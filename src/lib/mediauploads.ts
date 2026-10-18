/**
 * Parted uploads for audio and video.
 *
 * A video can be up to 200 MB, which is more than one request to a Worker may
 * carry and more than a Worker may hold in memory. So the browser sends it in
 * fixed-size parts straight into an R2 multipart upload at the artifact's final
 * object key, and the artifact rows are written only once every part is in:
 *
 *   POST /api/v1/artifacts/media-uploads              → upload_id, part size, part count
 *   PUT  /api/v1/artifacts/media-uploads/:id/parts/:n → one part (exact size)
 *   POST /api/v1/artifacts/media-uploads/:id/complete → the artifact
 *   DELETE /api/v1/artifacts/media-uploads/:id        → give up
 *
 * The upload's state lives in R2 under `staging/media/<hash of the id>/`, like
 * the MCP staged uploads in uploads.ts, so this needs no migration. Every part
 * must be exactly the size its position calls for, so the finished file is
 * exactly the size declared at the start and the 20 MB / 200 MB limits hold
 * without trusting the browser.
 */

import type { Env, Principal } from '../types'
import { sha256Hex } from './crypto'
import { prefixed, randomToken, ulid } from './ids'
import { buildObjectKey } from './storage'
import { EXTENSION_MIME, TYPE_LIMITS, extensionOf, isMediaExtension, kindForExtension, sanitizeFilename } from './validate'

export const MEDIA_PART_BYTES = 8 * 1024 * 1024
export const MEDIA_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000
/** Bytes read back for the signature and scan checks. */
const HEAD_BYTES = 4096

export class MediaUploadError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 413 | 415 = 400) {
    super(message)
  }
}

export interface MediaUploadFields {
  title?: string
  description?: string
  tags?: string[]
  collectionIds?: string[]
  acceptSuggestedTags?: boolean
}

interface MediaUploadMeta {
  user_id: string
  workspace_id: string
  organization_id: string | null
  filename: string
  size: number
  part_size: number
  part_count: number
  artifact_id: string
  version_id: string
  object_key: string
  r2_upload_id: string
  created_at: string
  fields: MediaUploadFields
}

const ID_PATTERN = /^mup_[A-Za-z0-9_-]{32}$/

async function prefixFor(uploadId: string): Promise<string> {
  if (!ID_PATTERN.test(uploadId)) throw new MediaUploadError('That upload does not exist. Start the upload again.', 404)
  return `staging/media/${(await sha256Hex(`media-upload:v1:${uploadId}`)).slice(0, 40)}/`
}

async function loadMeta(env: Env, principal: Principal, uploadId: string): Promise<{ prefix: string; meta: MediaUploadMeta }> {
  const prefix = await prefixFor(uploadId)
  const obj = await env.R2.get(`${prefix}meta.json`)
  const meta = obj ? ((await obj.json()) as MediaUploadMeta) : null
  // Someone else's upload reads exactly like an expired one.
  if (!meta || meta.user_id !== principal.userId || Date.now() - Date.parse(meta.created_at) > MEDIA_UPLOAD_TTL_MS) {
    throw new MediaUploadError('That upload has expired or does not exist. Start the upload again.', 404)
  }
  return { prefix, meta }
}

function expectedPartSize(meta: MediaUploadMeta, part: number): number {
  return part < meta.part_count ? meta.part_size : meta.size - meta.part_size * (meta.part_count - 1)
}

/** The ceiling for a media file, or null when the name is not audio or video. */
export function mediaLimit(filename: string): number | null {
  const ext = extensionOf(filename)
  if (!isMediaExtension(ext)) return null
  return TYPE_LIMITS[kindForExtension(ext)]
}

export async function startMediaUpload(
  env: Env,
  principal: Principal,
  workspace: { id: string; organization_id: string | null },
  input: { filename: unknown; size: unknown } & MediaUploadFields
) {
  const filename = sanitizeFilename(String(input.filename ?? ''))
  const ext = extensionOf(filename)
  const limit = mediaLimit(filename)
  if (limit === null) {
    throw new MediaUploadError(`.${ext || 'unknown'} is not an audio or video format this upload accepts.`, 415)
  }
  const size = Number(input.size)
  if (!Number.isInteger(size) || size <= 0) throw new MediaUploadError('Give the file size in bytes; the file cannot be empty.')
  if (size > limit) {
    const kind = kindForExtension(ext) === 'AUDIO' ? 'Audio' : 'Video'
    throw new MediaUploadError(`${kind} files can be up to ${Math.floor(limit / (1024 * 1024))} MB.`, 413)
  }

  const artifactId = prefixed('art', ulid())
  const versionId = prefixed('ver', ulid())
  const objectKey = buildObjectKey({
    organizationId: workspace.organization_id,
    ownerUserId: principal.userId!,
    workspaceId: workspace.id,
    artifactId,
    versionId
  })
  const multipart = await env.R2.createMultipartUpload(objectKey, {
    httpMetadata: { contentType: EXTENSION_MIME[ext], cacheControl: 'private, no-store' }
  })

  const uploadId = `mup_${randomToken(24)}`
  const meta: MediaUploadMeta = {
    user_id: principal.userId!,
    workspace_id: workspace.id,
    organization_id: workspace.organization_id,
    filename,
    size,
    part_size: MEDIA_PART_BYTES,
    part_count: Math.max(1, Math.ceil(size / MEDIA_PART_BYTES)),
    artifact_id: artifactId,
    version_id: versionId,
    object_key: objectKey,
    r2_upload_id: multipart.uploadId,
    created_at: new Date().toISOString(),
    fields: {
      title: typeof input.title === 'string' ? input.title : undefined,
      description: typeof input.description === 'string' ? input.description : undefined,
      tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
      collectionIds: Array.isArray(input.collectionIds) ? input.collectionIds.map(String) : [],
      acceptSuggestedTags: input.acceptSuggestedTags === true
    }
  }
  await env.R2.put(`${await prefixFor(uploadId)}meta.json`, JSON.stringify(meta), {
    httpMetadata: { contentType: 'application/json' }
  })

  return {
    uploadId,
    partSize: meta.part_size,
    partCount: meta.part_count,
    expiresAt: new Date(Date.parse(meta.created_at) + MEDIA_UPLOAD_TTL_MS).toISOString()
  }
}

/** Store one part. Sending a part again replaces it, so a retry is harmless. */
export async function uploadMediaPart(
  env: Env,
  principal: Principal,
  uploadId: string,
  partNumber: number,
  body: ArrayBuffer
): Promise<{ partNumber: number; etag: string }> {
  const { meta } = await loadMeta(env, principal, uploadId)
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > meta.part_count) {
    throw new MediaUploadError(`Parts are numbered 1 to ${meta.part_count}.`)
  }
  const expected = expectedPartSize(meta, partNumber)
  if (body.byteLength !== expected) {
    throw new MediaUploadError(`Part ${partNumber} must be exactly ${expected} bytes; it was ${body.byteLength}.`)
  }
  const multipart = env.R2.resumeMultipartUpload(meta.object_key, meta.r2_upload_id)
  const uploaded = await multipart.uploadPart(partNumber, body)
  return { partNumber: uploaded.partNumber, etag: uploaded.etag }
}

/**
 * Join the parts. Returns what createArtifact needs to record a file that is
 * already stored: its ids and key, its size and checksum, and its first bytes
 * for the signature check. The upload's state is removed either way.
 */
export async function completeMediaUpload(
  env: Env,
  principal: Principal,
  uploadId: string,
  parts: unknown
) {
  const { prefix, meta } = await loadMeta(env, principal, uploadId)
  const list = (Array.isArray(parts) ? parts : [])
    .map((p) => ({ partNumber: Number((p as { partNumber?: unknown })?.partNumber), etag: String((p as { etag?: unknown })?.etag ?? '') }))
    .filter((p) => Number.isInteger(p.partNumber) && p.etag)
    .sort((a, b) => a.partNumber - b.partNumber)
  const missing = Array.from({ length: meta.part_count }, (_, i) => i + 1).filter((n) => !list.some((p) => p.partNumber === n))
  if (missing.length) throw new MediaUploadError(`Part ${missing[0]} has not been sent yet.`)

  const multipart = env.R2.resumeMultipartUpload(meta.object_key, meta.r2_upload_id)
  await multipart.complete(list)
  await env.R2.delete(`${prefix}meta.json`)

  const head = await env.R2.get(meta.object_key, { range: { offset: 0, length: Math.min(HEAD_BYTES, meta.size) } })
  const stored = await env.R2.head(meta.object_key)
  if (!head || !stored || stored.size !== meta.size) {
    await env.R2.delete(meta.object_key).catch(() => {})
    throw new MediaUploadError('The joined file is not the size that was declared. Start the upload again.')
  }

  return {
    meta,
    head: new Uint8Array(await head.arrayBuffer()),
    stored: {
      artifactId: meta.artifact_id,
      versionId: meta.version_id,
      objectKey: meta.object_key,
      size: meta.size,
      checksum: await checksumOfStored(env, meta.object_key, stored)
    }
  }
}

/**
 * SHA-256 of the stored file, streamed so a 200 MB video never sits in memory.
 * Falls back to R2's own etag where the runtime has no DigestStream.
 */
async function checksumOfStored(env: Env, key: string, stored: R2Object): Promise<string> {
  const Digest = (crypto as unknown as { DigestStream?: new (algorithm: string) => WritableStream & { digest: Promise<ArrayBuffer> } }).DigestStream
  if (!Digest) return `etag:${stored.etag}`
  const object = await env.R2.get(key)
  if (!object) return `etag:${stored.etag}`
  const digest = new Digest('SHA-256')
  await object.body.pipeTo(digest)
  return [...new Uint8Array(await digest.digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function abortMediaUpload(env: Env, principal: Principal, uploadId: string): Promise<void> {
  const { prefix, meta } = await loadMeta(env, principal, uploadId)
  await env.R2.resumeMultipartUpload(meta.object_key, meta.r2_upload_id).abort().catch(() => {})
  await env.R2.delete(`${prefix}meta.json`)
}
