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

    it('continues past join notifications until a real message arrives', () => {
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
            expect(result.stdout).toContain('Ready for the next task');
            expect(result.stdout).not.toContain('has joined');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
