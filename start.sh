#!/bin/bash
# Undertow startup — starts Neo4j + Undertow service

# Resolve script-relative paths so this works from any cwd
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/service/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found."
  echo "Copy service/.env.example to service/.env and configure it first."
  exit 1
fi
set -a; source "$ENV_FILE"; set +a

if [ -z "$NEO4J_PASS" ]; then
  echo "ERROR: NEO4J_PASS not set in $ENV_FILE"
  exit 1
fi

echo "Starting Undertow..."

# Start Neo4j if not running
if ! docker ps --filter name=neo4j --format '{{.Names}}' | grep -q neo4j; then
  echo "Starting Neo4j..."
  docker start neo4j 2>/dev/null || docker run -d --name neo4j \
    -p 7474:7474 -p 7687:7687 \
    -e NEO4J_AUTH=neo4j/$NEO4J_PASS \
    -e NEO4J_PLUGINS='["apoc", "graph-data-science"]' \
    -v neo4j_data:/data \
    neo4j:community
else
  echo "Neo4j already running."
fi

# Wait for Neo4j to be ready
echo "Waiting for Neo4j..."
until curl -s http://localhost:7474 > /dev/null 2>&1; do sleep 1; done
echo "Neo4j ready."

# Kill existing Undertow service if running
if curl -s http://localhost:3030/health > /dev/null 2>&1; then
  echo "Stopping existing Undertow service..."
  PID=$(netstat -ano 2>/dev/null | grep ':3030.*LISTENING' | awk '{print $5}' | head -1)
  [ -n "$PID" ] && taskkill //PID "$PID" //F > /dev/null 2>&1
  sleep 1
fi

# Start Undertow service (dotenv loads .env automatically)
echo "Starting Undertow service..."
node "$SCRIPT_DIR/service/server.js" &
UNDERTOW_PID=$!

sleep 2
if curl -s http://localhost:3030/health > /dev/null 2>&1; then
  echo ""
  echo "=== Undertow online ==="
  echo "  Neo4j Browser: http://localhost:7474"
  echo "  Undertow API:   http://localhost:3030"
  echo "  Health check:  http://localhost:3030/health"
  echo "  PID: $UNDERTOW_PID"
  echo ""
else
  echo "Undertow failed to start. Check logs."
fi

wait $UNDERTOW_PID
