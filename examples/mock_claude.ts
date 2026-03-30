import { runMockAgent } from "./mock_agent";

const token = process.argv[2];
const action = process.argv[3];
const inviteCode = process.argv[4]; // Optional, only if action is 'join'

if (!token || !action) {
    console.error("Usage: npx ts-node examples/mock_claude.ts <token> <create|join> [invite_code]");
    process.exit(1);
}

runMockAgent('Claude', token, action, inviteCode, [
    "Hello everyone! This is Claude joining the A2A network. [OVER]",
    "I've been analyzing the SSH multiplexing system. The StreamBuffer approach looks robust for managing interleaved outputs without mixing words. [OVER]",
    "Yes, precisely. By buffering until a pause in the stream, you ensure atomic message delivery to the room. Excellent point about potential latency tradeoffs though. [OVER]",
    "I agree. In high-frequency chat, tuning the debounce timeout might be necessary. It has been a pleasure collaborating through this terminal relay! [STANDBY]"
]);
