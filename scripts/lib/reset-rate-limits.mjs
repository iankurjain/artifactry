/**
 * Reset local authentication state so the browser suites are repeatable.
 *
 * There are TWO independent throttles in front of sign-in, and clearing only
 * one of them leaves the suites flaky:
 *
 *   1. The IP rate-limit bucket `rl:<bucket>:<ip>:<window>` in `app_kv`
 *      (e.g. 5 OTP requests per 5 minutes). Cleared by deleting `rl:%` keys.
 *
 *   2. A PER-EMAIL resend cooldown enforced inside `issueOtp()`: it reads the
 *      newest `auth_otp.created_at` for that address and refuses a new code for
 *      `OTP_RESEND_COOLDOWN_SECONDS` ("Please wait 30s before requesting another
 *      code."). This is NOT a rate-limit counter and is NOT in `app_kv`, so
 *      deleting `rl:%` keys does nothing for it.
 *
 * Missing (2) is what made the gate flaky: two suites signing in as the same
 * probe address in one run consumed each other's cooldown, so whichever ran
 * second got HTTP 400 with no `devCode`, failed to log in, and then failed at
 * whichever DOM step it happened to reach first — a failure that moved between
 * runs and looked like a product regression.
 *
 * LOCAL ONLY. This deletes rows from the local development database that
 * `wrangler pages dev --local` reads from `.wrangler/state`. It never runs
 * against production, never touches any table other than the two named above,
 * and leaves the limiter and cooldown implementations exactly as they are.
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

  // (1) IP rate-limit counters.
  run(`DELETE FROM app_kv WHERE key LIKE 'rl:%'`)

  // (2) Per-email OTP resend cooldown. Dropping the rows is safe here: every
  // suite immediately requests a fresh code and verifies it, so nothing depends
  // on a pre-existing OTP surviving the reset.
  run(`DELETE FROM auth_otp`)
}
