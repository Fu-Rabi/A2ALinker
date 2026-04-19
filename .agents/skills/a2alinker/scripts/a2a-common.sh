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

a2a_resolve_base_url() {
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

  local cwd
  cwd="${PWD:-$(pwd)}"
  for artifact_path in \
    "$cwd/.a2a-host-session.json" \
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
    join|listen)
      printf '%s\n' "$cwd/.a2a-listener-session.json"
      ;;
    *)
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
