import { matchPdfQuote } from './quote-match'

export function findPdfQuoteRange(layer: HTMLElement, quote: string): { status: 'exact', range: Range } | { status: 'missing' | 'ambiguous' } {
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  const nodes: Array<{ node: Text, start: number, end: number }> = []
  let text = '', current = walker.nextNode()
  while (current) {
    if (current.nodeType !== Node.TEXT_NODE) { if (current.nodeName === 'BR') text += '\n'; current = walker.nextNode(); continue }
    const node = current as Text
    if (node.textContent) { const start = text.length; text += node.textContent; nodes.push({ node, start, end: text.length }) }
    current = walker.nextNode()
  }
  const match = matchPdfQuote(text, quote)
  if (match.status !== 'exact') return match
  const first = nodes.find(item => item.start <= match.start && item.end > match.start)
  const last = nodes.find(item => item.start < match.end && item.end >= match.end)
  if (!first || !last) return { status: 'missing' }
  const range = document.createRange()
  range.setStart(first.node, match.start - first.start); range.setEnd(last.node, match.end - last.start)
  return { status: 'exact', range }
}
