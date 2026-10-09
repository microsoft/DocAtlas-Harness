import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ControlStore, ProductAuth, ResourceStore, RuntimeCatalog, RuntimeManager, DocumentApplication, UploadStore, DocumentHttp, PersonalizationService, ProductPersonalization, createProductHttpHandler } from '../../apps/server/lib/index.js'
import type { ProductBinding } from '../../packages/contracts/lib/index.js'

const requireServer = createRequire(new URL('../../apps/server/package.json', import.meta.url))
const { createPiTestModel } = await import(requireServer.resolve('@docatlas/runtime-pi/testing')) as typeof import('../../packages/runtime-pi/lib/testing.js')
const { createEnrichmentModel, createTreeSearchModel } = await import(requireServer.resolve('@docatlas/runtime-pi')) as typeof import('../../packages/runtime-pi/lib/index.js')
const { PersonalizationStore } = await import(requireServer.resolve('@docatlas/core')) as typeof import('../../packages/core/lib/index.js')
export async function liveHarness(options: { beforeResponse?: (signal: AbortSignal | undefined) => Promise<void>, answers?: Parameters<typeof createPiTestModel>[0]['answers'], models?: Parameters<typeof createPiTestModel>[0]['models'], tokenSize?: Parameters<typeof createPiTestModel>[0]['tokenSize'], documents?: boolean, enrichmentAnswers?: string[], searchAnswers?: string[], beforeEnrichment?: (signal: AbortSignal | undefined) => Promise<void> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-browser-live-')), cleanup: Array<() => void | Promise<void>> = [() => rmSync(root, { recursive: true, force: true })]
  const close = async () => { while (cleanup.length) await cleanup.pop()!() }
  try {
    const work = join(root, 'work'), agent = join(root, 'agent'), state = join(root, 'private')
    for (const path of [work, agent, state]) mkdirSync(path)
    const actor = { actorId: 'actor:browser', workspaceId: 'workspace:browser' }, conversationId = 'conversation:browser', sessionId = randomUUID()
    const control = ControlStore.open(join(state, 'control')); cleanup.push(() => control.close())
    control.createConversation(actor, { conversationId, runtimeSessionId: sessionId })
    const resources = new ResourceStore(join(root, 'resources'), [state]); cleanup.push(() => resources.close())
    const snapshot = resources.capture(agent), approval = resources.approve(actor, snapshot.snapshotId, snapshot.manifestHash)
    const contexts: string[] = []; let policyPrepareCount = 0
    const model = await createPiTestModel({ answers: options.answers ?? ['这是真实 Pi 通路的测试回答。<script>window.untrusted = true</script>'], inspectMessages: messages => contexts.push(JSON.stringify(messages)), ...(options.models ? { models: options.models } : {}), ...(options.tokenSize === undefined ? {} : { tokenSize: options.tokenSize }), ...(options.beforeResponse ? { beforeResponse: options.beforeResponse } : {}) })
    const catalog = new RuntimeCatalog(join(state, 'catalog')); cleanup.push(() => catalog.close())
    const uploads = options.documents ? new UploadStore(join(state, 'upload-metadata'), join(root, 'uploads'), actor) : undefined
    if (uploads) cleanup.push(() => uploads.close())
    const documents = uploads ? await DocumentApplication.create({ control, actor, discovery: uploads, domainRoot: join(state, 'document-domain'),
      projectRoot: resolve('.'), cacheRoot: join(root, 'document-cache'), sourceRoots: { uploads: uploads.filesRoot }, protectedRoots: [state, resources.root, join(root, 'runtime-state')] }) : undefined
    if (documents) cleanup.push(() => documents.close())
    const enrichmentModel = options.enrichmentAnswers ? await createPiTestModel({ answers: options.enrichmentAnswers, ...(options.beforeEnrichment ? { beforeResponse: options.beforeEnrichment } : {}) }) : undefined
    if (documents && enrichmentModel) documents.enableEnrichments(createEnrichmentModel(enrichmentModel.modelRuntime, enrichmentModel.models[0]!, () => { control.binding(actor, conversationId) }))
    const searchModel = options.searchAnswers ? await createPiTestModel({ answers: options.searchAnswers }) : undefined
    if (documents && searchModel) documents.enableTreeSearch(createTreeSearchModel(searchModel.modelRuntime, searchModel.models[0]!, () => { control.binding(actor, conversationId) }))
    const profiles = documents ? await PersonalizationStore.open(join(state, 'personal-domain')) : undefined
    if (profiles) cleanup.push(() => profiles.close())
    const personalization = profiles ? new PersonalizationService(profiles, control) : undefined
    const preferenceApplication = profiles && personalization && documents ? new ProductPersonalization(profiles, personalization, control, actor, documents.research) : undefined
    if (preferenceApplication) cleanup.push(() => preferenceApplication.close())
    const documentHttp = documents && uploads && personalization ? new DocumentHttp(documents, uploads, join(root, 'document-cache'), personalization) : undefined
    const manager = new RuntimeManager({ ...model, control, catalog, resources, actor, approvalId: approval.approvalId, workspaceRoot: work,
      stateRoot: join(root, 'runtime-state'), rgExecutable: realpathSync(execFileSync('which', ['rg'], { encoding: 'utf8' }).trim()),
      ...(documents ? { protectedRoots: [state, join(root, 'uploads'), join(root, 'document-cache')], services: (binding: ProductBinding) => {
        const source = documents.forConversation(binding.conversationId), policy = preferenceApplication?.policy(binding)
        return { prepare: documents.prepare, documents: { operations: source.operations, boundary: source.backend, invalidate: () => source.session.invalidate(), onCheckpoint: source.onCheckpoint },
          ...(policy ? { modelPolicy: { prepare: (input: Parameters<typeof policy.prepare>[0]) => { policyPrepareCount++; return policy.prepare(input) } } } : {}) }
      } } : {}) })
    cleanup.push(() => manager.close())
    const { coordinator, native, worker } = await manager.get(actor, conversationId)
    documents?.questionContexts.enableHistoricalOrigins({ origins: (id, entry) => manager.historyAccess(actor, id).origins(id, entry), frames: id => manager.historyAccess(actor, id).frames(id) })
    const dist = resolve(process.env.DOCATLAS_E2E_WEB_ROOT ?? 'apps/web/dist'), assets = new Map<string, { bytes: Buffer, type: string }>()
    const types: Record<string, string> = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }
    assets.set('/live.html', { bytes: readFileSync(join(dist, 'live.html')), type: 'text/html; charset=utf-8' })
    for (const name of readdirSync(join(dist, 'assets'))) if (types[extname(name)]) assets.set(`/assets/${name}`, { bytes: readFileSync(join(dist, 'assets', name)), type: types[extname(name)]! })
    assets.set('/favicon.svg', { bytes: readFileSync(join(dist, 'favicon.svg')), type: 'image/svg+xml' })
    for (const directory of ['cmaps', 'standard_fonts', 'wasm']) for (const name of readdirSync(join(dist, 'pdfjs', directory))) assets.set(`/pdfjs/${directory}/${name}`, { bytes: readFileSync(join(dist, 'pdfjs', directory, name)), type: name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' })
    let handler: ReturnType<typeof createProductHttpHandler> | undefined
    const server = createServer((request, response) => {
      response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
      response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Cache-Control', 'no-store')
      if (request.url?.startsWith('/api/')) { handler!(request, response); return }
      const asset = assets.get(request.url ?? '')
      if (request.method !== 'GET' || !asset) { response.writeHead(404); response.end(); return }
      response.writeHead(200, { 'Content-Type': asset.type }); response.end(asset.bytes)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, auth = new ProductAuth(origin, undefined, undefined, actor)
    handler = createProductHttpHandler({ auth, control, coordinator: async (actor, id) => (await manager.get(actor, id)).coordinator,
      native: { inspect: (who, id) => manager.nativeInspect(who, id), command: (who, id, input, check) => manager.nativeCommand(who, id, input, check),
        operation: (who, id, operation) => manager.nativeOperation(who, id, operation) }, history: (who, id) => manager.history(who, id),
      observations: (actor, id) => manager.observations(actor, id), createConversation: (actor, key) => manager.create(actor, key), ...(documentHttp ? { documents: () => documentHttp } : {}) })
    // The worker is private fixture access for independent native-file assertions, never an HTTP/browser capability.
    return { origin, model, contexts, getPolicyPrepareCount: () => policyPrepareCount, documents, enrichmentModel, searchModel, coordinator, native, worker, close }
  } catch (error) { await close(); throw error }
}
