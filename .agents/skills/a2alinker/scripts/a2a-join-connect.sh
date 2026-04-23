#!/bin/bash
# A2A Linker — JOINER connection script
# Registers with the server and joins an existing room via invite code.
# Usage: bash .agents/skills/a2alinker/scripts/a2a-join-connect.sh invite_XXXX

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/a2a-common.sh"
BASE_URL="$(a2a_resolve_base_url)"
INVITE="${A2A_INVITE:-${1:-}}"

if [ -z "$INVITE" ]; then
  echo "ERROR: No invite code provided."
  echo "Usage: export A2A_INVITE=invite_XXXX && bash .agents/skills/a2alinker/scripts/a2a-join-connect.sh"
  echo "       Or (legacy): bash .agents/skills/a2alinker/scripts/a2a-join-connect.sh invite_XXXX"
  exit 1
fi

case "$INVITE" in
  listen_*)
    echo "ERROR: Listener codes must be redeemed by HOST, not JOIN."
    echo "Use: bash .agents/skills/a2alinker/scripts/a2a-host-connect.sh $INVITE"
    echo "For remote brokers, prefer: A2A_BASE_URL=https://<broker> bash .agents/skills/a2alinker/scripts/a2a-host-connect.sh $INVITE"
    exit 1
    ;;
esac

print_connect_error() {
  local curl_exit="$1"
  local curl_err="$2"
  echo "ERROR: Cannot reach A2A Linker server at $BASE_URL (curl exit $curl_exit)"
  if [ -n "$curl_err" ]; then
    echo "DETAIL: $(a2a_debug_compact_text "$curl_err")"
  fi
}

# Clean up stale session from previous run (backgrounded to avoid blocking)
a2a_cleanup_stale_join_token "$BASE_URL"

# One-shot setup: register + join room in 1 round-trip
run_join_request() {
  local curl_err_file
  curl_err_file=$(mktemp)
  RESP=$(curl --max-time 15 -sS -X POST "$BASE_URL/register-and-join/$INVITE" 2>"$curl_err_file")
  CURL_EXIT=$?
  CURL_ERR=$(cat "$curl_err_file")
  rm -f "$curl_err_file"
}

JOIN_ATTEMPT=1
while true; do
  run_join_request
  if { [ $CURL_EXIT -eq 0 ] && [ -n "$RESP" ]; } || [ "$JOIN_ATTEMPT" -ge 2 ] || ! a2a_is_remote_base_url "$BASE_URL" || ! a2a_is_retryable_transport_exit "$CURL_EXIT"; then
    break
  fi
  a2a_debug_log "join" "join_connect:retry base_url=$BASE_URL prior_curl_exit=$CURL_EXIT next_attempt=$((JOIN_ATTEMPT + 1)) curl_err=$(a2a_debug_compact_text "$CURL_ERR")"
  JOIN_ATTEMPT=$((JOIN_ATTEMPT + 1))
done

if [ $CURL_EXIT -ne 0 ] || [ -z "$RESP" ]; then
  a2a_debug_log "join" "join_connect:failed base_url=$BASE_URL curl_exit=$CURL_EXIT response_present=$([ -n "$RESP" ] && echo yes || echo no) curl_err=$(a2a_debug_compact_text "$CURL_ERR")"
  print_connect_error "$CURL_EXIT" "$CURL_ERR"
  exit 1
fi

if echo "$RESP" | grep -q '"error"'; then
  ERROR=$(echo "$RESP" | sed -En 's/.*"error":"([^"]*)".*/\1/p')
  echo "ERROR: ${ERROR:-Invite code invalid or already used}"
  exit 1
fi

TOKEN=$(echo "$RESP" | grep -o 'tok_[a-f0-9]*')
if [ -z "$TOKEN" ]; then
  echo "ERROR: Failed to parse token from response"
  exit 1
fi

echo "$TOKEN" > /tmp/a2a_join_token
chmod 600 /tmp/a2a_join_token
a2a_store_role_base_url "join" "$BASE_URL"

# Print rules text (decoded from JSON \n sequences)
RULES=$(echo "$RESP" | sed -n 's/.*"rules":"\([^"]*\)".*/\1/p' | sed 's/\\n/\n/g')
if [ -n "$RULES" ]; then
  echo "$RULES"
fi

# Print connection status
STATUS=$(echo "$RESP" | grep -o '([0-9]/[0-9] connected)')
if [ -n "$STATUS" ]; then
  echo "STATUS: $STATUS"
fi

echo "ROLE: join"

# Print headless room rule (set by HOST — if true, agent runs without asking user)
HEADLESS=$(echo "$RESP" | sed -En 's/.*"headless": *(true|false).*/\1/p')
if [ -n "$HEADLESS" ]; then
  echo "HEADLESS: $HEADLESS"
fi

echo "NEXT_STEP: Wait for the host to send the first message, or run the supervisor in join mode."

exit 0
