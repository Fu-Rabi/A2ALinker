import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';

function writeExecutable(filePath: string, contents: string): void {
    fs.writeFileSync(filePath, contents, 'utf8');
    fs.chmodSync(filePath, 0o755);
}

function copyFile(sourcePath: string, destinationPath: string): void {
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
}

function clearA2ATmpState(): void {
    fs.rmSync('/tmp/a2a_host_base_url', { force: true });
    fs.rmSync('/tmp/a2a_join_base_url', { force: true });
    fs.rmSync('/tmp/a2a_host_debug.log', { force: true });
    fs.rmSync('/tmp/a2a_join_debug.log', { force: true });
    fs.rmSync('/tmp/a2a_host_token', { force: true });
    fs.rmSync('/tmp/a2a_join_token', { force: true });
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

async function waitForLogLines(filePath: string, minLines: number): Promise<string[]> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (fs.existsSync(filePath)) {
            const contents = fs.readFileSync(filePath, 'utf8').trim();
            if (contents.length > 0) {
                const lines = contents.split('\n');
                if (lines.length >= minLines) {
                    return lines;
                }
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }

    if (!fs.existsSync(filePath)) {
        return [];
    }

    const contents = fs.readFileSync(filePath, 'utf8').trim();
    return contents ? contents.split('\n') : [];
}

async function waitForCondition(check: () => boolean, timeoutMs = 3000): Promise<void> {
    const startedAt = Date.now();
    while (!check()) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error('Timed out waiting for condition');
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

describe('A2A shell script usage guards', () => {
    beforeEach(() => {
        clearA2ATmpState();
    });

    afterEach(() => {
        clearA2ATmpState();
    });

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
        expect(result.stderr).not.toContain('Verifying listener stability...');
        expect(result.stderr).not.toContain('Listener startup was unstable');
        expect(result.stderr).toContain('RUNNER=codex');
        expect(result.stderr).toContain('WEB_ACCESS=false');
        expect(result.stderr).toContain('TESTS_BUILDS=true');

        fs.rmSync(root, { recursive: true, force: true });
    });

    it('releases an unattended listener code only after the child survives SIGHUP verification', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-supervisor-hup-survive-'));
        const binDir = path.join(root, 'bin');
        const fakeSupervisorPath = path.join(root, 'fake-supervisor.js');
        fs.mkdirSync(binDir, { recursive: true });

        fs.writeFileSync(fakeSupervisorPath, `
const fs = require('fs');
const path = require('path');

const artifact = path.join(process.cwd(), '.a2a-listener-session.json');
const writeState = () => fs.writeFileSync(artifact, JSON.stringify({
  mode: 'listen',
  status: 'waiting_for_host',
  listenerCode: 'listen_hupresilient',
  brokerEndpoint: 'https://broker.a2alinker.net',
  headless: true,
  sessionDir: path.join(process.cwd(), 'session'),
  pid: process.pid,
  startedAt: '2026-04-29T00:00:00.000Z',
  updatedAt: '2026-04-29T00:00:00.000Z',
  source: 'local_cache',
}, null, 2));

process.on('SIGHUP', () => {
  writeState();
});
writeState();
console.log('LISTENER_CODE: listen_hupresilient');
setInterval(() => {}, 1000);
`, 'utf8');
        writeExecutable(path.join(binDir, 'nohup'), `#!/bin/bash
exec "$@"
`);
        writeExecutable(path.join(binDir, 'node'), `#!/bin/bash
if [ "\${1:-}" = "--check" ]; then
  exit 0
fi
if [ "\${1:-}" = "-e" ]; then
  exec "${process.execPath}" "$@"
fi
exec "${process.execPath}" "${fakeSupervisorPath}"
`);
        writeExecutable(path.join(binDir, 'codex'), '#!/bin/bash\nexit 0\n');

        const result = spawnSync(
            'bash',
            [path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-supervisor.sh'), '--mode', 'listen', '--agent-label', 'Codi'],
            {
                cwd: root,
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                    A2A_BASE_URL: 'https://broker.a2alinker.net',
                    A2A_UNATTENDED: 'true',
                    A2A_RUNNER_KIND: 'codex',
                    A2A_ALLOW_WEB_ACCESS: 'true',
                    A2A_ALLOW_TESTS_BUILDS: 'true',
                    A2A_DETACH_LISTENER: 'true',
                    A2A_LISTENER_MAX_ATTEMPTS: '1',
                    A2A_LISTENER_STARTUP_TIMEOUT_SECONDS: '2',
                    A2A_LISTENER_VERIFICATION_GRACE_SECONDS: '0',
                    A2A_LISTENER_HUP_GRACE_SECONDS: '2',
                    A2A_DISABLE_SETSID: 'true',
                },
                encoding: 'utf8',
                timeout: 5000,
            },
        );

        const artifact = JSON.parse(fs.readFileSync(path.join(root, '.a2a-listener-session.json'), 'utf8')) as Record<string, number>;
        process.kill(Number(artifact.pid), 'SIGTERM');

        expect(result.status).toBe(0);
        expect(result.stderr).toContain('ATTEMPT_LOG:');
        expect(result.stderr).toContain('Verifying listener stability...');
        expect(result.stderr).toContain('Verifying listener hangup resilience...');
        expect(result.stderr).toContain('LISTENER_CODE: listen_hupresilient');

        fs.rmSync(root, { recursive: true, force: true });
    });

    it('does not release an unattended listener code when SIGHUP interrupts the child', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-supervisor-hup-fail-'));
        const binDir = path.join(root, 'bin');
        const fakeSupervisorPath = path.join(root, 'fake-supervisor.js');
        fs.mkdirSync(binDir, { recursive: true });

        fs.writeFileSync(fakeSupervisorPath, `
const fs = require('fs');
const path = require('path');

const artifact = path.join(process.cwd(), '.a2a-listener-session.json');
const baseState = {
  mode: 'listen',
  listenerCode: 'listen_hupfragile',
  brokerEndpoint: 'https://broker.a2alinker.net',
  headless: true,
  sessionDir: path.join(process.cwd(), 'session'),
  pid: process.pid,
  startedAt: '2026-04-29T00:00:00.000Z',
  updatedAt: '2026-04-29T00:00:00.000Z',
  source: 'local_cache',
};
const writeState = (extra) => fs.writeFileSync(artifact, JSON.stringify({
  ...baseState,
  ...extra,
}, null, 2));

process.on('SIGHUP', () => {
  writeState({ status: 'interrupted', lastEvent: 'SIGHUP' });
  process.exit(129);
});
writeState({ status: 'waiting_for_host' });
console.log('LISTENER_CODE: listen_hupfragile');
setInterval(() => {}, 1000);
`, 'utf8');
        writeExecutable(path.join(binDir, 'nohup'), `#!/bin/bash
exec "$@"
`);
        writeExecutable(path.join(binDir, 'node'), `#!/bin/bash
if [ "\${1:-}" = "--check" ]; then
  exit 0
fi
if [ "\${1:-}" = "-e" ]; then
  exec "${process.execPath}" "$@"
fi
exec "${process.execPath}" "${fakeSupervisorPath}"
`);
        writeExecutable(path.join(binDir, 'codex'), '#!/bin/bash\nexit 0\n');

        const result = spawnSync(
            'bash',
            [path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-supervisor.sh'), '--mode', 'listen', '--agent-label', 'Codi'],
            {
                cwd: root,
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                    A2A_BASE_URL: 'https://broker.a2alinker.net',
                    A2A_UNATTENDED: 'true',
                    A2A_RUNNER_KIND: 'codex',
                    A2A_ALLOW_WEB_ACCESS: 'true',
                    A2A_ALLOW_TESTS_BUILDS: 'true',
                    A2A_DETACH_LISTENER: 'true',
                    A2A_LISTENER_MAX_ATTEMPTS: '1',
                    A2A_LISTENER_STARTUP_TIMEOUT_SECONDS: '2',
                    A2A_LISTENER_VERIFICATION_GRACE_SECONDS: '0',
                    A2A_LISTENER_HUP_GRACE_SECONDS: '2',
                    A2A_DISABLE_SETSID: 'true',
                },
                encoding: 'utf8',
                timeout: 5000,
            },
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Verifying listener hangup resilience...');
        expect(result.stderr).toContain('Listener startup was unstable across 1 attempt');
        expect(result.stderr).not.toContain('LISTENER_CODE: listen_hupfragile');

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

    it('allows read-only join status without broker prompts or runner injection', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-supervisor-join-status-'));
        const binDir = path.join(root, 'bin');
        const capturedArgsPath = path.join(root, 'captured-args');
        fs.mkdirSync(binDir, { recursive: true });

        writeExecutable(path.join(binDir, 'node'), `#!/bin/bash
printf '%s\n' "$@" > "${capturedArgsPath}"
`);

        const result = spawnSync(
            'bash',
            ['.agents/skills/a2alinker/scripts/a2a-supervisor.sh', '--mode', 'join', '--status'],
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
        expect(capturedArgs).toContain('join');
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

    it('separates fresh broker setup from active host broker reuse', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-fresh-broker-split-'));
        const commonPath = path.join(root, '.agents/skills/a2alinker/scripts/a2a-common.sh');
        copyFile(
            path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-common.sh'),
            commonPath,
        );

        fs.writeFileSync(path.join(root, '.a2a-host-session.json'), JSON.stringify({
            mode: 'host',
            status: 'connected',
            attachedListenerCode: 'listen_remote123',
            inviteCode: null,
            brokerEndpoint: 'https://broker.a2alinker.net',
            headless: false,
            sessionDir: path.join(root, 'host-session'),
            pid: null,
            startedAt: '2026-04-11T00:00:00.000Z',
            updatedAt: '2026-04-11T00:00:00.000Z',
            source: 'local_cache',
            lastEvent: 'connected',
            error: null,
        }, null, 2), 'utf8');
        fs.writeFileSync(path.join(root, '.a2a-listener-policy.json'), JSON.stringify({
            brokerEndpoint: 'https://broker.a2alinker.net',
        }, null, 2), 'utf8');

        const result = spawnSync(
            'bash',
            ['-lc', '. .agents/skills/a2alinker/scripts/a2a-common.sh && printf "fresh=%s\\nactive=%s\\n" "$(a2a_resolve_fresh_base_url)" "$(a2a_resolve_active_base_url_for_role host)"'],
            {
                cwd: root,
                env: {
                    ...process.env,
                    A2A_BASE_URL: '',
                    A2A_SERVER: '',
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('fresh=http://127.0.0.1:3000');
        expect(result.stdout).toContain('active=https://broker.a2alinker.net');

        fs.rmSync(root, { recursive: true, force: true });
    });

    it('resolves stale cleanup broker from saved role state instead of fresh broker env', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-stale-broker-split-'));
        const commonPath = path.join(root, '.agents/skills/a2alinker/scripts/a2a-common.sh');
        copyFile(
            path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-common.sh'),
            commonPath,
        );
        fs.writeFileSync('/tmp/a2a_host_base_url', 'https://broker.a2alinker.net\n', 'utf8');

        const result = spawnSync(
            'bash',
            ['-lc', '. .agents/skills/a2alinker/scripts/a2a-common.sh && printf "saved=%s\\nfresh=%s\\nactive=%s\\n" "$(a2a_resolve_saved_base_url_for_role host)" "$(a2a_resolve_fresh_base_url)" "$(a2a_resolve_active_base_url_for_role host)"'],
            {
                cwd: root,
                env: {
                    ...process.env,
                    A2A_BASE_URL: 'https://fresh.broker.example',
                    A2A_SERVER: '',
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('saved=https://broker.a2alinker.net');
        expect(result.stdout).toContain('fresh=https://fresh.broker.example');
        expect(result.stdout).toContain('active=https://fresh.broker.example');

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

    it('falls back to the packaged runtime when repo dist is syntactically invalid', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-supervisor-invalid-dist-'));
        const binDir = path.join(root, 'bin');
        const capturedArgsPath = path.join(root, 'captured-args');
        const repoRoot = process.cwd();
        const invalidDistPath = path.join(root, 'dist/a2a-supervisor.js');
        const packagedRuntimePath = path.join(root, '.agents/skills/a2alinker/runtime/a2a-supervisor.js');
        fs.mkdirSync(binDir, { recursive: true });
        fs.mkdirSync(path.dirname(invalidDistPath), { recursive: true });

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
        fs.writeFileSync(invalidDistPath, '/broken js/\n', 'utf8');

        writeExecutable(path.join(binDir, 'node'), `#!/bin/bash
if [ "$1" = "--check" ]; then
  shift
  case "$1" in
    *dist/a2a-supervisor.js)
      exit 1
      ;;
    *)
      exit 0
      ;;
  esac
fi
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
                    A2A_BASE_URL: '',
                    A2A_SERVER: '',
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
                    A2A_BASE_URL: '',
                    A2A_SERVER: '',
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

    it('reports the broker endpoint and curl exit code when remote join connect cannot reach the relay', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-join-connect-error-'));
        const binDir = path.join(root, 'bin');
        const tokenPath = '/tmp/a2a_join_token';
        fs.mkdirSync(binDir, { recursive: true });
        fs.rmSync(tokenPath, { force: true });

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
echo 'Failed to connect to broker.a2alinker.net port 443' >&2
exit 7
`);

        const result = spawnSync(
            'bash',
            ['.agents/skills/a2alinker/scripts/a2a-join-connect.sh', 'invite_demo123'],
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
        expect(result.stdout).toContain('ERROR: Cannot reach A2A Linker server at https://broker.a2alinker.net (curl exit 7)');

        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(tokenPath, { force: true });
    });

    it('retries a transient remote join connect once on retryable transport errors', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-join-connect-retry-'));
        const binDir = path.join(root, 'bin');
        const statePath = path.join(root, 'join-count');
        const tokenPath = '/tmp/a2a_join_token';
        fs.mkdirSync(binDir, { recursive: true });
        fs.rmSync(tokenPath, { force: true });

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
COUNT=0
if [ -f "${statePath}" ]; then
  COUNT="$(cat "${statePath}")"
fi
COUNT=$((COUNT + 1))
echo "$COUNT" > "${statePath}"
if [ "$COUNT" -eq 1 ]; then
  echo 'Could not resolve host: broker.a2alinker.net' >&2
  exit 6
fi
  printf '%s' '{"token":"tok_a1b2c3","roomName":"room_demo","role":"join","headless":true,"status":"(2/2 connected)"}'
`);

        const result = spawnSync(
            'bash',
            ['.agents/skills/a2alinker/scripts/a2a-join-connect.sh', 'invite_demo123'],
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

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('ROLE: join');
        expect(fs.readFileSync(statePath, 'utf8').trim()).toBe('2');
        expect(fs.readFileSync(tokenPath, 'utf8').trim()).toBe('tok_a1b2c3');

        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(tokenPath, { force: true });
    });

    it('persists a dedicated raw join artifact and backup token on join connect', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-join-connect-artifact-'));
        const binDir = path.join(root, 'bin');
        const scriptPath = path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-join-connect.sh');
        fs.mkdirSync(binDir, { recursive: true });

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
printf '%s' '{"token":"tok_a1b2c3d6","roomName":"room_demo","role":"join","headless":true,"status":"(2/2 connected)"}'
`);

        const result = spawnSync(
            'bash',
            [scriptPath, 'invite_demo123'],
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
        const artifact = JSON.parse(fs.readFileSync(path.join(root, '.a2a-join-session.json'), 'utf8')) as {
            mode: string;
            inviteCode: string | null;
            brokerEndpoint: string;
            sessionDir: string;
            status: string;
            lastEvent: string;
            headless: boolean;
        };
        expect(artifact.mode).toBe('join');
        expect(artifact.inviteCode).toBe('invite_demo123');
        expect(artifact.brokerEndpoint).toBe('https://broker.a2alinker.net');
        expect(artifact.status).toBe('connected');
        expect(artifact.lastEvent).toBe('join_connected');
        expect(artifact.headless).toBe(true);
        expect(fs.readFileSync(path.join(artifact.sessionDir, 'a2a_join_token'), 'utf8').trim()).toBe('tok_a1b2c3d6');

        fs.rmSync(root, { recursive: true, force: true });
        clearA2ATmpState();
    });

    it('defaults fresh join connect to the local broker even when stale artifacts point remote', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-join-connect-fresh-broker-'));
        const binDir = path.join(root, 'bin');
        const curlArgsPath = path.join(root, 'curl-args');
        const scriptPath = path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-join-connect.sh');
        fs.mkdirSync(binDir, { recursive: true });

        fs.writeFileSync(path.join(root, '.a2a-host-session.json'), JSON.stringify({
            mode: 'host',
            status: 'closed',
            attachedListenerCode: null,
            inviteCode: 'invite_remote123',
            brokerEndpoint: 'https://broker.a2alinker.net',
            headless: false,
            sessionDir: path.join(root, 'host-session'),
            pid: null,
            startedAt: '2026-04-11T00:00:00.000Z',
            updatedAt: '2026-04-11T00:00:00.000Z',
            source: 'local_cache',
            lastEvent: 'closed',
            error: null,
        }, null, 2), 'utf8');
        fs.writeFileSync(path.join(root, '.a2a-listener-session.json'), JSON.stringify({
            mode: 'listen',
            status: 'closed',
            brokerEndpoint: 'https://broker.a2alinker.net',
            sessionDir: path.join(root, 'listener-session'),
        }, null, 2), 'utf8');
        fs.writeFileSync(path.join(root, '.a2a-listener-policy.json'), JSON.stringify({
            brokerEndpoint: 'https://broker.a2alinker.net',
        }, null, 2), 'utf8');

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
printf '%s\n' "$@" > "${curlArgsPath}"
printf '%s' '{"token":"tok_a1b2c3d4","roomName":"room_demo","role":"join","headless":false,"status":"(2/2 connected)"}'
`);

        const result = spawnSync(
            'bash',
            [scriptPath, 'invite_demo123'],
            {
                cwd: root,
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                    A2A_BASE_URL: '',
                    A2A_SERVER: '',
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('ROLE: join');
        expect(fs.readFileSync(curlArgsPath, 'utf8')).toContain('http://127.0.0.1:3000/register-and-join/invite_demo123');
        expect(fs.readFileSync('/tmp/a2a_join_base_url', 'utf8').trim()).toBe('http://127.0.0.1:3000');

        fs.rmSync(root, { recursive: true, force: true });
        clearA2ATmpState();
    });

    it('cleans up a stale join token on its saved broker before connecting to a fresh broker', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-join-connect-stale-cleanup-'));
        const binDir = path.join(root, 'bin');
        const callLogPath = path.join(root, 'curl-calls.log');
        const scriptPath = path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-join-connect.sh');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync('/tmp/a2a_join_base_url', 'https://broker.a2alinker.net\n', 'utf8');
        fs.writeFileSync('/tmp/a2a_join_token', 'tok_stalejoin123\n', 'utf8');

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
if printf '%s ' "$@" | grep -q '/leave'; then
  printf 'leave %s\n' "$*" >> "${callLogPath}"
  exit 0
fi
if printf '%s ' "$@" | grep -q '/register-and-join/'; then
  printf 'join %s\n' "$*" >> "${callLogPath}"
  printf '%s' '{"token":"tok_a1b2c3d4","roomName":"room_demo","role":"join","headless":false,"status":"(2/2 connected)"}'
  exit 0
fi
exit 99
`);

        const result = spawnSync(
            'bash',
            [scriptPath, 'invite_demo123'],
            {
                cwd: root,
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                    A2A_BASE_URL: 'https://fresh.broker.example',
                    A2A_SERVER: '',
                },
                encoding: 'utf8',
            },
        );

        const callLog = await waitForLogLines(callLogPath, 2);
        const leaveLine = callLog.find((line) => line.startsWith('leave ')) ?? '';
        const joinLine = callLog.find((line) => line.startsWith('join ')) ?? '';

        expect(result.status).toBe(0);
        expect(leaveLine).toContain('https://broker.a2alinker.net/leave');
        expect(leaveLine).toContain('tok_stalejoin123');
        expect(joinLine).toContain('https://fresh.broker.example/register-and-join/invite_demo123');
        expect(fs.readFileSync('/tmp/a2a_join_base_url', 'utf8').trim()).toBe('https://fresh.broker.example');

        fs.rmSync(root, { recursive: true, force: true });
        clearA2ATmpState();
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

        const hostArtifactPath = path.join(process.cwd(), '.a2a-host-session.json');
        const hostArtifact = JSON.parse(fs.readFileSync(hostArtifactPath, 'utf8')) as {
            brokerEndpoint: string;
            attachedListenerCode: string | null;
            status: string;
            sessionDir: string;
        };
        expect(hostArtifact.brokerEndpoint).toBe('http://127.0.0.1:3000');
        expect(hostArtifact.attachedListenerCode).toBe('listen_demo123');
        expect(hostArtifact.status).toBe('connected');
        expect(fs.existsSync(path.join(hostArtifact.sessionDir, 'a2a_host_token'))).toBe(true);

        fs.rmSync(hostArtifact.sessionDir, { recursive: true, force: true });
        fs.rmSync(hostArtifactPath, { force: true });
        fs.rmSync('/tmp/a2a_host_token', { force: true });
    });

    it('reports the broker endpoint and curl exit code when remote host attach cannot reach the relay', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-host-attach-error-'));
        const binDir = path.join(root, 'bin');
        fs.mkdirSync(binDir, { recursive: true });

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
echo 'Could not resolve host: broker.a2alinker.net' >&2
exit 6
`);

        const result = spawnSync(
            'bash',
            ['.agents/skills/a2alinker/scripts/a2a-host-connect.sh', 'listen_demo123'],
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

    it('retries a transient remote host attach once and only leaves the old token after the later success', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-host-attach-retry-'));
        const binDir = path.join(root, 'bin');
        const callLogPath = path.join(root, 'curl-calls.log');
        const statePath = path.join(root, 'register-count');
        const tokenPath = '/tmp/a2a_host_token';
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(tokenPath, 'tok_existing123', 'utf8');

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
if printf '%s ' "$@" | grep -q '/register-and-join/'; then
  COUNT=0
  if [ -f "${statePath}" ]; then
    COUNT="$(cat "${statePath}")"
  fi
  COUNT=$((COUNT + 1))
  echo "$COUNT" > "${statePath}"
  printf 'register-%s\n' "$COUNT" >> "${callLogPath}"
  if [ "$COUNT" -eq 1 ]; then
    echo 'Could not resolve host: broker.a2alinker.net' >&2
    exit 6
  fi
  printf '%s' '{"token":"tok_a1b2c4","roomName":"room_demo","role":"host","headless":false,"status":"(2/2 connected)"}'
  exit 0
fi
if printf '%s ' "$@" | grep -q '/leave'; then
  printf 'leave %s\n' "$*" >> "${callLogPath}"
  exit 0
fi
exit 99
`);

        const result = spawnSync(
            'bash',
            ['.agents/skills/a2alinker/scripts/a2a-host-connect.sh', 'listen_demo123'],
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

        for (let attempt = 0; attempt < 20; attempt += 1) {
            if (fs.existsSync(callLogPath) && fs.readFileSync(callLogPath, 'utf8').trim().split('\n').length >= 3) {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        }

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('ROLE: host');
        expect(fs.readFileSync(tokenPath, 'utf8').trim()).toBe('tok_a1b2c4');

        const callLog = fs.readFileSync(callLogPath, 'utf8').trim().split('\n');
        expect(callLog[0]).toBe('register-1');
        expect(callLog[1]).toBe('register-2');
        expect(callLog[2]).toContain('/leave');
        expect(callLog[2]).toContain('tok_existing123');

        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(tokenPath, { force: true });
    });

    it('retries a transient remote host setup once and only leaves the old token after the later success', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-host-setup-retry-'));
        const binDir = path.join(root, 'bin');
        const callLogPath = path.join(root, 'curl-calls.log');
        const statePath = path.join(root, 'setup-count');
        const tokenPath = '/tmp/a2a_host_token';
        const hostArtifactPath = path.join(process.cwd(), '.a2a-host-session.json');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(tokenPath, 'tok_existing123', 'utf8');
        fs.rmSync(hostArtifactPath, { force: true });

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
if printf '%s ' "$@" | grep -q '/setup'; then
  COUNT=0
  if [ -f "${statePath}" ]; then
    COUNT="$(cat "${statePath}")"
  fi
  COUNT=$((COUNT + 1))
  echo "$COUNT" > "${statePath}"
  printf 'setup-%s\n' "$COUNT" >> "${callLogPath}"
  if [ "$COUNT" -eq 1 ]; then
    echo 'Could not resolve host: broker.a2alinker.net' >&2
    exit 6
  fi
  printf '%s' '{"token":"tok_a1b2c4","invite":"invite_demo123","role":"host","headless":false}'
  exit 0
fi
if printf '%s ' "$@" | grep -q '/leave'; then
  printf 'leave %s\n' "$*" >> "${callLogPath}"
  exit 0
fi
exit 99
`);

        const result = spawnSync(
            'bash',
            ['.agents/skills/a2alinker/scripts/a2a-host-connect.sh', '', 'false'],
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

        for (let attempt = 0; attempt < 20; attempt += 1) {
            if (fs.existsSync(callLogPath) && fs.readFileSync(callLogPath, 'utf8').trim().split('\n').length >= 3) {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        }

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('INVITE_CODE: invite_demo123');
        expect(fs.readFileSync(tokenPath, 'utf8').trim()).toBe('tok_a1b2c4');

        const callLog = fs.readFileSync(callLogPath, 'utf8').trim().split('\n');
        expect(callLog[0]).toBe('setup-1');
        expect(callLog[1]).toBe('setup-2');
        expect(callLog[2]).toContain('/leave');
        expect(callLog[2]).toContain('tok_existing123');

        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(tokenPath, { force: true });
        fs.rmSync(hostArtifactPath, { force: true });
    });

    it('defaults fresh host setup to the local broker even when stale remote artifacts exist', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-host-setup-fresh-broker-'));
        const binDir = path.join(root, 'bin');
        const curlArgsPath = path.join(root, 'curl-args');
        const scriptPath = path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-host-connect.sh');
        fs.mkdirSync(binDir, { recursive: true });

        fs.writeFileSync(path.join(root, '.a2a-host-session.json'), JSON.stringify({
            mode: 'host',
            status: 'closed',
            attachedListenerCode: null,
            inviteCode: 'invite_remote123',
            brokerEndpoint: 'https://broker.a2alinker.net',
            headless: false,
            sessionDir: path.join(root, 'old-host-session'),
            pid: null,
            startedAt: '2026-04-11T00:00:00.000Z',
            updatedAt: '2026-04-11T00:00:00.000Z',
            source: 'local_cache',
            lastEvent: 'closed',
            error: null,
        }, null, 2), 'utf8');
        fs.writeFileSync(path.join(root, '.a2a-listener-policy.json'), JSON.stringify({
            brokerEndpoint: 'https://broker.a2alinker.net',
        }, null, 2), 'utf8');

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
printf '%s\n' "$@" > "${curlArgsPath}"
printf '%s' '{"token":"tok_a1b2c4d5","invite":"invite_local123","role":"host","headless":false}'
`);

        const result = spawnSync(
            'bash',
            [scriptPath, '', 'false'],
            {
                cwd: root,
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                    TMPDIR: root,
                    A2A_BASE_URL: '',
                    A2A_SERVER: '',
                    A2A_ALLOW_REPLACE_HOST_SESSION: '',
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('INVITE_CODE: invite_local123');
        expect(fs.readFileSync(curlArgsPath, 'utf8')).toContain('http://127.0.0.1:3000/setup');

        const hostArtifact = JSON.parse(fs.readFileSync(path.join(root, '.a2a-host-session.json'), 'utf8')) as {
            brokerEndpoint: string;
        };
        expect(hostArtifact.brokerEndpoint).toBe('http://127.0.0.1:3000');

        fs.rmSync(root, { recursive: true, force: true });
        clearA2ATmpState();
    });

    it('cleans up a stale host token on its saved broker before creating a fresh host room', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-host-setup-stale-cleanup-'));
        const binDir = path.join(root, 'bin');
        const callLogPath = path.join(root, 'curl-calls.log');
        const scriptPath = path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-host-connect.sh');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync('/tmp/a2a_host_base_url', 'https://broker.a2alinker.net\n', 'utf8');
        fs.writeFileSync('/tmp/a2a_host_token', 'tok_stalehost123\n', 'utf8');

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
if printf '%s ' "$@" | grep -q '/leave'; then
  printf 'leave %s\n' "$*" >> "${callLogPath}"
  exit 0
fi
if printf '%s ' "$@" | grep -q '/setup'; then
  printf 'setup %s\n' "$*" >> "${callLogPath}"
  printf '%s' '{"token":"tok_a1b2c4d5","invite":"invite_fresh123","role":"host","headless":false}'
  exit 0
fi
exit 99
`);

        const result = spawnSync(
            'bash',
            [scriptPath, '', 'false'],
            {
                cwd: root,
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                    A2A_BASE_URL: 'https://fresh.broker.example',
                    A2A_SERVER: '',
                    A2A_ALLOW_REPLACE_HOST_SESSION: '',
                },
                encoding: 'utf8',
            },
        );

        const callLog = await waitForLogLines(callLogPath, 2);
        const leaveLine = callLog.find((line) => line.startsWith('leave ')) ?? '';
        const setupLine = callLog.find((line) => line.startsWith('setup ')) ?? '';

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('INVITE_CODE: invite_fresh123');
        expect(leaveLine).toContain('https://broker.a2alinker.net/leave');
        expect(leaveLine).toContain('tok_stalehost123');
        expect(setupLine).toContain('https://fresh.broker.example/setup');
        expect(fs.readFileSync('/tmp/a2a_host_base_url', 'utf8').trim()).toBe('https://fresh.broker.example');

        fs.rmSync(root, { recursive: true, force: true });
        clearA2ATmpState();
    });

    it('blocks duplicate host room creation for active or ambiguous cached host statuses', () => {
        const statuses = [
            'starting',
            'waiting_for_join',
            'waiting_for_host',
            'connected',
            'waiting_for_local_task',
            'waiting_for_partner_reply',
            'retrying',
            'paused',
            'stale_local_state',
        ];
        const scriptPath = path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-host-connect.sh');

        for (const status of statuses) {
            clearA2ATmpState();
            const root = fs.mkdtempSync(path.join(os.tmpdir(), `a2a-host-guard-${status}-`));
            const binDir = path.join(root, 'bin');
            const curlArgsPath = path.join(root, 'curl-args');
            fs.mkdirSync(binDir, { recursive: true });

            fs.writeFileSync(path.join(root, '.a2a-host-session.json'), JSON.stringify({
                mode: 'host',
                status,
                attachedListenerCode: null,
                inviteCode: 'invite_existing123',
                brokerEndpoint: 'https://broker.a2alinker.net',
                headless: false,
                sessionDir: path.join(root, 'host-session'),
                pid: null,
                startedAt: '2026-04-11T00:00:00.000Z',
                updatedAt: '2026-04-11T00:00:00.000Z',
                source: 'local_cache',
                lastEvent: status,
                error: status === 'stale_local_state' ? 'Supervisor process is no longer running.' : null,
            }, null, 2), 'utf8');

            writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
printf '%s\n' "$@" > "${curlArgsPath}"
exit 99
`);

            const result = spawnSync(
                'bash',
                [scriptPath, '', 'false'],
                {
                    cwd: root,
                    env: {
                        ...process.env,
                        PATH: `${binDir}:${process.env.PATH ?? ''}`,
                        TMPDIR: root,
                        A2A_BASE_URL: '',
                        A2A_SERVER: '',
                        A2A_ALLOW_REPLACE_HOST_SESSION: '',
                    },
                    encoding: 'utf8',
                },
            );

            expect(result.status).toBe(1);
            expect(result.stdout).toContain('Refusing to create a new host room');
            expect(result.stdout).toContain(`HOST_SESSION_STATUS: ${status}`);
            expect(result.stdout).toContain('A2A_ALLOW_REPLACE_HOST_SESSION=true');
            expect(fs.existsSync(curlArgsPath)).toBe(false);

            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('explains why host room creation is blocked when cached host status is missing', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-host-guard-missing-status-'));
        const binDir = path.join(root, 'bin');
        const curlArgsPath = path.join(root, 'curl-args');
        const scriptPath = path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-host-connect.sh');
        fs.mkdirSync(binDir, { recursive: true });

        fs.writeFileSync(path.join(root, '.a2a-host-session.json'), JSON.stringify({
            mode: 'host',
            attachedListenerCode: null,
            inviteCode: null,
            brokerEndpoint: 'https://broker.a2alinker.net',
            headless: false,
            sessionDir: path.join(root, 'host-session'),
            pid: null,
            startedAt: '2026-04-11T00:00:00.000Z',
            updatedAt: '2026-04-11T00:00:00.000Z',
            source: 'local_cache',
            lastEvent: null,
            error: null,
        }, null, 2), 'utf8');

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
printf '%s\n' "$@" > "${curlArgsPath}"
exit 99
`);

        const result = spawnSync(
            'bash',
            [scriptPath, '', 'false'],
            {
                cwd: root,
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                    TMPDIR: root,
                    A2A_BASE_URL: '',
                    A2A_SERVER: '',
                    A2A_ALLOW_REPLACE_HOST_SESSION: '',
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(1);
        expect(result.stdout).toContain('HOST_SESSION_STATUS: unknown');
        expect(result.stdout).toContain('missing or uses an unrecognized status');
        expect(fs.existsSync(curlArgsPath)).toBe(false);

        fs.rmSync(root, { recursive: true, force: true });
    });

    it('allows fresh host setup when the cached host session is terminal', () => {
        const statuses = ['closed', 'error', 'interrupted'];
        const scriptPath = path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-host-connect.sh');

        for (const status of statuses) {
            clearA2ATmpState();
            const root = fs.mkdtempSync(path.join(os.tmpdir(), `a2a-host-terminal-${status}-`));
            const binDir = path.join(root, 'bin');
            const curlArgsPath = path.join(root, 'curl-args');
            fs.mkdirSync(binDir, { recursive: true });

            fs.writeFileSync(path.join(root, '.a2a-host-session.json'), JSON.stringify({
                mode: 'host',
                status,
                attachedListenerCode: null,
                inviteCode: 'invite_existing123',
                brokerEndpoint: 'https://broker.a2alinker.net',
                headless: false,
                sessionDir: path.join(root, 'host-session'),
                pid: null,
                startedAt: '2026-04-11T00:00:00.000Z',
                updatedAt: '2026-04-11T00:00:00.000Z',
                source: 'local_cache',
                lastEvent: status,
                error: status === 'error' ? 'previous failure' : null,
            }, null, 2), 'utf8');

            writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
printf '%s\n' "$@" > "${curlArgsPath}"
printf '%s' '{"token":"tok_a1b2c4d6","invite":"invite_terminal123","role":"host","headless":false}'
`);

            const result = spawnSync(
                'bash',
                [scriptPath, '', 'false'],
                {
                    cwd: root,
                    env: {
                        ...process.env,
                        PATH: `${binDir}:${process.env.PATH ?? ''}`,
                        TMPDIR: root,
                        A2A_BASE_URL: '',
                        A2A_SERVER: '',
                        A2A_ALLOW_REPLACE_HOST_SESSION: '',
                    },
                    encoding: 'utf8',
                },
            );

            expect(result.status).toBe(0);
            expect(result.stdout).toContain('INVITE_CODE: invite_terminal123');
            expect(fs.readFileSync(curlArgsPath, 'utf8')).toContain('http://127.0.0.1:3000/setup');

            const hostArtifact = JSON.parse(fs.readFileSync(path.join(root, '.a2a-host-session.json'), 'utf8')) as {
                brokerEndpoint: string;
                status: string;
            };
            expect(hostArtifact.brokerEndpoint).toBe('http://127.0.0.1:3000');
            expect(hostArtifact.status).toBe('waiting_for_join');

            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('allows deliberate host session replacement when A2A_ALLOW_REPLACE_HOST_SESSION=true', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-host-guard-override-'));
        const binDir = path.join(root, 'bin');
        const curlArgsPath = path.join(root, 'curl-args');
        const scriptPath = path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-host-connect.sh');
        fs.mkdirSync(binDir, { recursive: true });

        fs.writeFileSync(path.join(root, '.a2a-host-session.json'), JSON.stringify({
            mode: 'host',
            status: 'waiting_for_join',
            attachedListenerCode: null,
            inviteCode: 'invite_existing123',
            brokerEndpoint: 'https://broker.a2alinker.net',
            headless: false,
            sessionDir: path.join(root, 'host-session'),
            pid: null,
            startedAt: '2026-04-11T00:00:00.000Z',
            updatedAt: '2026-04-11T00:00:00.000Z',
            source: 'local_cache',
            lastEvent: 'waiting_for_join',
            error: null,
        }, null, 2), 'utf8');

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
printf '%s\n' "$@" > "${curlArgsPath}"
printf '%s' '{"token":"tok_a1b2c4d7","invite":"invite_override123","role":"host","headless":false}'
`);

        const result = spawnSync(
            'bash',
            [scriptPath, '', 'false'],
            {
                cwd: root,
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                    TMPDIR: root,
                    A2A_ALLOW_REPLACE_HOST_SESSION: 'true',
                    A2A_BASE_URL: '',
                    A2A_SERVER: '',
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('INVITE_CODE: invite_override123');
        expect(fs.readFileSync(curlArgsPath, 'utf8')).toContain('http://127.0.0.1:3000/setup');

        fs.rmSync(root, { recursive: true, force: true });
        clearA2ATmpState();
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

    it('marks the host artifact closed and stops the passive waiter when closing locally', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-leave-host-state-'));
        const binDir = path.join(root, 'bin');
        const sessionDir = path.join(root, 'session');
        const backupTokenPath = path.join(sessionDir, 'a2a_host_token');
        const waiterPidPath = path.join(sessionDir, 'a2a_host_passive_wait.pid');
        const pendingPath = path.join(sessionDir, 'a2a_host_pending_message.txt');
        const inflightPath = path.join(sessionDir, 'a2a_host_inflight_message.txt');
        const scriptPath = path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-leave.sh');
        fs.mkdirSync(binDir, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(backupTokenPath, 'tok_backup123\n', { encoding: 'utf8', mode: 0o600 });
        fs.writeFileSync(pendingPath, 'MESSAGE_RECEIVED\n[SYSTEM]: pending before local close\n', 'utf8');
        fs.writeFileSync(inflightPath, 'probe [OVER]\n', 'utf8');
        fs.writeFileSync(path.join(root, '.a2a-host-session.json'), JSON.stringify({
            mode: 'host',
            status: 'waiting_for_local_task',
            attachedListenerCode: null,
            inviteCode: 'invite_demo123',
            brokerEndpoint: 'https://broker.a2alinker.net',
            headless: false,
            sessionDir,
            pid: null,
            startedAt: '2026-04-11T00:00:00.000Z',
            updatedAt: '2026-04-11T00:00:00.000Z',
            source: 'local_cache',
            lastEvent: 'waiting_for_local_task',
            error: null,
            notice: 'A partner event is stored locally. Run a2a-chat.sh host to inspect it.',
        }, null, 2), 'utf8');

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
printf '%s' '{"ok":true}'
`);

        const waiter = spawn('sleep', ['30'], {
            stdio: 'ignore',
        });
        fs.writeFileSync(waiterPidPath, `${waiter.pid}\n`, 'utf8');

        try {
            const result = spawnSync(
                'bash',
                [scriptPath, 'host'],
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

            await waitForCondition(() => waiter.exitCode !== null || waiter.signalCode !== null);

            const artifact = JSON.parse(fs.readFileSync(path.join(root, '.a2a-host-session.json'), 'utf8')) as {
                status: string;
                lastEvent: string;
                pid: number | null;
                error: string | null;
                notice: string | null;
            };
            expect(artifact.status).toBe('closed');
            expect(artifact.lastEvent).toBe('system_closed');
            expect(artifact.pid).toBeNull();
            expect(artifact.error).toBeNull();
            expect(artifact.notice).toBeNull();
            expect(fs.existsSync(backupTokenPath)).toBe(false);
            expect(fs.existsSync(waiterPidPath)).toBe(false);
            expect(fs.existsSync(pendingPath)).toBe(false);
            expect(fs.existsSync(inflightPath)).toBe(false);
        } finally {
            if (waiter.exitCode === null && waiter.signalCode === null) {
                waiter.kill('SIGKILL');
            }
            fs.rmSync(root, { recursive: true, force: true });
        }
    }, 10000);

    it('kills passive waiter descendants when closing locally', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-leave-host-descendants-'));
        const binDir = path.join(root, 'bin');
        const scriptDir = path.join(root, 'scripts');
        const sessionDir = path.join(root, 'session');
        const backupTokenPath = path.join(sessionDir, 'a2a_host_token');
        const curlPidPath = path.join(root, 'curl.pid');
        const tokenPath = '/tmp/a2a_host_token';
        const previousToken = fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, 'utf8') : null;
        fs.mkdirSync(binDir, { recursive: true });
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(backupTokenPath, 'tok_backup123\n', { encoding: 'utf8', mode: 0o600 });
        fs.writeFileSync(tokenPath, 'tok_primary123\n', 'utf8');
        fs.writeFileSync(path.join(root, '.a2a-host-session.json'), JSON.stringify({
            mode: 'host',
            status: 'waiting_for_local_task',
            attachedListenerCode: null,
            inviteCode: 'invite_demo123',
            brokerEndpoint: 'https://broker.a2alinker.net',
            headless: false,
            sessionDir,
            pid: null,
            startedAt: '2026-04-11T00:00:00.000Z',
            updatedAt: '2026-04-11T00:00:00.000Z',
            source: 'local_cache',
            lastEvent: 'waiting_for_local_task',
            error: null,
            notice: null,
        }, null, 2), 'utf8');

        copyFile('.agents/skills/a2alinker/scripts/a2a-common.sh', path.join(scriptDir, 'a2a-common.sh'));
        copyFile('.agents/skills/a2alinker/scripts/a2a-wait-message.sh', path.join(scriptDir, 'a2a-wait-message.sh'));
        copyFile('.agents/skills/a2alinker/scripts/a2a-passive-wait.sh', path.join(scriptDir, 'a2a-passive-wait.sh'));
        copyFile('.agents/skills/a2alinker/scripts/a2a-leave.sh', path.join(scriptDir, 'a2a-leave.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-common.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-wait-message.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-passive-wait.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-leave.sh'), 0o755);

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
if printf '%s ' "$@" | grep -q '/leave'; then
  printf '%s' '{"ok":true}'
  exit 0
fi
echo $$ > "${curlPidPath}"
while true; do
  sleep 1
done
`);

        const waiter = spawn('bash', [path.join(scriptDir, 'a2a-passive-wait.sh'), 'host'], {
            cwd: root,
            env: {
                ...process.env,
                PATH: `${binDir}:${process.env.PATH ?? ''}`,
            },
            stdio: 'ignore',
        });

        let curlPid = 0;
        try {
            await waitForCondition(() => fs.existsSync(path.join(sessionDir, 'a2a_host_passive_wait.pid')));
            await waitForCondition(() => fs.existsSync(curlPidPath));
            curlPid = Number(fs.readFileSync(curlPidPath, 'utf8').trim());
            expect(curlPid).toBeGreaterThan(0);

            const result = spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-leave.sh'), 'host'],
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

            await waitForCondition(() => {
                try {
                    process.kill(waiter.pid!, 0);
                    return false;
                } catch {
                    return true;
                }
            });
            await waitForCondition(() => {
                try {
                    process.kill(curlPid, 0);
                    return false;
                } catch {
                    return true;
                }
            });
        } finally {
            if (waiter.exitCode === null && waiter.signalCode === null) {
                waiter.kill('SIGKILL');
            }
            if (curlPid > 0) {
                try {
                    process.kill(curlPid, 'SIGKILL');
                } catch {
                    // Curl stub is already gone.
                }
            }
            if (previousToken === null) {
                fs.rmSync(tokenPath, { force: true });
            } else {
                fs.writeFileSync(tokenPath, previousToken, 'utf8');
            }
            fs.rmSync(root, { recursive: true, force: true });
        }
    }, 10000);

    it('marks the listener artifact closed and clears join runtime files when listen closes locally', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-leave-listener-state-'));
        const binDir = path.join(root, 'bin');
        const sessionDir = path.join(root, 'listener-session');
        const backupTokenPath = path.join(sessionDir, 'a2a_join_token');
        const waiterPidPath = path.join(sessionDir, 'a2a_join_passive_wait.pid');
        const pendingPath = path.join(sessionDir, 'a2a_join_pending_message.txt');
        const inflightPath = path.join(sessionDir, 'a2a_join_inflight_message.txt');
        const scriptPath = path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-leave.sh');
        fs.mkdirSync(binDir, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(backupTokenPath, 'tok_listener123\n', { encoding: 'utf8', mode: 0o600 });
        fs.writeFileSync(waiterPidPath, '999999\n', 'utf8');
        fs.writeFileSync(pendingPath, 'MESSAGE_RECEIVED\n[SYSTEM]: pending before local close\n', 'utf8');
        fs.writeFileSync(inflightPath, 'reply [OVER]\n', 'utf8');
        fs.writeFileSync(path.join(root, '.a2a-listener-session.json'), JSON.stringify({
            mode: 'listen',
            status: 'waiting_for_host',
            listenerCode: 'listen_demo123',
            brokerEndpoint: 'https://broker.a2alinker.net',
            headless: false,
            sessionDir,
            pid: null,
            startedAt: '2026-04-11T00:00:00.000Z',
            updatedAt: '2026-04-11T00:00:00.000Z',
            source: 'local_cache',
            lastEvent: 'waiting_for_host',
            error: null,
            notice: 'Passive wait is active while the host sends the next message.',
        }, null, 2), 'utf8');

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
printf '%s' '{"ok":true}'
`);

        const result = spawnSync(
            'bash',
            [scriptPath, 'listen'],
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
        const artifact = JSON.parse(fs.readFileSync(path.join(root, '.a2a-listener-session.json'), 'utf8')) as {
            status: string;
            lastEvent: string;
            pid: number | null;
            error: string | null;
            notice: string | null;
        };
        expect(artifact.status).toBe('closed');
        expect(artifact.lastEvent).toBe('system_closed');
        expect(artifact.pid).toBeNull();
        expect(artifact.error).toBeNull();
        expect(artifact.notice).toBeNull();
        expect(fs.existsSync(backupTokenPath)).toBe(false);
        expect(fs.existsSync(waiterPidPath)).toBe(false);
        expect(fs.existsSync(pendingPath)).toBe(false);
        expect(fs.existsSync(inflightPath)).toBe(false);

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
                    A2A_BASE_URL: '',
                    A2A_SERVER: '',
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

    it('prefers the active host broker state over a stale host artifact when send.sh omits broker env', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-send-active-host-broker-'));
        const binDir = path.join(root, 'bin');
        const tokenPath = '/tmp/a2a_host_token';
        const brokerPath = '/tmp/a2a_host_base_url';
        const curlArgsPath = path.join(root, 'curl-args');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(tokenPath, 'tok_existing123', 'utf8');
        fs.writeFileSync(brokerPath, 'http://127.0.0.1:3000\n', 'utf8');
        fs.writeFileSync(path.join(root, '.a2a-host-session.json'), JSON.stringify({
            mode: 'host',
            status: 'error',
            attachedListenerCode: 'listen_old_remote',
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
        expect(fs.readFileSync(curlArgsPath, 'utf8')).toContain('http://127.0.0.1:3000/send');

        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(tokenPath, { force: true });
        fs.rmSync(brokerPath, { force: true });
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

    it('clears a staged host reply before raw send.sh transmits and avoids replaying it on the next host wait', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-send-host-clear-pending-'));
        const scriptDir = path.join(root, 'scripts');
        const sessionDir = path.join(root, 'session');
        const binDir = path.join(root, 'bin');
        const curlPendingStatePath = path.join(root, 'curl-pending-state');
        const pendingPath = path.join(sessionDir, 'a2a_host_pending_message.txt');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.mkdirSync(binDir, { recursive: true });

        copyFile('.agents/skills/a2alinker/scripts/a2a-send.sh', path.join(scriptDir, 'a2a-send.sh'));
        copyFile('.agents/skills/a2alinker/scripts/a2a-chat.sh', path.join(scriptDir, 'a2a-chat.sh'));
        copyFile('.agents/skills/a2alinker/scripts/a2a-common.sh', path.join(scriptDir, 'a2a-common.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-send.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-chat.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-common.sh'), 0o755);

        fs.writeFileSync(path.join(root, '.a2a-host-session.json'), JSON.stringify({
            mode: 'host',
            status: 'waiting_for_local_task',
            brokerEndpoint: 'http://127.0.0.1:3000',
            headless: false,
            sessionDir,
            pid: null,
            startedAt: '2026-04-18T00:00:00.000Z',
            updatedAt: '2026-04-18T00:00:00.000Z',
            source: 'local_cache',
            lastEvent: 'waiting_for_local_task',
            error: null,
            notice: 'A partner event is stored locally. Run a2a-chat.sh host to inspect it.',
        }, null, 2), 'utf8');
        fs.writeFileSync(pendingPath, `MESSAGE_RECEIVED
┌─ Agent-join [OVER]
│
│ Stale partner reply should not replay.
└────
`, 'utf8');

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
if [ -f "${pendingPath}" ]; then
  printf 'present\\n' > "${curlPendingStatePath}"
else
  printf 'missing\\n' > "${curlPendingStatePath}"
fi
printf 'DELIVERED\\n200'
`);
        writeExecutable(path.join(scriptDir, 'a2a-loop.sh'), '#!/bin/bash\necho "WAIT_ALREADY_PENDING"\n');

        try {
            const sendResult = withHostToken('tok_host_raw_send_clear', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-send.sh'), 'host', 'Fresh host message [OVER]'],
                {
                    cwd: root,
                    env: {
                        ...process.env,
                        PATH: `${binDir}:${process.env.PATH ?? ''}`,
                        A2A_BASE_URL: 'http://127.0.0.1:3000',
                    },
                    encoding: 'utf8',
                },
            ));

            expect(sendResult.status).toBe(0);
            expect(sendResult.stdout).toContain('DELIVERED');
            expect(fs.readFileSync(curlPendingStatePath, 'utf8').trim()).toBe('missing');
            expect(fs.existsSync(pendingPath)).toBe(false);

            const chatResult = withHostToken('tok_host_raw_send_clear', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-chat.sh'), 'host'],
                {
                    cwd: root,
                    encoding: 'utf8',
                },
            ));

            expect(chatResult.status).toBe(0);
            expect(chatResult.stdout).toContain('WAIT_ALREADY_PENDING');
            expect(chatResult.stdout).not.toContain('Stale partner reply should not replay.');
            expect(fs.readFileSync(pendingPath, 'utf8')).toContain('WAIT_ALREADY_PENDING');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('clears a staged join reply before raw send.sh transmits and avoids replaying it on the next join wait', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-send-join-clear-pending-'));
        const scriptDir = path.join(root, 'scripts');
        const sessionDir = path.join(root, 'session');
        const binDir = path.join(root, 'bin');
        const curlPendingStatePath = path.join(root, 'curl-pending-state');
        const pendingPath = path.join(sessionDir, 'a2a_join_pending_message.txt');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.mkdirSync(binDir, { recursive: true });

        copyFile('.agents/skills/a2alinker/scripts/a2a-send.sh', path.join(scriptDir, 'a2a-send.sh'));
        copyFile('.agents/skills/a2alinker/scripts/a2a-chat.sh', path.join(scriptDir, 'a2a-chat.sh'));
        copyFile('.agents/skills/a2alinker/scripts/a2a-common.sh', path.join(scriptDir, 'a2a-common.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-send.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-chat.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-common.sh'), 0o755);

        fs.writeFileSync(path.join(root, '.a2a-join-session.json'), JSON.stringify({
            mode: 'join',
            status: 'waiting_for_local_task',
            brokerEndpoint: 'http://127.0.0.1:3000',
            headless: false,
            sessionDir,
            pid: null,
            startedAt: '2026-04-18T00:00:00.000Z',
            updatedAt: '2026-04-18T00:00:00.000Z',
            source: 'local_cache',
            lastEvent: 'waiting_for_local_task',
            error: null,
            notice: 'A host event is stored locally. Run a2a-chat.sh join to inspect it.',
        }, null, 2), 'utf8');
        fs.writeFileSync(pendingPath, `MESSAGE_RECEIVED
┌─ Agent-host [OVER]
│
│ Stale host reply should not replay.
└────
`, 'utf8');

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
if [ -f "${pendingPath}" ]; then
  printf 'present\\n' > "${curlPendingStatePath}"
else
  printf 'missing\\n' > "${curlPendingStatePath}"
fi
printf 'DELIVERED\\n200'
`);
        writeExecutable(path.join(scriptDir, 'a2a-loop.sh'), '#!/bin/bash\necho "WAIT_ALREADY_PENDING"\n');

        try {
            const sendResult = withJoinToken('tok_join_raw_send_clear', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-send.sh'), 'join', 'Fresh join reply [OVER]'],
                {
                    cwd: root,
                    env: {
                        ...process.env,
                        PATH: `${binDir}:${process.env.PATH ?? ''}`,
                        A2A_BASE_URL: 'http://127.0.0.1:3000',
                    },
                    encoding: 'utf8',
                },
            ));

            expect(sendResult.status).toBe(0);
            expect(sendResult.stdout).toContain('DELIVERED');
            expect(fs.readFileSync(curlPendingStatePath, 'utf8').trim()).toBe('missing');
            expect(fs.existsSync(pendingPath)).toBe(false);

            const chatResult = withJoinToken('tok_join_raw_send_clear', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-chat.sh'), 'join'],
                {
                    cwd: root,
                    encoding: 'utf8',
                },
            ));

            expect(chatResult.status).toBe(0);
            expect(chatResult.stdout).toContain('WAIT_ALREADY_PENDING');
            expect(chatResult.stdout).not.toContain('Stale host reply should not replay.');
            expect(fs.readFileSync(pendingPath, 'utf8')).toContain('WAIT_ALREADY_PENDING');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
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

    it('retries a transient remote send once on retryable transport errors', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-send-retry-'));
        const binDir = path.join(root, 'bin');
        const tokenPath = '/tmp/a2a_host_token';
        const statePath = path.join(root, 'send-count');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(tokenPath, 'tok_existing123', 'utf8');

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
COUNT=0
if [ -f "${statePath}" ]; then
  COUNT="$(cat "${statePath}")"
fi
COUNT=$((COUNT + 1))
echo "$COUNT" > "${statePath}"
if [ "$COUNT" -eq 1 ]; then
  echo 'Could not resolve host: broker.a2alinker.net' >&2
  exit 6
fi
printf 'DELIVERED\\n200'
`);

        const result = spawnSync(
            'bash',
            [path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-send.sh'), 'host', 'hello retry [OVER]'],
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
        expect(fs.readFileSync(statePath, 'utf8').trim()).toBe('2');

        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(tokenPath, { force: true });
    });

    it('does not retry remote sends on curl timeout exit 28', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-send-timeout-'));
        const binDir = path.join(root, 'bin');
        const tokenPath = '/tmp/a2a_host_token';
        const statePath = path.join(root, 'send-count');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(tokenPath, 'tok_existing123', 'utf8');

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
COUNT=0
if [ -f "${statePath}" ]; then
  COUNT="$(cat "${statePath}")"
fi
COUNT=$((COUNT + 1))
echo "$COUNT" > "${statePath}"
echo 'Operation timed out after 30000 milliseconds' >&2
exit 28
`);

        const result = spawnSync(
            'bash',
            [path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-send.sh'), 'host', 'hello timeout [OVER]'],
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

        expect(result.status).toBe(1);
        expect(result.stdout).toContain('NOT_DELIVERED: Cannot reach A2A Linker server at https://broker.a2alinker.net (curl exit 28)');
        expect(fs.readFileSync(statePath, 'utf8').trim()).toBe('1');

        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(tokenPath, { force: true });
    });

    it('does not retry remote sends on generic HTTP 000 responses', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-send-http000-'));
        const binDir = path.join(root, 'bin');
        const tokenPath = '/tmp/a2a_host_token';
        const statePath = path.join(root, 'send-count');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(tokenPath, 'tok_existing123', 'utf8');

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
COUNT=0
if [ -f "${statePath}" ]; then
  COUNT="$(cat "${statePath}")"
fi
COUNT=$((COUNT + 1))
echo "$COUNT" > "${statePath}"
printf '\\n000'
`);

        const result = spawnSync(
            'bash',
            [path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-send.sh'), 'host', 'hello http000 [OVER]'],
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

        expect(result.status).toBe(1);
        expect(result.stdout).toContain('NOT_DELIVERED: A2A Linker send failed at https://broker.a2alinker.net (HTTP 000)');
        expect(fs.readFileSync(statePath, 'utf8').trim()).toBe('1');

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

    it('logs curl exit 28 long-poll timeouts separately from transport failures in wait-message.sh', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-wait-timeout-log-'));
        const binDir = path.join(root, 'bin');
        const tokenPath = '/tmp/a2a_host_token';
        const debugLogPath = path.join(root, 'wait-debug.log');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(tokenPath, 'tok_existing123', 'utf8');

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
if printf '%s ' "$@" | grep -q '/wait'; then
  echo 'Operation timed out after 15000 milliseconds' >&2
  exit 28
fi
printf '{"room_alive":true,"partner_connected":true,"partner_last_seen_ms":12}\\n200'
`);

        const result = spawnSync(
            'bash',
            ['.agents/skills/a2alinker/scripts/a2a-wait-message.sh', 'host'],
            {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                    A2A_BASE_URL: 'https://broker.a2alinker.net',
                    A2A_DEBUG: '1',
                    A2A_DEBUG_LOG: debugLogPath,
                },
                encoding: 'utf8',
            },
        );

        const debugLog = fs.readFileSync(debugLogPath, 'utf8');
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('TIMEOUT_ROOM_ALIVE last_seen_ms=12');
        expect(debugLog).toContain('wait:http_timeout base_url=https://broker.a2alinker.net curl_exit=28');
        expect(debugLog).not.toContain('wait:http_failed base_url=https://broker.a2alinker.net curl_exit=28');

        fs.unlinkSync(tokenPath);
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('logs real wait transport failures separately from expected timeout exits', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-wait-failure-log-'));
        const binDir = path.join(root, 'bin');
        const tokenPath = '/tmp/a2a_host_token';
        const debugLogPath = path.join(root, 'wait-debug.log');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(tokenPath, 'tok_existing123', 'utf8');

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
echo 'Could not resolve host: broker.a2alinker.net' >&2
exit 6
`);

        const result = spawnSync(
            'bash',
            ['.agents/skills/a2alinker/scripts/a2a-wait-message.sh', 'host'],
            {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                    A2A_BASE_URL: 'https://broker.a2alinker.net',
                    A2A_DEBUG: '1',
                    A2A_DEBUG_LOG: debugLogPath,
                },
                encoding: 'utf8',
            },
        );

        const debugLog = fs.readFileSync(debugLogPath, 'utf8');
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('TIMEOUT_PING_FAILED');
        expect(debugLog).toContain('wait:http_failed base_url=https://broker.a2alinker.net curl_exit=6');
        expect(debugLog).toContain('wait:ping_failed base_url=https://broker.a2alinker.net');
        expect(debugLog).not.toContain('wait:http_timeout base_url=https://broker.a2alinker.net curl_exit=6');

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

    it('keeps host artifact on local-task state without a passive waiter while a foreground reply is unacknowledged', () => {
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
            expect(artifact.pid).toBeNull();
            expect(artifact.notice).toContain('Run a2a-chat.sh host');
            expect(fs.readFileSync(path.join(sessionDir, 'a2a_host_pending_message.txt'), 'utf8')).toContain('Reply after normal turn');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('exits non-zero when host chat surfaces TIMEOUT_PING_FAILED and restores the passive waiter', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-chat-host-ping-failed-'));
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
            status: 'connected',
            brokerEndpoint: 'https://broker.a2alinker.net',
            headless: false,
            sessionDir,
            pid: null,
            startedAt: '2026-04-18T00:00:00.000Z',
            updatedAt: '2026-04-18T00:00:00.000Z',
            source: 'local_cache',
            lastEvent: 'foreground_chat_active',
            error: null,
            notice: null,
        }, null, 2), 'utf8');

        writeExecutable(path.join(scriptDir, 'a2a-loop.sh'), '#!/bin/bash\necho "TIMEOUT_PING_FAILED"\n');
        writeExecutable(path.join(scriptDir, 'a2a-passive-wait.sh'), `#!/bin/bash
mkdir -p "${sessionDir}"
printf '%s\\n' "$$" > "${sessionDir}/a2a_host_passive_wait.pid"
echo started >> "${waiterStartedPath}"
`);

        try {
            const result = withHostToken('tok_host_ping_failed', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-chat.sh'), 'host'],
                {
                    cwd: root,
                    env: {
                        ...process.env,
                        A2A_DEBUG: '1',
                    },
                    encoding: 'utf8',
                },
            ));

            expect(result.status).toBe(1);
            expect(result.stdout).toContain('TIMEOUT_PING_FAILED');
            expect(fs.readFileSync(waiterStartedPath, 'utf8')).toContain('started');
            expect(fs.readFileSync(path.join(sessionDir, 'a2a_debug.log'), 'utf8')).toContain('chat:loop_transport_failure first_line=TIMEOUT_PING_FAILED');

            const artifact = JSON.parse(fs.readFileSync(path.join(root, '.a2a-host-session.json'), 'utf8')) as {
                status: string;
                lastEvent: string;
                pid: number | null;
                error: string | null;
                notice: string | null;
            };
            expect(artifact.status).toBe('waiting_for_local_task');
            expect(artifact.lastEvent).toBe('waiting_for_local_task');
            expect(typeof artifact.pid).toBe('number');
            expect(artifact.error).toBeNull();
            expect(artifact.notice).toContain('local human decides the next host message');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('passes --surface-join-notice through chat.sh without relying on an env wrapper', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-chat-surface-join-flag-'));
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
            brokerEndpoint: 'https://broker.a2alinker.net',
            headless: false,
            sessionDir,
            pid: null,
            startedAt: '2026-04-18T00:00:00.000Z',
            updatedAt: '2026-04-18T00:00:00.000Z',
            source: 'local_cache',
            lastEvent: 'foreground_chat_active',
            error: null,
            notice: null,
        }, null, 2), 'utf8');

        writeExecutable(path.join(scriptDir, 'a2a-loop.sh'), `#!/bin/bash
if [ -n "\${A2A_SURFACE_JOIN_NOTICE:-}" ]; then
  echo "unexpected env" >&2
  exit 97
fi
if [ "$1" != "--surface-join-notice" ] || [ "$2" != "host" ]; then
  echo "unexpected args: $*" >&2
  exit 98
fi
cat <<'EOF'
MESSAGE_RECEIVED
[SYSTEM]: Partner 'Agent-join' has joined. Session is live!
EOF
`);
        writeExecutable(path.join(scriptDir, 'a2a-passive-wait.sh'), '#!/bin/bash\nexit 0\n');

        try {
            const result = withHostToken('tok_host_surface_join_flag', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-chat.sh'), '--surface-join-notice', 'host'],
                {
                    cwd: root,
                    encoding: 'utf8',
                },
            ));

            expect(result.status).toBe(0);
            expect(result.stdout).toContain('MESSAGE_RECEIVED');
            expect(result.stdout).toContain("Partner 'Agent-join' has joined. Session is live!");
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('marks the join artifact closed when foreground chat receives a host-close system message', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-chat-join-close-'));
        const scriptDir = path.join(root, 'scripts');
        const sessionDir = path.join(root, 'session');
        const waiterStartedPath = path.join(root, 'waiter-started');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });

        copyFile('.agents/skills/a2alinker/scripts/a2a-chat.sh', path.join(scriptDir, 'a2a-chat.sh'));
        copyFile('.agents/skills/a2alinker/scripts/a2a-common.sh', path.join(scriptDir, 'a2a-common.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-chat.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-common.sh'), 0o755);

        fs.writeFileSync(path.join(root, '.a2a-join-session.json'), JSON.stringify({
            mode: 'join',
            status: 'connected',
            inviteCode: 'invite_demo123',
            brokerEndpoint: 'https://broker.a2alinker.net',
            headless: false,
            sessionDir,
            pid: null,
            startedAt: '2026-04-18T00:00:00.000Z',
            updatedAt: '2026-04-18T00:00:00.000Z',
            source: 'local_cache',
            lastEvent: 'foreground_chat_active',
            error: null,
            notice: null,
        }, null, 2), 'utf8');

        writeExecutable(path.join(scriptDir, 'a2a-loop.sh'), `#!/bin/bash
cat <<'EOF'
MESSAGE_RECEIVED
[SYSTEM]: HOST has closed the session. You are disconnected.
EOF
`);
        writeExecutable(path.join(scriptDir, 'a2a-passive-wait.sh'), `#!/bin/bash
echo started >> "${waiterStartedPath}"
`);

        try {
            const result = withJoinToken('tok_join_closed', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-chat.sh'), 'join'],
                {
                    cwd: root,
                    encoding: 'utf8',
                },
            ));

            expect(result.status).toBe(0);
            expect(result.stdout).toContain('HOST has closed the session. You are disconnected.');
            expect(fs.existsSync(waiterStartedPath)).toBe(false);
            const artifact = JSON.parse(fs.readFileSync(path.join(root, '.a2a-join-session.json'), 'utf8')) as {
                status: string;
                lastEvent: string;
                pid: number | null;
                error: string | null;
                notice: string | null;
            };
            expect(artifact.status).toBe('closed');
            expect(artifact.lastEvent).toBe('system_closed');
            expect(artifact.pid).toBeNull();
            expect(artifact.error).toBeNull();
            expect(artifact.notice).toBeNull();
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('exits non-zero when join chat surfaces TIMEOUT_PING_FAILED', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-chat-join-ping-failed-'));
        const scriptDir = path.join(root, 'scripts');
        const sessionDir = path.join(root, 'session');
        const waiterStartedPath = path.join(root, 'waiter-started');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });

        copyFile('.agents/skills/a2alinker/scripts/a2a-chat.sh', path.join(scriptDir, 'a2a-chat.sh'));
        copyFile('.agents/skills/a2alinker/scripts/a2a-common.sh', path.join(scriptDir, 'a2a-common.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-chat.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-common.sh'), 0o755);

        fs.writeFileSync(path.join(root, '.a2a-join-session.json'), JSON.stringify({
            mode: 'join',
            status: 'connected',
            brokerEndpoint: 'https://broker.a2alinker.net',
            headless: false,
            sessionDir,
            pid: null,
            startedAt: '2026-04-18T00:00:00.000Z',
            updatedAt: '2026-04-18T00:00:00.000Z',
            source: 'local_cache',
            lastEvent: 'foreground_chat_active',
            error: null,
            notice: null,
        }, null, 2), 'utf8');

        writeExecutable(path.join(scriptDir, 'a2a-loop.sh'), '#!/bin/bash\necho "TIMEOUT_PING_FAILED"\n');
        writeExecutable(path.join(scriptDir, 'a2a-passive-wait.sh'), `#!/bin/bash
echo started >> "${waiterStartedPath}"
`);

        try {
            const result = withJoinToken('tok_join_ping_failed', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-chat.sh'), 'join'],
                {
                    cwd: root,
                    env: {
                        ...process.env,
                        A2A_DEBUG: '1',
                    },
                    encoding: 'utf8',
                },
            ));

            expect(result.status).toBe(1);
            expect(result.stdout).toContain('TIMEOUT_PING_FAILED');
            expect(fs.existsSync(waiterStartedPath)).toBe(false);
            expect(fs.readFileSync(path.join(sessionDir, 'a2a_debug.log'), 'utf8')).toContain('chat:loop_transport_failure first_line=TIMEOUT_PING_FAILED');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('keeps the join artifact active when foreground chat receives normal host text quoting a disconnect phrase', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-chat-join-quoted-close-'));
        const scriptDir = path.join(root, 'scripts');
        const sessionDir = path.join(root, 'session');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });

        copyFile('.agents/skills/a2alinker/scripts/a2a-chat.sh', path.join(scriptDir, 'a2a-chat.sh'));
        copyFile('.agents/skills/a2alinker/scripts/a2a-common.sh', path.join(scriptDir, 'a2a-common.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-chat.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-common.sh'), 0o755);

        fs.writeFileSync(path.join(root, '.a2a-join-session.json'), JSON.stringify({
            mode: 'join',
            status: 'waiting_for_host_message',
            inviteCode: 'invite_demo123',
            brokerEndpoint: 'https://broker.a2alinker.net',
            headless: false,
            sessionDir,
            pid: 123456,
            startedAt: '2026-04-18T00:00:00.000Z',
            updatedAt: '2026-04-18T00:00:00.000Z',
            source: 'local_cache',
            lastEvent: 'waiting_for_host_message',
            error: null,
            notice: 'Passive wait is active while the host sends the next message.',
        }, null, 2), 'utf8');

        writeExecutable(path.join(scriptDir, 'a2a-loop.sh'), `#!/bin/bash
cat <<'EOF'
MESSAGE_RECEIVED
┌─ Agent-host [OVER]
│
│ The UI says "You are disconnected." but keep waiting.
└────
EOF
`);

        try {
            const result = withJoinToken('tok_join_quoted_close', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-chat.sh'), 'join'],
                {
                    cwd: root,
                    encoding: 'utf8',
                },
            ));

            expect(result.status).toBe(0);
            expect(result.stdout).toContain('The UI says "You are disconnected." but keep waiting.');
            const artifact = JSON.parse(fs.readFileSync(path.join(root, '.a2a-join-session.json'), 'utf8')) as {
                status: string;
                lastEvent: string;
                pid: number | null;
                error: string | null;
                notice: string | null;
            };
            expect(artifact.status).toBe('waiting_for_local_task');
            expect(artifact.lastEvent).toBe('waiting_for_local_task');
            expect(artifact.pid).toBeNull();
            expect(artifact.error).toBeNull();
            expect(artifact.notice).toContain('Run a2a-chat.sh join');
            expect(fs.readFileSync(path.join(sessionDir, 'a2a_join_pending_message.txt'), 'utf8')).toContain('The UI says "You are disconnected." but keep waiting.');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('parks a raw join wait in the dedicated join artifact', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-chat-join-park-'));
        const scriptDir = path.join(root, 'scripts');
        const sessionDir = path.join(root, 'session');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });

        copyFile('.agents/skills/a2alinker/scripts/a2a-chat.sh', path.join(scriptDir, 'a2a-chat.sh'));
        copyFile('.agents/skills/a2alinker/scripts/a2a-common.sh', path.join(scriptDir, 'a2a-common.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-chat.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-common.sh'), 0o755);

        fs.writeFileSync(path.join(root, '.a2a-join-session.json'), JSON.stringify({
            mode: 'join',
            status: 'connected',
            inviteCode: 'invite_demo123',
            brokerEndpoint: 'https://broker.a2alinker.net',
            headless: false,
            sessionDir,
            pid: null,
            startedAt: '2026-04-18T00:00:00.000Z',
            updatedAt: '2026-04-18T00:00:00.000Z',
            source: 'local_cache',
            lastEvent: 'join_connected',
            error: null,
            notice: null,
        }, null, 2), 'utf8');

        writeExecutable(path.join(scriptDir, 'a2a-passive-wait.sh'), `#!/bin/bash
mkdir -p "${sessionDir}"
printf '%s\\n' "$$" > "${sessionDir}/a2a_join_passive_wait.pid"
sleep 3
`);

        try {
            const result = withJoinToken('tok_join_park', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-chat.sh'), '--park', 'join'],
                {
                    cwd: root,
                    encoding: 'utf8',
                },
            ));

            expect(result.status).toBe(0);
            expect(result.stdout).toContain('PARKED:');
            const artifact = JSON.parse(fs.readFileSync(path.join(root, '.a2a-join-session.json'), 'utf8')) as {
                status: string;
                lastEvent: string;
                pid: number | null;
                notice: string | null;
            };
            expect(artifact.status).toBe('waiting_for_host_message');
            expect(artifact.lastEvent).toBe('waiting_for_host_message');
            expect(typeof artifact.pid).toBe('number');
            expect(artifact.notice).toContain('Passive wait is active while the host sends the next message.');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('parks a raw host send after one delivery and marks the artifact as waiting for a reply', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-chat-host-park-'));
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
            status: 'connected',
            attachedListenerCode: null,
            inviteCode: 'invite_demo123',
            brokerEndpoint: 'https://broker.a2alinker.net',
            headless: false,
            sessionDir,
            pid: null,
            startedAt: '2026-04-18T00:00:00.000Z',
            updatedAt: '2026-04-18T00:00:00.000Z',
            source: 'local_cache',
            lastEvent: 'waiting_for_local_task',
            error: null,
            notice: null,
        }, null, 2), 'utf8');

        writeExecutable(path.join(scriptDir, 'a2a-send.sh'), `#!/bin/bash
printf '%s\\n' "$2" >> "${sendsPath}"
echo "DELIVERED"
`);
        writeExecutable(path.join(scriptDir, 'a2a-passive-wait.sh'), `#!/bin/bash
mkdir -p "${sessionDir}"
printf '%s\\n' "$$" > "${sessionDir}/a2a_host_passive_wait.pid"
sleep 3
`);

        try {
            const result = withHostToken('tok_host_park', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-chat.sh'), '--park', 'host', 'probe [OVER]'],
                {
                    cwd: root,
                    encoding: 'utf8',
                },
            ));

            expect(result.status).toBe(0);
            expect(result.stdout).toContain('DELIVERED');
            expect(result.stdout).toContain('PARKED:');
            expect(fs.readFileSync(sendsPath, 'utf8').trim().split('\n')).toEqual(['probe [OVER]']);
            expect(fs.readFileSync(path.join(sessionDir, 'a2a_host_inflight_message.txt'), 'utf8').trim()).toBe('probe [OVER]');
            const artifact = JSON.parse(fs.readFileSync(path.join(root, '.a2a-host-session.json'), 'utf8')) as {
                status: string;
                lastEvent: string;
                pid: number | null;
                notice: string | null;
            };
            expect(artifact.status).toBe('waiting_for_partner_reply');
            expect(artifact.lastEvent).toBe('waiting_for_partner_reply');
            expect(typeof artifact.pid).toBe('number');
            expect(artifact.notice).toContain('partner reply is pending');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('consumes a pending raw join message before entering the loop again', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-chat-join-pending-'));
        const scriptDir = path.join(root, 'scripts');
        const sessionDir = path.join(root, 'session');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });

        copyFile('.agents/skills/a2alinker/scripts/a2a-chat.sh', path.join(scriptDir, 'a2a-chat.sh'));
        copyFile('.agents/skills/a2alinker/scripts/a2a-common.sh', path.join(scriptDir, 'a2a-common.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-chat.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-common.sh'), 0o755);

        fs.writeFileSync(path.join(root, '.a2a-join-session.json'), JSON.stringify({
            mode: 'join',
            status: 'waiting_for_local_task',
            inviteCode: 'invite_demo123',
            brokerEndpoint: 'https://broker.a2alinker.net',
            headless: false,
            sessionDir,
            pid: null,
            startedAt: '2026-04-18T00:00:00.000Z',
            updatedAt: '2026-04-18T00:00:00.000Z',
            source: 'local_cache',
            lastEvent: 'waiting_for_local_task',
            error: null,
            notice: 'A host event is stored locally. Run a2a-chat.sh join to inspect it.',
        }, null, 2), 'utf8');
        fs.writeFileSync(path.join(sessionDir, 'a2a_join_pending_message.txt'), `MESSAGE_RECEIVED
┌─ Agent-host [OVER]
│
│ Confirm you are still there
└────
`, 'utf8');

        writeExecutable(path.join(scriptDir, 'a2a-loop.sh'), '#!/bin/bash\necho "loop-should-not-run"\nexit 99\n');

        try {
            const result = withJoinToken('tok_join_pending', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-chat.sh'), 'join'],
                {
                    cwd: root,
                    encoding: 'utf8',
                },
            ));

            expect(result.status).toBe(0);
            expect(result.stdout).toContain('Confirm you are still there');
            expect(result.stdout).not.toContain('loop-should-not-run');
            expect(fs.readFileSync(path.join(sessionDir, 'a2a_join_pending_message.txt'), 'utf8')).toContain('Confirm you are still there');
            expect(fs.readFileSync(path.join(sessionDir, 'a2a_join_last_foreground_output.txt'), 'utf8')).toContain('Confirm you are still there');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('stages a foreground join receive before printing and keeps it until outbound reply', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-chat-join-foreground-stage-'));
        const scriptDir = path.join(root, 'scripts');
        const sessionDir = path.join(root, 'session');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });

        copyFile('.agents/skills/a2alinker/scripts/a2a-chat.sh', path.join(scriptDir, 'a2a-chat.sh'));
        copyFile('.agents/skills/a2alinker/scripts/a2a-common.sh', path.join(scriptDir, 'a2a-common.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-chat.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-common.sh'), 0o755);

        fs.writeFileSync(path.join(root, '.a2a-join-session.json'), JSON.stringify({
            mode: 'join',
            status: 'connected',
            inviteCode: 'invite_demo123',
            brokerEndpoint: 'https://broker.a2alinker.net',
            headless: false,
            sessionDir,
            pid: null,
            startedAt: '2026-04-18T00:00:00.000Z',
            updatedAt: '2026-04-18T00:00:00.000Z',
            source: 'local_cache',
            lastEvent: 'foreground_chat_active',
            error: null,
            notice: null,
        }, null, 2), 'utf8');

        writeExecutable(path.join(scriptDir, 'a2a-loop.sh'), `#!/bin/bash
cat <<'EOF'
MESSAGE_RECEIVED
┌─ Agent-host [OVER]
│
│ Please send a confirmation message to verify the connection.
└────
EOF
`);

        try {
            const result = withJoinToken('tok_join_foreground_stage', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-chat.sh'), 'join'],
                {
                    cwd: root,
                    env: {
                        ...process.env,
                        A2A_DEBUG: '1',
                    },
                    encoding: 'utf8',
                },
            ));

            expect(result.status).toBe(0);
            expect(result.stdout).toContain('Please send a confirmation message to verify the connection.');
            expect(fs.readFileSync(path.join(sessionDir, 'a2a_join_pending_message.txt'), 'utf8')).toContain('Please send a confirmation message');
            expect(fs.readFileSync(path.join(sessionDir, 'a2a_join_last_foreground_output.txt'), 'utf8')).toContain('Please send a confirmation message');

            const debugLog = fs.readFileSync(path.join(sessionDir, 'a2a_debug.log'), 'utf8');
            expect(debugLog).toContain('chat:stage_pending_output first_line=MESSAGE_RECEIVED');
            expect(debugLog).toContain('chat:print_output_start first_line=MESSAGE_RECEIVED');
            expect(debugLog).toContain('chat:print_output_complete status=0 first_line=MESSAGE_RECEIVED');

            const artifact = JSON.parse(fs.readFileSync(path.join(root, '.a2a-join-session.json'), 'utf8')) as {
                status: string;
                lastEvent: string;
                notice: string | null;
            };
            expect(artifact.status).toBe('waiting_for_local_task');
            expect(artifact.lastEvent).toBe('waiting_for_local_task');
            expect(artifact.notice).toContain('Run a2a-chat.sh join');

            writeExecutable(path.join(scriptDir, 'a2a-loop.sh'), `#!/bin/bash
echo "DELIVERED"
`);
            const reply = withJoinToken('tok_join_foreground_stage', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-chat.sh'), 'join', 'Confirmed receipt [OVER]'],
                {
                    cwd: root,
                    env: {
                        ...process.env,
                        A2A_DEBUG: '1',
                    },
                    encoding: 'utf8',
                },
            ));

            expect(reply.status).toBe(0);
            expect(fs.existsSync(path.join(sessionDir, 'a2a_join_pending_message.txt'))).toBe(false);
            expect(fs.readFileSync(path.join(sessionDir, 'a2a_debug.log'), 'utf8')).toContain('chat:clear_pending_for_outbound');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('stages a join send-and-wait receive even when output starts with DELIVERED', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-chat-join-send-wait-stage-'));
        const scriptDir = path.join(root, 'scripts');
        const sessionDir = path.join(root, 'session');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });

        copyFile('.agents/skills/a2alinker/scripts/a2a-chat.sh', path.join(scriptDir, 'a2a-chat.sh'));
        copyFile('.agents/skills/a2alinker/scripts/a2a-common.sh', path.join(scriptDir, 'a2a-common.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-chat.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-common.sh'), 0o755);

        fs.writeFileSync(path.join(root, '.a2a-join-session.json'), JSON.stringify({
            mode: 'join',
            status: 'connected',
            inviteCode: 'invite_demo123',
            brokerEndpoint: 'https://broker.a2alinker.net',
            headless: false,
            sessionDir,
            pid: null,
            startedAt: '2026-04-18T00:00:00.000Z',
            updatedAt: '2026-04-18T00:00:00.000Z',
            source: 'local_cache',
            lastEvent: 'foreground_chat_active',
            error: null,
            notice: null,
        }, null, 2), 'utf8');

        writeExecutable(path.join(scriptDir, 'a2a-loop.sh'), `#!/bin/bash
cat <<'EOF'
DELIVERED
MESSAGE_RECEIVED
┌─ Agent-host [OVER]
│
│ Please declare your name.
└────
EOF
`);

        try {
            const result = withJoinToken('tok_join_send_wait_stage', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-chat.sh'), 'join', 'My name is Codi. [OVER]'],
                {
                    cwd: root,
                    env: {
                        ...process.env,
                        A2A_DEBUG: '1',
                    },
                    encoding: 'utf8',
                },
            ));

            expect(result.status).toBe(0);
            expect(result.stdout).toContain('DELIVERED');
            expect(result.stdout).toContain('Please declare your name.');
            expect(fs.readFileSync(path.join(sessionDir, 'a2a_join_pending_message.txt'), 'utf8')).toContain('Please declare your name.');
            expect(fs.readFileSync(path.join(sessionDir, 'a2a_join_last_foreground_output.txt'), 'utf8')).toContain('DELIVERED');

            const debugLog = fs.readFileSync(path.join(sessionDir, 'a2a_debug.log'), 'utf8');
            expect(debugLog).toContain('chat:stage_pending_output first_line=DELIVERED');
            expect(debugLog).toContain('chat:print_output_complete status=0 first_line=DELIVERED');

            const artifact = JSON.parse(fs.readFileSync(path.join(root, '.a2a-join-session.json'), 'utf8')) as {
                status: string;
                lastEvent: string;
                notice: string | null;
            };
            expect(artifact.status).toBe('waiting_for_local_task');
            expect(artifact.lastEvent).toBe('waiting_for_local_task');
            expect(artifact.notice).toContain('Run a2a-chat.sh join');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('surfaces a staged host join notice before the first combined host send clears it', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-chat-host-join-recover-before-send-'));
        const scriptDir = path.join(root, 'scripts');
        const sessionDir = path.join(root, 'session');
        const pendingPath = path.join(sessionDir, 'a2a_host_pending_message.txt');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });

        copyFile('.agents/skills/a2alinker/scripts/a2a-chat.sh', path.join(scriptDir, 'a2a-chat.sh'));
        copyFile('.agents/skills/a2alinker/scripts/a2a-common.sh', path.join(scriptDir, 'a2a-common.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-chat.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-common.sh'), 0o755);

        fs.writeFileSync(path.join(root, '.a2a-host-session.json'), JSON.stringify({
            mode: 'host',
            status: 'connected',
            brokerEndpoint: 'https://broker.a2alinker.net',
            headless: false,
            sessionDir,
            pid: null,
            startedAt: '2026-04-18T00:00:00.000Z',
            updatedAt: '2026-04-18T00:00:00.000Z',
            source: 'local_cache',
            lastEvent: 'system_joined',
            error: null,
            notice: 'Connection established. HOST can send the first message.',
        }, null, 2), 'utf8');
        fs.writeFileSync(pendingPath, `MESSAGE_RECEIVED
[SYSTEM]: Partner 'Agent-join' has joined. Session is live!
`, 'utf8');

        writeExecutable(path.join(scriptDir, 'a2a-loop.sh'), `#!/bin/bash
if [ "$1" != "host" ] || [ "$2" != "Please send a confirmation message. [OVER]" ]; then
  echo "unexpected args: $*" >&2
  exit 98
fi
cat <<'EOF'
DELIVERED
MESSAGE_RECEIVED
┌─ Agent-join [OVER]
│
│ I confirm the connection.
└────
EOF
`);
        writeExecutable(path.join(scriptDir, 'a2a-passive-wait.sh'), '#!/bin/bash\nexit 0\n');

        try {
            const result = withHostToken('tok_host_join_recover_before_send', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-chat.sh'), 'host', 'Please send a confirmation message. [OVER]'],
                {
                    cwd: root,
                    env: {
                        ...process.env,
                        A2A_DEBUG: '1',
                    },
                    encoding: 'utf8',
                },
            ));

            expect(result.status).toBe(0);
            expect(result.stdout).toContain("Partner 'Agent-join' has joined. Session is live!");
            expect(result.stdout).toContain('DELIVERED');
            expect(result.stdout).toContain('I confirm the connection.');
            expect(result.stdout.indexOf("Partner 'Agent-join' has joined. Session is live!")).toBeLessThan(result.stdout.indexOf('DELIVERED'));
            expect(fs.readFileSync(pendingPath, 'utf8')).toContain('I confirm the connection.');

            const debugLog = fs.readFileSync(path.join(sessionDir, 'a2a_debug.log'), 'utf8');
            expect(debugLog).toContain('chat:recover_pending_join_notice_before_send');
            expect(debugLog).toContain('chat:clear_pending_for_outbound');

            const artifact = JSON.parse(fs.readFileSync(path.join(root, '.a2a-host-session.json'), 'utf8')) as {
                status: string;
                lastEvent: string;
                notice: string | null;
            };
            expect(artifact.status).toBe('waiting_for_local_task');
            expect(artifact.lastEvent).toBe('waiting_for_local_task');
            expect(artifact.notice).toContain('Run a2a-chat.sh host');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('marks the join passive waiter artifact closed when it stores a host-close system message', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-passive-wait-join-close-'));
        const scriptDir = path.join(root, 'scripts');
        const sessionDir = path.join(root, 'session');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });

        copyFile('.agents/skills/a2alinker/scripts/a2a-passive-wait.sh', path.join(scriptDir, 'a2a-passive-wait.sh'));
        copyFile('.agents/skills/a2alinker/scripts/a2a-common.sh', path.join(scriptDir, 'a2a-common.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-passive-wait.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-common.sh'), 0o755);

        fs.writeFileSync(path.join(root, '.a2a-join-session.json'), JSON.stringify({
            mode: 'join',
            status: 'waiting_for_host_message',
            inviteCode: 'invite_demo123',
            brokerEndpoint: 'https://broker.a2alinker.net',
            headless: false,
            sessionDir,
            pid: 123456,
            startedAt: '2026-04-18T00:00:00.000Z',
            updatedAt: '2026-04-18T00:00:00.000Z',
            source: 'local_cache',
            lastEvent: 'waiting_for_host_message',
            error: null,
            notice: 'Passive wait is active while the host sends the next message.',
        }, null, 2), 'utf8');

        writeExecutable(path.join(scriptDir, 'a2a-wait-message.sh'), `#!/bin/bash
cat <<'EOF'
MESSAGE_RECEIVED
[SYSTEM]: HOST has closed the session. You are disconnected.
EOF
`);

        try {
            const result = spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-passive-wait.sh'), 'join'],
                {
                    cwd: root,
                    encoding: 'utf8',
                },
            );

            expect(result.status).toBe(0);
            expect(fs.readFileSync(path.join(sessionDir, 'a2a_join_pending_message.txt'), 'utf8')).toContain('HOST has closed the session. You are disconnected.');
            const artifact = JSON.parse(fs.readFileSync(path.join(root, '.a2a-join-session.json'), 'utf8')) as {
                status: string;
                lastEvent: string;
                pid: number | null;
                error: string | null;
                notice: string | null;
            };
            expect(artifact.status).toBe('closed');
            expect(artifact.lastEvent).toBe('system_closed');
            expect(artifact.pid).toBeNull();
            expect(artifact.error).toBeNull();
            expect(artifact.notice).toBeNull();
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('keeps the join passive waiter artifact active when a normal host message quotes a disconnect phrase', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-passive-wait-join-quoted-close-'));
        const scriptDir = path.join(root, 'scripts');
        const sessionDir = path.join(root, 'session');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });

        copyFile('.agents/skills/a2alinker/scripts/a2a-passive-wait.sh', path.join(scriptDir, 'a2a-passive-wait.sh'));
        copyFile('.agents/skills/a2alinker/scripts/a2a-common.sh', path.join(scriptDir, 'a2a-common.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-passive-wait.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-common.sh'), 0o755);

        fs.writeFileSync(path.join(root, '.a2a-join-session.json'), JSON.stringify({
            mode: 'join',
            status: 'waiting_for_host_message',
            inviteCode: 'invite_demo123',
            brokerEndpoint: 'https://broker.a2alinker.net',
            headless: false,
            sessionDir,
            pid: 123456,
            startedAt: '2026-04-18T00:00:00.000Z',
            updatedAt: '2026-04-18T00:00:00.000Z',
            source: 'local_cache',
            lastEvent: 'waiting_for_host_message',
            error: null,
            notice: 'Passive wait is active while the host sends the next message.',
        }, null, 2), 'utf8');

        writeExecutable(path.join(scriptDir, 'a2a-wait-message.sh'), `#!/bin/bash
cat <<'EOF'
MESSAGE_RECEIVED
┌─ Agent-host [OVER]
│
│ The UI says "You are disconnected." but keep waiting.
└────
EOF
`);

        try {
            const result = spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-passive-wait.sh'), 'join'],
                {
                    cwd: root,
                    encoding: 'utf8',
                },
            );

            expect(result.status).toBe(0);
            expect(fs.readFileSync(path.join(sessionDir, 'a2a_join_pending_message.txt'), 'utf8')).toContain('The UI says "You are disconnected." but keep waiting.');
            const artifact = JSON.parse(fs.readFileSync(path.join(root, '.a2a-join-session.json'), 'utf8')) as {
                status: string;
                lastEvent: string;
                pid: number | null;
                error: string | null;
                notice: string | null;
            };
            expect(artifact.status).toBe('waiting_for_local_task');
            expect(artifact.lastEvent).toBe('waiting_for_local_task');
            expect(artifact.pid).toBeNull();
            expect(artifact.error).toBeNull();
            expect(artifact.notice).toContain('Run a2a-chat.sh join');
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('exits a passive waiter on its next loop when the waiter pid file is removed', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-passive-wait-lost-owner-'));
        const scriptDir = path.join(root, 'scripts');
        const sessionDir = path.join(root, 'session');
        const waiterPidPath = path.join(sessionDir, 'a2a_host_passive_wait.pid');
        const startedPath = path.join(root, 'wait-started');
        const releasePath = path.join(root, 'wait-release');
        const waitCountPath = path.join(root, 'wait-count');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });

        copyFile('.agents/skills/a2alinker/scripts/a2a-passive-wait.sh', path.join(scriptDir, 'a2a-passive-wait.sh'));
        copyFile('.agents/skills/a2alinker/scripts/a2a-common.sh', path.join(scriptDir, 'a2a-common.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-passive-wait.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-common.sh'), 0o755);

        fs.writeFileSync(path.join(root, '.a2a-host-session.json'), JSON.stringify({
            mode: 'host',
            status: 'waiting_for_local_task',
            brokerEndpoint: 'http://127.0.0.1:3000',
            headless: false,
            sessionDir,
            pid: 123456,
            startedAt: '2026-04-18T00:00:00.000Z',
            updatedAt: '2026-04-18T00:00:00.000Z',
            source: 'local_cache',
            lastEvent: 'waiting_for_local_task',
            error: null,
            notice: 'Passive wait is active while the local human decides the next host message.',
        }, null, 2), 'utf8');

        writeExecutable(path.join(scriptDir, 'a2a-wait-message.sh'), `#!/bin/bash
COUNT=0
if [ -n "\${A2A_TEST_WAIT_COUNT_PATH:-}" ] && [ -f "$A2A_TEST_WAIT_COUNT_PATH" ]; then
  COUNT="$(cat "$A2A_TEST_WAIT_COUNT_PATH")"
fi
COUNT=$((COUNT + 1))
if [ -n "\${A2A_TEST_WAIT_COUNT_PATH:-}" ]; then
  printf '%s\\n' "$COUNT" > "$A2A_TEST_WAIT_COUNT_PATH"
fi
if [ "$COUNT" -eq 1 ] && [ -n "\${A2A_TEST_STARTED_PATH:-}" ]; then
  printf 'started\\n' > "$A2A_TEST_STARTED_PATH"
fi
if [ "$COUNT" -eq 1 ] && [ -n "\${A2A_TEST_RELEASE_PATH:-}" ]; then
  while [ ! -f "$A2A_TEST_RELEASE_PATH" ]; do
    sleep 0.05
  done
fi
echo "TIMEOUT_WAIT_EXPIRED"
`);

        const waiter = spawn('bash', [path.join(scriptDir, 'a2a-passive-wait.sh'), 'host'], {
            cwd: root,
            env: {
                ...process.env,
                A2A_DEBUG: '1',
                A2A_TEST_STARTED_PATH: startedPath,
                A2A_TEST_RELEASE_PATH: releasePath,
                A2A_TEST_WAIT_COUNT_PATH: waitCountPath,
            },
            stdio: 'ignore',
        });

        try {
            await waitForCondition(() => fs.existsSync(waiterPidPath) && fs.existsSync(startedPath));
            fs.rmSync(waiterPidPath, { force: true });
            fs.writeFileSync(releasePath, 'release\n', 'utf8');

            await waitForCondition(() => waiter.exitCode !== null || waiter.signalCode !== null);

            expect(waiter.exitCode).toBe(0);
            expect(fs.readFileSync(waitCountPath, 'utf8').trim()).toBe('1');
            expect(fs.existsSync(waiterPidPath)).toBe(false);
            expect(fs.readFileSync(path.join(sessionDir, 'a2a_debug.log'), 'utf8')).toContain('passive_wait:lost_ownership');
        } finally {
            if (waiter.exitCode === null && waiter.signalCode === null) {
                waiter.kill('SIGKILL');
            }
            fs.rmSync(root, { recursive: true, force: true });
        }
    }, 10000);

    it('does not let an older passive waiter delete a newer waiter pid file after ownership changes', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-passive-wait-handoff-'));
        const scriptDir = path.join(root, 'scripts');
        const sessionDir = path.join(root, 'session');
        const waiterPidPath = path.join(sessionDir, 'a2a_host_passive_wait.pid');
        const olderStartedPath = path.join(root, 'older-started');
        const olderReleasePath = path.join(root, 'older-release');
        const olderWaitCountPath = path.join(root, 'older-count');
        const newerStartedPath = path.join(root, 'newer-started');
        const newerReleasePath = path.join(root, 'newer-release');
        const newerWaitCountPath = path.join(root, 'newer-count');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });

        copyFile('.agents/skills/a2alinker/scripts/a2a-passive-wait.sh', path.join(scriptDir, 'a2a-passive-wait.sh'));
        copyFile('.agents/skills/a2alinker/scripts/a2a-common.sh', path.join(scriptDir, 'a2a-common.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-passive-wait.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-common.sh'), 0o755);

        fs.writeFileSync(path.join(root, '.a2a-host-session.json'), JSON.stringify({
            mode: 'host',
            status: 'waiting_for_local_task',
            brokerEndpoint: 'http://127.0.0.1:3000',
            headless: false,
            sessionDir,
            pid: 123456,
            startedAt: '2026-04-18T00:00:00.000Z',
            updatedAt: '2026-04-18T00:00:00.000Z',
            source: 'local_cache',
            lastEvent: 'waiting_for_local_task',
            error: null,
            notice: 'Passive wait is active while the local human decides the next host message.',
        }, null, 2), 'utf8');

        writeExecutable(path.join(scriptDir, 'a2a-wait-message.sh'), `#!/bin/bash
COUNT=0
if [ -n "\${A2A_TEST_WAIT_COUNT_PATH:-}" ] && [ -f "$A2A_TEST_WAIT_COUNT_PATH" ]; then
  COUNT="$(cat "$A2A_TEST_WAIT_COUNT_PATH")"
fi
COUNT=$((COUNT + 1))
if [ -n "\${A2A_TEST_WAIT_COUNT_PATH:-}" ]; then
  printf '%s\\n' "$COUNT" > "$A2A_TEST_WAIT_COUNT_PATH"
fi
if [ "$COUNT" -eq 1 ] && [ -n "\${A2A_TEST_STARTED_PATH:-}" ]; then
  printf 'started\\n' > "$A2A_TEST_STARTED_PATH"
fi
if [ "$COUNT" -eq 1 ] && [ -n "\${A2A_TEST_RELEASE_PATH:-}" ]; then
  while [ ! -f "$A2A_TEST_RELEASE_PATH" ]; do
    sleep 0.05
  done
fi
echo "TIMEOUT_WAIT_EXPIRED"
`);

        const olderWaiter = spawn('bash', [path.join(scriptDir, 'a2a-passive-wait.sh'), 'host'], {
            cwd: root,
            env: {
                ...process.env,
                A2A_DEBUG: '1',
                A2A_TEST_STARTED_PATH: olderStartedPath,
                A2A_TEST_RELEASE_PATH: olderReleasePath,
                A2A_TEST_WAIT_COUNT_PATH: olderWaitCountPath,
            },
            stdio: 'ignore',
        });

        let newerWaiter: ReturnType<typeof spawn> | null = null;
        try {
            await waitForCondition(() => fs.existsSync(waiterPidPath) && fs.existsSync(olderStartedPath));

            newerWaiter = spawn('bash', [path.join(scriptDir, 'a2a-passive-wait.sh'), 'host'], {
                cwd: root,
                env: {
                    ...process.env,
                    A2A_DEBUG: '1',
                    A2A_TEST_STARTED_PATH: newerStartedPath,
                    A2A_TEST_RELEASE_PATH: newerReleasePath,
                    A2A_TEST_WAIT_COUNT_PATH: newerWaitCountPath,
                },
                stdio: 'ignore',
            });

            await waitForCondition(() =>
                fs.existsSync(newerStartedPath)
                && fs.existsSync(waiterPidPath)
                && fs.readFileSync(waiterPidPath, 'utf8').trim() === String(newerWaiter?.pid),
            );

            fs.writeFileSync(olderReleasePath, 'release\n', 'utf8');
            await waitForCondition(() => olderWaiter.exitCode !== null || olderWaiter.signalCode !== null);

            expect(olderWaiter.exitCode).toBe(0);
            expect(fs.readFileSync(olderWaitCountPath, 'utf8').trim()).toBe('1');
            expect(fs.existsSync(waiterPidPath)).toBe(true);
            expect(fs.readFileSync(waiterPidPath, 'utf8').trim()).toBe(String(newerWaiter!.pid));
            expect(fs.readFileSync(path.join(sessionDir, 'a2a_debug.log'), 'utf8')).toContain('passive_wait:lost_ownership');
            expect(() => process.kill(newerWaiter!.pid!, 0)).not.toThrow();
        } finally {
            if (newerWaiter && newerWaiter.exitCode === null && newerWaiter.signalCode === null) {
                const activeNewerWaiter = newerWaiter;
                activeNewerWaiter.kill('SIGTERM');
                await waitForCondition(() => activeNewerWaiter.exitCode !== null || activeNewerWaiter.signalCode !== null);
            }
            if (olderWaiter.exitCode === null && olderWaiter.signalCode === null) {
                olderWaiter.kill('SIGKILL');
            }
            fs.rmSync(root, { recursive: true, force: true });
        }
    }, 10000);

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

    it('skips spawning a second passive waiter when one is already running during a host park handoff', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-chat-waiter-running-'));
        const scriptDir = path.join(root, 'scripts');
        const sessionDir = path.join(root, 'session');
        const waiterStartedPath = path.join(root, 'waiter-started');
        const existingWaiterPidPath = path.join(root, 'existing-waiter-pid');
        const waiterPidPath = path.join(sessionDir, 'a2a_host_passive_wait.pid');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.mkdirSync(sessionDir, { recursive: true });

        copyFile('.agents/skills/a2alinker/scripts/a2a-chat.sh', path.join(scriptDir, 'a2a-chat.sh'));
        copyFile('.agents/skills/a2alinker/scripts/a2a-common.sh', path.join(scriptDir, 'a2a-common.sh'));
        fs.chmodSync(path.join(scriptDir, 'a2a-chat.sh'), 0o755);
        fs.chmodSync(path.join(scriptDir, 'a2a-common.sh'), 0o755);

        fs.writeFileSync(path.join(root, '.a2a-host-session.json'), JSON.stringify({
            mode: 'host',
            status: 'waiting_for_local_task',
            brokerEndpoint: 'http://127.0.0.1:3000',
            headless: false,
            sessionDir,
            pid: null,
            startedAt: '2026-04-18T00:00:00.000Z',
            updatedAt: '2026-04-18T00:00:00.000Z',
            source: 'local_cache',
            lastEvent: 'waiting_for_local_task',
            error: null,
            notice: null,
        }, null, 2), 'utf8');

        writeExecutable(path.join(scriptDir, 'a2a-send.sh'), `#!/bin/bash
nohup bash -c 'exec sleep 30' >/dev/null 2>&1 &
WAITER_PID=$!
printf '%s\\n' "$WAITER_PID" > "${existingWaiterPidPath}"
printf '%s\\n' "$WAITER_PID" > "${waiterPidPath}"
echo "DELIVERED"
`);
        writeExecutable(path.join(scriptDir, 'a2a-passive-wait.sh'), `#!/bin/bash
echo started >> "${waiterStartedPath}"
`);

        let existingWaiterPid = 0;
        try {
            const result = withHostToken('tok_waiter_running', () => spawnSync(
                'bash',
                [path.join(scriptDir, 'a2a-chat.sh'), '--park', 'host', 'probe [OVER]'],
                {
                    cwd: root,
                    env: {
                        ...process.env,
                        A2A_DEBUG: '1',
                    },
                    encoding: 'utf8',
                },
            ));

            existingWaiterPid = Number(fs.readFileSync(existingWaiterPidPath, 'utf8').trim());

            expect(result.status).toBe(0);
            expect(result.stdout).toContain('PARKED:');
            expect(existingWaiterPid).toBeGreaterThan(0);
            expect(fs.existsSync(waiterStartedPath)).toBe(false);
            expect(fs.readFileSync(waiterPidPath, 'utf8').trim()).toBe(String(existingWaiterPid));
            expect(fs.readFileSync(path.join(sessionDir, 'a2a_debug.log'), 'utf8')).toContain('chat:start_passive_waiter skipped=waiter_running');

            const artifact = JSON.parse(fs.readFileSync(path.join(root, '.a2a-host-session.json'), 'utf8')) as {
                status: string;
                lastEvent: string;
                pid: number | null;
                error: string | null;
                notice: string | null;
            };
            expect(artifact.status).toBe('connected');
            expect(artifact.lastEvent).toBe('foreground_chat_active');
            expect(artifact.pid).toBeNull();
            expect(artifact.error).toBeNull();
            expect(artifact.notice).toBeNull();
            expect(() => process.kill(existingWaiterPid, 0)).not.toThrow();
        } finally {
            if (existingWaiterPid > 0) {
                try {
                    process.kill(existingWaiterPid, 'SIGKILL');
                } catch {
                    // Existing waiter is already gone.
                }
            }
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

    it('defaults fresh listener setup to the local broker even when stale artifacts point remote', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-listen-fresh-broker-'));
        const binDir = path.join(root, 'bin');
        const curlArgsPath = path.join(root, 'curl-args');
        const scriptPath = path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-listen.sh');
        fs.mkdirSync(binDir, { recursive: true });

        fs.writeFileSync(path.join(root, '.a2a-host-session.json'), JSON.stringify({
            mode: 'host',
            status: 'closed',
            attachedListenerCode: null,
            inviteCode: 'invite_remote123',
            brokerEndpoint: 'https://broker.a2alinker.net',
            headless: false,
            sessionDir: path.join(root, 'host-session'),
            pid: null,
            startedAt: '2026-04-11T00:00:00.000Z',
            updatedAt: '2026-04-11T00:00:00.000Z',
            source: 'local_cache',
            lastEvent: 'closed',
            error: null,
        }, null, 2), 'utf8');
        fs.writeFileSync(path.join(root, '.a2a-listener-session.json'), JSON.stringify({
            mode: 'listen',
            status: 'closed',
            brokerEndpoint: 'https://broker.a2alinker.net',
            sessionDir: path.join(root, 'listener-session'),
        }, null, 2), 'utf8');
        fs.writeFileSync(path.join(root, '.a2a-listener-policy.json'), JSON.stringify({
            brokerEndpoint: 'https://broker.a2alinker.net',
        }, null, 2), 'utf8');

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
printf '%s\n' "$@" > "${curlArgsPath}"
printf '%s' '{"token":"tok_a1b2c3d5","listenerCode":"listen_local123"}'
`);

        const result = spawnSync(
            'bash',
            [scriptPath, 'false'],
            {
                cwd: root,
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                    A2A_BASE_URL: '',
                    A2A_SERVER: '',
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('LISTENER_CODE: listen_local123');
        expect(fs.readFileSync(curlArgsPath, 'utf8')).toContain('http://127.0.0.1:3000/setup');
        expect(fs.readFileSync('/tmp/a2a_join_base_url', 'utf8').trim()).toBe('http://127.0.0.1:3000');

        fs.rmSync(root, { recursive: true, force: true });
        clearA2ATmpState();
    });

    it('cleans up a stale listener-side token on its saved broker before creating a fresh listener room', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-listen-stale-cleanup-'));
        const binDir = path.join(root, 'bin');
        const callLogPath = path.join(root, 'curl-calls.log');
        const scriptPath = path.join(process.cwd(), '.agents/skills/a2alinker/scripts/a2a-listen.sh');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync('/tmp/a2a_join_base_url', 'https://broker.a2alinker.net\n', 'utf8');
        fs.writeFileSync('/tmp/a2a_join_token', 'tok_stalelistener123\n', 'utf8');

        writeExecutable(path.join(binDir, 'curl'), `#!/bin/bash
if printf '%s ' "$@" | grep -q '/leave'; then
  printf 'leave %s\n' "$*" >> "${callLogPath}"
  exit 0
fi
if printf '%s ' "$@" | grep -q '/setup'; then
  printf 'setup %s\n' "$*" >> "${callLogPath}"
  printf '%s' '{"token":"tok_a1b2c3d5","listenerCode":"listen_fresh123"}'
  exit 0
fi
exit 99
`);

        const result = spawnSync(
            'bash',
            [scriptPath, 'false'],
            {
                cwd: root,
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                    A2A_BASE_URL: 'https://fresh.broker.example',
                    A2A_SERVER: '',
                },
                encoding: 'utf8',
            },
        );

        const callLog = await waitForLogLines(callLogPath, 2);
        const leaveLine = callLog.find((line) => line.startsWith('leave ')) ?? '';
        const setupLine = callLog.find((line) => line.startsWith('setup ')) ?? '';

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('LISTENER_CODE: listen_fresh123');
        expect(leaveLine).toContain('https://broker.a2alinker.net/leave');
        expect(leaveLine).toContain('tok_stalelistener123');
        expect(setupLine).toContain('https://fresh.broker.example/setup');
        expect(fs.readFileSync('/tmp/a2a_join_base_url', 'utf8').trim()).toBe('https://fresh.broker.example');

        fs.rmSync(root, { recursive: true, force: true });
        clearA2ATmpState();
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
        const hostArtifact = JSON.parse(fs.readFileSync(path.join(root, '.a2a-host-session.json'), 'utf8')) as {
            sessionDir: string;
        };
        const fallbackDebugLog = fs.readFileSync('/tmp/a2a_host_debug.log', 'utf8');
        const sessionDebugLog = fs.readFileSync(path.join(hostArtifact.sessionDir, 'a2a_debug.log'), 'utf8');
        expect(fallbackDebugLog).toContain('host_connect:start mode=standard');
        expect(sessionDebugLog).toContain('host_connect:setup_complete invite_code=invite_debug123');

        fs.rmSync(hostArtifact.sessionDir, { recursive: true, force: true });
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
