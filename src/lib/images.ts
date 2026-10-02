/**
 * Uploaded pictures: profile pictures and workspace logos.
 *
 * Rules, enforced here on the server whatever the client did:
 *   - PNG, JPEG or WebP, identified by their bytes (never by a header or name)
 *   - exactly square, exactly 320x320 pixels
 *   - at most 1 MB
 *
 * The app crops and resizes in the browser before upload, so a person can pick
 * any photo; this module is the check that the result actually meets the rules.
 * Dimensions are read from the image header without decoding the image.
 */

import { badRequest } from './http'

export const PICTURE_SIZE = 320
export const PICTURE_MAX_BYTES = 1024 * 1024

export type PictureType = 'image/png' | 'image/jpeg' | 'image/webp'

export interface PictureInfo {
  type: PictureType
  width: number
  height: number
}

function u16be(b: Uint8Array, i: number) {
  return (b[i]! << 8) | b[i + 1]!
}
function u32be(b: Uint8Array, i: number) {
  return ((b[i]! << 24) >>> 0) + ((b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!)
}
function u16le(b: Uint8Array, i: number) {
  return b[i]! | (b[i + 1]! << 8)
}
function u24le(b: Uint8Array, i: number) {
  return b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)
}
function ascii(b: Uint8Array, i: number, n: number) {
  return String.fromCharCode(...b.subarray(i, i + n))
}

/** Type and pixel size from the header, or null when it is not a supported image. */
export function pictureInfo(bytes: Uint8Array): PictureInfo | null {
  // PNG: signature, then IHDR with width/height as big-endian u32.
  if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG' && ascii(bytes, 12, 4) === 'IHDR') {
    return { type: 'image/png', width: u32be(bytes, 16), height: u32be(bytes, 20) }
  }

  // JPEG: walk the segments to the first start-of-frame marker.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null
      const marker = bytes[i + 1]!
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2
        continue
      }
      const length = u16be(bytes, i + 2)
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSof) {
        return { type: 'image/jpeg', height: u16be(bytes, i + 5), width: u16be(bytes, i + 7) }
      }
      i += 2 + length
    }
    return null
  }

  // WebP: RIFF container with a VP8, VP8L or VP8X first chunk.
  if (bytes.length >= 30 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const chunk = ascii(bytes, 12, 4)
    if (chunk === 'VP8 ') {
      return { type: 'image/webp', width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff }
    }
    if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      const b = bytes
      const width = 1 + (((b[22]! & 0x3f) << 8) | b[21]!)
      const height = 1 + (((b[24]! & 0x0f) << 10) | (b[23]! << 2) | ((b[22]! & 0xc0) >> 6))
      return { type: 'image/webp', width, height }
    }
    if (chunk === 'VP8X') {
      return { type: 'image/webp', width: 1 + u24le(bytes, 24), height: 1 + u24le(bytes, 27) }
    }
  }

  return null
}

/** Check an uploaded picture against the rules above, or throw a 400 saying which one failed. */
export function assertPicture(bytes: Uint8Array): PictureInfo {
  if (bytes.byteLength === 0) throw badRequest('Choose an image to upload')
  if (bytes.byteLength > PICTURE_MAX_BYTES) throw badRequest('The picture must be 1 MB or smaller')
  const info = pictureInfo(bytes)
  if (!info) throw badRequest('The picture must be a PNG, JPEG or WebP image')
  if (info.width !== info.height) throw badRequest('The picture must be square (1:1)')
  if (info.width !== PICTURE_SIZE) {
    throw badRequest(`The picture must be ${PICTURE_SIZE}x${PICTURE_SIZE} pixels`)
  }
  return info
}

/** Read a request body as bytes, refusing anything over the limit before buffering it all. */
export async function readPictureBody(req: Request): Promise<Uint8Array> {
  const declared = Number(req.headers.get('Content-Length') ?? '0')
  if (declared > PICTURE_MAX_BYTES) throw badRequest('The picture must be 1 MB or smaller')
  const buffer = await req.arrayBuffer()
  return new Uint8Array(buffer)
}

export const PICTURE_EXTENSION: Record<PictureType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp'
}
