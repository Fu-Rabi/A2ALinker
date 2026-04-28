#!/bin/bash
# A2A Linker — Send Message Script
# Sends a message to the session via HTTP POST and waits for DELIVERED confirmation.
# Usage: bash .agents/skills/a2alinker/scripts/a2a-send.sh [host|join] "message [OVER|STANDBY]"
# Usage: bash .agents/skills/a2alinker/scripts/a2a-send.sh "message [OVER|STANDBY]"   # defaults to host
# Usage: bash .agents/skills/a2alinker/scripts/a2a-send.sh [host|join] --stdin < message.txt
# Exit 0 = DELIVERED, Exit 1 = NOT_DELIVERED

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/a2a-common.sh"
ROLE="host"
MESSAGE=""
TOKEN_FILE="/tmp/a2a_${ROLE}_token"
READ_STDIN=false

if [ "${1:-}" = "host" ] || [ "${1:-}" = "join" ]; then
  ROLE="$1"
  MESSAGE="${2:-}"
else
  MESSAGE="${1:-}"
fi

TOKEN_FILE="/tmp/a2a_${ROLE}_token"
BASE_URL="$(a2a_resolve_active_base_url_for_role "$ROLE")"

if [ "$MESSAGE" = "--stdin" ]; then
  READ_STDIN=true
  MESSAGE=""
fi

if [ "$READ_STDIN" = true ]; then
  MESSAGE="$(cat)"
fi

if [ -z "$MESSAGE" ]; then
  echo "ERROR: No message provided."
  echo "Usage: bash .agents/skills/a2alinker/scripts/a2a-send.sh [host|join] \"message [OVER]\""
  echo "   or: bash .agents/skills/a2alinker/scripts/a2a-send.sh \"message [OVER]\""
  echo "   or: bash .agents/skills/a2alinker/scripts/a2a-send.sh [host|join] --stdin < message.txt"
  exit 1
fi

TOKEN=$(a2a_read_primary_token "$ROLE") || {
  rc=$?
  if [ "$rc" -eq 1 ]; then
    echo "ERROR: Token file not found at $TOKEN_FILE. Run the connect script first."
  else
    echo "ERROR: Token file is empty. Run the connect script first."
  fi
  exit 1
}

# Write message to temp file to handle large content/special characters safely
TMPFILE=$(mktemp)
cat <<< "$MESSAGE" > "$TMPFILE"

run_send_request() {
  local curl_err_file
  curl_err_file=$(mktemp)
  RESP=$(curl --max-time 30 -sS -w '\n%{http_code}' -X POST "$BASE_URL/send" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: text/plain" \
    --data-binary "@$TMPFILE" 2>"$curl_err_file")
  CURL_EXIT=$?
  CURL_ERR=$(cat "$curl_err_file")
  rm -f "$curl_err_file"
  HTTP_CODE=$(echo "$RESP" | tail -1)
  BODY=$(echo "$RESP" | sed '$d')
}

clear_pending_message_for_outbound "$ROLE"

SEND_ATTEMPT=1
while true; do
  run_send_request
  if [ "$SEND_ATTEMPT" -ge 2 ] || ! a2a_is_remote_base_url "$BASE_URL" || ! a2a_is_retryable_transport_exit "$CURL_EXIT"; then
    break
  fi
  a2a_debug_log "$ROLE" "send:retry base_url=$BASE_URL prior_curl_exit=$CURL_EXIT next_attempt=$((SEND_ATTEMPT + 1)) curl_err=$(a2a_debug_compact_text "$CURL_ERR")"
  SEND_ATTEMPT=$((SEND_ATTEMPT + 1))
done

# Cleanup temp file immediately
rm -f "$TMPFILE"

if [ "$CURL_EXIT" -eq 28 ]; then
  a2a_debug_log "$ROLE" "send:http_timeout base_url=$BASE_URL curl_exit=$CURL_EXIT http_code=$HTTP_CODE body_present=$([ -n "$BODY" ] && echo yes || echo no) curl_err=$(a2a_debug_compact_text "$CURL_ERR")"
elif [ $CURL_EXIT -ne 0 ] || [ "$HTTP_CODE" = "000" ]; then
  a2a_debug_log "$ROLE" "send:http_failed base_url=$BASE_URL curl_exit=$CURL_EXIT http_code=$HTTP_CODE body_present=$([ -n "$BODY" ] && echo yes || echo no) curl_err=$(a2a_debug_compact_text "$CURL_ERR")"
fi

if [ "$HTTP_CODE" = "200" ] && echo "$BODY" | grep -q 'DELIVERED'; then
  echo "DELIVERED"
  exit 0
elif [ $CURL_EXIT -ne 0 ]; then
  echo "NOT_DELIVERED: Cannot reach A2A Linker server at $BASE_URL (curl exit $CURL_EXIT)"
  if [ -n "$CURL_ERR" ]; then
    echo "DETAIL: $(a2a_debug_compact_text "$CURL_ERR")"
  fi
  exit 1
elif [ "$HTTP_CODE" = "000" ]; then
  echo "NOT_DELIVERED: A2A Linker send failed at $BASE_URL (HTTP 000)"
  if [ -n "$CURL_ERR" ]; then
    echo "DETAIL: $(a2a_debug_compact_text "$CURL_ERR")"
  fi
  exit 1
elif [ "$HTTP_CODE" = "401" ]; then
  echo "NOT_DELIVERED: Session expired or invalid (HTTP 401). Please re-run the connect script."
  exit 1
elif [ "$HTTP_CODE" = "503" ]; then
  echo "NOT_DELIVERED: Partner not connected (HTTP 503). Wait for partner to rejoin."
  exit 1
elif [ "$HTTP_CODE" = "429" ]; then
  echo "LOOP_DETECTED: Server paused the session due to repeated messages. Check the session and resume manually."
  exit 0
else
  echo "NOT_DELIVERED: $BODY (HTTP $HTTP_CODE)"
  exit 1
fi
