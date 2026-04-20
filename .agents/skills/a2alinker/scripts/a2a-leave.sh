#!/bin/bash
# A2A Linker — Leave Session Script
# Cleanly disconnects the current agent from the relay room.
# Refuses to close an active session unless explicitly authorized by the local human
# or invoked by internal supervisor cleanup after the session is already ending.
# Usage: bash .agents/skills/a2alinker/scripts/a2a-leave.sh [host|join|listen]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/a2a-common.sh"
BASE_URL="$(a2a_resolve_base_url)"
ROLE="${1:-host}"
ORIGINAL_ROLE="$ROLE"
case "$ROLE" in
  listen)
    ROLE="join"
    ;;
  host|join)
    ;;
  *)
    echo "LEAVE_ERROR: Unsupported role '$ROLE'. Use host, join, or listen."
    exit 1
    ;;
esac
TOKEN_FILE="/tmp/a2a_${ROLE}_token"
BACKUP_TOKEN_FILE=""
ARTIFACT_PATH=""
ALLOW_CLOSE="${A2A_ALLOW_CLOSE:-}"
FORCE_CLEANUP="${A2A_FORCE_CLEANUP:-}"

if [ "$FORCE_CLEANUP" != "true" ] && [ "$ALLOW_CLOSE" != "true" ]; then
  echo "LEAVE_DENIED: Refusing to close the A2A session without explicit local human instruction."
  echo "NEXT_STEP: If the human clearly instructed you to close the session, re-run with A2A_ALLOW_CLOSE=true."
  exit 1
fi

case "$ORIGINAL_ROLE" in
  host)
    ARTIFACT_PATH="${PWD}/.a2a-host-session.json"
    ;;
  join|listen)
    ARTIFACT_PATH="${PWD}/.a2a-listener-session.json"
    ;;
esac

if [ -n "$ARTIFACT_PATH" ] && [ -f "$ARTIFACT_PATH" ]; then
  SESSION_DIR=$(a2a_read_field_from_artifact "$ARTIFACT_PATH" "sessionDir" || true)
  if [ -n "${SESSION_DIR:-}" ]; then
    BACKUP_TOKEN_FILE="$SESSION_DIR/a2a_${ROLE}_token"
    TOKEN=$(cat "$BACKUP_TOKEN_FILE" 2>/dev/null)
  fi
fi

if [ -z "$TOKEN" ]; then
  TOKEN=$(a2a_read_primary_token "$ROLE" 2>/dev/null || true)
fi

if [ -z "$TOKEN" ]; then
  STATUS_MODE="$ORIGINAL_ROLE"
  if [ "$STATUS_MODE" = "listen" ]; then
    STATUS_MODE="listen"
  elif [ "$STATUS_MODE" = "join" ]; then
    STATUS_MODE="listen"
  else
    STATUS_MODE="host"
  fi
  echo "LEAVE_ERROR: No token found at $TOKEN_FILE or in the local session backup."
  echo "NEXT_STEP: Use bash .agents/skills/a2alinker/scripts/a2a-supervisor.sh --mode $STATUS_MODE --status to inspect local session state."
  exit 1
fi

RESP=$(curl --max-time 5 -s -X POST "$BASE_URL/leave" \
  -H "Authorization: Bearer $TOKEN")

rm -f "$TOKEN_FILE"
if [ -n "$BACKUP_TOKEN_FILE" ]; then
  rm -f "$BACKUP_TOKEN_FILE"
fi
echo "LEFT"
exit 0
