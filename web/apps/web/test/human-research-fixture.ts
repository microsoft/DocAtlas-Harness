import { readFileSync } from 'node:fs'
import type { ConversationSnapshot, DocumentLocator, HumanResearchCommand, HumanResearchEntry, HumanResearchFocus, HumanResearchOperation, HumanResearchOverlay, HumanResearchOverlayQuery, HumanResearchQuery, HumanResearchWorkspace, ProductBinding, ProductSelectionProposal, ProductSourceRef } from '@docatlas/contracts'
import { humanResearchOperationId, type HumanResearchOwner, type HumanResearchPending } from '../src/live/human-research-state'
import { canonicalHash } from '../src/live/state'

const { templates } = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/human-research-cases.json', import.meta.url), 'utf8')) as { templates: {
  binding: ProductBinding, command: HumanResearchCommand, entry: HumanResearchEntry, governanceEntry: HumanResearchEntry, operation: HumanResearchOperation,
  query: HumanResearchQuery, workspace: HumanResearchWorkspace, overlayQuery: HumanResearchOverlayQuery, overlay: HumanResearchOverlay, proposal: ProductSelectionProposal, sourceRef: ProductSourceRef, locator: DocumentLocator,
} }
export async function humanResearchFixture() {
  const value = structuredClone(templates), binding = value.binding
  const owner: HumanResearchOwner = { actorId: binding.ownerActorId, workspaceId: binding.workspaceId, conversationId: binding.conversationId, bindingId: binding.bindingId, generation: binding.generation }
  const pending: HumanResearchPending = { schemaVersion: 1, owner, request: value.command }
  const operation = async (request = value.command, current = binding): Promise<HumanResearchOperation> => {
    const operationId = await humanResearchOperationId(owner, request.idempotencyKey)
    return { schemaVersion: 1, kind: 'human-research-operation', binding: current, operationId, receipt: { ...value.operation.receipt!, operationId,
      idempotencyKey: request.idempotencyKey, requestHash: await canonicalHash(request), bindingId: request.expectedBindingId, generation: request.expectedGeneration,
      action: request.action, recordId: request.action === 'create' ? 'note:human' : request.recordId, recordType: request.action === 'create' || request.action === 'revise' ? request.entry.recordType : 'research-note', recordVersion: request.action === 'create' ? 1 : request.expectedVersion + 1 } }
  }
  const snapshot: ConversationSnapshot = { schemaVersion: 1, kind: 'conversation-snapshot', binding, cursor: { streamId: '11111111-2222-4333-8444-555555555555', sequence: 0 },
    runs: [], nextRunsCursor: null, history: { checkpoint: null, messages: [], hasEarlier: false }, live: [], activity: [], liveIncomplete: false }
  const focus: HumanResearchFocus = { schemaVersion: 1, kind: 'human-research-focus', binding, focus: { schemaVersion: 1, kind: 'research-focus', conversationId: binding.conversationId,
    recordId: 'note:human', status: 'resolved', locator: value.locator, physicalPage: value.locator.physicalPage, exactText: value.proposal.quote,
    original: { ...value.sourceRef, name: 'Original.pdf', contentHash: 'f'.repeat(64), byteLength: 1000, pageCount: 20 } } }
  const values = new Map<string, string>(), storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, content: string) => { values.set(key, content) },
    removeItem: (key: string) => { values.delete(key) }, key: (index: number) => [...values.keys()][index] ?? null, get length() { return values.size } }
  return { ...value, owner, pending, operation, snapshot, focus, values, storage }
}
