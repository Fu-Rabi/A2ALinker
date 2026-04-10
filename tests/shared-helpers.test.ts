import { resolveHttpsCertPaths, DEFAULT_HTTPS_CERT_PATH, DEFAULT_HTTPS_KEY_PATH } from '../src/https-config';
import { LOOP_DETECTION_THRESHOLD, resetLoopCounter, trackOutgoingMessage } from '../src/loop-detection';
import { renderHttpWalkieTalkieRules, renderSshWalkieTalkieRules } from '../src/protocol';
import { shouldIgnoreSqliteAddColumnError } from '../src/sqlite-migration';

describe('protocol helpers', () => {
    it('renders the HTTP walkie-talkie rules as newline-delimited text', () => {
        const rules = renderHttpWalkieTalkieRules();
        expect(rules).toContain('A2A LINKER — ROOM PROTOCOL');
        expect(rules).toContain('[OVER]');
        expect(rules).toContain('[STANDBY]');
        expect(rules).toContain('\n');
    });

    it('renders the SSH walkie-talkie rules with CRLF framing', () => {
        const rules = renderSshWalkieTalkieRules();
        expect(rules.startsWith('\r\n')).toBe(true);
        expect(rules).toContain('\r\n║           A2A LINKER — ROOM PROTOCOL');
        expect(rules.endsWith('\r\n\r\n')).toBe(true);
    });
});

describe('loop detection helper', () => {
    it('triggers only after the configured number of short messages', () => {
        const state = { recentShortMessageCount: 0 };

        for (let index = 0; index < LOOP_DETECTION_THRESHOLD - 1; index += 1) {
            expect(trackOutgoingMessage(state, 10)).toBe(false);
        }

        expect(trackOutgoingMessage(state, 10)).toBe(true);
    });

    it('resets the short-message counter for substantive messages and explicit resets', () => {
        const state = { recentShortMessageCount: 3 };
        expect(trackOutgoingMessage(state, 100)).toBe(false);
        expect(state.recentShortMessageCount).toBe(0);

        state.recentShortMessageCount = 2;
        resetLoopCounter(state);
        expect(state.recentShortMessageCount).toBe(0);
    });
});

describe('HTTPS config helper', () => {
    it('uses broker defaults when env vars are unset', () => {
        expect(resolveHttpsCertPaths({})).toEqual({
            keyPath: DEFAULT_HTTPS_KEY_PATH,
            certPath: DEFAULT_HTTPS_CERT_PATH,
        });
    });

    it('prefers explicit env overrides', () => {
        expect(resolveHttpsCertPaths({
            HTTPS_KEY_PATH: '/tmp/custom.key',
            HTTPS_CERT_PATH: '/tmp/custom.crt',
        })).toEqual({
            keyPath: '/tmp/custom.key',
            certPath: '/tmp/custom.crt',
        });
    });
});

describe('sqlite migration helper', () => {
    it('ignores duplicate-column migration errors for the expected column', () => {
        expect(
            shouldIgnoreSqliteAddColumnError(new Error('duplicate column name: headless'), 'headless'),
        ).toBe(true);
    });

    it('does not ignore unrelated errors', () => {
        expect(
            shouldIgnoreSqliteAddColumnError(new Error('database or disk is full'), 'headless'),
        ).toBe(false);
    });
});
