/**
 * Input validation: emails, filenames, MIME allow-list and magic-byte sniffing.
 *
 * PRD §9 requires limits enforced server-side; §69 requires MIME/magic-byte
 * validation before an artifact becomes READY. The browser is never trusted.
 */

/** Supported V1 artifact formats (PRD §8). */
export const EXTENSION_MIME: Record<string, string> = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  html: 'text/html',
  htm: 'text/html',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  bmp: 'image/bmp',
  gif: 'image/gif',
  webp: 'image/webp'
}

export type ArtifactKind = 'PRESENTATION' | 'DOCUMENT' | 'WEB' | 'IMAGE'

export function kindForExtension(ext: string): ArtifactKind {
  switch (ext) {
    case 'pptx':
      return 'PRESENTATION'
    case 'pdf':
    case 'docx':
      return 'DOCUMENT'
    case 'html':
    case 'htm':
      return 'WEB'
    default:
      return 'IMAGE'
  }
}

/**
 * Per-type ceilings from PRD §9, before the platform cap is applied.
 * Personal/org plans may override the org-level value.
 */
export const TYPE_LIMITS: Record<ArtifactKind, number> = {
  WEB: 25 * 1024 * 1024,
  IMAGE: 50 * 1024 * 1024,
  DOCUMENT: 100 * 1024 * 1024,
  PRESENTATION: 250 * 1024 * 1024
}

/** Effective limit = min(type ceiling, org ceiling, platform ceiling). */
export function effectiveLimit(
  ext: string,
  orgLimit: number | null,
  platformLimit: number
): number {
  const kind = kindForExtension(ext)
  return Math.min(TYPE_LIMITS[kind], orgLimit ?? platformLimit, platformLimit)
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function isValidEmail(email: string): boolean {
  if (email.length < 3 || email.length > 254) return false
  // Deliberately conservative: local@domain.tld, no spaces, no consecutive dots
  return /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email)
}

export function emailDomain(emailNormalized: string): string {
  const at = emailNormalized.lastIndexOf('@')
  return at === -1 ? '' : emailNormalized.slice(at + 1)
}

/** Strip path separators and control characters from an uploaded filename. */
export function sanitizeFilename(name: string, fallback = 'artifact'): string {
  const base = name.split(/[\\/]/).pop() ?? fallback
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim()
  return (cleaned || fallback).slice(0, 255)
}

export function extensionOf(filename: string): string {
  const idx = filename.lastIndexOf('.')
  if (idx === -1 || idx === filename.length - 1) return ''
  return filename.slice(idx + 1).toLowerCase()
}

export function isSupportedExtension(ext: string): boolean {
  return Object.prototype.hasOwnProperty.call(EXTENSION_MIME, ext)
}

const ZIP_SIGNATURES = [
  [0x50, 0x4b, 0x03, 0x04], // local file header
  [0x50, 0x4b, 0x05, 0x06], // empty archive
  [0x50, 0x4b, 0x07, 0x08] // spanning
]

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.length < sig.length) return false
  return sig.every((b, i) => bytes[i] === b)
}

/**
 * Verify the declared extension against the actual leading bytes.
 *
 * PPTX and DOCX are both OOXML ZIP containers, so magic bytes alone cannot
 * separate them — for those we assert the ZIP signature and trust the
 * extension, which is the best available check in a Workers runtime.
 * HTML has no signature and is validated as text instead.
 */
export function magicBytesMatch(
  ext: string,
  bytes: Uint8Array
): { ok: boolean; reason?: string } {
  switch (ext) {
    case 'pdf':
      return startsWith(bytes, [0x25, 0x50, 0x44, 0x46])
        ? { ok: true }
        : { ok: false, reason: 'File does not begin with a PDF signature' }
    case 'png':
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        ? { ok: true }
        : { ok: false, reason: 'File does not begin with a PNG signature' }
    case 'jpg':
    case 'jpeg':
      return startsWith(bytes, [0xff, 0xd8, 0xff])
        ? { ok: true }
        : { ok: false, reason: 'File does not begin with a JPEG signature' }
    case 'gif':
      return startsWith(bytes, [0x47, 0x49, 0x46, 0x38])
        ? { ok: true }
        : { ok: false, reason: 'File does not begin with a GIF signature' }
    case 'bmp':
      return startsWith(bytes, [0x42, 0x4d])
        ? { ok: true }
        : { ok: false, reason: 'File does not begin with a BMP signature' }
    case 'webp':
      // RIFF container whose form type (bytes 8–11) is WEBP.
      return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        bytes.length >= 12 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
        ? { ok: true }
        : { ok: false, reason: 'File does not begin with a WebP signature' }
    case 'pptx':
    case 'docx':
      return ZIP_SIGNATURES.some((sig) => startsWith(bytes, sig))
        ? { ok: true }
        : { ok: false, reason: 'Office file is not a valid ZIP container' }
    case 'html':
    case 'htm': {
      // Sniff for HTML-ish content; reject anything claiming HTML that is
      // obviously binary (e.g. a renamed executable).
      const head = new TextDecoder('utf-8', { fatal: false })
        .decode(bytes.slice(0, 512))
        .replace(/^\uFEFF/, '')
        .trimStart()
        .toLowerCase()
      const looksHtml =
        head.startsWith('<!doctype') ||
        head.startsWith('<html') ||
        head.includes('<html') ||
        head.includes('<head') ||
        head.includes('<body') ||
        head.includes('<div') ||
        head.includes('<script') ||
        head.includes('<meta')
      return looksHtml
        ? { ok: true }
        : { ok: false, reason: 'File does not look like HTML content' }
    }
    default:
      return { ok: false, reason: `Unsupported file extension: .${ext}` }
  }
}

/**
 * Lightweight static heuristics replacing a commercial malware scanner.
 * The PRD (§69) asks for an abstraction so a real provider can be plugged
 * in without touching artifact APIs — see `scanFile` in lib/validate-ext.
 */
export function looksSuspicious(ext: string, bytes: Uint8Array): string | null {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 4096))

  // Executable/script payload hidden behind an allowed extension
  const executableSignatures = [
    'MZ', // Windows PE
    '\x7fELF', // Linux ELF
    '#!/bin/', // shell script
    '#!/usr/bin/env'
  ]
  if (ext !== 'html' && ext !== 'htm') {
    for (const sig of executableSignatures) {
      if (head.startsWith(sig)) return `Embedded executable content detected (${sig.trim()})`
    }
  }

  // HTML artifacts are untrusted by definition (§68) but obviously hostile
  // constructs are quarantined rather than silently rendered.
  if (ext === 'html' || ext === 'htm') {
    const hostile = [
      /<script[^>]+src\s*=\s*["']\s*\/\/(?!localhost)/i,
      /document\.cookie\s*=/i,
      /localStorage\s*\.\s*setItem\s*\(\s*['"](?:token|session)/i
    ]
    for (const pattern of hostile) {
      if (pattern.test(head)) return 'Potentially unsafe HTML construct detected'
    }
  }

  return null
}
