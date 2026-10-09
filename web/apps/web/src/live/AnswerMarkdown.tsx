import { memo, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AnswerBlock, AnswerSegment } from '@docatlas/contracts'

/** Presentation coordinates only. These links are inserted by us, never taken from model text. */
interface Span { end: number, href: string, segment: AnswerSegment }

function escapedLabel(text: string): string {
  return text.replace(/[\\`*_{}[\]()<>!#|~&]/g, '\\$&').replace(/\r?\n/g, ' ')
}

export const AnswerMarkdown = memo(function AnswerMarkdown({ text, block, renderSegment }: {
  text?: string, block?: AnswerBlock, renderSegment?(segment: AnswerSegment, content: ReactNode): ReactNode,
}) {
  const spans = new Map<number, Span>()
  let markdown = text ?? ''
  if (block) {
    markdown = ''
    for (const segment of block.segments) {
      if (segment.kind === 'unclassified') { markdown += segment.text; continue }
      const start = markdown.length, href = `#docatlas-presentation-${spans.size}`
      markdown += `[${escapedLabel(segment.text)}](${href})`
      spans.set(start, { end: markdown.length, href, segment })
    }
  }
  return <div className="live-markdown"><Markdown remarkPlugins={[remarkGfm]} components={{
    a({ node, children }) {
      const span = spans.get(node?.position?.start.offset ?? -1)
      // An identical raw/encoded model link elsewhere cannot acquire a manifest binding.
      if (span && node?.position?.end.offset === span.end && node.properties.href === span.href && renderSegment) {
        return <>{renderSegment(span.segment, children)}</>
      }
      return <>{children}</>
    },
    // Model-supplied images must not issue requests or leak conversation text.
    img({ alt }) { return <span>{alt ? `[图片：${alt}]` : '[图片]'}</span> },
    table({ children }) { return <div className="live-markdown-table"><table>{children}</table></div> },
  }}>{markdown}</Markdown></div>
})
