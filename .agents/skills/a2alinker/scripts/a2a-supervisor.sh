#!/bin/bash
# A2A Linker — Supervisor launcher
# Wraps the Node supervisor and injects A2A_RUNNER_COMMAND if --runner-command
# was not provided explicitly.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
REPO_SUPERVISOR_JS="$ROOT_DIR/dist/a2a-supervisor.js"
REPO_SUPERVISOR_TS="$ROOT_DIR/src/a2a-supervisor.ts"
SKILL_SUPERVISOR_JS="$SCRIPT_DIR/../runtime/a2a-supervisor.js"
. "$SCRIPT_DIR/a2a-common.sh"

DEFAULT_GEMINI_RUNNER="bash $SCRIPT_DIR/a2a-gemini-runner.sh"
DEFAULT_CLAUDE_RUNNER="bash $SCRIPT_DIR/a2a-claude-runner.sh"
DEFAULT_CODEX_RUNNER="bash $SCRIPT_DIR/a2a-codex-runner.sh"

resolve_supervisor_command() {
  if [ -f "$REPO_SUPERVISOR_JS" ]; then
    printf 'node\n\n%s\n' "$REPO_SUPERVISOR_JS"
    return 0
  fi

  if [ -f "$REPO_SUPERVISOR_TS" ] && command -v npx >/dev/null 2>&1 && [ -d "$ROOT_DIR/node_modules" ]; then
    printf 'npx\nts-node\n%s\n' "$REPO_SUPERVISOR_TS"
    return 0
  fi

  if [ -f "$SKILL_SUPERVISOR_JS" ]; then
    printf 'node\n%s\n' "$SKILL_SUPERVISOR_JS"
    return 0
  fi

  return 1
}

prompt_for_broker_if_needed() {
  if [ -n "${A2A_BASE_URL:-}" ] || [ -n "${A2A_SERVER:-}" ]; then
    return 0
  fi

  if [ -t 0 ] && [ -t 1 ]; then
    local selection
    printf 'A2A broker target [local/remote] (default: local): ' >&2
    read -r selection || true
    selection="${selection:-local}"
    case "$selection" in
      remote|REMOTE|Remote)
        local remote_target
        printf 'Remote broker URL or hostname: ' >&2
        read -r remote_target || true
        if [ -z "${remote_target:-}" ]; then
          echo "ERROR: Remote broker selection requires a URL or hostname." >&2
          exit 1
        fi
        case "$remote_target" in
          http://*|https://*)
            export A2A_BASE_URL="$remote_target"
            ;;
          *)
            export A2A_SERVER="$remote_target"
            ;;
        esac
        ;;
      *)
        export A2A_BASE_URL="http://127.0.0.1:3000"
        ;;
    esac
    return 0
  fi

  echo "A2A broker target not explicitly selected. Defaulting to local/self-hosted http://127.0.0.1:3000. Set A2A_BASE_URL or A2A_SERVER for remote." >&2
  export A2A_BASE_URL="http://127.0.0.1:3000"
}

requires_explicit_broker=false
for arg in "$@"; do
  if [ "$arg" = "--listener-code" ]; then
    requires_explicit_broker=true
    break
  fi
done

ensure_explicit_broker_for_listener_attach() {
  if [ "$requires_explicit_broker" = false ]; then
    return 0
  fi

  if [ -n "${A2A_BASE_URL:-}" ] || [ -n "${A2A_SERVER:-}" ]; then
    return 0
  fi

  echo "ERROR: Host attach via --listener-code requires an explicit broker target." >&2
  echo "Set A2A_BASE_URL or A2A_SERVER to the same broker used by the listener before attaching." >&2
  exit 1
}

is_runner_kind_available() {
  case "$1" in
    gemini)
      command -v gemini >/dev/null 2>&1
      ;;
    claude)
      command -v claude >/dev/null 2>&1
      ;;
    codex)
      command -v codex >/dev/null 2>&1
      ;;
    custom)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

runner_command_for_kind() {
  case "$1" in
    gemini)
      printf '%s\n' "$DEFAULT_GEMINI_RUNNER"
      ;;
    claude)
      printf '%s\n' "$DEFAULT_CLAUDE_RUNNER"
      ;;
    codex)
      printf '%s\n' "$DEFAULT_CODEX_RUNNER"
      ;;
    *)
      return 1
      ;;
  esac
}

detect_first_available_runner_kind() {
  local kind
  for kind in gemini claude codex; do
    if is_runner_kind_available "$kind"; then
      printf '%s\n' "$kind"
      return 0
    fi
  done
  return 1
}

infer_runner_kind_from_label() {
  local label="${1:-}"
  local normalized
  normalized="$(printf '%s' "$label" | tr '[:upper:]' '[:lower:]')"
  case "$normalized" in
    *gemini*|*gemma*)
      printf 'gemini\n'
      ;;
    *claude*)
      printf 'claude\n'
      ;;
    *codex*)
      printf 'codex\n'
      ;;
    *)
      return 1
      ;;
  esac
}

infer_runner_kind_from_command() {
  local command_value="${1:-}"
  local normalized
  normalized="$(printf '%s' "$command_value" | tr '[:upper:]' '[:lower:]')"
  case "$normalized" in
    *gemini*)
      printf 'gemini\n'
      ;;
    *claude*)
      printf 'claude\n'
      ;;
    *codex*)
      printf 'codex\n'
      ;;
    *)
      printf 'custom\n'
      ;;
  esac
}

read_persisted_runner() {
  local mode_arg="$1"
  local cwd="$PWD"
  local artifact_path runner_command runner_kind
  local artifacts=()

  case "$mode_arg" in
    listen)
      artifacts=("$cwd/.a2a-listener-session.json" "$cwd/.a2a-listener-policy.json" "$cwd/.a2a-session-policy.json")
      ;;
    host)
      artifacts=("$cwd/.a2a-host-session.json" "$cwd/.a2a-session-policy.json" "$cwd/.a2a-listener-policy.json")
      ;;
    join)
      artifacts=("$cwd/.a2a-session-policy.json" "$cwd/.a2a-listener-policy.json")
      ;;
  esac

  for artifact_path in "${artifacts[@]}"; do
    runner_command="$(a2a_read_field_from_artifact "$artifact_path" "runnerCommand" || true)"
    if [ -n "$runner_command" ]; then
      runner_kind="$(a2a_read_field_from_artifact "$artifact_path" "runnerKind" || true)"
      printf '%s\n%s\n' "$runner_kind" "$runner_command"
      return 0
    fi
  done

  return 1
}

prompt_for_runner() {
  local default_kind="$1"
  local selection custom_command selected_kind

  echo "Which AI CLI will process background tasks for this agent?" >&2
  if is_runner_kind_available gemini; then
    echo "[1] gemini (Detected in PATH)" >&2
  else
    echo "[1] gemini" >&2
  fi
  if is_runner_kind_available claude; then
    echo "[2] claude (Detected in PATH)" >&2
  else
    echo "[2] claude" >&2
  fi
  if is_runner_kind_available codex; then
    echo "[3] codex (Detected in PATH)" >&2
  else
    echo "[3] codex" >&2
  fi
  echo "[4] custom (Supply your own script)" >&2
  printf 'Selection [1-4] (default: %s): ' "$(
    case "$default_kind" in
      gemini) printf '1' ;;
      claude) printf '2' ;;
      codex) printf '3' ;;
      *) printf '1' ;;
    esac
  )" >&2
  read -r selection || true
  selection="${selection:-$(
    case "$default_kind" in
      gemini) printf '1' ;;
      claude) printf '2' ;;
      codex) printf '3' ;;
      *) printf '1' ;;
    esac
  )}"

  case "$selection" in
    1) selected_kind="gemini" ;;
    2) selected_kind="claude" ;;
    3) selected_kind="codex" ;;
    4) selected_kind="custom" ;;
    *) selected_kind="$default_kind" ;;
  esac

  if [ "$selected_kind" = "custom" ]; then
    printf 'Custom runner command: ' >&2
    read -r custom_command || true
    if [ -z "${custom_command:-}" ]; then
      echo "ERROR: Custom runner selection requires a full command string." >&2
      exit 1
    fi
    printf 'custom\n%s\n' "$custom_command"
    return 0
  fi

  if ! is_runner_kind_available "$selected_kind"; then
    echo "ERROR: Selected runner '$selected_kind' is not available in PATH." >&2
    exit 1
  fi

  printf '%s\n%s\n' "$selected_kind" "$(runner_command_for_kind "$selected_kind")"
}

resolve_runner_selection() {
  local mode_arg="$1"
  local agent_label="$2"
  local explicit_runner_command="${3:-}"
  local explicit_runner_kind="${4:-}"
  local persisted runner_kind runner_command

  if [ -n "$explicit_runner_command" ]; then
    if [ -n "$explicit_runner_kind" ]; then
      printf '%s\n%s\n' "$explicit_runner_kind" "$explicit_runner_command"
    else
      printf '%s\n%s\n' "$(infer_runner_kind_from_command "$explicit_runner_command")" "$explicit_runner_command"
    fi
    return 0
  fi

  persisted="$(read_persisted_runner "$mode_arg" || true)"
  if [ -n "$persisted" ]; then
    printf '%s\n' "$persisted"
    return 0
  fi

  if [ -t 0 ] && [ -t 1 ]; then
    local default_kind
    default_kind="$(detect_first_available_runner_kind || true)"
    default_kind="${default_kind:-gemini}"
    prompt_for_runner "$default_kind"
    return 0
  fi

  runner_kind="$(infer_runner_kind_from_label "$agent_label" || true)"
  if [ -n "$runner_kind" ] && is_runner_kind_available "$runner_kind"; then
    printf '%s\n%s\n' "$runner_kind" "$(runner_command_for_kind "$runner_kind")"
    return 0
  fi

  runner_kind="$(detect_first_available_runner_kind || true)"
  if [ -n "$runner_kind" ]; then
    printf '%s\n%s\n' "$runner_kind" "$(runner_command_for_kind "$runner_kind")"
    return 0
  fi

  echo "ERROR: No supported unattended runner is configured or installed. Configure --runner-command, A2A_RUNNER_COMMAND, or install gemini, claude, or codex." >&2
  exit 1
}

if ! SUPERVISOR_INFO="$(resolve_supervisor_command)"; then
  echo "ERROR: supervisor runtime not found."
  echo "Checked:"
  echo "  - $REPO_SUPERVISOR_JS"
  echo "  - $REPO_SUPERVISOR_TS"
  echo "  - $SKILL_SUPERVISOR_JS"
  exit 1
fi

SUPERVISOR_BIN="$(printf '%s\n' "$SUPERVISOR_INFO" | sed -n '1p')"
SUPERVISOR_EXTRA="$(printf '%s\n' "$SUPERVISOR_INFO" | sed -n '2p')"
SUPERVISOR_TARGET="$(printf '%s\n' "$SUPERVISOR_INFO" | sed -n '3p')"

HAS_RUNNER=false
HAS_RUNNER_KIND=false
HAS_SCRIPT_DIR=false
HAS_HEADLESS=false
HAS_STATUS=false
HAS_HELP=false
MODE_ARG=""
AGENT_LABEL_ARG=""
for arg in "$@"; do
  if [ "$arg" = "--runner-command" ]; then
    HAS_RUNNER=true
  fi
  if [ "$arg" = "--runner-kind" ]; then
    HAS_RUNNER_KIND=true
  fi
  if [ "$arg" = "--script-dir" ]; then
    HAS_SCRIPT_DIR=true
  fi
  if [ "$arg" = "--headless" ]; then
    HAS_HEADLESS=true
  fi
  if [ "$arg" = "--status" ]; then
    HAS_STATUS=true
  fi
  if [ "$arg" = "--help" ]; then
    HAS_HELP=true
  fi
done

if [ "$HAS_STATUS" = false ] && [ "$HAS_HELP" = false ]; then
  if [ "$requires_explicit_broker" = true ]; then
    ensure_explicit_broker_for_listener_attach
  else
    prompt_for_broker_if_needed
  fi

  if [ -n "${A2A_BASE_URL:-}" ]; then
    echo "A2A broker target: $A2A_BASE_URL" >&2
  elif [ -n "${A2A_SERVER:-}" ]; then
    echo "A2A broker target: $A2A_SERVER" >&2
  fi
fi

ARGS=("$@")
for ((i=0; i<${#ARGS[@]}; i++)); do
  if [ "${ARGS[$i]}" = "--mode" ] && [ $((i + 1)) -lt ${#ARGS[@]} ]; then
    MODE_ARG="${ARGS[$((i + 1))]}"
  fi
  if [ "${ARGS[$i]}" = "--agent-label" ] && [ $((i + 1)) -lt ${#ARGS[@]} ]; then
    AGENT_LABEL_ARG="${ARGS[$((i + 1))]}"
  fi
done

ATTENDED_FLAG="${A2A_UNATTENDED:-${A2A_HEADLESS:-}}"
ATTENDED_FLAG_NORMALIZED="$(printf '%s' "$ATTENDED_FLAG" | tr '[:upper:]' '[:lower:]')"
case "$ATTENDED_FLAG_NORMALIZED" in
  true|1|yes|y|on)
    SHOULD_FORCE_HEADLESS=true
    ;;
  *)
    SHOULD_FORCE_HEADLESS=false
    ;;
esac

EXTRA_ARGS=()
if [ "$HAS_SCRIPT_DIR" = false ]; then
  EXTRA_ARGS+=(--script-dir "$SCRIPT_DIR")
fi
if [ "$MODE_ARG" = "listen" ] && [ "$HAS_HEADLESS" = false ] && [ "$SHOULD_FORCE_HEADLESS" = true ]; then
  EXTRA_ARGS+=(--headless true)
fi

if [ "$HAS_STATUS" = true ] || [ "$HAS_HELP" = true ]; then
  if [ "$SUPERVISOR_BIN" = "npx" ]; then
    exec npx "$SUPERVISOR_EXTRA" "$SUPERVISOR_TARGET" "$@" "${EXTRA_ARGS[@]}"
  fi
  exec "$SUPERVISOR_BIN" "$SUPERVISOR_TARGET" "$@" "${EXTRA_ARGS[@]}"
fi

RUNNER_COMMAND_ARG="${A2A_RUNNER_COMMAND:-}"
RUNNER_KIND_ARG="${A2A_RUNNER_KIND:-}"
if [ "$HAS_RUNNER" = false ]; then
  RESOLVED_RUNNER="$(resolve_runner_selection "$MODE_ARG" "$AGENT_LABEL_ARG" "$RUNNER_COMMAND_ARG" "$RUNNER_KIND_ARG")"
  RUNNER_KIND_ARG="$(printf '%s\n' "$RESOLVED_RUNNER" | sed -n '1p')"
  RUNNER_COMMAND_ARG="$(printf '%s\n' "$RESOLVED_RUNNER" | sed -n '2p')"
  EXTRA_ARGS+=(--runner-command "$RUNNER_COMMAND_ARG")
  if [ "$HAS_RUNNER_KIND" = false ] && [ -n "$RUNNER_KIND_ARG" ]; then
    EXTRA_ARGS+=(--runner-kind "$RUNNER_KIND_ARG")
  fi
elif [ "$HAS_RUNNER_KIND" = false ] && [ -n "$RUNNER_KIND_ARG" ]; then
  EXTRA_ARGS+=(--runner-kind "$RUNNER_KIND_ARG")
fi

if [ "$SUPERVISOR_BIN" = "npx" ]; then
  exec npx "$SUPERVISOR_EXTRA" "$SUPERVISOR_TARGET" "$@" "${EXTRA_ARGS[@]}"
fi

exec "$SUPERVISOR_BIN" "$SUPERVISOR_TARGET" "$@" "${EXTRA_ARGS[@]}"
