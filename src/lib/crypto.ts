/**
 * Cryptographic helpers built on the Web Crypto API.
 *
 * Security posture (PRD §36, §63):
 *   - Share tokens and session tokens are random opaque secrets.
 *   - Only their SHA-256 hashes are persisted; the raw value is never stored.
 *   - Comparisons are constant-time.
 */

const encoder = new TextEncoder()

export function hex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === 'string' ? encoder.encode(input) : input
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource)
  return hex(new Uint8Array(digest))
}

/** Constant-time string comparison to avoid token timing oracles. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * OTP codes are short, so a bare SHA-256 would be brute-forceable offline.
 * Bind the code to its purpose + recipient so a leaked hash is useless
 * outside its exact context.
 */
export function hashOtp(emailNormalized: string, code: string, purpose: string): Promise<string> {
  return sha256Hex(`otp:v1:${purpose}:${emailNormalized}:${code}`)
}

/** Session cookie value stored in the DB as a hash (PRD §63). */
export function hashSessionToken(token: string): Promise<string> {
  return sha256Hex(`session:v1:${token}`)
}

/** Share/grant tokens get their own domain tag so hashes are not interchangeable. */
export function hashShareToken(token: string): Promise<string> {
  return sha256Hex(`share:v1:${token}`)
}

export function hashGrantToken(token: string): Promise<string> {
  return sha256Hex(`grant:v1:${token}`)
}

/**
 * Privacy-conscious viewer identity for analytics (PRD §45).
 * Rotates daily so it cannot be used to build a cross-time profile, and
 * never involves fingerprinting — it is derived from the session only.
 */
export function viewerKey(sessionId: string, metricDate: string): Promise<string> {
  return sha256Hex(`viewer:${metricDate}:${sessionId}`)
}

/** Short prefix kept in the clear so a share URL is identifiable in the UI. */
export function tokenPrefix(token: string, length = 8): string {
  return token.slice(0, length)
}
