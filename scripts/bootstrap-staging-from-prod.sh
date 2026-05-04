#!/usr/bin/env bash
#
# Seed (or reset) the staging Docker volume from the current prod usage.db.
# Idempotent — running it again at any time refreshes staging from prod and
# wipes any staging-only data that has diverged.
#
# What is preserved: users, user_tokens, request_logs, daily_usage, and any
# other analytics tables.
# What is wiped: the accounts table — Claude OAuth tokens are NOT shared
# between envs because Anthropic rotates refresh tokens on every successful
# refresh, and shared rows would cause the two environments to invalidate
# each other's tokens.
#
# Run from /opt/claude-server-staging on the VPS.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f docker-compose.staging.yml ]; then
  echo "error: docker-compose.staging.yml not found in $(pwd)" >&2
  echo "run this script from /opt/claude-server-staging" >&2
  exit 1
fi

echo "==> stopping staging container..."
docker compose -f docker-compose.yml -f docker-compose.staging.yml down

echo "==> copying prod usage.db into staging volume and wiping accounts table..."
docker run --rm \
  -v claude-server_claude-data:/prod:ro \
  -v claude-data-staging:/staging \
  alpine sh -c '
    apk add --no-cache sqlite >/dev/null
    cp /prod/usage.db /staging/usage.db
    sqlite3 /staging/usage.db "DELETE FROM accounts;"
    echo "==> tables remaining:"
    sqlite3 /staging/usage.db ".tables"
    echo "==> accounts row count (expect 0):"
    sqlite3 /staging/usage.db "SELECT COUNT(*) FROM accounts;"
  '

echo "==> starting staging container..."
docker compose -f docker-compose.yml -f docker-compose.staging.yml up -d

echo "==> done. staging seeded from prod, accounts cleared."
echo "==> add a Claude account at https://falconclaudestaging.duckdns.org/dashboard/accounts"
