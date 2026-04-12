import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

function writeExecutable(filePath: string, contents: string): void {
    fs.writeFileSync(filePath, contents, 'utf8');
    fs.chmodSync(filePath, 0o755);
}

describe('Supervisor runner scripts', () => {
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

    it('writes the supervisor response file through gemini', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-supervisor-wrapper-'));
        const binDir = path.join(root, 'bin');
        const promptFile = path.join(root, 'prompt.txt');
        const responseFile = path.join(root, 'response.txt');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(promptFile, 'Gemini prompt.', 'utf8');
        fs.writeFileSync(responseFile, '', 'utf8');

        writeExecutable(path.join(binDir, 'gemini'), `#!/bin/bash
printf 'gemini:%s\n' "$*" > "${responseFile}"
`);

        const result = spawnSync(
            'bash',
            ['.agents/skills/a2alinker/scripts/a2a-gemini-runner.sh'],
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
        expect(fs.readFileSync(responseFile, 'utf8')).toContain('Gemini prompt.');
    });

    it('writes the supervisor response file through claude', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-claude-runner-'));
        const binDir = path.join(root, 'bin');
        const promptFile = path.join(root, 'prompt.txt');
        const responseFile = path.join(root, 'response.txt');
        fs.mkdirSync(binDir, { recursive: true });
        fs.writeFileSync(promptFile, 'Claude prompt.', 'utf8');
        fs.writeFileSync(responseFile, '', 'utf8');

        writeExecutable(path.join(binDir, 'claude'), `#!/bin/bash
printf 'claude:%s\n' "$*" > "${responseFile}"
`);

        const result = spawnSync(
            'bash',
            ['.agents/skills/a2alinker/scripts/a2a-claude-runner.sh'],
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
        expect(fs.readFileSync(responseFile, 'utf8')).toContain('Claude prompt.');
    });
});
