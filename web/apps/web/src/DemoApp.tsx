import { lazy, Suspense, useCallback, useEffect, useReducer, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { Answer, answerText } from './Answer'
import { Drawer } from './Drawer'
import { Icon } from './icons'
import { SplitHandle } from './SplitHandle'
import { CITATIONS, SAMPLE_DOCUMENT, SAMPLE_ID, classifyAnswer, demoReducer, initialDemoState, localPdfError, type ChatMessage, type DemoDocument, type QuoteContext } from './demo-state'

type DrawerName = 'library' | 'notes' | 'preferences' | 'about' | null
const starters = ['总结这份报告', '营收变化说明了什么？', '2026 年有哪些风险？']
const PdfReader = lazy(async () => ({ default: (await import('./PdfReader')).PdfReader }))

export function DemoApp() {
  const [state, dispatch] = useReducer(demoReducer, initialDemoState)
  const [documents, setDocuments] = useState<DemoDocument[]>([SAMPLE_DOCUMENT])
  const [draft, setDraft] = useState('')
  const [drawer, setDrawer] = useState<DrawerName>(null)
  const [readerId, setReaderId] = useState<string | null>(null)
  const [readerPage, setReaderPage] = useState(1)
  const [focus, setFocus] = useState<QuoteContext | null>(null)
  const [selection, setSelection] = useState<QuoteContext | null>(null)
  const [mobileView, setMobileView] = useState<'chat' | 'reader'>('chat')
  const [readerShare, setReaderShare] = useState(58)
  const [notice, setNotice] = useState('')
  const [uploading, setUploading] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const chatScroll = useRef<HTMLDivElement>(null)
  const objectUrls = useRef<string[]>([])
  const fileGeneration = useRef(0)
  const dragDepth = useRef(0)
  const attached = documents.find(document => document.id === state.selectedDocumentId) ?? null
  const source = documents.find(document => document.id === readerId) ?? null
  const isEmpty = state.messages.length === 0 && !state.run
  const isLanding = isEmpty && !source

  useEffect(() => {
    if (!state.run) return
    const id = state.run.id
    const phase = setTimeout(() => dispatch({ type: 'phase', id }), 650)
    const complete = setTimeout(() => dispatch({ type: 'complete', id }), 1450)
    return () => { clearTimeout(phase); clearTimeout(complete) }
  }, [state.run?.id])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 4200)
    return () => clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    chatScroll.current?.scrollTo({ top: chatScroll.current.scrollHeight, behavior: 'auto' })
  }, [state.messages.length, state.run?.phase])

  useEffect(() => () => { for (const url of objectUrls.current) URL.revokeObjectURL(url) }, [])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setDrawer(current => current === 'library' ? null : 'library') }
      if (event.key === 'Escape' && !drawer && selection) { setSelection(null); window.getSelection()?.removeAllRanges() }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [drawer, selection])

  const onPages = useCallback((id: string, pages: number) => {
    setDocuments(previous => previous.map(document => document.id === id && document.pages !== pages ? { ...document, pages } : document))
  }, [])

  function openDocument(id: string, page = 1, quote: QuoteContext | null = null) {
    if (!documents.some(document => document.id === id)) { setNotice('这份来源已移除，请重新选择原始文件。'); return }
    fileGeneration.current++
    setUploading(false)
    setReaderId(id)
    setReaderPage(page)
    setFocus(quote)
    setSelection(null)
    setDrawer(null)
    setMobileView('reader')
    dispatch({ type: 'select-document', documentId: id })
  }

  // A fresh navigation intent also re-centres a citation already open on this page.
  function openQuote(context: QuoteContext) { openDocument(context.documentId, context.page, { ...context }) }

  function submit(text: string, documentOverride: DemoDocument | null = attached) {
    if (!text.trim() || state.run || uploading) return
    if (documentOverride?.id !== state.selectedDocumentId) dispatch({ type: 'select-document', documentId: documentOverride?.id ?? null })
    dispatch({ type: 'submit', id: crypto.randomUUID(), text: text.slice(0, 6000), answer: classifyAnswer(text, documentOverride, state.context) })
    setDraft('')
    setMobileView('chat')
    requestAnimationFrame(() => textarea.current?.focus())
  }

  function handleSubmit(event: FormEvent) { event.preventDefault(); submit(draft) }

  function startNewChat() {
    fileGeneration.current++
    setUploading(false)
    dispatch({ type: 'new-chat' })
    setDraft('')
    setReaderId(null)
    setSelection(null)
    setFocus(null)
    setDrawer(null)
    setMobileView('chat')
    requestAnimationFrame(() => textarea.current?.focus())
  }

  function askSelection(context: QuoteContext) {
    dispatch({ type: 'context', context })
    setFocus(context)
    setSelection(null)
    window.getSelection()?.removeAllRanges()
    setDraft(previous => previous || '这段内容说明了什么？')
    setMobileView('chat')
    requestAnimationFrame(() => textarea.current?.focus())
  }

  function saveNote(context: QuoteContext) {
    dispatch({ type: 'save-note', note: { ...context, id: crypto.randomUUID() } })
    setSelection(null)
    window.getSelection()?.removeAllRanges()
    setNotice('已保存到本次演示的笔记。刷新后会清空。')
  }

  async function copyAnswer(message: ChatMessage) {
    try { await navigator.clipboard.writeText(answerText(message)); setNotice('已复制，内容包含演示标记与来源说明。') }
    catch { setNotice('浏览器未允许复制，请手动选择答案文字。') }
  }

  async function addFile(file: File | undefined) {
    if (!file) return
    const invalid = localPdfError(file)
    if (invalid) { setNotice(invalid); return }
    if (documents.filter(document => document.kind === 'local').length >= 4) { setNotice('本次演示最多同时打开 4 份本地 PDF。'); return }
    const generation = ++fileGeneration.current
    setUploading(true)
    try {
      const bytes = await file.arrayBuffer()
      if (generation !== fileGeneration.current) return
      if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') { setNotice('文件不是有效的 PDF，请重新选择。'); return }
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
      if (generation !== fileGeneration.current) return
      const id = `local:${crypto.randomUUID()}`
      const url = URL.createObjectURL(file)
      objectUrls.current.push(url)
      const document: DemoDocument = { id, url, name: file.name, kind: 'local', sha256: hash, pages: null, bytes: file.size }
      setDocuments(previous => [...previous, document])
      dispatch({ type: 'select-document', documentId: id })
      setReaderId(id)
      setReaderPage(1)
      setFocus(null)
      setSelection(null)
      setDrawer(null)
      setMobileView('reader')
      setNotice('文件仅在浏览器本地打开，没有上传；自动问答尚未接入。')
    } catch { if (generation === fileGeneration.current) setNotice('文件暂时无法打开，请重试。') }
    finally { if (generation === fileGeneration.current) setUploading(false) }
  }

  function removeDocument(document: DemoDocument) {
    if (document.kind === 'sample') return
    URL.revokeObjectURL(document.url)
    objectUrls.current = objectUrls.current.filter(url => url !== document.url)
    setDocuments(previous => previous.filter(item => item.id !== document.id))
    if (readerId === document.id) { setReaderId(null); setFocus(null); setSelection(null) }
    if (state.selectedDocumentId === document.id) dispatch({ type: 'select-document', documentId: null })
  }

  const composer = <form className={`composer ${isLanding ? 'composer-landing' : ''}`} onSubmit={handleSubmit}>
    {state.context && <div className="context-chip"><details key={`${state.context.documentId}:${state.context.page}:${state.context.quote}`}><summary><Icon name="link" size={15} /><span><strong>所选原文 · 第 {state.context.page} 页 <small>仅本次提问</small></strong><span>{state.context.quote}</span></span><Icon name="chevron" size={14} /></summary><div className="context-detail"><span>{documents.find(document => document.id === state.context?.documentId)?.name ?? '来源已移除'}</span><blockquote>{state.context.quote}</blockquote><button type="button" className="text-action" onClick={() => state.context && openQuote(state.context)}>定位这段原文<Icon name="chevron" size={13} /></button></div></details><button type="button" className="icon-button" aria-label="移除选区上下文" onClick={() => dispatch({ type: 'context', context: null })}><Icon name="close" size={14} /></button></div>}
    <textarea ref={textarea} value={draft} onChange={event => setDraft(event.target.value)} maxLength={6000}
      aria-label="向 DocAtlas 提问" placeholder={source ? '对眼前的内容，有什么想继续了解？' : '把问题带进来，或添加一份 PDF…'} rows={isLanding ? 3 : 2}
      onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(draft) } }} />
    <div className="composer-bottom"><div className="composer-tools"><button type="button" className="icon-button add-document" aria-label="添加资料" title="添加资料" onClick={() => setDrawer('library')}><Icon name="plus" size={20} /></button>
      {attached ? <div className="attached-source"><button type="button" onClick={() => openDocument(attached.id)} title={attached.name}><Icon name="file" size={14} /><span>{attached.kind === 'sample' ? 'Widget 年度报告 2025' : attached.name}</span></button><button type="button" aria-label="移除当前提问资料" title="取消当前提问资料" onClick={() => dispatch({ type: 'select-document', documentId: null })}><Icon name="close" size={12} /></button></div>
        : <button type="button" className="composer-hint" onClick={() => setDrawer('library')}>添加资料</button>}</div>
      <div className="composer-submit"><span className="enter-hint">{uploading ? '本地打开中…' : 'Enter 发送'}</span>{state.run ? <button className="send-button stop-button" type="button" aria-label="停止演示回答" onClick={() => dispatch({ type: 'cancel' })}><Icon name="stop" size={18} /></button>
        : <button className="send-button" type="submit" aria-label="发送问题" disabled={!draft.trim() || uploading}><Icon name="arrow" size={20} /></button>}</div>
    </div>
  </form>

  return <div className={`demo-app ${source ? 'has-reader' : ''} mobile-${mobileView}`} onDragEnter={event => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault(); dragDepth.current++; setIsDragging(true)
  }} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }}
    onDragLeave={event => { event.preventDefault(); dragDepth.current--; if (dragDepth.current <= 0) { dragDepth.current = 0; setIsDragging(false) } }}
    onDrop={event => { event.preventDefault(); dragDepth.current = 0; setIsDragging(false); void addFile(event.dataTransfer.files[0]) }}>
    <header className="app-header"><div className="brand-group"><button className="brand" aria-label="DocAtlas，新建对话" onClick={startNewChat}><span className="brand-mark"><Icon name="book" size={22} /></span><span>DocAtlas</span></button><span className="header-divider" /><button className="prototype-badge" onClick={() => setDrawer('about')}>交互原型 <span>01</span></button></div>
      <nav className="header-actions" aria-label="工作区操作"><button className="header-action" aria-label="研究笔记" onClick={() => setDrawer('notes')}><Icon name="note" size={17} /><span>笔记</span>{state.notes.length > 0 && <span className="note-count">{state.notes.length}</span>}</button><button className="header-action" aria-label="资料" onClick={() => setDrawer('library')}><Icon name="file" size={17} /><span>资料</span></button><button className="icon-button preference-button" aria-label="阅读偏好" title="阅读偏好" onClick={() => setDrawer('preferences')}><Icon name="settings" size={19} /></button><button className="icon-button about-button" aria-label="关于这个原型" title="关于这个原型" onClick={() => setDrawer('about')}><Icon name="info" size={18} /></button></nav>
    </header>
    {source && <div className="mobile-switch" role="group" aria-label="工作面切换"><button className={mobileView === 'chat' ? 'active' : ''} onClick={() => setMobileView('chat')}><Icon name="chat" size={15} />对话</button><button className={mobileView === 'reader' ? 'active' : ''} onClick={() => setMobileView('reader')}><Icon name="book" size={15} />原始 PDF</button></div>}
    <main className={`workspace ${isLanding ? 'is-landing' : ''}`} style={{ '--reader-share': readerShare / 100 } as CSSProperties}>
      {source && <div className="reader-workspace" id="original-reader"><Suspense fallback={<div className="pdf-loading" role="status"><span className="spinner" />正在准备阅读器…</div>}><PdfReader source={source} page={readerPage} focus={focus} focusOnLocate={mobileView === 'reader'} onPages={onPages}
        onPage={page => { setReaderPage(page); setFocus(null); setSelection(null); window.getSelection()?.removeAllRanges() }}
        onSelect={setSelection} onClose={() => { setReaderId(null); setFocus(null); setSelection(null); setMobileView('chat') }} onLibrary={() => setDrawer('library')} /></Suspense>
        {selection?.documentId === source.id && selection.page === readerPage && <div className="selection-popover" role="group" aria-label="选区操作" onMouseDown={event => event.preventDefault()}><span className="selection-length">已选 {selection.quote.length} 字</span><button className="selection-ask" onClick={() => askSelection(selection)}><Icon name="chat" size={16} />问这段</button><button onClick={() => saveNote(selection)}><Icon name="note" size={16} />保存笔记</button><button aria-label="取消选区" onClick={() => { setSelection(null); window.getSelection()?.removeAllRanges() }}><Icon name="close" size={14} /></button></div>}
      </div>}
      {source && <SplitHandle value={readerShare} onChange={setReaderShare} />}
      <section className="chat-panel" id="docatlas-chat" aria-label="DocAtlas 对话">
        {!isLanding && <div className="conversation-heading"><div><Icon name="chat" size={16} />{attached ? (attached.kind === 'sample' ? 'Widget 年度报告研究' : '文档对话') : 'DocAtlas 对话'}</div><button className="icon-button" aria-label="新建对话" title="新建对话" onClick={startNewChat}><Icon name="plus" size={18} /></button></div>}
        {isLanding ? <div className="landing-content"><div className="landing-eyebrow"><span />让理解，有据可循</div><h1>从一个好问题开始。</h1><p className="landing-description">读懂文档，也能随时回到原文。</p>{composer}
          <div className="starter-prompts">{starters.map((starter, index) => <button key={starter} onClick={() => submit(starter, SAMPLE_DOCUMENT)}><Icon name={index === 0 ? 'book' : index === 1 ? 'search' : 'chat'} size={15} />{starter}<Icon name="chevron" size={13} /></button>)}</div>
          <button className="sample-invitation" onClick={() => openDocument(SAMPLE_ID)}><span className="sample-pdf-tag">PDF</span><span>先看看示例报告<small>Annual Widget Report 2025 · 6 页</small></span><Icon name="chevron" size={15} /></button>
        </div> : <><div className="chat-scroll" ref={chatScroll}>
          {isEmpty && <div className="reading-empty"><div className="reading-empty-icon"><Icon name="chat" size={25} /></div><h2>边读，边问。</h2><p>选中原文中的一段，<br />把问题问得更具体。</p>{source?.kind === 'sample' && <button className="secondary-button" onClick={() => submit('总结这份报告', SAMPLE_DOCUMENT)}>先给我一个概览<Icon name="chevron" size={14} /></button>}</div>}
          <div className="messages" role="log" aria-label="对话记录" aria-live="polite">{state.messages.map(message => message.role === 'user' ? <article className="user-message" key={message.id}>{message.context && <div className="user-context"><Icon name="link" size={13} />所选原文 · 第 {message.context.page} 页</div>}<p>{message.text}</p></article>
            : <article className="assistant-message" key={message.id}><div className="assistant-label"><span className="mini-brand"><Icon name="book" size={15} /></span><strong>DocAtlas</strong><span className="script-label">示例回答</span></div><Answer message={message} style={state.style} onOpen={openQuote} onOpenDocument={openDocument} />
              {['overview', 'revenue', 'risk'].includes(message.answer ?? '') && <><div className="answer-source-line"><Icon name="file" size={14} /><button onClick={() => openDocument(SAMPLE_ID)}>Widget 年度报告 2025</button><span>·</span><span>预设内容，未调用模型</span></div><div className="answer-actions"><button className="icon-button" aria-label="复制示例回答" title="复制" onClick={() => void copyAnswer(message)}><Icon name="copy" size={16} /></button><button className="text-action" onClick={() => openQuote(CITATIONS[message.answer === 'risk' ? 'risk' : 'revenue']!)}><Icon name="book" size={15} />查看原文</button><button className="text-action" onClick={() => { setDraft('营收变化说明了什么？'); textarea.current?.focus() }}><Icon name="chat" size={15} />继续追问</button></div></>}
              {state.style === 'guided' && message.answer === 'overview' && <button className="personalization-hint" onClick={() => setDrawer('preferences')}><Icon name="settings" size={12} />按你选择的「分点阅读」显示</button>}
            </article>)}</div>
          {state.run && <div className="run-progress" role="status"><span className="run-orbit" /><div><span>{state.run.phase === 'reading' ? '演示：查看资料与问题上下文' : '演示：整理回答与引用'}</span><small>模拟执行 · 未连接 Pi / 模型</small></div><button className="text-action" onClick={() => dispatch({ type: 'cancel' })}>停止</button></div>}
          {!state.run && state.messages.some(message => message.answer === 'overview') && <div className="followup-prompts"><span>接下来，可以继续</span><button onClick={() => submit('营收变化说明了什么？', SAMPLE_DOCUMENT)}>看营收明细<Icon name="chevron" size={13} /></button><button onClick={() => submit('2026 年有哪些风险？', SAMPLE_DOCUMENT)}>核验风险<Icon name="chevron" size={13} /></button></div>}
        </div><div className="chat-composer-wrap">{composer}<p className="composer-disclaimer">回答为演示脚本，引用指向真实示例 PDF。</p></div></>}
      </section>
    </main>
    {isLanding && <footer className="landing-footer"><span>原文可核验，研究可继续。</span><button onClick={() => setDrawer('about')}><span className="demo-status-dot" />演示数据 · 未连接模型</button></footer>}
    <input ref={fileInput} type="file" accept="application/pdf,.pdf" className="visually-hidden" tabIndex={-1} aria-label="选择本地 PDF 文件" onChange={event => { void addFile(event.target.files?.[0]); event.target.value = '' }} />
    {notice && <div className="toast" role="status"><Icon name="info" size={16} />{notice}<button className="icon-button" aria-label="关闭提示" onClick={() => setNotice('')}><Icon name="close" size={13} /></button></div>}
    {isDragging && <div className="drop-overlay"><Icon name="upload" size={32} /><h2>把 PDF 放在这里</h2><p>只在浏览器本地打开 · 最大 25 MB</p></div>}
    {drawer === 'library' && <Drawer title="资料" subtitle="为问题选择一份资料，或直接打开原文。" onClose={() => setDrawer(null)}><button className="upload-area" disabled={uploading} onClick={() => fileInput.current?.click()}><span className="upload-icon"><Icon name="upload" size={22} /></span><strong>{uploading ? '正在本地打开…' : '打开本地 PDF'}</strong><span>选择文件或拖入页面 · 最大 25 MB</span><small>文件留在你的浏览器，不上传服务器</small></button><div className="drawer-section-label">本次演示的资料<span>{documents.length}</span></div><div className="document-list">{documents.map(document => <div className={`document-card ${state.selectedDocumentId === document.id ? 'selected' : ''}`} key={document.id}><button className="document-select" onClick={() => dispatch({ type: 'select-document', documentId: document.id })} aria-pressed={state.selectedDocumentId === document.id}><span className="document-checkbox">{state.selectedDocumentId === document.id && <Icon name="check" size={12} />}</span><span className="pdf-file-icon"><Icon name="file" size={20} /></span><span className="document-card-info"><strong>{document.name}</strong><small>{document.pages ? `${document.pages} 页` : '正在读取页数'} · {document.kind === 'sample' ? '虚构演示资料 · 带示例问答' : '本地文件 · 可阅读与选区'}</small></span></button><div className="document-card-actions"><button className="text-action" onClick={() => openDocument(document.id)}>打开原文<Icon name="chevron" size={13} /></button>{document.kind === 'local' && <button className="icon-button" aria-label={`移除 ${document.name}`} onClick={() => removeDocument(document)}><Icon name="trash" size={14} /></button>}</div></div>)}</div><p className="drawer-footnote">示例回答仅适用于示例报告。自己的 PDF 可真实阅读、选择和摘录，自动理解将在后续接入。</p><button className="primary-button drawer-done" onClick={() => { setDrawer(null); textarea.current?.focus() }}>回到对话<Icon name="chevron" size={15} /></button></Drawer>}
    {drawer === 'notes' && <Drawer title="研究笔记" subtitle="把值得继续思考的原文，留在手边。" onClose={() => setDrawer(null)}>{state.notes.length === 0 ? <div className="notes-empty"><span><Icon name="note" size={30} /></span><h3>从一段原文开始积累</h3><p>打开 PDF，选中内容，点击「保存笔记」。<br />每条笔记都保留返回原文的位置。</p><button className="secondary-button" onClick={() => openDocument(SAMPLE_ID)}>打开示例报告<Icon name="chevron" size={14} /></button></div> : <div className="notes-list">{state.notes.map(note => <article className="note-card" key={note.id}><header><span><Icon name="link" size={13} />原文摘录 · 第 {note.page} 页</span><button className="icon-button" aria-label="删除演示笔记" onClick={() => dispatch({ type: 'remove-note', id: note.id })}><Icon name="trash" size={14} /></button></header><blockquote>{note.quote}</blockquote><button className="text-action" onClick={() => openQuote(note)}>回到原文<Icon name="chevron" size={13} /></button></article>)}</div>}<div className="prototype-note"><Icon name="info" size={16} /><p>笔记仅保存在本次页面中，刷新后清空。长期研究记忆、Claim 与 Review 尚未接入。</p></div></Drawer>}
    {drawer === 'preferences' && <Drawer title="阅读偏好" subtitle="同一份事实，用你更顺手的方式阅读。" onClose={() => setDrawer(null)}><div className="preference-heading"><span>答案排版</span><small>只改变排版，事实与引用保持一致</small></div><label className={`preference-option ${state.style === 'concise' ? 'selected' : ''}`}><input type="radio" name="reading-style" value="concise" checked={state.style === 'concise'} onChange={() => dispatch({ type: 'style', style: 'concise' })} /><span><strong>简洁阅读</strong><small>轻量段落，直接看到重点</small><span className="style-preview concise-preview"><i /><i /><i /></span></span></label><label className={`preference-option ${state.style === 'guided' ? 'selected' : ''}`}><input type="radio" name="reading-style" value="guided" checked={state.style === 'guided'} onChange={() => dispatch({ type: 'style', style: 'guided' })} /><span><strong>分点阅读</strong><small>分组编号，更容易逐项核验</small><span className="style-preview guided-preview"><i /><i /><i /></span></span></label><div className="prototype-note"><Icon name="info" size={16} /><p>这是你主动选择的临时呈现偏好，没有自动学习，也不会写入真实个人记忆。刷新后恢复默认。</p></div><button className="primary-button drawer-done" onClick={() => setDrawer(null)}>完成</button></Drawer>}
    {drawer === 'about' && <Drawer title="关于这个原型" subtitle="先把阅读与交互设计好，再接入完整的 Agent。" onClose={() => setDrawer(null)}><div className="about-brand"><span className="brand-mark"><Icon name="book" size={25} /></span><h3>DocAtlas <span>Prototype 01</span></h3><p>从问题，到原文，再到下一个问题。</p></div><div className="prototype-capabilities"><section><span className="capability-label">真实可操作</span><p>PDF 渲染与翻页、原文字层选区、引用定位与高亮、选区上下文、临时笔记。</p></section><section><span className="capability-label muted">当前为模拟</span><p>示例回答、Agent 阅读进度。没有调用模型、Pi、搜索后端或云服务。</p></section><section><span className="capability-label muted">下一轮设计</span><p>多文档比较、旧研究继续、Claim / Review / Publish、个性化校准与通用代码任务。</p></section></div><div className="prototype-note"><Icon name="info" size={16} /><p>自选文件仅在浏览器读取；草稿、笔记和偏好在刷新后重置。此原型不是正式产品。</p></div></Drawer>}
  </div>
}
