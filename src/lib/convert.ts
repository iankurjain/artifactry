/**
 * Output conversion service — PRD §18, §19 "Mode B".
 *
 * The library generates a binary from structured content when the AI provider
 * cannot (or should not have to). This is what makes the north-star flow
 * "save this conversation as PDF" work without depending on any vendor.
 *
 * Implemented formats:
 *   HTML  — full document wrapper, sanitised, previewable in the sandbox
 *   PDF   — generated from scratch (Helvetica, paginated), no dependencies
 *
 * DOCX/PPTX are intentionally NOT claimed: they are OOXML ZIP packages that
 * need a document writer unavailable in the Workers runtime. Requesting them
 * returns an explicit, actionable error rather than a corrupt file.
 */

const PAGE_WIDTH = 595
const PAGE_HEIGHT = 842
const MARGIN_X = 48
const MARGIN_TOP = 60
const MARGIN_BOTTOM = 64
const FONT_SIZE = 11
const LEADING = 14.5
const MAX_CHARS_PER_LINE = 92

export interface ContentBlock {
  heading?: string
  paragraphs: string[]
}

export interface ConversionResult {
  bytes: Uint8Array
  mimeType: string
  extension: string
  filename: string
}

export class ConversionUnsupported extends Error {
  constructor(public format: string) {
    super(
      `Cannot generate ${format.toUpperCase()} in this environment: OOXML writing requires a ` +
        `document library that is not available in the Cloudflare Workers runtime. ` +
        `Save as PDF or HTML instead, or have the AI provider send a ${format.toUpperCase()} binary directly.`
    )
  }
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Wrap structured content into a self-contained, sandbox-safe HTML document. */
export function toHtml(title: string, content: string, blocks?: ContentBlock[]): ConversionResult {
  const body = blocks?.length
    ? blocks
        .map((b) => {
          const head = b.heading ? `<h2>${escapeHtml(b.heading)}</h2>` : ''
          const paras = b.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('\n')
          return `${head}\n${paras}`
        })
        .join('\n')
    : content
        .split(/\n{2,}/)
        .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
        .join('\n')

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         margin: 0 auto; padding: 32px 20px; max-width: 680px; line-height: 1.6;
         color: #12151c; background: #fff; }
  h1 { font-size: 24px; margin: 0 0 8px; letter-spacing: -0.01em; }
  h2 { font-size: 17px; margin: 28px 0 8px; }
  p { margin: 0 0 14px; font-size: 15px; }
  .meta { color: #5a6066; font-size: 12px; margin-bottom: 28px; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="meta">Generated ${new Date().toISOString().slice(0, 10)} · Artifactry</p>
${body}
</body>
</html>`

  return {
    bytes: new TextEncoder().encode(html),
    mimeType: 'text/html',
    extension: 'html',
    filename: `${safeBase(title)}.html`
  }
}

function safeBase(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'artifact'
  )
}

/** Word-wrap text to a fixed character budget (Helvetica is near-monospaced enough). */
function wrapText(text: string, maxChars: number): string[] {
  const lines: string[] = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\t/g, '    ')
    if (!line.trim()) {
      lines.push('')
      continue
    }
    let remaining = line
    while (remaining.length > maxChars) {
      let cut = remaining.lastIndexOf(' ', maxChars)
      if (cut <= 0) cut = maxChars
      lines.push(remaining.slice(0, cut).trimEnd())
      remaining = remaining.slice(cut).trimStart()
    }
    lines.push(remaining)
  }
  return lines
}

/** PDF string literals escape only these three characters. */
function pdfEscape(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    // Non-Latin1 characters cannot be expressed in a base-14 Helvetica
    // encoding without an embedded font, so fold them to a safe placeholder.
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?')
}

export interface PdfOptions {
  title: string
  content: string
  subtitle?: string
}

/**
 * Generate a valid, paginated PDF 1.4 document.
 *
 * Written by hand because no PDF library is available in the runtime. The xref
 * table is built from real byte offsets, so the output opens correctly in
 * standard viewers.
 */
export function toPdf(options: PdfOptions): ConversionResult {
  const usableLines = Math.floor((PAGE_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM) / LEADING)
  const headerLines = options.subtitle ? [options.subtitle, ''] : []
  const bodyLines = wrapText(options.content, MAX_CHARS_PER_LINE)

  const allLines = [options.title, '', ...headerLines, ...bodyLines]

  const pages: string[][] = []
  for (let i = 0; i < allLines.length; i += usableLines) {
    pages.push(allLines.slice(i, i + usableLines))
  }
  if (!pages.length) pages.push([''])

  // Object numbering:
  //   1 = Catalog, 2 = Pages, 3 = Font
  //   then per page: a Page object and a Contents stream
  const objects: string[] = []
  const pageObjectNumbers: number[] = []

  const firstPageObj = 4
  for (let i = 0; i < pages.length; i++) {
    pageObjectNumbers.push(firstPageObj + i * 2)
  }

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Count ${pages.length} /Kids [${pageObjectNumbers
    .map((n) => `${n} 0 R`)
    .join(' ')}] >>`
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'

  pages.forEach((lines, pageIndex) => {
    const pageObjNum = firstPageObj + pageIndex * 2
    const contentObjNum = pageObjNum + 1

    objects[pageObjNum] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjNum} 0 R >>`

    // Emit one text object per line: simpler and keeps offsets predictable.
    const parts: string[] = []
    let y = PAGE_HEIGHT - MARGIN_TOP

    lines.forEach((line, lineIndex) => {
      const isTitle = pageIndex === 0 && lineIndex === 0
      const font = isTitle ? 18 : FONT_SIZE
      if (line) {
        parts.push(
          `BT /F1 ${font} Tf ${MARGIN_X} ${y.toFixed(2)} Td (${pdfEscape(line)}) Tj ET`
        )
      }
      y -= isTitle ? 26 : LEADING
    })

    // Page number footer
    parts.push(
      `BT /F1 9 Tf ${MARGIN_X} 36 Td (${pdfEscape(
        `${options.title}  ·  page ${pageIndex + 1} of ${pages.length}`
      )}) Tj ET`
    )

    const stream = parts.join('\n')
    objects[contentObjNum] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  })

  // Serialise while tracking byte offsets for the xref table
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  const totalObjects = objects.length - 1

  for (let i = 1; i <= totalObjects; i++) {
    offsets[i] = pdf.length
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`
  }

  const xrefOffset = pdf.length
  pdf += `xref\n0 ${totalObjects + 1}\n`
  pdf += '0000000000 65535 f \n'
  for (let i = 1; i <= totalObjects; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }

  pdf += `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\n`
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`

  // Latin-1 range only, so a byte-per-char encoding is exact
  const bytes = new Uint8Array(pdf.length)
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff

  return {
    bytes,
    mimeType: 'application/pdf',
    extension: 'pdf',
    filename: `${safeBase(options.title)}.pdf`
  }
}

/**
 * Convert structured or plain content into a target format (§18).
 * Throws ConversionUnsupported with an actionable message for OOXML targets.
 */
export function convertContent(
  format: string,
  title: string,
  content: string,
  blocks?: ContentBlock[]
): ConversionResult {
  const normalized = format.toLowerCase().replace(/^\./, '')

  switch (normalized) {
    case 'pdf':
      return toPdf({ title, content })
    case 'html':
    case 'htm':
      return toHtml(title, content, blocks)
    case 'docx':
    case 'pptx':
      throw new ConversionUnsupported(normalized)
    default:
      throw new ConversionUnsupported(normalized)
  }
}
