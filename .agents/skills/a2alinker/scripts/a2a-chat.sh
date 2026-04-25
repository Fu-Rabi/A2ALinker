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
PARK_MODE=0
HAD_PASSIVE_WAITER=0
RESTORE_WAITER_ON_EXIT=0
RESTORE_WAIT_STATUS=""
RESTORE_WAIT_EVENT=""
RESTORE_WAIT_NOTICE=""

if [ "$(printf '%s' "${A2A_CHAT_MODE:-}" | tr '[:upper:]' '[:lower:]')" = "park" ]; then
  PARK_MODE=1
fi
if [ "${1:-}" = "--park" ]; then
  PARK_MODE=1
  shift
fi

if [ "${1:-}" = "host" ] || [ "${1:-}" = "join" ]; then
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
a2a_debug_log "$ROLE" "chat:start park_mode=$([ "$PARK_MODE" -eq 1 ] && echo yes || echo no) message_present=$([ -n "$MESSAGE" ] && echo yes || echo no)"

default_wait_state_for_role() {
  local role="$1"
  case "$role" in
    join)
      printf '%s\n' "waiting_for_host_message"
      ;;
    *)
      printf '%s\n' "waiting_for_local_task"
      ;;
  esac
}

passive_waiter_running() {
  local role="$1"
  local pid_path pid
  pid_path="$(a2a_waiter_pid_path_for_role "$role" 2>/dev/null || true)"
  if [ -z "$pid_path" ] || [ ! -f "$pid_path" ]; then
    return 1
  fi
  pid="$(cat "$pid_path" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

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
  local wait_status="$2"
  local wait_event="$3"
  local wait_notice="${4-}"
  local pid_path pid
  pid_path="$(a2a_waiter_pid_path_for_role "$role" 2>/dev/null || true)"
  if [ -z "$pid_path" ] || [ ! -f "$pid_path" ]; then
    return 0
  fi
  pid="$(cat "$pid_path" 2>/dev/null || true)"
  if [ -z "$pid" ]; then
    return 0
  fi
  a2a_update_artifact_state "$role" "$wait_status" "$wait_event" "$pid" "" "$wait_notice"
}

start_passive_waiter() {
  local role="$1"
  local wait_status="${2:-$(default_wait_state_for_role "$role")}"
  local wait_event="${3:-$wait_status}"
  local wait_notice="${4-}"
  local pending_path
  if [ $# -lt 4 ]; then
    wait_notice="$(a2a_wait_notice_for_role_state "$role" "$wait_status")"
  fi
  pending_path="$(a2a_pending_message_path_for_role "$role" 2>/dev/null || true)"
  if [ -n "$pending_path" ] && [ -s "$pending_path" ]; then
    a2a_debug_log "$role" "chat:start_passive_waiter skipped=pending_message"
    a2a_update_artifact_state "$role" "waiting_for_local_task" "waiting_for_local_task" "null" "" "$(a2a_pending_message_notice_for_role "$role")"
    return 0
  fi
  if command -v setsid >/dev/null 2>&1; then
    A2A_PASSIVE_WAIT_STATUS="$wait_status" \
      A2A_PASSIVE_WAIT_EVENT="$wait_event" \
      A2A_PASSIVE_WAIT_NOTICE="$wait_notice" \
      nohup setsid bash "$SCRIPT_DIR/a2a-passive-wait.sh" "$role" </dev/null >/dev/null 2>&1 &
  else
    A2A_PASSIVE_WAIT_STATUS="$wait_status" \
      A2A_PASSIVE_WAIT_EVENT="$wait_event" \
      A2A_PASSIVE_WAIT_NOTICE="$wait_notice" \
      nohup bash "$SCRIPT_DIR/a2a-passive-wait.sh" "$role" </dev/null >/dev/null 2>&1 &
  fi
  sleep 1
  sync_passive_waiter_artifact "$role" "$wait_status" "$wait_event" "$wait_notice"
  a2a_debug_log "$role" "chat:start_passive_waiter started status=$wait_status"
}

should_restart_passive_waiter() {
  local output="$1"
  if a2a_output_is_terminal_close "$output"; then
    return 1
  fi
  case "$output" in
    *WAIT_ALREADY_PENDING*|*WAIT_BROKER_DRAINING*|*WAIT_UNAUTHORIZED*)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

apply_output_artifact_state() {
  local role="$1"
  local output="$2"
  local pending_path

  if a2a_output_is_terminal_close "$output"; then
    a2a_update_artifact_state "$role" "closed" "$(a2a_output_close_event_name "$output")" "null" "" ""
    return 0
  fi

  case "$output" in
    *WAIT_ALREADY_PENDING*)
      a2a_update_artifact_state "$role" "error" "WAIT_ALREADY_PENDING" "null" "$output" ""
      ;;
    *WAIT_BROKER_DRAINING*)
      a2a_update_artifact_state "$role" "error" "WAIT_BROKER_DRAINING" "null" "$output" ""
      ;;
    *WAIT_UNAUTHORIZED*)
      a2a_update_artifact_state "$role" "error" "WAIT_UNAUTHORIZED" "null" "$output" ""
      ;;
    *MESSAGE_RECEIVED*)
      if [ "$role" = "join" ]; then
        pending_path="$(a2a_pending_message_path_for_role "$role" 2>/dev/null || true)"
        if [ -n "$pending_path" ] && [ -s "$pending_path" ]; then
          a2a_update_artifact_state "$role" "waiting_for_local_task" "waiting_for_local_task" "null" "" "$(a2a_pending_message_notice_for_role "$role")"
        else
          a2a_update_artifact_state "$role" "connected" "waiting_for_local_task" "null" "" ""
        fi
      fi
      ;;
  esac
}

clear_inflight_message() {
  local role="$1"
  local inflight_path
  inflight_path="$(a2a_inflight_message_path_for_role "$role" 2>/dev/null || true)"
  if [ -n "$inflight_path" ]; then
    rm -f "$inflight_path"
  fi
}

write_inflight_message() {
  local role="$1"
  local message="$2"
  local inflight_path
  inflight_path="$(a2a_inflight_message_path_for_role "$role" 2>/dev/null || true)"
  if [ -z "$inflight_path" ]; then
    return 0
  fi
  mkdir -p "$(dirname "$inflight_path")"
  printf '%s\n' "$message" > "$inflight_path"
}

recoverable_output_for_role() {
  local output="$1"
  printf '%s\n' "$output" | grep -Eq '^(MESSAGE_RECEIVED|TIMEOUT_ROOM_CLOSED|WAIT_ALREADY_PENDING|WAIT_BROKER_DRAINING|WAIT_UNAUTHORIZED)'
}

write_last_foreground_output() {
  local role="$1"
  local output="$2"
  local session_dir output_path tmp_path
  session_dir="$(a2a_session_dir_for_role "$role" 2>/dev/null || true)"
  if [ -z "$session_dir" ]; then
    return 0
  fi
  output_path="$session_dir/a2a_${role}_last_foreground_output.txt"
  tmp_path="${output_path}.tmp"
  mkdir -p "$session_dir"
  printf '%s\n' "$output" > "$tmp_path"
  mv "$tmp_path" "$output_path"
}

stage_pending_output_for_print() {
  local role="$1"
  local output="$2"
  local pending_path tmp_path
  if ! recoverable_output_for_role "$output"; then
    return 0
  fi
  write_last_foreground_output "$role" "$output"
  pending_path="$(a2a_pending_message_path_for_role "$role" 2>/dev/null || true)"
  if [ -z "$pending_path" ]; then
    return 0
  fi
  tmp_path="${pending_path}.tmp"
  mkdir -p "$(dirname "$pending_path")"
  printf '%s\n' "$output" > "$tmp_path"
  mv "$tmp_path" "$pending_path"
  a2a_update_artifact_state "$role" "waiting_for_local_task" "waiting_for_local_task" "null" "" "$(a2a_pending_message_notice_for_role "$role")"
  a2a_debug_log "$role" "chat:stage_pending_output first_line=$(printf '%s' "$output" | head -n 1)"
}

clear_pending_message_for_outbound() {
  local role="$1"
  local pending_path
  pending_path="$(a2a_pending_message_path_for_role "$role" 2>/dev/null || true)"
  if [ -z "$pending_path" ] || [ ! -f "$pending_path" ]; then
    return 0
  fi
  rm -f "$pending_path"
  a2a_debug_log "$role" "chat:clear_pending_for_outbound"
}

print_output_recoverably() {
  local role="$1"
  local output="$2"
  local rc
  stage_pending_output_for_print "$role" "$output"
  a2a_debug_log "$role" "chat:print_output_start first_line=$(printf '%s' "$output" | head -n 1)"
  if printf '%s\n' "$output"; then
    rc=0
  else
    rc=$?
  fi
  a2a_debug_log "$role" "chat:print_output_complete status=$rc first_line=$(printf '%s' "$output" | head -n 1)"
  return "$rc"
}

recover_inflight_reply_once() {
  local role="$1"
  if [ "$role" != "host" ]; then
    return 1
  fi
  A2A_WAIT_POLL_TIMEOUT="$RECOVERY_WAIT_TIMEOUT" bash "$SCRIPT_DIR/a2a-wait-message.sh" "$role" || true
}

should_restore_waiter() {
  if [ "$ROLE" = "host" ] || [ "$HAD_PASSIVE_WAITER" = "1" ] || [ "$RESTORE_WAITER_ON_EXIT" = "1" ]; then
    return 0
  fi
  return 1
}

restore_passive_waiter_on_exit() {
  local exit_code="${1:-0}"
  if ! should_restore_waiter; then
    return 0
  fi
  if [ "${A2A_CHAT_CLEAN_EXIT:-0}" = "1" ]; then
    return 0
  fi
  a2a_debug_log "$ROLE" "chat:restore_on_exit exit_code=$exit_code"
  if should_restart_passive_waiter "$OUTPUT"; then
    start_passive_waiter "$ROLE" "$RESTORE_WAIT_STATUS" "$RESTORE_WAIT_EVENT" "$RESTORE_WAIT_NOTICE"
  fi
  exit "$exit_code"
}

park_session() {
  local wait_status wait_event wait_notice send_output send_status
  if [ -n "$MESSAGE" ]; then
    wait_status="waiting_for_partner_reply"
    wait_event="waiting_for_partner_reply"
    wait_notice="$(a2a_wait_notice_for_role_state "$ROLE" "$wait_status")"
    INFLIGHT_PATH="$(a2a_inflight_message_path_for_role "$ROLE" 2>/dev/null || true)"
    if [ -n "$INFLIGHT_PATH" ] && [ -f "$INFLIGHT_PATH" ]; then
      INFLIGHT_MESSAGE="$(cat "$INFLIGHT_PATH" 2>/dev/null || true)"
      if [ -n "$INFLIGHT_MESSAGE" ] && [ "$INFLIGHT_MESSAGE" = "$MESSAGE" ]; then
        a2a_debug_log "$ROLE" "chat:park_resume_inflight same_message_detected"
        RESTORE_WAITER_ON_EXIT=1
        RESTORE_WAIT_STATUS="$wait_status"
        RESTORE_WAIT_EVENT="$wait_event"
        RESTORE_WAIT_NOTICE="$wait_notice"
        start_passive_waiter "$ROLE" "$wait_status" "$wait_event" "$wait_notice"
        A2A_CHAT_CLEAN_EXIT=1
        printf '%s\n' "PARKED: $wait_notice"
        exit 0
      fi
    fi
    send_output="$(bash "$SCRIPT_DIR/a2a-send.sh" "$ROLE" "$MESSAGE")"
    send_status=$?
    printf '%s\n' "$send_output"
    if [ "$send_status" -ne 0 ]; then
      exit "$send_status"
    fi
    write_inflight_message "$ROLE" "$MESSAGE"
  else
    wait_status="$(default_wait_state_for_role "$ROLE")"
    wait_event="$wait_status"
    wait_notice="$(a2a_wait_notice_for_role_state "$ROLE" "$wait_status")"
  fi

  if [ -z "${wait_status:-}" ]; then
    wait_status="$(default_wait_state_for_role "$ROLE")"
    wait_event="$wait_status"
    wait_notice="$(a2a_wait_notice_for_role_state "$ROLE" "$wait_status")"
  fi

  RESTORE_WAITER_ON_EXIT=1
  RESTORE_WAIT_STATUS="$wait_status"
  RESTORE_WAIT_EVENT="$wait_event"
  RESTORE_WAIT_NOTICE="$wait_notice"
  start_passive_waiter "$ROLE" "$wait_status" "$wait_event" "$wait_notice"
  A2A_CHAT_CLEAN_EXIT=1
  printf '%s\n' "PARKED: $wait_notice"
  exit 0
}

if passive_waiter_running "$ROLE"; then
  HAD_PASSIVE_WAITER=1
  ARTIFACT_PATH="$(a2a_artifact_path_for_role "$ROLE" 2>/dev/null || true)"
  if [ -n "$ARTIFACT_PATH" ] && [ -f "$ARTIFACT_PATH" ]; then
    RESTORE_WAIT_STATUS="$(a2a_read_field_from_artifact "$ARTIFACT_PATH" "status" 2>/dev/null || true)"
    RESTORE_WAIT_EVENT="$(a2a_read_field_from_artifact "$ARTIFACT_PATH" "lastEvent" 2>/dev/null || true)"
    RESTORE_WAIT_NOTICE="$(a2a_read_field_from_artifact "$ARTIFACT_PATH" "notice" 2>/dev/null || true)"
  fi
fi

if [ "$ROLE" = "host" ] || [ "$HAD_PASSIVE_WAITER" = "1" ]; then
  stop_passive_waiter "$ROLE"
fi

if [ -z "$RESTORE_WAIT_STATUS" ]; then
  RESTORE_WAIT_STATUS="$(default_wait_state_for_role "$ROLE")"
fi
if [ -z "$RESTORE_WAIT_EVENT" ]; then
  RESTORE_WAIT_EVENT="$RESTORE_WAIT_STATUS"
fi
if [ -z "$RESTORE_WAIT_NOTICE" ]; then
  RESTORE_WAIT_NOTICE="$(a2a_wait_notice_for_role_state "$ROLE" "$RESTORE_WAIT_STATUS")"
fi

a2a_update_artifact_state "$ROLE" "connected" "foreground_chat_active" "null" "" ""
trap 'restore_passive_waiter_on_exit $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$ROLE" = "host" ]; then

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
          printf '%s\n' "$RESUME_NOTICE"
          print_output_recoverably "$ROLE" "$OUTPUT" || exit $?
          clear_inflight_message "$ROLE"
          apply_output_artifact_state "$ROLE" "$OUTPUT"
          if should_restart_passive_waiter "$OUTPUT"; then
            start_passive_waiter "$ROLE" "waiting_for_local_task" "waiting_for_local_task"
          fi
          A2A_CHAT_CLEAN_EXIT=1
          exit 0
        fi
        RECOVERY_WAIT_RESULT="$(recover_inflight_reply_once "$ROLE")"
        a2a_debug_log "$ROLE" "chat:resume_inflight wait_result=$(printf '%s' "$RECOVERY_WAIT_RESULT" | head -n 1)"
        case "$RECOVERY_WAIT_RESULT" in
          MESSAGE_RECEIVED*)
            OUTPUT="$RECOVERY_WAIT_RESULT"
            printf '%s\n' "$RESUME_NOTICE"
            print_output_recoverably "$ROLE" "$OUTPUT" || exit $?
            clear_inflight_message "$ROLE"
            apply_output_artifact_state "$ROLE" "$OUTPUT"
            if should_restart_passive_waiter "$OUTPUT"; then
              start_passive_waiter "$ROLE" "waiting_for_local_task" "waiting_for_local_task"
            fi
            A2A_CHAT_CLEAN_EXIT=1
            exit 0
            ;;
          TIMEOUT_ROOM_CLOSED*)
            OUTPUT="$RECOVERY_WAIT_RESULT"
            printf '%s\n' "$RESUME_NOTICE"
            print_output_recoverably "$ROLE" "$OUTPUT" || exit $?
            clear_inflight_message "$ROLE"
            apply_output_artifact_state "$ROLE" "$OUTPUT"
            if should_restart_passive_waiter "$OUTPUT"; then
              start_passive_waiter "$ROLE" "waiting_for_local_task" "waiting_for_local_task"
            fi
            A2A_CHAT_CLEAN_EXIT=1
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
      if [ -n "$RESUME_NOTICE" ]; then
        printf '%s\n' "$RESUME_NOTICE"
      fi
      print_output_recoverably "$ROLE" "$OUTPUT" || exit $?
      clear_inflight_message "$ROLE"
      apply_output_artifact_state "$ROLE" "$OUTPUT"
      if should_restart_passive_waiter "$OUTPUT"; then
        start_passive_waiter "$ROLE" "waiting_for_local_task" "waiting_for_local_task"
      fi
      A2A_CHAT_CLEAN_EXIT=1
      exit 0
    fi
  fi
fi

if [ -z "$MESSAGE" ]; then
  PENDING_PATH="$(a2a_pending_message_path_for_role "$ROLE" 2>/dev/null || true)"
  if [ -n "$PENDING_PATH" ] && [ -s "$PENDING_PATH" ]; then
    OUTPUT="$(cat "$PENDING_PATH")"
    a2a_debug_log "$ROLE" "chat:consume_pending first_line=$(printf '%s' "$OUTPUT" | head -n 1)"
    if [ -n "$RESUME_NOTICE" ]; then
      printf '%s\n' "$RESUME_NOTICE"
    fi
    print_output_recoverably "$ROLE" "$OUTPUT" || exit $?
    clear_inflight_message "$ROLE"
    apply_output_artifact_state "$ROLE" "$OUTPUT"
    A2A_CHAT_CLEAN_EXIT=1
    exit 0
  fi
fi

if [ -n "$MESSAGE" ]; then
  clear_pending_message_for_outbound "$ROLE"
fi

if [ "$PARK_MODE" -eq 1 ]; then
  park_session
fi

OUTPUT="$(bash "$SCRIPT_DIR/a2a-loop.sh" "$ROLE" "$MESSAGE")"
STATUS=$?
a2a_debug_log "$ROLE" "chat:loop_complete status=$STATUS first_line=$(printf '%s' "$OUTPUT" | head -n 1)"

if [ "$STATUS" -eq 0 ]; then
  if [ -n "$RESUME_NOTICE" ]; then
    printf '%s\n' "$RESUME_NOTICE"
  fi
  print_output_recoverably "$ROLE" "$OUTPUT" || exit $?
  clear_inflight_message "$ROLE"
  apply_output_artifact_state "$ROLE" "$OUTPUT"
else
  if [ -n "$RESUME_NOTICE" ]; then
    printf '%s\n' "$RESUME_NOTICE"
  fi
  printf '%s\n' "$OUTPUT"
fi

if [ "$ROLE" = "host" ] && should_restart_passive_waiter "$OUTPUT"; then
  start_passive_waiter "$ROLE" "waiting_for_local_task" "waiting_for_local_task"
fi

A2A_CHAT_CLEAN_EXIT=1
exit "$STATUS"
