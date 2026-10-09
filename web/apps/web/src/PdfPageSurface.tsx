import { memo, useEffect, useRef, useState } from 'react'
import { TextLayer, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist'
import type { PdfQuote } from './PdfReader'
import type { PdfSlot } from './pdf-window'
import { findPdfQuoteRange } from './pdf-text-range'
import { relativeRect, type HighlightRect } from './quote-match'
import { useUi } from './live/locale'

export type PdfFocusStatus = 'none' | 'locating' | 'exact' | 'missing' | 'ambiguous' | 'page-only'
export const PdfPageSurface = memo(function PdfPageSurface({ pdf, documentId, slot, current, focus, navigationId, onRatio, onReady, onFocus, onSelect }: {
  pdf: PDFDocumentProxy, documentId: string, slot: PdfSlot, current: boolean, focus: PdfQuote | null, navigationId: number,
  onRatio(page: number, ratio: number): void, onReady(page: number): void,
  onFocus(page: number, status: PdfFocusStatus, element?: HTMLElement, offset?: number): void, onSelect(quote: PdfQuote): void,
}) {
  const { t } = useUi(), canvas = useRef<HTMLCanvasElement>(null), text = useRef<HTMLDivElement>(null), paper = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false), [error, setError] = useState(false), [hasText, setHasText] = useState(true)
  const [rects, setRects] = useState<HighlightRect[]>([]), [scale, setScale] = useState(1)
  useEffect(() => {
    let gone = false, render: RenderTask | undefined, layer: TextLayer | undefined
    setReady(false); setRects([]); setError(false)
    async function draw() {
      const page = await pdf.getPage(slot.page)
      if (gone || !canvas.current || !text.current) return
      const base = page.getViewport({ scale: 1 }), viewport = page.getViewport({ scale: slot.width / base.width })
      onRatio(slot.page, base.height / base.width); setScale(viewport.scale * viewport.userUnit)
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(4_000_000 / (viewport.width * viewport.height)))
      canvas.current.width = Math.floor(viewport.width * pixelRatio); canvas.current.height = Math.floor(viewport.height * pixelRatio)
      canvas.current.style.width = `${viewport.width}px`; canvas.current.style.height = `${viewport.height}px`
      text.current.replaceChildren()
      render = page.render({ canvas: canvas.current, viewport, transform: [pixelRatio, 0, 0, pixelRatio, 0, 0] })
      // Canvas first: a selectable text layer must not delay the original page's paint.
      const words = page.getTextContent()
      void words.catch(() => {})
      await render.promise
      if (gone) return
      setReady(true); onReady(slot.page)
      const content = await words
      if (gone || !text.current) return
      const usable = content.items.length < 30000 && content.items.some(item => 'str' in item && item.str.trim())
      setHasText(usable)
      if (usable) { layer = new TextLayer({ textContentSource: content, container: text.current, viewport }); await layer.render() }
      if (!gone) setTextReady(value => value + 1)
    }
    void draw().catch(cause => { if (!gone && !(cause instanceof Error && cause.name === 'RenderingCancelledException')) setError(true) })
    return () => { gone = true; render?.cancel(); layer?.cancel() }
  }, [pdf, slot.page, slot.width, onRatio, onReady])
  const [textReady, setTextReady] = useState(0)
  useEffect(() => {
    setRects([])
    if (!ready || !focus || focus.documentId !== documentId || focus.page !== slot.page) return
    if (focus.resolution === 'page-only' || focus.resolution === 'ambiguous') { onFocus(slot.page, focus.resolution); return }
    const frame = requestAnimationFrame(() => {
      if (!text.current || !paper.current) return
      const match = findPdfQuoteRange(text.current, focus.quote)
      if (match.status !== 'exact') { if (textReady) onFocus(slot.page, match.status); return }
      const pageRect = paper.current.getBoundingClientRect()
      const boxes = Array.from(match.range.getClientRects()).filter(rect => rect.width > .5 && rect.height > .5).map(rect => relativeRect(rect, pageRect))
      if (!boxes.length || boxes.some(rect => rect === null)) { onFocus(slot.page, 'missing'); return }
      setRects(boxes as HighlightRect[]); onFocus(slot.page, 'exact', paper.current, boxes[0]!.top * pageRect.height)
    })
    return () => cancelAnimationFrame(frame)
  }, [ready, focus, documentId, slot.page, slot.width, navigationId, textReady, onFocus])
  function select() {
    const selection = window.getSelection()
    if (!selection?.rangeCount || selection.isCollapsed || !text.current || !ready) return
    const range = selection.getRangeAt(0), quote = selection.toString().trim()
    if (!text.current.contains(range.startContainer) || !text.current.contains(range.endContainer) || !quote || quote.length > 2000) return
    onSelect({ documentId, page: slot.page, quote, context: 'selection' })
  }
  return <div className="pdf-page-slot" data-pdf-slot={slot.page} style={{ height: slot.height + 24 }}>
    <div ref={paper} className={`pdf-sheet ${current ? 'pdf-paper' : ''} ${ready ? 'is-ready' : ''}`} tabIndex={-1}
      data-document-id={documentId} data-page={slot.page} data-rendered={ready ? 'true' : 'false'} data-current={current}
      aria-label={t(`Original PDF, page ${slot.page}`, `原始 PDF，第 ${slot.page} 页`)} style={{ width: slot.width, height: slot.height, '--total-scale-factor': String(scale) } as React.CSSProperties}>
      <canvas ref={canvas} aria-label={t(`PDF page ${slot.page}`, `PDF 第 ${slot.page} 页`)} role="img" />
      {!ready && !error && <div className="pdf-page-skeleton" aria-label={t('Rendering page', '正在渲染页面')}><i /><i /><i /><i /><i /></div>}
      {error && <p className="pdf-page-error" role="alert">{t('This page could not be rendered. Reopen the document to retry.', '这一页暂时无法渲染，请重新打开文档重试。')}</p>}
      <div ref={text} className={`textLayer pdf-page-text ${current ? 'pdf-text-layer' : ''}`} onPointerUp={select} onKeyUp={event => { if (event.key === 'Shift') select() }} />
      <div className="evidence-overlay" aria-hidden="true" data-testid="evidence-overlay">{ready && rects.map((rect, index) => <span key={index} className="evidence-highlight" data-testid="evidence-highlight"
        style={{ left: `${rect.left * 100}%`, top: `${rect.top * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }} />)}</div>
      {ready && !hasText && <span className="pdf-no-text">{t('No selectable text on this page', '本页没有可选文字')}</span>}
    </div>
    <div className="pdf-page-number" aria-hidden="true">{slot.page}</div>
  </div>
})
