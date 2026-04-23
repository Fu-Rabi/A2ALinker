import path from 'path';

export type SessionGrantKind = 'repo_edit' | 'test_build' | 'read_workspace' | 'exact_command' | 'web_access';
export type RunnerKind = 'gemini' | 'claude' | 'codex' | 'custom';

export interface SessionGrantCandidate {
  kind: SessionGrantKind;
  value: string;
  label: string;
}

export interface SessionGrant extends SessionGrantCandidate {
  grantedAt: string;
  source: 'local-human';
}

export interface SessionPolicy {
  version: 1;
  mode: 'interactive' | 'pre-authorized-listener';
  createdAt: string;
  expiresAt: string;
  brokerEndpoint: string;
  workspaceRoot: string;
  allowedCommands: string[];
  allowedPaths: string[];
  allowRepoEdits: boolean;
  allowTestsBuilds: boolean;
  allowWebAccess: boolean;
  denyNetworkExceptBroker: boolean;
  allowRemoteTriggerWithinScope: boolean;
  runnerKind?: RunnerKind;
  runnerCommand?: string;
  sessionGrants: SessionGrant[];
}

export interface PolicyEvaluation {
  decision: 'allow' | 'require_approval' | 'forbid';
  reason: string;
  normalizedSummary: string;
  grantCandidates: SessionGrantCandidate[];
}

const SECRET_ACCESS_VERB_PATTERN = 'read|show|print|dump|reveal|expose|copy|cat|grep|send|upload|fetch|get';
const SECRET_TARGET_PATTERN = 'token|tokens|password|passwords|api[_ -]?key|api[_ -]?keys|credential|credentials|secret|secrets|env|environment variable';
const SECRET_IDENTIFIER_PATTERN = 'OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY|GH_TOKEN|GITHUB_TOKEN';

const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: new RegExp(`\\b(${SECRET_ACCESS_VERB_PATTERN})\\b[^.!?\\n]{0,40}\\b(${SECRET_TARGET_PATTERN})\\b`, 'i'),
    reason: 'remote secret access is forbidden',
  },
  {
    pattern: new RegExp(`\\b(${SECRET_ACCESS_VERB_PATTERN})\\b[^.!?\\n]{0,40}\\b(${SECRET_IDENTIFIER_PATTERN})\\b`, 'i'),
    reason: 'remote secret access is forbidden',
  },
  { pattern: /\b(exfiltrat|upload|send me|dump|print).*?\b(file|token|secret|env|credential)\b/i, reason: 'data exfiltration requests are forbidden' },
  { pattern: /\b(sudo|chmod|chown|ssh|scp)\b/i, reason: 'privileged or non-broker transport commands are forbidden' },
  { pattern: /\brm\s+-rf\b/i, reason: 'destructive shell commands are forbidden' },
  { pattern: /\b(approval_policy|autoapprove|auto-approve|full-auto|allowlist|permission|settings\.json|config\.toml)\b/i, reason: 'permission changes are forbidden' },
  { pattern: /\b(~\/|\/etc\/|\/var\/|\/Users\/|\/home\/|\.ssh\/)\b/i, reason: 'access outside the approved workspace is forbidden' },
];

const BROKER_DIRECT_MUTATION_PATTERN = /\b(?:set|change|switch|replace|override|point|redirect|reconfigure)\s+(?:the\s+)?(?:broker(?:\s+(?:endpoint|server|target))?|session(?:\s+broker)?|connection(?:\s+broker)?|relay)\b/i;
const BROKER_ENV_SETTING_PATTERN = /\b(?:set|export|change|override)\s+(?:A2A_BASE_URL|A2A_SERVER)\b(?:\s*=|\s+to\b)/i;
const BROKER_CONFIG_MUTATION_PATTERN = /\b(?:edit|modify|update|change|rewrite|set)\b[^.!?\n]{0,60}\b(?:config|configuration|settings|\.env|env file|environment variable|shell profile)\b[^.!?\n]{0,80}\b(?:broker|A2A_BASE_URL|A2A_SERVER)\b/i;
const BROKER_COMMAND_MUTATION_PATTERN = /\b(?:run|execute|launch|invoke|call)\b[^.!?\n]{0,140}\b(?:A2A_BASE_URL|A2A_SERVER)\s*=/i;
const NEGATED_BROKER_MUTATION_PATTERN = /\b(?:do not|don't|dont|never|without)\s+(?:\w+\s+){0,2}(?:change|switch|replace|override|point|redirect|reconfigure|set|export)\b[^.!?\n]{0,60}\b(?:broker|A2A_BASE_URL|A2A_SERVER)\b/i;

const COMMAND_HINTS = /\b(run|execute|launch|invoke)\b|\bshell command\b/i;
const TEST_BUILD_HINTS = /\b(test|tests|jest|npm run build|npm run test|tsc|build)\b/i;
const REPO_EDIT_HINTS = /\b(edit|modify|patch|rewrite|update|change|fix|refactor|implement)\b/i;
const READ_HINTS = /\b(read|inspect|review|open|check|look at|show|view|cat)\b/i;
const FILE_HINTS = /\b(file|files|source|code|repo|repository|module|package|config)\b/i;
const WEB_HINTS = /\b(web|website|webpage|internet|online|url|link|weather|forecast|news)\b/i;
const WEB_ACTION_HINTS = /\b(check|look up|lookup|find|search|browse|open|visit|fetch|get|use|call)\b/i;
const URL_DIRECT_WEB_ACTION_PATTERN = /\b(?:check|look up|lookup|find|search|browse|open|visit|fetch|get|curl|wget|call)\b[^.!?\n]{0,80}https?:\/\//i;
const URL_CONTEXTUAL_WEB_ACTION_PATTERN = /\b(?:read|review|research|verify|confirm|use)\b[^.!?\n]{0,40}\b(?:at|from|via|using|on)\b[^.!?\n]{0,20}https?:\/\//i;
const CURRENT_INFO_HINTS = /\b(current|latest|today|now)\b/i;
const NETWORK_FETCH_HINTS = /\b(curl|wget)\b/i;
const NEGATED_EXECUTION_HINTS = /\b(do not|don't|dont|without|instead of)\s+(?:\w+\s+){0,2}(run|execute|launch|invoke)\b/i;

export function createSessionPolicy(input: {
  unattended: boolean;
  brokerEndpoint: string;
  workspaceRoot: string;
  expiresInHours?: number;
  allowRepoEdits?: boolean;
  allowTestsBuilds?: boolean;
  allowWebAccess?: boolean;
  allowRemoteTriggerWithinScope?: boolean;
  allowedCommands?: string[];
  allowedPaths?: string[];
  runnerKind?: RunnerKind;
  runnerCommand?: string;
}): SessionPolicy {
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + (input.expiresInHours ?? 8) * 60 * 60 * 1000).toISOString();
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const allowedPaths = (input.allowedPaths ?? [workspaceRoot]).map((entry) => path.resolve(entry));

  return {
    version: 1,
    mode: input.unattended ? 'pre-authorized-listener' : 'interactive',
    createdAt,
    expiresAt,
    brokerEndpoint: input.brokerEndpoint,
    workspaceRoot,
    allowedCommands: input.allowedCommands ?? ['npm test', 'npm run test', 'npm run build', 'npx jest', 'jest', 'tsc'],
    allowedPaths,
    allowRepoEdits: input.allowRepoEdits ?? true,
    allowTestsBuilds: input.allowTestsBuilds ?? true,
    allowWebAccess: input.allowWebAccess ?? false,
    denyNetworkExceptBroker: !(input.allowWebAccess ?? false),
    allowRemoteTriggerWithinScope: input.allowRemoteTriggerWithinScope ?? true,
    ...(input.runnerKind ? { runnerKind: input.runnerKind } : {}),
    ...(input.runnerCommand ? { runnerCommand: input.runnerCommand } : {}),
    sessionGrants: [],
  };
}

export function isPolicyExpired(policy: SessionPolicy, now = Date.now()): boolean {
  return Number.isNaN(Date.parse(policy.expiresAt)) || Date.parse(policy.expiresAt) <= now;
}

export function hydrateSessionPolicy(policy: SessionPolicy): SessionPolicy {
  const effectiveAllowWebAccess = typeof policy.allowWebAccess === 'boolean'
    ? policy.allowWebAccess
    : !policy.denyNetworkExceptBroker;
  return {
    ...policy,
    allowWebAccess: effectiveAllowWebAccess,
    denyNetworkExceptBroker: typeof policy.denyNetworkExceptBroker === 'boolean'
      ? policy.denyNetworkExceptBroker
      : !effectiveAllowWebAccess,
    ...(policy.runnerKind ? { runnerKind: policy.runnerKind } : {}),
    ...(policy.runnerCommand ? { runnerCommand: policy.runnerCommand } : {}),
    sessionGrants: Array.isArray(policy.sessionGrants) ? policy.sessionGrants : [],
  };
}

export function formatPolicySummary(policy: SessionPolicy): string[] {
  const hydrated = hydrateSessionPolicy(policy);
  const grants = hydrated.sessionGrants.length > 0
    ? hydrated.sessionGrants.map((grant) => grant.label).join(', ')
    : '(none)';
  const webAccessGranted = hydrated.allowWebAccess || hasSessionGrant(hydrated, {
    kind: 'web_access',
    value: 'web_access',
    label: 'live web access',
  });
  return [
    `Policy mode: ${hydrated.mode}`,
    `Workspace root: ${hydrated.workspaceRoot}`,
    `Broker endpoint: ${hydrated.brokerEndpoint}`,
    `Repo edits allowed: ${String(hydrated.allowRepoEdits)}`,
    `Tests/builds allowed: ${String(hydrated.allowTestsBuilds)}`,
    `Web access allowed: ${String(webAccessGranted)}`,
    `Network restricted to broker: ${String(!webAccessGranted)}`,
    `Auto-trigger within scope: ${String(hydrated.allowRemoteTriggerWithinScope)}`,
    `Runner: ${hydrated.runnerKind ?? 'unset'}`,
    ...(hydrated.runnerCommand ? [`Runner command: ${hydrated.runnerCommand}`] : []),
    `Allowed commands: ${hydrated.allowedCommands.join(', ') || '(none)'}`,
    `Session grants: ${grants}`,
    `Policy expires at: ${hydrated.expiresAt}`,
  ];
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function evaluateIncomingMessage(
  policy: SessionPolicy,
  goal: string | null,
  message: string,
): PolicyEvaluation {
  const hydratedPolicy = hydrateSessionPolicy(policy);
  const normalized = normalizeIncomingRequest(hydratedPolicy, message);

  if (isPolicyExpired(policy)) {
    return {
      decision: 'require_approval',
      reason: 'local unattended policy has expired',
      normalizedSummary: normalized.summary,
      grantCandidates: [],
    };
  }

  for (const entry of FORBIDDEN_PATTERNS) {
    if (entry.pattern.test(message)) {
      return {
        decision: 'forbid',
        reason: entry.reason,
        normalizedSummary: normalized.summary,
        grantCandidates: [],
      };
    }
  }

  if (isBrokerMutationRequest(message)) {
    return {
      decision: 'forbid',
      reason: 'broker changes are forbidden during a session',
      normalizedSummary: normalized.summary,
      grantCandidates: [],
    };
  }

  if (!hydratedPolicy.allowRemoteTriggerWithinScope) {
    return {
      decision: 'require_approval',
      reason: 'remote-triggered execution is disabled by local policy',
      normalizedSummary: normalized.summary,
      grantCandidates: [],
    };
  }

  const unmetGrantCandidates = normalized.grantCandidates.filter((candidate) => !hasSessionGrant(hydratedPolicy, candidate));

  if (unmetGrantCandidates.length > 0) {
    return {
      decision: 'require_approval',
      reason: `local approval is required for ${formatGrantCandidateList(unmetGrantCandidates)}`,
      normalizedSummary: normalized.summary,
      grantCandidates: unmetGrantCandidates,
    };
  }

  if (isGeneralCommandExecutionRequest(message) && !normalized.exactCommand) {
    return {
      decision: 'require_approval',
      reason: 'general command execution requires local approval',
      normalizedSummary: normalized.summary,
      grantCandidates: [],
    };
  }

  return {
    decision: 'allow',
    reason: goal?.trim()
      ? 'request is within the local session policy envelope'
      : 'request is allowed by local policy defaults',
    normalizedSummary: normalized.summary,
    grantCandidates: [],
  };
}

export function normalizeIncomingRequest(
  policy: SessionPolicy,
  message: string,
): {
  summary: string;
  exactCommand: string | null;
  grantCandidates: SessionGrantCandidate[];
} {
  const exactCommand = extractExactCommand(message, policy.allowedCommands);
  const grantCandidates: SessionGrantCandidate[] = [];
  const repoEditRequested = REPO_EDIT_HINTS.test(message);
  const testBuildRequested = TEST_BUILD_HINTS.test(message);
  const readWorkspaceRequested = READ_HINTS.test(message) && (FILE_HINTS.test(message) || /`[^`\n/]+(?:\/[^`\n]+)*`/.test(message));
  const webAccessRequested = isWebAccessRequested(message);

  if (repoEditRequested && !policy.allowRepoEdits) {
    grantCandidates.push({
      kind: 'repo_edit',
      value: 'repo_edit',
      label: 'repo edits inside the workspace',
    });
  }

  if (testBuildRequested && !policy.allowTestsBuilds) {
    grantCandidates.push({
      kind: 'test_build',
      value: 'test_build',
      label: 'test/build commands',
    });
  }

  if (readWorkspaceRequested && !repoEditRequested && !policy.allowRepoEdits) {
    grantCandidates.push({
      kind: 'read_workspace',
      value: 'read_workspace',
      label: 'read files inside the workspace',
    });
  }

  if (webAccessRequested && !policy.allowWebAccess) {
    grantCandidates.push({
      kind: 'web_access',
      value: 'web_access',
      label: 'live web access',
    });
  }

  if (exactCommand && !isPreapprovedCommand(policy, exactCommand)) {
    grantCandidates.push({
      kind: 'exact_command',
      value: exactCommand,
      label: `command \`${exactCommand}\``,
    });
  }

  return {
    summary: buildRequestSummary(message, exactCommand, repoEditRequested, testBuildRequested, readWorkspaceRequested, webAccessRequested),
    exactCommand,
    grantCandidates: dedupeGrantCandidates(grantCandidates),
  };
}

export function grantSessionAccess(
  policy: SessionPolicy,
  grantCandidates: SessionGrantCandidate[],
): SessionPolicy {
  const hydratedPolicy = hydrateSessionPolicy(policy);
  const existingKeys = new Set(hydratedPolicy.sessionGrants.map((grant) => getGrantKey(grant)));
  const grantsToAdd = grantCandidates
    .filter((candidate) => !existingKeys.has(getGrantKey(candidate)))
    .map<SessionGrant>((candidate) => ({
      ...candidate,
      grantedAt: new Date().toISOString(),
      source: 'local-human',
    }));

  return {
    ...hydratedPolicy,
    sessionGrants: [...hydratedPolicy.sessionGrants, ...grantsToAdd],
  };
}

export function formatGrantCandidateList(grantCandidates: SessionGrantCandidate[]): string {
  if (grantCandidates.length === 0) {
    return 'this request';
  }
  return grantCandidates.map((candidate) => candidate.label).join(', ');
}

function buildRequestSummary(
  message: string,
  exactCommand: string | null,
  repoEditRequested: boolean,
  testBuildRequested: boolean,
  readWorkspaceRequested: boolean,
  webAccessRequested: boolean,
): string {
  if (webAccessRequested) {
    return 'Use live web access';
  }
  if (exactCommand) {
    return `Run ${exactCommand}`;
  }
  if (repoEditRequested && testBuildRequested) {
    return 'Edit the repository and run tests/builds';
  }
  if (repoEditRequested) {
    return 'Edit the repository';
  }
  if (testBuildRequested) {
    return 'Run tests/builds';
  }
  if (readWorkspaceRequested) {
    return 'Read files in the workspace';
  }
  if (isGeneralCommandExecutionRequest(message)) {
    return 'Run a shell command';
  }
  return 'Handle the remote request';
}

function isGeneralCommandExecutionRequest(message: string): boolean {
  return COMMAND_HINTS.test(message)
    && !TEST_BUILD_HINTS.test(message)
    && !NEGATED_EXECUTION_HINTS.test(message);
}

function extractExactCommand(message: string, allowedCommands: string[]): string | null {
  const fencedOrInlineCommand = message.match(/`([^`\n]+)`/);
  const executionContextRequested = (isGeneralCommandExecutionRequest(message) || TEST_BUILD_HINTS.test(message))
    && !NEGATED_EXECUTION_HINTS.test(message);

  if (fencedOrInlineCommand?.[1] && executionContextRequested) {
    return normalizeCommand(fencedOrInlineCommand[1]);
  }

  const normalizedMessage = normalizeCommand(message).toLowerCase();
  const matches = allowedCommands
    .map((command) => normalizeCommand(command))
    .filter((command) => normalizedMessage.includes(command.toLowerCase()));

  if (matches.length === 0) {
    return null;
  }

  return matches.sort((left, right) => right.length - left.length)[0] ?? null;
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

function isPreapprovedCommand(policy: SessionPolicy, exactCommand: string): boolean {
  const normalizedCommand = normalizeCommand(exactCommand);
  return policy.allowedCommands.some((command) => normalizeCommand(command) === normalizedCommand)
    || hasSessionGrant(policy, {
      kind: 'exact_command',
      value: normalizedCommand,
      label: `command \`${normalizedCommand}\``,
    });
}

function hasSessionGrant(policy: SessionPolicy, candidate: SessionGrantCandidate): boolean {
  return hydrateSessionPolicy(policy).sessionGrants.some((grant) => getGrantKey(grant) === getGrantKey(candidate));
}

function getGrantKey(grant: Pick<SessionGrantCandidate, 'kind' | 'value'>): string {
  return `${grant.kind}:${normalizeCommand(grant.value).toLowerCase()}`;
}

function dedupeGrantCandidates(grantCandidates: SessionGrantCandidate[]): SessionGrantCandidate[] {
  const seen = new Set<string>();
  return grantCandidates.filter((candidate) => {
    const key = getGrantKey(candidate);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isBrokerMutationRequest(message: string): boolean {
  if (NEGATED_BROKER_MUTATION_PATTERN.test(message)) {
    return false;
  }
  if (BROKER_DIRECT_MUTATION_PATTERN.test(message)) {
    return true;
  }
  if (BROKER_ENV_SETTING_PATTERN.test(message)) {
    return true;
  }
  if (BROKER_CONFIG_MUTATION_PATTERN.test(message)) {
    return true;
  }
  return BROKER_COMMAND_MUTATION_PATTERN.test(message) && !NEGATED_EXECUTION_HINTS.test(message);
}

function isWebAccessRequested(message: string): boolean {
  if (URL_DIRECT_WEB_ACTION_PATTERN.test(message) || URL_CONTEXTUAL_WEB_ACTION_PATTERN.test(message)) {
    return true;
  }
  if (NETWORK_FETCH_HINTS.test(message) && isGeneralCommandExecutionRequest(message)) {
    return true;
  }
  if (/\bcurrent weather\b/i.test(message) || /\blatest news\b/i.test(message)) {
    return true;
  }
  if (CURRENT_INFO_HINTS.test(message) && WEB_HINTS.test(message)) {
    return true;
  }
  return WEB_HINTS.test(message) && WEB_ACTION_HINTS.test(message);
}
