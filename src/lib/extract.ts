/**
 * Text extraction (§22 "Extract text").
 *
 * PDF, DOCX and PPTX cannot be parsed with a Node library here — the Workers
 * runtime has no filesystem and the bundle limit rules out a full parser. But
 * all three are reachable with **web-platform primitives only**:
 *
 *   - DOCX / PPTX are OOXML: ordinary ZIP containers holding XML parts. The
 *     central directory is parsed by hand and each part is inflated with
 *     `DecompressionStream('deflate-raw')`, which the runtime provides.
 *   - PDF stores page content in FlateDecode streams. Those inflate with
 *     `DecompressionStream('deflate')`, after which the text-showing operators
 *     (Tj / TJ / ' / ") are read out of the BT…ET blocks.
 *   - HTML is decoded directly.
 *
 * Everything is bounded and failure-tolerant: a malformed part yields a note
 * and no text rather than breaking the upload. Extraction is best-effort by
 * design — an artifact is always searchable by title, filename, description
 * and tags regardless of what its binary contains.
 */

export interface ExtractionResult {
  /** Extracted plain text, or null when nothing usable was recovered. */
  text: string | null
  /** True when this format has an extractor at all. */
  supported: boolean
  /** True when text was actually recovered. */
  ok: boolean
  /** Human-readable outcome, surfaced in the EXTRACT job record. */
  note: string
  chars?: number
  /** Which container/parser produced the text, for diagnostics. */
  via?: string
}

/** Total text kept per artifact. Bounds D1 row size and FTS growth. */
export const MAX_EXTRACTED_CHARS = 200_000

/** Per-part ceiling while decompressing, to bound CPU and memory. */
const MAX_PART_BYTES = 8 * 1024 * 1024

const decoder = new TextDecoder('utf-8', { fatal: false })

// ---------------------------------------------------------------
// Inflate (raw + zlib wrapped)
// ---------------------------------------------------------------

/**
 * Decompress a byte range using the platform's DecompressionStream.
 *
 * `deflate-raw` is the format used inside ZIP entries; `deflate` is the
 * zlib wrapper used by PDF FlateDecode. Both are streaming transformers, so we
 * pipe a bounded slice through and read the result back out.
 */
async function inflate(
  bytes: Uint8Array,
  format: 'deflate-raw' | 'deflate',
  maxBytes = MAX_PART_BYTES
): Promise<Uint8Array | null> {
  if (!bytes.length) return null
  if (typeof DecompressionStream === 'undefined') return null

  // A Blob is used because some runtimes reject a plain Uint8Array as a
  // ReadableStream source for compression streams.
  const source = new Blob([bytes as unknown as BlobPart])
  const stream = source.stream().pipeThrough(new DecompressionStream(format))

  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.length
        if (total > maxBytes) {
          await reader.cancel().catch(() => {})
          return null
        }
        chunks.push(value)
      }
    }
  } catch {
    // Truncated or wrongly-guessed streams are expected; caller decides.
    return null
  }

  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

// ---------------------------------------------------------------
// ZIP reader (DOCX / PPTX)
// ---------------------------------------------------------------

const u16 = (view: DataView, offset: number) => view.getUint16(offset, true)
const u32 = (view: DataView, offset: number) => view.getUint32(offset, true)

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  localOffset: number
}

/**
 * Read the ZIP central directory.
 *
 * The central directory is authoritative — it records the true compressed size
 * even when a local header was written with a streaming placeholder (which
 * OOXML writers commonly do), so sizes are taken from here rather than from
 * the local header.
 */
function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const len = bytes.length

  // End Of Central Directory: scan back over a possible trailing comment.
  let eocd = -1
  const scanFrom = Math.max(0, len - 65557)
  for (let i = len - 22; i >= scanFrom; i--) {
    if (u32(view, i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return []

  const entryCount = u16(view, eocd + 10)
  const cdOffset = u32(view, eocd + 16)
  if (cdOffset >= len) return []

  const entries: ZipEntry[] = []
  let p = cdOffset

  for (let i = 0; i < entryCount; i++) {
    if (p + 46 > len) break
    if (u32(view, p) !== 0x02014b50) break // central file header signature

    const method = u16(view, p + 10)
    const compressedSize = u32(view, p + 20)
    const nameLen = u16(view, p + 28)
    const extraLen = u16(view, p + 30)
    const commentLen = u16(view, p + 32)
    const localOffset = u32(view, p + 42)

    const nameStart = p + 46
    if (nameStart + nameLen > len) break
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLen))

    entries.push({ name, method, compressedSize, localOffset })
    p = nameStart + nameLen + extraLen + commentLen
  }

  return entries
}

/** Extract and inflate a single entry, or null when it cannot be read. */
async function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array | null> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const len = bytes.length
  const lo = entry.localOffset

  if (lo + 30 > len) return null
  if (u32(view, lo) !== 0x04034b50) return null // local file header signature

  const nameLen = u16(view, lo + 26)
  const extraLen = u16(view, lo + 28)
  const dataStart = lo + 30 + nameLen + extraLen

  // Stored size can legitimately be zero in a local header (streaming write),
  // so fall back to running to the next signature when the central directory
  // could not supply it.
  let size = entry.compressedSize
  if (!size || dataStart + size > len) {
    size = len - dataStart
  }
  const slice = bytes.subarray(dataStart, Math.min(dataStart + size, len))

  if (entry.method === 0) return slice // stored
  if (entry.method === 8) return inflate(slice, 'deflate-raw')
  return null // other methods (bzip2/lzma) are not used by OOXML
}

// ---------------------------------------------------------------
// XML → text
// ---------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#160': ' '
}

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? safeCodePoint(code) : match
    }
    if (body.startsWith('#')) {
      const code = parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? safeCodePoint(code) : match
    }
    return ENTITIES[body] ?? match
  })
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/**
 * Pull text runs out of an OOXML part.
 *
 * Only the text nodes are wanted, so the markup is walked rather than
 * stripped wholesale: `<w:t>` (Word) and `<a:t>` (PowerPoint) are the runs
 * that carry visible characters. Paragraph and line-break elements become
 * whitespace so words do not fuse across them.
 */
/**
 * Run-level scanner: 'w' = WordprocessingML, 'a' = DrawingML.
 *
 * A single pass captures text runs *and* the separator-only elements
 * (`br`/`cr` = line break, `tab` = spacing), because those carry no text node
 * of their own yet must not silently vanish — otherwise "Line oneLine two"
 * would be indexed as one word.
 *
 * Note the alternation order: `<w:t…>` never matches `<w:tab/>` or `<w:tbl>`
 * because `t` must be followed by `>` or whitespace.
 */
const RUN_SRC = {
  w: '<w:t(?:\\s[^>]*)?>([\\s\\S]*?)</w:t>|<w:(?:br|cr)\\s*/>|<w:tab\\s*/>',
  a: '<a:t(?:\\s[^>]*)?>([\\s\\S]*?)</a:t>|<a:br\\s*/>|<a:tab\\s*/>'
} as const

/** Paragraph containers, used to keep words from fusing across lines. */
const PARA_SRC = {
  w: '<w:p(?:\\s[^>]*)?>([\\s\\S]*?)</w:p>',
  a: '<a:p(?:\\s[^>]*)?>([\\s\\S]*?)</a:p>'
} as const

function runsToText(xml: string, ns: 'w' | 'a'): string {
  const re = new RegExp(RUN_SRC[ns], 'g')
  const parts: string[] = []
  let m: RegExpExecArray | null

  while ((m = re.exec(xml)) !== null) {
    if (m[1] !== undefined) {
      parts.push(decodeEntities(m[1].replace(/<[^>]*>/g, '')))
    } else if (/^<[wa]:(?:br|cr)/.test(m[0])) {
      parts.push('\n')
    } else {
      parts.push(' ')
    }
  }

  return parts.join('')
}

/** Paragraph-aware text for one OOXML part. */
function ooxmlText(xml: string, ns: 'w' | 'a'): string {
  const re = new RegExp(PARA_SRC[ns], 'g')
  const paras: string[] = []
  let m: RegExpExecArray | null

  while ((m = re.exec(xml)) !== null) {
    const t = runsToText(m[1], ns)
    if (t.trim()) paras.push(t)
  }

  // Parts without paragraph wrappers still carry text in runs.
  if (!paras.length) {
    const t = runsToText(xml, ns)
    if (t.trim()) paras.push(t)
  }

  return normalise(paras.join('\n'))
}

// ---------------------------------------------------------------
// PDF (FlateDecode content streams)
// ---------------------------------------------------------------

/**
 * Decode a PDF literal string `( … )`, honouring escapes.
 *
 * Balanced parentheses may nest per the spec, so depth is tracked rather than
 * stopping at the first `)`.
 */
function readPdfLiteral(src: string, start: number): { text: string; end: number } {
  let depth = 1
  let i = start
  let out = ''
  const octal = /[0-7]/

  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\') {
      const next = src[i + 1]
      switch (next) {
        case 'n': out += '\n'; i += 2; continue
        case 'r': out += '\r'; i += 2; continue
        case 't': out += '\t'; i += 2; continue
        case 'b': i += 2; continue
        case 'f': i += 2; continue
        case '(': out += '('; i += 2; continue
        case ')': out += ')'; i += 2; continue
        case '\\': out += '\\'; i += 2; continue
        default:
          if (next && octal.test(next)) {
            let oct = ''
            let j = i + 1
            while (j < src.length && oct.length < 3 && octal.test(src[j])) {
              oct += src[j]
              j++
            }
            out += String.fromCharCode(parseInt(oct, 8))
            i = j
            continue
          }
          i += 2
          continue
      }
    }
    if (ch === '(') {
      depth++
      out += ch
      i++
      continue
    }
    if (ch === ')') {
      depth--
      if (depth === 0) return { text: out, end: i + 1 }
      out += ch
      i++
      continue
    }
    out += ch
    i++
  }

  return { text: out, end: i }
}

/** Decode a PDF hex string `<48656c6c6f>`, including UTF-16BE BOM forms. */
function readPdfHex(src: string, start: number): { text: string; end: number } {
  const close = src.indexOf('>', start)
  if (close < 0) return { text: '', end: start }
  let hex = src.slice(start, close).replace(/[^0-9a-fA-F]/g, '')
  if (hex.length % 2) hex += '0'

  const bytes: number[] = []
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16))
  }

  // UTF-16BE is detected by the FE FF byte-order mark.
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = ''
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1])
    }
    return { text: out, end: close + 1 }
  }

  let out = ''
  for (const b of bytes) out += String.fromCharCode(b)
  return { text: out, end: close + 1 }
}

/**
 * Read the text-showing operators out of one decompressed content stream.
 *
 * Handles `(str) Tj`, `<hex> Tj`, `[(a) -20 (b)] TJ`, the quote operators
 * `'` / `"`, and treats `Td`/`TD`/`T*`/`ET` as line breaks so words from
 * different lines do not run together.
 */
function pdfContentText(content: string, out: string[]): void {
  let i = 0
  const len = content.length
  let line: string[] = []

  const flush = () => {
    const text = line.join('').replace(/\s+/g, ' ').trim()
    if (text) out.push(text)
    line = []
  }

  while (i < len) {
    const ch = content[i]

    if (ch === '(') {
      const { text, end } = readPdfLiteral(content, i + 1)
      line.push(text)
      i = end
      continue
    }

    if (ch === '<' && content[i + 1] !== '<') {
      const { text, end } = readPdfHex(content, i + 1)
      line.push(text)
      i = end
      continue
    }

    // Array form: [(a) -1 (b)] TJ — concatenation, spacing handled by kerning.
    if (ch === '[') {
      i++
      continue
    }

    // Text position / state operators imply a new visual line.
    if (ch === 'T') {
      const op = content.slice(i, i + 2)
      if (op === 'Td' || op === 'TD' || op === 'T*' || op === 'TJ') {
        if (op !== 'TJ') flush()
        i += 2
        continue
      }
    }

    if (ch === 'E' && content.slice(i, i + 2) === 'ET') {
      flush()
      i += 2
      continue
    }

    i++
  }

  flush()
}

/**
 * Extract the text layer from a PDF.
 *
 * Streams are located by `stream … endstream` delimiters and inflated with the
 * zlib format. Both the declared `/Length` and a scan-to-keyword fallback are
 * attempted, because `/Length` is frequently an indirect reference.
 */
async function extractPdf(bytes: Uint8Array): Promise<ExtractionResult> {
  const raw = latin1(bytes)
  const streams = locatePdfStreams(raw)
  const textBlocks: string[] = []
  let inflated = 0

  for (const stream of streams) {
    const out = await inflate(stream, 'deflate')
    if (out) {
      inflated++
      pdfContentText(latin1(out), textBlocks)
    } else {
      // Some generators emit uncompressed content streams; try them as-is.
      pdfContentText(latin1(stream), textBlocks)
    }
  }

  const text = normalise(textBlocks.join('\n'))

  if (text.length >= 1) {
    return {
      text: cap(text),
      supported: true,
      ok: true,
      note: 'PDF text layer extracted',
      chars: text.length,
      via: `pdf-content-streams(${inflated}/${streams.length})`
    }
  }

  return {
    text: null,
    supported: true,
    ok: false,
    note:
      'No text layer found — this PDF is likely scanned or image-only, so it is searchable by title, filename, description and tags',
    via: `pdf-content-streams(${inflated}/${streams.length})`
  }
}

/** Byte-preserving single-byte decode, used for binary PDF structure walks. */
function latin1(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let out = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)))
  }
  return out
}

/** Locate every `stream … endstream` payload in a PDF by scanning bytes. */
function locatePdfStreams(raw: string): Uint8Array[] {
  const found: Uint8Array[] = []
  const marker = 'stream'
  let from = 0

  while (found.length < 512) {
    const at = raw.indexOf(marker, from)
    if (at < 0) break

    // Step over 'stream' plus its EOL (CRLF or LF).
    let start = at + marker.length
    if (raw[start] === '\r') start++
    if (raw[start] === '\n') start++

    const end = raw.indexOf('endstream', start)
    if (end < 0) break

    // Trim the EOL that precedes 'endstream'.
    let stop = end
    if (raw[stop - 1] === '\n') stop--
    if (raw[stop - 1] === '\r') stop--

    if (stop > start) {
      const slice = new Uint8Array(stop - start)
      for (let i = start; i < stop; i++) slice[i - start] = raw.charCodeAt(i) & 0xff
      found.push(slice)
    }

    from = end + 'endstream'.length
  }

  return found
}

// ---------------------------------------------------------------
// Text hygiene
// ---------------------------------------------------------------

function normalise(text: string): string {
  return text
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

function cap(text: string): string {
  return text.length > MAX_EXTRACTED_CHARS ? text.slice(0, MAX_EXTRACTED_CHARS) : text
}

// ---------------------------------------------------------------
// Format handlers
// ---------------------------------------------------------------

function extractHtml(bytes: Uint8Array): ExtractionResult {
  const raw = decoder.decode(bytes)
  const text = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim()

  if (!text) {
    return { text: null, supported: true, ok: false, note: 'HTML contained no text content', via: 'html' }
  }
  return {
    text: cap(text),
    supported: true,
    ok: true,
    note: 'HTML text extracted',
    chars: text.length,
    via: 'html'
  }
}

/** Body text lives in these parts; headers/footers are boilerplate. */
const DOCX_PARTS = ['word/document.xml', 'word/footnotes.xml', 'word/endnotes.xml']

async function extractDocx(bytes: Uint8Array): Promise<ExtractionResult> {
  const entries = readZipEntries(bytes)
  if (!entries.length) {
    return { text: null, supported: true, ok: false, note: 'DOCX is not a readable OOXML container', via: 'docx' }
  }

  const byName = new Map(entries.map((e) => [e.name, e]))
  const blocks: string[] = []
  let parts = 0

  for (const name of DOCX_PARTS) {
    const entry = byName.get(name)
    if (!entry) continue
    const raw = await readZipEntry(bytes, entry)
    if (!raw) continue
    parts++
    const text = ooxmlText(decoder.decode(raw), 'w')
    if (text) blocks.push(text)
  }

  const text = normalise(blocks.join('\n\n'))
  if (text) {
    return {
      text: cap(text),
      supported: true,
      ok: true,
      note: 'DOCX text extracted',
      chars: text.length,
      via: `docx-xml(${parts} part${parts === 1 ? '' : 's'})`
    }
  }

  return {
    text: null,
    supported: true,
    ok: false,
    note: 'DOCX opened but held no extractable text',
    via: `docx-xml(${parts} part${parts === 1 ? '' : 's'})`
  }
}

async function extractPptx(bytes: Uint8Array): Promise<ExtractionResult> {
  const entries = readZipEntries(bytes)
  if (!entries.length) {
    return { text: null, supported: true, ok: false, note: 'PPTX is not a readable OOXML container', via: 'pptx' }
  }

  const numOf = (name: string) => {
    const m = /(\d+)\.xml$/.exec(name)
    return m ? parseInt(m[1], 10) : 0
  }

  const slides = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .sort((a, b) => numOf(a.name) - numOf(b.name))

  const notes = entries
    .filter((e) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(e.name))
    .sort((a, b) => numOf(a.name) - numOf(b.name))

  const blocks: string[] = []
  let read = 0

  for (const entry of slides) {
    const raw = await readZipEntry(bytes, entry)
    if (!raw) continue
    read++
    const text = ooxmlText(decoder.decode(raw), 'a')
    // The slide marker keeps results attributable to a place in the deck.
    if (text) blocks.push(`[Slide ${numOf(entry.name)}] ${text}`)
  }

  for (const entry of notes) {
    const raw = await readZipEntry(bytes, entry)
    if (!raw) continue
    const text = ooxmlText(decoder.decode(raw), 'a')
    if (text) blocks.push(`[Speaker notes] ${text}`)
  }

  const text = normalise(blocks.join('\n\n'))
  if (text) {
    return {
      text: cap(text),
      supported: true,
      ok: true,
      note: 'PPTX slide text extracted',
      chars: text.length,
      via: `pptx-xml(${read}/${slides.length} slides)`
    }
  }

  return {
    text: null,
    supported: true,
    ok: false,
    note: 'PPTX opened but held no extractable text',
    via: `pptx-xml(${read}/${slides.length} slides)`
  }
}

// ---------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------

/**
 * Extract searchable text for a supported format.
 *
 * Always resolves — a malformed or unextractable file reports `ok: false`
 * with a reason rather than failing the upload.
 */
export async function extractText(ext: string, bytes: Uint8Array): Promise<ExtractionResult> {
  switch (ext) {
    case 'html':
    case 'htm':
      return extractHtml(bytes)
    case 'pdf':
      return extractPdf(bytes)
    case 'docx':
      return extractDocx(bytes)
    case 'pptx':
      return extractPptx(bytes)
    default:
      return {
        text: null,
        supported: false,
        ok: false,
        note: `No text extractor for .${ext}; searchable by title, filename, description and tags`
      }
  }
}
