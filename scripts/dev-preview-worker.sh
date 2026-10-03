#!/bin/bash
# Local dev runner for the DEDICATED preview surface.
#
# WHY A DEDICATED DIRECTORY
# -------------------------
# `wrangler pages dev` has no `--config` flag. Verified against wrangler 4.x:
#
#     $ wrangler pages dev dist-preview -c wrangler.preview.jsonc
#     ✘ ERROR Pages does not support custom paths for the Wrangler
#       configuration file. Remove the --config flag, or use a standard
#       wrangler.jsonc in your project root.
#
# It therefore always reads `wrangler.jsonc` from the *current directory*, no
# matter which asset directory is passed. Running the preview worker from the
# project root made it silently inherit the APPLICATION's config (the Vectorize
# "does not support local development" warning was the tell), and the
# `--d1=DB=artifact-library-production` override synthesised a *different* local
# database than the app's — a second, empty sqlite file with zero tables. Tokens
# then resolved against nothing and `/p/:token` served the refusal notice.
#
# The fix is to run from `.preview-dev/`, which holds its own `wrangler.jsonc`
# that declares the SAME D1 database_id and R2 bucket as the app. Same ID plus
# the same `--persist-to` means the same local sqlite, so the two surfaces share
# state locally exactly as they do in production.
#
# KEPT AS A SCRIPT because a `pkill -f 'dist-preview'` pattern matches the
# invoking shell's own argv and kills the session. Cleanup here is port-based.
#
# The secret is never passed on argv: it is read from `.dev.vars` by wrangler,
# so it cannot appear in the process list.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PREVIEW_DEV_PORT:-3001}"
ASSETS=".preview-dev"

# Publish the built preview Worker into the dedicated directory.
rm -f "${ASSETS}/_worker.js"
cp dist-preview/_worker.js "${ASSETS}/_worker.js"

exec npx wrangler pages dev "${ASSETS}" \
  --persist-to "$PWD/.wrangler/state" \
  --inspector-port 9230 \
  --ip 0.0.0.0 \
  --port "${PORT}"
