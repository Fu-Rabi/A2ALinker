import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

function writeExecutable(filePath: string, contents: string): void {
    fs.writeFileSync(filePath, contents, 'utf8');
    fs.chmodSync(filePath, 0o755);
}

function copyFile(sourcePath: string, destinationPath: string): void {
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
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
                    A2A_RUNNER_KIND: 'codex',
                    A2A_ALLOW_WEB_ACCESS: 'false',
                    A2A_ALLOW_TESTS_BUILDS: 'true',
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
        expect(result.stderr).toContain('LISTENER_START mode=unattended');
        expect(result.stderr).toContain('RUNNER=codex');
        expect(result.stderr).toContain('WEB_ACCESS=false');
        expect(result.stderr).toContain('TESTS_BUILDS=true');

        fs.rmSync(root, { recursive: true, force: true });
    });

    it('fails fast for unattended listeners when runner selection is missing', () => {
        const result = spawnSync(
            'bash',
            ['.agents/skills/a2alinker/scripts/a2a-supervisor.sh', '--mode', 'listen', '--agent-label', 'Codi'],
            {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    A2A_BASE_URL: 'https://broker.a2alinker.net',
                    A2A_UNATTENDED: 'true',
                    A2A_ALLOW_WEB_ACCESS: 'false',
                    A2A_ALLOW_TESTS_BUILDS: 'true',
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('LISTENER_START_ERROR: missing_runner_selection');
    });

    it('fails fast for unattended listeners when web access selection is missing', () => {
        const result = spawnSync(
            'bash',
            ['.agents/skills/a2alinker/scripts/a2a-supervisor.sh', '--mode', 'listen', '--agent-label', 'Codi'],
            {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    A2A_BASE_URL: 'https://broker.a2alinker.net',
                    A2A_UNATTENDED: 'true',
                    A2A_RUNNER_KIND: 'codex',
                    A2A_ALLOW_TESTS_BUILDS: 'true',
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('LISTENER_START_ERROR: missing_web_access_selection');
    });

    it('fails fast for unattended listeners when tests/builds selection is missing', () => {
        const result = spawnSync(
            'bash',
            ['.agents/skills/a2alinker/scripts/a2a-supervisor.sh', '--mode', 'listen', '--agent-label', 'Codi'],
            {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    A2A_BASE_URL: 'https://broker.a2alinker.net',
                    A2A_UNATTENDED: 'true',
                    A2A_RUNNER_KIND: 'codex',
                    A2A_ALLOW_WEB_ACCESS: 'false',
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('LISTENER_START_ERROR: missing_tests_builds_selection');
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

    it('enables debug mode for the folder and persists the marker', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-supervisor-debug-prompt-'));
        const capturedPath = path.join(root, 'captured-env');
        copyFile(
            path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-common.sh'),
            path.join(root, '.agents/skills/a2alinker/scripts/a2a-common.sh'),
        );

        const result = spawnSync(
            'bash',
            ['-lc', `. .agents/skills/a2alinker/scripts/a2a-common.sh && a2a_enable_debug_mode && printf 'A2A_DEBUG=%s\\n' "\${A2A_DEBUG:-}" > "${capturedPath}"`],
            {
                cwd: root,
                env: process.env,
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(0);
        expect(fs.readFileSync(capturedPath, 'utf8')).toContain('A2A_DEBUG=1');
        expect(fs.readFileSync(path.join(root, '.a2a-debug-mode'), 'utf8')).toContain('enabled');

        fs.rmSync(root, { recursive: true, force: true });
    });

    it('passes the packaged runtime target when the wrapper falls back without repo dist or src', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-supervisor-packaged-'));
        const binDir = path.join(root, 'bin');
        const capturedArgsPath = path.join(root, 'captured-args');
        const repoRoot = process.cwd();
        const packagedRuntimePath = path.join(root, '.agents/skills/a2alinker/runtime/a2a-supervisor.js');
        fs.mkdirSync(binDir, { recursive: true });

        copyFile(
            path.join(repoRoot, '.agents/skills/a2alinker/scripts/a2a-supervisor.sh'),
            path.join(root, '.agents/skills/a2alinker/scripts/a2a-supervisor.sh'),
        );
        copyFile(
            path.join(repoRoot, '.agents/skills/a2alinker/scripts/a2a-common.sh'),
            path.join(root, '.agents/skills/a2alinker/scripts/a2a-common.sh'),
        );
        copyFile(
            path.join(repoRoot, '.agents/skills/a2alinker/runtime/a2a-supervisor.js'),
            packagedRuntimePath,
        );

        writeExecutable(path.join(binDir, 'node'), `#!/bin/bash
printf '%s\n' "$@" > "${capturedArgsPath}"
`);

        const result = spawnSync(
            'bash',
            [path.join(root, '.agents/skills/a2alinker/scripts/a2a-supervisor.sh'), '--help'],
            {
                cwd: root,
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                    A2A_RUNNER_KIND: 'codex',
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(0);
        const capturedArgs = fs.readFileSync(capturedArgsPath, 'utf8').trim().split('\n');
        const [runtimeArg] = capturedArgs;
        expect(runtimeArg).toBeDefined();
        expect(path.resolve(root, runtimeArg!)).toBe(packagedRuntimePath);
        expect(capturedArgs).toContain('--help');

        fs.rmSync(root, { recursive: true, force: true });
    });

    it('ignores a persisted listener policy runner on a fresh listener launch', () => {
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
            [path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-supervisor.sh'), '--mode', 'listen', '--agent-label', 'Codi'],
            {
                cwd: root,
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                    A2A_RUNNER_KIND: 'codex',
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(0);
        const capturedArgs = fs.readFileSync(capturedArgsPath, 'utf8');
        expect(capturedArgs).toContain('--runner-command');
        expect(capturedArgs).toContain('a2a-codex-runner.sh');
        expect(capturedArgs).not.toContain('a2a-gemini-runner.sh');

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

    it('ignores a custom persisted listener runner command with spaces on a fresh listener launch', () => {
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

        writeExecutable(path.join(binDir, 'codex'), '#!/bin/bash\nexit 0\n');
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
                    A2A_RUNNER_KIND: 'codex',
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(0);
        const capturedArgs = fs.readFileSync(capturedArgsPath, 'utf8');
        expect(capturedArgs).toContain('--runner-kind');
        expect(capturedArgs).toContain('codex');
        expect(capturedArgs).toContain('a2a-codex-runner.sh');
        expect(capturedArgs).not.toContain('/tmp/my\\\\ custom\\\\ runner.sh');
        expect(capturedArgs).not.toContain('--model llama3');

        fs.rmSync(root, { recursive: true, force: true });
    });

    it('prefers an explicit env runner kind over a persisted listener runner', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-runner-explicit-env-'));
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
            [path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-supervisor.sh'), '--mode', 'listen', '--agent-label', 'Codi'],
            {
                cwd: root,
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                    A2A_RUNNER_KIND: 'codex',
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(0);
        const capturedArgs = fs.readFileSync(capturedArgsPath, 'utf8');
        expect(capturedArgs).toContain('--runner-kind');
        expect(capturedArgs).toContain('codex');
        expect(capturedArgs).toContain('a2a-codex-runner.sh');
        expect(capturedArgs).not.toContain('a2a-gemini-runner.sh');

        fs.rmSync(root, { recursive: true, force: true });
    });

    it('prefers an explicit CLI runner kind over a persisted listener runner', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-runner-explicit-cli-'));
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
            [path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-supervisor.sh'), '--mode', 'listen', '--agent-label', 'Codi', '--runner-kind', 'codex'],
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
        expect(capturedArgs).toContain('codex');
        expect(capturedArgs).toContain('a2a-codex-runner.sh');
        expect(capturedArgs).not.toContain('a2a-gemini-runner.sh');

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

    it('surfaces duplicate waiter conflicts instead of hiding them as ping failures', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-wait-409-'));
        const binDir = path.join(root, 'bin');
        const tokenPath = '/tmp/a2a_host_token';
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(tokenPath, 'tok_existing123', 'utf8');

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
if printf '%s ' "$@" | grep -q '/wait'; then
  printf '{"error":"Wait already pending"}\\n409'
  exit 0
fi
printf '{"room_alive":true,"partner_connected":true,"partner_last_seen_ms":0}\\n200'
`);

        const result = spawnSync(
            'bash',
            ['.agents/skills/a2alinker/scripts/a2a-wait-message.sh', 'host'],
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
        expect(result.stdout).toContain('WAIT_ALREADY_PENDING');

        fs.unlinkSync(tokenPath);
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('retries a transient duplicate waiter conflict before surfacing it', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-loop-wait-retry-'));
        const scriptDir = path.join(root, 'scripts');
        const statePath = path.join(root, 'wait-count');
        fs.mkdirSync(scriptDir, { recursive: true });

        copyFile('.agents/skills/a2alinker/scripts/a2a-loop.sh', path.join(scriptDir, 'a2a-loop.sh'));
        copyFile('.agents/skills/a2alinker/scripts/a2a-common.sh', path.join(scriptDir, 'a2a-common.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-loop.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-common.sh'), 0o755);

        writeExecutable(path.join(scriptDir, 'a2a-wait-message.sh'), `#!/bin/bash
STATE_FILE="${statePath}"
COUNT=0
if [ -f "$STATE_FILE" ]; then
  COUNT="$(cat "$STATE_FILE")"
fi
COUNT=$((COUNT + 1))
echo "$COUNT" > "$STATE_FILE"
if [ "$COUNT" -lt 3 ]; then
  echo "WAIT_ALREADY_PENDING"
else
  cat <<'EOF'
MESSAGE_RECEIVED
┌─ Agent-join [OVER]
│
│ Reply after waiter handoff
└────
EOF
fi
`);

        try {
            const result = withHostToken('tok_wait_retry', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-loop.sh'), 'host'],
                {
                    cwd: root,
                    env: {
                        ...process.env,
                        A2A_MAX_WAIT_CONFLICTS: '4',
                    },
                    encoding: 'utf8',
                },
            ));

            expect(result.status).toBe(0);
            expect(result.stdout).toContain('Reply after waiter handoff');
            expect(fs.readFileSync(statePath, 'utf8').trim()).toBe('3');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('restores the host passive waiter when the foreground chat is interrupted', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-chat-interrupt-'));
        const scriptDir = path.join(root, 'scripts');
        const sessionDir = path.join(root, 'session');
        const waiterStartedPath = path.join(root, 'waiter-started');
        const inflightPath = path.join(sessionDir, 'a2a_host_inflight_message.txt');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });

        copyFile('.agents/skills/a2alinker/scripts/a2a-chat.sh', path.join(scriptDir, 'a2a-chat.sh'));
        copyFile('.agents/skills/a2alinker/scripts/a2a-common.sh', path.join(scriptDir, 'a2a-common.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-chat.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-common.sh'), 0o755);

        fs.writeFileSync(path.join(root, '.a2a-host-session.json'), JSON.stringify({
            mode: 'host',
            sessionDir,
        }), 'utf8');

        writeExecutable(path.join(scriptDir, 'a2a-loop.sh'), `#!/bin/bash
SESSION_DIR="${sessionDir}"
printf '%s\\n' "probe [OVER]" > "$SESSION_DIR/a2a_host_inflight_message.txt"
echo "DELIVERED"
kill -TERM "$PPID"
sleep 1
`);
        writeExecutable(path.join(scriptDir, 'a2a-passive-wait.sh'), `#!/bin/bash
mkdir -p "${sessionDir}"
printf '%s\\n' "$$" > "${sessionDir}/a2a_host_passive_wait.pid"
echo started >> "${waiterStartedPath}"
`);

        try {
            const result = withHostToken('tok_host_interrupt', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-chat.sh'), 'host', 'probe [OVER]'],
                {
                    cwd: root,
                    encoding: 'utf8',
                },
            ));

            expect(result.status).not.toBe(0);
            expect(fs.readFileSync(waiterStartedPath, 'utf8')).toContain('started');
            expect(fs.readFileSync(inflightPath, 'utf8')).toContain('probe [OVER]');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('syncs host artifact state back to waiting_for_local_task when the passive waiter restarts', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-chat-artifact-sync-'));
        const scriptDir = path.join(root, 'scripts');
        const sessionDir = path.join(root, 'session');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });

        copyFile('.agents/skills/a2alinker/scripts/a2a-chat.sh', path.join(scriptDir, 'a2a-chat.sh'));
        copyFile('.agents/skills/a2alinker/scripts/a2a-common.sh', path.join(scriptDir, 'a2a-common.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-chat.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-common.sh'), 0o755);

        fs.writeFileSync(path.join(root, '.a2a-host-session.json'), JSON.stringify({
            mode: 'host',
            status: 'connected',
            lastEvent: 'foreground_chat_active',
            sessionDir,
            pid: null,
            startedAt: '2026-04-18T00:00:00.000Z',
            updatedAt: '2026-04-18T00:00:00.000Z',
            source: 'local_cache',
        }), 'utf8');

        writeExecutable(path.join(scriptDir, 'a2a-loop.sh'), `#!/bin/bash
cat <<'EOF'
MESSAGE_RECEIVED
┌─ Agent-join [OVER]
│
│ Reply after normal turn
└────
EOF
`);
        writeExecutable(path.join(scriptDir, 'a2a-passive-wait.sh'), `#!/bin/bash
mkdir -p "${sessionDir}"
printf '%s\\n' "$$" > "${sessionDir}/a2a_host_passive_wait.pid"
sleep 1
`);

        try {
            const result = withHostToken('tok_host_artifact_sync', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-chat.sh'), 'host', 'probe [OVER]'],
                {
                    cwd: root,
                    encoding: 'utf8',
                },
            ));

            expect(result.status).toBe(0);
            const artifact = JSON.parse(fs.readFileSync(path.join(root, '.a2a-host-session.json'), 'utf8'));
            expect(artifact.status).toBe('waiting_for_local_task');
            expect(artifact.lastEvent).toBe('waiting_for_local_task');
            expect(typeof artifact.pid).toBe('number');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('does not start a new passive waiter when foreground chat reports WAIT_ALREADY_PENDING', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-chat-wait-conflict-'));
        const scriptDir = path.join(root, 'scripts');
        const sessionDir = path.join(root, 'session');
        const waiterStartedPath = path.join(root, 'waiter-started');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });

        copyFile('.agents/skills/a2alinker/scripts/a2a-chat.sh', path.join(scriptDir, 'a2a-chat.sh'));
        copyFile('.agents/skills/a2alinker/scripts/a2a-common.sh', path.join(scriptDir, 'a2a-common.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-chat.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-common.sh'), 0o755);

        fs.writeFileSync(path.join(root, '.a2a-host-session.json'), JSON.stringify({
            mode: 'host',
            status: 'waiting_for_local_task',
            sessionDir,
            pid: 123456,
            startedAt: '2026-04-18T00:00:00.000Z',
            updatedAt: '2026-04-18T00:00:00.000Z',
            source: 'local_cache',
        }), 'utf8');

        writeExecutable(path.join(scriptDir, 'a2a-loop.sh'), `#!/bin/bash
echo "DELIVERED"
echo "WAIT_ALREADY_PENDING"
`);
        writeExecutable(path.join(scriptDir, 'a2a-passive-wait.sh'), `#!/bin/bash
echo started >> "${waiterStartedPath}"
`);

        try {
            const result = withHostToken('tok_wait_conflict', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-chat.sh'), 'host', 'probe [OVER]'],
                {
                    cwd: root,
                    encoding: 'utf8',
                },
            ));

            expect(result.status).toBe(0);
            expect(result.stdout).toContain('WAIT_ALREADY_PENDING');
            expect(fs.existsSync(waiterStartedPath)).toBe(false);
            const artifact = JSON.parse(fs.readFileSync(path.join(root, '.a2a-host-session.json'), 'utf8'));
            expect(artifact.status).toBe('error');
            expect(artifact.lastEvent).toBe('WAIT_ALREADY_PENDING');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('waits for the partner reply without resending after an interrupted delivered host send', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-chat-resume-'));
        const scriptDir = path.join(root, 'scripts');
        const sessionDir = path.join(root, 'session');
        const sendsPath = path.join(root, 'sends.log');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });

        copyFile('.agents/skills/a2alinker/scripts/a2a-chat.sh', path.join(scriptDir, 'a2a-chat.sh'));
        copyFile('.agents/skills/a2alinker/scripts/a2a-common.sh', path.join(scriptDir, 'a2a-common.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-chat.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-common.sh'), 0o755);

        fs.writeFileSync(path.join(root, '.a2a-host-session.json'), JSON.stringify({
            mode: 'host',
            sessionDir,
        }), 'utf8');

        writeExecutable(path.join(scriptDir, 'a2a-loop.sh'), `#!/bin/bash
SESSION_DIR="${sessionDir}"
printf '%s\\n' "$2" >> "${sendsPath}"
printf '%s\\n' "$2" > "$SESSION_DIR/a2a_host_inflight_message.txt"
echo "DELIVERED"
kill -TERM "$PPID"
sleep 1
`);
        writeExecutable(path.join(scriptDir, 'a2a-passive-wait.sh'), `#!/bin/bash
mkdir -p "${sessionDir}"
printf '%s\\n' "$$" > "${sessionDir}/a2a_host_passive_wait.pid"
cat <<'EOF' > "${sessionDir}/a2a_host_pending_message.txt"
MESSAGE_RECEIVED
┌─ Agent-join [OVER]
│
│ Reply after interrupted send
└────
EOF
`);

        try {
            withHostToken('tok_host_resume', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-chat.sh'), 'host', 'probe [OVER]'],
                {
                    cwd: root,
                    encoding: 'utf8',
                },
            ));

            const resumed = withHostToken('tok_host_resume', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-chat.sh'), 'host', 'probe [OVER]'],
                {
                    cwd: root,
                    encoding: 'utf8',
                },
            ));

            expect(resumed.status).toBe(0);
            expect(resumed.stdout).toContain('Previous host send was already delivered before interruption');
            expect(resumed.stdout).toContain('Reply after interrupted send');
            expect(fs.readFileSync(sendsPath, 'utf8').trim().split('\n')).toEqual(['probe [OVER]']);
            expect(fs.existsSync(path.join(sessionDir, 'a2a_host_inflight_message.txt'))).toBe(false);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('uses the saved folder debug marker without prompting again in chat mode', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-chat-debug-marker-'));
        const scriptDir = path.join(root, 'scripts');
        const sessionDir = path.join(root, 'session');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });

        copyFile('.agents/skills/a2alinker/scripts/a2a-chat.sh', path.join(scriptDir, 'a2a-chat.sh'));
        copyFile('.agents/skills/a2alinker/scripts/a2a-common.sh', path.join(scriptDir, 'a2a-common.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-chat.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-common.sh'), 0o755);

        fs.writeFileSync(path.join(root, '.a2a-host-session.json'), JSON.stringify({
            mode: 'host',
            sessionDir,
        }), 'utf8');
        fs.writeFileSync(path.join(root, '.a2a-debug-mode'), 'enabled\n', 'utf8');

        writeExecutable(path.join(scriptDir, 'a2a-loop.sh'), `#!/bin/bash
echo "MESSAGE_RECEIVED"
echo "debug=\${A2A_DEBUG:-0}"
`);

        try {
            const result = withHostToken('tok_host_debug_marker', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-chat.sh'), 'host'],
                {
                    cwd: root,
                    encoding: 'utf8',
                },
            ));

            expect(result.status).toBe(0);
            expect(result.stdout).toContain('debug=1');
            expect(result.stdout).not.toContain('Run in debug mode?');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('maps host token loss to TIMEOUT_ROOM_CLOSED when the local listener artifact is already closed', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-wait-listener-closed-'));
        const scriptDir = path.join(root, 'scripts');
        fs.mkdirSync(scriptDir, { recursive: true });

        copyFile('.agents/skills/a2alinker/scripts/a2a-wait-message.sh', path.join(scriptDir, 'a2a-wait-message.sh'));
        copyFile('.agents/skills/a2alinker/scripts/a2a-common.sh', path.join(scriptDir, 'a2a-common.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-wait-message.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-common.sh'), 0o755);

        fs.writeFileSync(path.join(root, '.a2a-listener-session.json'), JSON.stringify({
            mode: 'listen',
            status: 'closed',
            lastEvent: 'system_closed',
            sessionDir: path.join(root, 'listener-session'),
        }), 'utf8');

        try {
            const result = spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-wait-message.sh'), 'host'],
                {
                    cwd: root,
                    encoding: 'utf8',
                },
            );

            expect(result.status).toBe(0);
            expect(result.stdout.trim()).toBe('TIMEOUT_ROOM_CLOSED');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('resends once if an interrupted delivered host send has no recoverable reply', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-chat-recover-resend-'));
        const scriptDir = path.join(root, 'scripts');
        const sessionDir = path.join(root, 'session');
        const sendsPath = path.join(root, 'sends.log');
        const waitStatePath = path.join(root, 'wait-state');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });

        copyFile('.agents/skills/a2alinker/scripts/a2a-chat.sh', path.join(scriptDir, 'a2a-chat.sh'));
        copyFile('.agents/skills/a2alinker/scripts/a2a-common.sh', path.join(scriptDir, 'a2a-common.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-chat.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-common.sh'), 0o755);

        fs.writeFileSync(path.join(root, '.a2a-host-session.json'), JSON.stringify({
            mode: 'host',
            sessionDir,
        }), 'utf8');

        writeExecutable(path.join(scriptDir, 'a2a-loop.sh'), `#!/bin/bash
SESSION_DIR="${sessionDir}"
printf '%s\\n' "$2" >> "${sendsPath}"
printf '%s\\n' "$2" > "$SESSION_DIR/a2a_host_inflight_message.txt"
echo "DELIVERED"
STATE_FILE="${waitStatePath}"
COUNT=0
if [ -f "$STATE_FILE" ]; then
  COUNT="$(cat "$STATE_FILE")"
fi
COUNT=$((COUNT + 1))
echo "$COUNT" > "$STATE_FILE"
if [ "$COUNT" -eq 1 ]; then
  kill -TERM "$PPID"
  sleep 1
fi
cat <<'EOF'
MESSAGE_RECEIVED
┌─ Agent-join [OVER]
│
│ Reply after resend
└────
EOF
`);
        writeExecutable(path.join(scriptDir, 'a2a-wait-message.sh'), `#!/bin/bash
echo "TIMEOUT_ROOM_ALIVE last_seen_ms=0"
`);
        writeExecutable(path.join(scriptDir, 'a2a-passive-wait.sh'), `#!/bin/bash
mkdir -p "${sessionDir}"
printf '%s\\n' "$$" > "${sessionDir}/a2a_host_passive_wait.pid"
`);

        try {
            withHostToken('tok_host_recover_resend', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-chat.sh'), 'host', 'probe [OVER]'],
                {
                    cwd: root,
                    encoding: 'utf8',
                },
            ));

            const resumed = withHostToken('tok_host_recover_resend', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-chat.sh'), 'host', 'probe [OVER]'],
                {
                    cwd: root,
                    encoding: 'utf8',
                    env: {
                        ...process.env,
                        A2A_INFLIGHT_RECOVERY_WAIT_TIMEOUT: '1',
                    },
                },
            ));

            expect(resumed.status).toBe(0);
            expect(resumed.stdout).toContain('No reply was recoverable within 1s, so the message will be resent once');
            expect(resumed.stdout).toContain('Reply after resend');
            expect(fs.readFileSync(sendsPath, 'utf8').trim().split('\n')).toEqual(['probe [OVER]', 'probe [OVER]']);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
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

    it('reports the broker endpoint and curl exit code when listener setup cannot reach the relay', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-listen-error-'));
        const binDir = path.join(root, 'bin');
        fs.mkdirSync(binDir, { recursive: true });

        writeExecutable(path.join(binDir, 'curl'), '#!/bin/bash\nexit 6\n');

        const result = spawnSync(
            'bash',
            ['.agents/skills/a2alinker/scripts/a2a-listen.sh', 'true'],
            {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                    A2A_BASE_URL: 'https://broker.a2alinker.net',
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(1);
        expect(result.stdout).toContain('ERROR: Cannot reach A2A Linker server at https://broker.a2alinker.net (curl exit 6)');

        fs.rmSync(root, { recursive: true, force: true });
    });

    it('uses the saved folder debug marker in a2a-listen.sh and writes a join debug log', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-listen-debug-marker-'));
        const binDir = path.join(root, 'bin');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(path.join(root, '.a2a-debug-mode'), 'enabled\n', 'utf8');

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
printf '%s' '{"token":"tok_listener123456","listenerCode":"listen_debug123"}'
`);

        const result = spawnSync(
            'bash',
            [path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-listen.sh'), 'false'],
            {
                cwd: root,
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                    A2A_BASE_URL: 'http://127.0.0.1:3000',
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(0);
        const debugLog = fs.readFileSync('/tmp/a2a_join_debug.log', 'utf8');
        expect(debugLog).toContain('listen:start');
        expect(debugLog).toContain('listen:setup_complete listener_code=listen_debug123');

        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync('/tmp/a2a_join_debug.log', { force: true });
        fs.rmSync('/tmp/a2a_join_token', { force: true });
    });

    it('uses the saved folder debug marker in a2a-host-connect.sh and writes a host debug log', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-host-connect-debug-marker-'));
        const binDir = path.join(root, 'bin');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(path.join(root, '.a2a-debug-mode'), 'enabled\n', 'utf8');

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
printf '%s' '{"token":"tok_host123456","inviteCode":"invite_debug123"}'
`);

        const result = spawnSync(
            'bash',
            [path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-host-connect.sh')],
            {
                cwd: root,
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                    A2A_BASE_URL: 'http://127.0.0.1:3000',
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(0);
        const debugLog = fs.readFileSync('/tmp/a2a_host_debug.log', 'utf8');
        expect(debugLog).toContain('host_connect:start mode=standard');
        expect(debugLog).toContain('host_connect:setup_complete invite_code=invite_debug123');

        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync('/tmp/a2a_host_debug.log', { force: true });
        fs.rmSync('/tmp/a2a_host_token', { force: true });
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
