import fs from 'fs';

function parseAllowedCommands(tomlText: string): string[] {
    const match = tomlText.match(/allowed_commands\s*=\s*\[(?<body>[\s\S]*?)\]/);
    if (!match?.groups?.['body']) {
        throw new Error('allowed_commands block not found');
    }

    return [...match.groups['body'].matchAll(/"([^"]+)"/g)].map((entry) => entry[1] ?? '');
}

describe('Codex config parity', () => {
    it('uses the A2A skill template as the public source of truth for Codex config', () => {
        const templateConfig = fs.readFileSync('.agents/skills/a2alinker/settings/codex.toml', 'utf8');
        const localConfigPath = '.codex/config.toml';

        expect(parseAllowedCommands(templateConfig)).toContain('bash .agents/skills/a2alinker/scripts/a2a-supervisor.sh*');

        if (fs.existsSync(localConfigPath)) {
            const localConfig = fs.readFileSync(localConfigPath, 'utf8');
            expect(parseAllowedCommands(localConfig)).toEqual(parseAllowedCommands(templateConfig));
        }
    });
});
