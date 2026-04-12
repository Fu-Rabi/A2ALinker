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
    echo "Or:  bash .agents/skills/a2alinker/scripts/a2a-supervisor.sh --mode host --listener-code $INVITE --agent-label codex --goal \"<task>\""
    exit 1
    ;;
esac

# Clean up stale session from previous run (backgrounded to avoid blocking)
if [ -f /tmp/a2a_join_token ]; then
  OLD_TOKEN=$(cat /tmp/a2a_join_token)
  if [ -n "$OLD_TOKEN" ]; then
    (curl -s --max-time 5 -X POST "$BASE_URL/leave" -H "Authorization: Bearer $OLD_TOKEN" > /dev/null 2>&1 &)
  fi
  rm -f /tmp/a2a_join_token
fi

# One-shot setup: register + join room in 1 round-trip
RESP=$(curl --max-time 15 -s -X POST "$BASE_URL/register-and-join/$INVITE")

if [ $? -ne 0 ] || [ -z "$RESP" ]; then
  echo "ERROR: Cannot reach A2A Linker server"
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
