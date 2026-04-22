#!/bin/bash
# A2A Linker — Wait for Message Script
# Long-polls the server and blocks until a message arrives or timeout.
# Usage: bash .agents/skills/a2alinker/scripts/a2a-wait-message.sh [host|join]
# Exit 0 = HTTP 200 received, Exit 1 = error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/a2a-common.sh"
ROLE="${1:-host}"
TOKEN_FILE="/tmp/a2a_${ROLE}_token"
WAIT_POLL_TIMEOUT="${A2A_WAIT_POLL_TIMEOUT:-15}"
BASE_URL="$(a2a_resolve_active_base_url_for_role "$ROLE")"

listener_closed_locally() {
  local artifact_path status
  artifact_path="$(a2a_artifact_path_for_role listen 2>/dev/null || true)"
  if [ -z "$artifact_path" ] || [ ! -f "$artifact_path" ]; then
    return 1
  fi
  status="$(a2a_read_field_from_artifact "$artifact_path" "status" 2>/dev/null || true)"
  [ "$status" = "closed" ]
}

TOKEN=$(a2a_read_primary_token "$ROLE") || {
  rc=$?
  if [ "$rc" -eq 1 ]; then
    if [ "$ROLE" = "host" ] && listener_closed_locally; then
      a2a_debug_log "$ROLE" "wait:token_missing local_listener_closed=1"
      echo "TIMEOUT_ROOM_CLOSED"
      exit 0
    fi
    echo "ERROR: Token file not found at $TOKEN_FILE. Run the connect script first."
  else
    if [ "$ROLE" = "host" ] && listener_closed_locally; then
      a2a_debug_log "$ROLE" "wait:token_empty local_listener_closed=1"
      echo "TIMEOUT_ROOM_CLOSED"
      exit 0
    fi
    echo "ERROR: Token file is empty. Run the connect script first."
  fi
  exit 1
}

a2a_debug_log "$ROLE" "wait:start timeout=${WAIT_POLL_TIMEOUT}s base_url=$BASE_URL"

# Use shorter client-side long-polls so a missed broker wake does not strand a
# queued reply for the full server wait timeout. The next /wait call will pick
# up any message already sitting in the inbox.
CURL_WAIT_ERR_FILE=$(mktemp)
RESP=$(curl --max-time "$WAIT_POLL_TIMEOUT" -s -w '\n%{http_code}' --no-buffer \
  "$BASE_URL/wait" \
  -H "Authorization: Bearer $TOKEN" 2>"$CURL_WAIT_ERR_FILE")
CURL_WAIT_EXIT=$?
CURL_WAIT_ERR=$(cat "$CURL_WAIT_ERR_FILE")
rm -f "$CURL_WAIT_ERR_FILE"

HTTP_CODE=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

if [ $CURL_WAIT_EXIT -ne 0 ] || [ "$HTTP_CODE" = "000" ]; then
  a2a_debug_log "$ROLE" "wait:http_failed curl_exit=$CURL_WAIT_EXIT http_code=$HTTP_CODE body_present=$([ -n "$BODY" ] && echo yes || echo no) curl_err=$(a2a_debug_compact_text "$CURL_WAIT_ERR")"
fi

if [ "$HTTP_CODE" = "200" ] && echo "$BODY" | grep -q '^MESSAGE_RECEIVED'; then
  a2a_debug_log "$ROLE" "wait:http code=$HTTP_CODE first_line=$(printf '%s' "$BODY" | head -n 1)"
  echo "$BODY"
  exit 0
fi

if [ "$HTTP_CODE" = "200" ] && echo "$BODY" | grep -q '^TIMEOUT:'; then
  a2a_debug_log "$ROLE" "wait:http code=$HTTP_CODE timeout_expired=1"
  echo "TIMEOUT_WAIT_EXPIRED"
  exit 0
fi

if [ "$HTTP_CODE" = "409" ] && echo "$BODY" | grep -q 'Wait already pending'; then
  a2a_debug_log "$ROLE" "wait:http code=$HTTP_CODE duplicate_wait=1"
  echo "WAIT_ALREADY_PENDING"
  exit 0
fi

if [ "$HTTP_CODE" = "503" ] && echo "$BODY" | grep -q 'Broker is draining'; then
  a2a_debug_log "$ROLE" "wait:http code=$HTTP_CODE draining=1"
  echo "WAIT_BROKER_DRAINING"
  exit 0
fi

if [ "$HTTP_CODE" = "401" ]; then
  a2a_debug_log "$ROLE" "wait:http code=$HTTP_CODE unauthorized=1"
  echo "WAIT_UNAUTHORIZED"
  exit 0
fi

if [ "$HTTP_CODE" = "400" ] && echo "$BODY" | grep -q 'Not in a room'; then
  a2a_debug_log "$ROLE" "wait:http code=$HTTP_CODE room_closed=1"
  echo "TIMEOUT_ROOM_CLOSED"
  exit 0
fi

# On timeout or error, auto-ping to give the SKILL actionable context
CURL_PING_ERR_FILE=$(mktemp)
PING=$(curl --max-time 5 -s -w '\n%{http_code}' \
  "$BASE_URL/ping" \
  -H "Authorization: Bearer $TOKEN" 2>"$CURL_PING_ERR_FILE")
PING_EXIT=$?
PING_ERR=$(cat "$CURL_PING_ERR_FILE")
rm -f "$CURL_PING_ERR_FILE"
PING_CODE=$(echo "$PING" | tail -1)
PING_BODY=$(echo "$PING" | sed '$d')

if [ "$PING_CODE" = "400" ]; then
  a2a_debug_log "$ROLE" "wait:ping code=$PING_CODE room_closed=1"
  echo "TIMEOUT_ROOM_CLOSED"
  exit 0
elif [ "$PING_CODE" = "200" ]; then
  LAST_SEEN=$(echo "$PING_BODY" | grep -o '"partner_last_seen_ms":[0-9]*' | grep -o '[0-9]*')
  a2a_debug_log "$ROLE" "wait:ping code=$PING_CODE room_alive=1 last_seen_ms=${LAST_SEEN:-0}"
  echo "TIMEOUT_ROOM_ALIVE last_seen_ms=${LAST_SEEN:-0}"
  exit 0
else
  a2a_debug_log "$ROLE" "wait:ping code=$PING_CODE failed=1 curl_exit=$PING_EXIT body_present=$([ -n "$PING_BODY" ] && echo yes || echo no) curl_err=$(a2a_debug_compact_text "$PING_ERR")"
  echo "TIMEOUT_PING_FAILED"
  exit 1
fi
