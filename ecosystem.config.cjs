/**
 * PM2 process definition for the local sandbox preview.
 *
 * `wrangler pages dev dist` serves the built Worker plus the static assets, and
 * --local makes the D1 and R2 bindings resolve against the on-disk emulation in
 * .wrangler/state, so no Cloudflare credentials are needed while developing.
 */
module.exports = {
  apps: [
    {
      name: 'webapp',
      script: 'npx',
      args: 'wrangler pages dev dist --d1=artifact-library-production --local --ip 0.0.0.0 --port 3000',
      interpreter: 'none',
      cwd: '/home/user/webapp',
      env: {
        NODE_ENV: 'development',
        PORT: 3000
      },
      watch: false,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10
    }
  ]
}
