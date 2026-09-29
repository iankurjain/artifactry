/**
 * Auto-tagging — AI suggests 3–7 tags from an artifact's real content.
 *
 * Runs on upload, save and reprocess, after extraction (there is no point
 * tagging content that has not been read yet). Suggestions are attached as
 * SUGGESTED and never as CONFIRMED: a machine guess must not silently become
 * the library's vocabulary, and it must not enter the search index.
 *
 * Guardrails, all enforced here rather than trusted to the model:
 *
 *   * 3–7 tags. Fewer than 3 is not useful; more than 7 is noise.
 *   * Generic type words (Document, File, PDF, Presentation, …) are dropped.
 *     They restate the file extension and carry no retrieval value.
 *   * Sensitive personal attributes are never inferred. Artifact content is
 *     not a lawful basis for guessing someone's health, religion, ethnicity,
 *     sexual orientation or political affiliation just to decorate a tag.
 *   * Case-insensitive de-duplication, so "AI" and "ai" cannot both be added.
 *   * Failure is non-fatal and reported honestly: no AI binding means no
 *     suggestions, not invented ones.
 */

import type { Env } from '../types'
import { all } from './db'

/**
 * Text model used for suggestion. Small and fast because this runs inline on
 * the upload path — a slow tagger would delay the artifact from becoming READY.
 */
export const TAGGING_MODEL = '@cf/meta/llama-3.1-8b-instruct'

export const MIN_TAGS = 3
export const MAX_TAGS = 7

/**
 * Type/summary words that restate what the file already is. Dropped unless they
 * are part of a longer, more specific phrase (e.g. "board deck" survives,
 * "presentation" alone does not).
 */
const GENERIC_TAGS = new Set([
  'document', 'documents', 'doc', 'docs', 'file', 'files', 'pdf', 'pdfs',
  'presentation', 'presentations', 'deck', 'decks', 'slides', 'slide', 'ppt',
  'pptx', 'spreadsheet', 'sheet', 'sheets', 'excel', 'xlsx', 'word', 'docx',
  'image', 'images', 'picture', 'photo', 'screenshot', 'html', 'page', 'text',
  'attachment', 'untitled', 'misc', 'other', 'general', 'various', 'content',
  'artifact', 'upload', 'download', 'new', 'final', 'draft', 'copy', 'version',
  'business', 'information', 'data', 'report', 'reports', 'notes', 'note'
])

/**
 * Attribute categories that must never be inferred from content. Matching is on
 * whole words so "gay" does not fire on "Gaylord" and "race" not on "racecar".
 */
const SENSITIVE_TERMS = new Set([
  'religion', 'religious', 'christian', 'catholic', 'protestant', 'muslim',
  'islamic', 'jewish', 'hindu', 'buddhist', 'atheist', 'evangelical',
  'ethnicity', 'ethnic', 'race', 'racial', 'racism', 'caucasian', 'asian',
  'hispanic', 'latino', 'latina', 'black', 'white', 'minority',
  'gay', 'lesbian', 'bisexual', 'transgender', 'queer', 'homosexual',
  'disability', 'disabled', 'handicapped', 'illness', 'disease', 'diagnosis',
  'medical', 'mental', 'therapy', 'depression', 'anxiety', 'hiv', 'aids',
  'cancer', 'diabetes', 'pregnancy', 'pregnant',
  'immigration', 'immigrant', 'refugee', 'citizenship',
  'political', 'politics', 'democrat', 'republican', 'liberal', 'conservative',
  'union', 'activist', 'protest',
  'salary', 'compensation', 'unionmember', 'criminal', 'arrest', 'conviction'
])

export interface TagSuggestion {
  name: string
  /** Which guardrail (if any) shaped this list — surfaced for transparency. */
  reason: string
}

export interface SuggestOutcome {
  suggestions: TagSuggestion[]
  /** Explicit, honest statement of what happened. */
  note: string
  ran: boolean
  model?: string
}

/** Normalize for comparison: lowercase, strip punctuation, collapse spaces. */
function normalizeTag(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isGeneric(normalized: string): boolean {
  if (GENERIC_TAGS.has(normalized)) return true
  // A two-word phrase whose every word is generic ("pdf document") is generic.
  const words = normalized.split(' ').filter(Boolean)
  return words.length > 1 && words.every((w) => GENERIC_TAGS.has(w))
}

function isSensitive(normalized: string): boolean {
  return normalized.split(' ').some((w) => SENSITIVE_TERMS.has(w))
}

/**
 * Apply every guardrail to a raw candidate list. Exported so the tests can
 * exercise the rules directly rather than only through the model.
 */
export function filterSuggestions(raw: string[]): { kept: string[]; dropped: string[] } {
  const kept: string[] = []
  const dropped: string[] = []
  const seen = new Set<string>()

  for (const candidate of raw) {
    const cleaned = String(candidate ?? '')
      .replace(/^[-*\d.\s"'`]+/, '')
      .replace(/["'`]+,?$/, '')
      .trim()
    if (!cleaned) continue

    const normalized = normalizeTag(cleaned)
    if (!normalized) continue
    // 2 chars minimum: one-letter tags are never meaningful.
    if (normalized.replace(/[^a-z0-9]/g, '').length < 2) continue
    if (normalized.length > 40) continue
    if (seen.has(normalized)) continue
    if (isGeneric(normalized) || isSensitive(normalized)) {
      dropped.push(cleaned)
      continue
    }

    seen.add(normalized)
    // Title-case single words from the model's lowercase output for display.
    kept.push(cleaned.length <= 3 ? cleaned.toUpperCase() : cleaned)
    if (kept.length >= MAX_TAGS) break
  }

  return { kept, dropped }
}

/**
 * Why a single manually-entered tag should be refused, if at all.
 *
 * Exported so a manual add path enforces the *same* rules as the suggester
 * instead of re-implementing them: two copies of a guardrail drift, and the
 * one that drifts becomes a hole. Kept deliberately separate from
 * `filterSuggestions` because the two policies differ — a generic word is
 * noise when a model volunteers it, but it is the user's prerogative when they
 * type it themselves. The sensitive-attribute rule applies to both.
 */
export function blockReason(name: string): 'empty' | 'sensitive' | 'too long' | null {
  const cleaned = String(name ?? '').trim()
  if (!cleaned) return 'empty'

  const normalized = normalizeTag(cleaned)
  if (!normalized) return 'empty'
  if (normalized.length > 40) return 'too long'
  if (isSensitive(normalized)) return 'sensitive'

  return null
}

/**
 * Deterministic suggestions when no AI binding is available.
 *
 * Derived from metadata the artifact already carries (title words, type,
 * workspace), which is honest: it is clearly weaker than content-derived
 * tagging, and the note says so. It deliberately does NOT invent subject
 * matter it cannot see.
 */
export function metadataSuggestions(input: {
  title: string
  extension: string | null
  workspaceName: string | null
}): string[] {
  const words = normalizeTag(input.title)
    .split(' ')
    .filter((w) => w.length >= 3 && !GENERIC_TAGS.has(w) && !SENSITIVE_TERMS.has(w))

  const out: string[] = []
  if (words.length >= 2) out.push(words.slice(0, 2).join(' '))
  for (const word of words) {
    if (out.length >= MAX_TAGS) break
    if (!out.includes(word)) out.push(word)
  }
  if (input.workspaceName) {
    const ws = normalizeTag(input.workspaceName)
    if (ws && !out.includes(ws) && !GENERIC_TAGS.has(ws)) out.push(ws)
  }
  return out
}

function parseModelTags(text: string): string[] {
  // Accept a JSON array, a JSON object with a tags key, or a plain list —
  // small models are inconsistent, and rejecting a valid answer over shape
  // would waste the generation.
  const trimmed = text.trim()

  const jsonArray = /\[[\s\S]*\]/.exec(trimmed)
  if (jsonArray) {
    try {
      const parsed = JSON.parse(jsonArray[0])
      if (Array.isArray(parsed)) return parsed.map((v) => String(v))
    } catch {
      /* fall through to line parsing */
    }
  }

  const jsonObject = /\{[\s\S]*\}/.exec(trimmed)
  if (jsonObject) {
    try {
      const parsed = JSON.parse(jsonObject[0]) as { tags?: unknown }
      if (Array.isArray(parsed.tags)) return parsed.tags.map((v) => String(v))
    } catch {
      /* fall through to line parsing */
    }
  }

  return trimmed
    .split(/[\n,;]+/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * Suggest tags for an artifact version.
 *
 * `text` is the extracted text; when it is absent the caller is told the
 * suggestion is metadata-only rather than being handed fabricated topics.
 */
export async function suggestTags(
  env: Pick<Env, 'AI'>,
  input: {
    title: string
    description?: string | null
    extension: string | null
    workspaceName: string | null
    text: string | null
  }
): Promise<SuggestOutcome> {
  const body = (input.text ?? '').slice(0, 6000)

  if (!env.AI) {
    const meta = filterSuggestions(
      metadataSuggestions({
        title: input.title,
        extension: input.extension,
        workspaceName: input.workspaceName
      })
    )
    return {
      suggestions: meta.kept.slice(0, MAX_TAGS).map((name) => ({ name, reason: 'metadata' })),
      note: meta.kept.length
        ? 'Suggested from title and workspace only — content-based tagging needs the AI binding.'
        : 'No AI binding is configured, so no content-based suggestions were generated.',
      ran: false
    }
  }

  if (!body.trim()) {
    const meta = filterSuggestions(
      metadataSuggestions({
        title: input.title,
        extension: input.extension,
        workspaceName: input.workspaceName
      })
    )
    return {
      suggestions: meta.kept.slice(0, MAX_TAGS).map((name) => ({ name, reason: 'metadata' })),
      note: meta.kept.length
        ? 'No text layer was recoverable, so tags were suggested from title and workspace only.'
        : 'No text layer was recoverable, so no tags could be suggested.',
      ran: false
    }
  }

  const prompt =
    `Suggest ${MIN_TAGS} to ${MAX_TAGS} short tags that describe what this document is about, ` +
    `for filing and retrieval.\n\n` +
    `Prefer: subject, customer or company, project, geography, document purpose, domain/topic.\n` +
    `Do NOT suggest the file type or generic words such as document, file, PDF, presentation, report, ` +
    `notes, draft, final — they add nothing.\n` +
    `Do NOT infer personal or sensitive attributes (health, religion, ethnicity, sexuality, politics).\n` +
    `Each tag must be 1–3 words, in lower case.\n\n` +
    `Title: ${input.title}\n` +
    (input.description ? `Description: ${input.description}\n` : '') +
    `File type: ${input.extension ?? 'unknown'}\n\n` +
    `Content (truncated):\n${body}\n\n` +
    `Respond with a JSON array of strings only, for example: ["q3 revenue","board meeting","emea"]`

  try {
    const response = (await env.AI.run(TAGGING_MODEL, {
      messages: [
        {
          role: 'system',
          content:
            'You label business documents. You reply with a JSON array of short tag strings and nothing else.'
        },
        { role: 'user', content: prompt }
      ],
      max_tokens: 200,
      temperature: 0.2
    })) as unknown

    const text = extractModelText(response)
    if (!text) {
      return {
        suggestions: [],
        note: 'The tagging model returned no usable output; no tags were suggested.',
        ran: true,
        model: TAGGING_MODEL
      }
    }

    const { kept, dropped } = filterSuggestions(parseModelTags(text))

    if (kept.length < MIN_TAGS) {
      return {
        suggestions: kept.map((name) => ({ name, reason: 'content' })),
        note:
          `The model produced ${kept.length} usable tag(s), below the ${MIN_TAGS}-tag minimum, so they ` +
          `were offered but not treated as a complete set.` +
          (dropped.length ? ` Filtered out: ${dropped.join(', ')}.` : ''),
        ran: true,
        model: TAGGING_MODEL
      }
    }

    return {
      suggestions: kept.map((name) => ({ name, reason: 'content' })),
      note: dropped.length
        ? `Suggested from document content. ${dropped.length} generic or sensitive candidate(s) were dropped.`
        : 'Suggested from document content.',
      ran: true,
      model: TAGGING_MODEL
    }
  } catch (err) {
    // Never fatal: an artifact is not less valid because tagging failed.
    return {
      suggestions: [],
      note: `Auto-tagging was unavailable (${String(err).slice(0, 120)}), so no tags were suggested.`,
      ran: false,
      model: TAGGING_MODEL
    }
  }
}

/** Workers AI text models variously return { response } or OpenAI-style shapes. */
function extractModelText(response: unknown): string {
  if (typeof response === 'string') return response
  if (!response || typeof response !== 'object') return ''

  const record = response as Record<string, unknown>
  if (typeof record.response === 'string') return record.response

  const choices = record.choices
  if (Array.isArray(choices) && choices.length) {
    const first = choices[0] as { message?: { content?: unknown } }
    const content = first?.message?.content
    if (typeof content === 'string') return content
  }

  return ''
}
