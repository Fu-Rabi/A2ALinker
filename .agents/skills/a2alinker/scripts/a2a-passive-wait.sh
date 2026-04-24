#!/bin/bash
# A2A Linker — Passive Mailbox Waiter
# Keeps a background wait loop alive without sending replies. When a real
# inbound event arrives, it stores the raw loop output in the session mailbox.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/a2a-common.sh"

ROLE="${1:-host}"
PENDING_PATH="$(a2a_pending_message_path_for_role "$ROLE")"
PID_PATH="$(a2a_waiter_pid_path_for_role "$ROLE")"
TMP_PATH="${PENDING_PATH}.tmp"
WAIT_STATUS="${A2A_PASSIVE_WAIT_STATUS:-}"
WAIT_EVENT="${A2A_PASSIVE_WAIT_EVENT:-}"
WAIT_NOTICE="${A2A_PASSIVE_WAIT_NOTICE-}"
INACTIVITY_THRESHOLD_SECONDS="${A2A_PASSIVE_WAIT_INACTIVITY_THRESHOLD:-60}"
INACTIVITY_THRESHOLD_MS=$((INACTIVITY_THRESHOLD_SECONDS * 1000))
INACTIVITY_NOTICE_EMITTED=0
CURRENT_WAIT_PID=""
WAIT_RESULT_PATH=""

default_wait_status() {
  case "$ROLE" in
    join)
      printf '%s\n' "waiting_for_host_message"
      ;;
    *)
      printf '%s\n' "waiting_for_local_task"
      ;;
  esac
}

if [ -z "$WAIT_STATUS" ]; then
  WAIT_STATUS="$(default_wait_status)"
fi
if [ -z "$WAIT_EVENT" ]; then
  WAIT_EVENT="$WAIT_STATUS"
fi
if [ -z "${WAIT_NOTICE+x}" ]; then
  WAIT_NOTICE="$(a2a_wait_notice_for_role_state "$ROLE" "$WAIT_STATUS")"
fi

update_wait_artifact() {
  local status="$1"
  local last_event="$2"
  local pid_value="$3"
  local error_text="${4-}"
  local notice_text="${5-}"
  a2a_update_artifact_state "$ROLE" "$status" "$last_event" "$pid_value" "$error_text" "$notice_text"
}

handle_terminal_result() {
  local result="$1"
  if a2a_output_is_terminal_close "$result"; then
    update_wait_artifact "closed" "$(a2a_output_close_event_name "$result")" "null" "" ""
    return 0
  fi
  case "$result" in
    WAIT_ALREADY_PENDING*|WAIT_BROKER_DRAINING*|WAIT_UNAUTHORIZED*)
      local pending_event
      pending_event="$(printf '%s' "$result" | head -n 1)"
      update_wait_artifact "error" "$pending_event" "null" "$result" ""
      ;;
    *)
      update_wait_artifact "waiting_for_local_task" "waiting_for_local_task" "null" "" "$(a2a_pending_message_notice_for_role "$ROLE")"
      ;;
  esac
}

cleanup() {
  if [ -n "$CURRENT_WAIT_PID" ]; then
    kill "$CURRENT_WAIT_PID" 2>/dev/null || true
    wait "$CURRENT_WAIT_PID" 2>/dev/null || true
    CURRENT_WAIT_PID=""
  fi
  if [ -n "$WAIT_RESULT_PATH" ]; then
    rm -f "$WAIT_RESULT_PATH"
    WAIT_RESULT_PATH=""
  fi
  rm -f "$PID_PATH" "$TMP_PATH"
}

trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

mkdir -p "$(dirname "$PENDING_PATH")"
printf '%s\n' "$$" > "$PID_PATH"
update_wait_artifact "$WAIT_STATUS" "$WAIT_EVENT" "$$" "" "$WAIT_NOTICE"
a2a_debug_log "$ROLE" "passive_wait:start pending_path=$PENDING_PATH"

while true; do
  WAIT_RESULT_PATH="$(mktemp)"
  bash "$SCRIPT_DIR/a2a-wait-message.sh" "$ROLE" >"$WAIT_RESULT_PATH" &
  CURRENT_WAIT_PID=$!
  if wait "$CURRENT_WAIT_PID"; then
    WAIT_EXIT=0
  else
    WAIT_EXIT=$?
  fi
  RESULT="$(cat "$WAIT_RESULT_PATH" 2>/dev/null || true)"
  rm -f "$WAIT_RESULT_PATH"
  WAIT_RESULT_PATH=""
  CURRENT_WAIT_PID=""
  a2a_debug_log "$ROLE" "passive_wait:result first_line=$(printf '%s' "$RESULT" | head -n 1)"

  if [ -z "$RESULT" ]; then
    sleep 5
    continue
  fi

  case "$RESULT" in
    TIMEOUT_ROOM_ALIVE*)
      LAST_SEEN_MS="$(printf '%s' "$RESULT" | sed -En 's/.*last_seen_ms=([0-9]+).*/\1/p')"
      if [ "$INACTIVITY_NOTICE_EMITTED" -eq 0 ] && [ "${LAST_SEEN_MS:-0}" -ge "$INACTIVITY_THRESHOLD_MS" ]; then
        update_wait_artifact "$WAIT_STATUS" "$WAIT_EVENT" "$$" "" "$(a2a_inactivity_notice_for_role_state "$ROLE" "$WAIT_STATUS" "$INACTIVITY_THRESHOLD_SECONDS")"
        INACTIVITY_NOTICE_EMITTED=1
      fi
      continue
      ;;
    TIMEOUT_WAIT_EXPIRED*)
      continue
      ;;
    TIMEOUT_PING_FAILED*)
      sleep 5
      continue
      ;;
    *)
      printf '%s\n' "$RESULT" > "$TMP_PATH"
      mv "$TMP_PATH" "$PENDING_PATH"
      handle_terminal_result "$RESULT"
      a2a_debug_log "$ROLE" "passive_wait:stored_message first_line=$(printf '%s' "$RESULT" | head -n 1)"
      exit 0
      ;;
  esac
done
