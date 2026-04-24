#!/bin/bash
# A2A Linker — Leave Session Script
# Cleanly disconnects the current agent from the relay room.
# Refuses to close an active session unless explicitly authorized by the local human
# or invoked by internal supervisor cleanup after the session is already ending.
# Usage: bash .agents/skills/a2alinker/scripts/a2a-leave.sh [host|join|listen]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/a2a-common.sh"
ROLE="${1:-host}"
ORIGINAL_ROLE="$ROLE"
case "$ROLE" in
  listen)
    ROLE="join"
    ;;
  host|join)
    ;;
  *)
    echo "LEAVE_ERROR: Unsupported role '$ROLE'. Use host, join, or listen."
    exit 1
    ;;
esac
BASE_URL="$(a2a_resolve_active_base_url_for_role "$ROLE")"
TOKEN_FILE="/tmp/a2a_${ROLE}_token"
BACKUP_TOKEN_FILE=""
ARTIFACT_PATH=""
SESSION_DIR=""
ARTIFACT_ROLE="$ORIGINAL_ROLE"
ALLOW_CLOSE="${A2A_ALLOW_CLOSE:-}"
FORCE_CLEANUP="${A2A_FORCE_CLEANUP:-}"

stop_passive_waiter() {
  local runtime_role="$1"
  local pid_path="$2"
  local pid pgid target_pids tree_alive

  if [ ! -f "$pid_path" ]; then
    return 0
  fi

  pid="$(cat "$pid_path" 2>/dev/null || true)"
  rm -f "$pid_path"
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi

  a2a_debug_log "$runtime_role" "leave:stop_passive_waiter pid=$pid"
  pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
  target_pids="$(ps -axo pid=,ppid= | awk -v root="$pid" '
    function walk(parent) {
      for (candidate in seen) {
        if (seen[candidate] == parent && !printed[candidate]) {
          printed[candidate] = 1
          print candidate
          walk(candidate)
        }
      }
    }
    {
      seen[$1] = $2
    }
    END {
      walk(root)
    }
  ' 2>/dev/null || true)"
  if [ -n "$pgid" ] && [ "$pgid" = "$pid" ]; then
    a2a_debug_log "$runtime_role" "leave:stop_passive_waiter pgid=$pgid"
    kill -- "-$pgid" 2>/dev/null || true
  fi
  for child_pid in $target_pids; do
    kill "$child_pid" 2>/dev/null || true
  done
  kill "$pid" 2>/dev/null || true

  for _ in 1 2 3 4 5 6; do
    tree_alive=0
    if ps -p "$pid" >/dev/null 2>&1; then
      tree_alive=1
    fi
    if [ "$tree_alive" -eq 0 ] && [ -n "$pgid" ] && [ "$pgid" = "$pid" ] && ps -axo pgid= | tr -d '[:space:]' | grep -qx "$pgid"; then
      tree_alive=1
    fi
    if [ "$tree_alive" -eq 0 ]; then
      for child_pid in $target_pids; do
        if ps -p "$child_pid" >/dev/null 2>&1; then
          tree_alive=1
          break
        fi
      done
    fi
    if [ "$tree_alive" -eq 0 ]; then
      a2a_debug_log "$runtime_role" "leave:stop_passive_waiter_complete"
      return 0
    fi
    sleep 1
  done

  if [ -n "$pgid" ] && [ "$pgid" = "$pid" ]; then
    kill -9 -- "-$pgid" 2>/dev/null || true
  fi
  for child_pid in $target_pids; do
    kill -9 "$child_pid" 2>/dev/null || true
  done
  kill -9 "$pid" 2>/dev/null || true
  a2a_debug_log "$runtime_role" "leave:stop_passive_waiter_complete"
}

cleanup_session_runtime_state() {
  local runtime_role="$1"
  local session_dir="$2"
  if [ -z "$session_dir" ]; then
    return 0
  fi

  stop_passive_waiter "$runtime_role" "$session_dir/a2a_${runtime_role}_passive_wait.pid"
  rm -f "$session_dir/a2a_${runtime_role}_pending_message.txt"
  rm -f "$session_dir/a2a_${runtime_role}_inflight_message.txt"
}

if [ "$FORCE_CLEANUP" != "true" ] && [ "$ALLOW_CLOSE" != "true" ]; then
  echo "LEAVE_DENIED: Refusing to close the A2A session without explicit local human instruction."
  echo "NEXT_STEP: If the human clearly instructed you to close the session, re-run with A2A_ALLOW_CLOSE=true."
  exit 1
fi

case "$ORIGINAL_ROLE" in
  host)
    ARTIFACT_PATH="${PWD}/.a2a-host-session.json"
    ;;
  join)
    ARTIFACT_PATH="${PWD}/.a2a-join-session.json"
    ;;
  listen)
    ARTIFACT_PATH="${PWD}/.a2a-listener-session.json"
    ;;
esac

if [ -n "$ARTIFACT_PATH" ] && [ -f "$ARTIFACT_PATH" ]; then
  SESSION_DIR=$(a2a_read_field_from_artifact "$ARTIFACT_PATH" "sessionDir" || true)
  if [ -n "${SESSION_DIR:-}" ]; then
    BACKUP_TOKEN_FILE="$SESSION_DIR/a2a_${ROLE}_token"
    TOKEN=$(cat "$BACKUP_TOKEN_FILE" 2>/dev/null)
  fi
fi

if [ -z "$TOKEN" ]; then
  TOKEN=$(a2a_read_primary_token "$ROLE" 2>/dev/null || true)
fi

if [ -z "$TOKEN" ]; then
  STATUS_MODE="$ORIGINAL_ROLE"
  echo "LEAVE_ERROR: No token found at $TOKEN_FILE or in the local session backup."
  echo "NEXT_STEP: Use bash .agents/skills/a2alinker/scripts/a2a-supervisor.sh --mode $STATUS_MODE --status to inspect local session state."
  exit 1
fi

RESP=$(curl --max-time 5 -s -X POST "$BASE_URL/leave" \
  -H "Authorization: Bearer $TOKEN")

cleanup_session_runtime_state "$ROLE" "$SESSION_DIR"
rm -f "$TOKEN_FILE"
if [ -n "$BACKUP_TOKEN_FILE" ]; then
  rm -f "$BACKUP_TOKEN_FILE"
fi
a2a_clear_role_base_url "$ROLE"
a2a_update_artifact_state "$ARTIFACT_ROLE" "closed" "system_closed" "null" "" ""
echo "LEFT"
exit 0
