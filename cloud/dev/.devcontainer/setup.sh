#!/usr/bin/env bash
# postStartCommand - runs on every devcontainer start.
set -euo pipefail
# From the repository root, three levels up from cloud/dev/.devcontainer.
cd "$(dirname "$0")/../../.."

# The GitHub login provider must be configured for Auth to start. Real values
# come from cloud/dev/.env (see cloud/dev/.env.example); placeholders keep the stack bootable.
set -a; [ -f cloud/dev/.env ] && . ./cloud/dev/.env; set +a
export SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID="${SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID:-not-configured}"
export SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET="${SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET:-not-configured}"

# Restart the stack every time. `supabase start` on its own is a no-op against a
# running stack: it applies neither config.toml changes nor repairs stopped
# containers. Plain `stop` (never --no-backup) keeps the data volumes.
npx --yes supabase stop --workdir cloud/db || true
npx --yes supabase start --workdir cloud/db

# The bucket, as sibling containers of the Supabase ones.
docker compose -f cloud/dev/compose.yml up -d

# The Worker's local secrets, written once from what the stack reports.
node cloud/dev/scripts/dev-vars.mjs

echo
echo "Inside this devcontainer:  http://${SUPABASE_SERVICES_HOSTNAME:-127.0.0.1}:54321"
echo "From your host browser:    http://localhost:54321   Studio: http://localhost:54323"
echo "Bucket (S3):               http://localhost:9000"
echo "Then: npm --prefix cloud/web run dev"
