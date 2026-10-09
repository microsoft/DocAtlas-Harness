export type QuoteMatch = { status: 'exact', start: number, end: number } | { status: 'missing' | 'ambiguous' }

/** Whitespace normalization only: never approximate a different quote or guess among repeated occurrences. */
function normalizedOffsets(input: string, pdfTypography = false): { text: string, starts: number[], ends: number[] } {
  const chars: string[] = []
  const starts: number[] = []
  const ends: number[] = []
  for (let offset = 0; offset < input.length; offset++) {
    const char = input[offset]!
    if (/\s/.test(char)) {
      if (chars.length === 0) continue
      if (chars.at(-1) === ' ') { ends[ends.length - 1] = offset + 1; continue }
      chars.push(' ')
    } else {
      // Some PDF extractors insert a layout space before a comma after a word
      // ("MBPP ,"). Never remove numeric/word boundaries or change characters.
      if (pdfTypography && char === ',' && chars.at(-1) === ' ' && /\p{L}/u.test(chars.at(-2) ?? '')) {
        chars.pop(); starts.pop(); ends.pop()
      }
      chars.push(char)
    }
    starts.push(offset)
    ends.push(offset + 1)
  }
  if (chars.at(-1) === ' ') { chars.pop(); starts.pop(); ends.pop() }
  return { text: chars.join(''), starts, ends }
}

export function matchQuote(text: string, quote: string): QuoteMatch {
  return matchNormalized(text, quote, false)
}

/** Original PDF display only; not source selection, an Evidence mutation or fuzzy search. */
export function matchPdfQuote(text: string, quote: string): QuoteMatch {
  return matchNormalized(text, quote, true)
}

function matchNormalized(text: string, quote: string, pdfTypography: boolean): QuoteMatch {
  const normalized = normalizedOffsets(text, pdfTypography)
  const needle = normalizedOffsets(quote, pdfTypography).text
  if (!needle) return { status: 'missing' }
  const start = normalized.text.indexOf(needle)
  if (start < 0) return { status: 'missing' }
  if (normalized.text.indexOf(needle, start + 1) >= 0) return { status: 'ambiguous' }
  return { status: 'exact', start: normalized.starts[start]!, end: normalized.ends[start + needle.length - 1]! }
}

export interface HighlightRect { left: number, top: number, width: number, height: number }

export function relativeRect(rect: { left: number, top: number, width: number, height: number },
  page: { left: number, top: number, width: number, height: number }): HighlightRect | null {
  if (![rect.left, rect.top, rect.width, rect.height, page.left, page.top, page.width, page.height].every(Number.isFinite)) return null
  if (page.width <= 0 || page.height <= 0 || rect.width <= 0 || rect.height <= 0) return null
  const left = (rect.left - page.left) / page.width
  const top = (rect.top - page.top) / page.height
  const width = rect.width / page.width
  const height = rect.height / page.height
  if (left < -0.005 || top < -0.005 || left + width > 1.005 || top + height > 1.005) return null
  return { left: Math.max(0, left), top: Math.max(0, top), width: Math.min(width, 1 - Math.max(0, left)), height: Math.min(height, 1 - Math.max(0, top)) }
}
