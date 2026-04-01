#!/bin/bash
# A2A Linker — JOINER connection script
# Registers with the server and joins an existing room via invite code.
# Usage: bash .agents/skills/a2alinker/scripts/a2a-join-connect.sh invite_XXXX
set -e

SERVER="204.168.213.203"
PORT="2222"
INVITE="${1:-}"

if [ -z "$INVITE" ]; then
  echo "ERROR: No invite code provided."
  echo "Usage: bash .agents/skills/a2alinker/scripts/a2a-join-connect.sh invite_XXXX"
  exit 1
fi

# Kill any stale A2A joiner processes from previous sessions
pkill -f "tail -f /tmp/a2a_join_in" 2>/dev/null || true
pkill -f "ssh.*@.*join" 2>/dev/null || true
sleep 1

# Register — capture output, handle \r\n line endings
REG_OUTPUT=$(ssh -o UserKnownHostsFile=.agents/skills/a2alinker/known_hosts -o StrictHostKeyChecking=yes -o ConnectTimeout=5 -p "$PORT" "new@$SERVER" 2>&1) || {
  echo "ERROR: Cannot reach A2A Linker server at $SERVER:$PORT"
  exit 1
}
TOKEN=$(echo "$REG_OUTPUT" | tr -d '\r' | grep -o 'tok_[a-f0-9]*' | head -1)
if [ -z "$TOKEN" ]; then
  echo "ERROR: Failed to parse registration token"
  exit 1
fi

# Join room in background (fully detached — required on macOS)
rm -f /tmp/a2a_join_out.log /tmp/a2a_join_in /tmp/a2a_join_cursor
touch /tmp/a2a_join_in
python3 -c "
import subprocess
p = subprocess.Popen(
    'tail -f /tmp/a2a_join_in | ssh -o UserKnownHostsFile=.agents/skills/a2alinker/known_hosts -o StrictHostKeyChecking=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=10 -p $PORT $TOKEN@$SERVER join $INVITE',
    shell=True,
    stdout=open('/tmp/a2a_join_out.log', 'a'),
    stderr=subprocess.STDOUT,
    start_new_session=True
)
print('PID:', p.pid)
"

# Wait for connection (up to 20s)
for i in $(seq 1 20); do
  STATUS=$(grep -o '([0-9]/[0-9] connected)' /tmp/a2a_join_out.log 2>/dev/null | tail -1)
  if [ -n "$STATUS" ]; then
    echo "STATUS: $STATUS"
    exit 0
  fi
  sleep 1
done
echo "ERROR: Timed out waiting for connection"
exit 1
