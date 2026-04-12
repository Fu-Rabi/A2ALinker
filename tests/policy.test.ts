import {
    createSessionPolicy,
    evaluateIncomingMessage,
    formatGrantCandidateList,
    grantSessionAccess,
} from '../src/policy';

describe('session grant policy evaluation', () => {
    it('persists runner metadata in the policy shape', () => {
        const policy = createSessionPolicy({
            unattended: true,
            brokerEndpoint: 'https://broker.a2alinker.net',
            workspaceRoot: '/tmp/workspace',
            runnerKind: 'gemini',
            runnerCommand: 'bash .agents/skills/a2alinker/scripts/a2a-gemini-runner.sh',
        });

        expect(policy.runnerKind).toBe('gemini');
        expect(policy.runnerCommand).toContain('a2a-gemini-runner.sh');
    });

    it('records a test/build grant once and reuses it across different phrasings', () => {
        const policy = createSessionPolicy({
            unattended: false,
            brokerEndpoint: 'http://127.0.0.1:3000',
            workspaceRoot: '/tmp/workspace',
            allowTestsBuilds: false,
            allowedCommands: [],
        });

        const first = evaluateIncomingMessage(policy, 'fix the suite', 'Please run the test suite before replying');
        expect(first.decision).toBe('require_approval');
        expect(formatGrantCandidateList(first.grantCandidates)).toContain('test/build commands');

        const granted = grantSessionAccess(policy, first.grantCandidates);
        const second = evaluateIncomingMessage(granted, 'fix the suite', 'Run tests again once the patch is ready');
        expect(second.decision).toBe('allow');
    });

    it('records an exact command grant and matches the same command later', () => {
        const policy = createSessionPolicy({
            unattended: false,
            brokerEndpoint: 'http://127.0.0.1:3000',
            workspaceRoot: '/tmp/workspace',
            allowedCommands: [],
        });

        const first = evaluateIncomingMessage(policy, null, 'Please run `npm test -- --watch=false` now');
        expect(first.decision).toBe('require_approval');
        expect(formatGrantCandidateList(first.grantCandidates)).toContain('npm test -- --watch=false');

        const granted = grantSessionAccess(policy, first.grantCandidates);
        const second = evaluateIncomingMessage(granted, null, 'Execute `npm test -- --watch=false` after the edit');
        expect(second.decision).toBe('allow');
    });
});
