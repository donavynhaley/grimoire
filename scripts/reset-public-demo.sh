#!/usr/bin/env bash
# Resets only the dedicated public demo's Compose project and named volume.
set -euo pipefail
cd "$(dirname "$0")/.."
exec 9>.public-demo-reset.lock
flock -n 9 || exit 0
compose=(docker compose -p grimoire-public-demo -f compose.public-demo.yaml)
"${compose[@]}" build
"${compose[@]}" down --volumes --remove-orphans
"${compose[@]}" up -d --wait grimoire-demo
"${compose[@]}" exec -T grimoire-demo node scripts/seed-demo.mjs http://127.0.0.1:8080
"${compose[@]}" up -d --wait gateway
