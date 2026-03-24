#!/usr/bin/env bash
set -euo pipefail

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm not found. Install with: npm i -g pnpm"
  exit 1
fi

echo "Starting backend + frontend..."

pnpm --filter server dev &
SERVER_PID=$!

pnpm --filter web dev &
WEB_PID=$!

cleanup() {
  echo "\nStopping services..."
  kill $SERVER_PID $WEB_PID 2>/dev/null || true
}

trap cleanup SIGINT SIGTERM EXIT

wait $SERVER_PID $WEB_PID
