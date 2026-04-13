# Skill And Supervisor Guide

This document covers the advanced local runtime side of A2A Linker: the included skill, the supervisor, unattended mode, listener workflows, and custom runner integration.

For the public overview and first-run guide, start with [README.md](../README.md). For deployment and operator guidance, see [production.md](production.md).

## Included Skill Layout

The skill is fully self-contained under `.agents/skills/a2alinker/`:

```text
.agents/skills/a2alinker/
├── SKILL.md
├── scripts/
│   ├── a2a-claude-runner.sh
│   ├── a2a-codex-runner.sh
│   ├── a2a-common.sh
│   ├── a2a-gemini-runner.sh
│   ├── a2a-host-connect.sh
│   ├── a2a-join-connect.sh
│   ├── a2a-leave.sh
│   ├── a2a-listen.sh
│   ├── a2a-loop.sh
│   ├── a2a-ollama-runner.example.sh
│   ├── a2a-ping.sh
│   ├── a2a-send.sh
│   ├── a2a-set-headless.sh
│   ├── a2a-supervisor.sh
│   ├── a2a-wait-message.sh
│   └── check-remote.sh
└── settings/
    ├── claude.json
    ├── codex.toml
    └── gemini.json
```

This layout lets you drop the skill into an existing project without rewriting the project root configuration. The skill keeps its own scripts, settings templates, and runtime helpers together.

## Long-Poll Message Waiting

After sending a message, the local runtime can block on a single `/wait` request instead of polling repeatedly. The included `a2a-loop.sh` helper wraps that behavior:

1. It can send a message first.
2. It then performs one blocking HTTP GET to `/wait`.
3. The broker holds that request open until a real message or session-ending event arrives.
4. The script filters routine `[SYSTEM]` notices and short internal timeouts so the local AI usually wakes only for meaningful content.

This keeps token usage low because the LLM does not need to repeatedly inspect a file or re-run a polling command while it waits.

## Supervisor And Unattended Mode

Some runtimes do not automatically continue after a tool result. For those cases, A2A Linker includes a session-scoped supervisor.

Recommended entrypoint:

```bash
npm run build
bash .agents/skills/a2alinker/scripts/a2a-supervisor.sh \
  --mode listen \
  --agent-label gemini
```

The supervisor:

1. creates or joins the A2A session
2. blocks on `a2a-loop.sh`
3. invokes the configured local runner when a real partner message arrives
4. sends the reply back through A2A
5. immediately resumes waiting

While the supervisor is active, it mirrors inbound partner messages, outbound replies, and important broker events to its own terminal session. That keeps unattended traffic visible without changing the broker protocol.

`--agent-label` is display metadata for the local UI. It is not a settings profile name and should not trigger file creation under `.agents/skills/a2alinker/settings/`.

## Runner Resolution And Custom Runners

If no explicit runner is configured, the supervisor wrapper resolves the unattended runner in this order:

1. `--runner-command`
2. `A2A_RUNNER_COMMAND`
3. persisted runner from the local session artifact
4. persisted runner from the local policy artifact
5. interactive selection (`gemini`, `claude`, `codex`, `custom`) when prompting is possible
6. non-interactive fallback from agent label, then detected CLI order `gemini`, `claude`, `codex`

The supervisor supports Claude, Gemini, Codex, or a custom runner.

If you are using a local LLM stack such as Ollama or LM Studio, provide a custom script that:

- reads `A2A_SUPERVISOR_PROMPT_FILE`
- writes the final reply to `A2A_SUPERVISOR_RESPONSE_FILE`
- exits non-zero on failure

### Ollama Example

```bash
cp .agents/skills/a2alinker/scripts/a2a-ollama-runner.example.sh \
  .agents/skills/a2alinker/scripts/a2a-custom-runner.sh
```

Then start the supervisor and choose the custom runner path when prompted:

```bash
bash .agents/skills/a2alinker/scripts/a2a-supervisor.sh --mode listen --agent-label ollama
```

## Safe Local Policy Model

Unattended mode is intentionally narrow. The local machine must be prepared in advance by a human, and remote input remains untrusted.

Key rules:

- the supervisor writes a visible local policy artifact such as `.a2a-listener-policy.json`
- unattended follow-up work is allowed only inside that local policy envelope
- interactive sessions can learn narrow session grants after local approval
- those grants stay session-scoped and should not broaden forbidden capabilities
- the broker does not grant new local permissions

The included skill and settings templates favor minimal exact command approvals, local-first brokers, and visible policy/session artifacts over broad wildcard approvals.

## Host, Join, And Listener Workflows

### Standard Host / Join Flow

1. Person A starts a host session.
2. The broker returns a one-time `invite_...` code.
3. Person B redeems that invite from their local AI.
4. The agents alternate turns using `[OVER]` / `[STANDBY]`.

### Listener Flow For An Unattended Machine

1. The unattended machine is prepared locally in advance.
2. Its local AI creates a `listen_...` code.
3. Later, another machine redeems that code and becomes the host side automatically.
4. The unattended machine never needs a person physically present at join time.

Important role mapping:

- `listen_...` codes are redeemed by the host side
- `invite_...` codes are redeemed by the join side
- do not pass a `listen_...` code to `a2a-join-connect.sh`
- if you use low-level transport scripts instead of the supervisor, the host must send the first message with `a2a-loop.sh host "message [OVER]"`

Supervisor attach to an existing listener room:

```bash
bash .agents/skills/a2alinker/scripts/a2a-supervisor.sh \
  --mode host \
  --listener-code listen_xxx \
  --agent-label codex
```

If the host attaches to a listener room before there is a task, the session should stay connected and wait for the local human's first instruction instead of opening a new invite room.

## Local Session Artifacts

Listener startup persists a stable local state file at `.a2a-listener-session.json`. Use:

```bash
bash .agents/skills/a2alinker/scripts/a2a-supervisor.sh --mode listen --status
```

to inspect the current listener code and local state without restarting the listener.

Host attach sessions also persist `.a2a-host-session.json`. Use:

```bash
bash .agents/skills/a2alinker/scripts/a2a-supervisor.sh --mode host --status
```

to inspect the cached local host session state after a backgrounded attach attempt. This is local state, not a live broker truth source.

Session closure is explicit. Agents should not leave just because a task appears complete. The connection remains open until the host closes it after clear local human instruction.

When the human explicitly instructs the host to close the session, use:

```bash
A2A_ALLOW_CLOSE=true bash .agents/skills/a2alinker/scripts/a2a-leave.sh host
```

Listener-side closure messages are only visible while a waiter is still active. Keep the supervisor running, or keep `a2a-loop.sh join` active, if you want the unattended side to visibly show that the host closed the session.
