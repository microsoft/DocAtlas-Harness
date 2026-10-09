import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import type { AgentSession, SessionEntry } from '@earendil-works/pi-coding-agent'
import { buildSessionContext, findCutPoint, sessionEntryToContextMessages } from '@earendil-works/pi-coding-agent'
import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model } from '@earendil-works/pi-ai'
import type { NativeCompactFailureProof, NativeConfiguration, NativeControlAction, NativeControlApply, NativeControlHead, NativeControlOutcome, NativeControlProof, NativeModelOption, NativeRuntimeState, NativeThinkingLevel } from '@docatlas/contracts'
import { flushInitialNativeSession } from './native-state.js'
import { inspectNativeSession } from './session-file.js'
import { WorkerRpcError } from './peer.js'
import { verifyNativeLineageConfigurationSeed, type NativeLineageConfigurationSeed } from './native-lineage.js'

export const NATIVE_CONTROL_MARKER = 'docatlas.native-operation.v1'
const levels: readonly NativeThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(value)
const modelName = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && ![...value].some(character => character.codePointAt(0)! < 32 || character.codePointAt(0) === 127)
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const exact = (value: Record<string, unknown>, keys: string) => Object.keys(value).sort().join(',') === keys.split(',').sort().join(',')
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => object(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right)
const invalid = (): never => { throw new WorkerRpcError('invalid') }

interface IntentMarker { version: 1, phase: 'intent', input: NativeControlApply }
type CompactionProof = NonNullable<NativeControlProof['compaction']>
interface CommitMarker { version: 1, phase: 'committed', input: NativeControlApply, intentEntryId: string, configuration: NativeConfiguration, compaction?: CompactionProof }
interface FailureMarker { version: 1, phase: 'not-applied', input: NativeControlApply, intentEntryId: string, reason: NativeCompactFailureProof['reason'] }
type Marker = IntentMarker | CommitMarker | FailureMarker
type Entry = Record<string, unknown>

function parseHead(value: unknown): NativeControlHead {
  if (!object(value) || !exact(value, 'version,sessionId,transcriptHash,byteLength,entryCount,leafEntryId') || value.version !== 1 || !id(value.sessionId)
    || !digest(value.transcriptHash) || !Number.isSafeInteger(value.byteLength) || (value.byteLength as number) < 1 || (value.byteLength as number) > 67108864
    || !Number.isSafeInteger(value.entryCount) || (value.entryCount as number) < 0 || value.leafEntryId !== null && !id(value.leafEntryId)) return invalid()
  return structuredClone(value) as unknown as NativeControlHead
}
function parseAction(value: unknown): NativeControlAction {
  if (!object(value)) return invalid()
  if (value.kind === 'set-model' && exact(value, 'kind,provider,modelId') && modelName(value.provider) && modelName(value.modelId)) return structuredClone(value) as unknown as NativeControlAction
  if (value.kind === 'set-thinking' && exact(value, 'kind,level') && levels.includes(value.level as NativeThinkingLevel)) return structuredClone(value) as unknown as NativeControlAction
  if (value.kind === 'set-queue-mode' && exact(value, 'kind,queue,mode') && ['steering', 'follow-up'].includes(String(value.queue)) && ['all', 'one-at-a-time'].includes(String(value.mode))) return structuredClone(value) as unknown as NativeControlAction
  if (value.kind === 'compact' && exact(value, 'kind,instructions') && typeof value.instructions === 'string' && [...value.instructions].length <= 4096) return { kind: 'compact', instructions: value.instructions }
  return invalid()
}
function parseApply(value: unknown): NativeControlApply {
  if (!object(value) || !exact(value, 'operationId,requestHash,expectedHead,action') || !id(value.operationId) || !digest(value.requestHash)) return invalid()
  return { operationId: value.operationId, requestHash: value.requestHash, expectedHead: parseHead(value.expectedHead), action: parseAction(value.action) }
}
function parseConfiguration(value: unknown): NativeConfiguration {
  if (!object(value) || !exact(value, 'model,thinkingLevel,steeringMode,followUpMode') || !object(value.model) || !exact(value.model, 'provider,id')
    || !modelName(value.model.provider) || !modelName(value.model.id) || !levels.includes(value.thinkingLevel as NativeThinkingLevel)
    || !['all', 'one-at-a-time'].includes(String(value.steeringMode)) || !['all', 'one-at-a-time'].includes(String(value.followUpMode))) return invalid()
  return structuredClone(value) as unknown as NativeConfiguration
}
function parseCompaction(value: unknown): CompactionProof {
  if (!object(value) || !exact(value, 'entryId,firstKeptEntryId,tokensBefore,summaryHash') || !id(value.entryId) || !id(value.firstKeptEntryId)
    || !Number.isSafeInteger(value.tokensBefore) || (value.tokensBefore as number) < 0 || !digest(value.summaryHash)) return invalid()
  return structuredClone(value) as unknown as CompactionProof
}
function marker(entry: Entry): Marker | undefined {
  if (entry.type !== 'custom' || entry.customType !== NATIVE_CONTROL_MARKER) return undefined
  const value = entry.data
  if (!object(value) || value.version !== 1) return invalid()
  const input = parseApply(value.input)
  if (value.phase === 'intent' && exact(value, 'version,phase,input')) return { version: 1, phase: 'intent', input }
  if (value.phase === 'committed' && exact(value, `version,phase,input,intentEntryId,configuration${input.action.kind === 'compact' ? ',compaction' : ''}`) && id(value.intentEntryId)) {
    return { version: 1, phase: 'committed', input, intentEntryId: value.intentEntryId, configuration: parseConfiguration(value.configuration),
      ...(input.action.kind === 'compact' ? { compaction: parseCompaction(value.compaction) } : {}) }
  }
  if (value.phase === 'not-applied' && input.action.kind === 'compact' && exact(value, 'version,phase,input,intentEntryId,reason') && id(value.intentEntryId)
    && (value.reason === 'cancelled' || value.reason === 'sdk-rejected')) {
    return { version: 1, phase: 'not-applied', input, intentEntryId: value.intentEntryId, reason: value.reason }
  }
  return invalid()
}

/** Eligibility hint using only public SDK preparation primitives; hooks/auth may still reject execution. */
export function nativeCanCompact(session: AgentSession): boolean {
  const entries = session.sessionManager.getBranch()
  if (!entries.length || entries.at(-1)?.type === 'compaction') return false
  let boundary = 0
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!
    if (entry.type === 'compaction') { const firstKept = entries.findIndex(item => item.id === entry.firstKeptEntryId); boundary = firstKept >= 0 ? firstKept : index + 1; break }
  }
  const cut = findCutPoint(entries, boundary, entries.length, session.settingsManager.getCompactionSettings().keepRecentTokens)
  if (!entries[cut.firstKeptEntryIndex]) return false
  // Both the discarded history and a split-turn prefix occupy this same contiguous range.
  return entries.slice(boundary, cut.firstKeptEntryIndex).some(entry => entry.type !== 'compaction' && sessionEntryToContextMessages(entry).length > 0)
}

interface Prefix { entries: Entry[], ends: number[], bytes: Buffer }
/** Generic verified native prefix; unlike an Answer checkpoint it need not contain a user/assistant pair. */
function prefix(file: string, head: NativeControlHead): Prefix {
  parseHead(head)
  if (realpathSync(file) !== file) return invalid()
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.size < head.byteLength) return invalid()
    const bytes = Buffer.alloc(head.byteLength)
    let offset = 0
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) return invalid(); offset += count }
    const current = statSync(file)
    if (before.ino !== current.ino || before.dev !== current.dev || hash(bytes) !== head.transcriptHash || bytes.at(-1) !== 10) return invalid()
    const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n'); lines.pop()
    if (lines.some(line => !line)) return invalid()
    const rows = lines.map(line => JSON.parse(line) as Entry), header = rows.shift()
    if (!header || header.type !== 'session' || header.version !== 3 || header.id !== head.sessionId || rows.length !== head.entryCount) return invalid()
    const seen = new Set<string>(), ends: number[] = []
    let end = Buffer.byteLength(lines[0]!, 'utf8') + 1
    for (const [index, row] of rows.entries()) {
      if (!object(row) || !id(row.id) || seen.has(row.id) || row.parentId !== null && (!id(row.parentId) || !seen.has(row.parentId))) return invalid()
      seen.add(row.id); end += Buffer.byteLength(lines[index + 1]!, 'utf8') + 1; ends.push(end)
    }
    if ((rows.at(-1)?.id ?? null) !== head.leafEntryId) return invalid()
    return { entries: rows, ends, bytes }
  } finally { closeSync(fd) }
}
function afterEntry(head: NativeControlHead, data: Prefix, index: number): NativeControlHead {
  const byteLength = data.ends[index]!
  return { version: 1, sessionId: head.sessionId, transcriptHash: hash(data.bytes.subarray(0, byteLength)), byteLength, entryCount: index + 1, leafEntryId: data.entries[index]!.id as string }
}
function nativeConfiguration(entries: Entry[], configuration: NativeConfiguration): void {
  const context = buildSessionContext(entries as unknown as SessionEntry[])
  if (!context.model || !same(configuration.model, { provider: context.model.provider, id: context.model.modelId }) || context.thinkingLevel !== configuration.thinkingLevel) return invalid()
}
function recordedOutcome(input: NativeControlApply, head: NativeControlHead, data: Prefix, index: number): NativeControlOutcome {
  const entry = data.entries[index]!, value = marker(entry)
  if (!value || value.phase === 'intent' || !same(value.input, input)) return invalid()
  const common = { operationId: input.operationId, requestHash: input.requestHash, beforeHead: input.expectedHead,
    afterHead: afterEntry(head, data, index), intentEntryId: value.intentEntryId, markerEntryId: entry.id as string }
  if (value.phase === 'not-applied') {
    if (input.action.kind !== 'compact') return invalid()
    return { status: 'not-applied', failureProof: { ...common, action: input.action, reason: value.reason } }
  }
  return { status: 'replayed', proof: { ...common, action: input.action, configuration: value.configuration,
    ...(value.compaction ? { compaction: value.compaction } : {}) } }
}

/** Safe allowlisted model metadata, including actual SDK thinking capabilities; no routing or credentials. */
export function nativeModelOptions(models: readonly Model<Api>[]): NativeModelOption[] {
  return models.map(model => ({ provider: model.provider, id: model.id, name: model.name, thinkingLevels: [...getSupportedThinkingLevels(model)],
    contextWindow: model.contextWindow, maxTokens: model.maxTokens }))
}

/** A trusted host can reconcile a lost IPC response without re-sending a native operation. */
export function findNativeControlOutcome(file: string, inputCandidate: NativeControlApply, models?: readonly Model<Api>[]): NativeControlOutcome | undefined {
  const input = parseApply(inputCandidate)
  const header = prefix(file, input.expectedHead)
  // Read the current complete file by its independently checked actual size and hash.
  // Expected-prefix verification above rejects replacement or a different native session.
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  let bytes: Buffer
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size < header.bytes.length || info.size > 67108864) return invalid()
    bytes = Buffer.alloc(info.size)
    let offset = 0
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) return invalid(); offset += count }
  } finally { closeSync(fd) }
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trimEnd().split('\n'), last = JSON.parse(lines.at(-1)!) as Entry
  const head: NativeControlHead = { version: 1, sessionId: input.expectedHead.sessionId, byteLength: bytes.length, transcriptHash: hash(bytes), entryCount: lines.length - 1,
    leafEntryId: lines.length === 1 ? null : last.id as string }
  const data = prefix(file, head), found = data.entries.flatMap((entry, index) => { const value = marker(entry); return value && value.input.operationId === input.operationId ? [{ value, entry, index }] : [] })
  if (!found.length) return undefined
  if (found.some(item => !same(item.value.input, input))) throw new WorkerRpcError('denied')
  const terminal = found.find(item => item.value.phase !== 'intent')
  if (!terminal) throw new WorkerRpcError('failed')
  return verifyNativeControlProof(file, input, recordedOutcome(input, head, data, terminal.index), models)
}

/** Private validation used by the inherited-pipe host; never returns native entries or paths. */
export function verifyNativeRuntimeState(file: string, candidate: NativeRuntimeState, models: readonly Model<Api>[]): NativeRuntimeState {
  if (!object(candidate) || !exact(candidate as unknown as Record<string, unknown>, `head,configuration,models,thinkingLevels,busy,nativeQueue${candidate.compaction === undefined ? '' : ',compaction'}`) || typeof candidate.busy !== 'boolean'
    || !object(candidate.nativeQueue) || !exact(candidate.nativeQueue as unknown as Record<string, unknown>, 'steering,followUp')
    || !Number.isSafeInteger(candidate.nativeQueue.steering) || candidate.nativeQueue.steering < 0 || !Number.isSafeInteger(candidate.nativeQueue.followUp) || candidate.nativeQueue.followUp < 0
    || candidate.compaction !== undefined && (!object(candidate.compaction) || !exact(candidate.compaction as unknown as Entry, 'canCompact') || typeof candidate.compaction.canCompact !== 'boolean')) return invalid()
  const configuration = parseConfiguration(candidate.configuration), data = prefix(file, parseHead(candidate.head))
  const current = models.find(model => model.provider === configuration.model.provider && model.id === configuration.model.id)
  const options = nativeModelOptions(models)
  if (!current || !same(candidate.models, options) || !same(candidate.thinkingLevels, getSupportedThinkingLevels(current))) return invalid()
  nativeConfiguration(data.entries, configuration)
  return structuredClone(candidate)
}

/** A joined compact rejection is terminal only when the entire native suffix is intent + rejection. */
export function verifyNativeCompactFailureProof(file: string, inputCandidate: NativeControlApply, proof: NativeCompactFailureProof): NativeCompactFailureProof {
  const input = parseApply(inputCandidate)
  if (input.action.kind !== 'compact' || !object(proof) || !exact(proof as unknown as Entry, 'operationId,requestHash,action,beforeHead,afterHead,intentEntryId,markerEntryId,reason')
    || proof.operationId !== input.operationId || proof.requestHash !== input.requestHash || !same(proof.action, input.action) || !same(proof.beforeHead, input.expectedHead)
    || !id(proof.intentEntryId) || !id(proof.markerEntryId) || proof.reason !== 'cancelled' && proof.reason !== 'sdk-rejected') return invalid()
  const before = prefix(file, input.expectedHead), after = prefix(file, parseHead(proof.afterHead))
  if (proof.afterHead.sessionId !== input.expectedHead.sessionId || proof.afterHead.entryCount !== input.expectedHead.entryCount + 2
    || proof.afterHead.byteLength <= input.expectedHead.byteLength || !after.bytes.subarray(0, before.bytes.length).equals(before.bytes)) return invalid()
  const intentEntry = after.entries[input.expectedHead.entryCount]!, terminalEntry = after.entries.at(-1)!
  const intent = marker(intentEntry), terminal = marker(terminalEntry)
  if (intentEntry.id !== proof.intentEntryId || intentEntry.parentId !== input.expectedHead.leafEntryId || terminalEntry.id !== proof.markerEntryId || terminalEntry.parentId !== intentEntry.id
    || intent?.phase !== 'intent' || terminal?.phase !== 'not-applied' || terminal.intentEntryId !== proof.intentEntryId || terminal.reason !== proof.reason
    || !same(intent.input, input) || !same(terminal.input, input)) return invalid()
  const sameOperation = after.entries.filter(entry => marker(entry)?.input.operationId === input.operationId)
  if (sameOperation.length !== 2 || !same(buildSessionContext(before.entries as unknown as SessionEntry[]), buildSessionContext(after.entries as unknown as SessionEntry[]))) return invalid()
  return structuredClone(proof)
}

/** Private host verifier. Re-reads fixed native prefixes; a worker DTO or matching current setting is never proof. */
export function verifyNativeControlProof(file: string, inputCandidate: NativeControlApply, outcome: NativeControlOutcome, models?: readonly Model<Api>[]): NativeControlOutcome {
  const input = parseApply(inputCandidate)
  if (object(outcome) && outcome.status === 'not-applied') {
    if (!exact(outcome as unknown as Entry, 'status,failureProof')) return invalid()
    return { status: 'not-applied', failureProof: verifyNativeCompactFailureProof(file, input, outcome.failureProof) }
  }
  if (!object(outcome) || !exact(outcome as unknown as Record<string, unknown>, 'status,proof') || !['applied', 'replayed'].includes(outcome.status) || !object(outcome.proof)) return invalid()
  const proof = outcome.proof
  if (!exact(proof as unknown as Record<string, unknown>, `operationId,requestHash,action,beforeHead,afterHead,intentEntryId,markerEntryId,configuration${input.action.kind === 'compact' ? ',compaction' : ''}`)
    || proof.operationId !== input.operationId || proof.requestHash !== input.requestHash || !same(proof.action, input.action) || !same(proof.beforeHead, input.expectedHead)
    || !id(proof.intentEntryId) || !id(proof.markerEntryId) || proof.afterHead.sessionId !== input.expectedHead.sessionId) return invalid()
  const configuration = parseConfiguration(proof.configuration), before = prefix(file, input.expectedHead), after = prefix(file, parseHead(proof.afterHead))
  if (proof.afterHead.byteLength <= input.expectedHead.byteLength || !after.bytes.subarray(0, before.bytes.length).equals(before.bytes)) return invalid()
  const intentIndex = input.expectedHead.entryCount, intentEntry = after.entries[intentIndex], commitEntry = after.entries.at(-1)
  if (!intentEntry || intentEntry.id !== proof.intentEntryId || intentEntry.parentId !== input.expectedHead.leafEntryId || !commitEntry || commitEntry.id !== proof.markerEntryId) return invalid()
  const intent = marker(intentEntry), committed = marker(commitEntry)
  if (intent?.phase !== 'intent' || committed?.phase !== 'committed' || committed.intentEntryId !== proof.intentEntryId
    || !same(intent.input, input) || !same(committed.input, input) || !same(committed.configuration, configuration) || !same(committed.compaction, proof.compaction)) return invalid()
  const byId = new Map(after.entries.map(entry => [entry.id, entry])); let entry: Entry | undefined = commitEntry
  while (entry && entry.id !== intentEntry.id) entry = byId.get(entry.parentId)
  if (!entry) return invalid()
  if (input.action.kind === 'compact') {
    const effect = parseCompaction(proof.compaction), compacted = after.entries.slice(intentIndex + 1, -1).filter(entry => entry.type === 'compaction')
    const saved = compacted[0]
    if (compacted.length !== 1 || !saved || saved.id !== effect.entryId || saved.firstKeptEntryId !== effect.firstKeptEntryId || saved.tokensBefore !== effect.tokensBefore
      || typeof saved.summary !== 'string' || hash(saved.summary) !== effect.summaryHash) return invalid()
    const active = new Set<unknown>(); let selected: Entry | undefined = commitEntry
    while (selected) { active.add(selected.id); selected = byId.get(selected.parentId) }
    const keptIndex = after.entries.findIndex(item => item.id === effect.firstKeptEntryId), compactIndex = after.entries.indexOf(saved)
    if (!active.has(effect.entryId) || !active.has(effect.firstKeptEntryId) || keptIndex < 0 || keptIndex >= compactIndex
      || [intentEntry.id, commitEntry.id, saved.id].includes(effect.firstKeptEntryId)) return invalid()
  }
  const sameOperation = after.entries.flatMap(entry => { const value = marker(entry); return value && value.input.operationId === input.operationId ? [{ entry, value }] : [] })
  if (sameOperation.length !== 2 || sameOperation[0]!.entry.id !== intentEntry.id || sameOperation[1]!.entry.id !== commitEntry.id) return invalid()
  nativeConfiguration(after.entries, configuration)
  if (input.action.kind === 'set-model' && (configuration.model.provider !== input.action.provider || configuration.model.id !== input.action.modelId)) return invalid()
  if (input.action.kind === 'set-queue-mode' && configuration[input.action.queue === 'steering' ? 'steeringMode' : 'followUpMode'] !== input.action.mode) return invalid()
  if (models) {
    const model = models.find(model => model.provider === configuration.model.provider && model.id === configuration.model.id)
    if (!model || !getSupportedThinkingLevels(model).includes(configuration.thinkingLevel)) return invalid()
    if (input.action.kind === 'set-thinking' && clampThinkingLevel(model, input.action.level) !== configuration.thinkingLevel) return invalid()
  }
  return structuredClone(outcome)
}

/** Narrow SDK controller. Serialization belongs to the product scheduler and is rechecked here. */
export class NativeControls {
  private active = false
  private stopped = false
  private inFlight: Promise<unknown> | undefined
  constructor(private readonly session: AgentSession, private readonly models: readonly Model<Api>[], private readonly externalBusy: () => boolean) {}
  get busy(): boolean { return this.active }
  initialize(lineageConfiguration?: NativeLineageConfigurationSeed): void {
    if (!this.session.isIdle || this.externalBusy()) throw new WorkerRpcError('denied')
    flushInitialNativeSession(this.session.sessionManager)
    const state = this.inspect(), data = prefix(this.file(), state.head)
    let latest: { value: CommitMarker, index: number, entry: Entry } | undefined
    const branch = this.session.sessionManager.getBranch(), indexes = new Map(data.entries.map((entry, index) => [entry.id, index]))
    const seed = lineageConfiguration ? verifyNativeLineageConfigurationSeed(this.session.sessionManager, lineageConfiguration) : undefined
    for (const nativeEntry of branch) {
      const index = indexes.get(nativeEntry.id)!, entry = data.entries[index]!
      const value = marker(entry)
      // SDK forks retain original custom entries. Parent-session proofs remain historical
      // bytes; they cannot initialize this child's queues or verify against its new header.
      if (value?.phase === 'committed' && value.input.expectedHead.sessionId === this.session.sessionId) latest = { value, index, entry }
    }
    const seedAt = seed ? branch.findIndex(entry => entry.id === seed.markerEntryId) : -1, latestAt = latest ? branch.findIndex(entry => entry.id === latest!.entry.id) : -1
    if (latest && latestAt > seedAt) {
      const { value, index } = latest
      // Restore from one verified complete configuration on the active branch. Checking
      // every prior prefix again would make a long-lived configuration journal quadratic.
      const outcome = recordedOutcome(value.input, state.head, data, index)
      verifyNativeControlProof(this.file(), value.input, outcome, this.models)
      this.session.setSteeringMode(value.configuration.steeringMode); this.session.setFollowUpMode(value.configuration.followUpMode)
    } else if (seed) { this.session.setSteeringMode(seed.configuration.steeringMode); this.session.setFollowUpMode(seed.configuration.followUpMode) }
  }
  inspect(): NativeRuntimeState {
    const inspected = inspectNativeSession(this.file(), this.session.sessionId, this.session.sessionManager.getCwd())
    if (this.session.sessionManager.getLeafId() !== inspected.seal.leafEntryId || !same(this.session.sessionManager.getEntries(), inspected.entries)) throw new WorkerRpcError('failed')
    const { cwd: _cwd, ...head } = inspected.seal
    return { head, configuration: this.configuration(), models: nativeModelOptions(this.models),
    thinkingLevels: this.session.getAvailableThinkingLevels(), busy: this.active || this.externalBusy() || !this.session.isIdle,
    nativeQueue: { steering: this.session.getSteeringMessages().length, followUp: this.session.getFollowUpMessages().length }, compaction: { canCompact: nativeCanCompact(this.session) } }
  }
  async exclusive<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.stopped || this.active || this.externalBusy() || !this.session.isIdle) throw new WorkerRpcError('denied')
    this.active = true
    const abort = () => { void this.session.abort().catch(() => {}) }
    signal?.addEventListener('abort', abort, { once: true })
    const running = (async () => { signal?.throwIfAborted(); return work() })()
    this.inFlight = running
    try { return await running } finally { signal?.removeEventListener('abort', abort); if (this.inFlight === running) this.inFlight = undefined; this.active = false }
  }
  async stop(): Promise<void> { this.stopped = true; await this.session.abort(); if (this.inFlight) await Promise.allSettled([this.inFlight]) }
  resume(): void { if (this.active || this.inFlight || !this.session.isIdle) throw new WorkerRpcError('denied'); this.stopped = false }
  async apply(candidate: NativeControlApply, signal: AbortSignal): Promise<NativeControlOutcome> {
    const input = parseApply(candidate)
    return this.exclusive(async () => {
      const check = () => { signal.throwIfAborted(); if (this.stopped) throw new WorkerRpcError('cancelled') }
      check()
      const current = this.inspect(), data = prefix(this.file(), current.head)
      const existing = data.entries.flatMap((entry, index) => { const value = marker(entry); return value && value.input.operationId === input.operationId ? [{ entry, index, value }] : [] })
      if (existing.some(item => !same(item.value.input, input))) throw new WorkerRpcError('denied')
      if (existing.length) {
        const terminal = existing.find(item => item.value.phase !== 'intent')
        if (!terminal) throw new WorkerRpcError('failed') // durable intent, outcome unknown; never execute again
        const outcome = recordedOutcome(input, current.head, data, terminal.index)
        check(); return verifyNativeControlProof(this.file(), input, outcome, this.models)
      }
      if (!same(input.expectedHead, current.head)) throw new WorkerRpcError('denied')
      const action = input.action
      const model = action.kind === 'set-model' ? this.models.find(model => model.provider === action.provider && model.id === action.modelId) : undefined
      if (input.action.kind === 'set-model' && !model) throw new WorkerRpcError('denied')
      if (action.kind === 'compact' && !nativeCanCompact(this.session)) throw new WorkerRpcError('denied')
      check()
      const intentEntryId = this.session.sessionManager.appendCustomEntry(NATIVE_CONTROL_MARKER, { version: 1, phase: 'intent', input } satisfies IntentMarker)
      this.durable()
      if (input.action.kind === 'compact') return this.compact(input, intentEntryId, current, signal)
      if (input.action.kind === 'set-model') {
        const available = this.session.modelRuntime.getModel(model!.provider, model!.id)
        if (!available) throw new WorkerRpcError('denied')
        await this.session.setModel(available)
      } else if (input.action.kind === 'set-thinking') this.session.setThinkingLevel(input.action.level)
      else if (input.action.queue === 'steering') this.session.setSteeringMode(input.action.mode)
      else this.session.setFollowUpMode(input.action.mode)
      check()
      if (!this.session.isIdle) throw new WorkerRpcError('failed')
      const configuration = this.configuration()
      const markerEntryId = this.session.sessionManager.appendCustomEntry(NATIVE_CONTROL_MARKER, { version: 1, phase: 'committed', input, intentEntryId, configuration } satisfies CommitMarker)
      const afterHead = this.durable()
      return verifyNativeControlProof(this.file(), input, { status: 'applied', proof: { operationId: input.operationId, requestHash: input.requestHash, action: input.action,
        beforeHead: input.expectedHead, afterHead, intentEntryId, markerEntryId, configuration } }, this.models)
    }, signal)
  }
  private async compact(input: NativeControlApply, intentEntryId: string, before: NativeRuntimeState, signal: AbortSignal): Promise<NativeControlOutcome> {
    if (input.action.kind !== 'compact') return invalid()
    const queue = { steering: this.session.getSteeringMessages(), followUp: this.session.getFollowUpMessages() }
    // compact() first awaits abort() before installing its own controller. Cover cancellation
    // in that await gap, without replacing the native operation or an SDK-owned signal.
    const detach = this.session.subscribe(event => { if (event.type === 'compaction_start' && (signal.aborted || this.stopped)) this.session.abortCompaction() })
    let rejected = false
    try { await this.session.compact(input.action.instructions) } catch { rejected = true } finally { detach() }
    // SDK idle can become true before async failure/extension callbacks have finished.
    // Awaiting the actual compact promise above is the essential join, not the idle flag.
    await this.session.abort()
    const current = this.inspect(), data = prefix(this.file(), current.head), start = input.expectedHead.entryCount
    if (!this.session.isIdle || this.externalBusy() || !same(queue, { steering: this.session.getSteeringMessages(), followUp: this.session.getFollowUpMessages() })) throw new WorkerRpcError('failed')
    const effects = data.entries.slice(start + 1).filter(entry => entry.type === 'compaction')
    if (effects.length === 1) {
      const entry = effects[0]!
      const compaction = parseCompaction({ entryId: entry.id, firstKeptEntryId: entry.firstKeptEntryId, tokensBefore: entry.tokensBefore,
        summaryHash: typeof entry.summary === 'string' ? hash(entry.summary) : undefined })
      const configuration = this.configuration()
      const markerEntryId = this.session.sessionManager.appendCustomEntry(NATIVE_CONTROL_MARKER, { version: 1, phase: 'committed', input, intentEntryId, configuration, compaction } satisfies CommitMarker)
      const afterHead = this.durable()
      return verifyNativeControlProof(this.file(), input, { status: 'applied', proof: { operationId: input.operationId, requestHash: input.requestHash, action: input.action,
        beforeHead: input.expectedHead, afterHead, intentEntryId, markerEntryId, configuration, compaction } }, this.models)
    }
    // No native effect is inferred from an error string. A terminal rejection requires
    // the unchanged prefix, one intent row, same branch/configuration, and joined SDK.
    if (!rejected || effects.length || current.head.entryCount !== start + 1 || current.head.leafEntryId !== intentEntryId || !same(current.configuration, before.configuration)
      || !same(data.entries.slice(0, start), prefix(this.file(), input.expectedHead).entries)) throw new WorkerRpcError('failed')
    const reason = signal.aborted || this.stopped ? 'cancelled' : 'sdk-rejected'
    const markerEntryId = this.session.sessionManager.appendCustomEntry(NATIVE_CONTROL_MARKER, { version: 1, phase: 'not-applied', input, intentEntryId, reason } satisfies FailureMarker)
    const failureProof: NativeCompactFailureProof = { operationId: input.operationId, requestHash: input.requestHash, action: input.action, beforeHead: input.expectedHead,
      afterHead: this.durable(), intentEntryId, markerEntryId, reason }
    return { status: 'not-applied', failureProof: verifyNativeCompactFailureProof(this.file(), input, failureProof) }
  }
  private file(): string { const file = this.session.sessionFile; if (!file) throw new WorkerRpcError('failed'); return file }
  private configuration(): NativeConfiguration {
    const model = this.session.model
    if (!model || !this.models.some(option => option.provider === model.provider && option.id === model.id)) throw new WorkerRpcError('denied')
    return parseConfiguration({ model: { provider: model.provider, id: model.id }, thinkingLevel: this.session.thinkingLevel,
      steeringMode: this.session.steeringMode, followUpMode: this.session.followUpMode })
  }
  private durable(): NativeControlHead {
    const { cwd: _cwd, ...head } = inspectNativeSession(this.file(), this.session.sessionId, this.session.sessionManager.getCwd(), true).seal
    if (head.leafEntryId !== this.session.sessionManager.getLeafId()) throw new WorkerRpcError('failed')
    return head
  }
}
