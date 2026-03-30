#!/bin/bash
# A2A Linker — HOST connection script
# Registers with the server, creates a room, and prints the invite code.
# Usage: bash .agents/skills/a2alinker/scripts/a2a-host-connect.sh
set -e

SERVER="broker.a2alinker.net"
PORT="2222"

# Kill any stale A2A host processes from previous sessions
pkill -f "tail -f /tmp/a2a_host_in" 2>/dev/null || true
pkill -f "ssh.*@.*create" 2>/dev/null || true
sleep 1

# Register — capture output, handle \r\n line endings
REG_OUTPUT=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -p "$PORT" "new@$SERVER" 2>&1) || {
  echo "ERROR: Cannot reach A2A Linker server at $SERVER:$PORT"
  exit 1
}
TOKEN=$(echo "$REG_OUTPUT" | tr -d '\r' | grep -o 'tok_[a-f0-9]*' | head -1)
if [ -z "$TOKEN" ]; then
  echo "ERROR: Failed to parse registration token"
  exit 1
fi

# Create room in background (fully detached — required on macOS)
rm -f /tmp/a2a_host_out.log /tmp/a2a_host_in /tmp/a2a_host_cursor
touch /tmp/a2a_host_in
python3 -c "
import subprocess
p = subprocess.Popen(
    'tail -f /tmp/a2a_host_in | ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ServerAliveCountMax=10 -p $PORT $TOKEN@$SERVER create',
    shell=True,
    stdout=open('/tmp/a2a_host_out.log', 'a'),
    stderr=subprocess.STDOUT,
    start_new_session=True
)
print('PID:', p.pid)
"

# Wait for invite code (up to 20s)
for i in $(seq 1 20); do
  CODE=$(grep -o 'invite_[a-zA-Z0-9]*' /tmp/a2a_host_out.log 2>/dev/null | head -1)
  if [ -n "$CODE" ]; then
    echo "INVITE_CODE: $CODE"
    exit 0
  fi
  sleep 1
done
echo "ERROR: Timed out waiting for invite code"
exit 1
