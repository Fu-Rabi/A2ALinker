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

cleanup() {
  rm -f "$PID_PATH" "$TMP_PATH"
}

trap cleanup EXIT INT TERM

mkdir -p "$(dirname "$PENDING_PATH")"
printf '%s\n' "$$" > "$PID_PATH"
a2a_debug_log "$ROLE" "passive_wait:start pending_path=$PENDING_PATH"

while true; do
  RESULT="$(bash "$SCRIPT_DIR/a2a-wait-message.sh" "$ROLE" || true)"
  a2a_debug_log "$ROLE" "passive_wait:result first_line=$(printf '%s' "$RESULT" | head -n 1)"

  if [ -z "$RESULT" ]; then
    sleep 5
    continue
  fi

  case "$RESULT" in
    TIMEOUT_ROOM_ALIVE*)
      continue
      ;;
    TIMEOUT_PING_FAILED*)
      sleep 5
      continue
      ;;
    *)
      printf '%s\n' "$RESULT" > "$TMP_PATH"
      mv "$TMP_PATH" "$PENDING_PATH"
      a2a_debug_log "$ROLE" "passive_wait:stored_message first_line=$(printf '%s' "$RESULT" | head -n 1)"
      exit 0
      ;;
  esac
done
