import {
  bootstrapHostAttachSession,
  getHostSessionArtifactPath,
  getJoinSessionArtifactPath,
  getListenerSessionArtifactPath,
  readHostSessionArtifact,
  readJoinSessionArtifact,
  readListenerSessionArtifact,
  runSupervisor,
  SupervisorMode,
} from './supervisor';

interface CliArgs {
  mode: SupervisorMode;
  agentLabel?: string;
  runnerCommand?: string;
  runnerKind?: 'gemini' | 'claude' | 'codex' | 'custom';
  goal?: string;
  inviteCode?: string;
  listenerCode?: string;
  headless?: boolean;
  scriptDir?: string;
  sessionRoot?: string;
  plainMode?: boolean;
  timestampEnabled?: boolean;
  bootstrapHostAttach?: boolean;
  status?: boolean;
  help?: boolean;
}

function renderUsage(): string {
  return [
    'Usage:',
    '  --mode host|join|listen is required.',
    '  --agent-label <label> is required unless using --status or --help.',
    '  --runner-command <command> is required unless using --status or --help.',
    '  --runner-kind gemini|claude|codex|custom is optional metadata for status/policy persistence.',
    '',
    'Common examples:',
    '  bash .agents/skills/a2alinker/scripts/a2a-supervisor.sh --mode listen --agent-label codex',
    '  bash .agents/skills/a2alinker/scripts/a2a-supervisor.sh --mode listen --status',
    '  bash .agents/skills/a2alinker/scripts/a2a-supervisor.sh --mode host --status',
    '  bash .agents/skills/a2alinker/scripts/a2a-supervisor.sh --mode join --status',
    '  A2A_BASE_URL=https://broker.example bash .agents/skills/a2alinker/scripts/a2a-host-connect.sh listen_xxx',
  ].join('\n');
}

function parseArgs(argv: string[]): CliArgs {
  const args = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current?.startsWith('--')) {
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      args.set(current, 'true');
      continue;
    }
    args.set(current, value);
    index += 1;
  }

  const mode = args.get('--mode');
  const agentLabel = args.get('--agent-label');
  const runnerCommand = args.get('--runner-command');
  const runnerKind = args.get('--runner-kind');
  const status = args.has('--status');
  const help = args.has('--help');

  if (help) {
    return {
      mode: 'listen',
      help: true,
    };
  }

  if (mode !== 'host' && mode !== 'join' && mode !== 'listen') {
    throw new Error('Usage: --mode host|join|listen is required.');
  }
  if (!status && !agentLabel) {
    throw new Error('Usage: --agent-label <label> is required.');
  }
  if (!status && !runnerCommand) {
    throw new Error('Usage: --runner-command <command> is required.');
  }

  const headlessValue = args.get('--headless');

  const parsed: CliArgs = {
    mode,
    ...(agentLabel !== undefined ? { agentLabel } : {}),
    ...(runnerCommand !== undefined ? { runnerCommand } : {}),
    ...(runnerKind !== undefined ? { runnerKind: runnerKind as NonNullable<CliArgs['runnerKind']> } : {}),
  };

  const goal = args.get('--goal');
  const inviteCode = args.get('--invite-code');
  const listenerCode = args.get('--listener-code');
  const scriptDir = args.get('--script-dir');
  const sessionRoot = args.get('--session-root');

  if (goal !== undefined) {
    parsed.goal = goal;
  }
  if (inviteCode !== undefined) {
    parsed.inviteCode = inviteCode;
  }
  if (listenerCode !== undefined) {
    parsed.listenerCode = listenerCode;
  }
  if (headlessValue) {
    parsed.headless = headlessValue !== 'false';
  }
  if (args.has('--plain')) {
    parsed.plainMode = true;
  }
  if (args.has('--bootstrap-host-attach')) {
    parsed.bootstrapHostAttach = true;
  }
  if (args.has('--no-timestamps')) {
    parsed.timestampEnabled = false;
  }
  if (status) {
    parsed.status = true;
  }
  if (help) {
    parsed.help = true;
  }
  if (scriptDir !== undefined) {
    parsed.scriptDir = scriptDir;
  }
  if (sessionRoot !== undefined) {
    parsed.sessionRoot = sessionRoot;
  }

  return parsed;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(renderUsage());
    return;
  }
  if (parsed.bootstrapHostAttach) {
    const session = await bootstrapHostAttachSession(parsed as Parameters<typeof bootstrapHostAttachSession>[0]);
    console.log(`SESSION_DIR: ${session.sessionDir}`);
    return;
  }
  if (parsed.status) {
    if (parsed.mode === 'listen') {
      const artifact = readListenerSessionArtifact(process.cwd());
      console.log(JSON.stringify({
        ...artifact,
        artifactPath: getListenerSessionArtifactPath(process.cwd()),
      }, null, 2));
      return;
    }
    if (parsed.mode === 'host') {
      const artifact = readHostSessionArtifact(process.cwd());
      console.log(JSON.stringify({
        ...artifact,
        artifactPath: getHostSessionArtifactPath(process.cwd()),
      }, null, 2));
      return;
    }
    if (parsed.mode === 'join') {
      const artifact = readJoinSessionArtifact(process.cwd());
      console.log(JSON.stringify({
        ...artifact,
        artifactPath: getJoinSessionArtifactPath(process.cwd()),
      }, null, 2));
      return;
    }
    throw new Error('Usage: --status is only supported with --mode listen, --mode host, or --mode join.');
  }
  const session = await runSupervisor(parsed as Parameters<typeof runSupervisor>[0]);
  console.log(`SESSION_DIR: ${session.sessionDir}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
