"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSessionPolicy = createSessionPolicy;
exports.isPolicyExpired = isPolicyExpired;
exports.hydrateSessionPolicy = hydrateSessionPolicy;
exports.formatPolicySummary = formatPolicySummary;
exports.escapeXml = escapeXml;
exports.evaluateIncomingMessage = evaluateIncomingMessage;
exports.normalizeIncomingRequest = normalizeIncomingRequest;
exports.grantSessionAccess = grantSessionAccess;
exports.formatGrantCandidateList = formatGrantCandidateList;
const path_1 = __importDefault(require("path"));
const FORBIDDEN_PATTERNS = [
    { pattern: /\b(token|password|api[_ -]?key|credential)s?\b/i, reason: 'remote secret access is forbidden' },
    { pattern: /\b(exfiltrat|upload|send me|dump|print).*?\b(file|token|secret|env|credential)\b/i, reason: 'data exfiltration requests are forbidden' },
    { pattern: /\b(sudo|chmod|chown|ssh|scp)\b/i, reason: 'privileged or non-broker transport commands are forbidden' },
    { pattern: /\brm\s+-rf\b/i, reason: 'destructive shell commands are forbidden' },
    { pattern: /\b(approval_policy|autoapprove|auto-approve|full-auto|allowlist|permission|settings\.json|config\.toml)\b/i, reason: 'permission changes are forbidden' },
    { pattern: /\b(~\/|\/etc\/|\/var\/|\/Users\/|\/home\/|\.ssh\/)\b/i, reason: 'access outside the approved workspace is forbidden' },
    { pattern: /\b(a2a_server|broker\.a2alinker\.net|change broker|switch broker)\b/i, reason: 'broker changes are forbidden during a session' },
];
const COMMAND_HINTS = /\b(run|execute|launch|invoke|shell|command)\b/i;
const TEST_BUILD_HINTS = /\b(test|tests|jest|npm run build|npm run test|tsc|build)\b/i;
const REPO_EDIT_HINTS = /\b(edit|modify|patch|rewrite|update|change|fix|refactor|implement)\b/i;
const READ_HINTS = /\b(read|inspect|review|open|check|look at|show|view|cat)\b/i;
const FILE_HINTS = /\b(file|files|source|code|repo|repository|module|package|config)\b/i;
const WEB_HINTS = /\b(web|website|webpage|internet|online|browse|search|google|url|link|curl|wget|weather|forecast|docs|documentation|news|latest|current)\b/i;
const WEB_ACTION_HINTS = /\b(check|look up|lookup|find|search|browse|open|visit|fetch|get|read|review|research|verify|confirm|use|call)\b/i;
function createSessionPolicy(input) {
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + (input.expiresInHours ?? 8) * 60 * 60 * 1000).toISOString();
    const workspaceRoot = path_1.default.resolve(input.workspaceRoot);
    const allowedPaths = (input.allowedPaths ?? [workspaceRoot]).map((entry) => path_1.default.resolve(entry));
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
function isPolicyExpired(policy, now = Date.now()) {
    return Number.isNaN(Date.parse(policy.expiresAt)) || Date.parse(policy.expiresAt) <= now;
}
function hydrateSessionPolicy(policy) {
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
function formatPolicySummary(policy) {
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
function escapeXml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
function evaluateIncomingMessage(policy, goal, message) {
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
    if (COMMAND_HINTS.test(message) && !TEST_BUILD_HINTS.test(message) && !normalized.exactCommand) {
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
function normalizeIncomingRequest(policy, message) {
    const exactCommand = extractExactCommand(message, policy.allowedCommands);
    const grantCandidates = [];
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
function grantSessionAccess(policy, grantCandidates) {
    const hydratedPolicy = hydrateSessionPolicy(policy);
    const existingKeys = new Set(hydratedPolicy.sessionGrants.map((grant) => getGrantKey(grant)));
    const grantsToAdd = grantCandidates
        .filter((candidate) => !existingKeys.has(getGrantKey(candidate)))
        .map((candidate) => ({
        ...candidate,
        grantedAt: new Date().toISOString(),
        source: 'local-human',
    }));
    return {
        ...hydratedPolicy,
        sessionGrants: [...hydratedPolicy.sessionGrants, ...grantsToAdd],
    };
}
function formatGrantCandidateList(grantCandidates) {
    if (grantCandidates.length === 0) {
        return 'this request';
    }
    return grantCandidates.map((candidate) => candidate.label).join(', ');
}
function buildRequestSummary(message, exactCommand, repoEditRequested, testBuildRequested, readWorkspaceRequested, webAccessRequested) {
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
    if (COMMAND_HINTS.test(message)) {
        return 'Run a shell command';
    }
    return 'Handle the remote request';
}
function extractExactCommand(message, allowedCommands) {
    const fencedOrInlineCommand = message.match(/`([^`\n]+)`/);
    if (fencedOrInlineCommand?.[1]) {
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
function normalizeCommand(command) {
    return command.trim().replace(/\s+/g, ' ');
}
function isPreapprovedCommand(policy, exactCommand) {
    const normalizedCommand = normalizeCommand(exactCommand);
    return policy.allowedCommands.some((command) => normalizeCommand(command) === normalizedCommand)
        || hasSessionGrant(policy, {
            kind: 'exact_command',
            value: normalizedCommand,
            label: `command \`${normalizedCommand}\``,
        });
}
function hasSessionGrant(policy, candidate) {
    return hydrateSessionPolicy(policy).sessionGrants.some((grant) => getGrantKey(grant) === getGrantKey(candidate));
}
function getGrantKey(grant) {
    return `${grant.kind}:${normalizeCommand(grant.value).toLowerCase()}`;
}
function dedupeGrantCandidates(grantCandidates) {
    const seen = new Set();
    return grantCandidates.filter((candidate) => {
        const key = getGrantKey(candidate);
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}
function isWebAccessRequested(message) {
    if (/https?:\/\//i.test(message)) {
        return true;
    }
    if (/\bcurrent weather\b/i.test(message) || /\blatest news\b/i.test(message)) {
        return true;
    }
    return WEB_HINTS.test(message) && (WEB_ACTION_HINTS.test(message) || /\b(current|latest|today|now)\b/i.test(message));
}
//# sourceMappingURL=policy.js.map