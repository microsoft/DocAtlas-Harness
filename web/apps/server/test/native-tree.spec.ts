import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProductNativeTreeRequest, ProductSubmission } from '@docatlas/contracts'
import { PiProductDriver } from '@docatlas/runtime-pi'
import { createPiTestRuntime } from '@docatlas/runtime-pi/testing'
import { captureNativeSelectedHead } from '@docatlas/runtime-pi/worker'
import { ControlStore } from '../src/storage/control-store.js'
import { RuntimeCatalog } from '../src/storage/runtime-catalog.js'
import { SubmissionCoordinator } from '../src/runs/submission-coordinator.js'
import { LineageHistoryAccess } from '../src/runs/lineage-history.js'
import { NativeConversationTree } from '../src/runs/native-tree.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); while (cleanup.length) await cleanup.pop()!() })
const actor = { actorId: 'actor:native-tree', workspaceId: 'workspace:native-tree' }
const request = (view: ProductNativeTreeRequest['view'] = 'all', cursor: string | null = null): ProductNativeTreeRequest => ({ schemaVersion: 1, kind: 'native-tree-request', expectedGeneration: 1, view, cursor })
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-native-tree-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const work = join(root, 'work'), agentDir = join(root, 'agent'); mkdirSync(work); mkdirSync(agentDir)
  const control = ControlStore.open(join(root, 'control')); cleanup.push(() => control.close())
  const catalog = new RuntimeCatalog(join(root, 'catalog')); cleanup.push(() => catalog.close())
  const binding = control.createConversation(actor, { conversationId: 'conversation:native-tree', runtimeSessionId: randomUUID() })
  const native = await createPiTestRuntime({ cwd: work, agentDir, sessionDir: join(root, 'sessions'), sessionId: binding.runtimeSessionId, tools: [], answers: ['Visible first answer', 'Visible second answer'] })
  cleanup.push(() => native.runtime.dispose())
  const manager = native.runtime.session.sessionManager, driver = new PiProductDriver(native.runtime.session, { activeCount: 0, abortAll: async () => {}, resume: () => {} })
  cleanup.push(() => driver.dispose())
  const coordinator = new SubmissionCoordinator(control, actor, binding.conversationId, driver, async ({ request, receipt }) => ({
    prepared: { schemaVersion: 1, kind: 'prepared', submissionId: receipt.submissionId, requestHash: receipt.requestHash, bindingGeneration: binding.generation,
      scopeVersionId: null, sourceRefs: [], selectionContextIds: [] }, modelText: `PRIVATE_PREPARED_SOURCE ${request.text}` }))
  cleanup.push(() => coordinator.close())
  const receipts = []
  for (const index of [1, 2]) {
    const submitted: ProductSubmission = { schemaVersion: 1, kind: 'submission', conversationId: binding.conversationId, expectedGeneration: binding.generation,
      idempotencyKey: `question:native-tree:${index}`, mode: 'prompt', text: `Original human question ${index}`, sourceRefs: [], selectionContextIds: [] }
    const accepted = coordinator.submit(submitted).receipt; await coordinator.waitForIdle()
    const receipt = control.get(actor, accepted.submissionId); expect(receipt.state).toBe('completed'); receipts.push(receipt)
  }
  await coordinator.close()
  const file = native.runtime.session.sessionFile!, claim = catalog.claim(binding); catalog.setFile(claim, basename(file))
  const access = new LineageHistoryAccess(control, catalog, actor, binding, work, () => file); cleanup.push(() => access.dispose())
  let time = Date.now()
  const head = vi.fn(async () => captureNativeSelectedHead(manager, true))
  const origins = vi.fn((selected: Awaited<ReturnType<typeof head>>, ids: readonly string[]) => access.treeOrigins(binding.conversationId, selected, ids))
  const tree = new NativeConversationTree({ control, actor, binding, cwd: work, head, file: () => file, origins, clock: () => time })
  cleanup.push(() => tree.dispose())
  return { root, work, binding, control, catalog, native, manager, file, receipts, access, tree, head, origins, advance: (amount: number) => { time += amount } }
}

describe('verified full native tree and private opaque paging', () => {
  it('shows original human drafts across selected and off-selected branches, preserves real depths/labels, and hides every private body class', async () => {
    const f = await fixture(), firstUser = f.receipts[0]!.checkpoint!.userEntryId, firstAnswer = f.receipts[0]!.checkpoint!.leafEntryId
    const answer = f.manager.getEntry(firstAnswer)
    if (answer?.type !== 'message' || answer.message.role !== 'assistant') throw new Error('Missing actual Pi answer')
    // Explicit structural SDK fixtures supplement the two genuinely checkpointed
    // product turns. No product receipt/proof is invented for these extra nodes.
    f.manager.appendCustomEntry('private-provider', { apiKey: 'PRIVATE_METADATA' })
    f.manager.appendMessage({ ...answer.message, content: [{ type: 'thinking', thinking: 'PRIVATE_THINKING' }, { type: 'text', text: 'Visible text beside thinking' }] })
    f.manager.appendMessage({ role: 'toolResult', toolCallId: 'tree-tool', toolName: 'bash', content: [{ type: 'text', text: 'PRIVATE_TOOL_RESULT' }], isError: false, timestamp: Date.now() })
    f.manager.appendCompaction('PRIVATE_COMPACTION_SUMMARY', firstUser, 12)
    f.manager.appendCustomMessageEntry('private-custom', 'PRIVATE_CUSTOM_MESSAGE', true)
    f.manager.branchWithSummary(firstAnswer, 'PRIVATE_BRANCH_SUMMARY')
    f.manager.appendLabelChange(firstUser, 'Visible bookmark')
    f.manager.branch(firstAnswer)
    const page = await f.tree.page(actor, request()), serialized = JSON.stringify(page)
    expect(page.head.selectedLeafEntryId).toBe(firstAnswer); expect(page.head.fileSeal.tailEntryId).not.toBe(firstAnswer)
    expect(page.entries.filter(entry => entry.type === 'user').map(entry => entry.preview)).toEqual(['Original human question 1', 'Original human question 2'])
    expect(page.entries.find(entry => entry.entryId === firstUser)).toMatchObject({ label: 'Visible bookmark', onSelectedBranch: true, canForkBefore: true })
    expect(page.entries.find(entry => entry.entryId === f.receipts[1]!.checkpoint!.userEntryId)).toMatchObject({ onSelectedBranch: false, preview: 'Original human question 2' })
    expect(serialized).toContain('Visible text beside thinking')
    for (const secret of ['PRIVATE_PREPARED_SOURCE', 'PRIVATE_METADATA', 'PRIVATE_THINKING', 'PRIVATE_TOOL_RESULT', 'PRIVATE_COMPACTION_SUMMARY', 'PRIVATE_BRANCH_SUMMARY', 'PRIVATE_CUSTOM_MESSAGE', f.root]) expect(serialized).not.toContain(secret)
    const byId = new Map(page.entries.map(entry => [entry.entryId, entry]))
    for (const entry of page.entries) {
      if (entry.parentId && byId.has(entry.parentId)) expect(entry.depth).toBe(byId.get(entry.parentId)!.depth + 1)
      expect(entry.canNavigate).toBe(true); expect(entry.canForkAt).toBe(true)
      expect(entry.canForkBefore).toBe(entry.type === 'user')
      if (!['user', 'assistant'].includes(entry.type)) expect(entry.preview).toBe('')
    }
    expect(f.native.getCallCount()).toBe(2)
  })

  it('paginates 100 native nodes with stable exact-head/view/owner cursors and no duplicate or invented nodes', async () => {
    const f = await fixture()
    for (let index = 0; index < 145; index++) f.manager.appendCustomEntry('native-tree-page', { private: `PRIVATE_${index}` })
    const first = await f.tree.page(actor, request())
    expect(first.entries).toHaveLength(100); expect(first.nextCursor).toMatch(/^tree:/u)
    const second = await f.tree.page(actor, request('all', first.nextCursor))
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.entries, ...second.entries].map(entry => entry.entryId)).size).toBe(f.manager.getEntries().length)
    expect(f.origins.mock.calls.every(([, ids]) => ids.length <= 100)).toBe(true)
    await expect(f.tree.page(actor, request('messages', first.nextCursor))).rejects.toMatchObject({ code: 'conflict' })
    await expect(f.tree.page({ ...actor, actorId: 'actor:foreign' }, request('all', first.nextCursor))).rejects.toMatchObject({ code: 'not-found' })
    f.manager.appendCustomEntry('actual-head-change', {})
    await expect(f.tree.page(actor, request('all', first.nextCursor))).rejects.toMatchObject({ code: 'conflict' })
    const current = await f.tree.page(actor, request()); f.advance(300001)
    await expect(f.tree.page(actor, request('all', current.nextCursor))).rejects.toMatchObject({ code: 'conflict' })
  })

  it('rechecks the head and original human payload after awaits instead of leaking an earlier cached draft', async () => {
    const f = await fixture(), head = captureNativeSelectedHead(f.manager, true)
    f.head.mockResolvedValueOnce(head).mockImplementationOnce(async () => {
      const first = f.receipts[0]!
      f.control.purgeRecoveryPayload(actor, first.submissionId)
      return head
    })
    const page = await f.tree.page(actor, request('messages'))
    expect(page.entries.find(entry => entry.entryId === f.receipts[0]!.checkpoint!.userEntryId)?.preview).toBe('')
    expect(JSON.stringify(page)).not.toContain('Original human question 1')
    f.head.mockResolvedValueOnce(head).mockImplementationOnce(async () => { f.manager.appendCustomEntry('during-await', {}); return captureNativeSelectedHead(f.manager, true) })
    await expect(f.tree.page(actor, request())).rejects.toMatchObject({ code: 'conflict' })
  })

  it('rejects missing assistant origins, corrupted file bytes and stale generations without a raw-text fallback', async () => {
    const f = await fixture(), bytes = readFileSync(f.file), head = captureNativeSelectedHead(f.manager, true)
    f.origins.mockReturnValueOnce(new Map())
    await expect(f.tree.page(actor, request())).rejects.toMatchObject({ code: 'unavailable' })
    f.head.mockResolvedValue(head)
    writeFileSync(f.file, readFileSync(f.file, 'utf8').replace('Visible first answer', 'Altered first answer'))
    try { await expect(f.tree.page(actor, request())).rejects.toThrow() } finally { writeFileSync(f.file, bytes) }
    f.control.rebind(actor, f.binding.conversationId, f.binding.version, 'native:replacement', null)
    await expect(f.tree.page(actor, request())).rejects.toMatchObject({ code: 'conflict' })
  })
})
