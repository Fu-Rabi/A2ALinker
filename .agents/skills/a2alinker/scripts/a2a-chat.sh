#!/bin/bash
# A2A Linker — Interactive Chat Script
# Resolves the active session role and runs the a2a-loop.sh blocking chat interface.
# Usage: bash .agents/skills/a2alinker/scripts/a2a-chat.sh [host|join] "Your message [OVER]"
# Usage: bash .agents/skills/a2alinker/scripts/a2a-chat.sh [host|join]  (just wait for a message)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/a2a-common.sh"

ROLE=""
MESSAGE=""
RESUME_NOTICE=""
OUTPUT=""
STATUS=0
RECOVERY_WAIT_RESULT=""
RECOVERY_WAIT_TIMEOUT="${A2A_INFLIGHT_RECOVERY_WAIT_TIMEOUT:-5}"

if [ "$1" = "host" ] || [ "$1" = "join" ]; then
  ROLE="$1"
  MESSAGE="${2:-}"
else
  ROLE="$(a2a_resolve_role)"
  MESSAGE="${1:-}"
fi

if [ -z "$ROLE" ]; then
  echo "ERROR: Not connected. No active role token found." >&2
  exit 1
fi

a2a_prompt_for_debug_if_interactive
a2a_debug_log "$ROLE" "chat:start message_present=$([ -n "$MESSAGE" ] && echo yes || echo no)"

stop_passive_waiter() {
  local role="$1"
  local pid_path pid pgid target_pids
  pid_path="$(a2a_waiter_pid_path_for_role "$role" 2>/dev/null || true)"
  if [ -z "$pid_path" ] || [ ! -f "$pid_path" ]; then
    return 0
  fi
  pid="$(cat "$pid_path" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    a2a_debug_log "$role" "chat:stop_passive_waiter pid=$pid"
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
    if [ -n "$pgid" ]; then
      a2a_debug_log "$role" "chat:stop_passive_waiter pgid=$pgid"
      kill -- "-$pgid" 2>/dev/null || true
    fi
    if [ -n "$target_pids" ]; then
      a2a_debug_log "$role" "chat:stop_passive_waiter descendants=$(printf '%s' "$target_pids" | tr '\n' ' ')"
      printf '%s\n' "$target_pids" | while IFS= read -r child_pid; do
        [ -n "$child_pid" ] || continue
        kill "$child_pid" 2>/dev/null || true
      done
    fi
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6; do
      if ! ps -p "$pid" >/dev/null 2>&1; then
        if [ -z "$pgid" ] || ! ps -axo pgid= | tr -d '[:space:]' | grep -qx "$pgid"; then
          if [ -z "$target_pids" ] || ! printf '%s\n' "$target_pids" | while IFS= read -r child_pid; do
            [ -n "$child_pid" ] || continue
            if ps -p "$child_pid" >/dev/null 2>&1; then
              exit 1
            fi
          done; then
            :
          else
            sleep 1
            continue
          fi
        else
          sleep 1
          continue
        fi
        break
      fi
      sleep 1
    done
    if ps -p "$pid" >/dev/null 2>&1 || { [ -n "$pgid" ] && ps -axo pgid= | tr -d '[:space:]' | grep -qx "$pgid"; }; then
      if [ -n "$pgid" ]; then
        kill -9 -- "-$pgid" 2>/dev/null || true
      fi
      if [ -n "$target_pids" ]; then
        printf '%s\n' "$target_pids" | while IFS= read -r child_pid; do
          [ -n "$child_pid" ] || continue
          kill -9 "$child_pid" 2>/dev/null || true
        done
      fi
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$pid_path"
  a2a_debug_log "$role" "chat:stop_passive_waiter_complete"
}

sync_passive_waiter_artifact() {
  local role="$1"
  local pid_path artifact_path pid
  [ "$role" = "host" ] || return 0
  pid_path="$(a2a_waiter_pid_path_for_role "$role" 2>/dev/null || true)"
  artifact_path="$(a2a_artifact_path_for_role "$role" 2>/dev/null || true)"
  if [ -z "$pid_path" ] || [ -z "$artifact_path" ] || [ ! -f "$pid_path" ] || [ ! -f "$artifact_path" ]; then
    return 0
  fi
  pid="$(cat "$pid_path" 2>/dev/null || true)"
  if [ -z "$pid" ]; then
    return 0
  fi
  node -e '
    const fs = require("fs");
    const artifactPath = process.argv[1];
    const pid = Number(process.argv[2]);
    const data = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    data.status = "waiting_for_local_task";
    data.lastEvent = "waiting_for_local_task";
    data.pid = pid;
    data.error = null;
    data.updatedAt = new Date().toISOString();
    fs.writeFileSync(artifactPath, JSON.stringify(data, null, 2));
  ' "$artifact_path" "$pid" >/dev/null 2>&1 || true
}

start_passive_waiter() {
  local role="$1"
  local pending_path
  pending_path="$(a2a_pending_message_path_for_role "$role" 2>/dev/null || true)"
  if [ -n "$pending_path" ] && [ -s "$pending_path" ]; then
    a2a_debug_log "$role" "chat:start_passive_waiter skipped=pending_message"
    return 0
  fi
  if command -v setsid >/dev/null 2>&1; then
    nohup setsid bash "$SCRIPT_DIR/a2a-passive-wait.sh" "$role" </dev/null >/dev/null 2>&1 &
  else
    nohup bash "$SCRIPT_DIR/a2a-passive-wait.sh" "$role" </dev/null >/dev/null 2>&1 &
  fi
  sleep 1
  sync_passive_waiter_artifact "$role"
  a2a_debug_log "$role" "chat:start_passive_waiter started"
}

should_restart_passive_waiter() {
  local output="$1"
  case "$output" in
    *TIMEOUT_ROOM_CLOSED*|*"Session ended."*|*"has left the room. Session ended."*|*WAIT_ALREADY_PENDING*|*WAIT_BROKER_DRAINING*|*WAIT_UNAUTHORIZED*)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

update_host_artifact_state() {
  local status="$1"
  local last_event="$2"
  local pid_value="${3:-null}"
  local error_text="${4:-}"
  local artifact_path
  artifact_path="$(a2a_artifact_path_for_role host 2>/dev/null || true)"
  if [ -z "$artifact_path" ] || [ ! -f "$artifact_path" ]; then
    return 0
  fi
  node -e '
    const fs = require("fs");
    const artifactPath = process.argv[1];
    const status = process.argv[2];
    const lastEvent = process.argv[3];
    const pidValue = process.argv[4];
    const errorText = process.argv[5];
    const data = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    data.status = status;
    data.lastEvent = lastEvent;
    data.pid = pidValue === "null" ? null : Number(pidValue);
    data.error = errorText || null;
    data.updatedAt = new Date().toISOString();
    fs.writeFileSync(artifactPath, JSON.stringify(data, null, 2));
  ' "$artifact_path" "$status" "$last_event" "$pid_value" "$error_text" >/dev/null 2>&1 || true
}

clear_inflight_message() {
  local role="$1"
  local inflight_path
  inflight_path="$(a2a_inflight_message_path_for_role "$role" 2>/dev/null || true)"
  if [ -n "$inflight_path" ]; then
    rm -f "$inflight_path"
  fi
}

recover_inflight_reply_once() {
  local role="$1"
  if [ "$role" != "host" ]; then
    return 1
  fi
  A2A_WAIT_POLL_TIMEOUT="$RECOVERY_WAIT_TIMEOUT" bash "$SCRIPT_DIR/a2a-wait-message.sh" "$role" || true
}

restore_host_waiter_on_exit() {
  local exit_code="${1:-0}"
  if [ "$ROLE" != "host" ]; then
    return 0
  fi
  if [ "${A2A_CHAT_CLEAN_EXIT:-0}" = "1" ]; then
    return 0
  fi
  a2a_debug_log "$ROLE" "chat:restore_on_exit exit_code=$exit_code"
  if should_restart_passive_waiter "$OUTPUT"; then
    start_passive_waiter "$ROLE"
  fi
  exit "$exit_code"
}

if [ "$ROLE" = "host" ]; then
  stop_passive_waiter "$ROLE"
  update_host_artifact_state "connected" "foreground_chat_active" "null" ""
  trap 'restore_host_waiter_on_exit $?' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  if [ -n "$MESSAGE" ]; then
    INFLIGHT_PATH="$(a2a_inflight_message_path_for_role "$ROLE" 2>/dev/null || true)"
    if [ -n "$INFLIGHT_PATH" ] && [ -f "$INFLIGHT_PATH" ]; then
      INFLIGHT_MESSAGE="$(cat "$INFLIGHT_PATH" 2>/dev/null || true)"
      if [ -n "$INFLIGHT_MESSAGE" ] && [ "$INFLIGHT_MESSAGE" = "$MESSAGE" ]; then
        a2a_debug_log "$ROLE" "chat:resume_inflight same_message_detected"
        RESUME_NOTICE="NOTICE: Previous host send was already delivered before interruption. Checking once for a recoverable partner reply before resending."
        PENDING_PATH="$(a2a_pending_message_path_for_role "$ROLE" 2>/dev/null || true)"
        if [ -n "$PENDING_PATH" ] && [ -s "$PENDING_PATH" ]; then
          OUTPUT="$(cat "$PENDING_PATH")"
          rm -f "$PENDING_PATH"
          clear_inflight_message "$ROLE"
          if should_restart_passive_waiter "$OUTPUT"; then
            start_passive_waiter "$ROLE"
          fi
          A2A_CHAT_CLEAN_EXIT=1
          printf '%s\n' "$RESUME_NOTICE"
          printf '%s\n' "$OUTPUT"
          exit 0
        fi
        RECOVERY_WAIT_RESULT="$(recover_inflight_reply_once "$ROLE")"
        a2a_debug_log "$ROLE" "chat:resume_inflight wait_result=$(printf '%s' "$RECOVERY_WAIT_RESULT" | head -n 1)"
        case "$RECOVERY_WAIT_RESULT" in
          MESSAGE_RECEIVED*)
            OUTPUT="$RECOVERY_WAIT_RESULT"
            clear_inflight_message "$ROLE"
            if should_restart_passive_waiter "$OUTPUT"; then
              start_passive_waiter "$ROLE"
            fi
            A2A_CHAT_CLEAN_EXIT=1
            printf '%s\n' "$RESUME_NOTICE"
            printf '%s\n' "$OUTPUT"
            exit 0
            ;;
          TIMEOUT_ROOM_CLOSED*)
            OUTPUT="$RECOVERY_WAIT_RESULT"
            clear_inflight_message "$ROLE"
            if should_restart_passive_waiter "$OUTPUT"; then
              start_passive_waiter "$ROLE"
            fi
            A2A_CHAT_CLEAN_EXIT=1
            printf '%s\n' "$RESUME_NOTICE"
            printf '%s\n' "$OUTPUT"
            exit 0
            ;;
          *)
            RESUME_NOTICE="NOTICE: Previous host send was already delivered before interruption. No reply was recoverable within ${RECOVERY_WAIT_TIMEOUT}s, so the message will be resent once."
            ;;
        esac
      fi
    fi
  fi

  if [ -z "$MESSAGE" ]; then
    PENDING_PATH="$(a2a_pending_message_path_for_role "$ROLE" 2>/dev/null || true)"
    if [ -n "$PENDING_PATH" ] && [ -s "$PENDING_PATH" ]; then
      OUTPUT="$(cat "$PENDING_PATH")"
      a2a_debug_log "$ROLE" "chat:consume_pending first_line=$(printf '%s' "$OUTPUT" | head -n 1)"
      rm -f "$PENDING_PATH"
      clear_inflight_message "$ROLE"
      if should_restart_passive_waiter "$OUTPUT"; then
        start_passive_waiter "$ROLE"
      fi
      A2A_CHAT_CLEAN_EXIT=1
      if [ -n "$RESUME_NOTICE" ]; then
        printf '%s\n' "$RESUME_NOTICE"
      fi
      printf '%s\n' "$OUTPUT"
      exit 0
    fi
  fi
fi

OUTPUT="$(bash "$SCRIPT_DIR/a2a-loop.sh" "$ROLE" "$MESSAGE")"
STATUS=$?
a2a_debug_log "$ROLE" "chat:loop_complete status=$STATUS first_line=$(printf '%s' "$OUTPUT" | head -n 1)"

if [ "$STATUS" -eq 0 ] && [ "$ROLE" = "host" ]; then
  clear_inflight_message "$ROLE"
  case "$OUTPUT" in
    *WAIT_ALREADY_PENDING*)
      update_host_artifact_state "error" "WAIT_ALREADY_PENDING" "null" "$OUTPUT"
      ;;
    *WAIT_BROKER_DRAINING*)
      update_host_artifact_state "error" "WAIT_BROKER_DRAINING" "null" "$OUTPUT"
      ;;
    *WAIT_UNAUTHORIZED*)
      update_host_artifact_state "error" "WAIT_UNAUTHORIZED" "null" "$OUTPUT"
      ;;
  esac
fi

if [ "$ROLE" = "host" ] && should_restart_passive_waiter "$OUTPUT"; then
  start_passive_waiter "$ROLE"
fi

A2A_CHAT_CLEAN_EXIT=1
if [ -n "$RESUME_NOTICE" ]; then
  printf '%s\n' "$RESUME_NOTICE"
fi
printf '%s\n' "$OUTPUT"
exit "$STATUS"
