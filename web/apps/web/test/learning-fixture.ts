import { readFileSync } from 'node:fs'
import { controlledProbeMaterial, createLearningProbe } from '../../../packages/core/src/personalization/controlled-presentation'
import type { AnswerManifest, ConversationSnapshot, ProductLearningCommand, ProductLearningOperation, ProductLearningView, ProductPiCheckpoint } from '@docatlas/contracts'
import { canonicalHash } from '../src/live/state'
import { learningFrame, learningMaterialPin, learningOperationId, sha256Text, type LearningOwner, type LearningPending } from '../src/live/learning-state'
import { emptyHistory } from '../src/live/history-state'
import type { LiveState } from '../src/live/client'

const raw = <T>(file: string): T => JSON.parse(readFileSync(new URL(`../../../contracts/fixtures/${file}`, import.meta.url), 'utf8')) as T
export async function learningFixture() {
  const snapshot = structuredClone(raw<{ valid: ConversationSnapshot[] }>('conversation-observations.json').valid.find(value => value.kind === 'conversation-snapshot')!)
  const binding = snapshot.binding, actor = { actorId: binding.ownerActorId, workspaceId: binding.workspaceId }
  const owner: LearningOwner = { ...actor, conversationId: binding.conversationId, bindingId: binding.bindingId, generation: binding.generation }
  const profileId = `profile:pi:${(await canonicalHash([actor.actorId, actor.workspaceId])).slice(0, 32)}`
  const manifest = { ...structuredClone(raw<{ manifest: AnswerManifest }>('m2/answer-manifest.json').manifest), sessionId: binding.conversationId, workspaceId: binding.workspaceId }
  const nativeText = 'Full native Answer with original citation markers.', material = controlledProbeMaterial(manifest, await sha256Text(nativeText))
  const probe = createLearningProbe({ profileId, profileEpoch: 0, material, evidenceFirstOnLeft: true, generatedAt: binding.createdAt })
  snapshot.runs = []; snapshot.live = []; snapshot.activity = []; snapshot.cursor.sequence = 0
  snapshot.history.messages = [{ entryId: manifest.messageId, role: 'assistant', text: nativeText, truncated: false }]
  const checkpoint = raw<{ valid: ProductPiCheckpoint[] }>('product/control.json').valid.find(value => value.kind === 'pi-checkpoint')!
  snapshot.history.checkpoint = { ...checkpoint, runtimeSessionId: binding.runtimeSessionId, leafEntryId: manifest.messageId }
  const view: ProductLearningView = { schemaVersion: 1, kind: 'learning-view', binding, profileId, profileEpoch: 0, settings: { version: 0, enabled: false },
    contributionAllowed: true, policyVersion: 1, offers: [], groups: [], messageId: manifest.messageId, comparison: { reason: 'ready', material, probe, choiceReceipt: null } }
  const request: ProductLearningCommand = { ...learningFrame(owner), kind: 'learning-command', expectedProfileEpoch: 0, idempotencyKey: 'learning:choice:fixture',
    action: 'choose', expectedPolicyVersion: 1, messageId: manifest.messageId, materialHash: material.materialHash, probeId: probe.probeId,
    selected: 'variant:evidence-first', scopeIntent: 'workspace', reasonTags: [] }
  const pending: LearningPending = { schemaVersion: 1, owner, profileId, profileEpoch: 0, material: await learningMaterialPin(profileId, 0, material), request }
  const operation = async (input: ProductLearningCommand = request, current = binding): Promise<ProductLearningOperation> => {
    const operationId = await learningOperationId(owner, input.idempotencyKey)
    const targetId = input.action === 'configure' ? `learning-settings:${(await sha256Text(profileId)).slice(0, 32)}` : input.action === 'prepare' ? probe.probeId
      : input.action === 'dismiss' ? input.offerId : input.action === 'review' ? input.candidateId : `choice:learning:${await canonicalHash([profileId, input.probeId, input.idempotencyKey])}`
    const targetVersion = input.action === 'configure' ? input.expectedSettingsVersion + 1 : input.action === 'dismiss' ? input.expectedOfferVersion + 1 : input.action === 'review' ? input.expectedCandidateVersion + 1 : 1
    return { schemaVersion: 1, kind: 'learning-operation', binding: current, profileId, profileEpoch: 0, operationId, receipt: { schemaVersion: 1, kind: 'learning-receipt', operationId,
      idempotencyKey: input.idempotencyKey, requestHash: await canonicalHash(input), actorId: owner.actorId, workspaceId: owner.workspaceId, conversationId: owner.conversationId,
      bindingId: input.expectedBindingId, generation: input.expectedGeneration, profileEpoch: input.expectedProfileEpoch, action: input.action, committedAt: binding.updatedAt,
      targetId, targetVersion, groupId: input.action === 'choose' && input.scopeIntent === 'workspace' ? 'learning-group:fixture' : input.action === 'review' ? input.groupId : null,
      candidateId: input.action === 'review' ? input.candidateId : null, memoryVersionId: null } }
  }
  const state: LiveState = { phase: 'ready', actor, conversations: [binding], nextConversation: null, selected: binding.conversationId, snapshot,
    history: emptyHistory(), connection: 'live', draft: 'An independent question', sourceRefs: [], selections: [], verifyingSelection: false,
    request: null, sending: false, stopping: false, creating: false, creationPending: false, error: '' }
  const values = new Map<string, string>(), storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) }, key: (index: number) => [...values.keys()][index] ?? null, get length() { return values.size } }
  const offer: ProductLearningView['offers'][number] = { offerId: 'learning-offer:fixture', version: 1, status: 'offered', createdAt: binding.createdAt,
    original: { profileEpoch: 0, probeId: probe.probeId, conversationId: binding.conversationId, messageId: manifest.messageId, manifestId: manifest.manifestId,
      investigationId: manifest.investigationId, sourceScopeVersionId: manifest.sourceScopeVersionId, materialHash: material.materialHash, nativeTextHash: material.nativeTextHash, mode: manifest.mode, turn: manifest.turn } }
  return { actor, binding, owner, profileId, snapshot, nativeText, material, probe, view, request, pending, operation, state, storage, values, offer }
}
