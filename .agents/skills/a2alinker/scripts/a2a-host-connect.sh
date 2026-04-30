#!/bin/bash
# A2A Linker — HOST connection script
# Registers with the server, creates a room, and prints the invite code.
# Optionally accepts a listen_ code to join a pre-staged listener room as HOST.
# For standard host rooms, it can also continue directly into a live join wait
# or a parked background wait without requiring a second top-level command.
# Usage:
#   bash .agents/skills/a2alinker/scripts/a2a-host-connect.sh [--notify-human] [--surface-join-notice|--park] ["" true|false]
#   bash .agents/skills/a2alinker/scripts/a2a-host-connect.sh listen_XXXX

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/a2a-common.sh"
a2a_prompt_for_debug_if_interactive
POST_CONNECT_MODE=""
ORIGINAL_ARGS=("$@")

print_usage() {
  cat <<'EOF'
Usage:
  bash .agents/skills/a2alinker/scripts/a2a-host-connect.sh [--notify-human] [--surface-join-notice|--park] ["" true|false]
  bash .agents/skills/a2alinker/scripts/a2a-host-connect.sh listen_XXXX

Options:
  --surface-join-notice  For standard host rooms, print the invite code and
                         immediately continue into the foreground join wait.
  --park                 For standard host rooms, print the invite code and
                         immediately park the host wait in the background.
  --notify-human         Best-effort local OS notification when JOIN connects.
EOF
}

while [ $# -gt 0 ]; do
  case "${1:-}" in
    --surface-join-notice)
      if [ -n "$POST_CONNECT_MODE" ] && [ "$POST_CONNECT_MODE" != "surface_join_notice" ]; then
        echo "ERROR: --surface-join-notice and --park cannot be combined."
        exit 1
      fi
      POST_CONNECT_MODE="surface_join_notice"
      shift
      ;;
    --park)
      if [ -n "$POST_CONNECT_MODE" ] && [ "$POST_CONNECT_MODE" != "park" ]; then
        echo "ERROR: --surface-join-notice and --park cannot be combined."
        exit 1
      fi
      POST_CONNECT_MODE="park"
      shift
      ;;
    --notify-human)
      export A2A_HUMAN_NOTIFY=1
      shift
      ;;
    --help|-h)
      print_usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done

LISTEN_CODE="${1:-}"
OLD_TOKEN=""
OLD_BASE_URL="$(a2a_resolve_saved_base_url_for_role host)"
if [ -f /tmp/a2a_host_token ]; then
  OLD_TOKEN=$(cat /tmp/a2a_host_token)
fi
BASE_URL="$(a2a_resolve_fresh_base_url)"

a2a_debug_script_lifecycle_start "host" "host_connect.sh" "${ORIGINAL_ARGS[@]}"
trap 'a2a_debug_script_lifecycle_end "host" "host_connect.sh" "$?"' EXIT
host_connect_signal_exit() {
  local signal_name="$1"
  local exit_code="$2"
  a2a_debug_signal_exit "host" "host_connect.sh" "$signal_name" "$exit_code"
  exit "$exit_code"
}
trap 'host_connect_signal_exit HUP 129' HUP
trap 'host_connect_signal_exit INT 130' INT
trap 'host_connect_signal_exit QUIT 131' QUIT
trap 'host_connect_signal_exit PIPE 141' PIPE
trap 'host_connect_signal_exit TERM 143' TERM
a2a_debug_log "host" "host_connect:parsed post_connect_mode=${POST_CONNECT_MODE:-none} listen_code_present=$([ -n "$LISTEN_CODE" ] && echo yes || echo no) base_url=$BASE_URL"

print_connect_error() {
  local curl_exit="$1"
  local curl_err="$2"
  echo "ERROR: Cannot reach A2A Linker server at $BASE_URL (curl exit $curl_exit)"
  if [ -n "$curl_err" ]; then
    echo "DETAIL: $(a2a_debug_compact_text "$curl_err")"
  fi
}

persist_host_session_artifact() {
  local status="$1"
  local attached_listener_code="$2"
  local invite_code="$3"
  local headless="$4"
  local token="$5"
  local session_dir artifact_path now attached_listener_json invite_json

  session_dir="$(mktemp -d "${TMPDIR:-/tmp}/a2a-host-session-XXXXXX")" || return 1
  artifact_path="${PWD}/.a2a-host-session.json"
  now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  attached_listener_json="null"
  invite_json="null"

  if [ -n "$attached_listener_code" ]; then
    attached_listener_json="\"$attached_listener_code\""
  fi
  if [ -n "$invite_code" ]; then
    invite_json="\"$invite_code\""
  fi

  printf '%s\n' "$token" > "$session_dir/a2a_host_token"
  chmod 600 "$session_dir/a2a_host_token"

  cat > "$artifact_path" <<EOF
{
  "mode": "host",
  "status": "$status",
  "attachedListenerCode": $attached_listener_json,
  "inviteCode": $invite_json,
  "brokerEndpoint": "$BASE_URL",
  "headless": $headless,
  "sessionDir": "$session_dir",
  "pid": null,
  "startedAt": "$now",
  "updatedAt": "$now",
  "source": "local_cache",
  "lastEvent": "$status",
  "error": null
}
EOF
}

store_host_token() {
  local new_token="$1"
  echo "$new_token" > /tmp/a2a_host_token
  chmod 600 /tmp/a2a_host_token

  if [ -n "$OLD_TOKEN" ] && [ "$OLD_TOKEN" != "$new_token" ]; then
    (curl -s --max-time 5 -X POST "$OLD_BASE_URL/leave" -H "Authorization: Bearer $OLD_TOKEN" > /dev/null 2>&1 &)
  fi
}

run_post_connect_mode() {
  local mode_label rc
  case "$POST_CONNECT_MODE" in
    surface_join_notice)
      mode_label="surface_join_notice"
      echo "FOLLOW_UP_MODE: surface_join_notice"
      echo 'FOLLOW_UP_DETAIL: Continuing directly into foreground host join wait.'
      a2a_debug_log "host" "host_connect:post_connect_invoke mode=$mode_label"
      bash "$SCRIPT_DIR/a2a-chat.sh" --surface-join-notice host
      rc=$?
      a2a_debug_log "host" "host_connect:post_connect_complete mode=$mode_label exit_code=$rc"
      return "$rc"
      ;;
    park)
      mode_label="park"
      echo "FOLLOW_UP_MODE: park"
      echo 'FOLLOW_UP_DETAIL: Parking host join wait for explicit later recovery; this is not active chat monitoring after the current turn ends.'
      echo 'FOLLOW_UP_RECOVERY: When the other side has joined, ask to recover the host session so the join can be confirmed.'
      a2a_debug_log "host" "host_connect:post_connect_invoke mode=$mode_label"
      bash "$SCRIPT_DIR/a2a-chat.sh" --park host
      rc=$?
      a2a_debug_log "host" "host_connect:post_connect_complete mode=$mode_label exit_code=$rc"
      return "$rc"
      ;;
  esac
}

host_cached_token_present() {
  [ -f /tmp/a2a_host_token ] && [ -s /tmp/a2a_host_token ]
}

print_cached_host_session_details() {
  local artifact_path="$1"
  local token_present="$2"

  if [ -f "$artifact_path" ]; then
    local status invite_code listener_code broker updated_at started_at last_event session_dir
    status="$(a2a_read_field_from_artifact "$artifact_path" "status" 2>/dev/null || true)"
    invite_code="$(a2a_read_field_from_artifact "$artifact_path" "inviteCode" 2>/dev/null || true)"
    listener_code="$(a2a_read_field_from_artifact "$artifact_path" "attachedListenerCode" 2>/dev/null || true)"
    broker="$(a2a_read_field_from_artifact "$artifact_path" "brokerEndpoint" 2>/dev/null || true)"
    updated_at="$(a2a_read_field_from_artifact "$artifact_path" "updatedAt" 2>/dev/null || true)"
    started_at="$(a2a_read_field_from_artifact "$artifact_path" "startedAt" 2>/dev/null || true)"
    last_event="$(a2a_read_field_from_artifact "$artifact_path" "lastEvent" 2>/dev/null || true)"
    session_dir="$(a2a_read_field_from_artifact "$artifact_path" "sessionDir" 2>/dev/null || true)"

    echo "HOST_SESSION_STATUS: ${status:-unknown}"
    if [ -n "$invite_code" ]; then
      echo "HOST_SESSION_INVITE_CODE: $invite_code"
    fi
    if [ -n "$listener_code" ]; then
      echo "HOST_SESSION_ATTACHED_LISTENER_CODE: $listener_code"
    fi
    if [ -n "$broker" ]; then
      echo "HOST_SESSION_BROKER: $broker"
    fi
    if [ -n "$started_at" ]; then
      echo "HOST_SESSION_STARTED_AT: $started_at"
    fi
    if [ -n "$updated_at" ]; then
      echo "HOST_SESSION_UPDATED_AT: $updated_at"
    fi
    if [ -n "$last_event" ]; then
      echo "HOST_SESSION_LAST_EVENT: $last_event"
    fi
    if [ -n "$session_dir" ]; then
      echo "HOST_SESSION_DIR: $session_dir"
    fi
  else
    echo "HOST_SESSION_STATUS: unknown"
    echo "HOST_SESSION_DETAIL: /tmp/a2a_host_token exists but .a2a-host-session.json is missing."
  fi

  echo "HOST_SESSION_TOKEN_PRESENT: $token_present"
}

guard_standard_host_room_creation() {
  local artifact_path token_present current_status unknown_status_blocked
  artifact_path="${PWD}/.a2a-host-session.json"
  token_present="false"
  unknown_status_blocked="false"
  if host_cached_token_present; then
    token_present="true"
  fi

  if [ "${A2A_ALLOW_REPLACE_HOST_SESSION:-}" = "true" ]; then
    a2a_debug_log "host" "host_connect:replace_override active=1 artifact_present=$([ -f "$artifact_path" ] && echo yes || echo no) token_present=$token_present"
    return 0
  fi

  if [ ! -f "$artifact_path" ]; then
    return 0
  fi

  current_status="$(a2a_read_field_from_artifact "$artifact_path" "status" 2>/dev/null || true)"
  case "$current_status" in
    closed|error|interrupted)
      return 0
      ;;
    starting|waiting_for_join|waiting_for_host|connected|waiting_for_local_task|waiting_for_partner_reply|retrying|paused|stale_local_state)
      ;;
    *)
      current_status="${current_status:-unknown}"
      unknown_status_blocked="true"
      ;;
  esac

  a2a_debug_log "host" "host_connect:guard_blocked reason=status status=$current_status"
  echo "ERROR: Refusing to create a new host room because a cached host session is still active or ambiguous."
  print_cached_host_session_details "$artifact_path" "$token_present"
  if [ "$unknown_status_blocked" = "true" ]; then
    echo "HOST_SESSION_DETAIL: Cached host state is missing or uses an unrecognized status, so replacement is blocked by default."
  fi
  echo "NEXT_STEP: Inspect the current host state with: bash .agents/skills/a2alinker/scripts/a2a-supervisor.sh --mode host --status"
  echo "NEXT_STEP: If you intend to replace it, rerun with A2A_ALLOW_REPLACE_HOST_SESSION=true."
  return 1
}

if [ -n "$LISTEN_CODE" ]; then
  if [ -n "$POST_CONNECT_MODE" ]; then
    echo "ERROR: --surface-join-notice and --park are only valid for fresh host room creation, not listener attach."
    exit 1
  fi
  a2a_debug_log "host" "host_connect:start mode=listener_attach listen_code=$LISTEN_CODE base_url=$BASE_URL"
  # Listener flow: join the pre-staged room, become HOST
  # Now 1 round-trip: register + join in one call
  run_attach_request() {
    local curl_err_file
    curl_err_file=$(mktemp)
    RESP=$(curl --max-time 15 -sS -X POST "$BASE_URL/register-and-join/$LISTEN_CODE" 2>"$curl_err_file")
    CURL_EXIT=$?
    CURL_ERR=$(cat "$curl_err_file")
    rm -f "$curl_err_file"
  }

  ATTACH_ATTEMPT=1
  while true; do
    run_attach_request
    if { [ $CURL_EXIT -eq 0 ] && [ -n "$RESP" ]; } || [ "$ATTACH_ATTEMPT" -ge 2 ] || ! a2a_is_remote_base_url "$BASE_URL" || ! a2a_is_retryable_transport_exit "$CURL_EXIT"; then
      break
    fi
    a2a_debug_log "host" "host_connect:attach_retry base_url=$BASE_URL prior_curl_exit=$CURL_EXIT next_attempt=$((ATTACH_ATTEMPT + 1)) curl_err=$(a2a_debug_compact_text "$CURL_ERR")"
    ATTACH_ATTEMPT=$((ATTACH_ATTEMPT + 1))
  done

  if [ $CURL_EXIT -ne 0 ] || [ -z "$RESP" ]; then
    a2a_debug_log "host" "host_connect:attach_failed base_url=$BASE_URL curl_exit=$CURL_EXIT response_present=$([ -n "$RESP" ] && echo yes || echo no) curl_err=$(a2a_debug_compact_text "$CURL_ERR")"
    print_connect_error "$CURL_EXIT" "$CURL_ERR"
    exit 1
  fi

  if echo "$RESP" | grep -q '"error"'; then
    ERROR=$(echo "$RESP" | sed -En 's/.*"error":"([^"]*)".*/\1/p')
    a2a_debug_log "host" "host_connect:attach_error error=${ERROR:-unknown}"
    echo "ERROR: ${ERROR:-Listener code invalid or already used}"
    exit 1
  fi

  TOKEN=$(echo "$RESP" | grep -o 'tok_[a-f0-9]*')
  if [ -z "$TOKEN" ]; then
    a2a_debug_log "host" "host_connect:attach_parse_failed missing_token=1"
    echo "ERROR: Failed to parse token from response"
    exit 1
  fi

  store_host_token "$TOKEN"
  a2a_store_role_base_url "host" "$BASE_URL"

  STATUS=$(echo "$RESP" | grep -o '([0-9]/[0-9] connected)')
  HEADLESS=$(echo "$RESP" | sed -En 's/.*"headless": *(true|false).*/\1/p')
  persist_host_session_artifact "connected" "$LISTEN_CODE" "" "${HEADLESS:-false}" "$TOKEN"
  a2a_debug_log "host" "host_connect:attach_complete status=${STATUS:-unknown} headless=${HEADLESS:-unknown}"
  echo "STATUS: $STATUS"
  echo "ROLE: host"
  echo "HEADLESS: $HEADLESS"
  echo 'NEXT_STEP: HOST sends the first message. Use: bash .agents/skills/a2alinker/scripts/a2a-loop.sh host "your message [OVER]"'
else
  a2a_debug_log "host" "host_connect:start mode=standard base_url=$BASE_URL"
  # Standard flow: register + create room in 1 round-trip
  HEADLESS_ARG="${2:-false}"
  guard_standard_host_room_creation || exit 1
  run_setup_request() {
    local curl_err_file
    curl_err_file=$(mktemp)
    RESP=$(curl --max-time 15 -sS -X POST "$BASE_URL/setup" \
      -H "Content-Type: application/json" \
      -d "{\"type\": \"standard\", \"headless\": $HEADLESS_ARG}" 2>"$curl_err_file")
    CURL_EXIT=$?
    CURL_ERR=$(cat "$curl_err_file")
    rm -f "$curl_err_file"
  }

  SETUP_ATTEMPT=1
  while true; do
    run_setup_request
    if { [ $CURL_EXIT -eq 0 ] && [ -n "$RESP" ]; } || [ "$SETUP_ATTEMPT" -ge 2 ] || ! a2a_is_remote_base_url "$BASE_URL" || ! a2a_is_retryable_transport_exit "$CURL_EXIT"; then
      break
    fi
    a2a_debug_log "host" "host_connect:setup_retry base_url=$BASE_URL prior_curl_exit=$CURL_EXIT next_attempt=$((SETUP_ATTEMPT + 1)) curl_err=$(a2a_debug_compact_text "$CURL_ERR")"
    SETUP_ATTEMPT=$((SETUP_ATTEMPT + 1))
  done

  if [ $CURL_EXIT -ne 0 ] || [ -z "$RESP" ]; then
    a2a_debug_log "host" "host_connect:setup_failed base_url=$BASE_URL curl_exit=$CURL_EXIT response_present=$([ -n "$RESP" ] && echo yes || echo no) curl_err=$(a2a_debug_compact_text "$CURL_ERR")"
    print_connect_error "$CURL_EXIT" "$CURL_ERR"
    exit 1
  fi

  TOKEN=$(echo "$RESP" | grep -o 'tok_[a-f0-9]*')
  INVITE=$(echo "$RESP" | grep -o 'invite_[a-zA-Z0-9]*')

  if [ -z "$TOKEN" ] || [ -z "$INVITE" ]; then
    ERROR=$(echo "$RESP" | sed -En 's/.*"error":"([^"]*)".*/\1/p')
    a2a_debug_log "host" "host_connect:setup_parse_failed error=${ERROR:-unknown}"
    echo "ERROR: ${ERROR:-Failed to create room}"
    exit 1
  fi

  store_host_token "$TOKEN"
  a2a_store_role_base_url "host" "$BASE_URL"
  persist_host_session_artifact "waiting_for_join" "" "$INVITE" "$HEADLESS_ARG" "$TOKEN"
  a2a_debug_log "host" "host_connect:setup_complete invite_code=$INVITE headless=$HEADLESS_ARG"
  echo "ROLE: host"
  echo "INVITE_CODE: $INVITE"
  echo "HEADLESS_SET: $HEADLESS_ARG"
  echo 'NEXT_STEP: Share INVITE_CODE with the joiner. For live same-turn monitoring use: bash .agents/skills/a2alinker/scripts/a2a-chat.sh --surface-join-notice host'
  echo 'NEXT_STEP: If you cannot keep the turn open, park the host session for explicit later recovery with: bash .agents/skills/a2alinker/scripts/a2a-chat.sh --park host'
  echo 'NEXT_STEP: If parked, tell the human: When the other side has joined, ask me to recover the host session and I will confirm whether it joined.'
  if [ -n "$POST_CONNECT_MODE" ]; then
    run_post_connect_mode
    exit $?
  fi
fi

exit 0
