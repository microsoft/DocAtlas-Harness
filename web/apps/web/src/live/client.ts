import type { ConversationSnapshot, ConversationObservation, ProductBinding, ProductSubmission, ProductRunReceipt, ProductSelectionTicket, ProductResearchValue, ProductPersonalizationValue, ProductPreferenceCommand, ProductPersonalizationV2Value, ProductPreferenceCommandV2, ProductReviewCommand, ProductReviewWorkspace, ProductReviewResult, ProductReviewFocus } from '@docatlas/contracts'
import { parseBrowserContract } from '@docatlas/contracts/browser'
import type { ProductRevisionHistory, ProductRevisionImport, ProductRevisionImportState } from '@docatlas/contracts'
import type { ProductContinuityAssess, ProductContinuityAssessment, ProductContinuityImpact, ProductContinuityImpactResult,
  ProductContinuityInspect, ProductContinuityInspection } from '@docatlas/contracts'
import type { ProductProbeChoose, ProductProbeChoiceResult, ProductProbeInspect, ProductProbePrepare, ProductProbeReview, ProductProbeReviewResult, ProductProbeView } from '@docatlas/contracts'
import type { NativeConversationMessage, ProductNativeCommand, ProductNativeInspection, ProductNativeOperation, ProductHistoryRequest, ProductHistoryPage } from '@docatlas/contracts'
import type { ProductLineageCommand, ProductLineageInspection, ProductLineageOperation, ProductNativeTreeRequest, ProductNativeTreePage } from '@docatlas/contracts'
import type { HumanResearchCommand, HumanResearchEntry, HumanResearchFocus, HumanResearchOperation, HumanResearchOverlay, HumanResearchOverlayQuery, HumanResearchQuery, HumanResearchWorkspace } from '@docatlas/contracts'
import type { ProductLearningCommand, ProductLearningOperation, ProductLearningQuery, ProductLearningView } from '@docatlas/contracts'
import { personalizationCommandIssues } from '@docatlas/contracts'
import type { QuestionContext, QuestionContextTarget, QuestionSelectionFocus } from '@docatlas/contracts'
import { checkedProbeView } from './probe-state'
import { checkedLineageInspection, checkedLineageOperation, lineageBindingMatches } from './lineage-state'
import { nativeControlIdentity } from './native-control-state'
import { humanResearchBinding, humanResearchOwner, humanResearchReceiptMatches } from './human-research-state'
import { checkedLearningView, learningBinding, learningOperationId, learningOwner, sha256Text } from './learning-state'
import { applyObservation, canonicalHash, parseDraft, submissionHash } from './state'
import { emptyHistory, historyHeadKey, historyOriginKey, historyTextHash, mergeHistory, type LiveHistory } from './history-state'
import type { OutgoingMessage } from './outgoing-message'

type Actor = { actorId: string, workspaceId: string }
export interface LiveState {
  phase: 'loading' | 'pairing' | 'ready', actor: Actor | null, conversations: ProductBinding[], nextConversation: string | null,
  selected: string | null, snapshot: ConversationSnapshot | null, connection: 'connecting' | 'live' | 'reconnecting' | 'offline',
  history: LiveHistory,
  outgoing?: OutgoingMessage | null,
  draft: string, sourceRefs: ProductSubmission['sourceRefs'], selections: ProductSelectionTicket[], verifyingSelection: boolean, request: ProductSubmission | null, sending: boolean, stopping: boolean, creating: boolean, creationPending: boolean, error: string
}
export interface EventStream { addEventListener(name: string, callback: EventListener): void, close(): void, onerror: ((event: Event) => void) | null, onopen: ((event: Event) => void) | null }
export interface LiveTransport { fetch: typeof fetch, events(url: string): EventStream, storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'> }
const initial = (): LiveState => ({ phase: 'loading', actor: null, conversations: [], nextConversation: null, selected: null, snapshot: null, history: emptyHistory(), connection: 'connecting', draft: '', sourceRefs: [], selections: [], verifyingSelection: false, request: null, sending: false, stopping: false, creating: false, creationPending: false, error: '' })
class RequestError extends Error { constructor(readonly status: number) { super(status === 401 ? '连接已失效，请重新连接服务。' : status === 409 ? '会话版本或提交发生冲突，请刷新并核对原请求。' : status === 413 ? '已达到服务容量上限，请稍后重试。' : '服务未确认本次操作，请稍后重试。') } }

export class LiveClient {
  private value = initial()
  private readonly listeners = new Set<() => void>()
  private csrf = ''
  private epoch = 0
  private stream: EventStream | undefined
  private abort = new AbortController()
  private refreshing = false
  private refreshAgain = false
  private streamOnline = false
  private buffered: ConversationObservation[] = []
  private bufferBytes = 0
  private retry: ReturnType<typeof setTimeout> | undefined
  private requestHash: string | undefined
  private historyRequest = 0
  private selectionVerification: symbol | undefined
  private readonly questionContextReads = new Map<string, Promise<QuestionContext>>()
  constructor(private readonly io: LiveTransport) {}
  readonly state = (): LiveState => this.value
  readonly subscribe = (callback: () => void): (() => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback) } }
  private patch(change: Partial<LiveState>): void {
    if ('snapshot' in change && (change.snapshot?.binding.bindingId !== this.value.snapshot?.binding.bindingId
      || historyHeadKey(change.snapshot?.history.checkpoint, change.snapshot?.history.selectedHead) !== historyHeadKey(this.value.snapshot?.history.checkpoint, this.value.snapshot?.history.selectedHead)
      || change.snapshot?.history.messages.some(message => { const old = this.value.snapshot?.history.messages.find(item => item.entryId === message.entryId)
        return old && (old.text !== message.text || old.role !== message.role || old.truncated !== message.truncated || historyOriginKey(old.origin) !== historyOriginKey(message.origin)) }))) {
      this.historyRequest++; change = { ...change, history: emptyHistory() }
    }
    if ('snapshot' in change && this.value.outgoing) {
      const outgoing = this.value.outgoing, binding = change.snapshot?.binding
      const run = change.snapshot?.runs.find(item => item.receipt.requestHash === outgoing.requestHash && item.receipt.generation === outgoing.request.expectedGeneration)
      if (!binding || binding.bindingId !== outgoing.bindingId || binding.generation !== outgoing.request.expectedGeneration
        || run && (!run.receipt.payloadRetained || run.text !== null || run.receipt.checkpoint)) change = { ...change, outgoing: null }
    }
    this.value = { ...this.value, ...change }; this.listeners.forEach(callback => callback())
  }
  async start(): Promise<void> {
    const epoch = this.epoch
    try {
      const value = parseBrowserContract('product-http', await this.json('/api/bootstrap'))
      if (epoch !== this.epoch) return
      if (value.kind !== 'bootstrap') throw new Error('Invalid bootstrap')
      this.csrf = value.csrfToken; this.patch({ actor: value.actor, phase: 'ready', error: '' })
      await this.loadConversations()
    } catch (error) { if (epoch === this.epoch) this.expired(error instanceof RequestError && error.status === 401 ? '' : '无法连接真实服务；此页面不会使用模拟回答。') }
  }
  async pair(code: string): Promise<void> {
    if (this.value.sending) return
    const epoch = this.epoch
    this.patch({ error: '', sending: true })
    try {
      const value = parseBrowserContract('product-http', await this.json('/api/auth/exchange', { schemaVersion: 1, kind: 'auth-exchange', code }))
      if (epoch !== this.epoch) return
      if (value.kind !== 'bootstrap') throw new Error('Invalid pairing response')
      this.csrf = value.csrfToken; this.patch({ actor: value.actor, phase: 'ready', sending: false })
      await this.loadConversations()
    } catch (error) { if (epoch === this.epoch) this.patch({ sending: false, error: error instanceof RequestError && error.status === 401 ? '配对码无效、过期或已被使用。' : '配对服务不可用，请重试。' }) }
  }
  async loadConversations(after?: string): Promise<void> {
    const epoch = this.epoch
    try {
      const value = parseBrowserContract('product-http', await this.json(`/api/conversations${after ? `?after=${encodeURIComponent(after)}` : ''}`))
      if (epoch !== this.epoch) return
      if (value.kind !== 'conversation-list' || value.items.some(item => !this.owns(item))) throw new Error('Invalid conversation scope')
      const items = after ? [...this.value.conversations, ...value.items] : value.items
      if (new Set(items.map(item => item.conversationId)).size !== items.length || items.length > 1024) throw new Error('Invalid conversation list')
      this.patch({ conversations: items, nextConversation: value.nextCursor })
      try { this.patch({ creationPending: this.io.storage.getItem(this.storagePrefix(this.value.actor!) + '@creation') !== null }) } catch { /* Creation will refuse to send if its key cannot be stored. */ }
      if (!this.value.selected && items[0]) {
        let previous: string | null = null
        try { previous = this.io.storage.getItem(this.storagePrefix(this.value.actor!) + '@selected') } catch { /* Reading remains available without tab storage. */ }
        if (previous && !items.some(item => item.conversationId === previous) && value.nextCursor) { await this.loadConversations(value.nextCursor); return }
        await this.select(items.find(item => item.conversationId === previous)?.conversationId ?? items[0].conversationId)
      }
    } catch (error) { this.failure(error, epoch) }
  }
  async select(conversationId: string): Promise<void> {
    if (!this.value.conversations.some(item => item.conversationId === conversationId && this.owns(item))) return
    this.resetObservation()
    const epoch = this.epoch
    this.patch({ selected: conversationId, snapshot: null, history: emptyHistory(), connection: 'connecting', draft: '', sourceRefs: [], selections: [], verifyingSelection: false, request: null, outgoing: null, error: '', sending: false, stopping: false, creating: false })
    try {
      this.io.storage.setItem(this.storagePrefix(this.value.actor!) + '@selected', conversationId)
      const stored = parseDraft(this.io.storage.getItem(this.storageKey()), conversationId)
      if (stored.selections?.some(item => item.actorId !== this.value.actor!.actorId || item.workspaceId !== this.value.actor!.workspaceId)) throw new Error('Selection actor mismatch')
      this.patch({ draft: stored.draft, request: stored.request, sourceRefs: stored.request?.sourceRefs ?? stored.sources ?? [], selections: stored.selections ?? [] })
      const hash = stored.request ? await submissionHash(stored.request) : undefined
      if (epoch !== this.epoch) return
      this.requestHash = hash
    } catch { this.patch({ error: '此标签页的旧草稿无法校验，未将其发送。' }) }
    if (epoch !== this.epoch) return
    this.stream = this.io.events(`/api/conversations/${encodeURIComponent(conversationId)}/events`)
    const event: EventListener = candidate => this.receive(candidate as MessageEvent, epoch)
    this.stream.addEventListener('observation', event); this.stream.addEventListener('resync', event)
    this.stream.onopen = () => { if (epoch === this.epoch) { this.streamOnline = true; this.patch({ connection: this.value.snapshot ? 'live' : 'connecting' }) } }
    this.stream.onerror = () => { if (epoch === this.epoch) { this.streamOnline = false; this.patch({ connection: 'reconnecting' }); this.scheduleRefresh() } }
    await this.refresh()
  }
  async createConversation(): Promise<string | undefined> {
    if (this.value.phase !== 'ready' || !this.value.actor || this.value.creating || this.value.sending) return
    const epoch = this.epoch, actor = this.value.actor, storageKey = this.storagePrefix(actor) + '@creation'
    this.patch({ creating: true, error: '' })
    try {
      const key = this.io.storage.getItem(storageKey) ?? `create:${crypto.randomUUID()}`
      const request = { schemaVersion: 1, kind: 'conversation-create', idempotencyKey: key }
      parseBrowserContract('product-http', request)
      const expected = `conversation:${await canonicalHash([actor.actorId, actor.workspaceId, key])}`
      if (epoch !== this.epoch) return
      this.io.storage.setItem(storageKey, key); this.patch({ creationPending: true })
      const binding = parseBrowserContract('product-control', await this.json('/api/conversations', request))
      if (epoch !== this.epoch) return
      if (binding.kind !== 'binding' || !this.owns(binding) || binding.conversationId !== expected) throw new Error('Creation receipt mismatch')
      this.io.storage.removeItem(storageKey)
      this.patch({ creating: false, creationPending: false, conversations: [...this.value.conversations.filter(item => item.conversationId !== binding.conversationId), binding] })
      await this.select(binding.conversationId)
      if (this.epoch === epoch + 1 && this.value.selected === binding.conversationId && this.value.snapshot) return binding.conversationId
    } catch (error) { this.failure(error, epoch, '新会话创建结果未确认；再次点击将使用原创建键核对，不会自动重建。') }
    finally { if (epoch === this.epoch) this.patch({ creating: false }) }
  }
  setDraft(draft: string): void {
    if (this.value.request || this.value.sending || draft.length > 6000) return
    this.patch({ draft })
    try { this.persist() } catch { this.patch({ error: '无法保存此标签页的草稿；发送前请检查浏览器存储。' }) }
  }
  setSources(sourceRefs: ProductSubmission['sourceRefs']): void {
    if (this.value.request || this.value.sending) return
    if (this.value.selections.some(ticket => ticket.items.some(item => !sourceRefs.some(ref => ref.documentId === item.locator.documentId && ref.revisionId === item.locator.revisionId)))) throw new Error('先移除关联选区，再移除此资料')
    parseBrowserContract('product-control', { schemaVersion: 1, kind: 'submission', conversationId: this.value.selected, expectedGeneration: 1, idempotencyKey: 'draft:source-validation', mode: 'prompt', text: 'draft', sourceRefs, selectionContextIds: [] })
    this.patch({ sourceRefs: structuredClone(sourceRefs) }); this.persist()
  }
  addSelection(candidate: ProductSelectionTicket): void {
    const value = parseBrowserContract('document-http', candidate)
    if (value.kind !== 'selection-ticket' || value.conversationId !== this.value.selected || value.actorId !== this.value.actor?.actorId || value.workspaceId !== this.value.actor.workspaceId || value.bindingId !== this.value.snapshot?.binding.bindingId
      || value.state !== 'staged' || Date.parse(value.expiresAt) <= Date.now() || this.value.request || this.value.sending || this.value.selections.length >= 8) throw new Error('选区过期、会话已变更或正在提交')
    const selections = [...this.value.selections.filter(item => item.selectionContextId !== value.selectionContextId), value]
    if (selections.flatMap(item => item.items).reduce((count, item) => count + [...item.text].length, 0) > 8000) throw new Error('选区文字超过 8000 字符限制')
    const sources = [...this.value.sourceRefs]
    for (const item of value.items) if (!sources.some(source => source.documentId === item.locator.documentId && source.revisionId === item.locator.revisionId)) sources.push({ documentId: item.locator.documentId, revisionId: item.locator.revisionId })
    this.setSources(sources); this.patch({ selections }); this.persist()
  }
  holdSelectionVerification(): () => void {
    if (this.value.sending || this.value.request || this.value.verifyingSelection) throw new Error('Submission or selection is already pending')
    const epoch = this.epoch, owner = Symbol('selection-verification')
    this.selectionVerification = owner
    this.patch({ verifyingSelection: true })
    return () => { if (epoch === this.epoch && this.selectionVerification === owner) { this.selectionVerification = undefined; this.patch({ verifyingSelection: false }) } }
  }
  forgetSelection(id: string): void {
    if (this.value.request || this.value.sending) return
    this.patch({ selections: this.value.selections.filter(item => item.selectionContextId !== id) }); this.persist()
  }
  async removeSelection(id: string): Promise<void> {
    if (this.value.request || this.value.sending || !this.value.selected) return
    const epoch = this.epoch
    await this.documentRequest(this.value.selected, `selections/${encodeURIComponent(id)}/cancel`, {})
    if (epoch !== this.epoch) return
    this.patch({ selections: this.value.selections.filter(item => item.selectionContextId !== id) }); this.persist()
  }
  private lineageContext(conversationId: string) {
    const epoch = this.epoch, identity = nativeControlIdentity(this.value)
    this.reviewId(conversationId)
    if (!identity || identity.conversationId !== conversationId) throw new Error('Lineage conversation changed')
    return { epoch, identity, current: () => {
      const now = nativeControlIdentity(this.value)
      if (epoch !== this.epoch || !now || now.actorId !== identity.actorId || now.workspaceId !== identity.workspaceId || now.conversationId !== conversationId) throw new Error('Lineage response changed actor or conversation')
    } }
  }
  async lineageInspect(conversationId: string): Promise<ProductLineageInspection> {
    const context = this.lineageContext(conversationId), current = this.reviewContext(conversationId)
    try {
      const value = checkedLineageInspection(context.identity, await this.json(`/api/conversations/${encodeURIComponent(conversationId)}/lineage`))
      current()
      await Promise.all(value.operations.map(operation => checkedLineageOperation(context.identity, operation)))
      current(); return value
    } catch (error) { if (error instanceof RequestError && error.status === 401) { current(); this.failure(error, context.epoch) } throw error }
  }
  async lineageTree(conversationId: string, candidate: ProductNativeTreeRequest): Promise<ProductNativeTreePage> {
    const context = this.lineageContext(conversationId), current = this.reviewContext(conversationId), request = structuredClone(candidate)
    const input = parseBrowserContract('native-lineage', request)
    if (!('kind' in input) || input.kind !== 'native-tree-request' || request.expectedGeneration !== context.identity.generation) throw new Error('Native tree request changed generation')
    try {
      const value = parseBrowserContract('native-lineage', await this.json(`/api/conversations/${encodeURIComponent(conversationId)}/lineage/tree`, request))
      current()
      if (!('kind' in value) || value.kind !== 'native-tree-page' || !lineageBindingMatches(context.identity, value.binding) || value.view !== request.view) throw new Error('Native tree response changed owner or view')
      return value
    } catch (error) { if (error instanceof RequestError && error.status === 401) { current(); this.failure(error, context.epoch) } throw error }
  }
  async lineageCommand(conversationId: string, candidate: ProductLineageCommand, recoveryOperationId?: string): Promise<ProductLineageOperation> {
    const context = this.lineageContext(conversationId), request = structuredClone(candidate)
    const input = parseBrowserContract('native-lineage', request), identity = context.identity
    const sameGeneration = request.expectedBindingId === identity.bindingId && request.expectedGeneration === identity.generation && request.runtimeSessionId === identity.nativeSessionId
    if (!('kind' in input) || input.kind !== 'lineage-command' || request.conversationId !== conversationId || !sameGeneration && !recoveryOperationId) throw new Error('Lineage command changed its original generation')
    try {
      if (recoveryOperationId) {
        const original = await this.lineageOperation(conversationId, recoveryOperationId)
        if (original.requestHash !== await canonicalHash(request)) throw new Error('Lineage recovery changed the complete original command')
        context.current()
      }
      const value = await checkedLineageOperation(identity, await this.json(`/api/conversations/${encodeURIComponent(conversationId)}/lineage`, request))
      context.current()
      if (value.requestHash !== await canonicalHash(request) || value.sourceBinding.bindingId !== request.expectedBindingId
        || value.sourceBinding.generation !== request.expectedGeneration || value.sourceBinding.runtimeSessionId !== request.runtimeSessionId
        || recoveryOperationId !== undefined && value.operationId !== recoveryOperationId) throw new Error('Lineage receipt does not match the complete frozen command')
      context.current(); return value
    } catch (error) { if (error instanceof RequestError && error.status === 401) { context.current(); this.failure(error, context.epoch) } throw error }
  }
  async lineageOperation(conversationId: string, operationId: string): Promise<ProductLineageOperation> {
    const context = this.lineageContext(conversationId)
    this.reviewId(operationId)
    try {
      const value = await checkedLineageOperation(context.identity, await this.json(`/api/conversations/${encodeURIComponent(conversationId)}/lineage/operations/${encodeURIComponent(operationId)}`), operationId)
      context.current(); return value
    } catch (error) { if (error instanceof RequestError && error.status === 401) { context.current(); this.failure(error, context.epoch) } throw error }
  }
  async nativeInspect(conversationId: string): Promise<ProductNativeInspection> {
    const current = this.reviewContext(conversationId), epoch = this.epoch, binding = this.value.snapshot!.binding
    try {
      const value = parseBrowserContract('native-control', await this.json(`/api/conversations/${encodeURIComponent(conversationId)}/native`))
      current()
      if (!('kind' in value) || value.kind !== 'native-inspection' || !this.owns(value.binding)
        || value.binding.bindingId !== binding.bindingId || value.binding.generation !== binding.generation || value.binding.runtimeSessionId !== binding.runtimeSessionId
        || value.binding.conversationId !== conversationId) throw new Error('Native settings changed their owner or session')
      await Promise.all(value.operations.map(operation => this.checkNativeOperation(operation, binding)))
      current(); return value
    } catch (error) { if (error instanceof RequestError && error.status === 401) { current(); this.failure(error, epoch) } throw error }
  }
  async nativeCommand(conversationId: string, candidate: ProductNativeCommand): Promise<ProductNativeOperation> {
    const current = this.reviewContext(conversationId), epoch = this.epoch, binding = this.value.snapshot!.binding, request = structuredClone(candidate)
    const input = parseBrowserContract('native-control', request)
    if (!('kind' in input) || input.kind !== 'native-command' || request.conversationId !== conversationId || request.expectedBindingId !== binding.bindingId
      || request.expectedGeneration !== binding.generation || request.runtimeSessionId !== binding.runtimeSessionId) throw new Error('Native command changed its original binding')
    try {
      const value = parseBrowserContract('native-control', await this.json(`/api/conversations/${encodeURIComponent(conversationId)}/native`, request))
      current()
      if (!('kind' in value) || value.kind !== 'native-operation') throw new Error('Invalid native operation receipt')
      await this.checkNativeOperation(value, binding)
      if (value.requestHash !== await canonicalHash(request)) throw new Error('Native receipt does not match the complete original command')
      current(); return value
    } catch (error) { if (error instanceof RequestError && error.status === 401) { current(); this.failure(error, epoch) } throw error }
  }
  async nativeOperation(conversationId: string, operationId: string): Promise<ProductNativeOperation> {
    const current = this.reviewContext(conversationId), epoch = this.epoch, binding = this.value.snapshot!.binding
    this.reviewId(operationId)
    try {
      const value = parseBrowserContract('native-control', await this.json(`/api/conversations/${encodeURIComponent(conversationId)}/native/operations/${encodeURIComponent(operationId)}`))
      current()
      if (!('kind' in value) || value.kind !== 'native-operation' || value.operationId !== operationId) throw new Error('Native operation identity changed')
      await this.checkNativeOperation(value, binding)
      current(); return value
    } catch (error) { if (error instanceof RequestError && error.status === 401) { current(); this.failure(error, epoch) } throw error }
  }
  private async checkNativeOperation(value: ProductNativeOperation, binding: ProductBinding): Promise<void> {
    if (value.conversationId !== binding.conversationId || value.bindingId !== binding.bindingId || value.generation !== binding.generation
      || value.runtimeSessionId !== binding.runtimeSessionId || value.requestHash !== await canonicalHash(value.request)) throw new Error('Native operation owner or request hash changed')
  }
  async historyPage(conversationId: string, candidate: ProductHistoryRequest): Promise<ProductHistoryPage> {
    const own = this.reviewContext(conversationId), epoch = this.epoch, binding = this.value.snapshot!.binding
    const request = structuredClone(candidate), parsed = parseBrowserContract('product-history', request)
    if (parsed.kind !== 'history-page-request' || request.expectedGeneration !== binding.generation || this.value.history.loading) throw new Error('History request changed context')
    const checkpoint = this.value.snapshot!.history.checkpoint, selectedHead = this.value.snapshot!.history.selectedHead ?? null,
      head = historyHeadKey(checkpoint, selectedHead), previous = this.value.history
    if (request.cursor !== null && (!previous.loaded || previous.nextCursor !== request.cursor || historyHeadKey(previous.head, previous.selectedHead) !== head)) throw new Error('History cursor is not the current verified continuation')
    const serial = ++this.historyRequest, current = () => {
      own()
      if (serial !== this.historyRequest || historyHeadKey(this.value.snapshot?.history.checkpoint, this.value.snapshot?.history.selectedHead) !== head) throw new Error('Native history checkpoint changed during pagination')
    }
    const stillCurrent = () => { try { current(); return true } catch { return false } }
    let messages = previous.loaded && historyHeadKey(previous.head, previous.selectedHead) === head ? previous.messages : this.value.snapshot!.history.messages
    const initialIds = new Set(messages.map(message => message.entryId))
    let cursor = request.cursor, result: ProductHistoryPage | undefined
    this.patch({ history: { ...previous, head: checkpoint, selectedHead, loading: true, error: '' } })
    try {
      // The snapshot may already contain 100 messages. Skip up to two entirely overlapping
      // newest-50 pages on the same gesture, without removing currently visible messages.
      for (let page = 0; page < 3; page++) {
        const value = parseBrowserContract('product-history', await this.json(`/api/conversations/${encodeURIComponent(conversationId)}/history`, { ...request, cursor }))
        current()
        if (value.kind !== 'history-page' || !this.owns(value.binding) || value.binding.bindingId !== binding.bindingId || value.binding.conversationId !== conversationId
          || value.binding.generation !== binding.generation || value.binding.runtimeSessionId !== binding.runtimeSessionId || historyHeadKey(value.checkpoint, value.selectedHead) !== head) throw new Error('History page changed owner or checkpoint')
        await Promise.all(value.messages.map(async message => {
          if (message.displayOrigin === 'native' && !message.truncated && message.nativeTextHash !== await historyTextHash(message.text)) throw new Error('Native history text hash does not match')
        }))
        current()
        messages = mergeHistory(messages, value.messages, cursor !== null)
        result = value; cursor = value.nextCursor
        if (!cursor || value.messages.some(message => !initialIds.has(message.entryId))) break
      }
      current()
      if (!result) throw new Error('No verified history page')
      this.patch({ history: { messages, head: checkpoint, selectedHead, hasEarlier: result.hasEarlier, nextCursor: result.nextCursor, loaded: true, loading: false,
        error: result.hasEarlier && !messages.some(message => !initialIds.has(message.entryId)) ? '已校验这部分历史，继续加载可读取更早内容。' : '' } })
      return result
    } catch (error) {
      if (epoch === this.epoch && stillCurrent()) {
        if (error instanceof RequestError && error.status === 401) this.failure(error, epoch)
        else if (error instanceof RequestError && error.status === 409) this.patch({ history: { ...emptyHistory(), error: '历史游标已失效，请重新加载；不会重发任何问题。' } })
        else this.patch({ history: { ...previous, loading: false, error: error instanceof Error && error.message.startsWith('当前页面') ? error.message : '无法核验更早历史，已保留当前消息，请重试。' } })
      }
      throw error
    } finally {
      if (epoch === this.epoch && stillCurrent() && this.value.history.loading) this.patch({ history: { ...this.value.history, loading: false } })
    }
  }
  private savedMessage(messageId: string): NativeConversationMessage | undefined {
    return (this.value.history.loaded && historyHeadKey(this.value.history.head, this.value.history.selectedHead) === historyHeadKey(this.value.snapshot?.history.checkpoint, this.value.snapshot?.history.selectedHead)
      ? this.value.history.messages : this.value.snapshot?.history.messages)?.find(message => message.entryId === messageId)
  }
  async documentRequest(conversationId: string, path: string, body?: unknown) {
    const epoch = this.epoch
    if (conversationId !== this.value.selected || this.value.phase !== 'ready') throw new Error('Conversation changed')
    try {
      const result = parseBrowserContract('document-http', await this.json(`/api/conversations/${encodeURIComponent(conversationId)}/${path}`, body))
      if (epoch !== this.epoch || result.kind === 'upload-start' || result.kind === 'selection-stage' || result.conversationId !== conversationId || result.kind === 'library-response' && result.result.workspaceId !== this.value.actor?.workspaceId) throw new Error('Document context changed')
      return result
    } catch (error) { if (epoch === this.epoch && error instanceof RequestError && error.status === 404) this.patch({ error: '资料不存在或尚未就绪，请刷新资料列表。' }); else this.failure(error, epoch, '资料操作失败；未更改已发送问题的来源。'); throw error }
  }
  async answerRequest(conversationId: string, messageId: string, citationId?: string) {
    const epoch = this.epoch, binding = this.value.snapshot?.binding
    const own = this.reviewContext(conversationId), checkpoint = historyHeadKey(this.value.snapshot?.history.checkpoint, this.value.snapshot?.history.selectedHead)
    const message = this.savedMessage(messageId)
    if (conversationId !== this.value.selected || this.value.phase !== 'ready' || !binding || !message || message.role !== 'assistant' || message.truncated) throw new Error('Answer is not a complete persisted message')
    const current = () => {
      try { own() } catch { throw new Error('Answer context changed') }
      const now = this.savedMessage(messageId)
      if (epoch !== this.epoch || this.value.phase !== 'ready' || this.value.selected !== conversationId || this.value.snapshot?.binding.bindingId !== binding.bindingId
        || checkpoint !== historyHeadKey(this.value.snapshot?.history.checkpoint, this.value.snapshot?.history.selectedHead)
        || !now || now.role !== 'assistant' || now.truncated || now.text !== message.text || historyOriginKey(now.origin) !== historyOriginKey(message.origin)) throw new Error('Answer context changed')
    }
    const textHash = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join('')
    try {
      const suffix = citationId === undefined ? '' : `/citations/${encodeURIComponent(citationId)}`
      const result = parseBrowserContract('product-answer', await this.json(`/api/conversations/${encodeURIComponent(conversationId)}/answers/${encodeURIComponent(messageId)}${suffix}`, citationId === undefined ? undefined : {}))
      current()
      if (result.conversationId !== conversationId || result.messageId !== messageId) throw new Error('Answer response identity changed')
      if (citationId !== undefined) {
        if (result.kind !== 'citation-focus' || result.citationId !== citationId) throw new Error('Citation response identity changed')
      } else {
        if (result.kind !== 'answer-response') throw new Error('Invalid answer response')
        if (result.status === 'available') {
          const manifest = result.manifest!
          if (historyOriginKey(result.origin) !== historyOriginKey(message.origin)
            || manifest.sessionId !== (result.origin?.conversationId ?? conversationId) || manifest.messageId !== messageId || manifest.workspaceId !== this.value.actor?.workspaceId
            || result.nativeTextHash !== await textHash(message.text)
            || manifest.answerTextHash !== await textHash(manifest.blocks.map(block => block.segments.map(segment => segment.text).join('')).join('\n\n'))) throw new Error('Answer manifest does not match this saved message')
        }
      }
      current(); return result
    } catch (error) { if (error instanceof RequestError && [401, 403].includes(error.status)) { current(); this.failure(error, epoch) } throw error }
  }
  async questionContextRequest(conversationId: string, target: QuestionContextTarget, focus?: { selectionContextId: string, locatorId: string }): Promise<QuestionContext | QuestionSelectionFocus> {
    const current = this.reviewContext(conversationId), epoch = this.epoch, binding = this.value.snapshot!.binding
    const identity = nativeControlIdentity(this.value)
    if (!identity) throw new Error('Question view is not ready')
    const message = target.kind === 'message' ? this.savedMessage(target.id) : undefined
    const receipt = target.kind === 'submission' ? this.value.snapshot!.runs.find(run => run.receipt.submissionId === target.id)?.receipt : undefined
    if (target.kind === 'message' ? !message || message.truncated : !receipt || receipt.generation !== binding.generation) throw new Error('Question is not in the current view')
    const signature = message ? JSON.stringify([message.role, message.text, message.truncated, message.origin]) : JSON.stringify([receipt!.requestHash, receipt!.generation])
    const check = () => {
      current()
      const now = target.kind === 'message' ? this.savedMessage(target.id) : undefined
      const run = target.kind === 'submission' ? this.value.snapshot?.runs.find(run => run.receipt.submissionId === target.id)?.receipt : undefined
      const stamp = now ? JSON.stringify([now.role, now.text, now.truncated, now.origin]) : run ? JSON.stringify([run.requestHash, run.generation]) : ''
      if (epoch !== this.epoch || stamp !== signature) throw new Error('Question view changed')
    }
    const path = `/api/conversations/${encodeURIComponent(conversationId)}/question-context/${target.kind === 'message' ? 'messages' : 'submissions'}/${encodeURIComponent(this.reviewId(target.id))}`
    const fetchValue = async () => {
      const value = parseBrowserContract('question-context', await this.json(focus ? `${path}/selections/${encodeURIComponent(this.reviewId(focus.selectionContextId))}/${encodeURIComponent(this.reviewId(focus.locatorId))}` : path, focus ? {} : undefined))
      check()
      if (!lineageBindingMatches(identity, value.binding) || value.target.kind !== target.kind || value.target.id !== target.id) throw new Error('Question context identity changed')
      if (focus) {
        if (value.kind !== 'question-selection-focus' || value.selectionContextId !== focus.selectionContextId || value.locatorId !== focus.locatorId) throw new Error('Selected passage focus changed')
      } else {
        if (value.kind !== 'question-context') throw new Error('Invalid question context')
        if (value.status === 'available' && (receipt && value.requestHash !== receipt.requestHash || message?.role === 'assistant' && value.nativeTextHash !== await historyTextHash(message.text)
          || message && 'nativeTextHash' in message && value.nativeTextHash !== message.nativeTextHash)) throw new Error('Question context does not match its message')
      }
      check(); return value
    }
    if (focus) return fetchValue()
    const key = JSON.stringify([epoch, binding.bindingId, target, signature, receipt?.version])
    let pending = this.questionContextReads.get(key)
    if (!pending) {
      if (this.questionContextReads.size >= 64) this.questionContextReads.delete(this.questionContextReads.keys().next().value!)
      pending = fetchValue().then(value => { if (value.kind !== 'question-context') throw new Error('Invalid question context'); return value })
      this.questionContextReads.set(key, pending)
      void pending.catch(() => { if (this.questionContextReads.get(key) === pending) this.questionContextReads.delete(key) })
    }
    const value = await pending; check(); return value
  }
  async enrichmentRequest(conversationId: string, path: string, body?: unknown) {
    const epoch = this.epoch
    if (conversationId !== this.value.selected || this.value.phase !== 'ready') throw new Error('Conversation changed')
    try {
      const result = parseBrowserContract('enrichment', await this.json(`/api/conversations/${encodeURIComponent(conversationId)}/${path}`, body))
      if (epoch !== this.epoch || result.kind !== 'enrichment-tree' && result.kind !== 'enrichment-job' || result.conversationId !== conversationId) throw new Error('Enrichment context changed')
      if (result.kind === 'enrichment-job' && (result.actorId !== this.value.actor?.actorId || result.workspaceId !== this.value.actor.workspaceId || result.bindingId !== this.value.snapshot?.binding.bindingId)) throw new Error('Enrichment owner changed')
      return result
    } catch (error) { if (error instanceof RequestError && [401, 403].includes(error.status)) this.failure(error, epoch); throw error }
  }
  async humanResearchCommand(conversationId: string, candidate: HumanResearchCommand): Promise<HumanResearchOperation> {
    const current = this.reviewContext(conversationId), owner = humanResearchOwner(this.value)!, request = structuredClone(candidate)
    const parsed = parseBrowserContract('human-research', request)
    if (!('kind' in parsed) || parsed.kind !== 'human-research-command' || request.expectedBindingId !== owner.bindingId || request.expectedGeneration !== owner.generation) throw new Error('Human research command changed binding')
    const value = await this.humanResearchRequest(conversationId, '', request)
    if (!('kind' in value) || value.kind !== 'human-research-operation' || !value.receipt
      || !await humanResearchReceiptMatches({ schemaVersion: 1, owner, request }, value)) throw new Error('Human research commit receipt differs from the complete command')
    current(); return value
  }
  async humanResearchOperation(conversationId: string, operationId: string): Promise<HumanResearchOperation> {
    const value = await this.humanResearchRequest(conversationId, `/operations/${encodeURIComponent(this.reviewId(operationId))}`)
    if (!('kind' in value) || value.kind !== 'human-research-operation' || value.operationId !== operationId) throw new Error('Human research operation changed identity')
    return value
  }
  async humanResearchQuery(conversationId: string, candidate: HumanResearchQuery): Promise<HumanResearchWorkspace> {
    const request = structuredClone(candidate), value = await this.humanResearchRequest(conversationId, '/query', request)
    if (!('kind' in value) || value.kind !== 'human-research-workspace' || value.result.view !== request.view || value.result.items.length > request.maxItems || value.result.pageInfo.usedChars === undefined || value.result.pageInfo.usedChars > request.maxChars
      || value.result.items.some(item => !request.recordTypes.some(type => type === item.recordType) || !request.recordStatuses.some(status => status === item.recordStatus)
        || request.view === 'working' && item.layer !== 'working')) throw new Error('Human research list escaped its filters')
    return value
  }
  async humanResearchEntry(conversationId: string, recordId: string): Promise<HumanResearchEntry> {
    const value = await this.humanResearchRequest(conversationId, `/entries/${encodeURIComponent(this.reviewId(recordId))}`)
    if (!('kind' in value) || value.kind !== 'human-research-entry' || value.entry.recordId !== recordId) throw new Error('Human research entry changed identity')
    return value
  }
  async humanResearchOverlay(conversationId: string, candidate: HumanResearchOverlayQuery): Promise<HumanResearchOverlay> {
    const request = structuredClone(candidate), value = await this.humanResearchRequest(conversationId, '/overlay', request)
    if (!('kind' in value) || value.kind !== 'human-research-overlay' || value.result.source.documentId !== request.source.documentId || value.result.source.revisionId !== request.source.revisionId
      || value.result.physicalPage !== request.physicalPage || value.result.items.length > request.maxItems || value.result.pageInfo.usedChars === undefined || value.result.pageInfo.usedChars > request.maxChars
      || value.result.items.some(item => !request.recordTypes.some(type => type === item.recordType) || request.view === 'working' && item.layer !== 'working')) throw new Error('Human research overlay escaped its exact source')
    return value
  }
  async humanResearchFocus(conversationId: string, recordId: string, locatorId: string): Promise<HumanResearchFocus> {
    const value = await this.humanResearchRequest(conversationId, `/entries/${encodeURIComponent(this.reviewId(recordId))}/focus/${encodeURIComponent(this.reviewId(locatorId))}`, {})
    if (!('kind' in value) || value.kind !== 'human-research-focus' || value.focus.recordId !== recordId || value.focus.locator.locatorId !== locatorId) throw new Error('Human research focus changed its original record')
    return value
  }
  private async humanResearchRequest(conversationId: string, suffix: string, body?: HumanResearchCommand | HumanResearchQuery | HumanResearchOverlayQuery | Record<string, never>) {
    const current = this.reviewContext(conversationId), owner = humanResearchOwner(this.value)!, epoch = this.epoch, request = body === undefined ? undefined : structuredClone(body)
    if (request && 'kind' in request) {
      const input = parseBrowserContract('human-research', request), expected = suffix === '' ? 'human-research-command' : suffix === '/query' ? 'human-research-query' : 'human-research-overlay-query'
      if (!('kind' in input) || input.kind !== expected || !('expectedBindingId' in input) || input.expectedBindingId !== owner.bindingId || input.expectedGeneration !== owner.generation) throw new Error('Human research request changed its binding or operation')
    }
    try {
      const value = parseBrowserContract('human-research', await this.json(`/api/conversations/${encodeURIComponent(this.reviewId(conversationId))}/research-workbench${suffix}`, request))
      current()
      if (!('binding' in value) || !humanResearchBinding(owner, value.binding)) throw new Error('Human research response changed its owner or binding')
      return value
    } catch (error) { if (error instanceof RequestError && error.status === 401) { current(); this.failure(error, epoch) } throw error }
  }
  async researchRequest(conversationId: string, path: string, body?: unknown): Promise<ProductResearchValue> {
    const epoch = this.epoch, binding = this.value.snapshot?.binding, actor = this.value.actor
    if (conversationId !== this.value.selected || this.value.phase !== 'ready' || !binding || !actor) throw new Error('Research conversation changed')
    const parts = path.split('/').map(part => decodeURIComponent(part))
    if (parts.some(part => !/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/.test(part))) throw new Error('Invalid research route')
    const expected = path === 'query' && body !== undefined ? 'notebook-response' : path === 'policy' ? 'research-session-policy'
      : path === 'notes' && body !== undefined ? 'note-saved' : parts[0] === 'notes' && parts.length === 2 ? body === undefined ? 'notebook-entry' : 'notebook-updated'
        : parts[0] === 'notes' && parts.length === 4 && parts[2] === 'focus' && body !== undefined ? 'research-focus' : undefined
    if (!expected) throw new Error('Unsupported research route')
    try {
      const result = parseBrowserContract('product-research', await this.json(`/api/conversations/${encodeURIComponent(conversationId)}/research/${parts.map(encodeURIComponent).join('/')}`, body))
      if (epoch !== this.epoch || this.value.snapshot?.binding.bindingId !== binding.bindingId || result.kind !== expected || !('conversationId' in result) || result.conversationId !== conversationId) throw new Error('Research response changed context')
      if (result.kind === 'notebook-response' && result.result.workspaceId !== actor.workspaceId || (result.kind === 'notebook-entry' || result.kind === 'research-focus') && result.recordId !== parts[1]
        || result.kind === 'research-focus' && result.locator.locatorId !== parts[3]) throw new Error('Research source identity changed')
      if (body !== undefined && expected !== 'research-focus') {
        const input = parseBrowserContract('product-research', body)
        if (!('expectedGeneration' in input) || input.expectedGeneration !== binding.generation) throw new Error('Research request generation changed')
        if (result.kind === 'note-saved' && (input.kind !== 'note-save' || result.result.selectionContextId !== input.selectionContextId || result.result.record.recordType !== 'research-note'
          || result.result.record.body !== input.body || result.result.record.noteKind !== input.noteKind || result.result.record.createdBy.actorId !== actor.actorId || result.result.record.workspaceId !== actor.workspaceId)) throw new Error('Saved note receipt differs from the request')
        if (result.kind === 'notebook-updated' && (input.kind !== 'notebook-mutate' || result.result.state.recordId !== input.recordId || result.result.state.workspaceId !== actor.workspaceId
          || result.result.state.previousVersion !== input.expectedVersion || result.result.state.version !== input.expectedVersion + 1
          || input.action === 'edit' && result.result.state.text !== input.text.normalize('NFC').trim()
          || input.action !== 'edit' && result.result.state.status !== ({ archive: 'archived', delete: 'deleted', resolve: 'resolved' } as const)[input.action])) throw new Error('Updated note receipt differs from the request')
        if (result.kind === 'research-session-policy' && (input.kind !== 'research-policy-set' || result.version !== input.expectedVersion + 1 || result.recallPriorResearch !== input.recallPriorResearch || result.contributeResearchState !== input.contributeResearchState)) throw new Error('Research policy receipt differs from the request')
      }
      return result
    } catch (error) { if (epoch === this.epoch && error instanceof RequestError && error.status === 401) this.failure(error, epoch); throw error }
  }
  async preferenceRequest(conversationId: string, body?: ProductPreferenceCommand | ProductPreferenceCommandV2): Promise<ProductPersonalizationValue | ProductPersonalizationV2Value> {
    const epoch = this.epoch, binding = this.value.snapshot?.binding, actor = this.value.actor
    if (conversationId !== this.value.selected || this.value.phase !== 'ready' || !binding || !actor) throw new Error('Preference conversation changed')
    // Restored v1 commands keep their exact envelope and key. New inspection is always v2.
    const request = body ? structuredClone(body) : undefined, contract = request?.schemaVersion === 1 ? 'product-personalization' : 'product-personalization-v2'
    if (request) { parseBrowserContract(contract, request); if (request.kind !== 'preference-command' || request.expectedGeneration !== binding.generation) throw new Error('Preference request changed context') }
    try {
      const result = parseBrowserContract(contract, await this.json(`/api/conversations/${encodeURIComponent(conversationId)}/preferences${request ? '' : '/state'}`, request))
      if (epoch !== this.epoch || this.value.snapshot?.binding.bindingId !== binding.bindingId || result.kind !== (request ? 'preference-result' : 'preference-inspection') || !('conversationId' in result) || result.conversationId !== conversationId) throw new Error('Preference response changed context')
      const profileId = `profile:pi:${(await canonicalHash([actor.actorId, actor.workspaceId])).slice(0, 32)}`
      if (epoch !== this.epoch || result.result.profileId !== profileId) throw new Error('Preference profile changed')
      if (request && result.kind === 'preference-result' && result.result.action !== request.command.action) throw new Error('Preference action receipt changed')
      return result
    } catch (error) { if (epoch === this.epoch && error instanceof RequestError && error.status === 401) this.failure(error, epoch); throw error }
  }
  async uploadBytes(conversationId: string, uploadId: string, file: File) {
    const epoch = this.epoch
    if (conversationId !== this.value.selected || this.value.phase !== 'ready') throw new Error('Conversation changed')
    const response = await this.io.fetch(`/api/conversations/${encodeURIComponent(conversationId)}/uploads/${encodeURIComponent(uploadId)}`, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/pdf', 'x-docatlas-csrf': this.csrf }, body: file, signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(60000)]) })
    let payload: unknown
    try { payload = await this.readJson(response) } catch (error) { if (error instanceof RequestError && error.status !== 404) this.failure(error, epoch); throw error }
    const result = parseBrowserContract('document-http', payload)
    if (epoch !== this.epoch || result.kind !== 'upload' || result.conversationId !== conversationId || result.uploadId !== uploadId || result.status !== 'stored') throw new Error('Upload receipt mismatch')
    return result
  }
  async learningQuery(conversationId: string, input: ProductLearningQuery): Promise<ProductLearningView> {
    const request = structuredClone(input), value = await this.learningRequest(conversationId, '/query', request)
    if (value.kind !== 'learning-view' || value.messageId !== (request.messageId ?? null)) throw new Error('Learning inspection changed its target')
    return value
  }
  async learningCommand(conversationId: string, input: ProductLearningCommand): Promise<ProductLearningOperation> {
    const value = await this.learningRequest(conversationId, '', input)
    if (value.kind !== 'learning-operation' || !value.receipt) throw new Error('Learning command has no durable receipt')
    return value
  }
  async learningOperation(conversationId: string, id: string): Promise<ProductLearningOperation> {
    const value = await this.learningRequest(conversationId, `/operations/${encodeURIComponent(this.reviewId(id))}`)
    if (value.kind !== 'learning-operation' || value.operationId !== id) throw new Error('Learning operation changed identity')
    return value
  }
  private async learningRequest(conversationId: string, suffix: string, candidate?: ProductLearningQuery | ProductLearningCommand) {
    const own = this.reviewContext(conversationId), owner = learningOwner(this.value)!, epoch = this.epoch, request = candidate ? structuredClone(candidate) : undefined
    if (request) {
      const parsed = parseBrowserContract('product-learning', request)
      if (parsed.kind !== (suffix === '/query' ? 'learning-query' : 'learning-command') || request.expectedBindingId !== owner.bindingId || request.expectedGeneration !== owner.generation) throw new Error('Learning request changed its frame')
    }
    const messageId = request && 'messageId' in request ? request.messageId : undefined
    const original = messageId ? this.savedMessage(messageId) : undefined
    const head = historyHeadKey(this.value.snapshot!.history.checkpoint, this.value.snapshot!.history.selectedHead)
    if (messageId && (!original || original.role !== 'assistant' || original.truncated || original.origin && original.origin.conversationId !== conversationId)) throw new Error('Learning comparison requires the original complete saved Answer')
    const current = () => {
      own()
      if (original) {
        const now = this.savedMessage(original.entryId)
        if (head !== historyHeadKey(this.value.snapshot!.history.checkpoint, this.value.snapshot!.history.selectedHead) || !now || now.text !== original.text
          || now.truncated || historyOriginKey(now.origin) !== historyOriginKey(original.origin)) throw new Error('Learning original Answer changed')
      }
    }
    try {
      let value = parseBrowserContract('product-learning', await this.json(`/api/conversations/${encodeURIComponent(conversationId)}/learning${suffix}`, request))
      current()
      if (value.kind !== 'learning-view' && value.kind !== 'learning-operation' || !learningBinding(owner, value.binding)
        || value.profileId !== `profile:pi:${(await canonicalHash([owner.actorId, owner.workspaceId])).slice(0, 32)}`) throw new Error('Learning response changed its owner')
      current()
      if (value.kind === 'learning-view') {
        value = await checkedLearningView(owner, value); current()
        if (original && value.comparison?.material && value.comparison.material.nativeTextHash !== await sha256Text(original.text)) throw new Error('Learning material is not this native Answer')
      } else if (request?.kind === 'learning-command') {
        const receipt = value.receipt
        if (!receipt || value.profileEpoch !== request.expectedProfileEpoch || value.operationId !== await learningOperationId(owner, request.idempotencyKey)
          || receipt.requestHash !== await canonicalHash(request) || receipt.idempotencyKey !== request.idempotencyKey || receipt.action !== request.action
          || receipt.bindingId !== owner.bindingId || receipt.generation !== owner.generation
          || request.action === 'dismiss' && (receipt.targetId !== request.offerId || receipt.targetVersion !== request.expectedOfferVersion + 1)
          || request.action === 'review' && (receipt.targetId !== request.candidateId || receipt.groupId !== request.groupId || receipt.targetVersion !== request.expectedCandidateVersion + 1)
          || request.action === 'configure' && receipt.targetVersion !== request.expectedSettingsVersion + 1) throw new Error('Learning receipt changed the complete command')
      }
      current(); return value
    } catch (error) { if (error instanceof RequestError && error.status === 401) { current(); this.failure(error, epoch) } throw error }
  }
  async probeInspect(conversationId: string, input: ProductProbeInspect): Promise<ProductProbeView> {
    const current = this.reviewContext(conversationId), value = await this.probeRequest(conversationId, 'inspect', input)
    if (value.kind !== 'probe-view') throw new Error('Unexpected controlled-presentation inspection')
    current(); return value
  }
  async probePrepare(conversationId: string, input: ProductProbePrepare): Promise<ProductProbeView> {
    const current = this.reviewContext(conversationId), value = await this.probeRequest(conversationId, 'prepare', input)
    if (value.kind !== 'probe-view' || !value.probe) throw new Error('Controlled presentation was not prepared')
    current(); return value
  }
  async probeChoose(conversationId: string, input: ProductProbeChoose): Promise<ProductProbeChoiceResult> {
    const current = this.reviewContext(conversationId), value = await this.probeRequest(conversationId, 'choose', input)
    if (value.kind !== 'probe-choice-result') throw new Error('Unexpected controlled-presentation choice receipt')
    current(); return value
  }
  async probeReview(conversationId: string, input: ProductProbeReview): Promise<ProductProbeReviewResult> {
    const current = this.reviewContext(conversationId), value = await this.probeRequest(conversationId, 'review', input)
    if (value.kind !== 'probe-review-result') throw new Error('Unexpected controlled-preference confirmation receipt')
    current(); return value
  }
  private async probeRequest(conversationId: string, operation: 'inspect' | 'prepare' | 'choose' | 'review', input: ProductProbeInspect | ProductProbePrepare | ProductProbeChoose | ProductProbeReview) {
    const own = this.reviewContext(conversationId), epoch = this.epoch, binding = this.value.snapshot!.binding, actor = this.value.actor!, request = structuredClone(input)
    const parsed = parseBrowserContract('product-probe', request)
    if (parsed.kind !== `probe-${operation}` || request.expectedGeneration !== binding.generation) throw new Error('Controlled presentation operation or generation changed')
    const original = this.savedMessage(request.messageId), checkpoint = historyHeadKey(this.value.snapshot!.history.checkpoint, this.value.snapshot!.history.selectedHead)
    if (!original || original.role !== 'assistant' || original.truncated) throw new Error('Controlled presentation requires a complete saved Answer')
    if (original.origin && original.origin.conversationId !== conversationId) throw new Error('继承的回答保留原会话归属；请在原会话中比较呈现。')
    const current = () => {
      own()
      const value = this.savedMessage(original.entryId)
      if (checkpoint !== historyHeadKey(this.value.snapshot!.history.checkpoint, this.value.snapshot!.history.selectedHead) || !value || value.role !== 'assistant'
        || value.truncated || value.text !== original.text || historyOriginKey(value.origin) !== historyOriginKey(original.origin)) throw new Error('Controlled presentation original Answer changed')
    }
    try {
      let value = parseBrowserContract('product-probe', await this.json(`/api/conversations/${encodeURIComponent(conversationId)}/preferences/probes/${operation}`, request))
      current()
      if (!('bindingId' in value) || value.conversationId !== conversationId || value.bindingId !== binding.bindingId || value.generation !== binding.generation || value.messageId !== request.messageId
        || 'expectedProfileEpoch' in request && value.profileEpoch !== request.expectedProfileEpoch) throw new Error('Controlled presentation response changed its owner or epoch')
      const profileId = `profile:pi:${(await canonicalHash([actor.actorId, actor.workspaceId])).slice(0, 32)}`
      if (value.kind === 'probe-view') {
        value = await checkedProbeView({ actorId: actor.actorId, workspaceId: actor.workspaceId, conversationId, bindingId: binding.bindingId, generation: binding.generation, messageId: request.messageId }, value)
        if (value.probe && value.probe.profileId !== profileId) throw new Error('Controlled presentation profile changed')
        if (value.material) {
          const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(original.text))
          const nativeHash = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
          if (value.material.nativeTextHash !== nativeHash) throw new Error('Controlled presentation is not bound to this native saved Answer')
        }
      } else if (value.kind === 'probe-choice-result' && request.kind === 'probe-choose') {
        if (value.probeId !== request.probeId || value.idempotencyKey !== request.idempotencyKey || value.requestHash !== await canonicalHash(request)
          || value.choice.profileId !== profileId || value.choice.selected !== request.selected || value.choice.scopeIntent !== request.scopeIntent
          || JSON.stringify([...(value.choice.reasonTags ?? [])].sort()) !== JSON.stringify([...request.reasonTags].sort())
          || value.choice.consent.basis !== 'session-policy' || value.choice.consent.retention !== (request.scopeIntent === 'workspace' ? 'eligible' : 'session-only')
          || (request.scopeIntent === 'workspace' ? value.candidateId === null : value.candidateId !== null)) throw new Error('Controlled choice receipt does not match the original command')
      } else if (value.kind === 'probe-review-result' && request.kind === 'probe-review') {
        if (value.probeId !== request.probeId || value.idempotencyKey !== request.idempotencyKey || value.requestHash !== await canonicalHash(request)
          || personalizationCommandIssues(value.result, { schemaVersion: 1, requestType: 'personalization-command', profileId, sessionId: conversationId,
            actor: { kind: 'user', actorId: actor.actorId }, action: 'review-candidate', candidateId: request.candidateId, expectedVersion: request.expectedCandidateVersion,
            decision: request.decision, idempotencyKey: request.idempotencyKey }).length
          || value.result.candidate.version !== request.expectedCandidateVersion + 1 || value.result.candidate.proposedEffect.key !== 'answer-order'
          || value.result.candidate.proposedScope.kind !== 'workspace' || value.result.candidate.proposedScope.workspaceId !== actor.workspaceId) throw new Error('Controlled preference confirmation changed the original candidate')
      } else throw new Error('Controlled presentation response kind changed')
      current(); return value
    } catch (error) { if (error instanceof RequestError && error.status === 401) { current(); this.failure(error, epoch) } throw error }
  }
  async continuityInspect(conversationId: string, input: ProductContinuityInspect): Promise<ProductContinuityInspection> {
    const current = this.reviewContext(conversationId), request = structuredClone(input), value = await this.continuityRequest(conversationId, 'inspect', request)
    if (value.kind !== 'continuity-inspection' || value.record.recordId !== request.recordId
      || request.scopeVersionId !== undefined && value.scopeVersionId !== request.scopeVersionId) throw new Error('Continuity inspection changed its original record or scope')
    current(); return value
  }
  async continuityImpact(conversationId: string, input: ProductContinuityImpact): Promise<ProductContinuityImpactResult> {
    const current = this.reviewContext(conversationId), request = structuredClone(input), value = await this.continuityRequest(conversationId, 'impact', request)
    if (value.kind !== 'continuity-impact-result' || value.recordId !== request.recordId || !value.dependencyOnly
      || value.previousSource.documentId !== request.previousSource.documentId || value.previousSource.revisionId !== request.previousSource.revisionId
      || value.currentSource.documentId !== request.currentSource.documentId || value.currentSource.revisionId !== request.currentSource.revisionId) throw new Error('Revision impact changed its original source pair')
    current(); return value
  }
  async continuityAssess(conversationId: string, input: ProductContinuityAssess): Promise<ProductContinuityAssessment> {
    const current = this.reviewContext(conversationId), request = structuredClone(input), value = await this.continuityRequest(conversationId, 'assess', request)
    const pairKeys = (sources: Array<{ documentId: string, revisionId: string }>) => sources.map(source => `${source.documentId}\0${source.revisionId}`).sort()
    if (value.kind !== 'continuity-assessment' || value.idempotencyKey !== request.idempotencyKey || value.requestHash !== await canonicalHash(request)
      || value.result.link.priorRecordId !== request.priorRecordId || value.result.link.priorRecordVersion !== request.expectedPriorVersion
      || value.result.link.scopeVersionId !== request.scopeVersionId || value.result.link.state !== request.proposedState || value.result.link.rationale !== request.rationale
      || JSON.stringify(pairKeys(value.result.link.currentSources)) !== JSON.stringify(pairKeys(request.currentSources))
      || JSON.stringify([...value.result.link.priorEvidenceIds].sort()) !== JSON.stringify([...request.priorEvidenceIds].sort())
      || JSON.stringify([...value.result.link.currentEvidenceIds].sort()) !== JSON.stringify([...request.currentEvidenceIds].sort())) throw new Error('Continuity receipt does not match the frozen original assessment')
    current(); return value
  }
  private async continuityRequest(conversationId: string, operation: 'inspect' | 'impact' | 'assess', body: ProductContinuityInspect | ProductContinuityImpact | ProductContinuityAssess) {
    const current = this.reviewContext(conversationId), epoch = this.epoch, binding = this.value.snapshot!.binding, actor = this.value.actor!, request = structuredClone(body)
    const parsed = parseBrowserContract('product-continuity', request)
    if (parsed.kind !== `continuity-${operation}` || !('expectedGeneration' in parsed) || parsed.expectedGeneration !== binding.generation) throw new Error('Continuity request changed its operation or generation')
    try {
      const value = parseBrowserContract('product-continuity', await this.json(`/api/conversations/${encodeURIComponent(this.reviewId(conversationId))}/continuity/${operation}`, request))
      current()
      if (!('conversationId' in value) || value.conversationId !== conversationId || value.bindingId !== binding.bindingId || value.generation !== binding.generation
        || value.kind === 'continuity-assessment' && (value.result.link.workspaceId !== actor.workspaceId || value.result.link.createdBy.kind !== 'user' || value.result.link.createdBy.actorId !== actor.actorId)) throw new Error('Continuity response changed identity')
      return value
    } catch (error) { if (error instanceof RequestError && error.status === 401) { current(); this.failure(error, epoch) } throw error }
  }
  async revisionHistory(conversationId: string, documentId: string, cursor?: string): Promise<ProductRevisionHistory> {
    const current = this.reviewContext(conversationId)
    const value = await this.revisionRequest(conversationId, `documents/${encodeURIComponent(this.reviewId(documentId))}/revisions${cursor === undefined ? '' : `?cursor=${encodeURIComponent(this.reviewId(cursor))}`}`)
    if (value.kind !== 'revision-history' || value.documentId !== documentId) throw new Error('Revision history identity changed')
    current(); return value
  }
  revisionImport(conversationId: string, command: ProductRevisionImport): Promise<ProductRevisionImportState> {
    return this.revisionIntent(conversationId, command, true)
  }
  revisionImportStatus(conversationId: string, command: ProductRevisionImport): Promise<ProductRevisionImportState> {
    return this.revisionIntent(conversationId, command, false)
  }
  private async revisionIntent(conversationId: string, command: ProductRevisionImport, write: boolean): Promise<ProductRevisionImportState> {
    const current = this.reviewContext(conversationId), request = structuredClone(command)
    const parsed = parseBrowserContract('product-library', request)
    if (parsed.kind !== 'revision-import' || write && parsed.expectedGeneration !== this.value.snapshot?.binding.generation) throw new Error('Revision import generation changed')
    const value = await this.revisionRequest(conversationId, `uploads/${encodeURIComponent(this.reviewId(request.uploadId))}/${write ? 'revision-import' : 'revision-status'}`, request)
    if (value.kind !== 'revision-import-state' || write && !value.job || value.requestHash !== await canonicalHash(request)
      || value.requestHash !== await canonicalHash(value.request)) throw new Error('Revision receipt does not match the frozen original intent')
    current(); return value
  }
  private async revisionRequest(conversationId: string, path: string, body?: ProductRevisionImport) {
    const current = this.reviewContext(conversationId), epoch = this.epoch, binding = this.value.snapshot!.binding, actor = this.value.actor!
    try {
      const value = parseBrowserContract('product-library', await this.json(`/api/conversations/${encodeURIComponent(this.reviewId(conversationId))}/${path}`, body))
      current()
      if (value.kind === 'revision-import' || value.conversationId !== conversationId || value.bindingId !== binding.bindingId || value.generation !== binding.generation
        || value.kind === 'revision-import-state' && value.job && value.job.workspaceId !== actor.workspaceId) throw new Error('Revision response changed identity')
      return value
    } catch (error) { if (error instanceof RequestError && error.status === 401) { current(); this.failure(error, epoch) } throw error }
  }
  async reviewWorkspace(conversationId: string, scopeVersionId?: string): Promise<ProductReviewWorkspace> {
    const current = this.reviewContext(conversationId)
    const value = await this.reviewRequest(conversationId, scopeVersionId === undefined ? '' : `?scopeVersionId=${encodeURIComponent(this.reviewId(scopeVersionId))}`)
    if (value.kind !== 'review-workspace' || scopeVersionId !== undefined && value.scope?.scopeVersionId !== scopeVersionId) throw new Error('Review scope changed')
    current()
    return value
  }
  async reviewCommand(conversationId: string, command: ProductReviewCommand): Promise<ProductReviewResult> {
    const current = this.reviewContext(conversationId), request = structuredClone(command)
    const parsed = parseBrowserContract('product-review', request)
    if (parsed.kind !== 'review-command' || parsed.expectedGeneration !== this.value.snapshot?.binding.generation) throw new Error('Review request generation changed')
    const value = await this.reviewRequest(conversationId, '', request)
    const resultType = { 'claim-save': 'm4-claim-record', 'artifact-create': 'm4-artifact-draft', 'review-attest': 'm4-conflict-search-assurance',
      'review-run': 'm4-review-run', 'review-decide': 'm4-human-decision', 'artifact-publish': 'm4-artifact-publish' } as const
    if (value.kind !== 'review-result' || value.idempotencyKey !== request.idempotencyKey || value.result.scopeVersionId !== request.scopeVersionId
      || value.result.resultType !== resultType[request.action] || value.requestHash !== await canonicalHash(request)) throw new Error('Review receipt does not match the original request')
    current()
    return value
  }
  async reviewFocus(conversationId: string, scopeVersionId: string, evidenceId: string): Promise<ProductReviewFocus> {
    const current = this.reviewContext(conversationId)
    const value = await this.reviewRequest(conversationId, `/evidence/${encodeURIComponent(this.reviewId(evidenceId))}/focus`, { scopeVersionId: this.reviewId(scopeVersionId) })
    if (value.kind !== 'review-focus' || value.evidenceId !== evidenceId || value.scopeVersionId !== scopeVersionId) throw new Error('Review evidence focus changed')
    current()
    return value
  }
  private reviewId(value: string): string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(value)) throw new Error('Invalid review reference')
    return value
  }
  private reviewContext(conversationId: string): () => void {
    const epoch = this.epoch, binding = this.value.snapshot?.binding, actor = this.value.actor
    this.reviewId(conversationId)
    if (this.value.phase !== 'ready' || this.value.selected !== conversationId || !binding || !actor || binding.conversationId !== conversationId
      || binding.ownerActorId !== actor.actorId || binding.workspaceId !== actor.workspaceId) throw new Error('Review conversation changed')
    return () => {
      const now = this.value.snapshot?.binding
      if (epoch !== this.epoch || this.value.phase !== 'ready' || this.value.selected !== conversationId
        || this.value.actor?.actorId !== actor.actorId || this.value.actor.workspaceId !== actor.workspaceId
        || now?.bindingId !== binding.bindingId || now.generation !== binding.generation || now.runtimeSessionId !== binding.runtimeSessionId
        || now.conversationId !== conversationId || now.ownerActorId !== actor.actorId || now.workspaceId !== actor.workspaceId) throw new Error('Review response changed context')
    }
  }
  private async reviewRequest(conversationId: string, suffix: string, body?: unknown) {
    const current = this.reviewContext(conversationId), epoch = this.epoch, binding = this.value.snapshot!.binding, actor = this.value.actor!
    try {
      const value = parseBrowserContract('product-review', await this.json(`/api/conversations/${encodeURIComponent(this.reviewId(conversationId))}/reviews${suffix}`, body))
      current()
      if (value.kind === 'review-command' || value.conversationId !== conversationId) throw new Error('Review response changed context')
      if (value.kind === 'review-workspace' && (value.bindingId !== binding.bindingId || value.generation !== binding.generation
        || value.scope && (value.scope.workspaceId !== actor.workspaceId || value.scope.createdBy.kind !== 'user' || value.scope.createdBy.actorId !== actor.actorId))
        || value.kind === 'review-result' && value.result.workspaceId !== actor.workspaceId) throw new Error('Review response changed owner')
      return value
    } catch (error) { if (error instanceof RequestError && error.status === 401) { current(); this.failure(error, epoch) } throw error }
  }
  discard(): void {
    if (this.value.sending) return
    this.requestHash = undefined; this.patch({ request: null, outgoing: null, draft: '', error: '' })
    try { this.persist() } catch { this.patch({ error: '无法清除此标签页草稿。' }) }
  }
  async submit(mode: ProductSubmission['mode'] = 'prompt', documentSearch?: ProductSubmission['documentSearch']): Promise<void> {
    if (this.value.sending || this.value.creating || this.value.verifyingSelection || !this.value.snapshot || !this.value.actor || !this.value.draft.trim()) return
    if (!this.value.request && this.value.selections.some(item => item.bindingId !== this.value.snapshot!.binding.bindingId || item.state !== 'staged' || Date.parse(item.expiresAt) <= Date.now())) { this.patch({ error: '选区已过期或会话版本变化，请移除后重新选择。草稿仍保留。' }); return }
    const epoch = this.epoch
    this.patch({ sending: true, error: '' })
    try {
      const request = this.value.request ?? { schemaVersion: 1, kind: 'submission', conversationId: this.value.selected!, expectedGeneration: this.value.snapshot.binding.generation,
        idempotencyKey: `web:${crypto.randomUUID()}`, mode, text: this.value.draft, sourceRefs: structuredClone(this.value.sourceRefs), selectionContextIds: this.value.selections.map(item => item.selectionContextId),
        ...(documentSearch ? { documentSearch: structuredClone(documentSearch) } : {}) } satisfies ProductSubmission
      parseBrowserContract('product-control', request)
      // Freeze and persist before any network request; the UI can paint this
      // pending intent immediately while hashing/acceptance is in flight.
      this.patch({ request, outgoing: { bindingId: this.value.snapshot!.binding.bindingId, request, requestHash: null, receipt: null, selections: structuredClone(this.value.selections) } })
      this.persist()
      const hash = await submissionHash(request)
      if (epoch !== this.epoch) return
      const outgoing = this.value.outgoing
      if (!outgoing || outgoing.request.idempotencyKey !== request.idempotencyKey) throw new Error('Submission view changed before dispatch')
      this.requestHash = hash; this.patch({ outgoing: { ...outgoing, requestHash: hash } })
      const receipt = parseBrowserContract('product-control', await this.json('/api/submissions', request))
      if (epoch !== this.epoch) return
      if (receipt.kind !== 'run-receipt' || receipt.requestHash !== hash || receipt.conversationId !== request.conversationId || receipt.generation !== request.expectedGeneration) throw new Error('Receipt does not match pending submission')
      this.acknowledge(receipt); await this.refresh()
    } catch (error) { this.failure(error, epoch, '提交结果尚未确认。草稿和原提交键已保留；请核对或使用原键重试。') }
    finally { if (epoch === this.epoch) this.patch({ sending: false }) }
  }
  async stop(): Promise<void> {
    if (!this.value.snapshot || this.value.stopping) return
    const epoch = this.epoch, conversationId = this.value.selected!, binding = this.value.snapshot.binding, generation = binding.generation
    const context = this.lineageContext(conversationId), currentOwner = () => { try { context.current(); return true } catch { return false } }
    this.patch({ stopping: true, error: '' })
    try {
      const value = parseBrowserContract('product-http', await this.json(`/api/conversations/${encodeURIComponent(conversationId)}/stop`, {}, binding.bindingId))
      if (!currentOwner()) return
      if (value.kind !== 'runtime-stopped' || value.conversationId !== conversationId || value.generation !== generation) throw new Error('Invalid stop receipt')
      await this.refresh()
    } catch (error) { if (currentOwner()) this.failure(error, epoch, '尚未确认任务已停止，请核对会话状态。') }
    finally { if (currentOwner()) this.patch({ stopping: false }) }
  }
  async logout(): Promise<void> {
    const actor = this.value.actor, csrf = this.csrf
    this.resetObservation(); this.csrf = ''; this.requestHash = undefined
    const epoch = this.epoch
    this.value = initial(); this.patch({ phase: 'pairing', sending: true, error: '' })
    try { if (actor) {
      const prefix = this.storagePrefix(actor), keys = Array.from({ length: this.io.storage.length }, (_, index) => this.io.storage.key(index)).filter((key): key is string => key?.startsWith(prefix) === true)
      for (const key of keys) this.io.storage.removeItem(key)
    } } catch { this.patch({ error: '本页已清空，但浏览器不允许清理标签页草稿，请关闭此标签页。' }) }
    try { const response = await this.io.fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-docatlas-csrf': csrf }, body: '{}', signal: AbortSignal.timeout(15000) }); if (!response.ok && response.status !== 401) throw new RequestError(response.status) }
    catch { if (epoch === this.epoch) this.patch({ error: '本页已清空，但服务尚未确认注销。请关闭此标签页或重试。' }) }
    finally { if (epoch === this.epoch) this.patch({ sending: false }) }
  }
  async refresh(): Promise<void> {
    if (this.refreshing || !this.value.selected || this.value.phase !== 'ready') return
    const epoch = this.epoch, selected = this.value.selected
    this.refreshing = true
    try {
      const value = parseBrowserContract('conversation-observation', await this.json(`/api/conversations/${encodeURIComponent(selected)}/snapshot`))
      if (epoch !== this.epoch) return
      if (value.kind !== 'conversation-snapshot' || value.binding.conversationId !== selected || !this.owns(value.binding)) throw new Error('Snapshot scope mismatch')
      this.patch({ snapshot: value, connection: this.streamOnline ? 'live' : 'reconnecting', error: this.value.request ? this.value.error : '' })
      for (const run of value.runs) this.acknowledge(run.receipt)
      const pending = this.buffered; this.buffered = []; this.bufferBytes = 0
      let refresh = false
      for (const event of pending) {
        if (event.cursor.streamId === this.value.snapshot!.cursor.streamId && event.cursor.sequence <= this.value.snapshot!.cursor.sequence) continue
        const result = applyObservation(this.value.snapshot!, event)
        this.patch({ snapshot: result.snapshot }); refresh ||= result.refresh
        if (event.update.type === 'receipt') this.acknowledge(event.update.receipt)
      }
      if (refresh) this.scheduleRefresh()
    } catch (error) { if (epoch === this.epoch) { this.patch({ connection: 'offline' }); this.failure(error, epoch); this.scheduleRefresh() } }
    finally { if (epoch === this.epoch) { this.refreshing = false; if (this.refreshAgain) { this.refreshAgain = false; this.scheduleRefresh() } } }
  }
  dispose(): void { this.resetObservation(); this.listeners.clear() }
  private receive(message: MessageEvent, epoch: number): void {
    if (epoch !== this.epoch) return
    try {
      if (typeof message.data !== 'string' || message.data.length > 65536) throw new Error('Oversized observation')
      const value = parseBrowserContract('conversation-observation', JSON.parse(message.data))
      if (value.kind !== 'conversation-observation' || value.conversationId !== this.value.selected || message.lastEventId !== `${value.cursor.streamId}:${value.cursor.sequence}`) throw new Error('Observation identity mismatch')
      if (this.refreshing || !this.value.snapshot) {
        if (this.buffered.length >= 256 || this.bufferBytes + message.data.length > 1048576) { this.buffered = []; this.bufferBytes = 0; this.scheduleRefresh(); return }
        this.buffered.push(value); this.bufferBytes += message.data.length; return
      }
      const result = applyObservation(this.value.snapshot, value)
      this.patch({ snapshot: result.snapshot, connection: result.refresh ? 'reconnecting' : 'live' })
      if (value.update.type === 'receipt') this.acknowledge(value.update.receipt)
      if (result.refresh) this.scheduleRefresh()
    } catch { this.patch({ connection: 'reconnecting', error: '观察流无法校验，正在重新获取会话。' }); this.scheduleRefresh() }
  }
  private acknowledge(receipt: ProductRunReceipt): void {
    if (!this.matches(receipt)) return
    const outgoing = this.value.outgoing
    this.requestHash = undefined; this.patch({ request: null, draft: '', selections: [], error: '',
      ...(outgoing && outgoing.requestHash === receipt.requestHash ? { outgoing: { ...outgoing, receipt } } : {}) })
    try { this.persist() } catch { this.patch({ error: '提交已接收，但本地草稿清理失败；重试仍使用原键。' }) }
  }
  private matches(receipt: ProductRunReceipt): boolean { return this.value.request !== null && receipt.requestHash === this.requestHash && receipt.conversationId === this.value.request.conversationId && receipt.generation === this.value.request.expectedGeneration }
  private owns(binding: ProductBinding): boolean { return binding.ownerActorId === this.value.actor?.actorId && binding.workspaceId === this.value.actor.workspaceId }
  private storagePrefix(actor: Actor): string { return `docatlas.live.draft.v1:${encodeURIComponent(actor.actorId)}:${encodeURIComponent(actor.workspaceId)}:` }
  private storageKey(): string { if (!this.value.actor || !this.value.selected) throw new Error('No draft scope'); return this.storagePrefix(this.value.actor) + encodeURIComponent(this.value.selected) }
  private persist(): void { this.io.storage.setItem(this.storageKey(), JSON.stringify({ version: 1, draft: this.value.draft, request: this.value.request, sources: this.value.sourceRefs, selections: this.value.selections })) }
  private scheduleRefresh(): void { if (this.value.phase !== 'ready') return; if (this.refreshing) { this.refreshAgain = true; return } if (!this.retry) this.retry = setTimeout(() => { this.retry = undefined; void this.refresh() }, 500) }
  private resetObservation(): void { this.epoch++; this.questionContextReads.clear(); this.stream?.close(); this.stream = undefined; this.streamOnline = false; this.abort.abort(); this.abort = new AbortController(); clearTimeout(this.retry); this.retry = undefined; this.buffered = []; this.bufferBytes = 0; this.refreshing = false; this.refreshAgain = false }
  private expired(message = '连接已更新，请重新连接服务。'): void { this.resetObservation(); this.csrf = ''; this.requestHash = undefined; this.value = initial(); this.patch({ phase: 'pairing', error: message }) }
  private failure(error: unknown, epoch: number, fallback = '无法刷新真实会话，请检查连接后重试。'): void { if (epoch !== this.epoch) return; if (error instanceof RequestError && [401, 403, 404].includes(error.status)) this.expired(); else this.patch({ error: error instanceof RequestError ? error.message : fallback }) }
  private async json(path: string, body?: unknown, expectedBindingId?: string): Promise<unknown> {
    const response = await this.io.fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30000)]),
      headers: { accept: 'application/json', ...(expectedBindingId ? { 'if-match': JSON.stringify(expectedBindingId) } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json', 'x-docatlas-csrf': this.csrf } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    return this.readJson(response)
  }
  private async readJson(response: Response): Promise<unknown> {
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new RequestError(response.status) }
    if (!response.headers.get('content-type')?.includes('application/json')) { await response.body?.cancel().catch(() => {}); throw new Error('Expected JSON response') }
    const reader = response.body!.getReader(), chunks: Uint8Array[] = []; let length = 0
    try {
      while (true) { const item = await reader.read(); if (item.done) break; length += item.value.length; if (length > 2097152) throw new Error('Response exceeds limit'); chunks.push(item.value) }
      const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } finally { await reader.cancel().catch(() => {}) }
  }
}
