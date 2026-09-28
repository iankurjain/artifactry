/**
 * Reset the local development rate-limit counters.
 *
 * The auth and artifact endpoints are deliberately rate limited (e.g. 5 OTP
 * requests per email per 5 minutes). That is correct production behaviour, but
 * it makes the browser security suite non-repeatable: running it a few times in
 * a row exhausts the bucket and the NEXT run fails at login with 429 — a test
 * artifact, not a defect.
 *
 * This clears only the `rl:` counters in the LOCAL D1 database. It never runs
 * against production and never touches any other table, so the limiter itself
 * is left exactly as it is.
 */

import { execFileSync } from 'node:child_process'

export function resetRateLimits({ silent = true } = {}) {
  const run = (command) =>
    execFileSync(
      'npx',
      [
        'wrangler',
        'd1',
        'execute',
        'artifact-library-production',
        '--local',
        '--yes',
        '--command',
        command
      ],
      { stdio: silent ? 'pipe' : 'inherit', cwd: process.cwd() }
    )

  run(`DELETE FROM app_kv WHERE key LIKE 'rl:%'`)
}
