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

/** Read a hex string payload verbatim, so a font CMap can decode it later. */
function readPdfHexRaw(src: string, start: number): { hex: string; end: number } {
  const close = src.indexOf('>', start)
  if (close < 0) return { hex: '', end: start }
  return { hex: src.slice(start, close), end: close + 1 }
}

/** Decode a PDF hex string `<48656c6c6f>`, including UTF-16BE BOM forms. */
function readPdfHex(src: string, start: number): { text: string; end: number } {
  const { hex, end } = readPdfHexRaw(src, start)
  return { text: decodePlainHex(hex), end }
}

/**
 * Default decoding for a hex string with no font CMap available: PDF treats it
 * as a byte string, with a UTF-16BE byte-order mark switching the meaning.
 */
function decodePlainHex(rawHex: string): string {
  let hex = rawHex.replace(/[^0-9a-fA-F]/g, '')
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
    return out
  }

  let out = ''
  for (const b of bytes) out += String.fromCharCode(b)
  return out
}

/**
 * Read the text-showing operators out of one decompressed content stream.
 *
 * Handles `(str) Tj`, `<hex> Tj`, `[(a) -20 (b)] TJ`, the quote operators
 * `'` / `"`, and treats `Td`/`TD`/`T*`/`ET` as line breaks so words from
 * different lines do not run together.
 */
function pdfContentText(
  content: string,
  out: string[],
  fonts?: Map<string, PdfCMap> | null
): void {
  let i = 0
  const len = content.length
  let line: string[] = []
  let current: PdfCMap | null = null

  const flush = () => {
    // Control characters are never extractable text. A font that addresses
    // glyphs by code leaves a few of them behind (e.g. `\001n\002c\003d`), and
    // letting them through used to sink an entire page at the plausibility
    // gate — 330 characters of real prose discarded over a handful of bytes.
    const text = line
      .join('')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
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

    // Hex strings carry the interesting case: a CID/TrueType font addresses
    // glyphs by code, and only its ToUnicode CMap says what those codes mean.
    if (ch === '<' && content[i + 1] !== '<') {
      const { hex, end } = readPdfHexRaw(content, i + 1)
      line.push(current ? applyCMap(hex, current) : decodePlainHex(hex))
      i = end
      continue
    }

    // Array form: [(a) -1 (b)] TJ — concatenation, spacing handled by kerning.
    if (ch === '[') {
      i++
      continue
    }

    // Font selection decides how every following hex string is decoded.
    if (ch === 'T' && content[i + 1] === 'f') {
      current = fonts?.get(fontNameBefore(content, i)) ?? null
      i += 2
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
 * The operand of a `Tf` operator, read backwards from the operator itself.
 *
 * `Tf` takes `(/Name) size Tf`, e.g. `/F1 14 Tf`, so the token immediately
 * before the size is the resource name.
 */
function fontNameBefore(content: string, at: number): string {
  const window = content.slice(Math.max(0, at - 80), at)
  const match = /([A-Za-z0-9._+-]+)\s+[-\d.]*\s*$/.exec(window)
  return match ? match[1] : ''
}

/**
 * Plausibility check for assembled PDF text.
 *
 * Decompressed font programs, XMP packets and image payloads are full of bytes
 * that look like PDF string literals, so a "did we find parentheses?" test is
 * not enough — the scanned-image fixture previously yielded 75k characters of
 * noise that was reported as a successful extraction. Real text has a high
 * printable ratio, almost no control bytes, and looks like words.
 */
function looksLikeExtractedText(text: string): boolean {
  if (!text) return false
  const len = text.length
  if (len < 2) return false

  let printable = 0
  let alnum = 0
  let control = 0

  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code === 9 || code === 10 || code === 13) {
      printable++
      continue
    }
    if (code < 32 || code === 0xfffd) {
      control++
      continue
    }
    printable++
    if (/[\p{L}\p{N}]/u.test(ch)) alnum++
  }

  // Binary noise is dense in control bytes; prose almost never is.
  if (control / len > 0.02) return false
  if (printable / len < 0.9) return false

  // Short strings (a title, a label) pass on legibility alone.
  if (len < 80) return alnum / len >= 0.25

  // Longer text must read like language. Numeric tables are allowed through on
  // their digit density so a data-only page is not discarded.
  const digits = (text.match(/\p{N}/gu) ?? []).length
  const letters = (text.match(/\p{L}/gu) ?? []).length
  const density = Math.max(letters / len, digits / len)
  if (density < 0.3) return false

  const words = text.split(/\s+/).filter((w) => w.length >= 3 && /\p{L}/u.test(w))
  return words.length >= 3
}

/**
 * Extract the text layer from a PDF.
 *
 * Two passes, both conservative:
 *
 * 1. **ToUnicode pass** — resolve each page's active font and decode its
 *    character codes through that font's `ToUnicode` CMap. This is what makes
 *    Word/LibreOffice output readable: such PDFs address glyphs by code
 *    (`[<01>1<020304>]TJ`), so the CMap is the only thing that maps `<01>` to
 *    `E`. Without it those bytes decode to control characters and the page
 *    looks empty.
 * 2. **Operator pass** — no usable CMaps, so scan content streams directly,
 *    skipping embedded font programs, which are binary and dense with
 *    string-like byte sequences.
 *
 * In both passes a stream must decode cleanly under its declared filter chain
 * and contain real PDF text operators, and the assembled result must pass
 * `looksLikeExtractedText`.
 *
 * Anything else reports "no text layer". That is the correct answer for a scan,
 * and the honest answer for a PDF this parser cannot read — object streams
 * (`/ObjStm`), encrypted content, or fonts with no ToUnicode map. Those are not
 * claimed as supported.
 */
async function extractPdf(bytes: Uint8Array): Promise<ExtractionResult> {
  const raw = latin1(bytes)
  const streams = locatePdfStreams(raw)
  const objs = parsePdfObjects(raw)

  const textBlocks: string[] = []
  let scanned = 0
  let viaCMap = false
  let fontCount = 0

  // Pass 1: resolve character codes through per-font ToUnicode CMaps.
  if (objs.size && streams.length) {
    const fonts = await collectPdfFonts(objs, streams)
    fontCount = fonts.size

    if (fonts.size) {
      for (const stream of streams) {
        if (isNonContent(stream.dict)) continue
        const decoded = await decodeStream(stream)
        if (!decoded) continue
        const content = latin1(decoded)
        // A page content stream opens a text object. Requiring this is what
        // stops font programs and image data from being scanned as pages.
        if (!/\bBT\b/.test(content) && !/\bTj\b/.test(content) && !/\bTJ\b/.test(content)) continue
        scanned++
        pdfContentText(content, textBlocks, fonts)
      }

      if (looksLikeExtractedText(textBlocks.join('\n'))) {
        viaCMap = true
      } else {
        // The CMaps resolved too little to be meaningful — discard this attempt
        // rather than reporting a document that is actually readable as empty.
        textBlocks.length = 0
        scanned = 0
      }
    }
  }

  // Pass 2: no usable CMaps, so scan content streams directly.
  if (!viaCMap) {
    const fontPrograms = findFontProgramStreams(objs)

    for (const stream of streams) {
      if (fontPrograms.has(stream.objNum)) continue
      if (isNonContent(stream.dict)) continue
      const decoded = await decodeStream(stream)
      if (!decoded) continue
      const content = latin1(decoded)
      if (!/\bBT\b/.test(content) && !/\bTj\b/.test(content) && !/\bTJ\b/.test(content)) continue
      scanned++
      pdfContentText(content, textBlocks, null)
    }
  }

  const joined = textBlocks.join('\n')
  const via = viaCMap
    ? `pdf-tounicode(fonts=${fontCount},text=${scanned}/${streams.length})`
    : `pdf-content-streams(text=${scanned}/${streams.length})`

  if (looksLikeExtractedText(joined)) {
    const text = normalise(joined)
    if (text.length >= 1) {
      return {
        text: cap(text),
        supported: true,
        ok: true,
        note: 'PDF text layer extracted',
        chars: text.length,
        via
      }
    }
  }

  return {
    text: null,
    supported: true,
    ok: false,
    note:
      'No decodable text layer — this PDF is likely scanned, or uses structures this parser does not support (object streams, encrypted content, or fonts with no ToUnicode map). Searchable by title, filename, description and tags',
    via
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

/**
 * One `stream … endstream` payload plus its dictionary and owning object.
 * The dictionary matters because a stream's filters decide whether its bytes
 * can be decoded at all — and encoding is not a detail that can be guessed.
 * The object number matters because font programs are looked up by it.
 */
interface PdfStream {
  bytes: Uint8Array
  dict: string
  objNum: number
}

/**
 * Locate every `stream … endstream` payload, capturing its dictionary.
 *
 * The walk is driven by object headers rather than by searching for the five
 * bytes `stream`: compressed payloads routinely contain that sequence, and a
 * naive search produced phantom streams (a font program and an XMP packet were
 * each counted twice in a real LibreOffice PDF, which is why the earlier
 * "text streams / total streams" ratio was misleading).
 */
function locatePdfStreams(raw: string): PdfStream[] {
  const found: PdfStream[] = []
  const re = /(\d+)\s+\d+\s+obj\b/g
  let m: RegExpExecArray | null

  while ((m = re.exec(raw)) !== null) {
    const num = parseInt(m[1], 10)
    if (!Number.isFinite(num)) continue

    const sIdx = raw.indexOf('stream', re.lastIndex)
    if (sIdx < 0) break

    // If the object closes before any `stream` appears, that keyword belongs to
    // a later object — not this one.
    const eObj = raw.indexOf('endobj', re.lastIndex)
    if (eObj >= 0 && sIdx > eObj) continue

    const dict = raw.slice(re.lastIndex, sIdx)
    if (!dict.includes('<<')) continue

    // Step over 'stream' plus its EOL (CRLF or LF).
    let start = sIdx + 'stream'.length
    if (raw[start] === '\r') start++
    if (raw[start] === '\n') start++

    const end = raw.indexOf('endstream', start)
    if (end < 0) break

    // Trim the EOL that precedes 'endstream'.
    let stop = end
    if (raw[stop - 1] === '\n') stop--
    if (raw[stop - 1] === '\r') stop--
    if (stop <= start) continue

    const slice = new Uint8Array(stop - start)
    for (let i = start; i < stop; i++) slice[i - start] = raw.charCodeAt(i) & 0xff
    found.push({ bytes: slice, dict, objNum: num })

    if (found.length >= 512) break
  }

  return found
}

/** Filter names declared by a stream dictionary, in application order. */
function streamFilters(dict: string): string[] {
  const match = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(dict)
  if (!match) return []
  return (match[1].match(/\/[A-Za-z0-9]+/g) ?? []).map((name) => name.slice(1))
}

// ---------------------------------------------------------------
// ToUnicode CMaps
// ---------------------------------------------------------------

/**
 * A font's character-code → Unicode mapping, parsed from its ToUnicode CMap.
 *
 * `bytes` is the code width: 1 for simple fonts, 2 for Type0/CID fonts whose
 * codes are multi-byte.
 */
interface PdfCMap {
  codes: Map<number, string>
  bytes: number
}

/**
 * Indirect-object bodies, keyed by object number.
 *
 * Only the dictionary head of each object is captured (from the first `<<` to
 * `endobj`), which is all that is needed to follow `/ToUnicode`, `/Font` and
 * `/Length1` references.
 */
function parsePdfObjects(raw: string): Map<number, string> {
  const out = new Map<number, string>()
  const re = /(\d+)\s+\d+\s+obj\b/g
  let m: RegExpExecArray | null

  while ((m = re.exec(raw)) !== null) {
    const num = parseInt(m[1], 10)
    const stop = raw.indexOf('endobj', re.lastIndex)
    const body = raw.slice(re.lastIndex, stop < 0 ? raw.length : stop)
    out.set(num, dictStartOf(body))
  }

  return out
}

/** The dictionary portion of an object body, ignoring any trailing stream. */
function dictStartOf(body: string): string {
  const open = body.indexOf('<<')
  if (open < 0) return ''
  const end = body.indexOf('endobj')
  return body.slice(open, end < 0 ? body.length : end)
}

/** Follow an indirect reference such as `/ToUnicode 41 0 R` to its object id. */
function resolveObjNum(scope: string, key: string): number | null {
  const re = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R\\b`)
  const m = re.exec(scope)
  return m ? parseInt(m[1], 10) : null
}

/** UTF-16BE hex payload (the ToUnicode target format) → string. */
function hexToUnicode(hex: string): string {
  if (hex.length <= 2) return String.fromCharCode(parseInt(hex, 16) || 0)
  let out = ''
  for (let i = 0; i + 4 <= hex.length; i += 4) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16))
  }
  return out
}

/** First code point of a ToUnicode target, used as a bfrange base. */
function firstCodePoint(hex: string): number {
  if (hex.length <= 2) return parseInt(hex, 16) || 0
  return parseInt(hex.slice(0, 4), 16)
}

/**
 * Parse a ToUnicode CMap.
 *
 * Both mapping forms are read: `beginbfchar` pairs (`<01> <0045>` — glyph code
 * to Unicode) and `beginbfrange` spans (`<01> <20> <0041>` — consecutive runs,
 * which is how most subset fonts encode a whole alphabet compactly).
 */
function parseToUnicodeCMap(text: string): PdfCMap | null {
  const codes = new Map<number, string>()
  let bytes = 1
  let m: RegExpExecArray | null

  const charBlocks = /beginbfchar([\s\S]*?)endbfchar/g
  while ((m = charBlocks.exec(text)) !== null) {
    const pair = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g
    let p: RegExpExecArray | null
    while ((p = pair.exec(m[1])) !== null) {
      if (p[1].length > 2) bytes = 2
      const mapped = hexToUnicode(p[2])
      // `<00> <0000>` entries are .notdef placeholders, not characters.
      if (!mapped || mapped === '\u0000') continue
      codes.set(parseInt(p[1].slice(0, 4), 16), mapped)
    }
  }

  const rangeBlocks = /beginbfrange([\s\S]*?)endbfrange/g
  while ((m = rangeBlocks.exec(text)) !== null) {
    const range = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g
    let p: RegExpExecArray | null
    while ((p = range.exec(m[1])) !== null) {
      const lo = parseInt(p[1].slice(0, 4), 16)
      const hi = parseInt(p[2].slice(0, 4), 16)
      const base = firstCodePoint(p[3])
      if (p[1].length > 2) bytes = 2
      // Bounded so a corrupt range cannot fan out into a huge loop.
      const span = Math.min(hi - lo, 1024)
      for (let k = 0; k <= span; k++) {
        codes.set(lo + k, String.fromCharCode((base + k) & 0xffff))
      }
    }
  }

  return codes.size ? { codes, bytes } : null
}

/**
 * Resolve a page's `Tf` resource name to a parsed CMap.
 *
 * Walks the real indirection chain — Resources → `/Font` → the font resource
 * dictionary → `/Fx n 0 R` → that font object's `/ToUnicode` stream — instead
 * of merging every CMap in the file into one table. Merging would be wrong:
 * in a real Word PDF the code `<01>` means `E` in one font and `O` in another.
 */
async function collectPdfFonts(
  objs: Map<number, string>,
  streams: PdfStream[]
): Promise<Map<string, PdfCMap>> {
  const streamByObj = new Map(streams.map((s) => [s.objNum, s]))
  const out = new Map<string, PdfCMap>()

  for (const body of objs.values()) {
    if (!/\/Font\b/.test(body)) continue

    // The resource dictionary may inline the font map or reference it.
    let fontDict = body
    const viaRef = /\/Font\s+(\d+)\s+\d+\s+R\b/.exec(body)
    if (viaRef) {
      const target = objs.get(parseInt(viaRef[1], 10))
      if (!target) continue
      fontDict = target
    }

    const refRe = /\/([A-Za-z0-9._+-]+)\s+(\d+)\s+\d+\s+R\b/g
    let m: RegExpExecArray | null
    while ((m = refRe.exec(fontDict)) !== null) {
      const name = m[1]
      if (out.has(name)) continue
      const fontObj = objs.get(parseInt(m[2], 10))
      if (!fontObj) continue

      const toUni = resolveObjNum(fontObj, 'ToUnicode')
      if (toUni == null) continue
      const stream = streamByObj.get(toUni)
      if (!stream) continue

      const decoded = await decodeStream(stream)
      if (!decoded) continue
      const cmap = parseToUnicodeCMap(latin1(decoded))
      if (cmap) out.set(name, cmap)
    }
  }

  return out
}

/**
 * Decode one hex string of glyph codes through a font's CMap.
 *
 * Returns '' when nothing resolves — emitting the raw codes instead would put
 * control characters into the extracted text as if they were content.
 */
function applyCMap(rawHex: string, cmap: PdfCMap): string {
  const hex = rawHex.replace(/[^0-9a-fA-F]/g, '')
  const width = cmap.bytes === 2 ? 4 : 2
  let out = ''

  for (let i = 0; i + width <= hex.length; i += width) {
    const mapped = cmap.codes.get(parseInt(hex.slice(i, i + width), 16))
    if (mapped !== undefined) out += mapped
  }

  return out
}

/**
 * Streams holding embedded font programs.
 *
 * `/Length1` is the reliable tell: it is required on Type1/TrueType font
 * streams (`FontFile`/`FontFile2`) and appears nowhere else. These payloads are
 * binary, large, and full of parenthesised byte runs, so on the no-CMap path
 * they must never be scanned as page content.
 */
function findFontProgramStreams(objs: Map<number, string>): Set<number> {
  const out = new Set<number>()
  for (const [num, body] of objs) {
    if (/\/Length1\b/.test(body)) out.add(num)
    if (/\/Type\s*\/FontFile/.test(body)) out.add(num)
    if (/\/Subtype\s*\/(Type1C|CIDFontType0C|OpenType)\b/.test(body)) out.add(num)
  }
  return out
}

/**
 * Encodings that carry raster/scan data. A stream using one of these is never
 * text — feeding a JPEG through the text scanner is what previously produced
 * tens of thousands of characters of noise for a scanned document.
 */
const NON_TEXT_FILTERS = new Set([
  'DCTDecode',
  'JPXDecode',
  'CCITTFaxDecode',
  'JBIG2Decode',
  'RunLengthDecode'
])

/**
 * Dictionaries describing fonts, images or metadata rather than page content.
 * Font programs are especially dangerous: they are large, binary, and full of
 * `(...)` byte sequences that resemble PDF string literals.
 */
const NON_CONTENT_DICT: RegExp[] = [
  /\/Subtype\s*\/Image/,
  /\/Type\s*\/Metadata/,
  /\/Type\s*\/FontFile/,
  /\/Subtype\s*\/XML/,
  /\/Subtype\s*\/Type1C/,
  /\/Subtype\s*\/CIDFontType0C/,
  /\/Subtype\s*\/(Type1|TrueType|OpenType)\b/,
  /\/Length1\b/
]

function isNonContent(dict: string): boolean {
  if (!dict) return false
  if (NON_CONTENT_DICT.some((re) => re.test(dict))) return true
  return streamFilters(dict).some((f) => NON_TEXT_FILTERS.has(f))
}

/**
 * Decode PDF ASCII85 (base-85). Whitespace is skipped, `z` is the all-zero
 * group shortcut, and `~>` terminates. Returns null on malformed input rather
 * than emitting a partially-correct buffer.
 */
function decodeAscii85(bytes: Uint8Array): Uint8Array | null {
  const out: number[] = []
  let tuple = 0
  let count = 0
  let i = 0

  // PDF allows an optional '<~' introducer.
  if (bytes[0] === 0x3c && bytes[1] === 0x7e) i = 2

  for (; i < bytes.length; i++) {
    const b = bytes[i]
    if (b === 0x7e) break // '~>'
    if (b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09 || b === 0x0c || b === 0x00) continue

    if (b === 0x7a && count === 0) {
      out.push(0, 0, 0, 0)
      continue
    }
    if (b < 0x21 || b > 0x75) return null

    tuple = tuple * 85 + (b - 0x21)
    count++
    if (count === 5) {
      // Math.floor rather than bit shifts: a 5-tuple can exceed 32 bits.
      out.push(
        Math.floor(tuple / 16777216) & 0xff,
        Math.floor(tuple / 65536) & 0xff,
        Math.floor(tuple / 256) & 0xff,
        tuple & 0xff
      )
      tuple = 0
      count = 0
    }
  }

  if (count > 0) {
    // Pad the final partial group with 'u' (84), emit count-1 bytes.
    for (let k = count; k < 5; k++) tuple = tuple * 85 + 84
    const padded = [
      Math.floor(tuple / 16777216) & 0xff,
      Math.floor(tuple / 65536) & 0xff,
      Math.floor(tuple / 256) & 0xff,
      tuple & 0xff
    ]
    for (let k = 0; k < count - 1; k++) out.push(padded[k])
  }

  return out.length ? Uint8Array.from(out) : null
}

/** Decode PDF ASCIIHex. Returns null on a truncated or malformed run. */
function decodeAsciiHex(bytes: Uint8Array): Uint8Array | null {
  const nibbles: number[] = []
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    if (b === 0x3e) break // '>'
    if (b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09 || b === 0x0c) continue
    let v: number
    if (b >= 0x30 && b <= 0x39) v = b - 0x30
    else if (b >= 0x41 && b <= 0x46) v = b - 0x41 + 10
    else if (b >= 0x61 && b <= 0x66) v = b - 0x61 + 10
    else return null
    nibbles.push(v)
  }
  if (nibbles.length % 2) nibbles.push(0)
  const out = new Uint8Array(nibbles.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = (nibbles[i * 2] << 4) | nibbles[i * 2 + 1]
  return out
}

/**
 * Apply a stream's declared decode chain.
 *
 * An unrecognised filter yields null instead of falling back to treating the
 * still-encoded bytes as text — guessing was the source of the garbage output.
 */
async function decodeStream(stream: PdfStream): Promise<Uint8Array | null> {
  const filters = streamFilters(stream.dict)
  if (!filters.length) return stream.bytes

  let data: Uint8Array | null = stream.bytes
  for (const filter of filters) {
    if (!data) return null
    if (filter === 'FlateDecode' || filter === 'Fl') data = await inflate(data, 'deflate')
    else if (filter === 'ASCII85Decode' || filter === 'A85') data = decodeAscii85(data)
    else if (filter === 'ASCIIHexDecode' || filter === 'AHx') data = decodeAsciiHex(data)
    else return null
  }
  return data
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
