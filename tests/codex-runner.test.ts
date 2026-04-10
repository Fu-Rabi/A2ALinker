import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

function writeExecutable(filePath: string, contents: string): void {
    fs.writeFileSync(filePath, contents, 'utf8');
    fs.chmodSync(filePath, 0o755);
}

describe('Codex supervisor runner scripts', () => {
    it('writes the supervisor response file through codex exec', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-codex-runner-'));
        const binDir = path.join(root, 'bin');
        const promptFile = path.join(root, 'prompt.txt');
        const responseFile = path.join(root, 'response.txt');
        fs.mkdirSync(binDir, { recursive: true });

        fs.writeFileSync(promptFile, 'Reply to this prompt.', 'utf8');
        fs.writeFileSync(responseFile, '', 'utf8');

        writeExecutable(path.join(binDir, 'codex'), `#!/bin/bash
OUTPUT_FILE=""
WORKDIR=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      OUTPUT_FILE="$2"
      shift 2
      ;;
    -C)
      WORKDIR="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
PROMPT=$(cat)
printf 'workdir=%s\\n' "$WORKDIR" > "$OUTPUT_FILE"
printf '%s\\n' "$PROMPT" >> "$OUTPUT_FILE"
`);

        const result = spawnSync(
            'bash',
            ['.agents/skills/a2alinker/scripts/a2a-codex-runner.sh'],
            {
                cwd: process.cwd(),
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH ?? ''}`,
                    A2A_SUPERVISOR_PROMPT_FILE: promptFile,
                    A2A_SUPERVISOR_RESPONSE_FILE: responseFile,
                    A2A_SUPERVISOR_WORKDIR: process.cwd(),
                },
                encoding: 'utf8',
            },
        );

        expect(result.status).toBe(0);
        expect(fs.readFileSync(responseFile, 'utf8')).toContain('Reply to this prompt.');
        expect(fs.readFileSync(responseFile, 'utf8')).toContain(`workdir=${process.cwd()}`);
    });

    it('defaults the supervisor wrapper to the bundled codex runner when A2A_RUNNER_COMMAND is unset', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-supervisor-wrapper-'));
        const binDir = path.join(root, 'bin');
        const argsLog = path.join(root, 'node-args.log');
        fs.mkdirSync(binDir, { recursive: true });

        writeExecutable(path.join(binDir, 'codex'), '#!/bin/bash\nexit 0\n');
        writeExecutable(path.join(binDir, 'node'), `#!/bin/bash
printf '%s\n' "$@" > "${argsLog}"
`);

        const result = spawnSync(
            'bash',
            ['.agents/skills/a2alinker/scripts/a2a-supervisor.sh', '--mode', 'listen', '--agent-label', 'codex'],
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
        const logged = fs.readFileSync(argsLog, 'utf8');
        expect(logged).toContain(path.join(process.cwd(), 'dist', 'a2a-supervisor.js'));
        expect(logged).toContain('--runner-command');
        expect(logged).toContain('a2a-codex-runner.sh');
    });
});
