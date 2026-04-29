"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const supervisor_1 = require("./supervisor");
function renderUsage() {
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
function parseArgs(argv) {
    const args = new Map();
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
    const parsed = {
        mode,
        ...(agentLabel !== undefined ? { agentLabel } : {}),
        ...(runnerCommand !== undefined ? { runnerCommand } : {}),
        ...(runnerKind !== undefined ? { runnerKind: runnerKind } : {}),
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
async function main() {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.help) {
        console.log(renderUsage());
        return;
    }
    if (parsed.bootstrapHostAttach) {
        const session = await (0, supervisor_1.bootstrapHostAttachSession)(parsed);
        console.log(`SESSION_DIR: ${session.sessionDir}`);
        return;
    }
    if (parsed.status) {
        if (parsed.mode === 'listen') {
            const artifact = (0, supervisor_1.readListenerSessionArtifact)(process.cwd());
            console.log(JSON.stringify({
                ...artifact,
                artifactPath: (0, supervisor_1.getListenerSessionArtifactPath)(process.cwd()),
            }, null, 2));
            return;
        }
        if (parsed.mode === 'host') {
            const artifact = (0, supervisor_1.readHostSessionArtifact)(process.cwd());
            console.log(JSON.stringify({
                ...artifact,
                artifactPath: (0, supervisor_1.getHostSessionArtifactPath)(process.cwd()),
            }, null, 2));
            return;
        }
        if (parsed.mode === 'join') {
            const artifact = (0, supervisor_1.readJoinSessionArtifact)(process.cwd());
            console.log(JSON.stringify({
                ...artifact,
                artifactPath: (0, supervisor_1.getJoinSessionArtifactPath)(process.cwd()),
            }, null, 2));
            return;
        }
        throw new Error('Usage: --status is only supported with --mode listen, --mode host, or --mode join.');
    }
    const session = await (0, supervisor_1.runSupervisor)(parsed);
    console.log(`SESSION_DIR: ${session.sessionDir}`);
}
main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
});
//# sourceMappingURL=a2a-supervisor.js.map