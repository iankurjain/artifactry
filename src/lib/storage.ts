/**
 * R2 object key model — PRD §65.
 *
 * The key is derived exclusively from server-side identifiers so a caller can
 * never influence it, and keys are never exposed in any URL (PRD §12).
 *
 *   org/{org_id}/workspace/{workspace_id}/artifact/{artifact_id}/version/{version_id}/original
 *   personal/{user_id}/workspace/{workspace_id}/artifact/{artifact_id}/version/{version_id}/original
 */

import type { Env } from '../types'
import { sha256Hex } from './crypto'

export interface KeyParts {
  organizationId: string | null
  ownerUserId: string
  workspaceId: string
  artifactId: string
  versionId: string
}

export function buildObjectKey(parts: KeyParts, suffix = 'original'): string {
  const root = parts.organizationId
    ? `org/${parts.organizationId}`
    : `personal/${parts.ownerUserId}`
  return `${root}/workspace/${parts.workspaceId}/artifact/${parts.artifactId}/version/${parts.versionId}/${suffix}`
}

export function checksumOf(bytes: Uint8Array): Promise<string> {
  return sha256Hex(bytes)
}

export interface PutResult {
  size: number
  checksum: string
}

export async function putObject(
  env: Env,
  key: string,
  body: ArrayBuffer | Uint8Array,
  mimeType: string
): Promise<PutResult> {
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body)
  const checksum = await checksumOf(bytes)

  await env.R2.put(key, bytes, {
    httpMetadata: {
      contentType: mimeType,
      // Private by default: never publicly cacheable (PRD §63)
      cacheControl: 'private, no-store'
    },
    customMetadata: {
      checksum
    }
  })

  return { size: bytes.byteLength, checksum }
}

export async function getObject(env: Env, key: string): Promise<R2ObjectBody | null> {
  const object = await env.R2.get(key)
  return (object as R2ObjectBody | null) ?? null
}

export async function deleteObject(env: Env, key: string): Promise<void> {
  await env.R2.delete(key)
}

export async function objectExists(env: Env, key: string): Promise<boolean> {
  const head = await env.R2.head(key)
  return head !== null
}

/**
 * Serve a private artifact. Binary delivery never exposes the object key or a
 * permanent public URL (PRD §66); HTML is additionally forced to download
 * under a locked-down content type so it cannot execute on the app origin.
 */
export function buildDeliveryHeaders(opts: {
  filename: string
  mimeType: string
  size: number
  inline: boolean
  download: boolean
}): Record<string, string> {
  const dispositionType = opts.inline && !opts.download ? 'inline' : 'attachment'
  const safeName = opts.filename.replace(/["\\]/g, '')

  const headers: Record<string, string> = {
    'Content-Type': opts.mimeType,
    'Content-Length': String(opts.size),
    'Content-Disposition': `${dispositionType}; filename="${safeName}"`,
    // Short-lived access semantics: nothing about a private artifact is cached
    'Cache-Control': 'private, no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin'
  }

  // Defensive: if an HTML artifact is ever returned inline, neutralise it.
  if (opts.mimeType === 'text/html' && dispositionType === 'inline') {
    headers['Content-Type'] = 'text/plain; charset=utf-8'
  }

  return headers
}

/**
 * A single `bytes=` range of an object of `size` bytes, or null when the
 * request asks for the whole file. Audio and video players fetch in ranges to
 * seek, and Safari will not play a video served without them. A range that
 * cannot be satisfied is reported as such so the caller can answer 416.
 */
export function parseRange(
  header: string | null | undefined,
  size: number
): { offset: number; length: number } | 'unsatisfiable' | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start: number
  let end: number
  if (m[1] === '') {
    // Suffix range: the last N bytes.
    const suffix = Number(m[2])
    if (!suffix) return 'unsatisfiable'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start >= size || end < start) return 'unsatisfiable'
  return { offset: start, length: end - start + 1 }
}

/**
 * Answer a delivery request, honouring a Range header. `headers` are the ones
 * buildDeliveryHeaders made for the whole file.
 */
export async function deliverObject(
  env: Env,
  key: string,
  size: number,
  headers: Record<string, string>,
  rangeHeader: string | null | undefined
): Promise<Response | null> {
  const range = parseRange(rangeHeader, size)
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' } })
  }
  if (!range) {
    const object = await getObject(env, key)
    if (!object) return null
    return new Response(object.body, { headers: { ...headers, 'Accept-Ranges': 'bytes' } })
  }
  const object = (await env.R2.get(key, { range })) as R2ObjectBody | null
  if (!object) return null
  return new Response(object.body, {
    status: 206,
    headers: {
      ...headers,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(range.length),
      'Content-Range': `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`
    }
  })
}

/**
 * True when a request is a player's follow-up range, not the first fetch: any
 * range not starting at 0, and Safari's two-byte probe before it plays.
 */
export function isContinuationRange(rangeHeader: string | null | undefined): boolean {
  if (!rangeHeader) return false
  const range = rangeHeader.trim()
  return !/^bytes=0-/.test(range) || range === 'bytes=0-1'
}

// NOTE: the CSP applied to an HTML preview now lives in lib/htmlpreview.ts
// (safePreviewCsp / interactivePreviewCsp / previewDocumentCsp).
//
// The previous helper here built a `nonce-…` policy. It was removed on purpose:
// the nonce was never injected into the uploaded document, and because a nonce
// causes browsers to ignore `'unsafe-inline'`, the policy's stated intent
// ("inline scripts allowed") disagreed with its behaviour. The replacement
// states `script-src 'none'` for Safe Preview, which is unambiguous, and moves
// script-executing HTML to its own origin rather than trying to express safety
// through an allow-list over untrusted inline script.
