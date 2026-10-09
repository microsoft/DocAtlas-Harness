// Real SDK child, deliberately killed by its parent before the first assistant.
// No provider network, persisted credentials, or user workspace is involved.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import { fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai'

const root = process.argv[2]
const cwd = join(root, 'project')
const agentDir = join(root, 'agent')
mkdirSync(cwd, { recursive: true })
mkdirSync(agentDir, { recursive: true })
const faux = fauxProvider()
const modelRuntime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
  modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
})
modelRuntime.registerNativeProvider(faux.provider)
const manager = SessionManager.create(cwd, join(root, 'sessions'))
faux.setResponses([async () => {
  process.send?.({ stage: 'model-started', sessionFile: manager.getSessionFile(), entries: manager.getEntries().length })
  return new Promise(() => {})
}])
const { session } = await createAgentSession({
  cwd, agentDir, modelRuntime, model: faux.getModel(), sessionManager: manager,
  settingsManager: SettingsManager.inMemory({ defaultProjectTrust: 'never', compaction: { enabled: false } }),
})
await session.bindExtensions({})
await session.prompt('Keep this first accepted user question through a process crash.')
