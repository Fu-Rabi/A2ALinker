"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const supervisor_1 = require("./supervisor");
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
    if (mode !== 'host' && mode !== 'join' && mode !== 'listen') {
        throw new Error('Usage: --mode host|join|listen is required.');
    }
    if (!agentLabel) {
        throw new Error('Usage: --agent-label <label> is required.');
    }
    if (!runnerCommand) {
        throw new Error('Usage: --runner-command <command> is required.');
    }
    const headlessValue = args.get('--headless');
    const parsed = {
        mode,
        agentLabel,
        runnerCommand,
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
    if (args.has('--no-timestamps')) {
        parsed.timestampEnabled = false;
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
    const session = await (0, supervisor_1.runSupervisor)(parsed);
    console.log(`SESSION_DIR: ${session.sessionDir}`);
}
main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
});
