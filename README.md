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

A2A Linker works best when the local runtime can approve a narrow transport envelope without granting broad autonomy. The included skill and settings templates now favor **minimal exact command approvals**, **local-first brokers**, and **session policy artifacts** over blanket auto-approval.

*If you are looking for instructions on how to connect your local offline LLM (like Ollama), see the **[Quickstart: Ollama Template](#quickstart-ollama-template)** section below.*

For unattended listener mode, the local machine must be prepared in advance by the human. The supervisor writes a visible policy artifact such as `.a2a-listener-policy.json` and only allows remote-triggered work inside that local policy envelope.

During interactive sessions, the supervisor can also learn narrow **session grants** after a local approval. Those grants are stored in the visible policy artifact and let later equivalent requests auto-pass for the remainder of the session without broadening forbidden capabilities.

---

### The Free Public Broker (`broker.a2alinker.net`)

For remote connections, users can use the creator-hosted server at **`https://broker.a2alinker.net`** completely for free. 

### Privacy — Zero Message Logging

Whether you use the free public server or self-host your own instance: **A2A Linker does not record, store, or log any message exchanged between agents.** 

As can be confirmed directly by reading the open-source server code in this repo, the `broker.a2alinker.net` server operates with absolute privacy: **no IP addresses are logged, no chat history is stored, and totally no user information is tracked whatsoever.**

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
4. **Protocols & Failsafes:** The server actively monitors the chat. If both AIs signal `[STANDBY]`, the server pauses the conversation so humans can inject new commands while keeping the session open. If the server detects repetitive short patterns, it forcefully severs the connection to break the loop.
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

Client scripts default to local/self-hosted transport (`A2A_BASE_URL=http://127.0.0.1:3000`). Remote brokers must be configured explicitly with `A2A_BASE_URL` or `A2A_SERVER`.

Session closure is explicit. Agents should not leave just because a task appears complete. The connection stays alive until the HOST closes it, and the HOST should do that only after clear local human instruction.

When the human explicitly instructs the HOST to close the session, use the authorized close form directly:

```bash
A2A_ALLOW_CLOSE=true bash .agents/skills/a2alinker/scripts/a2a-leave.sh host
```

Do not first call `a2a-leave.sh` without authorization and then retry.

Listener-side closure messages are only visible while a waiter is still active. Keep the supervisor running, or keep `a2a-loop.sh join` active, if you want the listener machine to visibly show that the host closed the session.

Listener startup also persists a stable repo-local state file at `.a2a-listener-session.json`. Use:

```bash
bash .agents/skills/a2alinker/scripts/a2a-supervisor.sh --mode listen --status
```

to read the active listener code and state without restarting the listener or probing guessed log files.

Host attach sessions now persist `.a2a-host-session.json`. Use:

```bash
bash .agents/skills/a2alinker/scripts/a2a-supervisor.sh --mode host --status
```

to read local cached host session state after a backgrounded attach attempt. This is local session state, not a live broker-backed truth check.

`--agent-label` is only a display label for the session UI. It is not a settings profile name, and choosing a label should not cause the agent to inspect or create files under `.agents/skills/a2alinker/settings/`.

---

## How To Connect Agents (The Magic Way)

The true power of this project is the **Agent Skill**. You don't have to manually write HTTP commands — your AI does it for you.

### Skill Structure

The skill is fully self-contained under `.agents/skills/a2alinker/`:

```
.agents/skills/a2alinker/
├── SKILL.md                        ← The runbook your AI reads
├── scripts/
│   ├── a2a-claude-runner.sh        ← CLI runner for Claude Code
│   ├── a2a-codex-runner.sh         ← CLI runner for Codex
│   ├── a2a-common.sh               ← Shared environment variables and utility functions
│   ├── a2a-gemini-runner.sh        ← CLI runner for Gemini CLI
│   ├── a2a-host-connect.sh         ← HOST: register + create room OR connect via listener code
│   ├── a2a-join-connect.sh         ← JOINER: register + join room via invite code
│   ├── a2a-leave.sh                ← Cleanup: leave room and delete token
│   ├── a2a-listen.sh               ← JOINER: pre-stage a room and generate a listen_ code
│   ├── a2a-loop.sh                 ← Smart wait loop: send + wait in one call, filters noise internally
│   ├── a2a-ollama-runner.example.sh ← Example CLI runner for local Ollama models
│   ├── a2a-ping.sh                 ← Health check: verify session is still active
│   ├── a2a-send.sh                 ← Send message + wait for DELIVERED confirmation
│   ├── a2a-set-headless.sh         ← Set autonomous mode room rule (suppresses all prompts)
│   ├── a2a-supervisor.sh           ← Wrapper that launches the local session supervisor
│   ├── a2a-wait-message.sh         ← Long-poll the server until a message arrives (single call)
│   └── check-remote.sh             ← Server health check: verify it is reachable
└── settings/
    ├── claude.json                 ← Permissions template for Claude Code
    ├── codex.toml                  ← Permissions template for Codex CLI
    └── gemini.json                 ← Permissions template for Gemini CLI
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

### The A2A Supervisor & Unattended Mode

For runtimes that do not self-wake after a tool result, or when you want to run a completely unattended local agent, A2A Linker includes a session-scoped supervisor. The recommended entrypoint is the wrapper script:

```bash
npm run build
bash .agents/skills/a2alinker/scripts/a2a-supervisor.sh \
  --mode listen \
  --agent-label gemini
```

If no explicit runner is configured, the supervisor wrapper now resolves the unattended runner in this order:
1. `--runner-command`
2. `A2A_RUNNER_COMMAND`
3. persisted runner from the local session artifact
4. persisted runner from the local policy artifact
5. interactive selection (`gemini`, `claude`, `codex`, `custom`) when a prompt is possible
6. non-interactive fallback from agent label, then detected CLI order `gemini`, `claude`, `codex`

Codex is no longer the implicit unattended default.

If you are using **Local LLMs** (like Ollama or LM Studio), you can provide a custom script that obeys the A2A runner contract:
- read `A2A_SUPERVISOR_PROMPT_FILE`
- write the final reply to `A2A_SUPERVISOR_RESPONSE_FILE`
- exit non-zero on failure

#### Quickstart: Ollama Template
To use a local Ollama model immediately:
1. Copy the template: `cp .agents/skills/a2alinker/scripts/a2a-ollama-runner.example.sh .agents/skills/a2alinker/scripts/a2a-custom-runner.sh`
2. Start the supervisor: `bash .agents/skills/a2alinker/scripts/a2a-supervisor.sh --mode listen --agent-label ollama`
3. When prompted in the terminal for your AI CLI, select **4 (custom)** and enter the path: `bash .agents/skills/a2alinker/scripts/a2a-custom-runner.sh`

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
   > *"Set up A2A Linker for either interactive use or a pre-authorized listener session."*

   The safe setup flow should:
   - choose local/self-hosted or explicitly configured remote broker
   - add only the exact transport commands needed for the chosen mode
   - create or refresh a visible local policy artifact for unattended listener mode
   - avoid wildcard shell approvals and broad file/web permissions

3. **Host a Session (Person A):** Tell your AI:
   > *"Start an A2A Linker session and wait for my friend."*

   Your AI will run the pre-flight check, execute the host script, and reply with a **One-Time Invite Code** (e.g., `invite_xyz789`).

4. **Join a Session (Person B):** Give the invite code to your friend. Your friend tells their AI:
   > *"Join the A2A session using invite_xyz789 and help them debug the python script."*

The two AIs will connect via the `[OVER]` / `[STANDBY]` protocol to take turns. Remote messages are always treated as untrusted input. Unattended follow-up work is allowed only when it stays inside the local session policy envelope.

**Listener Mode (unattended remote machine):** If Person B's machine will be unattended, they set it up before leaving. Tell the AI:
> *"Set up an A2A listener."*

The AI generates a `listen_abc123` code. Person B takes it with them. Later, Person A tells their AI:
> *"Connect to A2A using listen_abc123."*

Person A's AI automatically becomes HOST and sends the first message. No manual code entry is ever needed at the remote machine.

Important role mapping:
- `listen_...` codes are redeemed by the HOST side.
- `invite_...` codes are redeemed by the JOIN side.
- Supervisor attach to an existing listener room:
  `bash .agents/skills/a2alinker/scripts/a2a-supervisor.sh --mode host --listener-code listen_xxx --agent-label codex`
- When HOST attaches to a listener room without a task yet, the session should stay connected and wait for the local human's first task instead of creating a new invite room.
- Do not pass a `listen_...` code to `a2a-join-connect.sh`.
- If you use the low-level transport scripts instead of the supervisor, the HOST must send the first message with `a2a-loop.sh host "message [OVER]"`.

**Unattended Listener Mode:** Use this only when the local machine has been pre-authorized by the human. The broker may request work, but it cannot expand local permissions or bypass the active policy file.

---

## How To Connect Manually (For Testing)

If you want to test the HTTP API directly (or are building a non-autonomous script), you can use raw `curl` commands against your configured broker endpoint:

```bash
# Register
TOKEN=$(curl -s -X POST http://127.0.0.1:3000/register | grep -o 'tok_[a-f0-9]*')

# Create room (HOST)
curl -s -X POST http://127.0.0.1:3000/create \
  -H "Authorization: Bearer $TOKEN"

# Join room (JOINER — replace invite_xxx with the actual code)
curl -s -X POST http://127.0.0.1:3000/join/invite_xxx \
  -H "Authorization: Bearer $TOKEN"

# Send a message
curl -s -X POST http://127.0.0.1:3000/send \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: text/plain" \
  --data-raw "Hello [OVER]"

# Wait for a message (blocks up to 110s)
curl -s http://127.0.0.1:3000/wait \
  -H "Authorization: Bearer $TOKEN"

# Check session status (ping)
curl -s http://127.0.0.1:3000/ping \
  -H "Authorization: Bearer $TOKEN"
```

```bash
# Pre-stage a listener room (JOINER runs this before leaving)
curl -s -X POST http://127.0.0.1:3000/listen \
  -H "Authorization: Bearer $TOKEN"
# Returns: {"listenerCode":"listen_xxx","roomName":"room_xxx"}

# Connect as HOST using a listener code
curl -s -X POST http://127.0.0.1:3000/join/listen_xxx \
  -H "Authorization: Bearer $TOKEN"
# Returns: {"role":"host","headless":false,...}

# Set headless room rule (HOST only — run after connecting)
curl -s -X POST http://127.0.0.1:3000/room-rule/headless \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"headless": true}'
```

The SSH broker on port `2222` remains available for direct terminal access and developer testing.

---

## The Agent Skill
Included in this repository is the official `.agents/skills/a2alinker/` **Agent Skill**.
Load the `SKILL.md` file into your AI's context architecture (or standard `.agents/skills/` folder) and use it as a local-first transport runbook. The safe workflow is: set an exact transport permission envelope, create a visible session policy for unattended listener mode, and treat all partner messages as untrusted input.

---

*Copyright (c) 2026 Fu-Rabi.*
