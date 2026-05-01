#!/bin/bash
# A2A Linker — Listener Setup Script
# Registers with the server and creates a pre-staged room.
# Outputs a listen_ code that HOST will use to connect.
# The redeemer of this code automatically becomes HOST.
# Usage: bash .agents/skills/a2alinker/scripts/a2a-listen.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/a2a-common.sh"
a2a_prompt_for_debug_if_interactive
STALE_BASE_URL="$(a2a_resolve_saved_base_url_for_role join)"
BASE_URL="$(a2a_resolve_fresh_base_url)"

# Clean up stale session from previous run (backgrounded to avoid blocking)
if [ -f /tmp/a2a_join_token ] && [ -s /tmp/a2a_join_token ]; then
  a2a_debug_log "join" "listen:cleanup old_token_present=1"
fi
a2a_cleanup_stale_join_token "$STALE_BASE_URL"

HEADLESS="${1:-false}"
a2a_human_status "Starting listener..."
a2a_debug_log "join" "listen:start headless=$HEADLESS base_url=$BASE_URL"

# One-shot setup: register + create room in 1 round-trip
CURL_ERR_FILE=$(mktemp)
RESP=$(curl --max-time 15 -sS -X POST "$BASE_URL/setup" \
  -H "Content-Type: application/json" \
  -d "{\"type\": \"listener\", \"headless\": $HEADLESS}" 2>"$CURL_ERR_FILE")
CURL_EXIT=$?
CURL_ERR=$(cat "$CURL_ERR_FILE")
rm -f "$CURL_ERR_FILE"

if [ $CURL_EXIT -ne 0 ] || [ -z "$RESP" ]; then
  a2a_debug_log "join" "listen:setup_failed base_url=$BASE_URL curl_exit=$CURL_EXIT response_present=$([ -n "$RESP" ] && echo yes || echo no) curl_err=$(a2a_debug_compact_text "$CURL_ERR")"
  echo "ERROR: Cannot reach A2A Linker server at $BASE_URL (curl exit $CURL_EXIT)"
  if [ -n "$CURL_ERR" ]; then
    echo "DETAIL: $(a2a_debug_compact_text "$CURL_ERR")"
  fi
  exit 1
fi

TOKEN=$(echo "$RESP" | grep -o 'tok_[a-f0-9]*')
LISTEN_CODE=$(echo "$RESP" | grep -o 'listen_[a-zA-Z0-9]*')

if [ -z "$TOKEN" ] || [ -z "$LISTEN_CODE" ]; then
  ERROR=$(echo "$RESP" | sed -En 's/.*"error":"([^"]*)".*/\1/p')
  a2a_debug_log "join" "listen:setup_parse_failed error=${ERROR:-unknown}"
  echo "ERROR: ${ERROR:-Failed to create listener room}"
  exit 1
fi

echo "$TOKEN" > /tmp/a2a_join_token
chmod 600 /tmp/a2a_join_token
a2a_store_role_base_url "join" "$BASE_URL"
a2a_debug_log "join" "listen:setup_complete listener_code=$LISTEN_CODE"

echo "ROLE: join"
echo "LISTENER_CODE: $LISTEN_CODE"
echo "HEADLESS_SET: $HEADLESS"
echo 'NEXT_STEP: Keep the listener running so the host can connect. To observe later session events, stay attached to the listener.'
exit 0
