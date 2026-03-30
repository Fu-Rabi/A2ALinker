#!/bin/bash
# A2A Linker — Event-driven message wait script
# Blocks at the shell layer until a new message or system event appears in the log.
# The AI makes ONE tool call and wakes up only when something relevant happens.
# Usage: bash .agents/skills/a2alinker/scripts/a2a-wait-message.sh [host|join] [timeout_seconds]
# Exit 0 = MESSAGE_RECEIVED, Exit 1 = TIMEOUT

ROLE="${1:-host}"
TIMEOUT="${2:-110}"
LOG_FILE="/tmp/a2a_${ROLE}_out.log"
CURSOR_FILE="/tmp/a2a_${ROLE}_cursor"

# Use the cursor saved by a2a-send.sh if available — it marks exactly where
# the log was when the last send was confirmed delivered, so we never miss a
# reply that arrived between the send completing and this script starting.
# If no cursor exists (first wait of the session), scan the whole log immediately
# in case the other agent already sent something before we started watching.
if [ -f "$CURSOR_FILE" ]; then
  INITIAL_SIZE=$(cat "$CURSOR_FILE")
else
  # No prior send — check if there is already a pending message in the log
  if grep -qE "(Agent-|\[SYSTEM\]:)" "$LOG_FILE" 2>/dev/null; then
    echo "MESSAGE_RECEIVED"
    tail -n 20 "$LOG_FILE"
    exit 0
  fi
  INITIAL_SIZE=$(wc -c < "$LOG_FILE" 2>/dev/null || echo 0)
fi

ELAPSED=0
ACCUMULATED=""

while [ "$ELAPSED" -lt "$TIMEOUT" ]; do
  CURRENT_SIZE=$(wc -c < "$LOG_FILE" 2>/dev/null || echo 0)

  if [ "$CURRENT_SIZE" -gt "$INITIAL_SIZE" ]; then
    NEW_CONTENT=$(tail -c "+$((INITIAL_SIZE + 1))" "$LOG_FILE" 2>/dev/null)
    # Update size regardless of match — prevents re-reading the same bytes next iteration
    INITIAL_SIZE=$CURRENT_SIZE
    ACCUMULATED="${ACCUMULATED}${NEW_CONTENT}"

    if echo "$ACCUMULATED" | grep -qE "(Agent-|\[SYSTEM\]:)"; then
      echo "MESSAGE_RECEIVED"
      # Show only the new content that triggered detection — not the full log.
      # This prevents old messages from confusing the AI.
      printf '%s' "$ACCUMULATED"
      exit 0
    fi
  fi

  sleep 1
  ELAPSED=$((ELAPSED + 1))
done

# Safenet: return current log state before the 120s tool call timeout hits
echo "TIMEOUT: No event received within ${TIMEOUT}s"
tail -n 20 "$LOG_FILE"
exit 1
