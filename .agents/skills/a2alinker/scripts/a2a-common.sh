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
