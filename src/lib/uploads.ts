/**
 * Staged uploads — getting a file that is too big for one tool call into
 * Artifactry.
 *
 * A chat model writes tool arguments as output tokens, so a long HTML page or
 * a base64 binary often cannot fit in a single `save` call (Claude says so and
 * refuses). A staged upload lets it send the file in pieces:
 *
 *   upload_part(content: piece 1)               → upload_id
 *   upload_part(upload_id, content: piece 2)    → …
 *   save(upload_id, file, title, tags)          → the artifact
 *
 * The upload id also works as a one-time capability URL (`PUT /api/v1/uploads/
 * :id`), so a client that can run code (Claude desktop, a code sandbox with
 * network access) can send the whole file in one request instead.
 *
 * Pieces live in R2 under `staging/<hash of the id>/`, never under the id
 * itself, and are deleted once saved. Nothing touches D1, so no migration.
 */

import type { Env, Principal } from '../types'
import { sha256Hex } from './crypto'
import { randomToken } from './ids'

export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000
export const MAX_PART_CHARS = 4 * 1024 * 1024
export const MAX_PARTS = 1000

type Encoding = 'text' | 'base64'

interface UploadMeta {
  user_id: string
  created_at: string
  encoding: Encoding | null
}

export class UploadError extends Error {}

const ID_PATTERN = /^upl_[A-Za-z0-9_-]{32}$/

function uploadLimit(env: Env): number {
  return Number(env.MAX_UPLOAD_BYTES || 26214400)
}

async function prefixFor(uploadId: string): Promise<string> {
  if (!ID_PATTERN.test(uploadId)) throw new UploadError('Unknown upload_id. Start a new upload by omitting upload_id.')
  return `staging/${(await sha256Hex(`upload:v1:${uploadId}`)).slice(0, 40)}/`
}

const partKey = (prefix: string, n: number) => `${prefix}part-${String(n).padStart(5, '0')}`

async function readMeta(env: Env, prefix: string): Promise<UploadMeta | null> {
  const obj = await env.R2.get(`${prefix}meta.json`)
  if (!obj) return null
  const meta = (await obj.json()) as UploadMeta
  if (Date.now() - Date.parse(meta.created_at) > UPLOAD_TTL_MS) return null
  return meta
}

async function writeMeta(env: Env, prefix: string, meta: UploadMeta): Promise<void> {
  await env.R2.put(`${prefix}meta.json`, JSON.stringify(meta), {
    httpMetadata: { contentType: 'application/json' }
  })
}

/** Open an upload owned by the principal, or load the one named. */
async function openUpload(
  env: Env,
  principal: Principal,
  uploadId: string | null
): Promise<{ uploadId: string; prefix: string; meta: UploadMeta }> {
  if (!uploadId) {
    const id = `upl_${randomToken(24)}`
    const prefix = await prefixFor(id)
    const meta: UploadMeta = { user_id: principal.userId!, created_at: new Date().toISOString(), encoding: null }
    await writeMeta(env, prefix, meta)
    return { uploadId: id, prefix, meta }
  }
  const prefix = await prefixFor(uploadId)
  const meta = await readMeta(env, prefix)
  // Someone else's upload reads exactly like an expired one.
  if (!meta || meta.user_id !== principal.userId) {
    throw new UploadError('That upload_id has expired or does not exist. Start again by omitting upload_id.')
  }
  return { uploadId, prefix, meta }
}

async function listAll(env: Env, prefix: string): Promise<R2Object[]> {
  const objects: R2Object[] = []
  let cursor: string | undefined
  do {
    const page = await env.R2.list({ prefix, cursor })
    objects.push(...page.objects)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return objects
}

export interface PartReceipt {
  upload_id: string
  part: number
  parts_received: number
  bytes_received: number
  put_url: string
  expires_at: string
}

/**
 * Store one piece. Parts are numbered from 1; omitting `part` appends. Sending
 * a part number again replaces that piece, so a retried call is harmless.
 */
export async function appendPart(
  env: Env,
  principal: Principal,
  args: { upload_id?: unknown; part?: unknown; content?: unknown; content_base64?: unknown },
  origin: string
): Promise<PartReceipt> {
  const hasText = typeof args.content === 'string' && args.content.length > 0
  const hasB64 = typeof args.content_base64 === 'string' && args.content_base64.length > 0
  if (hasText === hasB64) throw new UploadError('Send exactly one of content (text) or content_base64 per part.')
  const encoding: Encoding = hasText ? 'text' : 'base64'
  const piece = (hasText ? args.content : (args.content_base64 as string).replace(/\s+/g, '')) as string
  if (piece.length > MAX_PART_CHARS) throw new UploadError('That part is too large; send smaller pieces.')
  if (encoding === 'base64' && !/^[A-Za-z0-9+/]*={0,2}$/.test(piece)) {
    throw new UploadError('content_base64 is not valid base64.')
  }

  const requested = typeof args.upload_id === 'string' && args.upload_id.trim() ? args.upload_id.trim() : null
  const { uploadId, prefix, meta } = await openUpload(env, principal, requested)
  if (meta.encoding && meta.encoding !== encoding) {
    throw new UploadError(`This upload was started with ${meta.encoding === 'text' ? 'content' : 'content_base64'}; keep using it for every part.`)
  }
  if (!meta.encoding) await writeMeta(env, prefix, { ...meta, encoding })

  const existing = (await listAll(env, prefix)).filter((o) => o.key.includes('/part-'))
  const partArg = Number(args.part)
  const part = Number.isInteger(partArg) && partArg > 0 ? partArg : existing.length + 1
  if (part > MAX_PARTS) throw new UploadError(`An upload can have at most ${MAX_PARTS} parts.`)

  const bytes = new TextEncoder().encode(piece)
  const others = existing.filter((o) => o.key !== partKey(prefix, part)).reduce((n, o) => n + o.size, 0)
  // Base64 shrinks by a quarter once decoded, so compare decoded sizes.
  const decoded = (n: number) => (encoding === 'base64' ? Math.floor((n * 3) / 4) : n)
  if (decoded(others + bytes.byteLength) > uploadLimit(env)) {
    throw new UploadError(`The file would exceed the ${uploadLimit(env)}-byte limit.`)
  }
  await env.R2.put(partKey(prefix, part), bytes)

  const replaced = existing.some((o) => o.key === partKey(prefix, part))
  return {
    upload_id: uploadId,
    part,
    parts_received: existing.length + (replaced ? 0 : 1),
    bytes_received: decoded(others + bytes.byteLength),
    put_url: `${origin}/api/v1/uploads/${uploadId}`,
    expires_at: new Date(Date.parse(meta.created_at) + UPLOAD_TTL_MS).toISOString()
  }
}

/** Open an empty upload for a client that will PUT the whole file. */
export async function startUpload(env: Env, principal: Principal, origin: string) {
  const { uploadId, meta } = await openUpload(env, principal, null)
  return {
    upload_id: uploadId,
    put_url: `${origin}/api/v1/uploads/${uploadId}`,
    expires_at: new Date(Date.parse(meta.created_at) + UPLOAD_TTL_MS).toISOString()
  }
}

/**
 * Receive a whole file through the capability URL. The id is the credential:
 * it is 192 random bits, known only to the chat that asked for it, and it
 * only ever writes into that user's own staging area.
 */
export async function putBody(env: Env, uploadId: string, body: ReadableStream | null): Promise<number> {
  const prefix = await prefixFor(uploadId)
  const meta = await readMeta(env, prefix)
  if (!meta) throw new UploadError('That upload link has expired or does not exist.')
  if (!body) throw new UploadError('The request has no body.')

  const limit = uploadLimit(env)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => {})
      throw new UploadError(`The file is larger than the ${limit}-byte limit.`)
    }
    chunks.push(value)
  }
  if (!total) throw new UploadError('The request body is empty.')

  // A PUT replaces any parts sent so far.
  await discardParts(env, prefix)
  await env.R2.put(`${prefix}body`, concat(chunks, total))
  return total
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

/** Put the pieces back together. Throws when there is nothing to save. */
export async function assembleUpload(
  env: Env,
  principal: Principal,
  uploadId: string
): Promise<{ bytes: Uint8Array; text: string | null }> {
  const { prefix, meta } = await openUpload(env, principal, uploadId)

  const body = await env.R2.get(`${prefix}body`)
  if (body) return { bytes: new Uint8Array(await body.arrayBuffer()), text: null }

  const parts = (await listAll(env, prefix))
    .filter((o) => o.key.includes('/part-'))
    .sort((a, b) => a.key.localeCompare(b.key))
  if (!parts.length) throw new UploadError('That upload has no parts yet. Send them with upload_part first.')

  // Parts must run 1..n with no gap, or the file would be silently corrupt.
  const numbers = parts.map((o) => Number(o.key.slice(-5)))
  const missing = numbers.findIndex((n, i) => n !== i + 1)
  if (missing !== -1) throw new UploadError(`Part ${missing + 1} is missing; send it, then save again.`)

  const pieces: Uint8Array[] = []
  let total = 0
  for (const o of parts) {
    const obj = await env.R2.get(o.key)
    if (!obj) throw new UploadError('A part could not be read back; resend it.')
    const b = new Uint8Array(await obj.arrayBuffer())
    pieces.push(b)
    total += b.byteLength
  }
  const joined = concat(pieces, total)

  if (meta.encoding === 'base64') {
    let binary: string
    try {
      binary = atob(new TextDecoder().decode(joined))
    } catch {
      throw new UploadError('The joined content_base64 parts are not valid base64. Split only at multiples of 4 characters.')
    }
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return { bytes, text: null }
  }
  return { bytes: joined, text: new TextDecoder().decode(joined) }
}

async function discardParts(env: Env, prefix: string): Promise<void> {
  const keys = (await listAll(env, prefix)).map((o) => o.key).filter((k) => !k.endsWith('meta.json'))
  if (keys.length) await env.R2.delete(keys)
}

/** Delete everything staged for an upload once it has been saved. */
export async function discardUpload(env: Env, uploadId: string): Promise<void> {
  const prefix = await prefixFor(uploadId)
  const keys = (await listAll(env, prefix)).map((o) => o.key)
  if (keys.length) await env.R2.delete(keys)
}
