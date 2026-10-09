// Node 22's TS transform is used only for this fault-injection child, not a product launcher.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createPiTestRuntime } from '@docatlas/runtime-pi/testing'
import { ControlStore } from '../../src/storage/control-store.ts'

const [root, crashStage] = process.argv.slice(2)
const cwd = join(root, 'project'), agentDir = join(root, 'agent')
mkdirSync(cwd, { recursive: true }); mkdirSync(agentDir, { recursive: true })
const actor = { actorId: 'user:crash', workspaceId: 'workspace:crash' }
const store = ControlStore.open(join(root, 'control'))
let receipt, lease
const { runtime } = await createPiTestRuntime({ cwd, agentDir, sessionDir: join(root, 'sessions'), answers: ['not reached'],
  beforeResponse: async () => {
    receipt = store.transition(lease, receipt.submissionId, receipt.version, 'running')
    process.send?.({ stage: 'running', submissionId: receipt.submissionId, epoch: lease.epoch, file: runtime.session.sessionFile })
    await new Promise(() => {})
  },
})
store.createConversation(actor, { conversationId: 'conversation:crash', runtimeSessionId: runtime.session.sessionId })
const request = { schemaVersion: 1, kind: 'submission', conversationId: 'conversation:crash', idempotencyKey: 'idempotency:crash:question',
  expectedGeneration: 1, mode: 'prompt', text: 'A first question that must survive the process.', sourceRefs: [], selectionContextIds: [] }
receipt = store.accept(actor, request).receipt
lease = store.acquireWriter(actor, request.conversationId, 'worker:crash')
if (crashStage === 'accepted') {
  process.send?.({ stage: 'accepted', submissionId: receipt.submissionId, epoch: lease.epoch, file: runtime.session.sessionFile })
  await new Promise(() => {})
}
receipt = store.transition(lease, receipt.submissionId, receipt.version, 'preparing')
receipt = store.transition(lease, receipt.submissionId, receipt.version, 'ready', { prepared: { schemaVersion: 1, kind: 'prepared',
  submissionId: receipt.submissionId, requestHash: receipt.requestHash, bindingGeneration: 1, scopeVersionId: null, sourceRefs: [], selectionContextIds: [] } })
receipt = store.transition(lease, receipt.submissionId, receipt.version, 'dispatching')
await runtime.session.prompt(request.text)
