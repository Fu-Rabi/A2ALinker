import fs from 'fs';

function parseAllowedCommands(tomlText: string): string[] {
    const match = tomlText.match(/allowed_commands\s*=\s*\[(?<body>[\s\S]*?)\]/);
    if (!match?.groups?.['body']) {
        throw new Error('allowed_commands block not found');
    }

    return [...match.groups['body'].matchAll(/"([^"]+)"/g)].map((entry) => entry[1] ?? '');
}

describe('A2A skill permission templates', () => {
    it('keeps the Codex template minimal and exact-match only', () => {
        const templateConfig = fs.readFileSync('.agents/skills/a2alinker/settings/codex.toml', 'utf8');
        const commands = parseAllowedCommands(templateConfig);

        expect(templateConfig).not.toContain('approval_policy = "full-auto"');
        expect(commands).toContain('bash .agents/skills/a2alinker/scripts/a2a-supervisor.sh');
        expect(commands).not.toContain('bash .agents/skills/a2alinker/scripts/a2a-leave.sh');
        expect(commands.some((entry) => entry.includes('*'))).toBe(false);
        expect(commands).not.toContain('echo * >> ~/.a2a_headless.log');
        expect(commands).not.toContain('rm /tmp/a2a_*');
    });

    it('keeps the Claude and Gemini templates free of broad shell and file wildcards', () => {
        const claudeTemplate = fs.readFileSync('.agents/skills/a2alinker/settings/claude.json', 'utf8');
        const geminiTemplate = fs.readFileSync('.agents/skills/a2alinker/settings/gemini.json', 'utf8');

        expect(claudeTemplate).not.toContain('FileSystemWrite(path:*)');
        expect(claudeTemplate).not.toContain('WebFetch(domain:*)');
        expect(claudeTemplate).not.toContain('echo *');
        expect(claudeTemplate).not.toContain('a2a-leave.sh');
        expect(geminiTemplate).not.toContain('write_file(*)');
        expect(geminiTemplate).not.toContain('curl https://*');
        expect(geminiTemplate).not.toContain('echo *');
        expect(geminiTemplate).not.toContain('a2a-leave.sh');
    });

    it('ships a packaged runtime that includes policy enforcement and safe listener defaults', () => {
        const packagedSupervisor = fs.readFileSync('.agents/skills/a2alinker/runtime/supervisor.js', 'utf8');
        const packagedPolicy = fs.readFileSync('.agents/skills/a2alinker/runtime/policy.js', 'utf8');
        const wrapperScript = fs.readFileSync('.agents/skills/a2alinker/scripts/a2a-supervisor.sh', 'utf8');

        expect(packagedSupervisor).toContain('./policy');
        expect(packagedSupervisor).toContain('headless: options.headless ?? false');
        expect(packagedPolicy).toContain('allowRemoteTriggerWithinScope');
        expect(wrapperScript).toContain('A2A broker target [local/remote]');
        expect(wrapperScript).toContain('Defaulting to local/self-hosted http://127.0.0.1:3000');
    });
});
