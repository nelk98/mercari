#!/usr/bin/env bash
set -euo pipefail

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm not found. Install with: npm i -g pnpm"
  exit 1
fi

if ! command -v ngrok >/dev/null 2>&1; then
  echo "ngrok not found. Install with: brew install ngrok"
  exit 1
fi

echo "Starting backend + frontend..."
pnpm run dev &
DEV_PID=$!

sleep 2

echo "Starting ngrok (port 2999)..."
ngrok http 2999

kill $DEV_PID
