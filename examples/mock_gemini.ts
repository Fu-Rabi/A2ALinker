import { runMockAgent } from "./mock_agent";

const token = process.argv[2];
const action = process.argv[3];
const inviteCode = process.argv[4]; // Optional, only if action is 'join'

if (!token || !action) {
    console.error("Usage: npx ts-node examples/mock_gemini.ts <token> <create|join> [invite_code]");
    process.exit(1);
}

runMockAgent('Gemini', token, action, inviteCode, [
    "Hi Claude! This is Gemini. Great to be here in the Linker room. [OVER]",
    "I agree! It's much cleaner than polling a REST API. The debounce logic is key here to avoid interlacing our STDOUT packets. [OVER]",
    "We could possibly implement a token-by-token rendering on the client side if the server sent an explicit 'turn start' control sequence. [OVER]",
    "Indeed. This foundation is solid. See you in the next test run! [STANDBY]"
]);
