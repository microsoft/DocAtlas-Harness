import {
  personalizationCommandIssues, personalizationCoreIssues, personalizationInspectIssues,
  type EditableMemoryDraft, type MemoryUse, type PersonalizationCommandRequest, type PersonalizationCommandResult,
  type PersonalizationDecision, type PersonalizationEffect, type PersonalizationInspectResult, type UserActorRef,
} from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'
import { PersonalizationStoreError, type PersonalizationStore, type PersonalizationExportAsset } from '../storage/personalization-store.js'

export type ExplicitPreferenceEffect = Extract<PersonalizationEffect, { key:
  'answer-order' | 'explanation-depth' | 'terminology-depth' | 'artifact-format' | 'comparison-layout' }>
  | { key: 'preferred-representation', value: 'pdf' | 'page-image' | 'table' | 'comparison' }
export interface ExplicitPreferenceDraft { effect: ExplicitPreferenceEffect, scope: 'global' | 'workspace' }
type ExistingCommandAction = Exclude<PersonalizationCommandRequest, { action: 'review-candidate' | 'set-preference' | 'edit' | 'pause' }>
type StripIdentity<T> = T extends unknown ? Omit<T, 'schemaVersion' | 'requestType' | 'profileId' | 'sessionId' | 'actor'> : never
/** Internal application input, not an independent wire format. The host owns every identity field. */
export type PreferenceCommand = StripIdentity<ExistingCommandAction> | {
  idempotencyKey: string
} & (
  { action: 'set-preference', preference: ExplicitPreferenceDraft }
  | { action: 'edit', memoryVersionId: string, expectedVersion: number, replacement: ExplicitPreferenceDraft, statusAfterEdit: 'active' | 'paused' }
  | { action: 'pause', memoryVersionId: string, expectedVersion: number }
)

export interface TrustedPersonalizationIdentity {
  profileId: string
  sessionId: string
  workspaceId: string
  actor: UserActorRef
  assertCurrent(): void
}
export interface RecordedPersonalizationUse { use: MemoryUse, decision: PersonalizationDecision }

type StorePort = Pick<PersonalizationStore, 'command' | 'inspect' | 'exportAsset'>
const effects = new Set(['answer-order', 'explanation-depth', 'preferred-representation', 'terminology-depth', 'artifact-format', 'comparison-layout'])
const commandFields: Record<PreferenceCommand['action'], readonly string[]> = {
  'set-session-policy': ['expectedVersion', 'policy'],
  'set-preference': ['preference'],
  edit: ['memoryVersionId', 'expectedVersion', 'replacement', 'statusAfterEdit'],
  pause: ['memoryVersionId', 'expectedVersion'],
  resume: ['memoryVersionId', 'expectedVersion'],
  forget: ['target', 'memoryVersionId', 'expectedVersion', 'expectedProfileRevision', 'mode', 'provenanceHandling', 'acknowledgeExternalRetention'],
  export: ['format', 'includeProvenanceRefs', 'includeStatuses'],
}
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(value)
function invalid(message = 'Invalid explicit personalization control'): never { throw new PersonalizationStoreError('invalid-request', message) }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid()
  return value as Record<string, unknown>
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid('Personalization input cannot supply identity, inference or unsupported fields')
}
function draft(value: unknown, identity: TrustedPersonalizationIdentity): EditableMemoryDraft {
  const input = object(value), effect = object(input.effect)
  exactKeys(input, ['effect', 'scope']); exactKeys(effect, ['key', 'value'])
  if (typeof effect.key !== 'string' || !effects.has(effect.key) || typeof effect.value !== 'string' || (input.scope !== 'global' && input.scope !== 'workspace')
    || effect.key === 'preferred-representation' && effect.value === 'markdown') invalid('Only explicit low-risk presentation preferences preserving original-PDF citations are supported')
  return {
    memoryType: effect.key === 'preferred-representation' ? 'reader-preference' : 'presentation-preference',
    effect: { key: effect.key, value: effect.value } as ExplicitPreferenceEffect,
    summary: `${effect.key}: ${effect.value}`,
    scope: input.scope === 'global' ? { kind: 'global', profileId: identity.profileId }
      : { kind: 'workspace', profileId: identity.profileId, workspaceId: identity.workspaceId },
    sensitivity: 'ordinary', policy: { apply: 'disclose' },
  }
}

/** Explicit settings only. There is deliberately no inference, decision compiler, model or MemoryUse writer port. */
export class PersonalizationControls {
  constructor(private readonly store: StorePort, private readonly identify: () => TrustedPersonalizationIdentity) {}

  command(candidate: unknown): PersonalizationCommandResult {
    const identity = this.identity(), input = object(candidate)
    if (typeof input.action !== 'string' || !Object.hasOwn(commandFields, input.action)) invalid('Unsupported personalization action')
    exactKeys(input, ['action', 'idempotencyKey', ...commandFields[input.action as PreferenceCommand['action']]])
    const fields = structuredClone(input)
    if (fields.action === 'set-preference') fields.preference = draft(fields.preference, identity)
    if (fields.action === 'edit') fields.replacement = draft(fields.replacement, identity)
    let request: PersonalizationCommandRequest
    try {
      const value = parseContract('personalization-command', { ...fields, schemaVersion: 1, requestType: 'personalization-command',
        profileId: identity.profileId, sessionId: identity.sessionId, actor: identity.actor })
      if (!('requestType' in value) || personalizationCommandIssues(value).length) invalid()
      request = value
    } catch (error) { if (error instanceof PersonalizationStoreError) throw error; invalid() }
    identity.assertCurrent()
    const result = this.store.command(request)
    identity.assertCurrent()
    const parsed = parseContract('personalization-command', result)
    if (!('resultType' in parsed) || personalizationCommandIssues(parsed, request).length) throw new PersonalizationStoreError('integrity-error', 'Personalization command receipt does not match its authorized request')
    return parsed
  }

  inspect(maxItems = 20): PersonalizationInspectResult {
    const identity = this.identity()
    const request = { schemaVersion: 1 as const, requestType: 'personalization-inspect' as const, profileId: identity.profileId, sessionId: identity.sessionId, maxItems }
    try { parseContract('personalization-inspect', request) } catch { invalid('Invalid personalization inspection bound') }
    const result = this.store.inspect(request)
    identity.assertCurrent()
    const parsed = parseContract('personalization-inspect', result)
    if (!('resultType' in parsed) || personalizationInspectIssues(parsed, request).length) throw new PersonalizationStoreError('integrity-error', 'Personalization inspection crossed its authorized identity')
    return parsed
  }

  /** Historical, matched uses only. Saved settings or planned decisions do not imply any application. */
  whyUsed(maxItems = 20): RecordedPersonalizationUse[] {
    const inspection = this.inspect(maxItems), decisions = new Map(inspection.decisions.map(decision => [decision.decisionId, decision]))
    return inspection.uses.flatMap(use => {
      const decision = decisions.get(use.decisionId)
      if (!decision) return [] // A bounded inspection may not include an older decision; never invent an explanation.
      if (personalizationCoreIssues(use, { decisions: [decision] }).length) throw new PersonalizationStoreError('integrity-error', 'Memory use does not match its recorded decision')
      return [{ use, decision }]
    })
  }

  exportAsset(assetId: string): PersonalizationExportAsset {
    const identity = this.identity()
    if (!opaque(assetId)) invalid('Invalid personalization export identifier')
    const asset = this.store.exportAsset(identity.profileId, assetId)
    identity.assertCurrent()
    if (asset.descriptor.assetId !== assetId) throw new PersonalizationStoreError('integrity-error', 'Personalization export identity changed')
    return asset
  }

  private identity(): TrustedPersonalizationIdentity {
    const value = this.identify()
    if (!value || value.actor?.kind !== 'user' || ![value.profileId, value.sessionId, value.workspaceId, value.actor.actorId].every(opaque) || typeof value.assertCurrent !== 'function') throw new PersonalizationStoreError('permission-denied', 'Explicit personalization controls require trusted human authority')
    const identity = { profileId: value.profileId, sessionId: value.sessionId, workspaceId: value.workspaceId, actor: { ...value.actor }, assertCurrent: value.assertCurrent }
    identity.assertCurrent()
    return identity
  }
}
