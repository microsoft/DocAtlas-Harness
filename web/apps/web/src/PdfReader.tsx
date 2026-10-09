import { useEffect, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { Icon } from './icons'
import { matchPdfQuote, relativeRect, type HighlightRect } from './quote-match'
import { pdfRestoreIsCurrent, pdfViewIdentity, restoredPdfTop, validPdfView, type PdfViewState } from './pdf-view-state'

GlobalWorkerOptions.workerSrc = workerUrl

export interface PdfReaderSource { id: string, name: string, url: string, kind: 'sample' | 'local' | 'server', sha256: string, pages: number | null, bytes: number, serverRevision?: { documentId: string, revisionId: string } }
export interface PdfQuote { documentId: string, page: number, quote: string, context?: 'citation' | 'selection', resolution?: 'resolved' | 'page-only' | 'ambiguous' }
type QuoteContext = PdfQuote
interface Props {
  source: PdfReaderSource
  page: number
  focus: QuoteContext | null
  focusOnLocate: boolean
  onPage: (page: number) => void
  onPages: (documentId: string, pages: number) => void
  onSelect: (context: QuoteContext) => void
  onClose: () => void
  onLibrary: () => void
  allowSelection?: boolean
  viewState?: PdfViewState
  restoreToken?: { id: number, mode: 'position' | 'focus' }
  onViewState?: (view: PdfViewState) => void
  onInteraction?: () => void
}

function findQuoteRange(layer: HTMLElement, quote: string): { status: 'exact', range: Range } | { status: 'missing' | 'ambiguous' } {
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  const nodes: Array<{ node: Text, start: number, end: number }> = []
  let text = ''
  let current = walker.nextNode()
  while (current) {
    // PDF.js emits its own space runs and BRs. Adding a space between every
    // text node corrupts superscripts, split words and inline punctuation.
    if (current.nodeType !== Node.TEXT_NODE) {
      if (current.nodeName === 'BR') text += '\n'
      current = walker.nextNode(); continue
    }
    const node = current as Text
    if (node.textContent) {
      const start = text.length
      text += node.textContent
      nodes.push({ node, start, end: text.length })
    }
    current = walker.nextNode()
  }
  const match = matchPdfQuote(text, quote)
  if (match.status !== 'exact') return match
  const first = nodes.find(item => item.start <= match.start && item.end > match.start)
  const last = nodes.find(item => item.start < match.end && item.end >= match.end)
  if (!first || !last) return { status: 'missing' }
  const range = document.createRange()
  range.setStart(first.node, match.start - first.start)
  range.setEnd(last.node, match.end - last.start)
  return { status: 'exact', range }
}

export function PdfReader({ source, page, focus, focusOnLocate, onPage, onPages, onSelect, onClose, onLibrary, allowSelection = true, viewState, restoreToken, onViewState, onInteraction }: Props) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState('')
  const [width, setWidth] = useState(600)
  const [zoom, setZoom] = useState(() => validPdfView(viewState, source, page) ? viewState.zoom : 100)
  const [rendered, setRendered] = useState('')
  const [rects, setRects] = useState<HighlightRect[]>([])
  const [focusStatus, setFocusStatus] = useState<'none' | 'locating' | 'exact' | 'missing' | 'ambiguous'>('none')
  const [hasText, setHasText] = useState(true)
  const [dimensions, setDimensions] = useState({ width: 600, height: 776, scale: 1 })
  const scrollRef = useRef<HTMLDivElement>(null)
  const paperRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const loadedIdentity = useRef('')
  const focusedQuote = useRef<QuoteContext | null>(null)
  const viewRef = useRef(viewState); viewRef.current = viewState
  const publishView = useRef(onViewState); publishView.current = onViewState
  const interaction = useRef(0), completedRestore = useRef<number | undefined>(undefined)
  const restoration = useRef<{ key: string, view: PdfViewState, interaction: number, focus: boolean, token: number | undefined } | null>(null)
  const focusResult = useRef<'exact' | 'other'>('other')
  const currentKey = `${source.id}:${page}:${width}:${zoom}`
  const controlledIdentity = pdfViewIdentity(source)

  function emitView() {
    const element = scrollRef.current
    if (element && element.clientHeight > 0 && rendered === currentKey && loadedIdentity.current === source.id) publishView.current?.({ identity: controlledIdentity, page, zoom,
      scrollTop: element.scrollTop, scrollLeft: element.scrollLeft, scrollHeight: element.scrollHeight, viewportHeight: element.clientHeight })
  }
  function userInteracted() { interaction.current++; restoration.current = null; completedRestore.current = restoreToken?.id; onInteraction?.() }

  useEffect(() => {
    const view = viewRef.current
    if (!validPdfView(view, source, page)) { restoration.current = null; return }
    const pendingFocus = restoreToken?.mode === 'focus' && completedRestore.current !== restoreToken.id
    restoration.current = { key: currentKey, view: { ...view }, interaction: interaction.current, focus: pendingFocus, token: restoreToken?.id }
    if (restoreToken?.id !== completedRestore.current && zoom !== view.zoom) setZoom(view.zoom)
  }, [currentKey, controlledIdentity, page, restoreToken?.id, restoreToken?.mode, focusOnLocate])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const observer = new ResizeObserver(entries => {
      const nextWidth = entries[0]?.contentRect.width
      if (nextWidth) setWidth(Math.max(200, Math.floor(nextWidth)))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let loading: ReturnType<typeof getDocument> | null = null
    let disposed = false
    setPdf(null)
    setError('')
    setRendered('')
    setRects([])
    loadedIdentity.current = ''
    async function load() {
      try {
        const response = await fetch(source.url, { credentials: 'same-origin', signal: controller.signal })
        if (!response.ok) throw new Error('无法加载原始 PDF，请重新打开。')
        const stream = response.body?.getReader(), chunks: Uint8Array[] = []; let length = 0
        if (!stream || !Number.isSafeInteger(source.bytes) || source.bytes < 1 || source.bytes > 100 * 1024 * 1024) throw new Error('无法加载原始 PDF，文件大小超出限制。')
        try {
          while (true) { const chunk = await stream.read(); if (chunk.done) break; length += chunk.value.length; if (length > source.bytes) throw new Error('文档内容与当前版本长度不一致。'); chunks.push(chunk.value) }
        } finally { await stream.cancel().catch(() => {}) }
        if (length !== source.bytes) throw new Error('文档内容与当前版本长度不一致。')
        const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
        if (hash !== source.sha256) throw new Error('文档内容与当前版本不一致，已停止显示引用。')
        if (disposed) return
        loading = getDocument({
          data: new Uint8Array(bytes), enableXfa: false, maxImageSize: 20_000_000,
          cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/',
          wasmUrl: '/pdfjs/wasm/', useSystemFonts: true,
        })
        const result = await loading.promise
        if (disposed) return
        loadedIdentity.current = source.id
        setPdf(result)
        onPages(source.id, result.numPages)
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error && cause.name === 'PasswordException'
          ? '这份 PDF 需要密码，请先解锁后再打开。'
          : cause instanceof Error && /文档内容|无法加载/.test(cause.message) ? cause.message : '无法打开这份 PDF，文件可能已损坏或格式不受支持。')
      }
    }
    void load()
    return () => {
      disposed = true
      controller.abort()
      void loading?.destroy().catch(() => undefined)
    }
  }, [source.id, source.url, source.sha256, onPages])

  useEffect(() => {
    if (!pdf || loadedIdentity.current !== source.id) return
    let cancelled = false
    let renderTask: RenderTask | null = null
    let textLayer: TextLayer | null = null
    setRendered('')
    setRects([])
    setError('')
    async function render() {
      try {
        const pdfPage = await pdf!.getPage(Math.max(1, Math.min(page, pdf!.numPages)))
        if (cancelled || !canvasRef.current || !textRef.current) return
        const baseViewport = pdfPage.getViewport({ scale: 1 })
        const viewport = pdfPage.getViewport({ scale: Math.min(width, 880) / baseViewport.width * zoom / 100 })
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(8_000_000 / (viewport.width * viewport.height)))
        const canvas = canvasRef.current
        const layer = textRef.current
        canvas.width = Math.floor(viewport.width * pixelRatio)
        canvas.height = Math.floor(viewport.height * pixelRatio)
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        layer.replaceChildren()
        setDimensions({ width: viewport.width, height: viewport.height, scale: viewport.scale * viewport.userUnit })
        layer.style.setProperty('--total-scale-factor', String(viewport.scale * viewport.userUnit))
        renderTask = pdfPage.render({ canvas, viewport, transform: [pixelRatio, 0, 0, pixelRatio, 0, 0] })
        const textContent = await pdfPage.getTextContent()
        if (cancelled) return
        const usable = textContent.items.length > 0 && textContent.items.length < 30_000
        setHasText(usable)
        if (usable) {
          textLayer = new TextLayer({ textContentSource: textContent, container: layer, viewport })
          await textLayer.render()
        }
        await renderTask.promise
        if (!cancelled) setRendered(currentKey)
      } catch (cause) {
        if (!cancelled && !(cause instanceof Error && cause.name === 'RenderingCancelledException')) setError('这一页暂时无法渲染，请切换页面或重新打开。')
      }
    }
    void render()
    return () => { cancelled = true; renderTask?.cancel(); textLayer?.cancel() }
  }, [pdf, source.id, page, width, zoom, currentKey])

  useEffect(() => {
    setRects([])
    focusResult.current = 'other'
    if (!focus || focus.documentId !== source.id || focus.page !== page) { focusedQuote.current = null; setFocusStatus('none'); return }
    setFocusStatus('locating')
    if (rendered !== currentKey) return
    if (focus.resolution === 'page-only' || focus.resolution === 'ambiguous') { setFocusStatus(focus.resolution === 'ambiguous' ? 'ambiguous' : 'missing'); return }
    const frame = requestAnimationFrame(() => {
      const layer = textRef.current
      const paper = paperRef.current
      if (!layer || !paper) return
      const match = findQuoteRange(layer, focus.quote)
      if (match.status !== 'exact') { setFocusStatus(match.status); return }
      const pageRect = paper.getBoundingClientRect()
      const boxes = Array.from(match.range.getClientRects()).filter(rect => rect.width > 0.5 && rect.height > 0.5)
        .map(rect => relativeRect(rect, pageRect))
      if (!boxes.length || boxes.some(rect => rect === null)) { setFocusStatus('missing'); return }
      setRects(boxes as HighlightRect[])
      setFocusStatus('exact')
      focusResult.current = 'exact'
      const top = boxes[0]!.top * pageRect.height
      const mayNavigate = viewState === undefined || restoration.current?.focus === true && restoration.current.interaction === interaction.current
      if (mayNavigate) scrollRef.current?.scrollTo({ top: Math.max(0, top - 140), behavior: 'auto' })
      // Resizing/zooming re-resolves geometry but must not steal the keyboard
      // from the splitter or the composer after “ask this selection”.
      if (focusedQuote.current !== focus) {
        if (focusOnLocate && mayNavigate) paper.focus({ preventScroll: true })
        focusedQuote.current = focus
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [focus, focusOnLocate, source.id, page, rendered, currentKey, restoreToken?.id])

  useEffect(() => {
    const pending = restoration.current
    if (viewState === undefined || rendered !== currentKey || pending?.key !== currentKey) return
    let second = 0
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => {
      if (restoration.current !== pending || !pdfRestoreIsCurrent(pending.key, currentKey, pending.interaction, interaction.current) || !scrollRef.current) return
      const element = scrollRef.current
      if (element.clientHeight <= 0) return
      if (!pending.focus || focusResult.current !== 'exact') element.scrollTo({ top: restoredPdfTop(pending.view, element.scrollHeight, element.clientHeight), left: pending.view.scrollLeft, behavior: 'auto' })
      completedRestore.current = pending.token; restoration.current = null; emitView()
    }) })
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second) }
  }, [rendered, currentKey, restoreToken?.id, focusOnLocate])

  function captureSelection() {
    const selection = window.getSelection()
    const layer = textRef.current
    if (!selection || !layer || selection.isCollapsed || !selection.rangeCount || rendered !== currentKey) return
    const range = selection.getRangeAt(0)
    if (!layer.contains(range.startContainer) || !layer.contains(range.endContainer)) return
    const quote = selection.toString().trim()
    if (!quote || quote.length > 2000) return
    if (allowSelection) onSelect({ documentId: source.id, page, quote })
  }

  const pageCount = pdf?.numPages ?? source.pages ?? 1
  return <section className="reader-panel" aria-label="原始 PDF 阅读器" onPointerDownCapture={userInteracted} onWheelCapture={userInteracted} onKeyDownCapture={userInteracted}>
    <div className="reader-heading">
      <button className="reader-file-title" onClick={onLibrary} title="切换资料"><span className="pdf-file-icon"><Icon name="file" /></span>
        <span><strong>{source.name}</strong><small>原始 PDF <span>·</span> {source.kind === 'sample' ? '演示资料' : source.kind === 'server' ? '已授权版本 · 核对原件哈希' : '仅在浏览器本地读取'}</small></span>
      </button>
      <button className="icon-button" aria-label="收起原文，返回聊天" title="收起原文" onClick={onClose}><Icon name="close" /></button>
    </div>
    <div className="reader-toolbar">
      <div className="page-controls">
        <button className="icon-button" aria-label="上一页" disabled={page <= 1 || !pdf} onClick={() => onPage(page - 1)}><Icon name="chevron" size={16} style={{ transform: 'rotate(180deg)' }} /></button>
        <span className="page-count" aria-label={`第 ${page} 页，共 ${pageCount} 页`}><b>{page}</b><span>/</span>{pageCount}</span>
        <button className="icon-button" aria-label="下一页" disabled={page >= pageCount || !pdf} onClick={() => onPage(page + 1)}><Icon name="chevron" size={16} /></button>
      </div>
      <div className="zoom-controls"><button className="icon-button" aria-label="缩小 PDF" disabled={zoom <= 75} onClick={() => setZoom(value => value - 25)}><Icon name="minus" size={16} /></button>
        <button className="zoom-value" onClick={() => setZoom(100)} aria-label="恢复适合宽度">{zoom}%</button>
        <button className="icon-button" aria-label="放大 PDF" disabled={zoom >= 175} onClick={() => setZoom(value => value + 25)}><Icon name="plus" size={16} /></button></div>
    </div>
    <div className={`reader-location ${focusStatus === 'exact' ? 'is-exact' : ''}`} role="status" data-focus-status={focusStatus}>
      {focusStatus === 'exact' ? <><span className="highlight-key" />{focus?.context === 'citation' ? '已定位引用原文' : source.kind === 'server' ? '已定位核验选区' : '已定位原文证据'}<span className="location-tip">选中内容，继续追问</span></>
          : focusStatus === 'missing' || focusStatus === 'ambiguous' ? <><Icon name="info" size={14} />{focusStatus === 'ambiguous' ? '本页有多处相同原文，为避免标错，未高亮。' : focus?.resolution === 'page-only'
            ? '已打开引用页；这条出处尚未通过段落定位核验。' : !hasText ? '本页没有可用文字层，暂不能高亮段落。' : '已打开引用页；PDF 文字层与引用文本未精确匹配，暂未高亮。'}</>
          : <><Icon name={focusStatus === 'locating' ? 'search' : 'link'} size={14} />{focusStatus === 'locating' ? '正在原始 PDF 中定位…' : allowSelection ? '在原文中选一段，直接向 DocAtlas 提问' : '已核对原件 · 选区与引用核验尚未接入'}</>}
    </div>
    <div className="pdf-scroll" ref={scrollRef} tabIndex={0} role="region" aria-label="PDF 页面滚动区域" onScroll={emitView}>
      {error ? <div className="reader-error" role="alert"><Icon name="file" size={28} /><h3>原文暂时不可用</h3><p>{error}</p><button className="secondary-button" onClick={onLibrary}>选择其他资料</button></div> : <>
        {!pdf && <div className="pdf-loading" role="status"><span className="spinner" />正在打开原始 PDF…</div>}
        <div className={`pdf-paper ${rendered === currentKey ? 'is-ready' : ''}`} ref={paperRef} tabIndex={-1}
          data-document-id={source.id} data-page={page} data-rendered={rendered === currentKey ? 'true' : 'false'}
          aria-label={`${source.name}，第 ${page} 页`}
          style={{ width: dimensions.width, height: dimensions.height }}>
          <canvas ref={canvasRef} aria-label="原始 PDF 页面" role="img" />
          <div ref={textRef} className="textLayer pdf-text-layer" onPointerUp={captureSelection}
            onKeyUp={event => { if (event.key === 'Shift') captureSelection() }} />
          <div className="evidence-overlay" aria-hidden="true" data-testid="evidence-overlay">
            {rendered === currentKey && focus?.documentId === source.id && focus.page === page && rects.map((rect, index) =>
              <span key={index} className="evidence-highlight" data-testid="evidence-highlight" style={{
                left: `${rect.left * 100}%`, top: `${rect.top * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%`,
              }} />)}
          </div>
        </div>
        {pdf && !hasText && <p className="reader-quality-note">本页没有可用文字层。可以查看原始页，暂不支持选区问答。</p>}
        <p className="pdf-page-footer">{source.kind === 'sample' ? '示例原件' : source.kind === 'server' ? '已授权原件' : '本地原件'} · 第 {page} 页</p>
      </>}
    </div>
  </section>
}
