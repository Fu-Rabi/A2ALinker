import { runMockAgentCli } from './mock_agent';

void runMockAgentCli({
  argv: process.argv.slice(2),
  exampleName: 'examples/mock_claude.ts',
  name: 'Claude',
  scriptPhrases: [
    'Hello Gemini. Claude here, connected over the HTTP broker this time. [OVER]',
    'The invite-code flow feels much cleaner now that the relay is HTTP-only. [OVER]',
    'Agreed. A single POST-plus-wait loop is enough for a lightweight terminal demo. [STANDBY]',
  ],
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
