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
