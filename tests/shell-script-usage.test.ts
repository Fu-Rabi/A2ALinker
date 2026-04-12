import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

function writeExecutable(filePath: string, contents: string): void {
    fs.writeFileSync(filePath, contents, 'utf8');
    fs.chmodSync(filePath, 0o755);
}

describe('A2A shell script usage guards', () => {
    it('forwards unattended listener intent to the supervisor as --headless true', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-supervisor-headless-'));
        const scriptDir = path.join(root, 'scripts');
        const binDir = path.join(root, 'bin');
        const capturedArgsPath = path.join(root, 'captured-args');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.mkdirSync(binDir, { recursive: true });

        writeExecutable(path.join(binDir, 'node'), `#!/bin/bash
printf '%s\n' "$@" > "${capturedArgsPath}"
`);

        const result = spawnSync(
            'bash',
            ['.agents/skills/a2alinker/scripts/a2a-supervisor.sh', '--mode', 'listen', '--agent-label', 'codex', '--runner-command', 'echo ok'],
            {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                    A2A_BASE_URL: 'http://127.0.0.1:3000',
                    A2A_UNATTENDED: 'true',
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(0);
        const capturedArgs = fs.readFileSync(capturedArgsPath, 'utf8');
        expect(capturedArgs).toContain('--mode');
        expect(capturedArgs).toContain('listen');
        expect(capturedArgs).toContain('--headless');
        expect(capturedArgs).toContain('true');

        fs.rmSync(root, { recursive: true, force: true });
    });

    it('allows read-only listener status without broker prompts or runner injection', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-supervisor-status-'));
        const binDir = path.join(root, 'bin');
        const capturedArgsPath = path.join(root, 'captured-args');
        fs.mkdirSync(binDir, { recursive: true });

        writeExecutable(path.join(binDir, 'node'), `#!/bin/bash
printf '%s\n' "$@" > "${capturedArgsPath}"
`);

        const result = spawnSync(
            'bash',
            ['.agents/skills/a2alinker/scripts/a2a-supervisor.sh', '--mode', 'listen', '--status'],
            {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(0);
        expect(result.stderr).not.toContain('A2A broker target');
        const capturedArgs = fs.readFileSync(capturedArgsPath, 'utf8');
        expect(capturedArgs).toContain('--mode');
        expect(capturedArgs).toContain('listen');
        expect(capturedArgs).toContain('--status');
        expect(capturedArgs).not.toContain('--runner-command');

        fs.rmSync(root, { recursive: true, force: true });
    });

    it('allows read-only host status without broker prompts or runner injection', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-supervisor-host-status-'));
        const binDir = path.join(root, 'bin');
        const capturedArgsPath = path.join(root, 'captured-args');
        fs.mkdirSync(binDir, { recursive: true });

        writeExecutable(path.join(binDir, 'node'), `#!/bin/bash
printf '%s\n' "$@" > "${capturedArgsPath}"
`);

        const result = spawnSync(
            'bash',
            ['.agents/skills/a2alinker/scripts/a2a-supervisor.sh', '--mode', 'host', '--status'],
            {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(0);
        expect(result.stderr).not.toContain('A2A broker target');
        const capturedArgs = fs.readFileSync(capturedArgsPath, 'utf8');
        expect(capturedArgs).toContain('--mode');
        expect(capturedArgs).toContain('host');
        expect(capturedArgs).toContain('--status');
        expect(capturedArgs).not.toContain('--runner-command');

        fs.rmSync(root, { recursive: true, force: true });
    });

    it('requires an explicit broker target for host attach via listener code', () => {
        const result = spawnSync(
            'bash',
            ['.agents/skills/a2alinker/scripts/a2a-supervisor.sh', '--mode', 'host', '--listener-code', 'listen_demo123', '--agent-label', 'codex', '--runner-command', 'echo ok'],
            {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Host attach via --listener-code requires an explicit broker target.');
        expect(result.stderr).toContain('Set A2A_BASE_URL or A2A_SERVER');
    });

    it('allows help output without broker prompts or runner injection', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-supervisor-help-'));
        const binDir = path.join(root, 'bin');
        const capturedArgsPath = path.join(root, 'captured-args');
        fs.mkdirSync(binDir, { recursive: true });

        writeExecutable(path.join(binDir, 'node'), `#!/bin/bash
printf '%s\n' "$@" > "${capturedArgsPath}"
`);

        const result = spawnSync(
            'bash',
            ['.agents/skills/a2alinker/scripts/a2a-supervisor.sh', '--help'],
            {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(0);
        expect(result.stderr).not.toContain('A2A broker target');
        const capturedArgs = fs.readFileSync(capturedArgsPath, 'utf8');
        expect(capturedArgs).toContain('--help');
        expect(capturedArgs).not.toContain('--runner-command');

        fs.rmSync(root, { recursive: true, force: true });
    });

    it('reuses a persisted listener policy runner instead of defaulting to codex', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-runner-persisted-'));
        const binDir = path.join(root, 'bin');
        const capturedArgsPath = path.join(root, 'captured-args');
        const persistedCommand = `bash ${path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-gemini-runner.sh')}`;
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(path.join(root, '.a2a-listener-policy.json'), JSON.stringify({
            version: 1,
            mode: 'pre-authorized-listener',
            createdAt: '2026-04-11T00:00:00.000Z',
            expiresAt: '2099-04-11T00:00:00.000Z',
            brokerEndpoint: 'https://broker.a2alinker.net',
            workspaceRoot: root,
            allowedCommands: ['npm test'],
            allowedPaths: [root],
            allowRepoEdits: true,
            allowTestsBuilds: true,
            denyNetworkExceptBroker: true,
            allowRemoteTriggerWithinScope: true,
            runnerKind: 'gemini',
            runnerCommand: persistedCommand,
            sessionGrants: [],
        }, null, 2), 'utf8');

        writeExecutable(path.join(binDir, 'codex'), '#!/bin/bash\nexit 0\n');
        writeExecutable(path.join(binDir, 'node'), `#!/bin/bash
printf '%s\n' "$@" > "${capturedArgsPath}"
`);

        const result = spawnSync(
            'bash',
            [path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-supervisor.sh'), '--mode', 'listen', '--agent-label', 'Gemma'],
            {
                cwd: root,
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(0);
        const capturedArgs = fs.readFileSync(capturedArgsPath, 'utf8');
        expect(capturedArgs).toContain('--runner-command');
        expect(capturedArgs).toContain('a2a-gemini-runner.sh');
        expect(capturedArgs).not.toContain('a2a-codex-runner.sh');

        fs.rmSync(root, { recursive: true, force: true });
    });

    it('infers gemini for non-interactive Gemma listeners instead of defaulting to codex', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-runner-label-'));
        const binDir = path.join(root, 'bin');
        const capturedArgsPath = path.join(root, 'captured-args');
        fs.mkdirSync(binDir, { recursive: true });

        writeExecutable(path.join(binDir, 'gemini'), '#!/bin/bash\nexit 0\n');
        writeExecutable(path.join(binDir, 'codex'), '#!/bin/bash\nexit 0\n');
        writeExecutable(path.join(binDir, 'node'), `#!/bin/bash
printf '%s\n' "$@" > "${capturedArgsPath}"
`);

        const result = spawnSync(
            'bash',
            [path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-supervisor.sh'), '--mode', 'listen', '--agent-label', 'Gemma'],
            {
                cwd: root,
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(0);
        const capturedArgs = fs.readFileSync(capturedArgsPath, 'utf8');
        expect(capturedArgs).toContain('--runner-kind');
        expect(capturedArgs).toContain('gemini');
        expect(capturedArgs).toContain('a2a-gemini-runner.sh');
        expect(capturedArgs).not.toContain('a2a-codex-runner.sh');

        fs.rmSync(root, { recursive: true, force: true });
    });

    it('preserves a custom persisted runner command with spaces', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-runner-custom-'));
        const binDir = path.join(root, 'bin');
        const capturedArgsPath = path.join(root, 'captured-args');
        const persistedCommand = 'bash /tmp/my\\ custom\\ runner.sh --model llama3';
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(path.join(root, '.a2a-listener-policy.json'), JSON.stringify({
            version: 1,
            mode: 'pre-authorized-listener',
            createdAt: '2026-04-11T00:00:00.000Z',
            expiresAt: '2099-04-11T00:00:00.000Z',
            brokerEndpoint: 'https://broker.a2alinker.net',
            workspaceRoot: root,
            allowedCommands: ['npm test'],
            allowedPaths: [root],
            allowRepoEdits: true,
            allowTestsBuilds: true,
            denyNetworkExceptBroker: true,
            allowRemoteTriggerWithinScope: true,
            runnerKind: 'custom',
            runnerCommand: persistedCommand,
            sessionGrants: [],
        }, null, 2), 'utf8');

        writeExecutable(path.join(binDir, 'node'), `#!/bin/bash
printf '%s\n' "$@" > "${capturedArgsPath}"
`);

        const result = spawnSync(
            'bash',
            [path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-supervisor.sh'), '--mode', 'listen', '--agent-label', 'LocalLLM'],
            {
                cwd: root,
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(0);
        const capturedArgs = fs.readFileSync(capturedArgsPath, 'utf8');
        expect(capturedArgs).toContain('--runner-kind');
        expect(capturedArgs).toContain('custom');
        expect(capturedArgs).toContain('/tmp/my\\\\ custom\\\\ runner.sh');
        expect(capturedArgs).toContain('--model llama3');

        fs.rmSync(root, { recursive: true, force: true });
    });

    it('rejects passing a listener code to the join script with a corrective message', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-join-usage-'));
        const binDir = path.join(root, 'bin');
        fs.mkdirSync(binDir, { recursive: true });

        writeExecutable(path.join(binDir, 'curl'), '#!/bin/bash\nexit 99\n');

        const result = spawnSync(
            'bash',
            ['.agents/skills/a2alinker/scripts/a2a-join-connect.sh'],
            {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                    A2A_INVITE: 'listen_demo123',
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(1);
        expect(result.stdout).toContain('Listener codes must be redeemed by HOST, not JOIN.');
        expect(result.stdout).toContain('a2a-host-connect.sh listen_demo123');
    });

    it('tells the host to send the first message after redeeming a listener code', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-host-usage-'));
        const binDir = path.join(root, 'bin');
        fs.mkdirSync(binDir, { recursive: true });

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
printf '%s' '{"token":"tok_abcdef123456","roomName":"room_demo","role":"host","headless":false,"status":"(2/2 connected)"}'
`);

        const result = spawnSync(
            'bash',
            ['.agents/skills/a2alinker/scripts/a2a-host-connect.sh', 'listen_demo123'],
            {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                    A2A_BASE_URL: 'http://127.0.0.1:3000',
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('ROLE: host');
        expect(result.stdout).toContain('NEXT_STEP: HOST sends the first message.');
        expect(result.stdout).toContain('a2a-loop.sh host "your message [OVER]"');
    });

    it('accepts listen as an alias for the listener-side join token when closing', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-leave-listen-'));
        const binDir = path.join(root, 'bin');
        const tokenPath = '/tmp/a2a_join_token';
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(tokenPath, 'tok_existing123', 'utf8');

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
printf '%s' '{"ok":true}'
`);

        const result = spawnSync(
            'bash',
            ['.agents/skills/a2alinker/scripts/a2a-leave.sh', 'listen'],
            {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                    A2A_BASE_URL: 'http://127.0.0.1:3000',
                    A2A_ALLOW_CLOSE: 'true',
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('LEFT');
        expect(fs.existsSync(tokenPath)).toBe(false);

        fs.rmSync(root, { recursive: true, force: true });
    });

    it('uses the host session backup token when /tmp/a2a_host_token is missing during close', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-leave-host-backup-'));
        const binDir = path.join(root, 'bin');
        const sessionDir = path.join(root, 'session');
        const backupTokenPath = path.join(sessionDir, 'a2a_host_token');
        const curlArgsPath = path.join(root, 'curl-args');
        fs.mkdirSync(binDir, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(backupTokenPath, 'tok_backup123\n', { encoding: 'utf8', mode: 0o600 });
        fs.writeFileSync(path.join(root, '.a2a-host-session.json'), JSON.stringify({
            mode: 'host',
            status: 'connected',
            attachedListenerCode: 'listen_demo123',
            inviteCode: null,
            brokerEndpoint: 'https://broker.a2alinker.net',
            headless: true,
            sessionDir,
            pid: null,
            startedAt: '2026-04-11T00:00:00.000Z',
            updatedAt: '2026-04-11T00:00:00.000Z',
            source: 'local_cache',
        }, null, 2), 'utf8');

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
printf '%s\n' "$@" > "${curlArgsPath}"
printf '%s' '{"ok":true}'
`);

        const result = spawnSync(
            'bash',
            [path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-leave.sh'), 'host'],
            {
                cwd: root,
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                    A2A_ALLOW_CLOSE: 'true',
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('LEFT');
        expect(fs.readFileSync(curlArgsPath, 'utf8')).toContain('https://broker.a2alinker.net/leave');
        expect(fs.existsSync(backupTokenPath)).toBe(false);

        fs.rmSync(root, { recursive: true, force: true });
    });

    it('resolves the broker from the host session artifact when send.sh runs without broker env', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-send-artifact-'));
        const binDir = path.join(root, 'bin');
        const tokenPath = '/tmp/a2a_host_token';
        const curlArgsPath = path.join(root, 'curl-args');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(tokenPath, 'tok_existing123', 'utf8');
        fs.writeFileSync(path.join(root, '.a2a-host-session.json'), JSON.stringify({
            mode: 'host',
            status: 'connected',
            attachedListenerCode: 'listen_demo123',
            inviteCode: null,
            brokerEndpoint: 'https://broker.a2alinker.net',
            headless: true,
            sessionDir: path.join(root, 'session'),
            pid: null,
            startedAt: '2026-04-11T00:00:00.000Z',
            updatedAt: '2026-04-11T00:00:00.000Z',
            source: 'local_cache',
        }, null, 2), 'utf8');

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
printf '%s\n' "$@" > "${curlArgsPath}"
printf 'DELIVERED\n200'
`);

        const result = spawnSync(
            'bash',
            [path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-send.sh'), 'host', 'hello [OVER]'],
            {
                cwd: root,
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('DELIVERED');
        expect(fs.readFileSync(curlArgsPath, 'utf8')).toContain('https://broker.a2alinker.net/send');

        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(tokenPath, { force: true });
    });

    it('defaults a2a-send.sh to the host role when only a message is provided', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-send-default-host-'));
        const binDir = path.join(root, 'bin');
        const tokenPath = '/tmp/a2a_host_token';
        const curlArgsPath = path.join(root, 'curl-args');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(tokenPath, 'tok_existing123', 'utf8');

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
printf '%s\n' "$@" > "${curlArgsPath}"
printf 'DELIVERED\n200'
`);

        const result = spawnSync(
            'bash',
            [path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-send.sh'), 'Established connection. Please provide a confirmation message. [OVER]'],
            {
                cwd: root,
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                    A2A_BASE_URL: 'https://broker.a2alinker.net',
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('DELIVERED');
        expect(fs.readFileSync(curlArgsPath, 'utf8')).toContain('https://broker.a2alinker.net/send');

        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(tokenPath, { force: true });
    });

    it('sends successfully from a host session artifact when the caller omits both role and broker env', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-send-trace-shape-'));
        const binDir = path.join(root, 'bin');
        const tokenPath = '/tmp/a2a_host_token';
        const curlArgsPath = path.join(root, 'curl-args');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(tokenPath, 'tok_existing123', 'utf8');
        fs.writeFileSync(path.join(root, '.a2a-host-session.json'), JSON.stringify({
            mode: 'host',
            status: 'connected',
            attachedListenerCode: 'listen_demo123',
            inviteCode: null,
            brokerEndpoint: 'https://broker.a2alinker.net',
            headless: true,
            sessionDir: path.join(root, 'session'),
            pid: null,
            startedAt: '2026-04-11T00:00:00.000Z',
            updatedAt: '2026-04-11T00:00:00.000Z',
            source: 'local_cache',
        }, null, 2), 'utf8');

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
printf '%s\n' "$@" > "${curlArgsPath}"
printf 'DELIVERED\n200'
`);

        const result = spawnSync(
            'bash',
            [path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-send.sh'), 'Established connection. Please provide a confirmation message. [OVER]'],
            {
                cwd: root,
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('DELIVERED');
        expect(fs.readFileSync(curlArgsPath, 'utf8')).toContain('https://broker.a2alinker.net/send');

        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(tokenPath, { force: true });
    });

    it('preserves the existing host token if a listener reconnect attempt fails', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-host-token-guard-'));
        const binDir = path.join(root, 'bin');
        const tokenPath = '/tmp/a2a_host_token';
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(tokenPath, 'tok_existing123', 'utf8');

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
printf '%s' '{"error":"Invite code invalid or already used"}'
`);

        const result = spawnSync(
            'bash',
            ['.agents/skills/a2alinker/scripts/a2a-host-connect.sh', 'listen_demo123'],
            {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                    A2A_BASE_URL: 'http://127.0.0.1:3000',
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(1);
        expect(result.stdout).toContain('ERROR: Invite code invalid or already used');
        expect(fs.readFileSync(tokenPath, 'utf8')).toBe('tok_existing123');

        if (fs.existsSync(tokenPath)) {
            fs.unlinkSync(tokenPath);
        }
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('supports stdin-based loop sends for multiline or shell-sensitive content', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-loop-stdin-'));
        const binDir = path.join(root, 'bin');
        const capturePath = path.join(root, 'captured-message');
        const tokenPath = '/tmp/a2a_host_token';
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(tokenPath, 'tok_existing123', 'utf8');

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
if printf '%s ' "$@" | grep -q '/send'; then
  for arg in "$@"; do
    case "$arg" in
      @*)
        FILE_PATH="$(printf '%s' "$arg" | sed 's/^@//')"
        cat "$FILE_PATH" > "${capturePath}"
        ;;
    esac
  done
  printf 'DELIVERED\\n200'
  exit 0
fi
if printf '%s ' "$@" | grep -q '/wait'; then
  printf 'MESSAGE_RECEIVED\\n[SYSTEM]: HOST has closed the session. You are disconnected.\\n200'
  exit 0
fi
printf 'TIMEOUT_ROOM_CLOSED\\n200'
`);

        const result = spawnSync(
            'bash',
            ['.agents/skills/a2alinker/scripts/a2a-loop.sh', 'host', '--stdin'],
            {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                    A2A_BASE_URL: 'http://127.0.0.1:3000',
                },
                input: '<!DOCTYPE html>\n<script>const x = `hi`;</script>\n[OVER]\n',
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('DELIVERED');
        expect(fs.readFileSync(capturePath, 'utf8')).toContain('<!DOCTYPE html>');
        expect(fs.readFileSync(capturePath, 'utf8')).toContain('const x = `hi`;');

        fs.unlinkSync(tokenPath);
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('tells the listener side to keep a waiter active if it wants to observe close events', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-listen-usage-'));
        const binDir = path.join(root, 'bin');
        fs.mkdirSync(binDir, { recursive: true });

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
printf '%s' '{"token":"tok_listener123456","listenerCode":"listen_demo123"}'
`);

        const result = spawnSync(
            'bash',
            ['.agents/skills/a2alinker/scripts/a2a-listen.sh', 'false'],
            {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                    A2A_BASE_URL: 'http://127.0.0.1:3000',
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('ROLE: join');
        expect(result.stdout).toContain('LISTENER_CODE: listen_demo123');
        expect(result.stdout).toContain('a2a-loop.sh join');

        fs.rmSync(root, { recursive: true, force: true });
    });

    it('refuses to leave an active session without explicit close authorization', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-leave-usage-'));
        const tokenPath = '/tmp/a2a_host_token';
        fs.writeFileSync(tokenPath, 'tok_demo123', 'utf8');

        const result = spawnSync(
            'bash',
            ['.agents/skills/a2alinker/scripts/a2a-leave.sh', 'host'],
            {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    A2A_BASE_URL: 'http://127.0.0.1:3000',
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(1);
        expect(result.stdout).toContain('LEAVE_DENIED');
        expect(result.stdout).toContain('A2A_ALLOW_CLOSE=true');
        expect(fs.readFileSync(tokenPath, 'utf8')).toBe('tok_demo123');

        fs.unlinkSync(tokenPath);
        fs.rmSync(root, { recursive: true, force: true });
    });
});
