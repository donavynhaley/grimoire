#!/usr/bin/env bash
#
# Builds and seeds a throwaway Grimoire on http://127.0.0.1:8099 to look at a change with
# data in front of it. Safe to run repeatedly: it starts from an empty ./demo-data every time.
#
#   scripts/demo.sh          build, seed, and start
#   scripts/demo.sh down     stop it and delete the data
#   scripts/demo.sh logs     follow the container log
#
set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE="docker compose -f compose.demo.yaml"
URL="http://127.0.0.1:8099"

case "${1:-up}" in
  down)
    $COMPOSE down --volumes --remove-orphans
    rm -rf demo-data
    echo "Demo stopped and its data deleted."
    exit 0
    ;;
  logs)
    exec $COMPOSE logs -f
    ;;
esac

echo "==> Clearing any previous demo"
$COMPOSE down --volumes --remove-orphans >/dev/null 2>&1 || true
rm -rf demo-data
mkdir -p demo-data

echo "==> Building"
$COMPOSE build

echo "==> Starting"
$COMPOSE up -d

echo "==> Seeding"
node scripts/seed-demo.mjs "$URL"

# The timestamps are part of what this section looks like, and everything the seeder wrote is
# stamped with the moment it ran. Stop, spread it over a few days, start again.
echo "==> Backdating the conversation"
$COMPOSE stop >/dev/null
node scripts/backdate-demo.mjs ./demo-data/grimoire.sqlite
$COMPOSE start >/dev/null

echo ""
echo "  Grimoire is at $URL"
echo "  Sign in as alex@example.test / 'a long enough password'"
echo ""
echo "  Stop it with: scripts/demo.sh down"
