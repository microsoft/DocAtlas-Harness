import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { buildSessionContext, type AgentSession, type AgentSessionRuntime, type SessionManager, type SessionStartEvent, type SessionEntry } from '@earendil-works/pi-coding-agent'
import { getSupportedThinkingLevels, type Api, type Model } from '@earendil-works/pi-ai'
import type { NativeConfiguration, NativeFileSeal, NativeLineageAction, NativeLineageApply, NativeLineageFailureProof, NativeLineageOutcome, NativeLineageProof, NativeNavigationProof, NativeSelectedHead } from '@docatlas/contracts'
import { WorkerRpcError } from './peer.js'
import { flushInitialNativeSession } from './native-state.js'
import { captureNativeSelectedHead, inspectNativeFile, verifyNativeFileSeal, verifyNativeSelectedHead, type NativeFileSnapshot } from './native-selection.js'
import { matchesNativeForkExport, nativeForkExport } from './native-fork-inheritance.js'

export const NATIVE_LINEAGE_MARKER = 'docatlas.native-lineage.v1'
type Entry = Record<string, unknown>
type Summary = NativeNavigationProof['summary']
interface Intent { version: 1, phase: 'intent', input: NativeLineageApply }
interface Navigation { version: 1, phase: 'navigation', input: NativeLineageApply, intentEntryId: string, configuration: NativeConfiguration, landingEntryId: string | null, summary: Summary }
interface ForkTarget { version: 1, phase: 'fork-target', input: NativeLineageApply, intentEntryId: string, nativeSessionId: string, configuration: NativeConfiguration, inheritedEntryCount: number, inheritanceHash: string, forkBasisSeal: NativeFileSeal }
interface ForkSource { version: 1, phase: 'fork-source', input: NativeLineageApply, intentEntryId: string, configuration: NativeConfiguration, sourceConfiguration: NativeConfiguration,
  targetHead: NativeSelectedHead, targetMarkerEntryId: string, forkFilename: string, inheritedEntryCount: number, inheritanceHash: string, forkBasisSeal: NativeFileSeal }
interface Failure { version: 1, phase: 'not-applied', input: NativeLineageApply, intentEntryId: string, reason: NativeLineageFailureProof['reason'] }
type Marker = Intent | Navigation | ForkTarget | ForkSource | Failure
export interface NativeLineageWorkerResult { outcome: NativeLineageOutcome, forkFilename?: string }
export interface NativeLineageConfigurationSeed { markerEntryId: string, configuration: NativeConfiguration }
const object = (value: unknown): value is Entry => value !== null && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(value)
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const exact = (value: Entry, keys: string) => Object.keys(value).sort().join(',') === keys.split(',').sort().join(',')
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => object(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right)
const invalid = (): never => { throw new WorkerRpcError('invalid') }
const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
function configuration(value: unknown): NativeConfiguration {
  if (!object(value) || !exact(value, 'model,thinkingLevel,steeringMode,followUpMode') || !object(value.model) || !exact(value.model, 'provider,id')
    || ![value.model.provider, value.model.id].every(item => typeof item === 'string' && item.length > 0 && item.length <= 256 && ![...item].some(character => character.codePointAt(0)! < 32 || character.codePointAt(0) === 127))
    || !levels.includes(String(value.thinkingLevel)) || !['all', 'one-at-a-time'].includes(String(value.steeringMode)) || !['all', 'one-at-a-time'].includes(String(value.followUpMode))) return invalid()
  return structuredClone(value) as unknown as NativeConfiguration
}
function input(value: unknown): NativeLineageApply {
  if (!object(value) || !exact(value, 'operationId,requestHash,expectedHead,action') || !id(value.operationId) || !digest(value.requestHash) || !object(value.expectedHead) || !object(value.action)) return invalid()
  const action = value.action
  if (!id(action.targetEntryId)) return invalid()
  if (action.kind === 'navigate') {
    if (!exact(action, 'kind,targetEntryId,summarize,instructions,replaceInstructions,label') || typeof action.summarize !== 'boolean' || typeof action.replaceInstructions !== 'boolean'
      || typeof action.instructions !== 'string' || [...action.instructions].length > 4096 || action.label !== null && (typeof action.label !== 'string' || [...action.label].length > 256)) return invalid()
  } else if (action.kind !== 'fork' || !exact(action, 'kind,targetEntryId,position') || !['before', 'at'].includes(String(action.position))) return invalid()
  return structuredClone(value) as unknown as NativeLineageApply
}
function marker(entry: Entry): Marker | undefined {
  if (entry.type !== 'custom' || entry.customType !== NATIVE_LINEAGE_MARKER) return undefined
  if (!object(entry.data) || entry.data.version !== 1) return invalid()
  const value = entry.data; input(value.input)
  const fields = { intent: 'version,phase,input', navigation: 'version,phase,input,intentEntryId,configuration,landingEntryId,summary',
    'fork-target': 'version,phase,input,intentEntryId,nativeSessionId,configuration,inheritedEntryCount,inheritanceHash,forkBasisSeal',
    'fork-source': 'version,phase,input,intentEntryId,configuration,sourceConfiguration,targetHead,targetMarkerEntryId,forkFilename,inheritedEntryCount,inheritanceHash,forkBasisSeal',
    'not-applied': 'version,phase,input,intentEntryId,reason' }
  if (typeof value.phase !== 'string' || !Object.hasOwn(fields, value.phase) || !exact(value, fields[value.phase as keyof typeof fields])) return invalid()
  if (value.phase !== 'intent' && !id(value.intentEntryId)) return invalid()
  if (['navigation', 'fork-target', 'fork-source'].includes(value.phase)) configuration(value.configuration)
  if (value.phase === 'fork-source') configuration(value.sourceConfiguration)
  if (value.phase === 'not-applied' && !['cancelled', 'sdk-rejected'].includes(String(value.reason))) return invalid()
  return structuredClone(value) as unknown as Marker
}
function path(entries: Entry[], selected: string | null): Entry[] {
  const byId = new Map(entries.map(entry => [entry.id, entry])), result: Entry[] = []
  let current = selected === null ? undefined : byId.get(selected)
  if (selected !== null && !current) return invalid()
  while (current) { result.unshift(current); current = byId.get(current.parentId); if (result.length > entries.length) return invalid() }
  return result
}
function headAt(snapshot: NativeFileSnapshot, entryCount: number, selected: string | null): NativeSelectedHead {
  const entries = snapshot.entries.slice(0, entryCount)
  path(entries, selected)
  return { version: 1, fileSeal: snapshot.prefixSeal(entryCount), selectedLeafEntryId: selected,
    contextHash: sha(canonical(buildSessionContext(entries as unknown as SessionEntry[], selected))) }
}
function nativeConfiguration(snapshot: NativeFileSnapshot, head: NativeSelectedHead, candidate: NativeConfiguration): void {
  const current = configuration(candidate), context = buildSessionContext(snapshot.entries as unknown as SessionEntry[], head.selectedLeafEntryId)
  if (!context.model || !same(current.model, { provider: context.model.provider, id: context.model.modelId }) || current.thinkingLevel !== context.thinkingLevel) return invalid()
}
function landing(before: NativeFileSnapshot, action: NativeLineageAction): string | null {
  const target = before.entries.find(entry => entry.id === action.targetEntryId)
  if (!target) return invalid()
  const user = target.type === 'message' && object(target.message) && target.message.role === 'user'
  if (action.kind === 'fork') { if (action.position === 'before' && !user) return invalid(); return action.position === 'before' ? target.parentId as string | null : target.id as string }
  return user || target.type === 'custom_message' ? target.parentId as string | null : target.id as string
}
function commonProof(sourceFile: string, cwd: string, candidate: NativeLineageApply, proof: NativeLineageProof) {
  const request = input(candidate), before = verifyNativeFileSeal(sourceFile, cwd, request.expectedHead.fileSeal)
  verifyNativeSelectedHead(sourceFile, cwd, request.expectedHead)
  landing(before, request.action)
  if (!object(proof) || proof.operationId !== request.operationId || proof.requestHash !== request.requestHash || !same(proof.action, request.action) || !same(proof.beforeHead, request.expectedHead)
    || !id(proof.intentEntryId) || !id(proof.sourceMarkerEntryId) || !id(proof.targetMarkerEntryId)) return invalid()
  verifyNativeSelectedHead(sourceFile, cwd, proof.sourceAfterHead)
  const after = verifyNativeFileSeal(sourceFile, cwd, proof.sourceAfterHead.fileSeal), at = before.entries.length
  if (after.seal.entryCount < at + 2 || after.seal.sessionId !== before.seal.sessionId || !same(after.prefixSeal(at), before.seal)) return invalid()
  const intentEntry = after.entries[at]!, intent = marker(intentEntry), terminalEntry = after.entries.at(-1)!, terminal = marker(terminalEntry)
  if (intentEntry.id !== proof.intentEntryId || intentEntry.parentId !== request.expectedHead.selectedLeafEntryId || intent?.phase !== 'intent' || !same(intent.input, request)
    || terminalEntry.id !== proof.sourceMarkerEntryId || proof.sourceAfterHead.selectedLeafEntryId !== proof.sourceMarkerEntryId || !terminal || !same(terminal.input, request)) return invalid()
  const own = after.entries.flatMap(entry => { const value = marker(entry); return value?.input.operationId === request.operationId && value.input.expectedHead.fileSeal.sessionId === before.seal.sessionId ? [value] : [] })
  if (own.length !== 2 || terminal.phase === 'intent' || terminal.intentEntryId !== intentEntry.id) return invalid()
  nativeConfiguration(after, proof.sourceAfterHead, proof.sourceConfiguration)
  return { request, before, after, terminal }
}

export function verifyNativeLineageFailureProof(sourceFile: string, cwd: string, candidate: NativeLineageApply, proof: NativeLineageFailureProof): NativeLineageFailureProof {
  const request = input(candidate)
  if (!object(proof) || !exact(proof as unknown as Entry, 'kind,operationId,requestHash,action,beforeHead,afterHead,intentEntryId,markerEntryId,reason') || proof.kind !== 'native-lineage-failure'
    || proof.operationId !== request.operationId || proof.requestHash !== request.requestHash || !same(proof.action, request.action) || !same(proof.beforeHead, request.expectedHead)
    || !id(proof.intentEntryId) || !id(proof.markerEntryId) || !['cancelled', 'sdk-rejected'].includes(proof.reason)) return invalid()
  verifyNativeSelectedHead(sourceFile, cwd, proof.beforeHead); verifyNativeSelectedHead(sourceFile, cwd, proof.afterHead)
  const before = verifyNativeFileSeal(sourceFile, cwd, proof.beforeHead.fileSeal), after = verifyNativeFileSeal(sourceFile, cwd, proof.afterHead.fileSeal)
  if (after.seal.entryCount !== before.seal.entryCount + 2 || !same(after.prefixSeal(before.seal.entryCount), before.seal)
    || proof.afterHead.selectedLeafEntryId !== proof.markerEntryId || proof.afterHead.contextHash !== proof.beforeHead.contextHash) return invalid()
  const intentEntry = after.entries[before.seal.entryCount]!, terminalEntry = after.entries.at(-1)!, intent = marker(intentEntry), terminal = marker(terminalEntry)
  if (intentEntry.id !== proof.intentEntryId || intentEntry.parentId !== proof.beforeHead.selectedLeafEntryId || terminalEntry.id !== proof.markerEntryId || terminalEntry.parentId !== intentEntry.id
    || intent?.phase !== 'intent' || terminal?.phase !== 'not-applied' || terminal.intentEntryId !== intentEntry.id || terminal.reason !== proof.reason
    || !same(intent.input, request) || !same(terminal.input, request)) return invalid()
  if (before.entries.some(entry => marker(entry)?.input.operationId === request.operationId)) return invalid()
  return structuredClone(proof)
}

/** Independent host verification; forkFile is a separately authorized private path, never browser authority. */
export function verifyNativeLineageOutcome(sourceFile: string, cwd: string, candidate: NativeLineageApply, outcome: NativeLineageOutcome, forkFile?: string, models?: readonly Model<Api>[]): NativeLineageOutcome {
  if (!object(outcome)) return invalid()
  if (outcome.status === 'not-applied') {
    if (!exact(outcome as unknown as Entry, 'status,failureProof')) return invalid()
    return { status: 'not-applied', failureProof: verifyNativeLineageFailureProof(sourceFile, cwd, candidate, outcome.failureProof) }
  }
  if (!exact(outcome as unknown as Entry, 'status,proof') || !['applied', 'replayed'].includes(outcome.status)) return invalid()
  const proof = outcome.proof, { request, before, after, terminal } = commonProof(sourceFile, cwd, candidate, proof)
  if (models) for (const config of [proof.sourceConfiguration, proof.configuration]) {
    const current = configuration(config), model = models.find(model => model.provider === current.model.provider && model.id === current.model.id)
    if (!model || !getSupportedThinkingLevels(model).includes(current.thinkingLevel)) return invalid()
  }
  if (proof.kind === 'native-navigation-proof') {
    if (!exact(proof as unknown as Entry, 'kind,operationId,requestHash,action,beforeHead,sourceAfterHead,targetHead,intentEntryId,sourceMarkerEntryId,targetMarkerEntryId,sourceConfiguration,configuration,landingEntryId,summary')
      || request.action.kind !== 'navigate' || terminal.phase !== 'navigation' || proof.targetMarkerEntryId !== proof.sourceMarkerEntryId
      || !same(proof.targetHead, proof.sourceAfterHead) || !same(proof.configuration, proof.sourceConfiguration) || !same(terminal.configuration, proof.configuration)
      || proof.landingEntryId !== landing(before, request.action) || terminal.landingEntryId !== proof.landingEntryId || !same(terminal.summary, proof.summary)) return invalid()
    const branch = path(after.entries, proof.targetHead.selectedLeafEntryId)
    if (proof.landingEntryId !== null && !branch.some(entry => entry.id === proof.landingEntryId)) return invalid()
    if (proof.summary !== null) {
      if (!request.action.summarize || !object(proof.summary) || !exact(proof.summary as unknown as Entry, 'entryId,fromEntryId,summaryHash') || !id(proof.summary.entryId) || !digest(proof.summary.summaryHash)) return invalid()
      const entry = after.entries.find(entry => entry.id === proof.summary!.entryId)
      if (!entry || entry.type !== 'branch_summary' || entry.parentId !== proof.landingEntryId || typeof entry.summary !== 'string' || sha(entry.summary) !== proof.summary.summaryHash
        || (entry.fromId === 'root' ? null : entry.fromId) !== proof.summary.fromEntryId || !branch.some(row => row.id === entry.id)
        || before.entries.some(row => row.id === entry.id)) return invalid()
    }
  } else if (proof.kind === 'native-fork-proof') {
    if (!exact(proof as unknown as Entry, 'kind,operationId,requestHash,action,beforeHead,sourceAfterHead,targetHead,intentEntryId,sourceMarkerEntryId,targetMarkerEntryId,sourceConfiguration,configuration,forkBasisSeal,inheritedEntryCount,inheritanceHash')
      || request.action.kind !== 'fork' || terminal.phase !== 'fork-source' || !forkFile || proof.targetHead.fileSeal.sessionId === before.seal.sessionId
      || proof.targetHead.selectedLeafEntryId !== proof.targetMarkerEntryId || !same(terminal.configuration, proof.configuration) || !same(terminal.sourceConfiguration, proof.sourceConfiguration)
      || !same(terminal.targetHead, proof.targetHead) || terminal.targetMarkerEntryId !== proof.targetMarkerEntryId || !same(terminal.forkBasisSeal, proof.forkBasisSeal)
      || terminal.inheritanceHash !== proof.inheritanceHash || terminal.inheritedEntryCount !== proof.inheritedEntryCount || basename(forkFile) !== terminal.forkFilename) return invalid()
    verifyNativeSelectedHead(forkFile, cwd, proof.targetHead)
    const child = verifyNativeFileSeal(forkFile, cwd, proof.targetHead.fileSeal), childMarker = marker(child.entries.at(-1)!)
    if (child.header.parentSession !== sourceFile || child.seal.tailEntryId !== proof.targetMarkerEntryId || childMarker?.phase !== 'fork-target' || childMarker.nativeSessionId !== child.seal.sessionId
      || !same(childMarker.input, request) || childMarker.intentEntryId !== proof.intentEntryId || !same(childMarker.configuration, proof.configuration)
      || !same(childMarker.forkBasisSeal, proof.forkBasisSeal) || childMarker.inheritanceHash !== proof.inheritanceHash || childMarker.inheritedEntryCount !== proof.inheritedEntryCount) return invalid()
    const basis = verifyNativeFileSeal(sourceFile, cwd, proof.forkBasisSeal)
    if (basis.seal.entryCount < before.seal.entryCount + 1 || basis.seal.entryCount >= after.seal.entryCount || !same(after.prefixSeal(basis.seal.entryCount), basis.seal)
      || !Number.isSafeInteger(proof.inheritedEntryCount) || proof.inheritedEntryCount < 0 || proof.inheritedEntryCount >= child.seal.entryCount) return invalid()
    const expected = nativeForkExport(basis.entries, request.action)
    if (expected.inheritanceHash !== proof.inheritanceHash || expected.inheritedEntryCount !== proof.inheritedEntryCount
      || !matchesNativeForkExport(expected, child.entries.slice(0, proof.inheritedEntryCount))) return invalid()
    nativeConfiguration(child, proof.targetHead, proof.configuration)
  } else return invalid()
  return structuredClone(outcome)
}

function reconstructed(source: NativeFileSnapshot, request: NativeLineageApply, index: number): NativeLineageWorkerResult {
  const row = source.entries[index]!, value = marker(row)
  if (!value || value.phase === 'intent' || value.phase === 'fork-target' || !same(value.input, request)) return invalid()
  const afterHead = headAt(source, index + 1, row.id as string), common = { operationId: request.operationId, requestHash: request.requestHash,
    beforeHead: request.expectedHead, intentEntryId: value.intentEntryId }
  if (value.phase === 'not-applied') return { outcome: { status: 'not-applied', failureProof: { kind: 'native-lineage-failure', ...common, action: request.action, afterHead, markerEntryId: row.id as string, reason: value.reason } } }
  if (value.phase === 'navigation') {
    if (request.action.kind !== 'navigate') return invalid()
    return { outcome: { status: 'replayed', proof: { kind: 'native-navigation-proof', ...common, action: request.action, sourceAfterHead: afterHead, targetHead: afterHead,
      sourceMarkerEntryId: row.id as string, targetMarkerEntryId: row.id as string, sourceConfiguration: value.configuration, configuration: value.configuration, landingEntryId: value.landingEntryId, summary: value.summary } } }
  }
  if (request.action.kind !== 'fork') return invalid()
  return { forkFilename: value.forkFilename, outcome: { status: 'replayed', proof: { kind: 'native-fork-proof', ...common, action: request.action, sourceAfterHead: afterHead,
    targetHead: value.targetHead, sourceMarkerEntryId: row.id as string, targetMarkerEntryId: value.targetMarkerEntryId, sourceConfiguration: value.sourceConfiguration, configuration: value.configuration,
    inheritedEntryCount: value.inheritedEntryCount, inheritanceHash: value.inheritanceHash, forkBasisSeal: value.forkBasisSeal } } }
}

/** Exact-key cold recovery uses only already-authorized native files, never SDK factories or navigation replay. */
export function findNativeLineageOutcome(sourceFile: string, cwd: string, candidate: NativeLineageApply, resolveFork?: (filename: string) => string, models?: readonly Model<Api>[]): NativeLineageWorkerResult | undefined {
  const request = input(candidate); verifyNativeSelectedHead(sourceFile, cwd, request.expectedHead)
  const source = inspectNativeFile(sourceFile, request.expectedHead.fileSeal.sessionId, cwd)
  const own = source.entries.flatMap((entry, index) => { const value = marker(entry); return value?.input.operationId === request.operationId ? [{ value, index }] : [] })
  if (!own.length) return undefined
  if (own.some(item => !same(item.value.input, request))) throw new WorkerRpcError('denied')
  const terminal = own.find(item => item.value.phase !== 'intent' && item.value.phase !== 'fork-target')
  if (!terminal) throw new WorkerRpcError('failed')
  const result = reconstructed(source, request, terminal.index)
  if (result.forkFilename && (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}\.jsonl$/u.test(result.forkFilename) || !resolveFork)) return invalid()
  return { ...result, outcome: verifyNativeLineageOutcome(sourceFile, cwd, request, result.outcome, result.forkFilename ? resolveFork!(result.forkFilename) : undefined, models) }
}

/** Host-approved queue seed must still identify a real same-session terminal on this selected branch. */
export function verifyNativeLineageConfigurationSeed(manager: SessionManager, candidate: NativeLineageConfigurationSeed): NativeLineageConfigurationSeed {
  if (!object(candidate) || !exact(candidate as unknown as Entry, 'markerEntryId,configuration') || !id(candidate.markerEntryId)) return invalid()
  const config = configuration(candidate.configuration), row = manager.getBranch().find(entry => entry.id === candidate.markerEntryId), value = row ? marker(row as unknown as Entry) : undefined
  const nativeSessionId = value?.phase === 'fork-target' ? value.nativeSessionId : value?.phase === 'navigation' || value?.phase === 'fork-source' ? value.input.expectedHead.fileSeal.sessionId : undefined
  const saved = value?.phase === 'fork-source' ? value.sourceConfiguration : value && 'configuration' in value ? value.configuration : undefined
  if (nativeSessionId !== manager.getSessionId() || !same(saved, config)) return invalid()
  return { markerEntryId: candidate.markerEntryId, configuration: config }
}

/** One native transition at a time. A successful handoff freezes this worker until the host joins/rebinds it. */
export class NativeLineage {
  private active = false
  private stopped = false
  private frozen = false
  private inFlight: Promise<NativeLineageWorkerResult> | undefined
  private current: NativeLineageApply | undefined
  private signal: AbortSignal | undefined
  private forkCreated: { sessionId: string, file: string, entries: Entry[] } | undefined
  private invalidated = false
  constructor(private readonly runtime: AgentSessionRuntime, private readonly models: readonly Model<Api>[], private readonly externalBusy: () => boolean) {}
  get busy(): boolean { return this.active }
  get blocked(): boolean { return this.active || this.stopped || this.frozen }
  get handoffFrozen(): boolean { return this.frozen }
  inspect(): NativeSelectedHead { return captureNativeSelectedHead(this.runtime.session.sessionManager) }
  onInvalidate(): void { if (this.active) this.invalidated = true }
  beforeSessionCreate(manager: SessionManager, event?: SessionStartEvent): void {
    if (event?.reason !== 'fork') return
    if (!this.active || this.current?.action.kind !== 'fork' || this.forkCreated) throw new WorkerRpcError('denied')
    this.forkCreated = { sessionId: manager.getSessionId(), file: manager.getSessionFile()!, entries: structuredClone(manager.getEntries()) as unknown as Entry[] }
    this.signal?.throwIfAborted()
    if (this.stopped) throw new WorkerRpcError('cancelled')
  }
  async stop(): Promise<void> { this.stopped = true; await this.runtime.session.abort(); if (this.inFlight) await Promise.allSettled([this.inFlight]); await this.runtime.session.abort() }
  resume(): void { if (this.active || this.frozen || !this.runtime.session.isIdle) throw new WorkerRpcError('denied'); this.stopped = false }
  async apply(candidate: NativeLineageApply, signal: AbortSignal): Promise<NativeLineageWorkerResult> {
    const request = input(candidate)
    if (this.blocked || this.externalBusy() || !this.runtime.session.isIdle) throw new WorkerRpcError('denied')
    const sourceSession = this.runtime.session, sourceManager = sourceSession.sessionManager, sourceFile = sourceSession.sessionFile!, cwd = sourceManager.getCwd()
    const old = findNativeLineageOutcome(sourceFile, cwd, request, filename => join(dirname(sourceFile), filename), this.models)
    if (old) return old
    const before = this.inspect()
    if (!same(before, request.expectedHead)) throw new WorkerRpcError('denied')
    const beforeSnapshot = verifyNativeFileSeal(sourceFile, cwd, before.fileSeal), landingEntryId = landing(beforeSnapshot, request.action)
    signal.throwIfAborted(); this.active = true; this.current = request; this.signal = signal; this.forkCreated = undefined; this.invalidated = false
    const abort = () => { void this.runtime.session.abort().catch(() => {}) }
    signal.addEventListener('abort', abort, { once: true })
    let terminal = false
    const work = (async (): Promise<NativeLineageWorkerResult> => {
      const initialConfiguration = this.configuration(sourceSession), intentEntryId = sourceManager.appendCustomEntry(NATIVE_LINEAGE_MARKER, { version: 1, phase: 'intent', input: request } satisfies Intent)
      captureNativeSelectedHead(sourceManager, true)
      let rejected = false, summary: Summary = null
      try {
        if (request.action.kind === 'navigate') {
          const result = await sourceSession.navigateTree(request.action.targetEntryId, { summarize: request.action.summarize, customInstructions: request.action.instructions,
            replaceInstructions: request.action.replaceInstructions, ...(request.action.label === null ? {} : { label: request.action.label }) })
          rejected = result.cancelled
          if (result.summaryEntry) summary = { entryId: result.summaryEntry.id, fromEntryId: result.summaryEntry.fromId === 'root' ? null : result.summaryEntry.fromId, summaryHash: sha(result.summaryEntry.summary) }
        } else rejected = (await this.runtime.fork(request.action.targetEntryId, { position: request.action.position })).cancelled
      } catch { rejected = true }
      await this.runtime.session.abort()
      if (!this.runtime.session.isIdle || this.externalBusy()) throw new WorkerRpcError('failed')
      if (rejected && !this.forkCreated && !this.invalidated && this.runtime.session === sourceSession) {
        const current = captureNativeSelectedHead(sourceManager)
        if (current.fileSeal.entryCount !== before.fileSeal.entryCount + 1 || current.selectedLeafEntryId !== intentEntryId || current.contextHash !== before.contextHash
          || !same(this.configuration(sourceSession), initialConfiguration)) throw new WorkerRpcError('failed')
        const reason = signal.aborted || this.stopped ? 'cancelled' : 'sdk-rejected'
        const markerEntryId = sourceManager.appendCustomEntry(NATIVE_LINEAGE_MARKER, { version: 1, phase: 'not-applied', input: request, intentEntryId, reason } satisfies Failure)
        const failureProof: NativeLineageFailureProof = { kind: 'native-lineage-failure', operationId: request.operationId, requestHash: request.requestHash, action: request.action,
          beforeHead: before, afterHead: captureNativeSelectedHead(sourceManager, true), intentEntryId, markerEntryId, reason }
        const verified = verifyNativeLineageFailureProof(sourceFile, cwd, request, failureProof)
        terminal = true; return { outcome: { status: 'not-applied', failureProof: verified } }
      }
      if (request.action.kind === 'navigate') {
        if (this.runtime.session !== sourceSession || rejected) throw new WorkerRpcError('failed')
        const config = this.configuration(sourceSession); this.recordConfiguration(sourceSession, config)
        sourceManager.appendCustomEntry(NATIVE_LINEAGE_MARKER, { version: 1, phase: 'navigation', input: request, intentEntryId, configuration: config, landingEntryId, summary } satisfies Navigation)
        captureNativeSelectedHead(sourceManager, true)
      } else {
        const child = this.runtime.session, copied = this.forkCreated
        if (!copied || child === sourceSession || child.sessionId !== copied.sessionId || child.sessionFile !== copied.file || dirname(copied.file) !== dirname(sourceFile)) throw new WorkerRpcError('failed')
        const source = inspectNativeFile(sourceFile, sourceSession.sessionId, cwd)
        let forkBasisSeal: NativeFileSeal | undefined, inheritanceHash: string | undefined
        for (let count = before.fileSeal.entryCount + 1; count <= source.entries.length; count++) {
          const exported = nativeForkExport(source.entries.slice(0, count), request.action)
          if (matchesNativeForkExport(exported, copied.entries)) { forkBasisSeal = source.prefixSeal(count); inheritanceHash = exported.inheritanceHash; break }
        }
        if (!forkBasisSeal || !inheritanceHash) throw new WorkerRpcError('failed')
        const config = this.configuration(child), sourceConfiguration = this.configuration(sourceSession)
        this.recordConfiguration(child, config); flushInitialNativeSession(child.sessionManager)
        const inheritedEntryCount = copied.entries.length
        const targetMarkerEntryId = child.sessionManager.appendCustomEntry(NATIVE_LINEAGE_MARKER, { version: 1, phase: 'fork-target', input: request, intentEntryId, nativeSessionId: child.sessionId,
          configuration: config, inheritedEntryCount, inheritanceHash, forkBasisSeal } satisfies ForkTarget)
        const targetHead = captureNativeSelectedHead(child.sessionManager, true)
        this.recordConfiguration(sourceSession, sourceConfiguration)
        sourceManager.appendCustomEntry(NATIVE_LINEAGE_MARKER, { version: 1, phase: 'fork-source', input: request, intentEntryId, configuration: config, sourceConfiguration, targetHead, targetMarkerEntryId,
          forkFilename: basename(copied.file), inheritedEntryCount, inheritanceHash, forkBasisSeal } satisfies ForkSource)
        captureNativeSelectedHead(sourceManager, true)
      }
      const result = findNativeLineageOutcome(sourceFile, cwd, request, filename => join(dirname(sourceFile), filename), this.models)
      if (!result || result.outcome.status === 'not-applied') throw new WorkerRpcError('failed')
      this.frozen = true
      terminal = true
      return { ...result, outcome: { status: 'applied', proof: result.outcome.proof } }
    })()
    this.inFlight = work
    try { return await work } finally {
      signal.removeEventListener('abort', abort); if (!terminal || this.invalidated || this.forkCreated) this.frozen = true
      this.active = false; this.current = undefined; this.signal = undefined; this.inFlight = undefined
    }
  }
  private configuration(session: AgentSession): NativeConfiguration {
    const model = session.model
    if (!model || !this.models.some(option => option.provider === model.provider && option.id === model.id)) throw new WorkerRpcError('denied')
    return configuration({ model: { provider: model.provider, id: model.id }, thinkingLevel: session.thinkingLevel, steeringMode: session.steeringMode, followUpMode: session.followUpMode })
  }
  private recordConfiguration(session: AgentSession, config: NativeConfiguration): void {
    const manager = session.sessionManager, recorded = manager.buildSessionContext()
    if (!recorded.model || !same({ provider: recorded.model.provider, id: recorded.model.modelId }, config.model)) manager.appendModelChange(config.model.provider, config.model.id)
    if (recorded.thinkingLevel !== config.thinkingLevel) manager.appendThinkingLevelChange(config.thinkingLevel)
  }
}
