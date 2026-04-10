import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    normalizeSupervisorReply,
    parseLoopEvent,
    runSupervisor,
} from '../src/supervisor';

function writeExecutable(filePath: string, contents: string): void {
    fs.writeFileSync(filePath, contents, 'utf8');
    fs.chmodSync(filePath, 0o755);
}

function createTempLayout(): {
    root: string;
    scriptDir: string;
    sessionRoot: string;
    runnerPath: string;
} {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-supervisor-test-'));
    const scriptDir = path.join(root, 'scripts');
    const sessionRoot = path.join(root, 'sessions');
    const runnerPath = path.join(root, 'runner.js');
    fs.mkdirSync(scriptDir, { recursive: true });
    fs.mkdirSync(sessionRoot, { recursive: true });
    return { root, scriptDir, sessionRoot, runnerPath };
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (!check()) {
        if (Date.now() - start > timeoutMs) {
            throw new Error('Timed out waiting for condition');
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

describe('supervisor helpers', () => {
    it('normalizes replies that omit a turn marker', () => {
        expect(normalizeSupervisorReply('Handled it.')).toBe('Handled it. [OVER]');
        expect(normalizeSupervisorReply('Done [STANDBY]')).toBe('Done [STANDBY]');
    });

    it('parses A2A loop message output', () => {
        const event = parseLoopEvent([
            'MESSAGE_RECEIVED',
            '┌─ Agent-abcd [OVER]',
            '│',
            '│ Investigate the bug',
            '└────',
        ].join('\n'));

        expect(event.type).toBe('message');
        if (event.type !== 'message') {
            throw new Error('Expected message event');
        }
        expect(event.speaker).toBe('Agent-abcd');
        expect(event.signal).toBe('OVER');
        expect(event.body).toBe('Investigate the bug');
    });

    it('parses send-plus-wait loop output with a delivered prefix', () => {
        const event = parseLoopEvent([
            'DELIVERED',
            'MESSAGE_RECEIVED',
            '┌─ Agent-abcd [OVER]',
            '│',
            '│ Second probe',
            '└────',
        ].join('\n'));

        expect(event.type).toBe('message');
        if (event.type !== 'message') {
            throw new Error('Expected message event');
        }
        expect(event.speaker).toBe('Agent-abcd');
        expect(event.signal).toBe('OVER');
        expect(event.body).toBe('Second probe');
    });

    it('parses broker system messages as control events', () => {
        const event = parseLoopEvent([
            'MESSAGE_RECEIVED',
            '[SYSTEM]: HOST has closed the session. You are disconnected.',
        ].join('\n'));

        expect(event.type).toBe('system');
        if (event.type !== 'system') {
            throw new Error('Expected system event');
        }
        expect(event.kind).toBe('closed');
        expect(event.body).toContain('HOST has closed the session');
    });
});

describe('runSupervisor', () => {
    it('processes a JOINER conversation turn and resumes through a2a-loop', async () => {
        const { root, scriptDir, sessionRoot, runnerPath } = createTempLayout();
        const loopStatePath = path.join(root, 'loop-state');
        const sentLogPath = path.join(root, 'sent.log');

        writeExecutable(path.join(scriptDir, 'a2a-join-connect.sh'), `#!/bin/bash
echo "STATUS: (2/2 connected)"
echo "HEADLESS: true"
`);
        writeExecutable(path.join(scriptDir, 'a2a-loop.sh'), `#!/bin/bash
STATE_FILE="${loopStatePath}"
COUNT=0
if [ -f "$STATE_FILE" ]; then
  COUNT=$(cat "$STATE_FILE")
fi
COUNT=$((COUNT + 1))
echo "$COUNT" > "$STATE_FILE"

if [ "$COUNT" -eq 1 ]; then
  cat <<'EOF'
MESSAGE_RECEIVED
┌─ Agent-host [OVER]
│
│ Please investigate the failing test
└────
EOF
  exit 0
fi

echo "$2" >> "${sentLogPath}"
echo "TIMEOUT_ROOM_CLOSED"
`);
        writeExecutable(path.join(scriptDir, 'a2a-leave.sh'), `#!/bin/bash
exit 0
`);
        writeExecutable(runnerPath, `const fs = require('fs');
const prompt = fs.readFileSync(process.env.A2A_SUPERVISOR_PROMPT_FILE, 'utf8');
if (!prompt.includes('Please investigate the failing test')) {
  throw new Error('prompt did not include incoming message');
}
process.stdout.write('I found the failing assertion and fixed it. [STANDBY]\\n');
`);

        const session = await runSupervisor({
            mode: 'join',
            agentLabel: 'custom-bot',
            runnerCommand: `node "${runnerPath}"`,
            inviteCode: 'invite_join123',
            scriptDir,
            sessionRoot,
            cwd: root,
            logger: { info: () => undefined, error: () => undefined },
        });

        const sentLog = fs.readFileSync(sentLogPath, 'utf8');
        const metadata = JSON.parse(fs.readFileSync(session.metadataPath, 'utf8')) as Record<string, string>;

        expect(sentLog).toContain('I found the failing assertion and fixed it. [STANDBY]');
        expect(metadata.agentLabel).toBe('custom-bot');
        expect(metadata.status).toBe('closed');
    });

    it('waits for a host partner join notification before sending the opening goal', async () => {
        const { root, scriptDir, sessionRoot, runnerPath } = createTempLayout();
        const sentLogPath = path.join(root, 'sent.log');

        writeExecutable(path.join(scriptDir, 'a2a-host-connect.sh'), `#!/bin/bash
echo "INVITE_CODE: invite_demo123"
echo "HEADLESS_SET: true"
`);
        writeExecutable(path.join(scriptDir, 'a2a-wait-message.sh'), `#!/bin/bash
cat <<'EOF'
MESSAGE_RECEIVED
[SYSTEM]: Partner 'Agent-join' has joined. Session is live!
EOF
`);
        writeExecutable(path.join(scriptDir, 'a2a-loop.sh'), `#!/bin/bash
echo "$2" >> "${sentLogPath}"
echo "TIMEOUT_ROOM_CLOSED"
`);
        writeExecutable(path.join(scriptDir, 'a2a-leave.sh'), `#!/bin/bash
exit 0
`);
        writeExecutable(runnerPath, `process.stdout.write('unused [OVER]\\n');`);

        await runSupervisor({
            mode: 'host',
            agentLabel: 'codex-like',
            runnerCommand: `node "${runnerPath}"`,
            goal: 'Audit the repository and explain the async gap.',
            scriptDir,
            sessionRoot,
            cwd: root,
            logger: { info: () => undefined, error: () => undefined },
        });

        const sentLog = fs.readFileSync(sentLogPath, 'utf8');
        expect(sentLog).toContain('Hello from codex-like.');
        expect(sentLog).toContain('Audit the repository and explain the async gap.');
        expect(sentLog).toContain('[OVER]');
    });

    it('creates isolated session directories for concurrent-capable labels', async () => {
        const { root, scriptDir, sessionRoot, runnerPath } = createTempLayout();

        writeExecutable(path.join(scriptDir, 'a2a-join-connect.sh'), `#!/bin/bash
echo "STATUS: (2/2 connected)"
`);
        writeExecutable(path.join(scriptDir, 'a2a-loop.sh'), `#!/bin/bash
cat <<'EOF'
TIMEOUT_ROOM_CLOSED
EOF
`);
        writeExecutable(path.join(scriptDir, 'a2a-leave.sh'), `#!/bin/bash
exit 0
`);
        writeExecutable(runnerPath, `process.stdout.write('unused [OVER]\\n');`);

        const first = await runSupervisor({
            mode: 'join',
            agentLabel: 'bot-alpha',
            runnerCommand: `node "${runnerPath}"`,
            inviteCode: 'invite_alpha',
            scriptDir,
            sessionRoot,
            cwd: root,
            logger: { info: () => undefined, error: () => undefined },
        });
        const second = await runSupervisor({
            mode: 'join',
            agentLabel: 'bot-beta',
            runnerCommand: `node "${runnerPath}"`,
            inviteCode: 'invite_beta',
            scriptDir,
            sessionRoot,
            cwd: root,
            logger: { info: () => undefined, error: () => undefined },
        });

        const firstMetadata = JSON.parse(fs.readFileSync(first.metadataPath, 'utf8')) as Record<string, string>;
        const secondMetadata = JSON.parse(fs.readFileSync(second.metadataPath, 'utf8')) as Record<string, string>;

        expect(first.sessionDir).not.toBe(second.sessionDir);
        expect(firstMetadata.agentLabel).toBe('bot-alpha');
        expect(secondMetadata.agentLabel).toBe('bot-beta');
    });

    it('does not invoke the runner for broker close notifications', async () => {
        const { root, scriptDir, sessionRoot, runnerPath } = createTempLayout();
        const runnerTouchedPath = path.join(root, 'runner-touched');

        writeExecutable(path.join(scriptDir, 'a2a-join-connect.sh'), `#!/bin/bash
echo "STATUS: (2/2 connected)"
`);
        writeExecutable(path.join(scriptDir, 'a2a-loop.sh'), `#!/bin/bash
cat <<'EOF'
MESSAGE_RECEIVED
[SYSTEM]: HOST has closed the session. You are disconnected.
EOF
`);
        writeExecutable(path.join(scriptDir, 'a2a-leave.sh'), `#!/bin/bash
exit 0
`);
        writeExecutable(runnerPath, `const fs = require('fs');
fs.writeFileSync("${runnerTouchedPath}", "called");
process.stdout.write('should not run [OVER]\\n');
`);

        const session = await runSupervisor({
            mode: 'join',
            agentLabel: 'custom-bot',
            runnerCommand: `node "${runnerPath}"`,
            inviteCode: 'invite_join123',
            scriptDir,
            sessionRoot,
            cwd: root,
            logger: { info: () => undefined, error: () => undefined },
        });

        const metadata = JSON.parse(fs.readFileSync(session.metadataPath, 'utf8')) as Record<string, string>;
        expect(fs.existsSync(runnerTouchedPath)).toBe(false);
        expect(metadata.status).toBe('closed');
    });

    it('handles a second incoming turn after replying with STANDBY', async () => {
        const { root, scriptDir, sessionRoot, runnerPath } = createTempLayout();
        const loopStatePath = path.join(root, 'loop-state');
        const sentLogPath = path.join(root, 'sent.log');

        writeExecutable(path.join(scriptDir, 'a2a-join-connect.sh'), `#!/bin/bash
echo "STATUS: (2/2 connected)"
echo "HEADLESS: true"
`);
        writeExecutable(path.join(scriptDir, 'a2a-loop.sh'), `#!/bin/bash
STATE_FILE="${loopStatePath}"
COUNT=0
if [ -f "$STATE_FILE" ]; then
  COUNT=$(cat "$STATE_FILE")
fi
COUNT=$((COUNT + 1))
echo "$COUNT" > "$STATE_FILE"

if [ "$COUNT" -eq 1 ]; then
  cat <<'EOF'
MESSAGE_RECEIVED
┌─ Agent-host [OVER]
│
│ First probe
└────
EOF
  exit 0
fi

if [ "$COUNT" -eq 2 ]; then
  cat <<EOF >> "${sentLogPath}"
$2
EOF
  cat <<'EOF'
DELIVERED
MESSAGE_RECEIVED
┌─ Agent-host [OVER]
│
│ Second probe
└────
EOF
  exit 0
fi

cat <<EOF >> "${sentLogPath}"
$2
EOF
echo "TIMEOUT_ROOM_CLOSED"
`);
        writeExecutable(path.join(scriptDir, 'a2a-leave.sh'), `#!/bin/bash
exit 0
`);
        writeExecutable(runnerPath, `const fs = require('fs');
const msg = fs.readFileSync(process.env.A2A_SUPERVISOR_MESSAGE_FILE, 'utf8').trim();
if (msg === 'First probe') {
  process.stdout.write('first ok [STANDBY]\\n');
} else if (msg === 'Second probe') {
  process.stdout.write('second ok [STANDBY]\\n');
} else {
  throw new Error('unexpected message: ' + msg);
}
`);

        const session = await runSupervisor({
            mode: 'join',
            agentLabel: 'custom-bot',
            runnerCommand: `node "${runnerPath}"`,
            inviteCode: 'invite_join123',
            scriptDir,
            sessionRoot,
            cwd: root,
            logger: { info: () => undefined, error: () => undefined },
        });

        const sentLog = fs.readFileSync(sentLogPath, 'utf8');
        const metadata = JSON.parse(fs.readFileSync(session.metadataPath, 'utf8')) as Record<string, string>;

        expect(sentLog).toContain('first ok [STANDBY]');
        expect(sentLog).toContain('second ok [STANDBY]');
        expect(metadata.status).toBe('closed');
    });

    it('marks the session as waiting while blocked on the next loop after replying', async () => {
        const { root, scriptDir, sessionRoot, runnerPath } = createTempLayout();
        const sentLogPath = path.join(root, 'sent.log');
        const waitingMarkerPath = path.join(root, 'waiting.marker');

        writeExecutable(path.join(scriptDir, 'a2a-join-connect.sh'), `#!/bin/bash
echo "STATUS: (2/2 connected)"
echo "HEADLESS: true"
`);
        writeExecutable(path.join(scriptDir, 'a2a-loop.sh'), `#!/bin/bash
if [ -z "$2" ]; then
  cat <<'EOF'
MESSAGE_RECEIVED
┌─ Agent-host [OVER]
│
│ First probe
└────
EOF
  exit 0
fi

echo "$2" >> "${sentLogPath}"
touch "${waitingMarkerPath}"
sleep 1
echo "TIMEOUT_ROOM_CLOSED"
`);
        writeExecutable(path.join(scriptDir, 'a2a-leave.sh'), `#!/bin/bash
exit 0
`);
        writeExecutable(runnerPath, `process.stdout.write('done [STANDBY]\\n');`);

        const sessionPromise = runSupervisor({
            mode: 'join',
            agentLabel: 'custom-bot',
            runnerCommand: `node "${runnerPath}"`,
            inviteCode: 'invite_join123',
            scriptDir,
            sessionRoot,
            cwd: root,
            logger: { info: () => undefined, error: () => undefined },
        });

        await waitFor(() => fs.existsSync(waitingMarkerPath));

        const [sessionDirName] = fs.readdirSync(sessionRoot);
        const metadataPath = path.join(sessionRoot, sessionDirName, 'session.json');
        const liveMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as Record<string, string>;

        expect(fs.readFileSync(sentLogPath, 'utf8')).toContain('done [STANDBY]');
        expect(liveMetadata.status).toBe('waiting');
        expect(liveMetadata.lastReplySignal).toBe('STANDBY');

        const session = await sessionPromise;
        const finalMetadata = JSON.parse(fs.readFileSync(session.metadataPath, 'utf8')) as Record<string, string>;
        expect(finalMetadata.status).toBe('closed');
    });

    it('mirrors inbound and outbound traffic through the supervisor logger', async () => {
        const { root, scriptDir, sessionRoot, runnerPath } = createTempLayout();
        const infoLogs: string[] = [];
        const errorLogs: string[] = [];

        writeExecutable(path.join(scriptDir, 'a2a-join-connect.sh'), `#!/bin/bash
echo "STATUS: (2/2 connected)"
echo "HEADLESS: true"
`);
        writeExecutable(path.join(scriptDir, 'a2a-loop.sh'), `#!/bin/bash
if [ -z "$2" ]; then
  cat <<'EOF'
MESSAGE_RECEIVED
┌─ Agent-host [OVER]
│
│ Visible first line
│ Visible second line
└────
EOF
  exit 0
fi

echo "TIMEOUT_ROOM_CLOSED"
`);
        writeExecutable(path.join(scriptDir, 'a2a-leave.sh'), `#!/bin/bash
exit 0
`);
        writeExecutable(runnerPath, `process.stdout.write('Handled visibly [STANDBY]\\n');`);

        await runSupervisor({
            mode: 'join',
            agentLabel: 'codex',
            runnerCommand: `node "${runnerPath}"`,
            inviteCode: 'invite_join123',
            scriptDir,
            sessionRoot,
            cwd: root,
            plainMode: true,
            timestampEnabled: false,
            terminalWidth: 72,
            logger: {
                info: (...args: string[]) => infoLogs.push(args.join(' ')),
                error: (...args: string[]) => errorLogs.push(args.join(' ')),
            },
        });

        expect(infoLogs.some((entry) => entry.includes('A2A LINKER CONNECTING'))).toBe(true);
        expect(infoLogs.some((entry) => entry.includes('INBOUND  Agent-host  [OVER]'))).toBe(true);
        expect(infoLogs.some((entry) => entry.includes('│ Visible first line'))).toBe(true);
        expect(infoLogs.some((entry) => entry.includes('OUTBOUND  codex  [STANDBY]'))).toBe(true);
        expect(infoLogs.some((entry) => entry.includes('Handled visibly'))).toBe(true);
        expect(infoLogs.some((entry) => entry.includes('SESSION CLOSED'))).toBe(true);
        expect(errorLogs).toEqual([]);
    });

    it('mirrors system events without invoking the runner', async () => {
        const { root, scriptDir, sessionRoot, runnerPath } = createTempLayout();
        const infoLogs: string[] = [];

        writeExecutable(path.join(scriptDir, 'a2a-join-connect.sh'), `#!/bin/bash
echo "STATUS: (2/2 connected)"
`);
        writeExecutable(path.join(scriptDir, 'a2a-loop.sh'), `#!/bin/bash
cat <<'EOF'
MESSAGE_RECEIVED
[SYSTEM]: HOST has closed the session. You are disconnected.
EOF
`);
        writeExecutable(path.join(scriptDir, 'a2a-leave.sh'), `#!/bin/bash
exit 0
`);
        writeExecutable(runnerPath, `throw new Error('runner should not execute');`);

        await runSupervisor({
            mode: 'join',
            agentLabel: 'codex',
            runnerCommand: `node "${runnerPath}"`,
            inviteCode: 'invite_join123',
            scriptDir,
            sessionRoot,
            cwd: root,
            plainMode: true,
            timestampEnabled: false,
            logger: {
                info: (...args: string[]) => infoLogs.push(args.join(' ')),
                error: () => undefined,
            },
        });

        expect(infoLogs.some((entry) => entry.includes('SESSION CLOSED'))).toBe(true);
        expect(infoLogs.some((entry) => entry.includes('HOST has closed the session. You are disconnected.'))).toBe(true);
    });

    it('keeps the local join role and broker headless state in listener mode', async () => {
        const { root, scriptDir, sessionRoot, runnerPath } = createTempLayout();
        const infoLogs: string[] = [];
        const loopStatePath = path.join(root, 'loop-state');

        writeExecutable(path.join(scriptDir, 'a2a-listen.sh'), `#!/bin/bash
echo "LISTENER_CODE: listen_demo123"
echo "HEADLESS_SET: false"
`);
        writeExecutable(path.join(scriptDir, 'a2a-loop.sh'), `#!/bin/bash
STATE_FILE="${loopStatePath}"
COUNT=0
if [ -f "$STATE_FILE" ]; then
  COUNT=$(cat "$STATE_FILE")
fi
COUNT=$((COUNT + 1))
echo "$COUNT" > "$STATE_FILE"

if [ "$COUNT" -eq 1 ]; then
  cat <<'EOF'
MESSAGE_RECEIVED
[SYSTEM]: HOST 'Agent-host' has joined. Session is live!
EOF
  exit 0
fi

cat <<'EOF'
TIMEOUT_ROOM_CLOSED
EOF
`);
        writeExecutable(path.join(scriptDir, 'a2a-leave.sh'), `#!/bin/bash
exit 0
`);
        writeExecutable(runnerPath, `throw new Error('runner should not execute');`);

        await runSupervisor({
            mode: 'listen',
            agentLabel: 'codex',
            runnerCommand: `node "${runnerPath}"`,
            scriptDir,
            sessionRoot,
            cwd: root,
            plainMode: true,
            timestampEnabled: false,
            logger: {
                info: (...args: string[]) => infoLogs.push(args.join(' ')),
                error: () => undefined,
            },
        });

        const liveCard = infoLogs.find((entry) => entry.includes('A2A LINKER SESSION LIVE'));
        expect(liveCard).toBeDefined();
        expect(liveCard).toContain('Role');
        expect(liveCard).toContain('JOIN');
        expect(liveCard).toContain('Headless');
        expect(liveCard).toContain('false');
    });

    it('keeps waiting after standby pause and then cleans up when the host closes', async () => {
        const { root, scriptDir, sessionRoot, runnerPath } = createTempLayout();
        const loopStatePath = path.join(root, 'loop-state');
        const leaveLogPath = path.join(root, 'leave.log');
        const infoLogs: string[] = [];

        writeExecutable(path.join(scriptDir, 'a2a-join-connect.sh'), `#!/bin/bash
echo "STATUS: (2/2 connected)"
echo "HEADLESS: true"
`);
        writeExecutable(path.join(scriptDir, 'a2a-loop.sh'), `#!/bin/bash
STATE_FILE="${loopStatePath}"
COUNT=0
if [ -f "$STATE_FILE" ]; then
  COUNT=$(cat "$STATE_FILE")
fi
COUNT=$((COUNT + 1))
echo "$COUNT" > "$STATE_FILE"

if [ "$COUNT" -eq 1 ]; then
  cat <<'EOF'
MESSAGE_RECEIVED
[SYSTEM]: Both agents have signaled STANDBY. Session paused. A human must intervene to resume.
EOF
  exit 0
fi

cat <<'EOF'
MESSAGE_RECEIVED
[SYSTEM]: HOST has closed the session. You are disconnected.
EOF
`);
        writeExecutable(path.join(scriptDir, 'a2a-leave.sh'), `#!/bin/bash
echo "$1" >> "${leaveLogPath}"
exit 0
`);
        writeExecutable(runnerPath, `throw new Error('runner should not execute');`);

        const session = await runSupervisor({
            mode: 'join',
            agentLabel: 'codex',
            runnerCommand: `node "${runnerPath}"`,
            inviteCode: 'invite_join123',
            scriptDir,
            sessionRoot,
            cwd: root,
            plainMode: true,
            timestampEnabled: false,
            logger: {
                info: (...args: string[]) => infoLogs.push(args.join(' ')),
                error: () => undefined,
            },
        });

        const metadata = JSON.parse(fs.readFileSync(session.metadataPath, 'utf8')) as Record<string, string>;
        const leaveLog = fs.readFileSync(leaveLogPath, 'utf8');

        expect(infoLogs.some((entry) => entry.includes('SESSION PAUSED'))).toBe(true);
        expect(infoLogs.some((entry) => entry.includes('Both agents have signaled STANDBY. Session paused.'))).toBe(true);
        expect(infoLogs.some((entry) => entry.includes('SESSION CLOSED'))).toBe(true);
        expect(infoLogs.some((entry) => entry.includes('HOST has closed the session. You are disconnected.'))).toBe(true);
        expect(metadata.status).toBe('closed');
        expect(metadata.lastEvent).toBe('system_closed');
        expect(leaveLog).toContain('join');
    });
});
