import { PersonalizationApplication, PersonalizationStoreError, enrichmentHash, type PersonalizationStore, type ObservedPersonalizationGeneration, type PersonalizationApplicationPlan } from '@docatlas/core'
import type { ModelRequestPolicy, PreparedModelRequestPolicy } from '@docatlas/runtime-pi/worker'
import type { ProductBinding } from '@docatlas/contracts'
import type { ProductResearch } from '../documents/research.js'
import type { ControlStore, ProductActor } from '../storage/control-store.js'
import { PersonalizationService, workspaceProfileId, type PersonalizationChange } from './service.js'

interface ActiveUse { controller: AbortController, profileId: string, conversationId: string, submissionId: string }

/** Ephemeral host request guidance, never native history or an additional agent/model loop. */
export class ProductPersonalization {
  private readonly active = new Set<ActiveUse>()
  private readonly applied = new Map<string, { profileId: string, submissionId: string }>()
  private readonly revoked = new Map<string, Set<string>>()
  private readonly unsubscribe: () => void
  private readonly disconnect: () => void
  private closed = false
  constructor(private readonly store: PersonalizationStore, readonly controls: PersonalizationService, private readonly control: ControlStore,
    private readonly actor: ProductActor, private readonly research: Pick<ProductResearch, 'consumedFrame'>) {
    this.disconnect = controls.connectModelApplication()
    this.unsubscribe = controls.onChange(change => this.changed(change))
  }
  policy(binding: ProductBinding): ModelRequestPolicy {
    this.assertBinding(binding)
    return { prepare: input => {
      this.assertBinding(binding); input.signal.throwIfAborted()
      const frame = this.research.consumedFrame(binding.conversationId)
      // Startup and compaction outside a precisely consumed user request are not personalization uses.
      if (!frame) { this.applied.delete(binding.conversationId); return { context: input.context } }
      if (frame.binding.bindingId !== binding.bindingId) throw new PersonalizationStoreError('conflict', 'Model personalization binding changed')
      if (this.applied.get(binding.conversationId)?.submissionId !== frame.submissionId) this.applied.delete(binding.conversationId)
      if (this.wasRevoked(binding.conversationId, frame.submissionId)) throw new PersonalizationStoreError('conflict', 'Preferences changed during this generation; a new user submission is required')
      const profileId = workspaceProfileId(this.actor), policy = this.store.sessionPolicy(profileId, binding.conversationId)
      if (!policy?.useExisting) return { context: input.context }
      const baselineDigest = enrichmentHash({ model: input.model, context: input.context, scopeVersionId: frame.scopeVersionId })
      const controller = new AbortController(), lifetime = AbortSignal.any([input.signal, controller.signal])
      const check = () => { lifetime.throwIfAborted(); this.assertBinding(binding); frame.assertCurrent(); lifetime.throwIfAborted() }
      const observationId = `generation:${enrichmentHash([binding.bindingId, frame.submissionId, input.callId]).slice(0, 48)}`
      let observed: ObservedPersonalizationGeneration | undefined, issued: PersonalizationApplicationPlan | undefined
      const application = new PersonalizationApplication(this.store, {
        identity: () => ({ actorId: this.actor.actorId, profileId, sessionId: binding.conversationId, workspaceId: binding.workspaceId,
          submissionId: frame.submissionId, turn: this.control.submissionOrdinal(this.actor, frame.submissionId), sourceScopeVersionId: frame.scopeVersionId,
          baselineDigest, mode: 'explore', assertCurrent: check }),
        beforeDecision: () => { check(); frame.ensureSnapshot(); check() },
        assertObservedGeneration: (candidate, plan) => {
          check()
          if (!observed || issued !== plan || candidate.observationId !== observed.observationId || candidate.observedAt !== observed.observedAt) throw new PersonalizationStoreError('permission-denied', 'The host has not observed generated answer text for this use')
        },
      })
      issued = application.prepare()
      if (!issued) return { context: input.context }
      const plan = issued, active: ActiveUse = { controller, profileId, conversationId: binding.conversationId, submissionId: frame.submissionId }
      if (this.active.size >= 64) throw new PersonalizationStoreError('limit-exceeded', 'Personalization generation capacity reached')
      this.active.add(active)
      this.applied.set(binding.conversationId, { profileId, submissionId: frame.submissionId })
      const checkPlan = () => {
        try { check(); application.assertUsable(plan) }
        catch (error) {
          // Expiry or source/frame invalidation is sticky as well as explicit user revocation.
          this.markRevoked(binding.conversationId, frame.submissionId)
          controller.abort(new Error('The admitted personalization plan is no longer current'))
          throw error
        }
      }
      const observe = () => {
        checkPlan()
        if (observed) return
        observed = { observationId, observedAt: new Date().toISOString() }
        // A real provider text event is the witness. This is not a compliance or factual-quality verdict.
        application.recordObservedUse(plan, observed)
        check()
      }
      const result: PreparedModelRequestPolicy = {
        context: { ...input.context, systemPrompt: `${input.context.systemPrompt ?? ''}\n\n${plan.instruction}` }, signal: lifetime,
        onEvent: event => { checkPlan(); if (event.type === 'text_delta' && event.delta.trim()) observe() },
        onResult: answer => { checkPlan(); if (answer.stopReason !== 'error' && answer.stopReason !== 'aborted'
          && answer.content.some(block => block.type === 'text' && block.text.trim())) observe() },
        // The broker calls close after the actual provider result/stream has joined.
        close: () => { this.active.delete(active); controller.abort() },
      }
      return result
    } }
  }
  close(): void {
    if (this.closed) return
    this.closed = true; this.unsubscribe(); this.disconnect()
    for (const item of this.active) item.controller.abort(new Error('Personalization application closed'))
    this.revoked.clear(); this.applied.clear()
  }
  private changed(change: PersonalizationChange): void {
    // A submission can be executing native tools between two provider calls. Revocation spans that gap too.
    for (const [conversationId, item] of this.applied) if (item.profileId === change.profileId && (change.scope === 'profile' || conversationId === change.conversationId)) {
      try {
        const frame = this.research.consumedFrame(conversationId)
        if (!frame || frame.submissionId !== item.submissionId) { this.applied.delete(conversationId); continue }
      } catch { /* Failed current-source authorization cannot re-enable previously applied guidance. */ }
      this.markRevoked(conversationId, item.submissionId)
    }
    for (const item of this.active) if (item.profileId === change.profileId && (change.scope === 'profile' || item.conversationId === change.conversationId)) {
      this.markRevoked(item.conversationId, item.submissionId)
      item.controller.abort(new Error('Explicit preferences changed; this generation cannot continue with the old guidance'))
    }
  }
  private markRevoked(conversationId: string, submissionId: string): void {
    if (this.closed) return
    const items = this.revoked.get(conversationId) ?? new Set<string>()
    items.add(submissionId); this.revoked.set(conversationId, items)
  }
  private wasRevoked(conversationId: string, submissionId: string): boolean {
    const items = this.revoked.get(conversationId)
    if (!items) return false
    // Retain current/actually in-flight identities only. An older callback must never overwrite a newer revocation.
    for (const id of items) if (id !== submissionId && ![...this.active].some(item => item.conversationId === conversationId && item.submissionId === id)) items.delete(id)
    const revoked = items.has(submissionId)
    if (!items.size) this.revoked.delete(conversationId)
    return revoked
  }
  private assertBinding(binding: ProductBinding): void {
    if (this.closed) throw new PersonalizationStoreError('conflict', 'Personalization application is closed')
    const current = this.control.binding(this.actor, binding.conversationId)
    if (current.bindingId !== binding.bindingId || current.runtimeSessionId !== binding.runtimeSessionId || current.generation !== binding.generation
      || binding.ownerActorId !== this.actor.actorId || binding.workspaceId !== this.actor.workspaceId) throw new PersonalizationStoreError('permission-denied', 'Personalization crossed its authenticated runtime binding')
  }
}
