import { questionContextIssues, type QuestionContext, type QuestionContextTarget, type QuestionSelectionFocus, type ProductBinding, type DocumentLocator } from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import { DocumentAccessError, enrichmentHash } from '@docatlas/core'
import type { ControlStore, ProductActor } from '../storage/control-store.js'
import type { SelectionTickets } from '../storage/selection-tickets.js'
import type { HistoricalAnswerOrigins } from '../runs/lineage-history.js'
import type { ProductAnswers } from './answers.js'

/** Read projection of original input tickets. Not new Evidence, conversation content or ticket admission. */
export class ProductQuestionContexts {
  private history: HistoricalAnswerOrigins | undefined
  constructor(private readonly control: ControlStore, private readonly actor: ProductActor, private readonly tickets: SelectionTickets, private readonly answers: ProductAnswers) {}
  enableHistoricalOrigins(port: HistoricalAnswerOrigins): void {
    if (this.history) throw new DocumentAccessError('unavailable', 'Question history access is already configured')
    this.history = port
  }
  get(conversationId: string, target: QuestionContextTarget): QuestionContext { return this.load(conversationId, target).context }
  async focus(conversationId: string, target: QuestionContextTarget, selectionContextId: string, locatorId: string, authorize: () => void, signal: AbortSignal): Promise<QuestionSelectionFocus> {
    const before = this.load(conversationId, target), locator = before.locators.get(`${selectionContextId}:${locatorId}`)
    if (before.context.status !== 'available' || !locator) throw new DocumentAccessError('permission-denied', 'This passage is not part of the original question')
    const focused = await this.answers.focusLocator(conversationId, locator, authorize, signal)
    const after = this.load(conversationId, target)
    if (enrichmentHash(before.context) !== enrichmentHash(after.context)) throw new DocumentAccessError('stale', 'Question source context changed during focus')
    const value: QuestionSelectionFocus = { schemaVersion: 1, kind: 'question-selection-focus', binding: before.context.binding, target, selectionContextId, locatorId, ...focused }
    parseContract('question-context', value)
    if (questionContextIssues(value).length) throw new DocumentAccessError('invalid-output', 'Invalid selected passage focus')
    return value
  }
  private load(conversationId: string, target: QuestionContextTarget): { context: QuestionContext, locators: Map<string, DocumentLocator> } {
    const view = this.answers.binding(conversationId), locators = new Map<string, DocumentLocator>()
    let origin: ProductBinding = view, submissionId: string | null = null, nativeTextHash: string | null = null
    const empty = (status: 'none' | 'unavailable', reason: QuestionContext['reason'] = null) => ({ context: {
      schemaVersion: 1 as const, kind: 'question-context' as const, binding: view, target, status, reason, requestHash: null, nativeTextHash, selectionState: null, passages: [],
    } satisfies QuestionContext, locators: new Map<string, DocumentLocator>() })
    if (target.kind === 'submission') {
      const receipt = this.control.get(this.actor, target.id)
      if (receipt.conversationId !== conversationId || receipt.generation !== view.generation) throw new DocumentAccessError('permission-denied', 'Question does not belong to this view')
      submissionId = receipt.submissionId
    } else {
      for (const candidate of this.history?.origins(conversationId, target.id) ?? []) {
        if (candidate.entryId !== target.id || candidate.binding.ownerActorId !== view.ownerActorId || candidate.binding.workspaceId !== view.workspaceId) throw new DocumentAccessError('invalid-output', 'Question origin changed')
        const user = this.control.publicUserMessageAt(this.actor, candidate.binding, target.id)
        const publication = this.answers.receipts.publication(candidate.binding, target.id)
        const leaf = user ? null : this.control.publicLeafSubmissionAt(this.actor, candidate.binding, target.id)
        const id = user?.submissionId ?? publication?.checkpoint.submissionId ?? leaf
        if (!id) continue
        if (publication) {
          const receipt = this.control.get(this.actor, id)
          if (receipt.state !== 'completed' || !receipt.checkpoint || enrichmentHash(receipt.checkpoint) !== enrichmentHash(publication.checkpoint)
            || publication.nativeTextHash !== candidate.nativeTextHash) throw new DocumentAccessError('invalid-output', 'Question answer publication changed')
        }
        origin = candidate.binding; submissionId = id; nativeTextHash = candidate.nativeTextHash; break
      }
      if (!submissionId) return empty('unavailable', 'history')
    }
    const receipt = this.control.get(this.actor, submissionId), request = this.control.recoveryInput(this.actor, submissionId)
    if (receipt.conversationId !== origin.conversationId || receipt.generation !== origin.generation || request && (request.conversationId !== origin.conversationId || request.expectedGeneration !== origin.generation || enrichmentHash(request) !== receipt.requestHash)) throw new DocumentAccessError('invalid-output', 'Question input binding changed')
    if (!request) return empty('unavailable', 'purged')
    if (!request.selectionContextIds.length) return empty('none')
    const context: QuestionContext = { schemaVersion: 1, kind: 'question-context', binding: view, target, status: 'available', reason: null,
      requestHash: receipt.requestHash, nativeTextHash, selectionState: 'consumed', passages: [] }
    for (const id of request.selectionContextIds) {
      const ticket = this.tickets.get(origin, id)
      if (ticket.submissionId !== null && (ticket.submissionId !== receipt.submissionId || ticket.requestHash !== receipt.requestHash)
        || target.kind === 'message' && ticket.state !== 'consumed') throw new DocumentAccessError('invalid-output', 'Selection does not belong to the original question')
      if (ticket.state !== 'consumed') context.selectionState = 'attached'
      for (const item of ticket.items) {
        if (!request.sourceRefs.some(source => source.documentId === item.locator.documentId && source.revisionId === item.locator.revisionId)) throw new DocumentAccessError('invalid-output', 'Selected source is outside its submitted scope')
        try {
          const originalSource = this.answers.originalDocument(origin.conversationId, item.locator.documentId, item.locator.revisionId)
          const currentSource = this.answers.originalDocument(conversationId, item.locator.documentId, item.locator.revisionId)
          for (const source of [originalSource, currentSource]) if (source.source.representationId !== item.locator.representationId || source.source.representationContentHash !== item.locator.representationContentHash) return empty('unavailable', 'source')
          if (enrichmentHash(originalSource.original) !== enrichmentHash(currentSource.original)) return empty('unavailable', 'source')
          context.passages.push({ selectionContextId: id, locatorId: item.locator.locatorId, physicalPage: item.locator.physicalPage, text: item.text, original: currentSource.original })
          locators.set(`${id}:${item.locator.locatorId}`, item.locator)
        } catch (error) {
          if (error instanceof DocumentAccessError && ['permission-denied', 'stale'].includes(error.code)) return empty('unavailable', 'source')
          throw error
        }
      }
    }
    if (this.answers.binding(conversationId).bindingId !== view.bindingId) throw new DocumentAccessError('stale', 'Question view changed')
    parseContract('question-context', context)
    if (questionContextIssues(context).length || Buffer.byteLength(JSON.stringify(context)) > 131072) throw new DocumentAccessError('invalid-output', 'Question context exceeds its bounds')
    return { context, locators }
  }
}
