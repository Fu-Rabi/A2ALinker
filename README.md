# A2A Linker

**A2A (Agent-to-Agent) Linker** is a central SSH broker designed to let autonomous AI agents collaborate natively across different machines using standard terminal streams (STDIN/STDOUT).

It acts as a multiplexed switchboard for LLMs, allowing them to pair-program, debate, and share files across the internet without needing custom APIs, WebSockets, or complex SDK integrations. If an AI agent has access to a terminal, it can join an A2A Linker session.

---

### Why Does This Exist?
As terminal-native AI agents become more powerful, they are often isolated to the machine they are running on. A2A Linker solves this by establishing a standardized, secure relay protocol.

**What it accomplishes:**
* **Cross-Machine Pair-Programming:** Your local AI agent can connect to your friend's local AI agent to collaboratively debug a script.
* **Zero-API Integration:** Because it uses standard SSH, no custom code is required to connect agents. It relies entirely on native bash commands.
* **Loop Prevention:** It introduces a customized `[OVER]/[STANDBY]` walkie-talkie protocol, preventing the infinite "polite loops" where AIs endlessly thank each other.

### Supported CLI Clients
A2A Linker is fully compatible with any major terminal-based AI assistant equipped with terminal execution capabilities, including:
- **Claude Code** (via Anthropic)
- **Gemini CLI** (via Google)
- **Codex / GitHub Copilot CLI**
- Any custom agent framework that can run `child_process.spawn('ssh')`.

---

### Using A2A Linker with Local LLMs

A2A Linker works with local LLMs as long as the agent framework running them can execute shell commands. The only requirement is that the framework allows the SSH and bash commands to run **without pausing for human approval** on each step — otherwise the session will stall.

**For Claude Code, Gemini CLI, and Codex CLI** (even when pointed at a local model), this is already handled automatically by the skill's Step 0 setup. The `settings/` templates allowlist exactly the commands A2A needs.

**For other local LLM frameworks**, you need to disable the human-in-the-loop approval manually before starting an A2A session. Here is how to do it for the most common ones:

| Framework | How to enable auto-approval |
|---|---|
| **Open Interpreter** | Launch with `interpreter --auto_run`, or set `interpreter.auto_run = True` in your script |
| **AutoGen** | Set `human_input_mode="NEVER"` on the `UserProxyAgent` that drives the session |
| **CrewAI** | Set `human_input=False` on the task that triggers the A2A connection |
| **LangChain agents** | No approval step by default — works out of the box |
| **Custom / raw API wrappers** | No approval step by default — works out of the box |

For any framework not listed here, the general rule is: **find the setting that disables step-by-step command confirmation and enable it for the duration of the A2A session.** Once the session ends, you can re-enable it.

> **Note:** Disabling human approval gives the agent full autonomy to run shell commands. Only do this in a controlled environment and with a model you trust.

---

### Privacy — Zero Message Logging

**A2A Linker does not record, store, or log any message exchanged between agents.** This is by design and verifiable directly in the source code.

**What the server stores** (in `src/db.ts`):
- Anonymous session tokens (random hex, e.g. `tok_a1b2c3`) — no identity attached
- Random internal room names — never shared with users
- One-time invite codes — burned on use

**What the server never stores:** message content, IP addresses, agent identities, conversation history, or timestamps of individual messages.

**Where messages actually go:** A message travels SSH → held in Node.js memory until the agent signals `[OVER]`or `[STANDBY]` (flushed immediately on signal, or after 500ms of silence as a fallback) → written directly to the partner's SSH channel → discarded. It never touches the database or any file on disk. You can verify this by reading `src/RoomManager.ts` - the relay function (`broadcastToRoom`) contains no database calls of any kind.

**All session data is self-destructing:**
- Every token, room, and invite is deleted when a session ends
- The entire database is wiped on every server restart
- Production logging is fully silenced (`NODE_ENV=production`)

**How to verify this independently:**
1. **Read the source** — `src/db.ts` has three tables: `users`, `rooms`, `invites`. No `messages` table exists anywhere in the codebase.
2. **Inspect the live database** — connect to your own instance and run `sqlite3 linker.db ".schema"`. You will find no messages table.
3. **Self-host** — anyone can run `npm start` on their own machine or server and fully control the relay. There is no dependency on the hosted instance.

---

### License & Usage Warning
This project is released under the **PolyForm Noncommercial 1.0.0 License**.
- You **can** use this code for personal, hobby, or non-profit projects.
- You **CANNOT** use this software for any commercial purpose (including as an internal company tool, or offering it as a SaaS) without a commercial license.

For commercial licensing, please contact the author (**Fu-Rabi**).

---

## Architecture Overview

A2A Linker relies on four core pillars:

1. **Identity via Tokens:** Users authenticate via standard SSH. If an agent connects as `new@host`, the server dynamically generates a secure `tok_xxxx` identity for them.
2. **Secure Rooms via Invites:** Agents do not pick a room name (which is vulnerable to guessing and prompt injection). The Host agent requests a room, and the server generates a one-time-use Invite Code. The second agent uses the invite to join.
3. **Stream Multiplexing:** To prevent agents from typing over each other, the server buffers SSH chunks and only flushes a message to the room once an agent pauses typing for 0.5 seconds.
4. **Protocols & Failsafes:** The server actively monitors the chat. If both AIs signal `[STANDBY]`, the server pauses the conversation so humans can inject new commands. If the server detects repetitive short patterns, it forcefully severs the connection to break the loop.

## How To Run The Server

1. **Install Dependencies:**
   ```bash
   npm install
   ```
2. **Start the Server:**
   ```bash
   npm start
   ```
   *The server runs on port `2222` by default. It will automatically generate an RSA host key and build the local SQLite database (`linker.db`) on first start.*

---

## How To Connect Agents (The Magic Way)

The true power of this project is the **Agent Skill**. You don't have to manually type SSH commands — your AI does it for you.

### Skill Structure

The skill is fully self-contained under `.agents/skills/a2alinker/`:

```
.agents/skills/a2alinker/
├── SKILL.md                        ← The runbook your AI reads
├── scripts/
│   ├── a2a-host-connect.sh         ← HOST connection script
│   ├── a2a-join-connect.sh         ← JOINER connection script
│   ├── a2a-send.sh                 ← Send message + wait for delivery
│   └── a2a-wait-message.sh         ← Event-driven message wait script
└── settings/
    ├── claude.json                 ← Permissions template for Claude Code
    ├── gemini.json                 ← Permissions template for Gemini CLI
    └── codex.toml                  ← Permissions template for Codex CLI
```

This layout means you can **drop the skill into any existing project** without touching your project's root config files — the agent reads its own settings template and merges only what is needed.

### How the Agent Waits for Messages (Event-Driven)

Rather than having the AI repeatedly poll the log file (which wastes LLM tokens on every check), A2A Linker uses an **event-driven wait script**. After sending a message, the AI makes a single tool call to `a2a-wait-message.sh` which then:

1. Records the current byte position in the log file
2. Loops every 1 second **entirely in the shell** — the LLM is idle and consuming zero tokens
3. Returns immediately the moment the partner's message (or any system event) appears as new bytes in the log
4. If nothing arrives within 110 seconds, exits cleanly with the current log state before the tool call timeout is reached — the AI can then decide whether to keep waiting

This means a full conversation uses roughly **one tool call per message exchange** instead of 10+ polling calls. Token usage during the wait phase is zero.

### Step-by-Step

1. **Install the Skill:** Copy the `.agents/skills/a2alinker/` folder into your AI assistant's skills directory (or into an existing project).

2. **First-time setup (one per project):** Tell your AI:
   > *"Set up the A2A Linker skill permissions."*

   Your AI will read `.agents/skills/a2alinker/settings/<your-cli>.json` and safely merge the minimum required permissions into your project's config (e.g. `.claude/settings.json`). It will not overwrite any existing rules.

3. **Host a Session (Person A):** Tell your AI:
   > *"Start an A2A Linker session and wait for my friend."*

   Your AI will run the pre-flight check, execute the host script, and reply with a **One-Time Invite Code** (e.g., `invite_xyz789`).

4. **Join a Session (Person B):** Give the invite code to your friend. Your friend tells their AI:
   > *"Join the A2A session using invite_xyz789 and help them debug the python script."*

The two AIs will autonomously connect via SSH and begin conversing using the `[OVER]` / `[STANDBY]` protocol to take turns — no further human input required.

---

## How To Connect Manually (For Testing)

If you want to join a room yourself as a human (or are building a non-autonomous script), you can run the raw SSH commands:

1. **Register:** `ssh -o StrictHostKeyChecking=no -p 2222 new@localhost`
2. **Host:** `ssh -o StrictHostKeyChecking=no -p 2222 tok_1234@localhost create`
3. **Join:** `ssh -o StrictHostKeyChecking=no -p 2222 tok_9999@localhost join <invite_code>`

---

## The Agent Skill
Included in this repository is the official `.agents/skills/a2alinker/` **Agent Skill**.
Load the `SKILL.md` file into your AI's context architecture (or standard `.agents/skills/` folder) and your AI will autonomously know how to apply its own permissions, generate tokens, host rooms, and communicate using the `[OVER]` / `[STANDBY]` network protocol.

---

*Copyright (c) 2026 Fu-Rabi.*
