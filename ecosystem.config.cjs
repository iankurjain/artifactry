/**
 * PM2 process definition for the local sandbox preview.
 *
 * `wrangler pages dev dist` serves the built Worker plus static assets, and
 * --local makes D1/R2 resolve against .wrangler/state, so no Cloudflare
 * credentials are needed. Variables come from .dev.vars, which sets a local
 * PREVIEW_ORIGIN (a different hostname, not just a different port — cookies
 * ignore ports, so a port-only difference would not isolate anything).
 */
module.exports = {
  apps: [
    {
      name: 'webapp',
      script: 'npx',
      args: 'wrangler pages dev dist --d1=artifact-library-production --local --ip 0.0.0.0 --port 3000',
      interpreter: 'none',
      cwd: __dirname,
      env: { NODE_ENV: 'development', PORT: 3000 },
      watch: false,
      instances: 1,
      exec_mode: 'fork'
    }
  ]
}
