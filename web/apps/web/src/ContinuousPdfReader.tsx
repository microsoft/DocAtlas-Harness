import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PdfReaderSource, PdfQuote } from './PdfReader'
import { pdfViewIdentity, type PdfViewState } from './pdf-view-state'
import { pageAt, pdfSlots, windowPages } from './pdf-window'
import { PdfPageSurface, type PdfFocusStatus } from './PdfPageSurface'
import { Icon } from './icons'
import { DocumentOutline, type OutlineLoader } from './live/DocumentOutline'
import { useDocumentTree } from './live/document-tree'
import { useUi } from './live/locale'
import { WorkingIndicator } from './live/WorkingIndicator'
import type { MapSummaryAccess } from './live/MapNodeSummary'
import type { MapResearchAccess } from './live/map-research'
import './continuous-reader.css'

GlobalWorkerOptions.workerSrc = workerUrl
const DocumentMap = lazy(async () => ({ default: (await import('./live/DocumentMap')).DocumentMap }))

export function ContinuousPdfReader({ source, page, focus, focusOnLocate, onPage, onPages, onSelect, onClose, onLibrary, allowSelection = true,
  viewState, restoreToken, onViewState, onInteraction, loadOutline, summaryAccess, researchAccess }: {
  source: PdfReaderSource, page: number, focus: PdfQuote | null, focusOnLocate: boolean,
  onPage(page: number, scrolled?: boolean): void, onPages(id: string, pages: number): void, onSelect(quote: PdfQuote): void, onClose(): void, onLibrary(): void,
  allowSelection?: boolean, viewState?: PdfViewState, restoreToken?: { id: number, mode: 'position' | 'focus' }, onViewState?(view: PdfViewState): void,
  onInteraction?(): void, loadOutline?: OutlineLoader | undefined,
  summaryAccess?: MapSummaryAccess | undefined,
  researchAccess?: MapResearchAccess | undefined,
}) {
  const { t } = useUi(), [pdf, setPdf] = useState<PDFDocumentProxy | null>(null), [error, setError] = useState(false), [outline, setOutline] = useState(false)
  const [mapOpen, setMapOpen] = useState(false)
  const tree = useDocumentTree(source, loadOutline, outline || mapOpen)
  const [zoom, setZoom] = useState(viewState?.zoom ?? 100), [width, setWidth] = useState(640), [ratios, setRatios] = useState<Map<number, number>>(new Map())
  const [position, setPosition] = useState({ top: 0, height: 900 }), [status, setStatus] = useState<PdfFocusStatus>('none'), [painted, setPainted] = useState(false)
  const [pageInput, setPageInput] = useState(String(page)), scroll = useRef<HTMLDivElement>(null), frame = useRef(0), start = useRef(0), firstPaint = useRef(0)
  const current = useRef({ page, onPage, onViewState, onInteraction, focusOnLocate, viewState, onSelect, allowSelection }); current.current = { page, onPage, onViewState, onInteraction, focusOnLocate, viewState, onSelect, allowSelection }
  const identity = pdfViewIdentity(source), count = pdf?.numPages ?? source.pages ?? 1
  useEffect(() => { setMapOpen(false); setOutline(false) }, [identity])
  const slots = useMemo(() => pdfSlots(count, width, zoom, ratios), [count, width, zoom, ratios])
  const layout = useRef(slots); layout.current = slots
  const pending = useRef<{ id: number, page: number, focus: boolean } | null>(null), completed = useRef(-1), userScroll = useRef(false)
  const lastSeen = useRef(page), lastIdentity = useRef(identity)
  const navigationId = restoreToken?.id ?? page
  const visible = windowPages(slots, position.top, position.height)
  useEffect(() => { setPageInput(String(page)) }, [page])
  useEffect(() => {
    const controller = new AbortController(); let task: ReturnType<typeof getDocument> | null = null, gone = false
    setPdf(null); setPainted(false); setError(false); setRatios(new Map()); completed.current = -1; firstPaint.current = 0; start.current = performance.now()
    async function load() {
      const response = await fetch(source.url, { credentials: 'same-origin', signal: controller.signal })
      if (!response.ok || source.bytes < 1 || source.bytes > 100 * 1024 * 1024) throw new Error('Original unavailable')
      const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let length = 0
      if (!reader) throw new Error('No original bytes')
      try { while (true) { const item = await reader.read(); if (item.done) break; length += item.value.length; if (length > source.bytes) throw new Error('Original size changed'); chunks.push(item.value) } }
      finally { await reader.cancel().catch(() => {}) }
      if (length !== source.bytes) throw new Error('Original size changed')
      const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
      if (hash !== source.sha256) throw new Error('Original hash changed')
      if (gone) return
      task = getDocument({ data: bytes, enableXfa: false, maxImageSize: 20_000_000, cMapUrl: '/pdfjs/cmaps/', cMapPacked: true,
        standardFontDataUrl: '/pdfjs/standard_fonts/', wasmUrl: '/pdfjs/wasm/', useSystemFonts: true })
      const doc = await task.promise
      if (gone) return
      const first = await doc.getPage(1), viewport = first.getViewport({ scale: 1 })
      if (gone) return
      setRatios(new Map([[1, viewport.height / viewport.width]])); setPdf(doc); onPages(source.id, doc.numPages)
    }
    void load().catch(() => { if (!gone) setError(true) })
    return () => { gone = true; controller.abort(); void task?.destroy().catch(() => {}) }
  }, [source.id, source.url, source.sha256, source.bytes, onPages])
  useEffect(() => {
    if (!scroll.current) return
    const observer = new ResizeObserver(entries => { const box = entries[0]?.contentRect; if (box && box.width > 0) { setWidth(Math.floor(box.width)); setPosition(old => ({ ...old, height: box.height })) } })
    observer.observe(scroll.current); return () => observer.disconnect()
  }, [])
  useEffect(() => () => cancelAnimationFrame(frame.current), [])
  const onRatio = useCallback((number: number, ratio: number) => setRatios(old => Math.abs((old.get(number) ?? 0) - ratio) < .0001 ? old : new Map(old).set(number, ratio)), [])
  const onReady = useCallback((number: number) => { if (number === current.current.page) { setPainted(true); if (!firstPaint.current) firstPaint.current = Math.round(performance.now() - start.current) } }, [])
  const onFocus = useCallback((number: number, result: PdfFocusStatus, element?: HTMLElement, offset = 0) => {
    setStatus(result)
    if (result !== 'exact' || !element || !scroll.current || !pending.current?.focus || pending.current.page !== number) return
    const top = element.getBoundingClientRect().top - scroll.current.getBoundingClientRect().top + scroll.current.scrollTop + offset
    scroll.current.scrollTo({ top: Math.max(0, top - 110), behavior: 'auto' })
    if (current.current.focusOnLocate) element.focus({ preventScroll: true })
    pending.current = null
  }, [])
  useLayoutEffect(() => {
    if (!pdf || !scroll.current) return
    const changed = lastIdentity.current !== identity || completed.current !== navigationId
    if (changed) {
      lastIdentity.current = identity; completed.current = navigationId
      pending.current = { id: navigationId, page, focus: restoreToken?.mode === 'focus' && !!focus }
      const view = current.current.viewState
      if (view && view.zoom !== zoom) setZoom(view.zoom)
      const top = view?.layout === 'continuous' && view.scrollHeight > 0 && restoreToken?.mode !== 'focus'
        ? view.scrollTop : slots[page - 1]?.top ?? 0
      scroll.current.scrollTo({ top, left: view?.scrollLeft ?? 0, behavior: 'auto' }); userScroll.current = false
      setPosition({ top, height: scroll.current.clientHeight }); lastSeen.current = page
      setStatus(focus ? 'locating' : 'none')
    }
  }, [pdf, identity, navigationId, page, slots, restoreToken?.mode, focus])
  // Resize/zoom preserve page-local position, not a proportional position in another page.
  const previousLayout = useRef(slots)
  useLayoutEffect(() => {
    const old = previousLayout.current; previousLayout.current = slots
    if (!pdf || !scroll.current || old === slots || lastIdentity.current !== identity) return
    const number = current.current.page, before = old[number - 1], after = slots[number - 1]
    if (!before || !after || !before.height) return
    const fraction = Math.max(0, (scroll.current.scrollTop - before.top) / before.height)
    const top = after.top + fraction * after.height
    scroll.current.scrollTop = top; setPosition({ top, height: scroll.current.clientHeight })
  }, [slots, pdf, identity])
  function interacted() { userScroll.current = true; pending.current = null; current.current.onInteraction?.() }
  function scrolled() {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0; const element = scroll.current; if (!element || !pdf) return
      const number = pageAt(layout.current, element.scrollTop + Math.min(120, element.clientHeight * .2))
      setPosition({ top: element.scrollTop, height: element.clientHeight })
      if (number !== lastSeen.current && userScroll.current) { lastSeen.current = number; current.current.onPage(number, true) }
      current.current.onViewState?.({ identity, page: userScroll.current ? number : current.current.page, zoom, layout: 'continuous',
        scrollTop: element.scrollTop, scrollLeft: element.scrollLeft, scrollHeight: element.scrollHeight, viewportHeight: element.clientHeight })
    })
  }
  function jump(number: number) { if (Number.isInteger(number) && number >= 1 && number <= count) { userScroll.current = false; onPage(number) } else setPageInput(String(page)) }
  const selected = useCallback((quote: PdfQuote) => { const value = current.current; if (!value.allowSelection) return; value.onPage(quote.page, true); value.onSelect(quote) }, [])
  return <section className="reader-panel continuous-reader" aria-label={t('Original PDF reader', '原始 PDF 阅读器')} data-pdf-paint-ms={firstPaint.current || undefined}>
    <div className="reader-heading"><button className="reader-file-title" onClick={onLibrary} title={source.name}><Icon name="file" size={17} /><span><strong>{source.name}</strong><small>{t('Original PDF', '原始 PDF')}</small></span></button>
      <button className="icon-button" aria-label={t('Close PDF and return to chat', '收起原文，返回聊天')} title={t('Close PDF', '收起原文')} onClick={onClose}><Icon name="close" size={17} /></button></div>
    <div className="reader-toolbar"><div className="page-controls">
      {loadOutline && <button className="icon-button outline-button" aria-label={t('Document contents', '文档目录')} title={t('Contents', '目录')} aria-expanded={outline} onClick={() => setOutline(value => !value)}><Icon name="note" size={16} /></button>}
      {loadOutline && <button className="reader-map-button" aria-haspopup="dialog" onClick={() => setMapOpen(true)}><Icon name="map" size={15} />{t('Map', '地图')}</button>}
      <button className="icon-button" aria-label={t('Previous page', '上一页')} disabled={!pdf || page <= 1} onClick={() => jump(page - 1)}><Icon name="chevron" size={14} style={{ transform: 'rotate(180deg)' }} /></button>
      <label className="continuous-page-number"><input aria-label={t('Page number', '页码')} inputMode="numeric" value={pageInput} onChange={event => setPageInput(event.target.value)} onBlur={() => { if (Number(pageInput) !== page) jump(Number(pageInput)) }} onKeyDown={event => { if (event.key === 'Enter') { jump(Number(pageInput)); event.currentTarget.blur() } }} /><span>/ {count}</span></label>
      <button className="icon-button" aria-label={t('Next page', '下一页')} disabled={!pdf || page >= count} onClick={() => jump(page + 1)}><Icon name="chevron" size={14} /></button></div>
      <div className="zoom-controls"><button className="icon-button" aria-label={t('Zoom out', '缩小 PDF')} disabled={zoom <= 75} onClick={() => setZoom(value => value - 25)}><Icon name="minus" size={15} /></button>
        <button className="zoom-value" aria-label={t('Fit to width', '恢复适合宽度')} onClick={() => setZoom(100)}>{zoom}%</button><button className="icon-button" aria-label={t('Zoom in', '放大 PDF')} disabled={zoom >= 175} onClick={() => setZoom(value => value + 25)}><Icon name="plus" size={15} /></button></div></div>
    {focus?.page === page && <div className={`reader-location ${status === 'exact' ? 'is-exact' : ''}`} role="status" data-focus-status={status}>
      {status === 'exact' ? <><span className="highlight-key" />{t('Source highlighted', focus.context === 'citation' ? '已定位引用原文' : '已定位核验选区')}</> : status === 'locating' ? <><WorkingIndicator small />{t('Locating source…', '正在定位原文…')}</>
        : status === 'ambiguous' ? t('Repeated text on this page; no highlight was guessed.', '本页有重复原文，未猜测高亮位置。') : status === 'page-only' ? t('Page located; paragraph position is unverified.', '已打开引用页；段落位置尚未核验。') : t('Page located; the PDF text layer does not match exactly.', '已打开引用页；文字层暂未精确匹配。')}</div>}
    <div className="continuous-reader-body">{outline && loadOutline && <DocumentOutline key={identity} tree={tree} page={page} onMap={() => setMapOpen(true)} onPage={jump} onClose={() => setOutline(false)} />}
      <div ref={scroll} className="pdf-scroll continuous-pdf-scroll" tabIndex={0} role="region" aria-label={t('PDF document scrolling area', 'PDF 页面滚动区域')}
        onScroll={scrolled} onWheel={interacted} onPointerDown={interacted} onKeyDown={interacted}>
        {error ? <div className="reader-error" role="alert"><Icon name="file" size={28} /><h3>{t('Unable to open this original', '原件暂时无法打开')}</h3><p>{t('Check the file and permissions, then reopen it from your library.', '请核对文件与权限，再从资料中重新打开。')}</p><button onClick={onLibrary}>{t('Open library', '打开资料')}</button></div>
          : <>{!painted && <div className="pdf-loading-status"><WorkingIndicator small label={t('Opening original PDF', '正在打开原始 PDF')} /><span>{t('Opening PDF', '打开原文中')}</span></div>}
            <div className="pdf-page-spacer" style={{ height: visible[0]?.top ?? 0 }} aria-hidden="true" />
            {pdf ? visible.map(slot => <PdfPageSurface key={`${source.sha256}:${slot.page}`} pdf={pdf} documentId={source.id} slot={slot} current={slot.page === page}
              focus={focus?.page === slot.page ? focus : null} navigationId={navigationId} onRatio={onRatio} onReady={onReady} onFocus={onFocus} onSelect={selected} />)
              : <div className="pdf-page-skeleton initial-skeleton" style={{ height: 720 }}><i /><i /><i /><i /><i /></div>}
            <div className="pdf-page-spacer" style={{ height: Math.max(0, (slots.at(-1)?.top ?? 0) + (slots.at(-1)?.height ?? 0) + 24 - ((visible.at(-1)?.top ?? 0) + (visible.at(-1)?.height ?? 0) + 24)) }} aria-hidden="true" />
          </>}
      </div>
    </div>
    {mapOpen && <Suspense fallback={<div className="map-module-loading" role="status"><WorkingIndicator small />{t('Opening map…', '正在打开地图…')}<button onClick={() => setMapOpen(false)}>{t('Cancel', '取消')}</button></div>}><DocumentMap key={identity} source={source} tree={tree} page={page} onPage={jump} onClose={() => setMapOpen(false)} summaryAccess={summaryAccess} researchAccess={researchAccess} /></Suspense>}
  </section>
}
