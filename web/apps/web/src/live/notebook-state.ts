import type { NoteSave, NotebookMutation, ProductResearchValue, ProductSelectionTicket, ResearchPolicySet } from '@docatlas/contracts'
import { parseBrowserContract } from '@docatlas/contracts/browser'

export type NotebookCommand = NoteSave | NotebookMutation | ResearchPolicySet
export interface NotebookOwner { actorId: string, workspaceId: string, conversationId: string, bindingId: string, generation: number }
export interface NotebookPending { version: 1, confirmed: true, owner: NotebookOwner, command: NotebookCommand }
export function notebookStorageKey(owner: NotebookOwner): string { return `docatlas.live.draft.v1:${encodeURIComponent(owner.actorId)}:${encodeURIComponent(owner.workspaceId)}:@notebook:${encodeURIComponent(owner.conversationId)}` }
export const notebookOwnerKey = (owner: NotebookOwner): string => JSON.stringify([owner.actorId, owner.workspaceId, owner.conversationId, owner.bindingId, owner.generation])
export function notebookContextCurrent(expected: string, owner: NotebookOwner | null, requestedEpoch: number, currentEpoch: number): boolean { return requestedEpoch === currentEpoch && owner !== null && notebookOwnerKey(owner) === expected }
export function currentNotebookPending(pending: NotebookPending, owner: NotebookOwner): boolean { return notebookOwnerKey(pending.owner) === notebookOwnerKey(owner) }
export function notebookCommandPath(command: NotebookCommand): string { return command.kind === 'note-save' ? 'notes' : command.kind === 'research-policy-set' ? 'policy' : `notes/${encodeURIComponent(command.recordId)}` }

/** A restored command is a receipt-reconciliation candidate, never an instruction to auto-submit. */
export function parseNotebookPending(raw: string | null, owner: NotebookOwner): NotebookPending | null {
  if (raw === null) return null
  if (raw.length > 65536) throw new Error('Notebook draft exceeds its local bound')
  const value = JSON.parse(raw) as NotebookPending
  if (!value || Object.keys(value).sort().join(',') !== 'command,confirmed,owner,version' || value.version !== 1 || value.confirmed !== true || !value.owner
    || Object.keys(value.owner).sort().join(',') !== 'actorId,bindingId,conversationId,generation,workspaceId'
    || ![value.owner.actorId, value.owner.workspaceId, value.owner.conversationId, value.owner.bindingId].every(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/.test(id))
    || !Number.isSafeInteger(value.owner.generation) || value.owner.generation < 1
    || value.owner.actorId !== owner.actorId || value.owner.workspaceId !== owner.workspaceId || value.owner.conversationId !== owner.conversationId) throw new Error('Invalid Notebook draft owner')
  const command = parseBrowserContract('product-research', value.command)
  if (!['note-save', 'notebook-mutate', 'research-policy-set'].includes(command.kind) || !('expectedGeneration' in command) || command.expectedGeneration !== value.owner.generation) throw new Error('Invalid Notebook draft command')
  return { ...value, command: command as NotebookCommand }
}

export function eligibleNoteTicket(ticket: ProductSelectionTicket, owner: NotebookOwner, now = Date.now()): boolean {
  return ticket.actorId === owner.actorId && ticket.workspaceId === owner.workspaceId && ticket.conversationId === owner.conversationId
    && ticket.bindingId === owner.bindingId && ticket.generation === owner.generation && ticket.state === 'staged' && ticket.submissionId === null && Date.parse(ticket.expiresAt) > now && ticket.items.length > 0
}

/** Clear an outbox only for a matching user-authored durable receipt, never a transient runtime event. */
export function notebookReceiptMatches(pending: NotebookPending, candidate: ProductResearchValue): boolean {
  const value = parseBrowserContract('product-research', candidate), command = pending.command, owner = pending.owner
  if (!('conversationId' in value) || value.conversationId !== owner.conversationId) return false
  if (command.kind === 'note-save') {
    if (value.kind !== 'note-saved' || value.result.action !== 'create-note' || value.result.selectionContextId !== command.selectionContextId) return false
    const record = value.result.record
    return record.recordType === 'research-note' && record.selectionContextId === command.selectionContextId && record.workspaceId === owner.workspaceId
      && record.createdBy.kind === 'user' && record.createdBy.actorId === owner.actorId && record.noteKind === command.noteKind && record.body === command.body
  }
  if (command.kind === 'research-policy-set') return value.kind === 'research-session-policy' && value.version === command.expectedVersion + 1
    && value.recallPriorResearch === command.recallPriorResearch && value.contributeResearchState === command.contributeResearchState
  if (value.kind !== 'notebook-updated') return false
  const state = value.result.state
  if (state.recordId !== command.recordId || state.workspaceId !== owner.workspaceId || state.previousVersion !== command.expectedVersion || state.version !== command.expectedVersion + 1
    || state.updatedBy.kind !== 'user' || state.updatedBy.actorId !== owner.actorId) return false
  return command.action === 'edit' ? state.text === command.text.normalize('NFC').trim() : state.status === ({ archive: 'archived', delete: 'deleted', resolve: 'resolved' } as const)[command.action]
}
