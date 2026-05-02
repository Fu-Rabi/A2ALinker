import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

function writeExecutable(filePath: string, contents: string): void {
    fs.writeFileSync(filePath, contents, 'utf8');
    fs.chmodSync(filePath, 0o755);
}

function withJoinToken<T>(token: string, run: () => T): T {
    const tokenFile = '/tmp/a2a_join_token';
    const previousToken = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8') : null;

    fs.writeFileSync(tokenFile, token, 'utf8');

    try {
        return run();
    } finally {
        if (previousToken === null) {
            fs.rmSync(tokenFile, { force: true });
        } else {
            fs.writeFileSync(tokenFile, previousToken, 'utf8');
        }
    }
}

function withHostToken<T>(token: string, run: () => T): T {
    const tokenFile = '/tmp/a2a_host_token';
    const previousToken = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8') : null;

    fs.writeFileSync(tokenFile, token, 'utf8');

    try {
        return run();
    } finally {
        if (previousToken === null) {
            fs.rmSync(tokenFile, { force: true });
        } else {
            fs.writeFileSync(tokenFile, previousToken, 'utf8');
        }
    }
}

describe('a2a-loop.sh', () => {
    const realScriptPath = path.resolve(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-loop.sh');
    const realCommonPath = path.resolve(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-common.sh');

    function setupTempLoopScripts(): {
        root: string;
        scriptDir: string;
        sendLogPath: string;
    } {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-loop-test-'));
        const scriptDir = path.join(root, 'scripts');
        const sendLogPath = path.join(root, 'send.log');
        fs.mkdirSync(scriptDir, { recursive: true });

        fs.copyFileSync(realScriptPath, path.join(scriptDir, 'a2a-loop.sh'));
        fs.copyFileSync(realCommonPath, path.join(scriptDir, 'a2a-common.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-loop.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-common.sh'), 0o755);

        writeExecutable(path.join(scriptDir, 'a2a-send.sh'), `#!/bin/bash
printf '%s\\n' "$2" >> "${sendLogPath}"
echo "DELIVERED"
`);
        writeExecutable(path.join(scriptDir, 'a2a-wait-message.sh'), `#!/bin/bash
cat <<'EOF'
TIMEOUT_ROOM_CLOSED
EOF
`);

        return { root, scriptDir, sendLogPath };
    }

    it('surfaces a host-closed system message instead of swallowing it', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-loop-test-'));
        const scriptDir = path.join(root, 'scripts');
        fs.mkdirSync(scriptDir, { recursive: true });

        fs.copyFileSync(realScriptPath, path.join(scriptDir, 'a2a-loop.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-loop.sh'), 0o755);

        writeExecutable(path.join(scriptDir, 'a2a-wait-message.sh'), `#!/bin/bash
cat <<'EOF'
MESSAGE_RECEIVED
[SYSTEM]: HOST has closed the session. You are disconnected.
EOF
`);
        writeExecutable(path.join(scriptDir, 'a2a-send.sh'), `#!/bin/bash
echo "DELIVERED"
`);

        try {
            const result = withJoinToken('tok_test_join', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-loop.sh'), 'join'],
                { encoding: 'utf8' },
            ));

            expect(result.status).toBe(0);
            expect(result.stdout).toContain('HOST has closed the session. You are disconnected.');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('continues past join notifications and returns the first real partner message', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-loop-test-'));
        const scriptDir = path.join(root, 'scripts');
        const stateFile = path.join(root, 'wait-state');
        fs.mkdirSync(scriptDir, { recursive: true });

        fs.copyFileSync(realScriptPath, path.join(scriptDir, 'a2a-loop.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-loop.sh'), 0o755);

        writeExecutable(path.join(scriptDir, 'a2a-wait-message.sh'), `#!/bin/bash
STATE_FILE="${stateFile}"
COUNT=0
if [ -f "$STATE_FILE" ]; then
  COUNT=$(cat "$STATE_FILE")
fi
COUNT=$((COUNT + 1))
echo "$COUNT" > "$STATE_FILE"

if [ "$COUNT" -eq 1 ]; then
  cat <<'EOF'
MESSAGE_RECEIVED
[SYSTEM]: HOST 'Agent-abcd' has joined. Session is live!
EOF
  exit 0
fi

cat <<'EOF'
MESSAGE_RECEIVED
┌─ Agent-host [OVER]
│
│ Ready for the next task
└────
EOF
`);
        try {
            const result = withJoinToken('tok_test_join', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-loop.sh'), 'join'],
                { encoding: 'utf8' },
            ));

            expect(result.status).toBe(0);
            expect(result.stdout).toContain('Ready for the next task');
            expect(result.stdout).not.toContain("HOST 'Agent-abcd' has joined. Session is live!");
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('surfaces the full join notification when explicitly requested', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-loop-test-'));
        const scriptDir = path.join(root, 'scripts');
        fs.mkdirSync(scriptDir, { recursive: true });

        fs.copyFileSync(realScriptPath, path.join(scriptDir, 'a2a-loop.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-loop.sh'), 0o755);

        writeExecutable(path.join(scriptDir, 'a2a-wait-message.sh'), `#!/bin/bash
cat <<'EOF'
MESSAGE_RECEIVED
[SYSTEM]: HOST 'Agent-abcd' has joined. Session is live!
EOF
`);

        try {
            const result = withJoinToken('tok_test_join', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-loop.sh'), 'join'],
                {
                    encoding: 'utf8',
                    env: {
                        ...process.env,
                        A2A_SURFACE_JOIN_NOTICE: 'true',
                    },
                },
            ));

            expect(result.status).toBe(0);
            expect(result.stdout).toContain('MESSAGE_RECEIVED');
            expect(result.stdout).toContain("HOST 'Agent-abcd' has joined. Session is live!");
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('surfaces the full join notification when requested via --surface-join-notice', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-loop-flag-test-'));
        const scriptDir = path.join(root, 'scripts');
        fs.mkdirSync(scriptDir, { recursive: true });

        fs.copyFileSync(realScriptPath, path.join(scriptDir, 'a2a-loop.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-loop.sh'), 0o755);

        writeExecutable(path.join(scriptDir, 'a2a-wait-message.sh'), `#!/bin/bash
cat <<'EOF'
MESSAGE_RECEIVED
[SYSTEM]: HOST 'Agent-abcd' has joined. Session is live!
EOF
`);

        try {
            const result = withJoinToken('tok_test_join', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-loop.sh'), '--surface-join-notice', 'join'],
                { encoding: 'utf8' },
            ));

            expect(result.status).toBe(0);
            expect(result.stdout).toContain('MESSAGE_RECEIVED');
            expect(result.stdout).toContain("HOST 'Agent-abcd' has joined. Session is live!");
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('writes surfaced host join notices to the captured terminal notifier', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-loop-notify-test-'));
        const scriptDir = path.join(root, 'scripts');
        const notifyPath = path.join(root, 'notify.log');
        fs.mkdirSync(scriptDir, { recursive: true });

        fs.copyFileSync(realScriptPath, path.join(scriptDir, 'a2a-loop.sh'));
        fs.copyFileSync(realCommonPath, path.join(scriptDir, 'a2a-common.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-loop.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-common.sh'), 0o755);
        fs.writeFileSync(notifyPath, '', 'utf8');

        writeExecutable(path.join(scriptDir, 'a2a-wait-message.sh'), `#!/bin/bash
cat <<'EOF'
MESSAGE_RECEIVED
[SYSTEM]: Partner 'Agent-abcd' has joined. Session is live!
EOF
`);

        try {
            const result = withHostToken('tok_test_host', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-loop.sh'), '--surface-join-notice', 'host'],
                {
                    encoding: 'utf8',
                    env: {
                        ...process.env,
                        A2A_RELAY_NOTIFY_TTY: notifyPath,
                    },
                },
            ));

            expect(result.status).toBe(0);
            expect(result.stdout).toContain("Partner 'Agent-abcd' has joined. Session is live!");
            const notification = fs.readFileSync(notifyPath, 'utf8');
            expect(notification).toContain('A2A_LINKER_JOIN_NOTICE');
            expect(notification).toContain("Partner 'Agent-abcd' has joined. Session is live!");
            expect(notification).toContain('A2A_LINKER_PROMPT: What is the first host message you want sent?');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('returns WAIT_CONTINUE_REQUIRED when the bounded wait slice expires', () => {
        const { root, scriptDir } = setupTempLoopScripts();

        writeExecutable(path.join(scriptDir, 'a2a-wait-message.sh'), `#!/bin/bash
echo "TIMEOUT_WAIT_EXPIRED"
`);

        try {
            const result = withJoinToken('tok_test_join', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-loop.sh'), '--surface-join-notice', 'join'],
                {
                    encoding: 'utf8',
                    env: {
                        ...process.env,
                        A2A_LOOP_MAX_SECONDS: '0',
                    },
                },
            ));

            expect(result.status).toBe(0);
            expect(result.stdout).toMatch(/^WAIT_CONTINUE_REQUIRED elapsed_s=\d+\n$/);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('emits continue heartbeats to stderr while keeping the wait alive', () => {
        const { root, scriptDir } = setupTempLoopScripts();
        const statePath = path.join(root, 'wait-count');

        writeExecutable(path.join(scriptDir, 'a2a-wait-message.sh'), `#!/bin/bash
COUNT=0
if [ -f "${statePath}" ]; then
  COUNT="$(cat "${statePath}")"
fi
COUNT=$((COUNT + 1))
echo "$COUNT" > "${statePath}"
if [ "$COUNT" -lt 2 ]; then
  echo "TIMEOUT_WAIT_EXPIRED"
else
  cat <<'EOF'
MESSAGE_RECEIVED
┌─ Agent-host [OVER]
│
│ Reply after heartbeat
└────
EOF
fi
`);

        try {
            const result = withJoinToken('tok_test_join', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-loop.sh'), 'join'],
                {
                    encoding: 'utf8',
                    env: {
                        ...process.env,
                        A2A_LOOP_MAX_SECONDS: '0',
                        A2A_LOOP_CONTINUE_ON_MAX_SECONDS: 'true',
                    },
                },
            ));

            expect(result.status).toBe(0);
            expect(result.stderr).toMatch(/WAIT_CONTINUE_REQUIRED elapsed_s=\d+/);
            expect(result.stdout).toContain('Reply after heartbeat');
            expect(fs.readFileSync(statePath, 'utf8').trim()).toBe('2');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('ignores a stale all-standby pause after sending a new active message', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-loop-stale-standby-'));
        const scriptDir = path.join(root, 'scripts');
        const statePath = path.join(root, 'wait-state');
        fs.mkdirSync(scriptDir, { recursive: true });

        fs.copyFileSync(realScriptPath, path.join(scriptDir, 'a2a-loop.sh'));
        fs.copyFileSync(realCommonPath, path.join(scriptDir, 'a2a-common.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-loop.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-common.sh'), 0o755);

        writeExecutable(path.join(scriptDir, 'a2a-send.sh'), `#!/bin/bash
echo "DELIVERED"
`);
        writeExecutable(path.join(scriptDir, 'a2a-wait-message.sh'), `#!/bin/bash
COUNT=0
if [ -f "${statePath}" ]; then
  COUNT="$(cat "${statePath}")"
fi
COUNT=$((COUNT + 1))
echo "$COUNT" > "${statePath}"
if [ "$COUNT" -eq 1 ]; then
  cat <<'EOF'
MESSAGE_RECEIVED
[SYSTEM]: Both agents have signaled STANDBY. Session paused. A human must intervene to resume.
EOF
else
  cat <<'EOF'
MESSAGE_RECEIVED
┌─ Agent-join [OVER]
│
│ Fresh reply
└────
EOF
fi
`);

        try {
            const result = withHostToken('tok_test_host', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-loop.sh'), 'host', 'New task [OVER]'],
                {
                    encoding: 'utf8',
                    env: {
                        ...process.env,
                        A2A_DEBUG: '1',
                    },
                },
            ));

            expect(result.status).toBe(0);
            expect(result.stdout).toContain('DELIVERED');
            expect(result.stdout).toContain('Fresh reply');
            expect(result.stdout).not.toContain('Both agents have signaled STANDBY');
            expect(fs.readFileSync(statePath, 'utf8').trim()).toBe('2');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('surfaces five-minute inactivity by default for supervisor callers', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-loop-inactivity-default-'));
        const scriptDir = path.join(root, 'scripts');
        fs.mkdirSync(scriptDir, { recursive: true });

        fs.copyFileSync(realScriptPath, path.join(scriptDir, 'a2a-loop.sh'));
        fs.copyFileSync(realCommonPath, path.join(scriptDir, 'a2a-common.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-loop.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-common.sh'), 0o755);

        writeExecutable(path.join(scriptDir, 'a2a-wait-message.sh'), `#!/bin/bash
echo "TIMEOUT_ROOM_ALIVE last_seen_ms=300000"
`);
        writeExecutable(path.join(scriptDir, 'a2a-send.sh'), `#!/bin/bash
echo "DELIVERED"
`);

        try {
            const result = withJoinToken('tok_test_join', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-loop.sh'), 'join'],
                { encoding: 'utf8' },
            ));

            expect(result.status).toBe(0);
            expect(result.stdout.trim()).toBe('TIMEOUT_ROOM_ALIVE last_seen_ms=300000');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('continues past five-minute inactivity when the caller disables inactivity surfacing', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-loop-inactivity-disabled-'));
        const scriptDir = path.join(root, 'scripts');
        const stateFile = path.join(root, 'wait-state');
        fs.mkdirSync(scriptDir, { recursive: true });

        fs.copyFileSync(realScriptPath, path.join(scriptDir, 'a2a-loop.sh'));
        fs.copyFileSync(realCommonPath, path.join(scriptDir, 'a2a-common.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-loop.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-common.sh'), 0o755);

        writeExecutable(path.join(scriptDir, 'a2a-wait-message.sh'), `#!/bin/bash
STATE_FILE="${stateFile}"
COUNT=0
if [ -f "$STATE_FILE" ]; then
  COUNT=$(cat "$STATE_FILE")
fi
COUNT=$((COUNT + 1))
echo "$COUNT" > "$STATE_FILE"

if [ "$COUNT" -eq 1 ]; then
  echo "TIMEOUT_ROOM_ALIVE last_seen_ms=300000"
  exit 0
fi

cat <<'EOF'
MESSAGE_RECEIVED
┌─ Agent-host [OVER]
│
│ Delayed reply
└────
EOF
`);
        writeExecutable(path.join(scriptDir, 'a2a-send.sh'), `#!/bin/bash
echo "DELIVERED"
`);

        try {
            const result = withJoinToken('tok_test_join', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-loop.sh'), 'join'],
                {
                    encoding: 'utf8',
                    env: {
                        ...process.env,
                        A2A_LOOP_SURFACE_INACTIVITY: 'false',
                    },
                },
            ));

            expect(result.status).toBe(0);
            expect(result.stdout).toContain('Delayed reply');
            expect(fs.readFileSync(stateFile, 'utf8').trim()).toBe('2');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('blocks a reply-seeking STANDBY message in non-interactive mode', () => {
        const { root, scriptDir, sendLogPath } = setupTempLoopScripts();

        try {
            const result = withJoinToken('tok_test_join', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-loop.sh'), 'join', 'Please review this HTML and return APPROVED or issues only. [STANDBY]'],
                { encoding: 'utf8', env: { ...process.env, A2A_DEBUG_PROMPT: '0' } },
            ));

            expect(result.status).toBe(1);
            expect(result.stderr).toContain('reply-seeking');
            expect(fs.existsSync(sendLogPath)).toBe(false);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('requires both STANDBY overrides when a message is both artifact-like and reply-seeking', () => {
        const { root, scriptDir, sendLogPath } = setupTempLoopScripts();

        try {
            const message = '<!DOCTYPE html>\n<html><body>Please review this file and return APPROVED or issues only.</body></html> [STANDBY]';
            const blocked = withJoinToken('tok_test_join', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-loop.sh'), 'join', message],
                {
                    encoding: 'utf8',
                    env: {
                        ...process.env,
                        A2A_DEBUG_PROMPT: '0',
                        A2A_ALLOW_STANDBY_ARTIFACT_SEND: '1',
                    },
                },
            ));

            expect(blocked.status).toBe(1);
            expect(blocked.stderr).toContain('reply-seeking');
            expect(fs.existsSync(sendLogPath)).toBe(false);

            const allowed = withJoinToken('tok_test_join', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-loop.sh'), 'join', message],
                {
                    encoding: 'utf8',
                    env: {
                        ...process.env,
                        A2A_DEBUG_PROMPT: '0',
                        A2A_ALLOW_STANDBY_ARTIFACT_SEND: '1',
                        A2A_ALLOW_STANDBY_REPLY_REQUEST: '1',
                    },
                },
            ));

            expect(allowed.status).toBe(0);
            expect(fs.readFileSync(sendLogPath, 'utf8')).toContain('Please review this file and return APPROVED or issues only.');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('allows a neutral STANDBY status update without triggering the guard', () => {
        const { root, scriptDir, sendLogPath } = setupTempLoopScripts();

        try {
            const result = withJoinToken('tok_test_join', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-loop.sh'), 'join', 'Chunk stored locally. Standing by for the next part. [STANDBY]'],
                { encoding: 'utf8', env: { ...process.env, A2A_DEBUG_PROMPT: '0' } },
            ));

            expect(result.status).toBe(0);
            expect(fs.readFileSync(sendLogPath, 'utf8')).toContain('Chunk stored locally. Standing by for the next part. [STANDBY]');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
