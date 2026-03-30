#!/bin/bash
# A2A Linker — Send Message Script
# Sends a message to the session and waits for [DELIVERED] confirmation.
# All internal operations (printf, sleep, tail) run as subprocesses — no
# separate tool approval needed. One named script call = one auto-approved action.
#
# Usage: bash .agents/skills/a2alinker/scripts/a2a-send.sh [host|join] "message [OVER|STANDBY]"
# Exit 0 = DELIVERED, Exit 1 = NOT_DELIVERED

ROLE="${1:-host}"
MESSAGE="${2:-}"

INPUT_FILE="/tmp/a2a_${ROLE}_in"
LOG_FILE="/tmp/a2a_${ROLE}_out.log"

if [ -z "$MESSAGE" ]; then
  echo "ERROR: No message provided."
  echo "Usage: bash .agents/skills/a2alinker/scripts/a2a-send.sh [host|join] \"message [OVER]\""
  exit 1
fi

# Record current log size so we only look at NEW content for [DELIVERED]
INITIAL_SIZE=$(wc -c < "$LOG_FILE" 2>/dev/null || echo 0)

# Send the message — %s prevents printf from interpreting format specifiers in the message
printf '%s\n' "$MESSAGE" >> "$INPUT_FILE"

# Wait up to 10s for [DELIVERED] to appear in new log content
ELAPSED=0
while [ "$ELAPSED" -lt 10 ]; do
  sleep 1
  CURRENT_SIZE=$(wc -c < "$LOG_FILE" 2>/dev/null || echo 0)
  if [ "$CURRENT_SIZE" -gt "$INITIAL_SIZE" ]; then
    NEW_CONTENT=$(tail -c "+$((INITIAL_SIZE + 1))" "$LOG_FILE" 2>/dev/null)
    INITIAL_SIZE=$CURRENT_SIZE
    if echo "$NEW_CONTENT" | grep -q '\[DELIVERED\]'; then
      # Save cursor so the wait script knows exactly where to start watching
      wc -c < "$LOG_FILE" > "/tmp/a2a_${ROLE}_cursor" 2>/dev/null
      echo "DELIVERED"
      exit 0
    fi
  fi
  ELAPSED=$((ELAPSED + 1))
done

echo "NOT_DELIVERED: SSH pipe may be broken. The message was written to $INPUT_FILE but the server did not confirm relay."
exit 1
