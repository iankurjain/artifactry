/**
 * Identifier + secret generation.
 *
 * - ULIDs for canonical artifact identity (PRD §12: immutable, sortable,
 *   never discloses storage location).
 * - Cryptographically random opaque tokens for share links and grants
 *   (PRD §36: never sequential IDs).
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** 48-bit timestamp + 80-bit randomness, Crockford base32 → 26 chars. */
export function ulid(now: number = Date.now()): string {
  let timeStr = ''
  let t = now
  for (let i = 0; i < 10; i++) {
    timeStr = CROCKFORD[t % 32] + timeStr
    t = Math.floor(t / 32)
  }

  const bytes = new Uint8Array(10)
  crypto.getRandomValues(bytes)

  // 80 bits of entropy → exactly 16 base32 chars.
  // Read the byte stream MSB-first so the 5-bit groups align as in spec.
  let randStr = ''
  let bitPos = 0
  for (let i = 0; i < 16; i++) {
    let value = 0
    for (let b = 0; b < 5; b++) {
      const p = bitPos + b
      const byteIndex = p >> 3
      const bitInByte = 7 - (p & 7)
      const bit = byteIndex < bytes.length ? (bytes[byteIndex] >> bitInByte) & 1 : 0
      value = (value << 1) | bit
    }
    bitPos += 5
    randStr += CROCKFORD[value]
  }

  return timeStr + randStr
}

/** URL-safe random token, `bytes` of entropy (default 32 → 43 chars). */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  let binary = ''
  for (const b of buf) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Numeric one-time code for email OTP (PRD §5, §37). */
export function otpCode(digits = 6): string {
  const max = 10 ** digits
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return String(buf[0] % max).padStart(digits, '0')
}

export const prefixed = (prefix: string, value: string) => `${prefix}_${value}`

/** Short, human-readable slug used for optional canonical URLs (PRD §12). */
export function slugify(input: string, maxLength = 60): string {
  const base = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '')
  return base || 'artifact'
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** i
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}
