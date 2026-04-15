import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

function writeExecutable(filePath: string, contents: string): void {
    fs.writeFileSync(filePath, contents, 'utf8');
    fs.chmodSync(filePath, 0o755);
}

function withJoinToken<T>(stateDir: string, token: string, run: () => T): T {
    fs.mkdirSync(stateDir, { recursive: true });
    const tokenFile = path.join(stateDir, 'a2a_join_token');
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
    const commonScriptPath = path.resolve(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-common.sh');

    it('surfaces a host-closed system message instead of swallowing it', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-loop-test-'));
        const scriptDir = path.join(root, 'scripts');
        fs.mkdirSync(scriptDir, { recursive: true });

        fs.copyFileSync(realScriptPath, path.join(scriptDir, 'a2a-loop.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-loop.sh'), 0o755);
        fs.copyFileSync(commonScriptPath, path.join(scriptDir, 'a2a-common.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-common.sh'), 0o755);

        writeExecutable(path.join(scriptDir, 'a2a-wait-message.sh'), `#!/bin/bash
cat <<'EOF'
MESSAGE_RECEIVED
[SYSTEM]: HOST has closed the session. You are disconnected.
EOF
`);
        writeExecutable(path.join(scriptDir, 'a2a-send.sh'), `#!/bin/bash
echo "DELIVERED"
`);
        const stateDir = path.join(root, 'state');

        try {
            const result = withJoinToken(stateDir, 'tok_test_join', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-loop.sh'), 'join'],
                { encoding: 'utf8', env: { ...process.env, A2A_STATE_DIR: stateDir } },
            ));

            expect(result.status).toBe(0);
            expect(result.stdout).toContain('HOST has closed the session. You are disconnected.');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('surfaces join notifications immediately', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-loop-test-'));
        const scriptDir = path.join(root, 'scripts');
        const stateFile = path.join(root, 'wait-state');
        fs.mkdirSync(scriptDir, { recursive: true });

        fs.copyFileSync(realScriptPath, path.join(scriptDir, 'a2a-loop.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-loop.sh'), 0o755);
        fs.copyFileSync(commonScriptPath, path.join(scriptDir, 'a2a-common.sh'));
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
        const stateDir = path.join(root, 'state');
        try {
            const result = withJoinToken(stateDir, 'tok_test_join', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-loop.sh'), 'join'],
                { encoding: 'utf8', env: { ...process.env, A2A_STATE_DIR: stateDir } },
            ));

            expect(result.status).toBe(0);
            expect(result.stdout).toContain("HOST 'Agent-abcd' has joined. Session is live!");
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
