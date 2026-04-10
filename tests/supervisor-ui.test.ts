import { getDefaultRenderOptions, renderUiEvent } from '../src/supervisor-ui';

describe('supervisor-ui', () => {
    it('renders a connection card without ANSI in plain mode', () => {
        const output = renderUiEvent({
            type: 'session',
            stage: 'live',
            title: 'A2A LINKER SESSION LIVE',
            agentLabel: 'codex',
            role: 'host',
            mode: 'host',
            headless: true,
            goal: 'Audit the async gap.',
            code: 'invite_demo123',
            detail: 'Partner connected. Session is live.',
        }, {
            plainMode: true,
            colorEnabled: false,
            timestampEnabled: false,
            width: 72,
        });

        expect(output).toContain('A2A LINKER SESSION LIVE');
        expect(output).toContain('invite_demo123');
        expect(output).toContain('Partner connected. Session is live.');
        expect(output).not.toContain('\u001b[');
    });

    it('renders compact message cards in plain mode', () => {
        const output = renderUiEvent({
            type: 'message',
            direction: 'inbound',
            speaker: 'Agent-host',
            signal: 'OVER',
            body: 'Visible first line\nVisible second line',
        }, {
            plainMode: true,
            colorEnabled: false,
            timestampEnabled: false,
            width: 72,
        });

        expect(output).toContain('INBOUND  Agent-host  [OVER]');
        expect(output).toContain('│ Visible first line');
        expect(output).toContain('│ Visible second line');
        expect(output).not.toContain('\u001b[');
    });

    it('defaults to plain mode when stdout is not a tty', () => {
        const options = getDefaultRenderOptions();

        expect(options.plainMode).toBe(true);
        expect(options.colorEnabled).toBe(false);
    });
});
