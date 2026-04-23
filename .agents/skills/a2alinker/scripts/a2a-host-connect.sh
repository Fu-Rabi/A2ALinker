#!/bin/bash
# A2A Linker — HOST connection script
# Registers with the server, creates a room, and prints the invite code.
# Optionally accepts a listen_ code to join a pre-staged listener room as HOST.
# Usage:
#   bash .agents/skills/a2alinker/scripts/a2a-host-connect.sh ["" true|false]
#   bash .agents/skills/a2alinker/scripts/a2a-host-connect.sh listen_XXXX

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/a2a-common.sh"
a2a_prompt_for_debug_if_interactive
BASE_URL="$(a2a_resolve_base_url)"
LISTEN_CODE="${1:-}"
OLD_TOKEN=""
if [ -f /tmp/a2a_host_token ]; then
  OLD_TOKEN=$(cat /tmp/a2a_host_token)
fi

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
    (curl -s --max-time 5 -X POST "$BASE_URL/leave" -H "Authorization: Bearer $OLD_TOKEN" > /dev/null 2>&1 &)
  fi
}

if [ -n "$LISTEN_CODE" ]; then
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
  echo 'NEXT_STEP: Share INVITE_CODE with the joiner. After the joiner connects, HOST sends the first message with: bash .agents/skills/a2alinker/scripts/a2a-loop.sh host "your message [OVER]"'
fi

exit 0
