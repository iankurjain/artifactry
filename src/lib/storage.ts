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
 * CSP applied to the sandboxed HTML preview (PRD §68).
 *
 * The preview runs in an iframe with `sandbox="allow-scripts"` and *without*
 * `allow-same-origin`, so the frame has an opaque origin: it cannot read
 * parent cookies, call app-authenticated APIs, or touch app storage — the
 * practical equivalent of the separate preview origin the PRD asks for.
 */
export function previewCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' 'unsafe-inline'`,
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "media-src 'none'",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'"
  ].join('; ')
}
