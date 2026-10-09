import { createHash } from 'node:crypto'
import { PersonalizationControls, PersonalizationStoreError, type PersonalizationStore, type SourceScopeStore } from '@docatlas/core'
import { ControlStore, type ProductActor } from '../storage/control-store.js'
import type { ProductAnswers } from '../documents/answers.js'
import { ProductProbes } from './probes.js'
import { ProductLearning } from './learning.js'

export interface PersonalizationChange { profileId: string, conversationId: string, scope: 'profile' | 'conversation' }

/** Explicit workspace-beta identity: global scope means all tasks in this profile, not other workspaces. */
export function workspaceProfileId(actor: ProductActor): string {
  if (![actor.actorId, actor.workspaceId].every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(value))) throw new PersonalizationStoreError('permission-denied', 'Invalid authenticated personalization identity')
  return `profile:pi:${createHash('sha256').update(JSON.stringify([actor.actorId, actor.workspaceId])).digest('hex').slice(0, 32)}`
}

/** Trusted host service only. The HTTP composition supplies the paired actor, never a browser body or model call. */
export class PersonalizationService {
  private readonly listeners = new Set<(change: PersonalizationChange) => void>()
  private applicationConnected = false
  private learningApplication: ProductLearning | undefined
  constructor(private readonly store: PersonalizationStore, private readonly control: ControlStore) {}
  probes(answers: ProductAnswers): ProductProbes {
    return new ProductProbes(this.store, this.control, answers, workspaceProfileId, (actor, conversationId) => {
      const profileId = workspaceProfileId(actor)
      for (const listener of this.listeners) try { listener({ profileId, conversationId, scope: 'profile' }) } catch { /* A committed confirmation remains committed. */ }
    })
  }
  learning(answers: ProductAnswers, domain: SourceScopeStore): ProductLearning {
    return this.learningApplication ??= new ProductLearning(this.store, this.control, answers, domain, workspaceProfileId, (actor, conversationId) => {
      const profileId = workspaceProfileId(actor)
      for (const listener of this.listeners) try { listener({ profileId, conversationId, scope: 'profile' }) } catch { /* Explicit adoption remains committed. */ }
    })
  }
  command(actor: ProductActor, conversationId: string, candidate: unknown, expectedProfileEpoch = 0) {
    const controls = this.controls(actor, conversationId, expectedProfileEpoch), profileId = workspaceProfileId(actor)
    const before = this.store.sessionPolicy(profileId, conversationId)?.useExisting ?? false
    const result = controls.command(candidate)
    if (result.status !== 'replayed' && result.action !== 'export' && (result.action !== 'set-session-policy' || result.sessionPolicy.useExisting !== before)) {
      for (const listener of this.listeners) try { listener({ profileId, conversationId, scope: result.action === 'set-session-policy' ? 'conversation' : 'profile' }) } catch { /* A notification cannot undo a committed user control. */ }
    }
    return result
  }
  connectModelApplication(): () => void {
    if (this.applicationConnected) throw new PersonalizationStoreError('conflict', 'A model application is already connected')
    this.applicationConnected = true
    return () => { this.applicationConnected = false }
  }
  get modelApplication(): 'host-ephemeral' | 'not-connected' { return this.applicationConnected ? 'host-ephemeral' : 'not-connected' }
  onChange(listener: (change: PersonalizationChange) => void): () => void {
    if (this.listeners.size >= 64) throw new PersonalizationStoreError('limit-exceeded', 'Personalization observer limit reached')
    this.listeners.add(listener); return () => { this.listeners.delete(listener) }
  }
  inspect(actor: ProductActor, conversationId: string, maxItems = 20) { return this.controls(actor, conversationId).inspect(maxItems) }
  profileEpoch(actor: ProductActor, conversationId: string): number {
    this.control.binding(actor, conversationId)
    return this.store.profileEpoch(workspaceProfileId(actor))
  }
  whyUsed(actor: ProductActor, conversationId: string, maxItems = 20) { return this.controls(actor, conversationId).whyUsed(maxItems) }
  exportAsset(actor: ProductActor, conversationId: string, assetId: string) { return this.controls(actor, conversationId).exportAsset(assetId) }

  private controls(actor: ProductActor, conversationId: string, expectedProfileEpoch = 0): PersonalizationControls {
    const authenticated = { actorId: actor.actorId, workspaceId: actor.workspaceId }
    const binding = this.control.binding(authenticated, conversationId)
    const profileId = workspaceProfileId(authenticated)
    const store = { command: (candidate: unknown) => this.store.command(candidate, expectedProfileEpoch),
      inspect: this.store.inspect.bind(this.store), exportAsset: this.store.exportAsset.bind(this.store) }
    return new PersonalizationControls(store, () => ({
      profileId, sessionId: binding.conversationId, workspaceId: authenticated.workspaceId,
      actor: { kind: 'user', actorId: authenticated.actorId },
      assertCurrent: () => {
        const current = this.control.binding(authenticated, conversationId)
        if (current.bindingId !== binding.bindingId || current.generation !== binding.generation || current.runtimeSessionId !== binding.runtimeSessionId) throw new PersonalizationStoreError('conflict', 'Conversation identity changed during personalization control')
      },
    }))
  }
}
