import { createServer } from 'node:http'
import { readFileSync, readdirSync, realpathSync, lstatSync, existsSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createEnrichmentModel, createTreeSearchModel } from '@docatlas/runtime-pi'
import { PersonalizationStore } from '@docatlas/core'
import { PersonalizationService } from './personalization/service.js'
import { ProductPersonalization } from './personalization/application.js'
import { ControlStore } from './storage/control-store.js'
import { ResourceStore } from './storage/resource-store.js'
import { RuntimeCatalog, dedicatedDirectory } from './storage/runtime-catalog.js'
import { RuntimeManager, type RuntimeManagerOptions } from './runs/runtime-manager.js'
import { DocumentApplication } from './documents/application.js'
import { UploadStore } from './documents/uploads.js'
import { DocumentHttp } from './documents/http.js'
import { ProductAuth } from './http/auth.js'
import { encodeStaticAsset, staticAssetCacheControl, staticEncoding, type StaticAsset } from './http/static-encoding.js'
import { createProductHttpHandler } from './http/handler.js'

export interface DocAtlasApplicationOptions {
  root: string
  projectRoot: string
  webRoot: string
  port?: number
  modelRuntime: RuntimeManagerOptions['modelRuntime']
  models: RuntimeManagerOptions['models']
  /** Explicit operator review of exactly this trusted-resource snapshot, never a browser flag. */
  trustedResourceHash?: string
  /** Trusted host configuration only; the loopback CLI uses local access without login. */
  localAccess?: boolean
}
const csp = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

/** Single-user loopback beta: real services and persistent state, not a fixture or public multi-tenant deployment. */
export async function startDocAtlasApplication(options: DocAtlasApplicationOptions) {
  const root = resolve(options.root), projectRoot = realpathSync(options.projectRoot), webRoot = realpathSync(options.webRoot)
  if (root !== options.root || !options.models.length || options.models.length > 32 || !Number.isSafeInteger(options.port ?? 4177) || (options.port ?? 4177) < 0 || (options.port ?? 4177) > 65535) throw new Error('Invalid DocAtlas application configuration')
  let ancestor = root
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  if (realpathSync(ancestor) !== ancestor) throw new Error('Application state cannot traverse a symlink')
  for (const code of [projectRoot, webRoot]) { const part = relative(root, code); if (!part || !isAbsolute(part) && part !== '..' && !part.startsWith('../')) throw new Error('Application state cannot contain product code') }
  dedicatedDirectory(root)
  const work = join(root, 'workspace'), state = join(root, 'private'), runtimeRoot = join(root, 'runtime'), trusted = join(root, 'trusted-resources'), cache = join(root, 'document-cache'), files = join(root, 'uploads')
  for (const path of [work, state, runtimeRoot, trusted, cache, files]) dedicatedDirectory(path)
  const actor = { actorId: `actor:local:${hash(root).slice(0, 24)}`, workspaceId: `workspace:local:${hash(work).slice(0, 24)}` }
  const cleanup: Array<() => void | Promise<void>> = []
  let closed = false, closing: Promise<void> | undefined
  const close = (): Promise<void> => closing ??= (async () => {
    closed = true
    const failures: unknown[] = []
    while (cleanup.length) try { await cleanup.pop()!() } catch (error) { failures.push(error); break }
    if (failures.length) throw new AggregateError(failures, 'Application shutdown needs operator inspection; state was retained')
  })()
  try {
    const assets = loadAssets(webRoot)
    const control = ControlStore.open(join(state, 'control')); cleanup.push(() => control.close())
    const resources = new ResourceStore(join(root, 'resources'), [state, runtimeRoot, work, cache, files]); cleanup.push(() => resources.close())
    const snapshot = resources.capture(trusted)
    if (snapshot.files.length && options.trustedResourceHash !== snapshot.manifestHash) throw new Error(`Trusted resources require explicit review: ${snapshot.files.length} files, SHA-256 ${snapshot.manifestHash}. Restart with that reviewed resource hash.`)
    const approval = resources.approve(actor, snapshot.snapshotId, snapshot.manifestHash)
    const catalog = new RuntimeCatalog(join(state, 'catalog')); cleanup.push(() => catalog.close())
    const uploads = new UploadStore(join(state, 'upload-metadata'), files, actor); cleanup.push(() => uploads.close())
    const documents = await DocumentApplication.create({ actor, control, domainRoot: join(state, 'document-domain'), projectRoot, cacheRoot: cache,
      discovery: uploads, sourceRoots: { uploads: files }, protectedRoots: [state, runtimeRoot, resources.root, trusted] })
    cleanup.push(() => documents.close())
    const authorize = () => { if (closed) throw new Error('Application is closing') }
    documents.enableEnrichments(createEnrichmentModel(options.modelRuntime, options.models[0]!, authorize))
    documents.enableTreeSearch(createTreeSearchModel(options.modelRuntime, options.models[0]!, authorize))
    const profiles = await PersonalizationStore.open(join(state, 'personal-domain')); cleanup.push(() => profiles.close())
    const personalization = new PersonalizationService(profiles, control)
    const preferenceApplication = new ProductPersonalization(profiles, personalization, control, actor, documents.research)
    cleanup.push(() => preferenceApplication.close())
    const learning = personalization.learning(documents.answers, documents.store)
    cleanup.push(() => learning.close())
    const documentHttp = new DocumentHttp(documents, uploads, cache, personalization)
    const manager = new RuntimeManager({ modelRuntime: options.modelRuntime, models: options.models, actor, control, catalog, resources, approvalId: approval.approvalId,
      workspaceRoot: work, stateRoot: runtimeRoot, protectedRoots: [state, files, cache, trusted],
      rgExecutable: realpathSync(execFileSync('which', ['rg'], { encoding: 'utf8', timeout: 5000 }).trim()), services: binding => {
        authorize(); const source = documents.forConversation(binding.conversationId)
        return { prepare: documents.prepare, documents: { operations: source.operations, boundary: source.backend, invalidate: () => source.session.invalidate(), onCheckpoint: source.onCheckpoint }, modelPolicy: preferenceApplication.policy(binding),
          onCoordinator: coordinator => learning.observe(binding, coordinator) }
      } })
    cleanup.push(() => manager.close())
    documents.answers.enableHistoricalOrigins({ origins: (id, entry) => manager.historyAccess(actor, id).origins(id, entry), frames: id => manager.historyAccess(actor, id).frames(id) })
    documents.questionContexts.enableHistoricalOrigins({ origins: (id, entry) => manager.historyAccess(actor, id).origins(id, entry), frames: id => manager.historyAccess(actor, id).frames(id) })
    // An empty durable conversation is not a model call; the first question remains explicitly user-triggered.
    if (!control.conversations(actor).items.length) manager.create(actor, `initial-conversation:${hash(root)}`)
    let handler: ReturnType<typeof createProductHttpHandler> | undefined
    const server = createServer((request, response) => {
      response.setHeader('Content-Security-Policy', csp); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Cache-Control', 'no-store')
      if (request.url?.startsWith('/api/')) { if (!handler) { response.writeHead(503); response.end(); return }; handler(request, response); return }
      const asset = assets.get(request.url ?? '')
      if (request.method !== 'GET' || !asset) { response.writeHead(404); response.end(); return }
      const encoded = staticEncoding(asset, request.headers['accept-encoding'])
      response.setHeader('Cache-Control', staticAssetCacheControl(request.url!))
      response.setHeader('Vary', 'Accept-Encoding')
      if (encoded.encoding) response.setHeader('Content-Encoding', encoded.encoding)
      response.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': encoded.bytes.length }); response.end(encoded.bytes)
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 4177, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
    cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`, auth = new ProductAuth(origin, undefined, undefined, options.localAccess ? actor : undefined)
    handler = createProductHttpHandler({ auth, control, coordinator: async (who, id) => (await manager.get(who, id)).coordinator,
      stop: (who, id) => manager.stop(who, id),
      native: { inspect: (who, id) => manager.nativeInspect(who, id), command: (who, id, input, check) => manager.nativeCommand(who, id, input, check),
        operation: (who, id, operation) => manager.nativeOperation(who, id, operation) }, history: (who, id) => manager.history(who, id),
      lineage: { inspect: (who, id) => manager.lineageInspect(who, id), command: (who, id, input, check) => manager.lineageCommand(who, id, input, check),
        operation: (who, id, operation) => manager.lineageOperation(who, id, operation), tree: (who, id, input) => manager.lineageTree(who, id, input) },
      observations: (who, id) => manager.observations(who, id), createConversation: (who, key) => manager.create(who, key), documents: () => documentHttp })
    return { origin, pairingCode: auth.localAccess ? '' : auth.issueBootstrap(actor).code, actor, close, workspaceRoot: work,
      // Trusted embedding API only; none of these methods or objects are exposed by static routes.
      manager, documents, control }
  } catch (error) { await close(); throw error }
}

function loadAssets(root: string): Map<string, StaticAsset> {
  const assets = new Map<string, StaticAsset>(), types: Record<string, string> = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }
  let total = 0
  const add = (url: string, file: string, type: string) => {
    if (realpathSync(file) !== file || !lstatSync(file).isFile()) throw new Error('Static product asset is not a regular allowlisted file')
    const size = lstatSync(file).size
    if (size > 16000000 || total + size > 64000000 || assets.size >= 2048) throw new Error('Static product assets exceed startup budget')
    const bytes = readFileSync(file); if (bytes.length !== size) throw new Error('Static asset changed during startup')
    const asset = encodeStaticAsset(bytes, type)
    total += size + (asset.br?.length ?? 0) + (asset.gzip?.length ?? 0)
    if (total > 64000000) throw new Error('Encoded static assets exceed startup budget')
    assets.set(url, asset)
  }
  add('/', join(root, 'live.html'), 'text/html; charset=utf-8'); assets.set('/live.html', assets.get('/')!)
  add('/favicon.svg', join(root, 'favicon.svg'), 'image/svg+xml')
  for (const name of readdirSync(join(root, 'assets'))) if (types[extname(name)]) add(`/assets/${name}`, join(root, 'assets', name), types[extname(name)]!)
  for (const directory of ['cmaps', 'standard_fonts', 'wasm']) for (const name of readdirSync(join(root, 'pdfjs', directory))) add(`/pdfjs/${directory}/${name}`, join(root, 'pdfjs', directory, name), name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream')
  return assets
}
