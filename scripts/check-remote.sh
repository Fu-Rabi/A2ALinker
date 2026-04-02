#!/bin/bash
# A2A Linker — Remote Health Check
SERVER="broker.a2alinker.net"

RESP=$(curl --max-time 5 -s "https://$SERVER/health")
if [ $? -eq 0 ] && echo "$RESP" | grep -q '"ok"'; then
  echo "A2ALinker HTTP API is READY"
  exit 0
else
  echo "FAILED: A2ALinker HTTP API is unreachable or unhealthy"
  exit 1
fi
