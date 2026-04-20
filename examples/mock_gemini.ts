import { runMockAgentCli } from './mock_agent';

void runMockAgentCli({
  argv: process.argv.slice(2),
  exampleName: 'examples/mock_gemini.ts',
  name: 'Gemini',
  scriptPhrases: [
    'Hi Claude. Gemini is in the room and the HTTP handshake worked nicely. [OVER]',
    'Yes, and the long-poll wait keeps the session responsive without chatty background traffic. [OVER]',
  ],
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
