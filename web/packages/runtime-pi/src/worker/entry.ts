import { Writable } from 'node:stream'
import { SessionManager, SettingsManager, type AgentSessionRuntime } from '@earendil-works/pi-coding-agent'
import type { Model, Api } from '@earendil-works/pi-ai'
import { parseContract } from '@docatlas/contracts/node'
import { createPiRuntime } from '../create-runtime.js'
import { createNativeToolOptions } from '../native-operations.js'
import { PiProductDriver, type RuntimeSubmission } from '../product-driver.js'
import { WorkerCancelledResult, WorkerPeer, WorkerRpcError, workerJson, type WorkerHandler } from './peer.js'
import { createBrokerModelRuntime, record } from './model-bridge.js'
import { NativeModelPurpose } from './model-purpose.js'
import { remoteNativeBackend, string } from './native-bridge.js'
import { remoteDocuments } from './document-bridge.js'
import { createPiDocumentTools } from '../document-tools.js'
import { ProgressRelay } from './progress-relay.js'
import { openNativeSession, type NativeSessionSeal } from './session-file.js'
import { NativeControls } from './native-controls.js'
import { NativeLineage, verifyNativeLineageConfigurationSeed, type NativeLineageConfigurationSeed } from './native-lineage.js'
import { restoreNativeSelectedSession } from './native-selection.js'
import type { NativeControlApply, NativeLineageApply, NativeSelectedHead, NativeThinkingLevel } from '@docatlas/contracts'

// Diagnostics cannot become protocol authority. Native transcript entries remain Pi-owned.
const protocolWrite = process.stdout.write.bind(process.stdout)
const output = new Writable({ write: (bytes, _encoding, callback) => { protocolWrite(bytes, callback) } })
process.stdout.write = process.stderr.write.bind(process.stderr)
const handlers = new Map<string, WorkerHandler>()
const modelPurposes = new NativeModelPurpose()
let runtime: AgentSessionRuntime | undefined, driver: PiProductDriver | undefined, controls: NativeControls | undefined, lineage: NativeLineage | undefined
const peer = new WorkerPeer(process.stdin, output, handlers, () => { void shutdown() })
let closing: Promise<void> | undefined
async function shutdown(): Promise<void> {
  if (!closing) closing = (async () => { await Promise.allSettled([lineage?.stop(), controls?.stop(), driver?.dispose()]); await runtime?.dispose().catch(() => {}); modelPurposes.invalidate(); process.exit(0) })()
  return closing
}
handlers.set('runtime.init', async candidate => {
  if (runtime) throw new WorkerRpcError('denied')
  const config = record(candidate)
  if (!Array.isArray(config.models) || config.models.length === 0) throw new WorkerRpcError('invalid')
  const models = config.models as unknown as Model<Api>[]
  const modelRuntime = await createBrokerModelRuntime(peer, models, handlers, modelPurposes)
  const native = remoteNativeBackend(peer)
  const sessionManager = config.resumeFile === undefined
    ? SessionManager.create(string(config.cwd), string(config.sessionDir), { id: string(config.sessionId) })
    : config.selectedHead === undefined ? openNativeSession(string(config.resumeFile), string(config.sessionDir), config.seal as unknown as NativeSessionSeal)
      : restoreNativeSelectedSession(string(config.resumeFile), string(config.sessionDir), string(config.cwd), config.selectedHead as unknown as NativeSelectedHead)
  if (sessionManager.getSessionId() !== string(config.sessionId)) throw new WorkerRpcError('denied')
  const lineageConfiguration = config.lineageConfiguration === undefined ? undefined : verifyNativeLineageConfigurationSeed(sessionManager, config.lineageConfiguration as unknown as NativeLineageConfigurationSeed)
  const recorded = sessionManager.buildSessionContext()
  const selectedModel = recorded.model ? modelRuntime.getModel(recorded.model.provider, recorded.model.modelId) : models[0]
  const recordedThinking = sessionManager.getBranch().some(entry => entry.type === 'thinking_level_change') ? recorded.thinkingLevel as NativeThinkingLevel : undefined
  if (!selectedModel) throw new WorkerRpcError('unavailable')
  runtime = await createPiRuntime({ cwd: string(config.cwd), agentDir: string(config.agentDir), modelRuntime,
    sessionManager,
    session: { model: selectedModel, ...(recordedThinking === undefined ? {} : { thinkingLevel: recordedThinking }), toolOptions: createNativeToolOptions(native, string(config.outputDir)),
      ...(config.documents === true ? { customTools: createPiDocumentTools(remoteDocuments(peer, string(config.sessionId))) } : {}) },
    services: () => ({ settingsManager: SettingsManager.inMemory({ defaultProjectTrust: 'never' }),
      resourceLoaderOptions: { extensionExec: (command, args, cwd, options) => native.execFile!(command, args, cwd, options) } }),
    onBound: session => modelPurposes.bind(session), onInvalidate: () => { lineage?.onInvalidate(); modelPurposes.invalidate() },
    onBeforeSessionCreate: (manager, event) => lineage?.beforeSessionCreate(manager, event),
  })
  driver = new PiProductDriver(runtime.session, {
    get activeCount() { return 0 }, // Parent waits for actual native processes separately; RPC calls settle before session idle.
    abortAll: async () => { await peer.call('native.stop', null) }, resume: () => {},
  })
  controls = new NativeControls(runtime.session, models, () => driver?.busy ?? true)
  controls.initialize(lineageConfiguration)
  lineage = new NativeLineage(runtime, models, () => controls?.busy || driver?.busy || false)
  return workerJson({ sessionId: runtime.session.sessionId, sessionFile: runtime.session.sessionFile, tools: runtime.session.getActiveToolNames() })
})
handlers.set('runtime.submit', async (candidate, call) => {
  if (!driver || !runtime || controls?.busy || lineage?.blocked) throw new WorkerRpcError('denied')
  const value = record(candidate)
  const request = parseContract('product-control', value.request), receipt = parseContract('product-control', value.receipt), prepared = parseContract('product-control', value.prepared)
  if (request.kind !== 'submission' || receipt.kind !== 'run-receipt' || prepared.kind !== 'prepared') throw new WorkerRpcError('invalid')
  const stop = () => { void driver!.stop() }
  const relay = new ProgressRelay(progress => call.yield(workerJson({ kind: 'runtime-progress', submissionId: receipt.submissionId, progress })))
  call.signal.addEventListener('abort', stop, { once: true })
  try {
    const input: RuntimeSubmission = { request, receipt, prepared, modelText: string(value.modelText) }
    return workerJson(await driver.submit(input, () => { void call.yield({ kind: 'consumed', submissionId: receipt.submissionId }).catch(() => { peer.close() }) },
      progress => relay.push(progress)))
  } finally { relay.close(); call.signal.removeEventListener('abort', stop) }
})
handlers.set('runtime.stop', async () => { await Promise.all([lineage?.stop(), controls?.stop(), driver?.stop()]); return null })
handlers.set('runtime.resume', async () => { lineage?.resume(); driver?.resume(); controls?.resume(); return null })
handlers.set('runtime.nativeInspect', async candidate => {
  if (!controls || candidate !== null || lineage?.busy || lineage?.handoffFrozen) throw new WorkerRpcError('denied')
  return workerJson(controls.inspect())
})
handlers.set('runtime.nativeApply', async (candidate, call) => {
  if (!controls || lineage?.blocked) throw new WorkerRpcError('denied')
  const outcome = await controls.apply(candidate as unknown as NativeControlApply, call.signal)
  // A compact terminal is returned only after the actual SDK promise/hooks have joined
  // and its durable prefix has been verified. Preserve that proof across IPC cancellation;
  // an unjoined/unknown operation still throws and cannot bypass normal cancellation.
  return outcome.status === 'not-applied' || outcome.proof.action.kind === 'compact' ? new WorkerCancelledResult(workerJson(outcome)) : workerJson(outcome)
})
handlers.set('runtime.lineageInspect', async candidate => {
  if (!lineage || candidate !== null) throw new WorkerRpcError('denied')
  return workerJson(lineage.inspect())
})
handlers.set('runtime.lineageApply', async (candidate, call) => {
  if (!lineage) throw new WorkerRpcError('denied')
  const result = await lineage.apply(candidate as unknown as NativeLineageApply, call.signal)
  return new WorkerCancelledResult(workerJson(result)) // Only independently verified terminals survive cancellation.
})
handlers.set('runtime.snapshot', async () => {
  if (!runtime) throw new WorkerRpcError('denied')
  return workerJson({ sessionId: runtime.session.sessionId, sessionFile: runtime.session.sessionFile, idle: runtime.session.isIdle,
    tools: runtime.session.getActiveToolNames(), entries: runtime.session.sessionManager.getEntries() })
})
handlers.set('runtime.tools', async candidate => {
  if (!runtime || driver?.busy || controls?.busy || lineage?.blocked || !Array.isArray(candidate) || candidate.some(value => typeof value !== 'string')) throw new WorkerRpcError('invalid')
  const names = candidate as string[], available = new Set(runtime.session.getAllTools().map(tool => tool.name))
  if (names.some(name => !available.has(name))) throw new WorkerRpcError('denied')
  runtime.session.setActiveToolsByName(names); return null
})
handlers.set('runtime.compact', async (_candidate, call) => {
  if (!runtime || !controls || lineage?.blocked) throw new WorkerRpcError('denied')
  return workerJson(await controls.exclusive(() => runtime!.session.compact(), call.signal))
})
handlers.set('runtime.setModel', async (candidate, call) => {
  if (!runtime || !controls || lineage?.blocked) throw new WorkerRpcError('denied')
  const input = record(candidate), model = runtime.session.modelRuntime.getModel(string(input.provider), string(input.id))
  if (!model) throw new WorkerRpcError('denied')
  await controls.exclusive(() => runtime!.session.setModel(model), call.signal); return null
})
