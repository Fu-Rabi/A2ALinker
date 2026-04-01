#!/bin/bash
# A2ALinker Remote Health Check Utility

SERVER="204.168.213.203"
PORT="2222"

echo "🔍 Checking A2ALinker Remote health ($SERVER:$PORT)..."

# 1. Network Connectivity
if ping -c 1 -W 2 "$SERVER" > /dev/null 2>&1; then
    echo "  ✅ Host $SERVER is UP"
else
    echo "  ❌ Host $SERVER is DOWN or ignoring pings"
fi

# 2. Port Accessibility
if nc -zv -w 3 "$SERVER" "$PORT" > /dev/null 2>&1; then
    echo "  ✅ Port $PORT is OPEN and listening"
else
    echo "  ❌ Port $PORT is CLOSED or blocked by firewall"
    echo "     Double check 'ufw status' on the VPS."
    exit 1
fi

# 3. Application / Database Health (via Test Registration)
echo "  🔄 Running production broker self-test..."
REG_OUTPUT=$(ssh -o UserKnownHostsFile=.agents/skills/a2alinker/known_hosts -o StrictHostKeyChecking=yes -o ConnectTimeout=5 -p "$PORT" "new@$SERVER" 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ] && echo "$REG_OUTPUT" | grep -q 'tok_'; then
    TOKEN=$(echo "$REG_OUTPUT" | grep -o 'tok_[a-f0-9]*' | head -1)
    echo "  ✅ Broker is healthy (Database is responsive)"
    echo "  ✅ Test Registration Successful! Token received: $TOKEN"
else
    echo "  ❌ Broker self-test FAILED"
    echo "     Error output: $REG_OUTPUT"
    echo "     Possible issues: database lock, process crash, or disk full."
    exit 1
fi

echo ""
echo "🎉 A2ALinker is READY for production sessions."
