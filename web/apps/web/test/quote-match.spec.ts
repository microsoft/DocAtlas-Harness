import { describe, expect, it } from 'vitest'
import { matchPdfQuote, matchQuote, relativeRect } from '../src/quote-match'

describe('exact PDF quote and real geometry guard', () => {
  it('normalizes PDF line spacing but returns original character offsets', () => {
    const text = 'Title\n Q4    15.2\r\n +9% \nOther'
    const match = matchQuote(text, 'Q4 15.2 +9%')
    expect(match.status).toBe('exact')
    if (match.status === 'exact') expect(text.slice(match.start, match.end)).toBe('Q4    15.2\r\n +9%')
  })
  it('does not fuzzy-match a different number, case or empty quote', () => {
    expect(matchQuote('Q4 15.2', 'Q4 15.3')).toEqual({ status: 'missing' })
    expect(matchQuote('Q4 15.2', 'q4 15.2')).toEqual({ status: 'missing' })
    expect(matchQuote('Q4 15.2', '   ')).toEqual({ status: 'missing' })
  })
  it('refuses ambiguous and overlapping matches', () => {
    expect(matchQuote('Revenue 15.2\nRevenue 15.2', 'Revenue 15.2')).toEqual({ status: 'ambiguous' })
    expect(matchQuote('aaa', 'aa')).toEqual({ status: 'ambiguous' })
  })
  it('preserves Unicode and punctuation in the source', () => {
    const text = '资料：营收 15.2 百万美元。'
    const match = matchQuote(text, '营收 15.2 百万美元。')
    expect(match).toEqual({ status: 'exact', start: 3, end: text.length })
  })
  it('maps PDF extractor spacing before word commas without changing source offsets', () => {
    const source = 'Title\nHotpotQA, APPS, MBPP , and FEVER.'
    const quote = 'HotpotQA, APPS, MBPP, and FEVER.'
    const result = matchPdfQuote(source, quote)
    expect(result).toEqual({ status: 'exact', start: 6, end: source.length })
    expect(matchPdfQuote(quote, source.slice(6))).toEqual({ status: 'exact', start: 0, end: quote.length })
    expect(matchQuote(source, quote)).toEqual({ status: 'missing' })
  })
  it('keeps numeric/word boundaries, punctuation, case and ambiguity strict in PDF matching', () => {
    for (const [text, quote] of [['1 2%', '12%'], ['1 ,2', '1,2'], ['1.2', '1,2'], ['now here', 'nowhere'], ['BERT36', 'BERT37'], ['BERT36', 'bert36']]) {
      expect(matchPdfQuote(text!, quote!)).toEqual({ status: 'missing' })
    }
    expect(matchPdfQuote('MBPP, and FEVER. MBPP , and FEVER.', 'MBPP, and FEVER.')).toEqual({ status: 'ambiguous' })
  })
  it('converts actual client rectangles into page-relative coordinates', () => {
    expect(relativeRect({ left: 70, top: 130, width: 120, height: 16 }, { left: 10, top: 50, width: 600, height: 800 }))
      .toEqual({ left: .1, top: .1, width: .2, height: .02 })
  })
  it('refuses nonfinite, zero-size and outside-page geometry', () => {
    const page = { left: 0, top: 0, width: 600, height: 800 }
    expect(relativeRect({ left: NaN, top: 5, width: 10, height: 10 }, page)).toBeNull()
    expect(relativeRect({ left: 0, top: 0, width: 0, height: 10 }, page)).toBeNull()
    expect(relativeRect({ left: 590, top: 0, width: 40, height: 10 }, page)).toBeNull()
    expect(relativeRect({ left: 0, top: 0, width: 1, height: 1 }, { ...page, height: 0 })).toBeNull()
  })
})
