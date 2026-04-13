# A2A Linker

**A2A (Agent-to-Agent) Linker** is an HTTP-first relay broker that lets autonomous AI agents collaborate in real-time across different machines. Agents connect over HTTP(S), exchange messages using a walkie-talkie protocol (`[OVER]` / `[STANDBY]`), and the server routes messages without durable conversation storage.

It acts as a multiplexed switchboard for LLMs, allowing them to pair-program, debate, and share files across the internet without needing custom APIs, WebSockets, or complex SDK integrations. If an AI agent can run `curl`, it can join an A2A Linker session.

## In One Sentence

Use A2A Linker when you want one AI agent to safely talk to another AI agent over the internet or across machines without building a custom integration.

## What You Can Do With It

- Connect your local AI agent to a coworker's or friend's AI agent for pair debugging
- Leave a machine in listener mode so another trusted machine can reach it later
- Relay messages between agents using plain HTTP and shell scripts instead of a custom SDK
- Self-host a privacy-preserving broker with ephemeral Redis-backed runtime state

## Who This Is For

- Hobbyists who want two AI coding assistants to collaborate
- Developers who want a simple HTTP transport instead of building their own agent bridge
- Technical product managers who want to prototype agent-to-agent workflows without standing up a larger platform

You do not need to understand Redis, SSH, or the internal protocol to try it. The fastest path is either:

- use the hosted broker at `https://broker.a2alinker.net`
- self-host locally with Docker Compose
- use the included skill scripts from `.agents/skills/a2alinker/`

---

## Quickstart

Choose the path that matches how you want to try the project:

### Option 1: Use The Hosted Broker

Best if you want to try A2A Linker quickly without running infrastructure.

1. Point your local scripts or skill at `https://broker.a2alinker.net`
2. Start a host session on one machine
3. Join with the invite code from another machine

### Option 2: Self-Host With Docker Compose

Best if you want your own private broker with the recommended production-style topology.

1. Copy the example environment:
   ```bash
   cp deploy/a2alinker.env.example .env
   ```
2. Edit `.env` and set at least:
   - `LOOKUP_HMAC_KEY`
   - `ADMIN_TOKEN` if you want admin endpoints
3. Start the broker and Redis:
   ```bash
   docker compose up -d
   ```
4. Check that it is live:
   ```bash
   curl http://127.0.0.1:3000/health
   curl http://127.0.0.1:3000/ready
   ```

### Option 3: Run It Locally Without Docker

Best if you are developing or testing the broker directly.

1. Install dependencies:
   ```bash
   npm install
   ```
2. Build:
   ```bash
   npm run build
   ```
3. Start Redis locally
4. Start the broker:
   ```bash
   NODE_ENV=production \
   BROKER_STORE=redis \
   REDIS_URL=redis://127.0.0.1:6379/0 \
   LOOKUP_HMAC_KEY=replace-with-at-least-32-random-bytes \
   TRUST_PROXY=1 \
   HTTP_BIND_HOST=127.0.0.1 \
   HTTP_PORT=3000 \
   ENABLE_SSH=false \
   npm start
   ```

---

## Why Does This Exist?

As terminal-native AI agents become more powerful, they are often isolated to the machine they are running on. A2A Linker gives them a simple shared transport.

What it solves:

- **Cross-machine pair programming:** one AI can help another AI debug, inspect, or implement work
- **Zero-SDK transport:** agents can connect with ordinary HTTP and shell commands
- **Turn-taking control:** the `[OVER]` / `[STANDBY]` protocol helps prevent endless polite loops

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

If you want two agents on different machines to connect remotely without self-hosting the broker first, you can use the author-hosted public broker at **`https://broker.a2alinker.net`**.

It is:

- run by the project author
- free to use
- intended for remote agent-to-agent connections over the internet
- operated with the same zero-message-logging privacy goal described below

### Privacy — Zero Message Logging

Whether you use the free public server or self-host your own instance: **A2A Linker does not record or log message bodies exchanged between agents.**

The current production direction is:

- zero message logging
- zero identifying usage logging
- zero user accounts
- no durable conversation storage
- only TTL-bound anonymous broker state

**What the broker may store temporarily:**
- anonymous session tokens
- anonymous room membership
- one-time invite or listener codes
- pending waiter ownership
- queued inbox messages needed for live delivery
- aggregate counters and dependency health state

**What the broker should never store durably:** message content, raw request bodies, IP-based audit history, user identities, or per-message conversation history.

**Where messages go:** a message arrives as an HTTP POST body, is held ephemerally in memory and/or TTL-bound broker inbox state for delivery, is forwarded to the waiting participant, and is then discarded. There is still no durable message history table or message-body logging path.

The legacy SQLite path still exists for the optional SSH broker, but the privacy-preserving production path is now Redis-backed HTTP. See [production.md](docs/production.md) for the deployment contract, Docker Compose notes, and operator guidance.

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
5. **Rate-Limited Security:** Critical HTTP endpoints are protected by shared TTL-backed counters. The production target is anonymous bucket throttling with no durable per-user history.

> **Transport note:** The HTTP production path has been refactored around shared broker state and Redis wake-up delivery. The SSH broker is still optional and legacy-oriented. Public production deployments should prefer HTTP behind a reverse proxy and leave `ENABLE_SSH=false` unless SSH is intentionally hardened and operated separately.

## Deployment Summary

Supported production shapes:

- run the app privately on `127.0.0.1:3000`
- terminate TLS at nginx or another reverse proxy
- use `BROKER_STORE=redis`
- set `TRUST_PROXY=1`
- leave `ENABLE_SSH=false`
- deploy either with `systemd` or with `docker compose`

Direct in-process HTTPS is no longer the recommended production default. In production it requires `ALLOW_DIRECT_HTTPS_PROD=true`.

For deeper operator guidance, see [production.md](docs/production.md).

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `NODE_ENV` | Runtime mode. Production requires stricter startup validation. | `development` |
| `BROKER_STORE` | `memory` for local/test, `redis` for production shared state. | `memory` in dev, `redis` in production |
| `REDIS_URL` | Redis connection URL. Required when `BROKER_STORE=redis`. | unset |
| `LOOKUP_HMAC_KEY` | HMAC key used to derive anonymous lookup IDs. Must be at least 32 bytes in production. | random in non-production |
| `TRUST_PROXY` | Reverse-proxy trust setting for Express. Required in production. | `false` |
| `HTTP_BIND_HOST` | Bind host for the HTTP app listener. | `0.0.0.0` in dev, `127.0.0.1` in production |
| `HTTP_PORT` | HTTP app listener port. | `3000` |
| `PUBLIC_HOST` | Hostname used in SSH banners and host key generation. | `localhost` |
| `PORT` | Local listen port for the SSH broker. | `2222` |
| `ENABLE_SSH` | Enables the legacy SSH broker. Public HTTP deployments should leave this disabled. | `false` |
| `ADMIN_TOKEN` | Enables authenticated admin endpoints when set. | unset |
| `HTTPS_KEY_PATH` | Optional direct TLS private key path. Production use requires `ALLOW_DIRECT_HTTPS_PROD=true`. | unset |
| `HTTPS_CERT_PATH` | Optional direct TLS certificate chain path. Production use requires `ALLOW_DIRECT_HTTPS_PROD=true`. | unset |
| `ALLOW_DIRECT_HTTPS_PROD` | Explicit override for direct in-process TLS in production. | `false` |
| `ALLOW_INSECURE_HTTP_LOCAL_DEV` | Allows plain HTTP startup when certs are missing in local development. | `false` |

Client scripts default to local/self-hosted transport (`A2A_BASE_URL=http://127.0.0.1:3000`). Remote brokers must be configured explicitly with `A2A_BASE_URL` or `A2A_SERVER`.

For production deployment assets and the operator runbook, see [production.md](docs/production.md), [nginx.a2alinker.conf](deploy/nginx.a2alinker.conf), [a2alinker.env.example](deploy/a2alinker.env.example), [Dockerfile](Dockerfile), and [docker-compose.yml](docker-compose.yml).

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

## Connect Agents With The Included Skill

The easiest way to use A2A Linker is the included **Agent Skill**. You do not need to manually compose HTTP commands; the local scripts and skill prompt your agent to do the transport work safely.

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

## Manual HTTP API (For Testing)

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

The SSH broker on port `2222` remains available only for direct terminal access and developer testing. It is not the recommended public production path.

---

## Summary

A2A Linker is ready to use in three ways:

- quickest trial: use the hosted broker
- recommended self-hosted path: Docker Compose + reverse proxy + Redis
- deepest control: use the raw HTTP API and local scripts

Included in this repository is the official `.agents/skills/a2alinker/` skill for Claude, Gemini, Codex, and similar terminal-capable agent runtimes.

---

*Copyright (c) 2026 Fu-Rabi.*
