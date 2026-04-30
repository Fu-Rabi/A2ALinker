#!/bin/bash

a2a_read_broker_from_artifact() {
  local artifact_path="$1"
  if [ ! -f "$artifact_path" ]; then
    return 1
  fi

  local broker
  broker=$(sed -En 's/.*"brokerEndpoint"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$artifact_path" | head -n 1)
  if [ -n "$broker" ]; then
    printf '%s\n' "$broker"
    return 0
  fi

  return 1
}

a2a_read_field_from_artifact() {
  local artifact_path="$1"
  local field_name="$2"
  if [ ! -f "$artifact_path" ]; then
    return 1
  fi

  local value
  value=$(sed -En "s/.*\"${field_name}\"[[:space:]]*:[[:space:]]*\"([^\"]+)\".*/\\1/p" "$artifact_path" | head -n 1)
  if [ -n "$value" ]; then
    printf '%s\n' "$value"
    return 0
  fi

  return 1
}

a2a_resolve_explicit_base_url() {
  if [ -n "${A2A_BASE_URL:-}" ]; then
    printf '%s\n' "$A2A_BASE_URL"
    return 0
  fi

  if [ -n "${A2A_SERVER:-}" ]; then
    case "$A2A_SERVER" in
      http://*|https://*)
        printf '%s\n' "$A2A_SERVER"
        ;;
      *)
        printf 'https://%s\n' "$A2A_SERVER"
        ;;
    esac
    return 0
  fi

  return 1
}

a2a_resolve_fresh_base_url() {
  if a2a_resolve_explicit_base_url; then
    return 0
  fi

  printf '%s\n' "http://127.0.0.1:3000"
}

a2a_resolve_base_url() {
  if a2a_resolve_explicit_base_url; then
    return 0
  fi

  local cwd
  cwd="${PWD:-$(pwd)}"
  for artifact_path in \
    "$cwd/.a2a-host-session.json" \
    "$cwd/.a2a-join-session.json" \
    "$cwd/.a2a-listener-session.json" \
    "$cwd/.a2a-session-policy.json" \
    "$cwd/.a2a-listener-policy.json"
  do
    if a2a_read_broker_from_artifact "$artifact_path"; then
      return 0
    fi
  done

  printf '%s\n' "http://127.0.0.1:3000"
}

a2a_role_base_url_path() {
  local role="$1"
  printf '/tmp/a2a_%s_base_url\n' "$role"
}

a2a_read_role_base_url() {
  local role="$1"
  local base_url_path
  base_url_path="$(a2a_role_base_url_path "$role")"
  if [ ! -f "$base_url_path" ]; then
    return 1
  fi

  local saved_base_url
  saved_base_url=$(cat "$base_url_path")
  if [ -z "$saved_base_url" ]; then
    return 2
  fi

  printf '%s\n' "$saved_base_url"
  return 0
}

a2a_store_role_base_url() {
  local role="$1"
  local base_url="$2"
  local base_url_path
  base_url_path="$(a2a_role_base_url_path "$role")"
  printf '%s\n' "$base_url" > "$base_url_path"
  chmod 600 "$base_url_path"
}

a2a_clear_role_base_url() {
  local role="$1"
  local base_url_path
  base_url_path="$(a2a_role_base_url_path "$role")"
  rm -f "$base_url_path"
}

a2a_resolve_saved_base_url_for_role() {
  local role="$1"
  if [ -n "$role" ]; then
    if a2a_read_role_base_url "$role"; then
      return 0
    fi

    local artifact_path
    artifact_path="$(a2a_artifact_path_for_role "$role" 2>/dev/null || true)"
    if [ -n "$artifact_path" ] && a2a_read_broker_from_artifact "$artifact_path"; then
      return 0
    fi
  fi

  printf '%s\n' "http://127.0.0.1:3000"
}

a2a_resolve_active_base_url_for_role() {
  local role="$1"
  if [ -n "${A2A_BASE_URL:-}" ] || [ -n "${A2A_SERVER:-}" ]; then
    a2a_resolve_base_url
    return 0
  fi

  if [ -n "$role" ]; then
    if a2a_read_role_base_url "$role"; then
      return 0
    fi

    local artifact_path
    artifact_path="$(a2a_artifact_path_for_role "$role" 2>/dev/null || true)"
    if [ -n "$artifact_path" ] && a2a_read_broker_from_artifact "$artifact_path"; then
      return 0
    fi
  fi

  a2a_resolve_base_url
}

a2a_resolve_role() {
  if [ -f "/tmp/a2a_host_token" ] && [ -s "/tmp/a2a_host_token" ]; then
    printf 'host\n'
    return 0
  fi
  if [ -f "/tmp/a2a_join_token" ] && [ -s "/tmp/a2a_join_token" ]; then
    printf 'join\n'
    return 0
  fi
  return 1
}

a2a_artifact_path_for_role() {
  local role="$1"
  local cwd
  cwd="${PWD:-$(pwd)}"
  case "$role" in
    host)
      printf '%s\n' "$cwd/.a2a-host-session.json"
      ;;
    join)
      printf '%s\n' "$cwd/.a2a-join-session.json"
      ;;
    listen)
      printf '%s\n' "$cwd/.a2a-listener-session.json"
      ;;
    *)
      return 1
      ;;
  esac
}

a2a_update_artifact_state() {
  local role="$1"
  local status="$2"
  local last_event="$3"
  local pid_value="${4-__KEEP__}"
  local error_text="${5-__KEEP__}"
  local notice_text="${6-__KEEP__}"
  local artifact_path
  artifact_path="$(a2a_artifact_path_for_role "$role" 2>/dev/null || true)"
  if [ -z "$artifact_path" ] || [ ! -f "$artifact_path" ]; then
    return 0
  fi

  node -e '
    const fs = require("fs");
    const [artifactPath, status, lastEvent, pidValue, errorText, noticeText] = process.argv.slice(1);
    const data = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    data.status = status;
    data.lastEvent = lastEvent;
    if (pidValue !== "__KEEP__") {
      data.pid = pidValue === "null" ? null : Number(pidValue);
    }
    if (errorText !== "__KEEP__") {
      data.error = errorText ? errorText : null;
    }
    if (noticeText !== "__KEEP__") {
      data.notice = noticeText ? noticeText : null;
    }
    data.updatedAt = new Date().toISOString();
    fs.writeFileSync(artifactPath, JSON.stringify(data, null, 2));
  ' "$artifact_path" "$status" "$last_event" "$pid_value" "$error_text" "$notice_text" >/dev/null 2>&1 || true
}

a2a_capture_notification_tty() {
  if [ -n "${A2A_RELAY_NOTIFY_TTY:-}" ]; then
    printf '%s\n' "$A2A_RELAY_NOTIFY_TTY"
    return 0
  fi
  if [ -n "${A2A_PASSIVE_NOTIFY_TTY:-}" ]; then
    printf '%s\n' "$A2A_PASSIVE_NOTIFY_TTY"
    return 0
  fi
  if [ -t 2 ]; then
    tty <&2 2>/dev/null && return 0
  fi
  if [ -t 1 ]; then
    tty <&1 2>/dev/null && return 0
  fi
  if [ -t 0 ]; then
    tty 2>/dev/null && return 0
  fi
  return 1
}

a2a_wait_notice_for_role_state() {
  local role="$1"
  local status="$2"
  case "$status" in
    waiting_for_partner_reply)
      if [ "$role" = "host" ]; then
        printf '%s\n' "Host message delivered. Passive wait is active while the partner reply is pending."
      else
        printf '%s\n' "Reply delivered. Passive wait is active while the host response is pending."
      fi
      ;;
    waiting_for_host_message)
      printf '%s\n' "Passive wait is active while the host sends the next message."
      ;;
    waiting_for_join)
      printf '%s\n' "Passive wait is active while the joiner connects. If this turn ends, recover with the surfaced host join wait."
      ;;
    waiting_for_local_task)
      if [ "$role" = "host" ]; then
        printf '%s\n' "Passive wait is active while the local human decides the next host message."
      else
        printf '%s\n' "Passive wait is active while the local human decides the next reply."
      fi
      ;;
    *)
      printf '\n'
      ;;
  esac
}

a2a_pending_message_notice_for_role() {
  local role="$1"
  if [ "$role" = "host" ]; then
    printf '%s\n' "A partner event is stored locally. Run a2a-chat.sh host to inspect it."
  else
    printf '%s\n' "A host event is stored locally. Run a2a-chat.sh join to inspect it."
  fi
}

a2a_pending_message_status_for_output() {
  local role="$1"
  local output="${2-}"
  if [ "$role" = "host" ] && a2a_output_is_join_notice "$output"; then
    printf '%s\n' "join_notice_pending"
    return 0
  fi
  printf '%s\n' "waiting_for_local_task"
}

a2a_pending_message_event_for_output() {
  local role="$1"
  local output="${2-}"
  if [ "$role" = "host" ] && a2a_output_is_join_notice "$output"; then
    printf '%s\n' "system_joined"
    return 0
  fi
  printf '%s\n' "waiting_for_local_task"
}

a2a_pending_message_notice_for_output() {
  local role="$1"
  local output="${2-}"
  if [ "$role" = "host" ] && a2a_output_is_join_notice "$output"; then
    printf '%s\n' "Partner joined. Relay this system notification to the human and ask for the first host message."
    return 0
  fi
  a2a_pending_message_notice_for_role "$role"
}

a2a_inactivity_notice_for_role_state() {
  local role="$1"
  local status="$2"
  local threshold_seconds="$3"
  case "$status" in
    waiting_for_partner_reply)
      if [ "$role" = "host" ]; then
        printf '%s\n' "Still waiting for the partner reply. No remote activity has been seen for ${threshold_seconds}s, but the passive wait is still active."
      else
        printf '%s\n' "Still waiting for the host reply. No remote activity has been seen for ${threshold_seconds}s, but the passive wait is still active."
      fi
      ;;
    waiting_for_host_message)
      printf '%s\n' "Still waiting for the host's next message. No remote activity has been seen for ${threshold_seconds}s, but the passive wait is still active."
      ;;
    *)
      printf '\n'
      ;;
  esac
}

a2a_extract_system_body() {
  local output="$1"
  local normalized
  normalized="$(printf '%s' "$output" | tr -d '\r')"
  if [[ "$normalized" != MESSAGE_RECEIVED$'\n'* ]]; then
    return 1
  fi

  normalized="${normalized#MESSAGE_RECEIVED$'\n'}"
  case "$normalized" in
    "[SYSTEM]:"*|"[SYSTEM ALERT]:"*)
      printf '%s\n' "$normalized"
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

a2a_system_close_event_name() {
  local body="$1"
  case "$body" in
    "[SYSTEM]:"*"has left the room. Session ended."*)
      printf '%s\n' "room_closed"
      return 0
      ;;
    "[SYSTEM]:"*"has closed the session."*|"[SYSTEM]:"*"Session ended."*|"[SYSTEM]:"*"Session expired due to inactivity."*|"[SYSTEM]:"*"Session was closed by broker policy."*)
      printf '%s\n' "system_closed"
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

a2a_output_is_join_notice() {
  local output="$1"
  local system_body
  if ! system_body="$(a2a_extract_system_body "$output")"; then
    return 1
  fi

  case "$system_body" in
    "[SYSTEM]:"*"has joined."*|"[SYSTEM]:"*"Session is live!"*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

a2a_sanitize_terminal_notification() {
  LC_ALL=C perl -pe 's/\e\[[0-?]*[ -\/]*[@-~]//g; s/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]//g'
}

a2a_notify_host_join_terminal() {
  local role="$1"
  local output="$2"
  local notify_tty="${3:-${A2A_RELAY_NOTIFY_TTY:-${A2A_PASSIVE_NOTIFY_TTY:-}}}"
  local clean_output
  local tty_exists="no"
  local tty_writable="no"

  if [ "$role" != "host" ] || ! a2a_output_is_join_notice "$output"; then
    return 0
  fi
  if [ -n "$notify_tty" ] && [ -e "$notify_tty" ]; then
    tty_exists="yes"
  fi
  if [ -n "$notify_tty" ] && [ -w "$notify_tty" ]; then
    tty_writable="yes"
  fi
  a2a_debug_log "$role" "notify:host_join_tty path=$(a2a_debug_shell_quote "${notify_tty:-none}") exists=$tty_exists writable=$tty_writable"
  if [ -z "$notify_tty" ] || [ ! -w "$notify_tty" ]; then
    a2a_debug_log "$role" "notify:host_join_tty skipped=unavailable"
    return 0
  fi

  clean_output="$(printf '%s\n' "$output" | a2a_sanitize_terminal_notification)"
  if {
    printf '\nA2A_LINKER_JOIN_NOTICE\n'
    printf '%s\n' "$clean_output"
    printf 'A2A_LINKER_PROMPT: What is the first host message you want sent?\n'
  } >> "$notify_tty" 2>/dev/null; then
    a2a_debug_log "$role" "notify:host_join_tty write=ok path=$(a2a_debug_shell_quote "$notify_tty")"
  else
    a2a_debug_log "$role" "notify:host_join_tty write=failed path=$(a2a_debug_shell_quote "$notify_tty")"
    return 0
  fi
}

a2a_join_notification_artifact_path_for_role() {
  local role="$1"
  local session_dir
  session_dir="$(a2a_session_dir_for_role "$role" 2>/dev/null || true)"
  if [ -z "$session_dir" ]; then
    return 1
  fi
  printf '%s\n' "$session_dir/a2a_${role}_join_notification.json"
}

a2a_extract_join_partner_label() {
  local output="$1"
  local system_body
  if ! system_body="$(a2a_extract_system_body "$output")"; then
    return 1
  fi

  printf '%s\n' "$system_body" | sed -En "s/.*(Partner|HOST|JOIN|Agent) '([^']+)'.*/\2/p" | head -n 1
}

a2a_write_host_join_notification_artifact() {
  local role="$1"
  local output="$2"
  local notified_human="${3:-false}"
  local human_notify_status="${4:-skipped}"
  local artifact_path session_artifact invite_code partner_label pending_path event_timestamp

  if [ "$role" != "host" ] || ! a2a_output_is_join_notice "$output"; then
    return 0
  fi

  artifact_path="$(a2a_join_notification_artifact_path_for_role "$role" 2>/dev/null || true)"
  if [ -z "$artifact_path" ]; then
    a2a_debug_log "$role" "human_notify:artifact skipped=no_session_dir"
    return 0
  fi

  session_artifact="$(a2a_artifact_path_for_role "$role" 2>/dev/null || true)"
  invite_code=""
  if [ -n "$session_artifact" ]; then
    invite_code="$(a2a_read_field_from_artifact "$session_artifact" "inviteCode" 2>/dev/null || true)"
  fi
  partner_label="$(a2a_extract_join_partner_label "$output" 2>/dev/null || true)"
  pending_path="$(a2a_pending_message_path_for_role "$role" 2>/dev/null || true)"
  event_timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  mkdir -p "$(dirname "$artifact_path")"
  node -e '
    const fs = require("fs");
    const [
      artifactPath,
      inviteCode,
      partnerLabel,
      eventTimestamp,
      pendingPayloadPath,
      notifiedHumanRaw,
      humanNotifyStatus,
    ] = process.argv.slice(1);
    let prior = {};
    try {
      prior = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    } catch {
      prior = {};
    }
    const notifiedHuman = prior.notifiedHuman === true || notifiedHumanRaw === "true";
    const data = {
      inviteCode: inviteCode || null,
      partnerLabel: partnerLabel || null,
      eventTimestamp,
      pendingPayloadPath: pendingPayloadPath || null,
      notifiedHuman,
      humanNotifyStatus: prior.notifiedHuman === true && notifiedHumanRaw !== "true"
        ? (prior.humanNotifyStatus || "sent")
        : humanNotifyStatus,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(artifactPath, JSON.stringify(data, null, 2));
  ' "$artifact_path" "$invite_code" "$partner_label" "$event_timestamp" "$pending_path" "$notified_human" "$human_notify_status" >/dev/null 2>&1 || true
}

a2a_human_notify_enabled() {
  case "$(printf '%s' "${A2A_HUMAN_NOTIFY:-0}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

a2a_notify_host_join_human() {
  local role="$1"
  local output="$2"

  if [ "$role" != "host" ] || ! a2a_output_is_join_notice "$output"; then
    return 0
  fi

  a2a_debug_log "$role" "human_notify:start"
  a2a_write_host_join_notification_artifact "$role" "$output" "false" "skipped"

  if ! a2a_human_notify_enabled; then
    a2a_debug_log "$role" "human_notify=skipped"
    return 0
  fi

  if ! command -v osascript >/dev/null 2>&1; then
    a2a_write_host_join_notification_artifact "$role" "$output" "false" "unavailable"
    a2a_debug_log "$role" "human_notify=unavailable"
    return 0
  fi

  if osascript -e 'display notification "Partner joined" with title "A2A Linker"' >/dev/null 2>&1; then
    a2a_write_host_join_notification_artifact "$role" "$output" "true" "sent"
    a2a_debug_log "$role" "human_notify=sent"
  else
    a2a_write_host_join_notification_artifact "$role" "$output" "false" "failed"
    a2a_debug_log "$role" "human_notify=failed"
  fi
}

a2a_output_is_terminal_close() {
  a2a_output_close_event_name "$1" >/dev/null
}

a2a_output_close_event_name() {
  local output="$1"
  local system_body
  case "$output" in
    TIMEOUT_ROOM_CLOSED*)
      printf '%s\n' "room_closed"
      ;;
    *)
      if system_body="$(a2a_extract_system_body "$output")"; then
        a2a_system_close_event_name "$system_body"
        return $?
      fi
      return 1
      ;;
  esac
}

a2a_session_dir_for_role() {
  local role="$1"
  local artifact_path
  artifact_path="$(a2a_artifact_path_for_role "$role")" || return 1
  a2a_read_field_from_artifact "$artifact_path" "sessionDir"
}

a2a_pending_message_path_for_role() {
  local role="$1"
  local session_dir
  session_dir="$(a2a_session_dir_for_role "$role")" || return 1
  printf '%s\n' "$session_dir/a2a_${role}_pending_message.txt"
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

a2a_waiter_pid_path_for_role() {
  local role="$1"
  local session_dir
  session_dir="$(a2a_session_dir_for_role "$role")" || return 1
  printf '%s\n' "$session_dir/a2a_${role}_passive_wait.pid"
}

a2a_inflight_message_path_for_role() {
  local role="$1"
  local session_dir
  session_dir="$(a2a_session_dir_for_role "$role")" || return 1
  printf '%s\n' "$session_dir/a2a_${role}_inflight_message.txt"
}

a2a_debug_enabled() {
  if [ "${A2A_DEBUG:-0}" = "1" ] || [ -n "${A2A_DEBUG_LOG:-}" ]; then
    return 0
  fi

  local marker_path
  marker_path="$(a2a_debug_marker_path)"
  if [ -f "$marker_path" ]; then
    return 0
  fi
  return 1
}

a2a_debug_marker_path() {
  local cwd
  cwd="${PWD:-$(pwd)}"
  printf '%s\n' "$cwd/.a2a-debug-mode"
}

a2a_enable_debug_mode() {
  local marker_path
  marker_path="$(a2a_debug_marker_path)"
  export A2A_DEBUG=1
  printf 'enabled\n' > "$marker_path"
}

a2a_prompt_for_debug_if_interactive() {
  if a2a_debug_enabled; then
    export A2A_DEBUG="${A2A_DEBUG:-1}"
    return 0
  fi

  if [ "${A2A_DEBUG_PROMPT:-auto}" = "0" ] || [ "${A2A_DEBUG_PROMPT:-auto}" = "false" ]; then
    return 0
  fi

  if [ ! -t 0 ] || [ ! -t 1 ]; then
    return 0
  fi

  local answer
  printf 'Run in debug mode? [y/N] ' >&2
  read -r answer || true
  case "$(printf '%s' "${answer:-}" | tr '[:upper:]' '[:lower:]')" in
    y|yes)
      a2a_enable_debug_mode
      printf 'A2A debug mode enabled for this folder.\n' >&2
      ;;
  esac
}

a2a_prompt_for_listener_policy_if_interactive() {
  if [ "${A2A_LISTENER_POLICY_PROMPT:-auto}" = "0" ] || [ "${A2A_LISTENER_POLICY_PROMPT:-auto}" = "false" ]; then
    return 0
  fi

  if [ ! -t 0 ] || [ ! -t 1 ]; then
    return 0
  fi

  if [ -z "${A2A_ALLOW_WEB_ACCESS:-}" ]; then
    local web_answer
    printf 'Allow live web access for this listener? [y/N] ' >&2
    read -r web_answer || true
    case "$(printf '%s' "${web_answer:-}" | tr '[:upper:]' '[:lower:]')" in
      y|yes)
        export A2A_ALLOW_WEB_ACCESS=true
        ;;
      *)
        export A2A_ALLOW_WEB_ACCESS=false
        ;;
    esac
  fi

  if [ -z "${A2A_ALLOW_TESTS_BUILDS:-}" ]; then
    local tests_answer
    printf 'Allow tests/builds for this listener? [Y/n] ' >&2
    read -r tests_answer || true
    case "$(printf '%s' "${tests_answer:-yes}" | tr '[:upper:]' '[:lower:]')" in
      n|no)
        export A2A_ALLOW_TESTS_BUILDS=false
        ;;
      *)
        export A2A_ALLOW_TESTS_BUILDS=true
        ;;
    esac
  fi
}

a2a_debug_log_path_for_role() {
  local role="$1"
  if [ -n "${A2A_DEBUG_LOG:-}" ]; then
    printf '%s\n' "$A2A_DEBUG_LOG"
    return 0
  fi

  local session_dir
  session_dir="$(a2a_session_dir_for_role "$role" 2>/dev/null || true)"
  if [ -n "$session_dir" ]; then
    printf '%s\n' "$session_dir/a2a_debug.log"
    return 0
  fi

  printf '%s\n' "/tmp/a2a_${role}_debug.log"
}

a2a_debug_log() {
  local role="$1"
  shift || true
  if ! a2a_debug_enabled; then
    return 0
  fi

  local log_path timestamp
  log_path="$(a2a_debug_log_path_for_role "$role")"
  mkdir -p "$(dirname "$log_path")"
  timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  printf '%s [%s] pid=%s %s\n' "$timestamp" "$role" "$$" "$*" >> "$log_path"
}

a2a_debug_compact_text() {
  local value="${1:-}"
  value=$(printf '%s' "$value" | tr '\r\n' ' ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//')
  if [ "${#value}" -gt 200 ]; then
    value="${value:0:200}..."
  fi
  printf '%s' "$value"
}

a2a_debug_shell_quote() {
  printf '%q' "${1:-}"
}

a2a_debug_ps_field_raw() {
  local pid="$1"
  local field="$2"
  ps -o "${field}=" -p "$pid" 2>/dev/null | head -n 1
}

a2a_debug_join_args() {
  local joined="" arg quoted
  if [ "$#" -eq 0 ]; then
    printf '%s' "<none>"
    return 0
  fi
  for arg in "$@"; do
    quoted="$(a2a_debug_shell_quote "$arg")"
    if [ -n "$joined" ]; then
      joined="$joined $quoted"
    else
      joined="$quoted"
    fi
  done
  printf '%s' "$joined"
}

a2a_now_ms() {
  if command -v node >/dev/null 2>&1; then
    node -e 'process.stdout.write(String(Date.now()))' 2>/dev/null && return 0
  fi
  printf '%s000\n' "$(date +%s)"
}

a2a_debug_tty_state() {
  local fd="$1"
  if [ -t "$fd" ]; then
    printf '%s' "yes"
  else
    printf '%s' "no"
  fi
}

a2a_debug_tty_path() {
  local fd="$1"
  if ! [ -t "$fd" ]; then
    printf '%s' "none"
    return 0
  fi
  case "$fd" in
    0)
      tty 2>/dev/null || printf '%s' "unknown"
      ;;
    1)
      tty <&1 2>/dev/null || printf '%s' "unknown"
      ;;
    2)
      tty <&2 2>/dev/null || printf '%s' "unknown"
      ;;
    *)
      printf '%s' "unsupported"
      ;;
  esac
}

a2a_debug_process_field() {
  local pid="$1"
  local field="$2"
  local value
  case "$field" in
    sid)
      value="$(a2a_debug_ps_field_raw "$pid" "sid" | tr -d '[:space:]')"
      if ! printf '%s' "$value" | grep -Eq '^[0-9]+$'; then
        value="$(a2a_debug_ps_field_raw "$pid" "sess" | tr -d '[:space:]')"
      fi
      ;;
    *)
      value="$(a2a_debug_ps_field_raw "$pid" "$field" | tr -d '[:space:]')"
      ;;
  esac
  case "$field" in
    pgid|ppid|pid|sid)
      if ! printf '%s' "$value" | grep -Eq '^[0-9]+$'; then
        value=""
      fi
      ;;
  esac
  if [ -n "$value" ]; then
    printf '%s' "$value"
  else
    printf '%s' "unknown"
  fi
}

a2a_debug_process_command() {
  local pid="$1"
  local command_text
  command_text="$(ps -o command= -p "$pid" 2>/dev/null | head -n 1)"
  command_text="$(a2a_debug_compact_text "$command_text")"
  if [ -n "$command_text" ]; then
    a2a_debug_shell_quote "$command_text"
  else
    printf '%s' "unknown"
  fi
}

a2a_debug_runtime_context() {
  local role="$1"
  local label="$2"
  shift 2 || true
  local stdin_tty stdout_tty stderr_tty stdin_path stdout_path stderr_path pgid sid tty_name parent_cmd self_cmd
  stdin_tty="$(a2a_debug_tty_state 0)"
  stdout_tty="$(a2a_debug_tty_state 1)"
  stderr_tty="$(a2a_debug_tty_state 2)"
  stdin_path="$(a2a_debug_shell_quote "$(a2a_debug_tty_path 0)")"
  stdout_path="$(a2a_debug_shell_quote "$(a2a_debug_tty_path 1)")"
  stderr_path="$(a2a_debug_shell_quote "$(a2a_debug_tty_path 2)")"
  pgid="$(a2a_debug_process_field "$$" "pgid")"
  sid="$(a2a_debug_process_field "$$" "sid")"
  tty_name="$(a2a_debug_process_field "$$" "tty")"
  parent_cmd="$(a2a_debug_process_command "$PPID")"
  self_cmd="$(a2a_debug_process_command "$$")"
  a2a_debug_log "$role" "$label stdin_tty=$stdin_tty stdout_tty=$stdout_tty stderr_tty=$stderr_tty stdin_path=$stdin_path stdout_path=$stdout_path stderr_path=$stderr_path ppid=$PPID pgid=$pgid sid=$sid tty=$tty_name parent_cmd=$parent_cmd self_cmd=$self_cmd $*"
}

a2a_debug_runtime_checkpoint() {
  local role="$1"
  local label="$2"
  shift 2 || true
  a2a_debug_runtime_context "$role" "$label" "checkpoint_ms=$(a2a_now_ms)" "$@"
}

a2a_debug_script_lifecycle_start() {
  local role="$1"
  local script_name="$2"
  shift 2 || true
  unset A2A_DEBUG_SCRIPT_END_EMITTED
  export A2A_DEBUG_SCRIPT_START_MS="$(a2a_now_ms)"
  a2a_debug_log "$role" "script:$script_name start started_ms=${A2A_DEBUG_SCRIPT_START_MS:-unknown} argv=$(a2a_debug_join_args "$@")"
  a2a_debug_runtime_context "$role" "script:$script_name context"
}

a2a_debug_script_lifecycle_end() {
  local role="$1"
  local script_name="$2"
  local exit_code="${3:-0}"
  if [ "${A2A_DEBUG_SCRIPT_END_EMITTED:-0}" = "1" ]; then
    return 0
  fi
  export A2A_DEBUG_SCRIPT_END_EMITTED=1
  local end_ms start_ms duration_ms
  end_ms="$(a2a_now_ms)"
  start_ms="${A2A_DEBUG_SCRIPT_START_MS:-$end_ms}"
  a2a_debug_runtime_checkpoint "$role" "script:$script_name end_context" "exit_code=$exit_code"
  case "$start_ms:$end_ms" in
    *[!0-9:]*)
      duration_ms="unknown"
      ;;
    *)
      duration_ms="$((end_ms - start_ms))"
      ;;
  esac
  a2a_debug_log "$role" "script:$script_name end exit_code=$exit_code started_ms=$start_ms ended_ms=$end_ms duration_ms=$duration_ms"
}

a2a_debug_signal_exit() {
  local role="$1"
  local script_name="$2"
  local signal_name="$3"
  local exit_code="${4:-0}"
  shift 4 || true
  a2a_debug_log "$role" "script:$script_name signal signal=$signal_name exit_code=$exit_code $*"
  a2a_debug_runtime_checkpoint "$role" "script:$script_name signal_context" "signal=$signal_name" "exit_code=$exit_code" "$@"
  a2a_debug_script_lifecycle_end "$role" "$script_name" "$exit_code"
}

a2a_is_remote_base_url() {
  local base_url="${1:-}"
  case "$base_url" in
    http://127.0.0.1|http://127.0.0.1:*|http://localhost|http://localhost:*|https://localhost|https://localhost:*)
      return 1
      ;;
  esac
  return 0
}

a2a_is_retryable_transport_exit() {
  local curl_exit="${1:-}"
  case "$curl_exit" in
    6|7)
      return 0
      ;;
  esac
  return 1
}

# Sets PROMPT_FILE, RESPONSE_FILE, WORKDIR in the caller's shell context.
# Optionally checks that a required executable is in PATH ($1).
# Exits with an error message on validation failure.
a2a_validate_runner_env() {
  local required_bin="${1:-}"

  if [ -z "${A2A_SUPERVISOR_PROMPT_FILE:-}" ] || [ ! -f "${A2A_SUPERVISOR_PROMPT_FILE}" ]; then
    echo "ERROR: A2A_SUPERVISOR_PROMPT_FILE is missing or unreadable."
    exit 1
  fi

  if [ -z "${A2A_SUPERVISOR_RESPONSE_FILE:-}" ]; then
    echo "ERROR: A2A_SUPERVISOR_RESPONSE_FILE is not set."
    exit 1
  fi

  if [ -n "$required_bin" ] && ! command -v "$required_bin" >/dev/null 2>&1; then
    echo "ERROR: $required_bin executable not found in PATH."
    exit 1
  fi

  PROMPT_FILE="$A2A_SUPERVISOR_PROMPT_FILE"
  RESPONSE_FILE="$A2A_SUPERVISOR_RESPONSE_FILE"
  WORKDIR="${A2A_SUPERVISOR_WORKDIR:-$PWD}"
}

# Reads the primary /tmp token for the given (already-normalized) role.
# Exit 0: token found and non-empty; prints token.
# Exit 1: token file does not exist.
# Exit 2: token file exists but is empty.
a2a_read_primary_token() {
  local role="$1"
  local token_file="/tmp/a2a_${role}_token"
  if [ ! -f "$token_file" ]; then
    return 1
  fi
  local token
  token=$(cat "$token_file")
  if [ -z "$token" ]; then
    return 2
  fi
  printf '%s\n' "$token"
  return 0
}

# Cleans up a stale /tmp/a2a_join_token. Takes the broker URL as $1.
# If the file exists and is non-empty: posts /leave asynchronously, then removes it.
# If the file exists but is empty: removes it, skips /leave.
# If absent: no-op.
a2a_cleanup_stale_join_token() {
  local base_url="$1"
  local token_file="/tmp/a2a_join_token"
  if [ ! -f "$token_file" ]; then
    return 0
  fi
  local old_token
  old_token=$(cat "$token_file")
  if [ -n "$old_token" ]; then
    (curl -s --max-time 5 -X POST "$base_url/leave" -H "Authorization: Bearer $old_token" > /dev/null 2>&1 &)
  fi
  rm -f "$token_file"
  a2a_clear_role_base_url "join"
}
