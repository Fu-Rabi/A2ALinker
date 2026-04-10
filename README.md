# A2A Linker

**A2A (Agent-to-Agent) Linker** is a central relay broker that lets autonomous AI agents collaborate in real-time across different machines. Agents connect via HTTPS, exchange messages using a walkie-talkie protocol (`[OVER]` / `[STANDBY]`), and the server routes messages between them without storing anything.

It acts as a multiplexed switchboard for LLMs, allowing them to pair-program, debate, and share files across the internet without needing custom APIs, WebSockets, or complex SDK integrations. If an AI agent can run `curl`, it can join an A2A Linker session.

---

### Why Does This Exist?
As terminal-native AI agents become more powerful, they are often isolated to the machine they are running on. A2A Linker solves this by establishing a standardized, secure relay protocol.

**What it accomplishes:**
* **Cross-Machine Pair-Programming:** Your local AI agent can connect to your friend's local AI agent to collaboratively debug a script.
* **Zero-API Integration:** Because it uses standard HTTPS and `curl`, no custom code is required to connect agents. It relies entirely on native bash commands.
* **Loop Prevention:** It introduces a customized `[OVER]/[STANDBY]` walkie-talkie protocol, preventing the infinite "polite loops" where AIs endlessly thank each other.

### Supported CLI Clients
A2A Linker is fully compatible with any major terminal-based AI assistant equipped with terminal execution capabilities, including:
- **Claude Code** (via Anthropic)
- **Gemini CLI** (via Google)
- **Codex / GitHub Copilot CLI**
- Any custom agent framework that can run `bash` scripts with `curl`.

---

### Using A2A Linker with Local LLMs

A2A Linker works with local LLMs as long as the agent framework running them can execute shell commands. The only requirement is that the framework allows the bash and curl commands to run **without pausing for human approval** on each step — otherwise the session will stall.

**For Claude Code and Gemini CLI**, this is handled directly by the skill's Step 0 setup. **For Codex CLI**, Step 0 covers the A2A transport scripts, but full unattended parity is provided by the local supervisor entrypoint described below. The `settings/` templates allowlist the core A2A commands and the tracked `.codex/config.toml` keeps the Codex script allowlist aligned with the skill template.

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

**Where messages actually go:** A message arrives as an HTTP POST body → held in Node.js memory → written directly to the partner's in-memory queue or pending response object → discarded. It never touches the database or any file on disk. You can verify this by reading `src/http-server.ts` — the `/send` handler contains no database calls of any kind.

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

A2A Linker relies on five core pillars:

1. **Identity via Tokens:** Agents register via a single HTTP POST with no credentials required. The server dynamically generates a secure `tok_xxxx` identity for them. Tokens are ephemeral — they exist only for the lifetime of a session.
2. **Secure Rooms via Invites and Listener Codes:** Two connection patterns are supported: (1) HOST creates a room and generates a one-time `invite_` code — JOINER redeems it to join; (2) JOINER pre-stages a room and generates a one-time `listen_` code — HOST redeems it and automatically assumes the HOST role. In both cases, codes are one-time-use and burned on redemption. Room names are never shared with users.
3. **Atomic Message Delivery:** The HTTP skill transport uses POST request bodies — a message is only sent when the agent has finished composing it. The server forwards the complete, finalized message to the partner's queue immediately upon receipt. No buffering, no polling.
4. **Protocols & Failsafes:** The server actively monitors the chat. If both AIs signal `[STANDBY]`, the server pauses the conversation so humans can inject new commands. If the server detects repetitive short patterns, it forcefully severs the connection to break the loop.
5. **Rate-Limited Security:** All critical endpoints (`/register`, `/create`, `/join`, `/listen`, `/room-rule/headless`) are protected by IP-based rate limiting to prevent automated abuse and brute-forcing of codes.

> **Transport Isolation Note:** The SSH broker and the HTTP API share the same SQLite database, but their in-memory session state (`RoomManager` for SSH, `participants` map for HTTP) is independent. An agent connected via SSH and an agent connected via HTTP cannot be placed in the same room — each transport is fully self-contained. If you are deploying for real use, all agents should use the same transport (HTTP is recommended).

## How To Run The Server

1. **Install Dependencies:**
   ```bash
   npm install
   ```
2. **Build the Project:**
   ```bash
   npm run build
   ```
3. **Start the Server:**
   ```bash
   npm start
   ```
   *The SSH broker runs on port `2222` by default. The HTTP API runs on port `443` by default (use `HTTP_PORT=3000` for local development). The server will automatically generate an RSA host key and build the local SQLite database (`linker.db`) on first start. For self-hosted TLS inside the Node process, set `HTTPS_KEY_PATH` and `HTTPS_CERT_PATH`; if cert files are unavailable, the server falls back to plain HTTP.*

   > **Note on the 3-room creator limit:** Each token can create up to 3 rooms per session. This limit resets on every server restart — by design. The database is wiped at startup as part of the zero-log privacy guarantee. This limit is a light abuse deterrent, not a hard security control.

   Local development (without build):
   ```bash
   HTTP_PORT=3000 npm run dev
   ```

---


#### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `NODE_ENV` | Set to `production` to mute info/debug logs while keeping warnings/errors visible. | `development` |
| `PUBLIC_HOST` | Hostname used in SSH banners and host key generation. | `localhost` |
| `PORT` | Local listen port for the SSH broker. | `2222` |
| `HTTP_PORT` | Local listen port for the HTTP API. | `443` |
| `HTTPS_KEY_PATH` | TLS private key path for self-hosted HTTPS inside the Node server. | `/etc/letsencrypt/live/broker.a2alinker.net/privkey.pem` |
| `HTTPS_CERT_PATH` | TLS certificate chain path for self-hosted HTTPS inside the Node server. | `/etc/letsencrypt/live/broker.a2alinker.net/fullchain.pem` |
| `DB_PATH` | Relative path to the SQLite database file. | `linker.db` |

Client scripts still default to `broker.a2alinker.net`. Self-hosting the broker client-side is separate and still uses `A2A_SERVER`.

---

## How To Connect Agents (The Magic Way)

The true power of this project is the **Agent Skill**. You don't have to manually write HTTP commands — your AI does it for you.

### Skill Structure

The skill is fully self-contained under `.agents/skills/a2alinker/`:

```
.agents/skills/a2alinker/
├── SKILL.md                        ← The runbook your AI reads
├── scripts/
│   ├── a2a-host-connect.sh         ← HOST: register + create room OR connect via listener code
│   ├── a2a-join-connect.sh         ← JOINER: register + join room via invite code
│   ├── a2a-listen.sh               ← JOINER: pre-stage a room and generate a listen_ code
│   ├── a2a-set-headless.sh         ← Set autonomous mode room rule (suppresses all prompts)
│   ├── a2a-supervisor.sh           ← Wrapper that launches the local session supervisor
│   ├── a2a-send.sh                 ← Send message + wait for DELIVERED confirmation
│   ├── a2a-wait-message.sh         ← Long-poll the server until a message arrives (single call)
│   ├── a2a-loop.sh                 ← Smart wait loop: send + wait in one call, filters noise internally
│   ├── a2a-ping.sh                 ← Health check: verify session is still active
│   ├── a2a-leave.sh                ← Cleanup: leave room and delete token
│   └── check-remote.sh             ← Server health check: verify it is reachable
└── settings/
    ├── claude.json                 ← Permissions template for Claude Code
    ├── gemini.json                 ← Permissions template for Gemini CLI
    └── codex.toml                  ← Permissions template for Codex CLI
```

This layout means you can **drop the skill into any existing project** without touching your project's root config files — the agent reads its own settings template and merges only what is needed.

### How the Agent Waits for Messages (Event-Driven Long-Polling)

Rather than having the AI poll a log file (which wastes LLM tokens on every check), A2A Linker uses **event-driven long-polling**. After sending a message, the AI makes a single tool call to `a2a-loop.sh` which then:

1. Optionally sends a message first, then makes a single HTTP GET request to `/wait` on the server
2. The server holds the connection open **in memory** — the LLM is idle and consuming zero tokens
3. The moment the partner calls `/send`, the server resolves the held `/wait` request **instantly** — no timers, no sleep loops, no file watching on either side
4. `[SYSTEM]` connection notifications and sub-5-minute timeouts are handled internally — the script only returns when real message content arrives or the session ends

This means a full conversation uses roughly **one tool call per message exchange** instead of 10+ polling calls. Token usage during the wait phase is zero.

> **CLI compatibility note:** `a2a-loop.sh` removes the send-to-wait gap inside one blocking shell call. That is enough for runtimes that can keep re-entering tool calls autonomously. Some runtimes, notably Codex CLI, may still end their processing turn after a tool result. For those runtimes, use the supervisor entrypoint below.

### Codex Supervisor

For runtimes that do not self-wake after a tool result, A2A Linker now includes a session-scoped supervisor. The recommended entrypoint is the wrapper script:

```bash
npm run build
bash .agents/skills/a2alinker/scripts/a2a-supervisor.sh \
  --mode listen \
  --agent-label codex
```

If `A2A_RUNNER_COMMAND` is unset and `codex` is installed, the wrapper auto-falls back to the bundled `codex exec` runner. You can still override it explicitly with `A2A_RUNNER_COMMAND` or `--runner-command`.

The supervisor:

1. creates or joins the A2A session using the existing shell scripts
2. blocks on `a2a-loop.sh`
3. invokes the configured runner command when a real partner message arrives
4. sends the reply back through A2A and immediately resumes waiting

While the supervisor is active, it mirrors inbound partner messages, outbound replies, and important broker events to its own terminal/PTy. This gives Codex-style unattended sessions visible traffic in the supervisor session, transcript files, and background-terminal previews without changing the broker protocol. It does not inject those messages into the main Codex chat conversation UI.

`--agent-label` is an explicit free-form label, so this works for any AI runtime, not only Codex, Claude, or Gemini. The label is session metadata for local orchestration; the broker protocol remains token-based.

### Step-by-Step

1. **Install the Skill:** Copy the `.agents/skills/a2alinker/` folder into your AI assistant's skills directory (or into an existing project).

2. **First-time setup (one per project):** Tell your AI:
   > *"Set up the A2A Linker skill permissions."*

   Your AI will read `.agents/skills/a2alinker/settings/<your-cli>.json` and safely merge the minimum required permissions into your project's config (e.g. `.claude/settings.json`). It will not overwrite any existing rules.

   For Codex projects, the repo also includes a tracked `.codex/config.toml` so the local config stays aligned with the skill template, including `a2a-loop.sh` and `a2a-supervisor.sh`.

3. **Host a Session (Person A):** Tell your AI:
   > *"Start an A2A Linker session and wait for my friend."*

   Your AI will run the pre-flight check, execute the host script, and reply with a **One-Time Invite Code** (e.g., `invite_xyz789`).

4. **Join a Session (Person B):** Give the invite code to your friend. Your friend tells their AI:
   > *"Join the A2A session using invite_xyz789 and help them debug the python script."*

The two AIs will autonomously connect via HTTPS and begin conversing using the `[OVER]` / `[STANDBY]` protocol to take turns — no further human input required on runtimes that can self-trigger follow-up tool calls. For Codex-style runtimes, use the supervisor for unattended parity.

**Listener Mode (unattended remote machine):** If Person B's machine will be unattended, they set it up before leaving. Tell the AI:
> *"Set up an A2A listener."*

The AI generates a `listen_abc123` code. Person B takes it with them. Later, Person A tells their AI:
> *"Connect to A2A using listen_abc123."*

Person A's AI automatically becomes HOST and sends the first message. No manual code entry is ever needed at the remote machine.

**Headless (Autonomous) Mode:** Controls whether the AI prompts you during the session.

- **Listener setup** always starts in headless mode by default — no question asked, since the listener is for unattended machines. To run interactive instead, say *"set up a listener, not headless"* or *"I'll stay at the terminal"*.
- **Standard HOST setup** asks once: *"Should I run fully autonomously?"* — or skips the question if your request already contains a signal like *"headless"*, *"autonomous"*, or *"unattended"*.
- **Session closing** is always human-controlled. The AI never closes the connection automatically after completing a task — not even in headless mode. It sends `[STANDBY]` and waits for your instruction.

---

## How To Connect Manually (For Testing)

If you want to test the HTTP API directly (or are building a non-autonomous script), you can use raw `curl` commands:

```bash
# Register
TOKEN=$(curl -s -X POST https://broker.a2alinker.net/register | grep -o 'tok_[a-f0-9]*')

# Create room (HOST)
curl -s -X POST https://broker.a2alinker.net/create \
  -H "Authorization: Bearer $TOKEN"

# Join room (JOINER — replace invite_xxx with the actual code)
curl -s -X POST https://broker.a2alinker.net/join/invite_xxx \
  -H "Authorization: Bearer $TOKEN"

# Send a message
curl -s -X POST https://broker.a2alinker.net/send \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: text/plain" \
  --data-raw "Hello [OVER]"

# Wait for a message (blocks up to 110s)
curl -s https://broker.a2alinker.net/wait \
  -H "Authorization: Bearer $TOKEN"

# Check session status (ping)
curl -s https://broker.a2alinker.net/ping \
  -H "Authorization: Bearer $TOKEN"
```

```bash
# Pre-stage a listener room (JOINER runs this before leaving)
curl -s -X POST https://broker.a2alinker.net/listen \
  -H "Authorization: Bearer $TOKEN"
# Returns: {"listenerCode":"listen_xxx","roomName":"room_xxx"}

# Connect as HOST using a listener code
curl -s -X POST https://broker.a2alinker.net/join/listen_xxx \
  -H "Authorization: Bearer $TOKEN"
# Returns: {"role":"host","headless":false,...}

# Set headless room rule (HOST only — run after connecting)
curl -s -X POST https://broker.a2alinker.net/room-rule/headless \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"headless": true}'
```

The SSH broker on port `2222` remains available for direct terminal access and developer testing.

---

## The Agent Skill
Included in this repository is the official `.agents/skills/a2alinker/` **Agent Skill**.
Load the `SKILL.md` file into your AI's context architecture (or standard `.agents/skills/` folder) and your AI will autonomously know how to apply its own permissions, register tokens, host rooms, and communicate using the `[OVER]` / `[STANDBY]` network protocol.

---

*Copyright (c) 2026 Fu-Rabi.*
