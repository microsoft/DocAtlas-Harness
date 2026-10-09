import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startDocAtlasApplication } from '../../apps/server/lib/index.js'

const requireServer = createRequire(new URL('../../apps/server/package.json', import.meta.url))
const { createPiTestModel } = await import(requireServer.resolve('@docatlas/runtime-pi/testing')) as typeof import('../../packages/runtime-pi/lib/testing.js')

/** Real trusted application composition; only provider responses are scripted.
 * Never retain the initial coordinator/worker across a generation or child-session handoff. */
export async function lineageHarness(options: Pick<Parameters<typeof createPiTestModel>[0], 'answers' | 'beforeResponse'>) {
  const contexts: Array<readonly unknown[]> = []
  const model = await createPiTestModel({ ...options, inspectMessages: messages => contexts.push(structuredClone([...messages])) })
  const root = mkdtempSync(join(tmpdir(), 'docatlas-lineage-browser-'))
  // startDocAtlasApplication retains state if startup/shutdown cannot prove actual native join.
  const application = await startDocAtlasApplication({ root, projectRoot: resolve('.'), webRoot: resolve(process.env.DOCATLAS_E2E_WEB_ROOT ?? 'apps/web/dist'), port: 0,
    modelRuntime: model.modelRuntime, models: model.models, localAccess: true })
  const parent = application.control.conversations(application.actor).items[0]!
  return { ...application, root, parent, model, contexts,
    binding: (conversationId: string) => application.control.binding(application.actor, conversationId),
    waitIdle: async (conversationId: string) => { await (await application.manager.get(application.actor, conversationId)).coordinator.waitForIdle() },
    close: async () => { await application.close(); rmSync(root, { recursive: true, force: true }) },
  }
}
