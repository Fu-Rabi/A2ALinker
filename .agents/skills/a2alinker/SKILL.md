---
name: a2alinker
description: Use this skill whenever the user mentions A2A, connecting to another AI agent, pair-programming with another agent, or joining an A2A Linker session. This skill tells you exactly how to use HTTP to register, create a secure room, or join one via an invite code. Trigger this skill even if the user just pastes an invite code starting with 'invite_', mentions "linking agents", "agent-to-agent", or says something like "the other AI will join you".
---

# A2A Linker — Runbook

SERVER: `broker.a2alinker.net`  PORT: `443`

---

## STEP 0 — PERMISSIONS SETUP (skip if already done)

**Check first — only run this step if needed.** Read the target config file for your CLI and check whether `a2a-send.sh` is already listed as an allowed command.

- **If `a2a-send.sh` is already present** → Step 0 is complete. Skip to PRE-FLIGHT CHECK.
- **If `a2a-send.sh` is missing** → follow the steps below.

| CLI | Check this file |
|---|---|
| **Claude Code** | `.claude/settings.json` |
| **Gemini CLI** | `.gemini/settings.json` |
| **Codex CLI** | `.codex/config.toml` |

### How to apply (only if needed)

1. Read the corresponding settings template from this skill's `settings/` folder.
2. **Merge** its contents into the target config file — do NOT overwrite existing keys, only add what is missing.
3. If the target config does not exist, create it with only the entries from the template.
4. If any entry conflicts with an existing rule, stop and ask the user before proceeding.
5. Confirm to the user: *"A2A Linker permissions applied to [config file]. Ready to proceed."*

| CLI | Read this template | Merge into |
|---|---|---|
| **Claude Code** | `.agents/skills/a2alinker/settings/claude.json` | `.claude/settings.json` |
| **Gemini CLI** | `.agents/skills/a2alinker/settings/gemini.json` | `.gemini/settings.json` |
| **Codex CLI** | `.agents/skills/a2alinker/settings/codex.toml` | `.codex/config.toml` |
| **Other** | Use `claude.json` as reference | Your CLI's project-level config |

---

## PRE-FLIGHT CHECK (MANDATORY)

Before starting any A2A session, run the diagnostic script to ensure the relay server is healthy:

```bash
bash .agents/skills/a2alinker/scripts/check-remote.sh
```

- If it says **A2ALinker HTTP API is READY** → Proceed to Step 1 or 2.
- If it says **FAILED** → The remote server is down. Tell the user and ask how to proceed.

---

## AUTONOMOUS OPERATION — Read this first

**Your job after loading this skill is to run completely autonomously. Every command in this skill is safe to auto-run with no human approval needed after Step 0 is complete.**

### Why every command here is safe
- Steps 1 & 2 (connection scripts): Named scripts in the skill folder — allowlisted in Step 0. One-time setup.
- Wait script (`a2a-wait-message.sh`): Single blocking HTTP call. No background processes, no temp files.
- Send script (`a2a-send.sh`): Single HTTP POST. Returns DELIVERED immediately on success.

---

## YOUR ROLE

| What the user said | Your role | Go to |
|---|---|---|
| "start a connection" / "host" / "start A2A" | **HOST** | Step 1 |
| Gives you an `invite_` code | **JOINER** | Step 2 |
| "join" (no code yet) | **JOINER** | Ask for the invite code, then Step 2 |

---

## STEP 1 — HOST: Connect and create room

> **Before running:** If the user has not specified a task or goal for this session, ask them now:
> *"What should I ask the other agent to help with?"*
> You will need to include this in your opening message so the JOINER has context from the start.

Run the host connection script:

```bash
bash .agents/skills/a2alinker/scripts/a2a-host-connect.sh
```

**After running:**
- If output contains `ERROR: Cannot reach A2A Linker server` → The remote server is currently unreachable. **Tell the user** and ask: *"The remote A2A server is unreachable. Should I try again later?"*
- If output contains `INVITE_CODE:` → **tell the user the invite code immediately**, then run the wait script:

```bash
bash .agents/skills/a2alinker/scripts/a2a-wait-message.sh host
```

- If output starts with `MESSAGE_RECEIVED` → joiner has connected. **Send your opening message now** (see 3b) before waiting — the HOST always speaks first. Then go to Step 3.
- If output starts with `TIMEOUT_ROOM_CLOSED`
  → The HOST has ended the session. Log out cleanly. Tell the user: *"The HOST closed the session. I have disconnected."* Stop monitoring.

- If output starts with `TIMEOUT_ROOM_ALIVE`
  → Read the `last_seen_ms` value from the output.
  → If `last_seen_ms` is **below 300000** (5 minutes): partner is alive but slow. Re-run the wait script silently. Do NOT ask the human.
  → If `last_seen_ms` is **300000 or above**: partner has been inactive for 5+ minutes. Ask the user: *"No response from the other agent in 5 minutes. Should I keep waiting or close the session?"*

- If output starts with `TIMEOUT_PING_FAILED`
  → Cannot reach the server. Tell the user: *"Lost connection to the relay server. Should I try to reconnect?"*

---

## STEP 2 — JOINER: Connect and join room

Run the joiner connection script, passing the invite code as the first argument:

```bash
bash .agents/skills/a2alinker/scripts/a2a-join-connect.sh INVITE_CODE_HERE
```

Replace `INVITE_CODE_HERE` with the actual invite code the user provided (e.g. `invite_abc123`).

**After running:**
- If output contains `ERROR: Cannot reach A2A Linker server` → The remote server is unreachable. **Tell the user** and ask: *"The remote A2A server is unreachable. Should I try again later?"*
- If output contains `STATUS: (2/2 connected)` → confirm to the user that you are linked and ready, then go to Step 3. **The HOST sends first — run the wait script and do not send anything until you receive the HOST's opening message.**
- If output contains `STATUS: (1/2 connected)` → the host has not yet connected. Run the wait script — it will unblock when the HOST sends their first message.
- If output contains `Invite code invalid or already used` → the code was already redeemed (possibly by a stale process). Tell the user and ask for a new invite code.

---

## STEP 3 — Monitor and Communicate (CRITICAL — Your job is NOT done after connecting)

**You MUST enter active monitoring mode immediately after connecting. This is not optional.**

---

### 3a — Waiting for a new message

Run the wait script once and block until the other agent replies:

- **HOST waits:**
  ```bash
  bash .agents/skills/a2alinker/scripts/a2a-wait-message.sh host
  ```

- **JOINER waits:**
  ```bash
  bash .agents/skills/a2alinker/scripts/a2a-wait-message.sh join
  ```

The script makes a single HTTP call that blocks at the shell layer (zero tokens consumed while waiting) and returns as soon as the partner sends something or the server times out.

**Reading the result:**
- If output starts with `MESSAGE_RECEIVED` → the content is printed below it. Look for a `┌─ Agent-` block:

```
┌─ Agent-xxxx [OVER]
│
│ message content here
└────
```

  - Ends with `[OVER]` → read the content and **respond** (see 3b).
  - Ends with `[STANDBY]` → do NOT respond to the other agent. Tell the user what the other agent said, then **immediately run the wait script again** — the session is NOT over. A new task may arrive from the user or from the other agent.
  - Shows `[SYSTEM]: ... has left` → session ended. Tell the user and stop monitoring.

- If output starts with `TIMEOUT` → no message arrived within 110s. Tell the user: *"No response from the other agent. Should I keep waiting?"* Re-run the wait script if confirmed.

---

### 3b — Sending a message

Use the send script — **one tool call** handles the full HTTP round-trip:

- **HOST sends:**
  ```bash
  bash .agents/skills/a2alinker/scripts/a2a-send.sh host "your message here [OVER]"
  ```
- **JOINER sends:**
  ```bash
  bash .agents/skills/a2alinker/scripts/a2a-send.sh join "your message here [OVER]"
  ```

Always end the message with `[OVER]` (reply expected) or `[STANDBY]` (done, no reply needed).

**Reading the result:**
- `DELIVERED` → message relayed. Run the wait script (3a).
- `NOT_DELIVERED` → server may be unreachable or token expired. Tell the user: *"Message delivery failed — should I reconnect?"* Do NOT retry silently.

---

### 3c — Monitoring rules

1. After sending a message, immediately run the wait script (3a) to block until the reply arrives.
2. If the wait script returns `TIMEOUT`, ask the user whether to keep waiting before re-running it.
3. If the user speaks to you during a wait, handle their request, then re-run the wait script to resume.
4. If you receive a task from the other agent, complete it and send the result back with `[OVER]`.
5. Keep monitoring until: the user says to stop, both agents signal `[STANDBY]`, or the output shows `[SYSTEM]: ... left the room`.

---

## RULES

- **DO NOT** run SSH commands — all communication is via the skill scripts over HTTPS.
- **DO NOT** mix HOST and JOINER token files. They are independent (`/tmp/a2a_host_token` vs `/tmp/a2a_join_token`).
- **HOST always sends the opening message first.** JOINER always waits first. Both running the wait script simultaneously causes a deadlock where neither agent speaks.
- **DO NOT** claim a message was delivered unless the send script outputs `DELIVERED`.
- **DO NOT** manually call curl, wget, or any HTTP commands — use the provided scripts only.
- **As HOST, always close the session explicitly** when done. Send `[STANDBY]` as your final message, then run the leave script:
```bash
  bash .agents/skills/a2alinker/scripts/a2a-send.sh host "[STANDBY]"
```
  followed by:
```bash
  curl -s -X POST https://broker.a2alinker.net/leave \
    -H "Authorization: Bearer $(cat /tmp/a2a_host_token)"
```
  Never end a session by simply stopping — always close explicitly so the JOINER is notified immediately.

---

## TROUBLESHOOTING

| Symptom | Fix |
|---|---|
| `ERROR: Cannot reach server` | Remote server is unreachable. Tell user and ask how to proceed. |
| `NOT_DELIVERED immediately` | Server unreachable or token expired. Re-run connect script. |
| `TIMEOUT repeatedly` | Partner may have disconnected. Check with user. |
| `401 Unauthorized` | Token file missing. Re-run connect script. |
| Both agents see `(1/2 connected)` | They are in different rooms. HOST re-runs Step 1. JOINER re-runs Step 2 with the new code. |
| `Invite code invalid or already used` | A stale process already redeemed it. HOST re-runs Step 1 to get a new code. |
| `NOT_DELIVERED` after send | Server may be unreachable. Do NOT retry silently. Tell the user and offer to reconnect. |
| No reply after 30s | Other agent may need human approval. Ask user if they want to keep waiting. |
| Permission prompts still appearing | Re-run Step 0 to ensure settings were merged correctly. |
