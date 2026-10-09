import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import type { ProductSubmission, ProductRunState, ProductSelectionProposal, CitationPresentation, ConversationSnapshot, ResearchFocus, ProductReviewFocus } from '@docatlas/contracts'
import { Icon } from '../icons'
import { Drawer } from '../Drawer'
import { LiveClient } from './client'
import { LiveLibrary, type IncomingUpload } from './Library'
import type { PdfReaderSource, PdfQuote } from '../PdfReader'
import { LiveSelections } from './Selections'
import { LiveAnswer, citationReaderTarget } from './Answers'
import { outgoingMessage } from './outgoing-message'
import { OutgoingQuestion } from './OutgoingQuestion'
import { AnswerMarkdown } from './AnswerMarkdown'
import { CompareReaders } from './CompareReaders'
import { ReaderNavigation, type AnswerReturn, type ReaderPane } from './reader-state'
import { LiveNotebook } from './Notebook'
import { LiveHumanResearch, type HumanResearchOpenRequest } from './HumanResearch'
import { LiveLearning, type LearningOpenRequest } from './Learning'
import { learningOwner, learningOwnerKey } from './learning-state'
import { humanResearchOwner, humanResearchOwnerKey, humanResearchFrame, type HumanResearchOwner } from './human-research-state'
import { LivePreferences } from './Preferences'
import { LiveReviews, type ReviewOpenRequest } from './Reviews'
import { LiveContinuity } from './Continuity'
import type { ContinuityOpenRequest, ContinuityTarget } from './continuity-state'
import { LiveNativeControls } from './NativeControls'
import { captureNativeHistoryAnchor, nativeControlIdentity, nativeIdentityKey, restoreNativeHistoryAnchor, type NativeHistoryScrollAnchor } from './native-control-state'
import { historyHeadKey } from './history-state'
import { LocaleSwitch, useUi } from './locale'
import { WorkingIndicator } from './WorkingIndicator'
import { QuestionText } from './QuestionText'
import { LiveQuestionContext } from './QuestionContext'
import type { QuestionContextTarget, QuestionPassage } from '@docatlas/contracts'
import type { MapSummaryAccess } from './MapNodeSummary'
import type { MapResearchAccess } from './map-research'
import { ResearchActions } from './ResearchActions'
import './live.css'
import './reading-experience.css'
import './editorial.css'

const status: Record<ProductRunState, string> = { accepted: '已接收', preparing: '准备中', ready: '排队中', dispatching: '正在提交给 Pi', running: '生成中', cancelling: '正在停止', cancelled: '已停止', completed: '已保存', failed: '执行失败', 'outcome-unknown': '结果未知 · 需要核对' }
const connections = { connecting: '连接中', live: '实时连接', reconnecting: '正在重新同步', offline: '离线 · 当前状态可能不是最新' }

export function isLiveLanding(snapshot: ConversationSnapshot | null, readerOpen: boolean): boolean {
  return !readerOpen && snapshot !== null && !snapshot.history.messages.length && !snapshot.history.hasEarlier
    && !snapshot.runs.some(run => run.receipt.generation === snapshot.binding.generation) && !snapshot.live.length && !snapshot.activity.length && !snapshot.liveIncomplete
}

/** A prior-generation receipt is an execution record, not a message on the selected branch. */
export function unprojectedCurrentRuns(snapshot: ConversationSnapshot | null, submittedUsers: ReadonlySet<string>) {
  return snapshot?.runs.filter(run => run.receipt.generation === snapshot.binding.generation
    && (!run.receipt.checkpoint || !submittedUsers.has(run.receipt.checkpoint.userEntryId))) ?? []
}

export function LiveApp() {
  const { t, notice: uiNotice } = useUi()
  const client = useMemo(() => new LiveClient({ fetch: window.fetch.bind(window), events: url => new EventSource(url), storage: {
    getItem: key => window.sessionStorage.getItem(key), setItem: (key, value) => window.sessionStorage.setItem(key, value),
    removeItem: key => window.sessionStorage.removeItem(key), key: index => window.sessionStorage.key(index), get length() { return window.sessionStorage.length },
  } }), [])
  const state = useSyncExternalStore(client.subscribe, client.state)
  const uploadReady = state.phase === 'ready' && (!state.selected || !!state.snapshot)
  const navigation = useMemo(() => new ReaderNavigation(), [])
  const reading = useSyncExternalStore(navigation.subscribe, navigation.shellState)
  const [mode, setMode] = useState<ProductSubmission['mode']>('prompt')
  const searchOwner = state.actor && state.selected ? JSON.stringify([state.actor.actorId, state.actor.workspaceId, state.selected, state.snapshot?.binding.bindingId, state.snapshot?.binding.generation]) : null
  const [searchChoice, setSearchChoice] = useState<{ owner: string | null, strategy: 'default' | 'fts' | 'tree' | 'combined' }>({ owner: null, strategy: 'default' })
  const searchStrategy = searchChoice.owner === searchOwner ? searchChoice.strategy : 'default'
  const [historyOpen, setHistoryOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false), moreRef = useRef<HTMLDivElement>(null)
  const [welcomeDraft, setWelcomeDraft] = useState(''), [uploadNotice, setUploadNotice] = useState(''), [uploading, setUploading] = useState(false)
  const [incomingUpload, setIncomingUpload] = useState<IncomingUpload | undefined>(), [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null), starting = useRef(false), uploadSequence = useRef(0), dragDepth = useRef(0)
  const consumeUpload = useCallback(() => setIncomingUpload(undefined), [])
  useEffect(() => { setWelcomeDraft(''); setIncomingUpload(undefined); setUploadNotice(''); setUploading(false); setMoreOpen(false) }, [state.phase, state.actor?.actorId, state.actor?.workspaceId])
  useEffect(() => {
    if (!moreOpen) return
    const outside = (event: PointerEvent) => { if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.querySelector('[role=dialog]')) setMoreOpen(false) }
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [moreOpen])
  const [proposed, setProposed] = useState<ProductSelectionProposal | null>(null)
  const [humanRequest, setHumanRequest] = useState<HumanResearchOpenRequest | undefined>(), [legacyNotebookRequest, setLegacyNotebookRequest] = useState<{ id: number, owner: HumanResearchOwner } | undefined>(), [researchAvailable, setResearchAvailable] = useState(false)
  const humanSequence = useRef(0), legacyNotebookSequence = useRef(0)
  const [researchRevision, setResearchRevision] = useState(0)
  const researchChanged = useCallback(() => setResearchRevision(value => value + 1), [])
  const humanAvailability = useCallback((available: boolean) => setResearchAvailable(available), [])
  const [libraryRequest, setLibraryRequest] = useState<{ id: number, pane: ReaderPane } | undefined>()
  const [reviewRequest, setReviewRequest] = useState<ReviewOpenRequest | undefined>()
  const reviewSequence = useRef(0)
  const [continuityRequest, setContinuityRequest] = useState<ContinuityOpenRequest | undefined>()
  const continuitySequence = useRef(0)
  const [learningRequest, setLearningRequest] = useState<LearningOpenRequest | undefined>(), learningSequence = useRef(0)
  const openLearning = () => {
    const owner = learningOwner(state), active = learningOwner(client.state())
    if (owner && active && learningOwnerKey(owner) === learningOwnerKey(active)) setLearningRequest({ id: ++learningSequence.current, owner })
  }
  const continueResearch = (target: ContinuityTarget) => setContinuityRequest({ ...target, id: ++continuitySequence.current })
  const scroll = useRef<HTMLElement>(null), follow = useRef(true), textarea = useRef<HTMLTextAreaElement>(null), librarySequence = useRef(0)
  const historyInteraction = useRef(0), historyLoadSequence = useRef(0), historyAnchor = useRef<{ anchor: NativeHistoryScrollAnchor, serial: number, ready: boolean } | null>(null)
  const [historyRender, setHistoryRender] = useState(0)
  const readingScope = JSON.stringify([state.phase, state.actor?.actorId, state.actor?.workspaceId, state.selected, state.snapshot?.binding.bindingId])
  // Keep the lineage outbox/drawer alive while its own navigation advances the
  // binding. Native setting forms still fence/reset themselves by full identity.
  const nativeControlsScope = JSON.stringify([state.phase, state.actor?.actorId, state.actor?.workspaceId, state.selected])
  const nativeIdentity = nativeControlIdentity(state)
  const historyScope = JSON.stringify([nativeIdentity ? nativeIdentityKey(nativeIdentity) : '', state.history.loaded
    ? historyHeadKey(state.history.head, state.history.selectedHead) : historyHeadKey(state.snapshot?.history.checkpoint, state.snapshot?.history.selectedHead)])
  const historyScopeRef = useRef(historyScope); historyScopeRef.current = historyScope
  const displayedMessages = state.history.loaded ? state.history.messages : state.snapshot?.history.messages ?? []
  const hasEarlier = state.history.loaded ? state.history.hasEarlier : state.snapshot?.history.hasEarlier ?? false
  useEffect(() => { void client.start(); return () => client.dispose() }, [client])
  useEffect(() => { navigation.reset(readingScope); follow.current = true; historyAnchor.current = null; historyLoadSequence.current++; setProposed(null); setHistoryOpen(false); setLibraryRequest(undefined); setReviewRequest(undefined); setContinuityRequest(undefined) }, [navigation, readingScope])
  useEffect(() => { if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight }, [state.snapshot?.cursor.sequence, state.selected])
  useLayoutEffect(() => {
    const pending = historyAnchor.current, container = scroll.current
    if (!pending?.ready || state.history.loading || !container) return
    let observer: ResizeObserver | undefined
    const restore = () => {
      if (historyAnchor.current !== pending || !restoreNativeHistoryAnchor(container, pending.anchor, historyScopeRef.current, historyInteraction.current)) {
        if (historyAnchor.current === pending) historyAnchor.current = null
        observer?.disconnect()
      }
    }
    restore()
    if (historyAnchor.current !== pending) return
    // Citation manifests load after the prepend commit and can change earlier message
    // heights. Keep the same visual anchor through those changes, until user intent.
    observer = new ResizeObserver(restore)
    observer.observe(container)
    for (const entry of container.querySelectorAll<HTMLElement>('[data-message-entry]')) {
      observer.observe(entry)
      if (entry.dataset.messageEntry === pending.anchor.entryId) break
    }
    const release = () => { if (historyAnchor.current === pending) historyAnchor.current = null; observer?.disconnect() }
    const document = container.ownerDocument
    for (const name of ['wheel', 'touchstart', 'pointerdown', 'keydown']) document.addEventListener(name, release, { capture: true, passive: true })
    return () => { observer?.disconnect(); for (const name of ['wheel', 'touchstart', 'pointerdown', 'keydown']) document.removeEventListener(name, release, true) }
  }, [historyRender, displayedMessages, state.history.loading, historyScope])
  const pending = state.snapshot?.runs.filter(run => !['completed', 'failed', 'cancelled', 'outcome-unknown'].includes(run.receipt.state)) ?? []
  const submittedUsers = new Set(displayedMessages.filter(message => message.role === 'user').map(message => message.entryId))
  const outgoing = outgoingMessage(state)
  const unprojected = unprojectedCurrentRuns(state.snapshot, submittedUsers).filter(run => !outgoing || run.receipt.requestHash !== outgoing.requestHash)
  const landing = !outgoing && (!state.selected || isLiveLanding(state.snapshot, reading.visible))
  const composerText = state.request && state.sending ? '' : state.selected ? state.draft : welcomeDraft
  useLayoutEffect(() => {
    const input = textarea.current
    if (input) { input.style.height = '0'; input.style.height = `${Math.min(180, Math.max(landing ? 88 : 48, input.scrollHeight))}px` }
    if (outgoing && follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [composerText, landing, outgoing?.request.idempotencyKey, outgoing?.receipt?.submissionId])
  const loadOutline = useCallback(async (source: PdfReaderSource, offset: number) => {
    const state = client.state(), conversation = state.selected, binding = state.snapshot?.binding
    if (!source.serverRevision || !conversation || !binding) throw new Error('No document context')
    const { documentId, revisionId } = source.serverRevision
    const result = await client.enrichmentRequest(conversation, `documents/${encodeURIComponent(documentId)}/${encodeURIComponent(revisionId)}/tree`, { mode: 'merge', offset })
    if (result.kind !== 'enrichment-tree' || client.state().selected !== conversation || client.state().snapshot?.binding.bindingId !== binding.bindingId || client.state().snapshot?.binding.generation !== binding.generation) throw new Error('Invalid outline')
    return result
  }, [client])
  const summaryAccess = useMemo<MapSummaryAccess | undefined>(() => {
    const value = client.state(), binding = value.snapshot?.binding
    if (!binding || !value.actor || !value.selected) return undefined
    const conversation = value.selected
    return { ownerKey: `docatlas.live.draft.v1:${encodeURIComponent(value.actor.actorId)}:${encodeURIComponent(value.actor.workspaceId)}:@map-summary:${encodeURIComponent(conversation)}:${encodeURIComponent(binding.bindingId)}`,
      request: async (path, body) => {
        if (client.state().selected !== conversation || client.state().snapshot?.binding.bindingId !== binding.bindingId) throw new Error('Summary view changed')
        const result = await client.enrichmentRequest(conversation, path, body)
        if (result.kind !== 'enrichment-job' || client.state().snapshot?.binding.bindingId !== binding.bindingId) throw new Error('Invalid summary job')
        return result
      } }
  }, [client, readingScope])
  const researchAccess = useMemo<MapResearchAccess | undefined>(() => {
    const owner = humanResearchOwner(client.state())
    if (!owner) return undefined
    const conversation = owner.conversationId, key = humanResearchOwnerKey(owner)
    const current = () => { const now = humanResearchOwner(client.state()); return !!now && humanResearchOwnerKey(now) === key }
    const check = () => { if (!current()) throw new Error('Research map view changed') }
    const completeFocus = (intent: ReturnType<ReaderNavigation['begin']>, focus: ResearchFocus | ProductReviewFocus) => {
      check()
      const original = focus.original, id = `${original.documentId}:${original.revisionId}`
      const source: PdfReaderSource = { id, kind: 'server', name: original.name, sha256: original.contentHash, bytes: original.byteLength, pages: original.pageCount,
        serverRevision: { documentId: original.documentId, revisionId: original.revisionId }, url: `/api/conversations/${encodeURIComponent(conversation)}/documents/${encodeURIComponent(original.documentId)}/${encodeURIComponent(original.revisionId)}/original` }
      if (!navigation.complete(intent, source, { documentId: id, page: focus.physicalPage, quote: focus.exactText ?? '', context: focus.kind === 'research-focus' ? 'selection' : 'citation', ...(focus.status !== 'resolved' ? { resolution: focus.status } : {}) })) throw new Error('Research focus was superseded')
      follow.current = false
    }
    return { ownerKey: key, revision: `${researchRevision}:${historyScope}`,
      notes: async (source, cursor) => {
        check(); if (!source.serverRevision) throw new Error('No original source')
        const value = await client.humanResearchOverlay(conversation, { ...humanResearchFrame(owner), kind: 'human-research-overlay-query', source: source.serverRevision,
          view: 'working', recordTypes: ['research-note', 'open-question'], maxItems: 20, maxChars: 6000, ...(cursor ? { cursor } : {}) })
        check(); return value
      },
      reviews: async (source, scopeVersionId) => {
        check()
        let value = await client.reviewWorkspace(conversation, scopeVersionId)
        check()
        const matches = (ref: { documentId: string, revisionId: string }) => ref.documentId === source.serverRevision?.documentId && ref.revisionId === source.serverRevision?.revisionId
        if (!scopeVersionId && !value.evidence.some(matches)) {
          const option = value.scopeOptions.filter(item => item.sourceRefs?.some(matches)).at(-1)
          if (option && option.scopeVersionId !== value.scope?.scopeVersionId) { value = await client.reviewWorkspace(conversation, option.scopeVersionId); check() }
        }
        return value
      },
      openNote: recordId => { if (current()) setHumanRequest({ id: ++humanSequence.current, owner, kind: 'entry', recordId }) },
      openReview: (scopeVersionId, target) => { if (current()) setReviewRequest({ id: ++reviewSequence.current, scopeVersionId, ...target }) },
      focusNote: async (recordId, locatorId) => { check(); const intent = navigation.begin(); try { const value = await client.humanResearchFocus(conversation, recordId, locatorId); completeFocus(intent, value.focus) } catch (error) { navigation.reject(intent); throw error } },
      focusEvidence: async (scopeVersionId, evidenceId) => { check(); const intent = navigation.begin(); try { completeFocus(intent, await client.reviewFocus(conversation, scopeVersionId, evidenceId)) } catch (error) { navigation.reject(intent); throw error } },
    }
  }, [client, navigation, readingScope, researchRevision, historyScope])
  async function prepareConversation(): Promise<string | undefined> {
    const current = client.state()
    if (current.phase !== 'ready' || current.creating || current.sending) return
    if (current.selected) return current.snapshot ? current.selected : undefined
    const draft = welcomeDraft, id = await client.createConversation()
    if (id && client.state().selected === id) { client.setDraft(draft); setWelcomeDraft(''); return id }
  }
  const send = async (event?: FormEvent) => {
    event?.preventDefault()
    if (starting.current || uploading || incomingUpload || proposed || client.state().verifyingSelection) return
    starting.current = true
    try { if (await prepareConversation()) { historyAnchor.current = null; follow.current = true; await client.submit(mode, searchStrategy === 'default' ? undefined : { recipe: 'tree-search.v1', strategy: searchStrategy }) } }
    finally { starting.current = false }
  }
  async function acceptFile(file: File | undefined) {
    if (!file || starting.current || uploading || incomingUpload || state.request || state.sending) return
    if (!uploadReady) { setUploadNotice('正在连接工作区，请在连接完成后重新选择 PDF。'); return }
    if (file.size < 5 || file.size > 26214400 || !/\.pdf$/i.test(file.name)) { setUploadNotice('请选择不超过 25 MB 的 PDF 文件。'); return }
    starting.current = true; setUploadNotice('')
    try {
      const conversationId = await prepareConversation()
      const binding = client.state().snapshot?.binding
      if (conversationId && binding?.conversationId === conversationId) setIncomingUpload({ id: ++uploadSequence.current, conversationId, bindingId: binding.bindingId, generation: binding.generation, file })
    } finally { starting.current = false }
  }
  const focusChat = () => { requestAnimationFrame(() => { textarea.current?.focus({ preventScroll: true });
    if (window.matchMedia('(max-width: 760px)').matches) textarea.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' })
  }) }
  const openLibrary = (pane: ReaderPane) => setLibraryRequest({ id: ++librarySequence.current, pane })
  async function loadEarlierHistory() {
    if (!state.selected || !nativeIdentity || state.history.loading || !scroll.current) return
    const serial = ++historyLoadSequence.current, scope = historyScope
    follow.current = false
    historyAnchor.current = { anchor: captureNativeHistoryAnchor(scroll.current, scope, historyInteraction.current), serial, ready: false }
    try { await client.historyPage(state.selected, { schemaVersion: 1, kind: 'history-page-request', expectedGeneration: nativeIdentity.generation, cursor: state.history.loaded ? state.history.nextCursor : null }) }
    catch { /* The client retains a scoped, truthful read error; never retry a task or a run-receipt cursor. */ }
    finally {
      if (historyAnchor.current?.serial === serial && historyScopeRef.current === scope) { historyAnchor.current.ready = true; setHistoryRender(value => value + 1) }
      else if (historyAnchor.current?.serial === serial) historyAnchor.current = null
    }
  }
  const beginRead = (pane?: ReaderPane) => {
    if (pane) navigation.setCompare(true)
    const intent = navigation.begin(pane)
    return { complete: (source: PdfReaderSource) => navigation.complete(intent, source), reject: () => navigation.reject(intent) }
  }
  const openReader = (source: PdfReaderSource, quote: PdfQuote | null = null) => {
    if (navigation.state().scope !== readingScope || navigation.state().serial !== reading.serial) return
    navigation.complete(navigation.begin(reading.active), source, quote)
  }
  const selectionReady = () => {
    const current = client.state()
    if (current.selected !== state.selected || current.snapshot?.binding.bindingId !== state.snapshot?.binding.bindingId) return
    if (!current.draft.trim()) client.setDraft(t('Explain this selected passage.', '解释这段选中的原文。'))
    focusChat()
  }
  const proposeSelection = (proposal: ProductSelectionProposal) => {
    const current = client.state()
    if (current.request || current.sending || current.verifyingSelection || proposed) return
    const normalized = (text: string) => text.replace(/\s+/gu, ' ').trim()
    const attached = current.selections.some(ticket => ticket.state === 'staged' && Date.parse(ticket.expiresAt) > Date.now() && ticket.items.some(item =>
      item.locator.documentId === proposal.documentId && item.locator.revisionId === proposal.revisionId && item.locator.physicalPage === proposal.physicalPage && normalized(item.text) === normalized(proposal.quote)))
    if (attached) selectionReady(); else setProposed(proposal)
    navigation.showChat(); focusChat()
  }
  const saveResearchSelection = (selection: ProductSelectionProposal) => {
    const owner = humanResearchOwner(client.state())
    if (!owner || !researchAvailable || navigation.state().scope !== readingScope) return
    setHumanRequest({ id: ++humanSequence.current, owner, kind: 'selection', selection: structuredClone(selection) })
  }
  const sourceResearch = (source: ProductSubmission['sourceRefs'][number], physicalPage: number) => {
    const owner = humanResearchOwner(client.state())
    if (owner && navigation.state().scope === readingScope) setHumanRequest({ id: ++humanSequence.current, owner, kind: 'overlay', source: { ...source }, physicalPage })
  }
  const openLegacyNotebook = () => { const owner = humanResearchOwner(client.state()); if (owner) setLegacyNotebookRequest({ id: ++legacyNotebookSequence.current, owner }) }
  const returnToAnswer = (anchor: AnswerReturn) => {
    follow.current = false
    requestAnimationFrame(() => {
      if (!scroll.current) return
      scroll.current.scrollTop = anchor.scrollTop
      const message = [...scroll.current.querySelectorAll<HTMLElement>('[data-message-entry]')].find(item => item.dataset.messageEntry === anchor.messageId)
      message?.scrollIntoView({ block: 'nearest', behavior: 'auto' }); message?.focus({ preventScroll: true })
    })
  }
  async function openCitation(messageId: string, citation: CitationPresentation) {
    const intent = navigation.begin(), conversationId = state.selected!, answer = { messageId, scrollTop: scroll.current?.scrollTop ?? 0 }
    try {
      const result = await client.answerRequest(conversationId, messageId, citation.citationId)
      if (client.state().selected !== conversationId || client.state().phase !== 'ready') return
      if (result.kind !== 'citation-focus') throw new Error('Invalid citation focus')
      const target = citationReaderTarget(conversationId, messageId, citation, result)
      if (navigation.complete(intent, target.source, target.focus, answer)) follow.current = false
    } catch (error) { navigation.reject(intent); throw error }
  }
  async function openQuestionOriginal(target: QuestionContextTarget, passage: QuestionPassage) {
    const intent = navigation.begin(), conversationId = state.selected!, anchor = target.kind === 'message' ? { messageId: target.id, scrollTop: scroll.current?.scrollTop ?? 0 } : undefined
    try {
      const result = await client.questionContextRequest(conversationId, target, passage)
      if (result.kind !== 'question-selection-focus') throw new Error('Invalid selected passage focus')
      const original = result.original, id = `${original.documentId}:${original.revisionId}`
      const source: PdfReaderSource = { id, kind: 'server', name: original.name, sha256: original.contentHash, bytes: original.byteLength, pages: original.pageCount,
        serverRevision: { documentId: original.documentId, revisionId: original.revisionId }, url: `/api/conversations/${encodeURIComponent(conversationId)}/documents/${encodeURIComponent(original.documentId)}/${encodeURIComponent(original.revisionId)}/original` }
      if (navigation.complete(intent, source, { documentId: id, page: result.physicalPage, quote: result.exactText ?? '', context: 'selection', ...(result.status !== 'resolved' ? { resolution: result.status } : {}) }, anchor)) follow.current = false
    } catch (error) { navigation.reject(intent); throw error }
  }
  function openResearch(focus: ResearchFocus | ProductReviewFocus) {
    if (state.phase !== 'ready' || focus.conversationId !== state.selected || navigation.state().scope !== readingScope || navigation.state().serial !== reading.serial) return
    const original = focus.original, id = `${original.documentId}:${original.revisionId}`
    const source: PdfReaderSource = { id, kind: 'server', name: original.name, sha256: original.contentHash, bytes: original.byteLength, pages: original.pageCount,
      serverRevision: { documentId: original.documentId, revisionId: original.revisionId },
      url: `/api/conversations/${encodeURIComponent(focus.conversationId)}/documents/${encodeURIComponent(original.documentId)}/${encodeURIComponent(original.revisionId)}/original` }
    const quote: PdfQuote = { documentId: id, page: focus.physicalPage, quote: focus.exactText ?? '', ...(focus.status !== 'resolved' ? { resolution: focus.status } : {}) }
    navigation.complete(navigation.begin(), source, quote); follow.current = false
  }
  return <div className="demo-app live-app" onDragEnter={event => { if (uploadReady && event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current++; setDragging(true) } }}
    onDragOver={event => { if (state.phase === 'ready' && event.dataTransfer.types.includes('Files')) event.preventDefault() }}
    onDragLeave={event => { if (event.dataTransfer.types.includes('Files') && --dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false) } }}
    onDrop={event => { if (state.phase !== 'ready' || !event.dataTransfer.types.includes('Files')) return; event.preventDefault(); dragDepth.current = 0; setDragging(false)
      if (event.dataTransfer.files.length !== 1) setUploadNotice('请一次添加一份 PDF；可以连续添加多份文档。'); else void acceptFile(event.dataTransfer.files[0]) }}>
    <header className="app-header"><div className="brand-group"><span className="brand"><span className="brand-mark"><Icon name="book" size={22} /></span><strong>DocAtlas</strong></span></div>
      {state.phase === 'ready' && <div className="header-actions">
        <button className="header-action" aria-label={t('New chat', '新对话')} title={t('New chat', '新对话')} disabled={state.creating || state.sending || uploading || !!incomingUpload} onClick={() => void client.createConversation()}><Icon name="plus" size={17} /><span>{t('New chat', '新对话')}</span></button>
        {!reading.visible && (reading.panes.A.location || reading.panes.B.location) && <button className="header-action" onClick={() => navigation.show()}>{t('Continue reading', '继续阅读')}</button>}
        <button className="header-action" aria-haspopup="dialog" aria-expanded={historyOpen} onClick={() => setHistoryOpen(true)}><Icon name="history" size={17} />{t('History', '历史')}</button>
        {state.selected && <ResearchActions><LiveHumanResearch key={`human:${nativeControlsScope}`} client={client} state={state} onFocus={openResearch} onContinue={continueResearch} openRequest={humanRequest} onAvailability={humanAvailability} onLegacy={openLegacyNotebook} onChanged={researchChanged} /><LiveReviews key={`reviews:${readingScope}`} client={client} state={state} onFocus={openResearch} openRequest={reviewRequest} onContinue={continueResearch} onChanged={researchChanged} /></ResearchActions>}
        <LocaleSwitch />
        <div className="live-more" ref={moreRef}><button className="icon-button" aria-label={t('More actions', '更多操作')} aria-expanded={moreOpen} onClick={() => setMoreOpen(value => !value)}><Icon name="more" /></button>
          <div className={`live-more-panel ${moreOpen ? 'is-open' : ''}`} onClick={event => { if ((event.target as Element).closest('button')?.parentElement === event.currentTarget) setMoreOpen(false) }}>
            <label className="live-mode">{t('Document search', '文档检索')}<select aria-label={t('Document search strategy', '文档检索方式')} value={state.request?.documentSearch?.strategy ?? searchStrategy} disabled={state.request !== null || state.sending}
              onChange={event => setSearchChoice({ owner: searchOwner, strategy: event.target.value as typeof searchStrategy })}>
              <option value="default">{t('Default · keyword', '默认 · 关键词')}</option><option value="fts">{t('Keyword only', '仅关键词')}</option><option value="tree">{t('Document tree', '目录树')}</option><option value="combined">{t('Tree + keyword', '目录树 + 关键词')}</option>
            </select><small className="search-mode-hint">{t('Tree search uses a bounded model call. Sources and evidence rules stay unchanged.', '目录树搜索使用有界模型调用，不改变本次资料或证据规则。')}</small></label>
            {state.selected && <><LiveNotebook key={`notebook:${nativeControlsScope}`} client={client} state={state} onFocus={openResearch} onContinue={continueResearch} hideTrigger openRequest={legacyNotebookRequest} /><LivePreferences key={`preferences:${readingScope}`} client={client} state={state} onLearning={openLearning} /><LiveNativeControls key={`native-controls:${nativeControlsScope}`} client={client} state={state} />
              <label className="live-mode">{t('Send mode', '发送方式')}<select aria-label={t('Send mode', '发送方式')} value={state.request?.mode ?? mode} disabled={state.request !== null} onChange={event => setMode(event.target.value as ProductSubmission['mode'])}><option value="prompt">{t('Message', '普通消息')}</option><option value="steer">{t('Steer current task', '插入当前任务')}</option><option value="follow-up">{t('Follow up', '跟进消息')}</option></select></label></>}
            <span className={`live-connection ${state.connection}`}>{t(state.connection, connections[state.connection])}</span><button className="header-action" onClick={() => void client.refresh()}>{t('Refresh status', '刷新状态')}</button>
          </div>
        </div>
      </div>}
    </header>
    {state.phase === 'ready' && state.selected && <LiveContinuity key={`continuity:${readingScope}`} client={client} state={state} openRequest={continuityRequest} onFocus={openResearch} />}
    {state.phase === 'ready' && state.selected && <LiveLearning key={`learning:${nativeControlsScope}`} client={client} state={state} openRequest={learningRequest} onCitation={openCitation} />}
    {state.phase === 'ready' && historyOpen && <Drawer title={t('Chat history', '历史会话')} subtitle={t('Pick up where you left off, or start a new question.', '继续已有研究，或开始一个新的问题。')} onClose={() => setHistoryOpen(false)}><aside className="live-conversations" aria-label={t('Conversations', '会话列表')}>
      <button disabled={state.creating || state.sending} onClick={() => void client.createConversation()}><Icon name="plus" size={16} /><span>{state.creating ? t('Creating…', '正在创建…') : state.creationPending ? t('Retry new chat', '重试新建会话') : t('Create a chat', '新建会话')}</span></button>
      {state.conversations.map((conversation, index) => <button key={conversation.conversationId} aria-current={state.selected === conversation.conversationId ? 'page' : undefined} onClick={() => { setHistoryOpen(false); void client.select(conversation.conversationId) }}><Icon name="chat" size={16} /><span>{t(`Chat ${index + 1}`, `会话 ${index + 1}`)}<small>{new Date(conversation.createdAt).toLocaleDateString()}</small></span></button>)}
      {state.nextConversation && <button onClick={() => void client.loadConversations(state.nextConversation!)}>{t('More conversations', '加载更多会话')}</button>}
      {!state.conversations.length && <p>{t('No conversations yet. Start a new chat.', '还没有会话，开始一个新对话吧。')}</p>}<p className="live-boundary">{t('Your drafts and documents stay with each conversation. Switching never resends a question.', '草稿和来源选择按会话保留，切换不会重新发送问题。')}</p>
    </aside></Drawer>}
    {state.phase !== 'ready' ? <main className="live-connect"><h1>{state.phase === 'loading' ? 'DocAtlas' : t('Unable to connect', '暂时无法连接 DocAtlas')}</h1>
      {state.phase === 'loading' ? <WorkingIndicator label={t('Opening your workspace', '正在打开工作区')} /> : <><p>{t('Start the local service. For remote access, forward port 4177 over SSH.', '请确认本机服务已启动，远程使用时已转发 4177 端口。')}</p><button className="primary-button" onClick={() => void client.start()}>{t('Reconnect', '重新连接')}</button></>}
      {state.error && <p className="live-error" role="alert">{uiNotice(state.error)}</p>}
    </main> : <div className={`workspace live-workspace ${reading.visible ? 'with-reader' : ''} ${reading.visible && reading.compare ? 'with-compare' : ''} ${reading.surface === 'chat' ? 'show-chat' : 'show-reader'}`}><main className={`chat-panel live-chat ${landing ? 'is-landing' : ''}`} data-chat-layout={landing ? 'landing' : 'conversation'}><div className="live-chat-heading">
      {landing ? <><div className="editorial-eyebrow"><span aria-hidden="true" />{t('A workspace for deeper reading', '让理解回到原文')}</div><h1>{t('What would you like to understand?', '这份文档，你想了解什么？')}</h1><p>{t('Bring a document. Ask a question. Follow the evidence.', '带上一份文档，问一个问题，循着出处深入理解。')}</p></> : <h1 className="sr-only">{t('Conversation', '对话')}</h1>}
    </div>
      {state.error && <div className="live-error" role="alert">{uiNotice(state.error)}</div>}
      <section className="live-messages" ref={scroll} aria-label={t('Conversation messages', '会话消息')} aria-busy={state.connection === 'connecting'} onWheel={() => { historyInteraction.current++ }} onTouchStart={() => { historyInteraction.current++ }} onPointerDown={() => { historyInteraction.current++ }} onKeyDown={event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) historyInteraction.current++ }} onScroll={() => { const element = scroll.current!; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80 }}>
        {state.selected && !state.snapshot && <WorkingIndicator label={t('Loading conversation', '正在加载对话')} />}
        {(hasEarlier || state.history.loading) && <button className="text-action live-history-earlier" disabled={state.history.loading || !nativeIdentity} onClick={() => void loadEarlierHistory()}>{state.history.loading ? t('Loading earlier messages…', '正在加载更早消息…') : t('Earlier messages', '加载更早消息')}</button>}
        {state.history.error && <p className="live-notice" role="status">{state.history.error}</p>}
        {displayedMessages.filter(message => message.role === 'user' || message.text.trim()).map(message => {
          const projected = 'displayOrigin' in message, unavailable = message.role === 'user' && (projected ? message.displayOrigin === 'unavailable' : message.text === '')
          return <article className={`live-message ${message.role}`} key={`${state.selected}:${state.snapshot?.binding.bindingId}:${message.entryId}`} data-message-entry={message.entryId} data-message-saved="true" aria-label={message.role === 'user' ? t('Your message', '你的消息') : 'DocAtlas'} tabIndex={-1}>{message.role === 'assistant' && <header className="assistant-signature"><Icon name="book" size={16} /><span>DocAtlas</span></header>}
            {!message.truncated && state.selected && <LiveQuestionContext client={client} conversationId={state.selected} target={{ kind: 'message', id: message.entryId }} version={JSON.stringify([message.text, message.origin])} answer={message.role === 'assistant'} onOriginal={openQuestionOriginal} />}
            {message.role === 'assistant' && !message.truncated && state.selected
            ? <LiveAnswer client={client} conversationId={state.selected} message={message} onCitation={openCitation} /> : <QuestionText text={unavailable ? '这条原始提问正文暂不可核对；未以原生附加上下文替代用户输入。' : message.text} />}{message.truncated && <small>长记录仅显示当前片段，不代表完整内容；引用不启用。</small>}</article>
        })}
        {unprojected.map(run => <article className="live-message user" key={run.receipt.submissionId} data-run-state={run.receipt.state} aria-label={t('Your message', '你的消息')}><LiveQuestionContext client={client} conversationId={state.selected!} target={{ kind: 'submission', id: run.receipt.submissionId }} version={String(run.receipt.version)} onOriginal={openQuestionOriginal} /><QuestionText text={run.text ?? t('This question has not synced yet.', '此条请求正文尚未同步。')} />{['failed', 'cancelled', 'outcome-unknown'].includes(run.receipt.state) && <small>{t(run.receipt.state, status[run.receipt.state])}</small>}</article>)}
        {outgoing && <OutgoingQuestion key={outgoing.request.idempotencyKey} value={outgoing} sending={state.sending} error={!!state.error} onRetry={() => void send()} />}
        {state.snapshot?.live.map(message => <article className="live-message assistant provisional" key={message.messageId}><header className="assistant-signature"><Icon name="book" size={16} /><span>DocAtlas</span></header><LiveQuestionContext client={client} conversationId={state.selected!} target={{ kind: 'submission', id: message.submissionId }} version={String(state.snapshot?.runs.find(run => run.receipt.submissionId === message.submissionId)?.receipt.version)} answer onOriginal={openQuestionOriginal} /><AnswerMarkdown text={message.text} />{message.truncated && <small>{t('Live preview is truncated; the saved answer follows on completion.', '实时预览已达到上限，完成后显示保存的回答。')}</small>}</article>)}
        {pending.length > 0 && <div className="live-thinking"><WorkingIndicator small={!!state.snapshot?.live.some(message => message.text)} /></div>}
        {state.snapshot?.liveIncomplete && <p className="live-notice">{t('Some live updates were missed. The verified saved response is authoritative.', '部分实时更新未完整接收，最终内容以核验后的快照为准。')}</p>}
        {!!state.snapshot?.activity.length && <details className="live-activity"><summary>{t('Behind the answer', '查看处理过程')}</summary><ul>{state.snapshot.activity.map(item => <li key={`${item.submissionId}:${item.toolCallId}`}><code>{item.toolName}</code> · {item.state === 'running' ? t('Running', '运行中') : t('Finished', '本次调用已结束')}</li>)}</ul></details>}
      </section>
      <div className="live-composer-wrap">{state.selected && <LiveSelections key={readingScope} client={client} state={state} proposed={proposed} onAdded={() => setProposed(null)} onReady={selectionReady} onReturn={(source, quote) => openReader(source, quote)} />}
        <div className={`composer live-composer-shell ${landing ? 'composer-landing' : ''} ${state.sourceRefs.length ? 'has-sources' : ''}`}>
        <div className="live-document-tools">
          <input ref={fileInput} type="file" accept="application/pdf,.pdf" aria-label="上传 PDF 文件" hidden disabled={!uploadReady} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void acceptFile(file) }} />
          <button className="live-upload-button" type="button" aria-label={t('Upload PDF', '上传 PDF')} disabled={uploading || !!incomingUpload || state.creating || state.sending || !!state.request || !!state.selected && !state.snapshot} onClick={() => fileInput.current?.click()}>{uploading || incomingUpload || state.creating ? <WorkingIndicator small label={t('Adding document', '正在添加文档')} /> : <Icon name="plus" size={19} />}{t('Upload PDF', '上传 PDF')}</button>
          {state.selected && <LiveLibrary key={readingScope} client={client} state={state} onReadStart={beginRead} openRequest={libraryRequest} onPickFile={() => fileInput.current?.click()} incomingUpload={incomingUpload} onUploadConsumed={consumeUpload} onBusyChange={setUploading} />}
        </div>
        <form className="live-question-form" onSubmit={event => void send(event)}><textarea ref={textarea} aria-label={t('Ask DocAtlas', '向 DocAtlas 提问')} placeholder={state.sourceRefs.length ? t('Ask anything about your documents…', '这份文档，你想了解什么？') : t('Ask a question, or add a PDF…', '问一个问题，或添加一份 PDF…')} value={composerText} maxLength={6000} readOnly={state.request !== null || state.sending} disabled={!!state.selected && !state.snapshot || state.creating} onChange={event => state.selected ? client.setDraft(event.target.value) : setWelcomeDraft(event.target.value)} rows={1}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send() } }} />
        <div className="composer-bottom"><span className="live-input-hint">{mode !== 'prompt' ? <button type="button" className="text-action" onClick={() => setMode('prompt')}>{t('Return to message mode', '恢复普通消息')}</button> : t('Shift + Enter for a new line', 'Shift + Enter 换行')}</span><div className="composer-submit">
          {(pending.length > 0 || state.stopping) && <button type="button" className="send-button stop-button" aria-label={state.stopping ? t('Stopping…', '等待确认停止…') : t('Stop task', '停止任务')} title={t('Stop task', '停止任务')} disabled={state.stopping} onClick={() => void client.stop()}><Icon name="stop" size={17} /></button>}
          <button className="send-button" aria-label={state.sending ? t('Sending…', '发送中…') : state.request ? t('Retry original submission', '使用原提交键重试') : t('Send message', '发送问题')} title={state.request ? t('Retry original submission', '使用原提交键重试') : t('Send message', '发送问题')} disabled={state.sending || state.creating || state.verifyingSelection || !!proposed || uploading || !!incomingUpload || !!state.selected && !state.snapshot || !(state.selected ? state.draft : welcomeDraft).trim()}><Icon name={state.request ? 'history' : 'arrow'} size={20} /></button></div></div>
      </form></div>{uploadNotice && <p className="live-notice" role="status">{uiNotice(uploadNotice)}</p>}
      {state.request && !state.sending && <div className="live-outbox"><span>{t('Submission not yet confirmed. This tab keeps the original request; refreshing will not resend it.', '此请求尚未确认；原文和提交键暂存于此标签页，刷新不会自动重发。')}</span><button onClick={() => { if (window.confirm(t('Clear this local draft? A task already received by the server will not be stopped.', '清除此标签页草稿不会停止服务器可能已接收的任务，仍需核对运行状态。继续清除？'))) client.discard() }} disabled={state.sending}>{t('Clear local draft', '清除本地草稿')}</button></div>}
      <p className="live-footnote">{state.sourceRefs.length ? t(`${state.sourceRefs.length} document${state.sourceRefs.length === 1 ? '' : 's'} attached. Click a citation to see the original.`, `本次提问使用上方 ${state.sourceRefs.length} 份文档 · 点击引用核对原文`) : t('PDF up to 25 MB. You can also drop a file here.', '支持 PDF，最大 25 MB · 也可以将文件拖到这里')}</p>
      {state.connection === 'reconnecting' || state.connection === 'offline' ? <p className="live-notice" role="status">{t(state.connection === 'offline' ? 'Offline. Displayed status may be out of date.' : 'Reconnecting…', connections[state.connection])}</p> : null}</div>
    </main>{(reading.visible || reading.panes.A.location || reading.panes.B.location) && <CompareReaders key={readingScope} navigation={navigation} state={reading} canSelect={!state.request && !state.sending && !state.verifyingSelection && !proposed} onSelect={proposeSelection} onLibrary={openLibrary} onAnswer={returnToAnswer} onChat={focusChat} canSaveResearch={researchAvailable} onSaveResearch={saveResearchSelection} onSourceResearch={sourceResearch} loadOutline={loadOutline} summaryAccess={summaryAccess} researchAccess={researchAccess} />}</div>}
    {dragging && <div className="drop-overlay"><Icon name="upload" size={32} /><h2>{t('Drop your PDF here', '把 PDF 放在这里')}</h2><p>{t('Add to this question · up to 25 MB', '上传后用于本次提问 · 最大 25 MB')}</p></div>}
  </div>
}
