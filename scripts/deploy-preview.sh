#!/bin/bash
# Build and deploy the DEDICATED preview surface (Pages project
# `artifactry-preview`) to preview.artifactry.app.
#
# WHY IT CDS INTO deploy/preview/
# `wrangler pages deploy` has no `--config` flag and always reads
# `wrangler.jsonc` from the CURRENT WORKING DIRECTORY. Run from the repo root it
# would read the APPLICATION's config and deploy to `artifact-library` instead —
# overwriting the app, or (worse) binding the preview hostname to the app
# runtime. Running from deploy/preview/ makes it read that directory's config,
# which names project `artifactry-preview` and carries only the bindings the
# preview surface needs.
#
# The uploaded assets are a single `_worker.js` copied from dist-preview/. It
# routes /p/:token and /api/health and answers everything else with a plain-text
# 404 — there is no SPA shell in this bundle to leak.
#
# NO SECRETS HERE. PREVIEW_TOKEN_SECRET is stored in Cloudflare by
# `wrangler pages secret put`, never on disk and never on argv.
set -euo pipefail
cd /home/user/webapp

echo "── building preview worker ──"
npm run build:preview

echo "── staging assets ──"
rm -rf deploy/preview/assets
mkdir -p deploy/preview/assets
cp dist-preview/_worker.js deploy/preview/assets/_worker.js
cp dist-preview/_routes.json deploy/preview/assets/_routes.json

# Guard: assert the bundle really is the minimal preview surface and not the app.
# The app bundle is ~226 kB; the preview bundle is ~34 kB. A wrong entry point is
# the one mistake here that would publish the whole application under the
# untrusted hostname, so it is checked rather than assumed.
size=$(wc -c < deploy/preview/assets/_worker.js)
if [ "$size" -gt 80000 ]; then
  echo "ABORT: preview bundle is ${size} bytes — that looks like the APPLICATION bundle." >&2
  exit 1
fi
if grep -q 'id="app"' deploy/preview/assets/_worker.js; then
  echo "ABORT: preview bundle contains the application SPA shell." >&2
  exit 1
fi
echo "  bundle ok (${size} bytes, no app shell)"

echo "── deploying ──"
cd deploy/preview
exec npx wrangler pages deploy assets \
  --project-name artifactry-preview \
  --branch main \
  --commit-dirty=true
