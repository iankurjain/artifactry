/**
 * Uploaded pictures: profile pictures and workspace logos.
 *
 * The one hard rule is size: at most 1 MB. Anything else (aspect ratio,
 * dimensions) is the app's job at display time, where the picture is cropped
 * to fill a circle (object-fit: cover), so a 4:3 photo still looks right.
 *
 * The type is identified from the bytes, never from a header or file name, and
 * limited to raster formats a browser renders safely in an <img>. SVG is
 * refused on purpose: it is a document that can carry script.
 */

import { badRequest } from './http'

export const PICTURE_MAX_BYTES = 1024 * 1024

export type PictureType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

function ascii(b: Uint8Array, i: number, n: number) {
  return String.fromCharCode(...b.subarray(i, i + n))
}

/** The picture's type from its leading bytes, or null when it is not a supported image. */
export function pictureType(bytes: Uint8Array): PictureType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG') return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp'
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) return 'image/gif'
  return null
}

/** Check an uploaded picture, or throw a 400 saying what is wrong. */
export function assertPicture(bytes: Uint8Array): PictureType {
  if (bytes.byteLength === 0) throw badRequest('Choose an image to upload')
  if (bytes.byteLength > PICTURE_MAX_BYTES) throw badRequest('The picture must be 1 MB or smaller')
  const type = pictureType(bytes)
  if (!type) throw badRequest('The picture must be a PNG, JPEG, WebP or GIF image')
  return type
}

/** Read a request body as bytes, refusing a declared size over the limit before buffering. */
export async function readPictureBody(req: Request): Promise<Uint8Array> {
  const declared = Number(req.headers.get('Content-Length') ?? '0')
  if (declared > PICTURE_MAX_BYTES) throw badRequest('The picture must be 1 MB or smaller')
  return new Uint8Array(await req.arrayBuffer())
}

/** Headers for serving a stored picture. */
export function pictureHeaders(type: string, cacheControl: string): Record<string, string> {
  return {
    'Content-Type': type,
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Content-Disposition': 'inline'
  }
}
