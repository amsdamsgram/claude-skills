#!/usr/bin/env bash
# deploy.sh lives with the skill and is copied in at build time, so the repo
# keeps one copy of the Cloudflare logic rather than two that drift.
set -euo pipefail
cd "$(dirname "$0")"

cp ../plugins/cloudflare-deploy/skills/cloudflare-deploy/deploy.sh server/deploy.sh
chmod +x server/deploy.sh

node test.mjs
npx -y @anthropic-ai/mcpb pack

echo
echo "Built cloudflare-deploy.mcpb — double-click it, or open it from"
echo "Claude Desktop under Settings > Extensions."
