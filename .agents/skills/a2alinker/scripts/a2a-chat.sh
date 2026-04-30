#!/bin/bash
# A2A Linker — Interactive Chat Script
# Resolves the active session role and runs the a2a-loop.sh blocking chat interface.
# Usage: bash .agents/skills/a2alinker/scripts/a2a-chat.sh [--surface-join-notice] [host|join] "Your message [OVER]"
# Usage: bash .agents/skills/a2alinker/scripts/a2a-chat.sh [--surface-join-notice] [host|join]  (just wait for a message)
# Usage: bash .agents/skills/a2alinker/scripts/a2a-chat.sh --pending-only [host|join]
# Add --notify-human to enable best-effort local OS notification for HOST join notices.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/a2a-common.sh"
ORIGINAL_ARGS=("$@")

ROLE=""
MESSAGE=""
RESUME_NOTICE=""
OUTPUT=""
STATUS=0
RECOVERY_WAIT_RESULT=""
RECOVERY_WAIT_TIMEOUT="${A2A_INFLIGHT_RECOVERY_WAIT_TIMEOUT:-5}"
PARK_MODE=0
SURFACE_JOIN_NOTICE=0
PENDING_ONLY=0
HAD_PASSIVE_WAITER=0
RESTORE_WAITER_ON_EXIT=0
RESTORE_WAIT_STATUS=""
RESTORE_WAIT_EVENT=""
RESTORE_WAIT_NOTICE=""

if [ "$(printf '%s' "${A2A_CHAT_MODE:-}" | tr '[:upper:]' '[:lower:]')" = "park" ]; then
  PARK_MODE=1
fi
case "$(printf '%s' "${A2A_SURFACE_JOIN_NOTICE:-false}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on)
    SURFACE_JOIN_NOTICE=1
    ;;
esac

while [ $# -gt 0 ]; do
  case "${1:-}" in
    --park)
      PARK_MODE=1
      shift
      ;;
    --surface-join-notice)
      SURFACE_JOIN_NOTICE=1
      shift
      ;;
    --pending-only)
      PENDING_ONLY=1
      shift
      ;;
    --notify-human)
      export A2A_HUMAN_NOTIFY=1
      shift
      ;;
    *)
      break
      ;;
  esac
done

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

a2a_debug_script_lifecycle_start "$ROLE" "a2a-chat.sh" "${ORIGINAL_ARGS[@]}"

host_join_notice_artifact_exists() {
  local artifact_path
  artifact_path="$(a2a_join_notification_artifact_path_for_role host 2>/dev/null || true)"
  [ -n "$artifact_path" ] && [ -s "$artifact_path" ]
}

host_session_has_invite() {
  local artifact_path invite_code
  artifact_path="$(a2a_artifact_path_for_role host 2>/dev/null || true)"
  if [ -z "$artifact_path" ] || [ ! -f "$artifact_path" ]; then
    return 1
  fi
  invite_code="$(a2a_read_field_from_artifact "$artifact_path" "inviteCode" 2>/dev/null || true)"
  [ -n "$invite_code" ] && [ "$invite_code" != "null" ]
}

host_pre_join_wait_required() {
  if [ "$ROLE" != "host" ]; then
    return 1
  fi
  if ! host_session_has_invite; then
    return 1
  fi
  if host_join_notice_artifact_exists; then
    return 1
  fi
  return 0
}

pending_only_recovery_required() {
  local role="$1"
  local artifact_path status error_text pid_value pid_path pid_file_value
  if [ "$role" != "host" ]; then
    return 1
  fi
  artifact_path="$(a2a_artifact_path_for_role "$role" 2>/dev/null || true)"
  if [ -z "$artifact_path" ] || [ ! -f "$artifact_path" ]; then
    return 1
  fi
  status="$(a2a_read_field_from_artifact "$artifact_path" "status" 2>/dev/null || true)"
  error_text="$(a2a_read_field_from_artifact "$artifact_path" "error" 2>/dev/null || true)"
  pid_value="$(a2a_read_field_from_artifact "$artifact_path" "pid" 2>/dev/null || true)"
  if [ "$status" = "stale_local_state" ]; then
    return 0
  fi
  case "$error_text" in
    *"no longer running"*|*"not running"*)
      return 0
      ;;
  esac
  if [ -n "$pid_value" ] && [ "$pid_value" != "null" ] && ! kill -0 "$pid_value" 2>/dev/null; then
    return 0
  fi
  pid_path="$(a2a_waiter_pid_path_for_role "$role" 2>/dev/null || true)"
  if [ -n "$pid_path" ] && [ -f "$pid_path" ]; then
    pid_file_value="$(cat "$pid_path" 2>/dev/null || true)"
    if [ -n "$pid_file_value" ] && ! kill -0 "$pid_file_value" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

if [ "$PENDING_ONLY" -eq 1 ]; then
  PENDING_PATH="$(a2a_pending_message_path_for_role "$ROLE" 2>/dev/null || true)"
  if [ -n "$PENDING_PATH" ] && [ -s "$PENDING_PATH" ]; then
    cat "$PENDING_PATH"
  elif pending_only_recovery_required "$ROLE"; then
    printf '%s\n' "RECOVERY_REQUIRED"
    printf '%s\n' "REASON: Local parked host waiter is not running and no join notice is staged."
    printf '%s\n' "NEXT_STEP: Reattach the surfaced host join wait with: bash .agents/skills/a2alinker/scripts/a2a-chat.sh --surface-join-notice host"
  else
    printf '%s\n' "NO_PENDING_MESSAGE"
  fi
  exit 0
fi

a2a_prompt_for_debug_if_interactive
a2a_debug_log "$ROLE" "chat:start park_mode=$([ "$PARK_MODE" -eq 1 ] && echo yes || echo no) surface_join_notice=$([ "$SURFACE_JOIN_NOTICE" -eq 1 ] && echo yes || echo no) message_present=$([ -n "$MESSAGE" ] && echo yes || echo no)"

default_wait_state_for_role() {
  local role="$1"
  case "$role" in
    join)
      printf '%s\n' "waiting_for_host_message"
      ;;
    *)
      if host_pre_join_wait_required; then
        printf '%s\n' "waiting_for_join"
      else
        printf '%s\n' "waiting_for_local_task"
      fi
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
  local pid_path pid pgid target_pids tree_stopped
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
      tree_stopped=1
      if ps -p "$pid" >/dev/null 2>&1; then
        tree_stopped=0
      fi
      if [ "$tree_stopped" -eq 1 ] && [ -n "$pgid" ] && ps -axo pgid= | tr -d '[:space:]' | grep -qx "$pgid"; then
        tree_stopped=0
      fi
      if [ "$tree_stopped" -eq 1 ] && [ -n "$target_pids" ]; then
        if printf '%s\n' "$target_pids" | while IFS= read -r child_pid; do
          [ -n "$child_pid" ] || continue
          if ps -p "$child_pid" >/dev/null 2>&1; then
            exit 1
          fi
        done; then
          :
        else
          tree_stopped=0
        fi
      fi
      if [ "$tree_stopped" -eq 1 ]; then
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
  tree_stopped=1
  if [ -n "$pid" ] && ps -p "$pid" >/dev/null 2>&1; then
    tree_stopped=0
  fi
  if [ "$tree_stopped" -eq 1 ] && [ -n "$pgid" ] && ps -axo pgid= | tr -d '[:space:]' | grep -qx "$pgid"; then
    tree_stopped=0
  fi
  if [ "$tree_stopped" -eq 1 ] && [ -n "$target_pids" ]; then
    if printf '%s\n' "$target_pids" | while IFS= read -r child_pid; do
      [ -n "$child_pid" ] || continue
      if ps -p "$child_pid" >/dev/null 2>&1; then
        exit 1
      fi
    done; then
      :
    else
      tree_stopped=0
    fi
  fi
  rm -f "$pid_path"
  a2a_debug_log "$role" "chat:stop_passive_waiter_complete stopped=$([ "$tree_stopped" -eq 1 ] && echo yes || echo no)"
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
  local pending_path pending_output pending_status pending_event pending_notice notify_tty waiter_pid launch_strategy
  if [ $# -lt 4 ]; then
    wait_notice="$(a2a_wait_notice_for_role_state "$role" "$wait_status")"
  fi
  pending_path="$(a2a_pending_message_path_for_role "$role" 2>/dev/null || true)"
  if [ -n "$pending_path" ] && [ -s "$pending_path" ]; then
    pending_output="$(cat "$pending_path" 2>/dev/null || true)"
    pending_status="$(a2a_pending_message_status_for_output "$role" "$pending_output")"
    pending_event="$(a2a_pending_message_event_for_output "$role" "$pending_output")"
    pending_notice="$(a2a_pending_message_notice_for_output "$role" "$pending_output")"
    a2a_debug_log "$role" "chat:start_passive_waiter skipped=pending_message"
    a2a_update_artifact_state "$role" "$pending_status" "$pending_event" "null" "" "$pending_notice"
    return 0
  fi
  if passive_waiter_running "$role"; then
    a2a_debug_log "$role" "chat:start_passive_waiter skipped=waiter_running"
    return 0
  fi
  notify_tty="$(a2a_capture_notification_tty 2>/dev/null || true)"
  if command -v setsid >/dev/null 2>&1; then
    launch_strategy="nohup+setsid"
    A2A_PASSIVE_WAIT_STATUS="$wait_status" \
      A2A_PASSIVE_WAIT_EVENT="$wait_event" \
      A2A_PASSIVE_WAIT_NOTICE="$wait_notice" \
      A2A_PASSIVE_NOTIFY_TTY="$notify_tty" \
      nohup setsid bash "$SCRIPT_DIR/a2a-passive-wait.sh" "$role" </dev/null >/dev/null 2>&1 &
    waiter_pid=$!
  else
    launch_strategy="nohup"
    A2A_PASSIVE_WAIT_STATUS="$wait_status" \
      A2A_PASSIVE_WAIT_EVENT="$wait_event" \
      A2A_PASSIVE_WAIT_NOTICE="$wait_notice" \
      A2A_PASSIVE_NOTIFY_TTY="$notify_tty" \
      nohup bash "$SCRIPT_DIR/a2a-passive-wait.sh" "$role" </dev/null >/dev/null 2>&1 &
    waiter_pid=$!
  fi
  sleep 1
  sync_passive_waiter_artifact "$role" "$wait_status" "$wait_event" "$wait_notice"
  a2a_debug_log "$role" "chat:start_passive_waiter started status=$wait_status pid=${waiter_pid:-unknown} strategy=${launch_strategy:-unknown} notify_tty=$(a2a_debug_shell_quote "${notify_tty:-none}")"
}

should_restart_passive_waiter() {
  local output="$1"
  if a2a_output_is_terminal_close "$output"; then
    return 1
  fi
  case "$output" in
    WAIT_CONTINUE_REQUIRED*)
      return 1
      ;;
    *WAIT_ALREADY_PENDING*|*WAIT_BROKER_DRAINING*|*WAIT_UNAUTHORIZED*)
      return 1
      ;;
    *)
      return 0
      ;;
  esac
}

output_is_transport_failure() {
  local output="$1"
  case "$output" in
    TIMEOUT_PING_FAILED*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

apply_output_artifact_state() {
  local role="$1"
  local output="$2"
  local pending_path pending_status pending_event pending_notice

  if a2a_output_is_terminal_close "$output"; then
    a2a_update_artifact_state "$role" "closed" "$(a2a_output_close_event_name "$output")" "null" "" ""
    return 0
  fi

  case "$output" in
    *WAIT_ALREADY_PENDING*)
      if printf '%s\n' "$output" | grep -q '^DELIVERED'; then
        a2a_update_artifact_state "$role" "waiting_for_partner_reply" "WAIT_ALREADY_PENDING" "null" "" "Message was delivered and an existing wait is already pending for the partner reply."
      else
        a2a_update_artifact_state "$role" "error" "WAIT_ALREADY_PENDING" "null" "$output" ""
      fi
      ;;
    *WAIT_BROKER_DRAINING*)
      a2a_update_artifact_state "$role" "error" "WAIT_BROKER_DRAINING" "null" "$output" ""
      ;;
    *WAIT_UNAUTHORIZED*)
      a2a_update_artifact_state "$role" "error" "WAIT_UNAUTHORIZED" "null" "$output" ""
      ;;
    WAIT_CONTINUE_REQUIRED*)
      if [ "$role" = "host" ]; then
        a2a_update_artifact_state "$role" "waiting_for_join" "wait_continue_required" "null" "" "No join notice has arrived in the current foreground slice. Re-run the surfaced host join wait to continue."
      fi
      ;;
    *MESSAGE_RECEIVED*)
      if a2a_output_is_join_notice "$output"; then
        if [ "$role" = "host" ]; then
          pending_path="$(a2a_pending_message_path_for_role "$role" 2>/dev/null || true)"
          if [ -n "$pending_path" ] && [ -s "$pending_path" ]; then
            pending_status="$(a2a_pending_message_status_for_output "$role" "$output")"
            pending_event="$(a2a_pending_message_event_for_output "$role" "$output")"
            pending_notice="$(a2a_pending_message_notice_for_output "$role" "$output")"
            a2a_update_artifact_state "$role" "$pending_status" "$pending_event" "null" "" "$pending_notice"
          else
            a2a_update_artifact_state "$role" "connected" "system_joined" "null" "" "Connection established. HOST can send the first message."
          fi
        else
          a2a_update_artifact_state "$role" "connected" "system_joined" "null" "" "Connection established. Waiting for the host's first message."
        fi
        return 0
      fi
      if [ "$role" = "join" ]; then
        pending_path="$(a2a_pending_message_path_for_role "$role" 2>/dev/null || true)"
        if [ -n "$pending_path" ] && [ -s "$pending_path" ]; then
          pending_status="$(a2a_pending_message_status_for_output "$role" "$output")"
          pending_event="$(a2a_pending_message_event_for_output "$role" "$output")"
          pending_notice="$(a2a_pending_message_notice_for_output "$role" "$output")"
          a2a_update_artifact_state "$role" "$pending_status" "$pending_event" "null" "" "$pending_notice"
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
  case "$output" in
    MESSAGE_RECEIVED*|*"
MESSAGE_RECEIVED"*|TIMEOUT_ROOM_CLOSED*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
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
  local pending_path tmp_path pending_status pending_event pending_notice
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
  pending_status="$(a2a_pending_message_status_for_output "$role" "$output")"
  pending_event="$(a2a_pending_message_event_for_output "$role" "$output")"
  pending_notice="$(a2a_pending_message_notice_for_output "$role" "$output")"
  a2a_update_artifact_state "$role" "$pending_status" "$pending_event" "null" "" "$pending_notice"
  a2a_write_host_join_notification_artifact "$role" "$output" "false" "staged"
  a2a_debug_log "$role" "chat:stage_pending_output first_line=$(printf '%s' "$output" | head -n 1)"
}

clear_pending_message_after_relay() {
  local role="$1"
  local pending_path
  pending_path="$(a2a_pending_message_path_for_role "$role" 2>/dev/null || true)"
  if [ -z "$pending_path" ] || [ ! -f "$pending_path" ]; then
    return 0
  fi
  rm -f "$pending_path"
  a2a_debug_log "$role" "chat:clear_pending_after_relay"
}

recover_pending_join_notice_for_host_outbound() {
  local pending_path pending_output
  if [ "$ROLE" != "host" ] || [ -z "$MESSAGE" ]; then
    return 0
  fi

  pending_path="$(a2a_pending_message_path_for_role "$ROLE" 2>/dev/null || true)"
  if [ -z "$pending_path" ] || [ ! -s "$pending_path" ]; then
    return 0
  fi

  pending_output="$(cat "$pending_path")"
  if ! a2a_output_is_join_notice "$pending_output"; then
    return 0
  fi

  a2a_debug_log "$ROLE" "chat:recover_pending_join_notice_before_send first_line=$(printf '%s' "$pending_output" | head -n 1)"
  print_output_recoverably "$ROLE" "$pending_output" || return $?
  apply_output_artifact_state "$ROLE" "$pending_output"
  return 0
}

foreground_wait_pid_path_for_role() {
  local role="$1"
  local session_dir
  session_dir="$(a2a_session_dir_for_role "$role" 2>/dev/null || true)"
  if [ -z "$session_dir" ]; then
    return 1
  fi
  printf '%s\n' "$session_dir/a2a_${role}_foreground_wait.pid"
}

foreground_wait_message_path_for_role() {
  local role="$1"
  local session_dir
  session_dir="$(a2a_session_dir_for_role "$role" 2>/dev/null || true)"
  if [ -z "$session_dir" ]; then
    return 1
  fi
  printf '%s\n' "$session_dir/a2a_${role}_foreground_wait_message.txt"
}

foreground_wait_active_for_message() {
  local role="$1"
  local expected_message="${2-}"
  local pid_path message_path pid active_message
  pid_path="$(foreground_wait_pid_path_for_role "$role" 2>/dev/null || true)"
  if [ -z "$pid_path" ] || [ ! -f "$pid_path" ]; then
    return 1
  fi
  pid="$(cat "$pid_path" 2>/dev/null || true)"
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$pid_path"
    message_path="$(foreground_wait_message_path_for_role "$role" 2>/dev/null || true)"
    [ -n "$message_path" ] && rm -f "$message_path"
    return 1
  fi
  if [ -n "$expected_message" ]; then
    message_path="$(foreground_wait_message_path_for_role "$role" 2>/dev/null || true)"
    active_message="$(cat "$message_path" 2>/dev/null || true)"
    [ "$active_message" = "$expected_message" ] || return 1
  fi
  return 0
}

mark_foreground_wait_owner() {
  local role="$1"
  local message="${2-}"
  local pid_path message_path
  pid_path="$(foreground_wait_pid_path_for_role "$role" 2>/dev/null || true)"
  message_path="$(foreground_wait_message_path_for_role "$role" 2>/dev/null || true)"
  if [ -z "$pid_path" ] || [ -z "$message_path" ]; then
    return 0
  fi
  mkdir -p "$(dirname "$pid_path")"
  printf '%s\n' "$$" > "$pid_path"
  printf '%s\n' "$message" > "$message_path"
  a2a_debug_log "$role" "chat:foreground_wait_owner pid=$$ message_present=$([ -n "$message" ] && echo yes || echo no)"
}

clear_foreground_wait_owner() {
  local role="$1"
  local pid_path message_path pid
  pid_path="$(foreground_wait_pid_path_for_role "$role" 2>/dev/null || true)"
  if [ -z "$pid_path" ] || [ ! -f "$pid_path" ]; then
    return 0
  fi
  pid="$(cat "$pid_path" 2>/dev/null || true)"
  if [ "$pid" != "$$" ]; then
    return 0
  fi
  message_path="$(foreground_wait_message_path_for_role "$role" 2>/dev/null || true)"
  rm -f "$pid_path"
  [ -n "$message_path" ] && rm -f "$message_path"
  a2a_debug_log "$role" "chat:foreground_wait_owner_cleared pid=$$"
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
  local should_restore="no"
  clear_foreground_wait_owner "$ROLE"
  a2a_debug_script_lifecycle_end "$ROLE" "a2a-chat.sh" "$exit_code"
  if should_restore_waiter; then
    should_restore="yes"
  fi
  a2a_debug_log "$ROLE" "chat:exit_handler exit_code=$exit_code clean_exit=${A2A_CHAT_CLEAN_EXIT:-0} should_restore=$should_restore had_passive_waiter=$HAD_PASSIVE_WAITER restore_waiter_on_exit=$RESTORE_WAITER_ON_EXIT output_first_line=$(printf '%s' "$OUTPUT" | head -n 1)"
  a2a_debug_runtime_checkpoint "$ROLE" "chat:exit_handler_context" "exit_code=$exit_code" "clean_exit=${A2A_CHAT_CLEAN_EXIT:-0}" "should_restore=$should_restore"
  if ! should_restore_waiter; then
    return 0
  fi
  if [ "${A2A_CHAT_CLEAN_EXIT:-0}" = "1" ]; then
    return 0
  fi
  a2a_debug_log "$ROLE" "chat:restore_on_exit exit_code=$exit_code"
  if should_restart_passive_waiter "$OUTPUT"; then
    a2a_debug_log "$ROLE" "chat:restore_on_exit restart_waiter=yes wait_status=$RESTORE_WAIT_STATUS wait_event=$RESTORE_WAIT_EVENT"
    start_passive_waiter "$ROLE" "$RESTORE_WAIT_STATUS" "$RESTORE_WAIT_EVENT" "$RESTORE_WAIT_NOTICE"
  else
    a2a_debug_log "$ROLE" "chat:restore_on_exit restart_waiter=no output_first_line=$(printf '%s' "$OUTPUT" | head -n 1)"
  fi
  exit "$exit_code"
}

chat_signal_exit() {
  local signal_name="$1"
  local exit_code="$2"
  a2a_debug_log "$ROLE" "chat:signal signal=$signal_name exit_code=$exit_code clean_exit=${A2A_CHAT_CLEAN_EXIT:-0}"
  clear_foreground_wait_owner "$ROLE"
  a2a_debug_signal_exit "$ROLE" "a2a-chat.sh" "$signal_name" "$exit_code"
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

if [ "$ROLE" = "host" ] && [ "$SURFACE_JOIN_NOTICE" -eq 1 ] && [ -z "$MESSAGE" ] && host_pre_join_wait_required; then
  RESTORE_WAIT_STATUS="waiting_for_join"
  RESTORE_WAIT_EVENT="waiting_for_join"
  RESTORE_WAIT_NOTICE="$(a2a_wait_notice_for_role_state "$ROLE" "$RESTORE_WAIT_STATUS")"
fi

a2a_update_artifact_state "$ROLE" "connected" "foreground_chat_active" "null" "" ""
trap 'restore_passive_waiter_on_exit $?' EXIT
trap 'chat_signal_exit HUP 129' HUP
trap 'chat_signal_exit INT 130' INT
trap 'chat_signal_exit QUIT 131' QUIT
trap 'chat_signal_exit PIPE 141' PIPE
trap 'chat_signal_exit TERM 143' TERM

if [ "$ROLE" = "host" ]; then

  if [ -n "$MESSAGE" ]; then
    INFLIGHT_PATH="$(a2a_inflight_message_path_for_role "$ROLE" 2>/dev/null || true)"
    if [ -n "$INFLIGHT_PATH" ] && [ -f "$INFLIGHT_PATH" ]; then
      INFLIGHT_MESSAGE="$(cat "$INFLIGHT_PATH" 2>/dev/null || true)"
      if [ -n "$INFLIGHT_MESSAGE" ] && [ "$INFLIGHT_MESSAGE" = "$MESSAGE" ]; then
        a2a_debug_log "$ROLE" "chat:resume_inflight same_message_detected"
        if foreground_wait_active_for_message "$ROLE" "$MESSAGE"; then
          a2a_debug_log "$ROLE" "chat:resume_inflight foreground_wait_active"
          OUTPUT="$(printf '%s\n%s\n' "DELIVERED" "WAIT_ALREADY_PENDING")"
          printf '%s\n' "$OUTPUT"
          apply_output_artifact_state "$ROLE" "$OUTPUT"
          A2A_CHAT_CLEAN_EXIT=1
          exit 0
        fi
        RESUME_NOTICE="NOTICE: Previous host send was already delivered before interruption. Checking once for a recoverable partner reply before resending."
        PENDING_PATH="$(a2a_pending_message_path_for_role "$ROLE" 2>/dev/null || true)"
        if [ -n "$PENDING_PATH" ] && [ -s "$PENDING_PATH" ]; then
          OUTPUT="$(cat "$PENDING_PATH")"
          printf '%s\n' "$RESUME_NOTICE"
          print_output_recoverably "$ROLE" "$OUTPUT" || exit $?
          clear_pending_message_after_relay "$ROLE"
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
          WAIT_ALREADY_PENDING*)
            OUTPUT="$(printf '%s\n%s\n' "DELIVERED" "WAIT_ALREADY_PENDING")"
            printf '%s\n' "$OUTPUT"
            apply_output_artifact_state "$ROLE" "$OUTPUT"
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
      clear_pending_message_after_relay "$ROLE"
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
    clear_pending_message_after_relay "$ROLE"
    clear_inflight_message "$ROLE"
    apply_output_artifact_state "$ROLE" "$OUTPUT"
    A2A_CHAT_CLEAN_EXIT=1
    exit 0
  fi
fi

if [ -n "$MESSAGE" ]; then
  recover_pending_join_notice_for_host_outbound || exit $?
  clear_pending_message_for_outbound "$ROLE"
fi

if [ "$PARK_MODE" -eq 1 ]; then
  park_session
fi

if [ "$SURFACE_JOIN_NOTICE" -eq 1 ]; then
  mark_foreground_wait_owner "$ROLE" "$MESSAGE"
  if [ "$ROLE" = "host" ] && [ -z "$MESSAGE" ]; then
    HOST_JOIN_WAIT_MAX_SECONDS="${A2A_LOOP_MAX_SECONDS:-${A2A_HOST_JOIN_WAIT_MAX_SECONDS:-8}}"
    HOST_JOIN_WAIT_POLL_TIMEOUT="${A2A_WAIT_POLL_TIMEOUT:-${A2A_HOST_JOIN_WAIT_POLL_TIMEOUT:-5}}"
    HOST_JOIN_NOTIFY_TTY="$(a2a_capture_notification_tty 2>/dev/null || true)"
    a2a_debug_log "$ROLE" "chat:loop_invoke surface_join_notice=yes host_join_wait=yes loop_max_seconds=$HOST_JOIN_WAIT_MAX_SECONDS wait_poll_timeout=$HOST_JOIN_WAIT_POLL_TIMEOUT notify_tty=$(a2a_debug_shell_quote "${HOST_JOIN_NOTIFY_TTY:-none}")"
    OUTPUT="$(A2A_RELAY_NOTIFY_TTY="$HOST_JOIN_NOTIFY_TTY" A2A_LOOP_CONTINUE_ON_MAX_SECONDS="${A2A_LOOP_CONTINUE_ON_MAX_SECONDS:-true}" A2A_LOOP_MAX_SECONDS="$HOST_JOIN_WAIT_MAX_SECONDS" A2A_WAIT_POLL_TIMEOUT="$HOST_JOIN_WAIT_POLL_TIMEOUT" A2A_LOOP_SURFACE_INACTIVITY="${A2A_LOOP_SURFACE_INACTIVITY:-false}" bash "$SCRIPT_DIR/a2a-loop.sh" --surface-join-notice "$ROLE" "$MESSAGE")"
  else
    a2a_debug_log "$ROLE" "chat:loop_invoke surface_join_notice=yes host_join_wait=no"
    OUTPUT="$(A2A_LOOP_SURFACE_INACTIVITY="${A2A_LOOP_SURFACE_INACTIVITY:-false}" bash "$SCRIPT_DIR/a2a-loop.sh" --surface-join-notice "$ROLE" "$MESSAGE")"
  fi
else
  a2a_debug_log "$ROLE" "chat:loop_invoke surface_join_notice=no"
  mark_foreground_wait_owner "$ROLE" "$MESSAGE"
  OUTPUT="$(A2A_LOOP_SURFACE_INACTIVITY="${A2A_LOOP_SURFACE_INACTIVITY:-false}" bash "$SCRIPT_DIR/a2a-loop.sh" "$ROLE" "$MESSAGE")"
fi
STATUS=$?
clear_foreground_wait_owner "$ROLE"
a2a_debug_log "$ROLE" "chat:loop_complete status=$STATUS first_line=$(printf '%s' "$OUTPUT" | head -n 1)"

if [ "$STATUS" -eq 0 ] && output_is_transport_failure "$OUTPUT"; then
  STATUS=1
  a2a_debug_log "$ROLE" "chat:loop_transport_failure first_line=$(printf '%s' "$OUTPUT" | head -n 1)"
fi

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
