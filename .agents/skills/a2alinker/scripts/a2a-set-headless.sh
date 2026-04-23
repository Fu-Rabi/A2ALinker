#!/bin/bash
# A2A Linker — Set Headless Room Rule
# Sets the autonomous mode room rule. When headless=true, agents will never
# prompt the user for input during the session.
# The partner agent will be notified automatically on their next /join.
# Usage: bash .agents/skills/a2alinker/scripts/a2a-set-headless.sh [host|join] [true|false]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/a2a-common.sh"
ROLE="${1:-host}"
HEADLESS="${2:-false}"
TOKEN_FILE="/tmp/a2a_${ROLE}_token"
BASE_URL="$(a2a_resolve_active_base_url_for_role "$ROLE")"

TOKEN=$(a2a_read_primary_token "$ROLE") || {
  echo "ERROR: No token found at $TOKEN_FILE"
  exit 1
}

CURL_ERR_FILE=$(mktemp)
RESP=$(curl --max-time 10 -sS -X POST "$BASE_URL/room-rule/headless" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"headless\": $HEADLESS}" 2>"$CURL_ERR_FILE")
CURL_EXIT=$?
CURL_ERR=$(cat "$CURL_ERR_FILE")
rm -f "$CURL_ERR_FILE"

if [ $CURL_EXIT -ne 0 ] || [ -z "$RESP" ]; then
  echo "ERROR: Cannot reach A2A Linker server at $BASE_URL (curl exit $CURL_EXIT)"
  if [ -n "$CURL_ERR" ]; then
    echo "DETAIL: $(a2a_debug_compact_text "$CURL_ERR")"
  fi
  exit 1
fi

if echo "$RESP" | grep -q '"error"'; then
  ERROR=$(echo "$RESP" | sed 's/.*"error":"\([^"]*\)".*/\1/')
  if [ "$ERROR" = "Unauthorized" ]; then
    echo "ERROR: Token expired or server restarted. Clearing $TOKEN_FILE."
    rm -f "$TOKEN_FILE"
  else
    echo "ERROR: $ERROR"
  fi
  exit 1
fi

echo "HEADLESS_SET: $HEADLESS"
exit 0
