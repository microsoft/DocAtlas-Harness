import { clickHeaderAction } from './ui.js'
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from './test.js'
import type { ConversationSnapshot, ProductPreferenceCommand, ProductPreferenceCommandV2, ProductPreferenceInspectionV2, ProductPreferenceResultV2 } from '@docatlas/contracts'
import { parseContract } from '../../packages/contracts/lib/node.js'
import { liveHarness } from './harness.js'

const preferencePath = '/api/conversations/conversation%3Abrowser/preferences'
async function pair(page: Page, fixture: Awaited<ReturnType<typeof liveHarness>>) {
  await page.goto(`${fixture.origin}/live.html`)

  await page.reload()
  await expect(page.getByLabel('向 DocAtlas 提问')).toBeEnabled()
}
async function openPreferences(page: Page) {
  await clickHeaderAction(page, '偏好')
  await expect(page.getByRole('dialog', { name: '偏好设置', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '重新读取偏好', exact: true })).toBeEnabled()
  await expect(page.getByRole('note')).toContainText('偏好已连接回答生成')
}
async function inspect(page: Page, origin: string): Promise<ProductPreferenceInspectionV2> {
  const response = await page.request.get(`${origin}${preferencePath}/state`)
  expect(response.status()).toBe(200)
  const value = parseContract('product-personalization-v2', await response.json())
  if (value.kind !== 'preference-inspection') throw new Error('Expected real profile inspection')
  return value
}
async function outbox(page: Page): Promise<Array<{ key: string, raw: string }>> {
  return page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith('docatlas.live.draft.v1:') && key.includes(':@preferences:'))
    .map(([key, raw]) => ({ key, raw })))
}

test('saves explicit preferences through real services, retains versions across refresh and supports independent controls, export and forget without a model call', async ({ page }) => {
  test.setTimeout(90000)
  const fixture = await liveHarness({ documents: true }), commands: ProductPreferenceCommandV2[] = [], results: ProductPreferenceResultV2[] = []
  try {
    await page.route('**/api/conversations/*/preferences', async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return }
      const command = parseContract('product-personalization-v2', route.request().postDataJSON())
      if (command.kind !== 'preference-command') throw new Error('Expected explicit preference command')
      commands.push(command)
      const response = await route.fetch(), body = await response.body()
      expect(response.ok()).toBe(true)
      const result = parseContract('product-personalization-v2', JSON.parse(body.toString('utf8')))
      if (result.kind !== 'preference-result') throw new Error('Expected committed preference receipt')
      results.push(result)
      await route.fulfill({ response, body }) // Forward the actual committed service response unchanged.
    })
    await pair(page, fixture)
    await openPreferences(page)
    await page.getByLabel('偏好项目', { exact: true }).selectOption('answer-order')
    await page.getByLabel('我的偏好选择', { exact: true }).selectOption('conclusion-first')
    await page.getByLabel('偏好作用范围', { exact: true }).selectOption('workspace')
    await page.getByRole('button', { name: '保存偏好', exact: true }).click()
    const card = page.locator('[data-preference-id]')
    await expect(card).toHaveCount(1)
    await expect(card).toContainText('回答顺序 · 先说结论')
    await expect(card).toContainText('版本 1')
    const firstId = await card.getAttribute('data-preference-id')
    await expect.poll(() => outbox(page)).toEqual([])

    await page.reload()
    await openPreferences(page)
    await expect(card).toHaveAttribute('data-preference-id', firstId!)
    expect(commands.filter(value => value.command.action === 'set-preference')).toHaveLength(1)
    await card.getByRole('button', { name: '修改', exact: true }).click()
    await page.getByLabel('我的偏好选择', { exact: true }).selectOption('evidence-first')
    await page.getByRole('button', { name: '保存修改', exact: true }).click()
    await expect(card).toContainText('版本 2')
    await expect(card).toContainText('回答顺序 · 先看证据')
    await card.getByRole('button', { name: '暂停', exact: true }).click()
    await expect(card).toContainText('版本 3')
    await expect(card).toContainText('已暂停')
    await card.getByRole('button', { name: '恢复', exact: true }).click()
    await expect(card).toContainText('版本 4')
    await expect(card).toContainText('授权后可用于生成')
    expect(commands.filter(value => ['edit', 'pause', 'resume'].includes(value.command.action)).map(value => 'expectedVersion' in value.command ? value.command.expectedVersion : undefined)).toEqual([1, 2, 3])

    const useExisting = page.getByRole('checkbox', { name: /允许使用已有偏好/u })
    const contribute = page.getByRole('checkbox', { name: /允许为未来偏好积累信号/u })
    await useExisting.check(); await contribute.uncheck()
    await page.getByRole('button', { name: '保存会话开关', exact: true }).click()
    await expect.poll(async () => (await inspect(page, fixture.origin)).result.sessionPolicy).toMatchObject({ version: 1, useExisting: true, contributeToFuture: false })
    await useExisting.uncheck(); await contribute.check()
    await page.getByRole('button', { name: '保存会话开关', exact: true }).click()
    await expect.poll(async () => (await inspect(page, fixture.origin)).result.sessionPolicy).toMatchObject({ version: 2, useExisting: false, contributeToFuture: true })
    await expect(useExisting).not.toBeChecked(); await expect(contribute).toBeChecked()

    await page.getByLabel('偏好导出格式', { exact: true }).selectOption('json')
    await page.getByRole('button', { name: '生成偏好导出', exact: true }).click()
    const link = page.getByRole('link', { name: /下载偏好记录/u })
    await expect(link).toBeVisible()
    await expect(link).toHaveAttribute('href', /^\/api\/conversations\/conversation%3Abrowser\/preferences\/exports\//u)
    const downloading = page.waitForEvent('download')
    await link.click()
    const download = await downloading, file = await download.path()
    expect(await download.failure()).toBeNull()
    expect(download.suggestedFilename()).toBe('docatlas-preferences.json')
    expect(file).not.toBeNull()
    const exported = JSON.parse(readFileSync(file!, 'utf8')) as { exportType: string, memories: Array<{ status: string, version: number, effect: { key: string, value: string } }> }
    expect(exported.exportType).toBe('docatlas-personalization')
    expect(exported.memories.filter(value => value.status === 'active')).toEqual([expect.objectContaining({ version: 4, effect: { key: 'answer-order', value: 'evidence-first' } })])

    page.once('dialog', async dialog => { expect(dialog.message()).toContain('不会删除原生会话'); await dialog.accept() })
    await card.getByRole('button', { name: '忘记这条偏好', exact: true }).click()
    await expect(card).toHaveCount(0)
    await expect(page.getByText('一条偏好已忘记 · 版本 5', { exact: true })).toBeVisible()
    const forgotten = results.at(-1)!
    expect(forgotten.result).toMatchObject({ action: 'forget', receipt: { mode: 'memory-only', activeProjectionRemoved: true, sessionLogChanged: false, providerCopiesChanged: false } })
    const final = await inspect(page, fixture.origin)
    expect(final.modelApplication).toBe('host-ephemeral')
    expect(final.useSemantics).toBe('observed-answer-generation')
    expect(final.result.memories.filter(value => value.status !== 'deleted')).toEqual([])
    expect(final.result.counts.decisions).toBe(0); expect(final.result.counts.uses).toBe(0)
    expect(fixture.model.getCallCount()).toBe(0)
    expect(fixture.contexts).toEqual([])
  } finally { await fixture.close() }
})

test('retains a committed but unacknowledged preference request across refresh and retries the exact same key without duplicate memory', async ({ page }) => {
  test.setTimeout(90000)
  const fixture = await liveHarness({ documents: true }), commands: ProductPreferenceCommandV2[] = [], receipts: ProductPreferenceResultV2[] = []
  let dropResponse = true
  try {
    await page.route('**/api/conversations/*/preferences', async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return }
      const command = parseContract('product-personalization-v2', route.request().postDataJSON())
      if (command.kind !== 'preference-command') throw new Error('Expected explicit preference command')
      commands.push(command)
      const response = await route.fetch(), body = await response.body()
      expect(response.ok()).toBe(true)
      const receipt = parseContract('product-personalization-v2', JSON.parse(body.toString('utf8')))
      if (receipt.kind !== 'preference-result') throw new Error('Expected real committed receipt')
      receipts.push(receipt)
      if (dropResponse) { dropResponse = false; await route.abort('failed') }
      else await route.fulfill({ response, body })
    })
    await pair(page, fixture)
    await openPreferences(page)
    await page.getByLabel('偏好项目', { exact: true }).selectOption('explanation-depth')
    await page.getByLabel('我的偏好选择', { exact: true }).selectOption('brief')
    await page.getByRole('button', { name: '保存偏好', exact: true }).click()
    await expect(page.getByRole('region', { name: '未确认的偏好请求', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '使用原键重试偏好操作', exact: true })).toBeEnabled()
    expect(commands).toHaveLength(1); expect(receipts[0]!.result.status).toBe('created')
    const retained = await outbox(page)
    expect(retained).toHaveLength(1)
    const pending = JSON.parse(retained[0]!.raw) as { identity: { actorId: string, workspaceId: string, conversationId: string, bindingId: string, generation: number }, request: ProductPreferenceCommandV2 }
    expect(pending.request).toEqual(commands[0])
    expect(pending.identity).toMatchObject({ actorId: 'actor:browser', workspaceId: 'workspace:browser', conversationId: 'conversation:browser', generation: commands[0]!.expectedGeneration })
    const committed = await inspect(page, fixture.origin)
    expect(committed.result.memories).toHaveLength(1)
    const memoryId = committed.result.memories[0]!.memoryVersionId

    await page.reload()
    await openPreferences(page)
    await expect(page.locator('[data-preference-id]')).toHaveCount(1)
    await expect(page.locator('[data-preference-id]')).toHaveAttribute('data-preference-id', memoryId)
    await expect(page.getByRole('button', { name: '使用原键重试偏好操作', exact: true })).toBeEnabled()
    expect(commands).toHaveLength(1) // Opening or restoring the drawer performs only reads.
    expect(await outbox(page)).toEqual(retained)
    expect(fixture.model.getCallCount()).toBe(0)

    await page.getByRole('button', { name: '使用原键重试偏好操作', exact: true }).click()
    await expect(page.getByRole('region', { name: '未确认的偏好请求', exact: true })).toBeHidden()
    await expect.poll(() => outbox(page)).toEqual([])
    expect(commands).toHaveLength(2); expect(commands[1]).toEqual(commands[0])
    expect(receipts[1]!.result).toMatchObject({ action: 'set-preference', status: 'replayed', memoryVersion: { memoryVersionId: memoryId, version: 1 } })
    const after = await inspect(page, fixture.origin)
    expect(after.result.memories).toHaveLength(1)
    expect(after.result.memories[0]!.memoryVersionId).toBe(memoryId)
    expect(after.result.counts.uses).toBe(0); expect(after.result.counts.decisions).toBe(0)
    expect(after.modelApplication).toBe('host-ephemeral')
    expect(fixture.model.getCallCount()).toBe(0)
  } finally { await fixture.close() }
})

test('replays an existing v1 outbox unchanged against a connected host and then refreshes v2 state', async ({ page }) => {
  test.setTimeout(90000)
  const fixture = await liveHarness({ documents: true }), posted: unknown[] = []
  try {
    await pair(page, fixture)
    const initial = await inspect(page, fixture.origin)
    const snapshot = await (await page.request.get(`${fixture.origin}/api/conversations/conversation%3Abrowser/snapshot`)).json() as ConversationSnapshot
    const binding = snapshot.binding, identity = { actorId: binding.ownerActorId, workspaceId: binding.workspaceId, conversationId: binding.conversationId, bindingId: binding.bindingId, generation: binding.generation }
    const command: ProductPreferenceCommand = { schemaVersion: 1, kind: 'preference-command', expectedGeneration: binding.generation,
      command: { action: 'set-preference', idempotencyKey: 'legacy:preference:one', preference: { effect: { key: 'answer-order', value: 'evidence-first' }, scope: 'workspace' } } }
    const response = await page.evaluate(async ({ path, body }) => {
      const bootstrap = await (await fetch('/api/bootstrap')).json() as { csrfToken: string }
      const result = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-docatlas-csrf': bootstrap.csrfToken }, body: JSON.stringify(body) })
      return { status: result.status, value: await result.json() as unknown }
    }, { path: preferencePath, body: command })
    expect(response.status).toBe(200)
    const receipt = parseContract('product-personalization', response.value)
    expect(receipt).toMatchObject({ schemaVersion: 1, kind: 'preference-result', result: { status: 'created' } })
    const key = `docatlas.live.draft.v1:${encodeURIComponent(identity.actorId)}:${encodeURIComponent(identity.workspaceId)}:@preferences:${encodeURIComponent(identity.conversationId)}:${encodeURIComponent(identity.bindingId)}:${identity.generation}`
    const raw = JSON.stringify({ schemaVersion: 1, identity, profileId: initial.result.profileId, request: command })
    await page.evaluate(({ key, raw }) => sessionStorage.setItem(key, raw), { key, raw })
    await page.route('**/api/conversations/*/preferences', async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return }
      posted.push(route.request().postDataJSON())
      const real = await route.fetch(), body = await real.body()
      expect(parseContract('product-personalization', JSON.parse(body.toString('utf8')))).toMatchObject({ schemaVersion: 1, result: { status: 'replayed' } })
      await route.fulfill({ response: real, body })
    })
    await page.reload(); await openPreferences(page)
    expect(posted).toEqual([]); expect(await outbox(page)).toEqual([{ key, raw }])
    await page.getByRole('button', { name: '使用原键重试偏好操作', exact: true }).click()
    await expect.poll(() => outbox(page)).toEqual([])
    expect(posted).toEqual([command])
    const after = await inspect(page, fixture.origin)
    expect(after.schemaVersion).toBe(2); expect(after.result.memories).toHaveLength(1)
    expect(after.modelApplication).toBe('host-ephemeral'); expect(fixture.model.getCallCount()).toBe(0)
  } finally { await fixture.close() }
})

test('records why a preference was used during genuine Pi answer generation, without treating it as compliance or facts', async ({ page }) => {
  test.setTimeout(90000)
  const fixture = await liveHarness({ documents: true, answers: ['已通过真实 Pi 回答通路完成本次说明。'] })
  try {
    await pair(page, fixture); await openPreferences(page)
    await page.getByLabel('偏好项目', { exact: true }).selectOption('explanation-depth')
    await page.getByLabel('我的偏好选择', { exact: true }).selectOption('brief')
    await page.getByRole('button', { name: '保存偏好', exact: true }).click()
    await expect(page.locator('[data-preference-id]')).toHaveCount(1)
    await expect.poll(() => outbox(page)).toEqual([])
    await page.getByRole('checkbox', { name: /允许使用已有偏好/u }).check()
    await page.getByRole('checkbox', { name: /允许为未来偏好积累信号/u }).uncheck()
    await page.getByRole('button', { name: '保存会话开关', exact: true }).click()
    await expect.poll(async () => (await inspect(page, fixture.origin)).result.sessionPolicy).toMatchObject({ useExisting: true, contributeToFuture: false })
    expect((await inspect(page, fixture.origin)).result.counts.uses).toBe(0)
    expect(fixture.model.getCallCount()).toBe(0)
    await page.getByRole('button', { name: '关闭偏好设置', exact: true }).click()
    await page.getByLabel('向 DocAtlas 提问').fill('请给我一个简短说明。')
    await page.getByRole('button', { name: '发送问题', exact: true }).click()
    await expect(page.locator('.live-message.assistant[data-message-saved=true]')).toBeVisible()
    await expect(page.getByRole('region', { name: '会话消息' })).toContainText('已通过真实 Pi 回答通路完成本次说明。')
    await fixture.coordinator.waitForIdle()
    const generated = await inspect(page, fixture.origin)
    expect(generated.useSemantics).toBe('observed-answer-generation')
    expect(generated.result.uses).toHaveLength(1)
    expect(generated.result.uses[0]!.effect).toEqual({ key: 'explanation-depth', value: 'brief' })
    const decision = generated.result.decisions.find(value => value.decisionId === generated.result.uses[0]!.decisionId)
    expect(decision?.why.some(value => value.memoryVersionId === generated.result.uses[0]!.memoryVersionId)).toBe(true)
    expect(fixture.model.getCallCount()).toBe(1)
    await openPreferences(page)
    const history = page.getByRole('region', { name: '偏好生成阶段使用记录', exact: true })
    await expect(history.locator('li')).toHaveCount(1)
    await expect(history).toContainText('解释深度 · 简洁')
    await expect(history).toContainText('不证明模型遵从、事实正确或页面已展示')
    await page.reload(); await openPreferences(page)
    await expect(history.locator('li')).toHaveCount(1)
    expect(fixture.model.getCallCount()).toBe(1)
  } finally { await fixture.close() }
})

test('an old tab cannot restore preferences after another tab clears the profile, and a fresh explicit choice uses the new epoch', async ({ page }) => {
  test.setTimeout(90000)
  const fixture = await liveHarness({ documents: true }), sent: ProductPreferenceCommandV2[] = []
  const other = await page.context().newPage()
  let drop = true
  try {
    await page.route('**/api/conversations/*/preferences', async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return }
      const command = parseContract('product-personalization-v2', route.request().postDataJSON())
      if (command.kind !== 'preference-command') throw new Error('Expected real preference command')
      sent.push(command)
      const response = await route.fetch(), body = await response.body()
      expect(response.ok()).toBe(true)
      if (drop) { drop = false; await route.abort('failed') }
      else await route.fulfill({ response, body })
    })
    await pair(page, fixture); await openPreferences(page)
    await page.getByRole('button', { name: '保存偏好', exact: true }).click()
    await expect(page.getByRole('button', { name: '使用原键重试偏好操作', exact: true })).toBeEnabled()
    const retained = await outbox(page)
    expect(retained).toHaveLength(1)
    expect(sent[0]!.expectedProfileEpoch).toBe(0)
    await other.goto(`${fixture.origin}/live.html`)
    await expect(other.getByLabel('向 DocAtlas 提问')).toBeEnabled()
    await openPreferences(other)
    other.once('dialog', async dialog => { await dialog.accept() })
    await other.getByRole('button', { name: '清除当前个人工作区画像', exact: true }).click()
    await expect.poll(async () => (await inspect(other, fixture.origin)).profileEpoch).toBe(1)
    await expect.poll(() => outbox(other)).toEqual([])
    await page.reload(); await openPreferences(page)
    await expect(page.getByText('画像已清除过；这条旧请求不能恢复旧设置。请清除此草稿后重新选择。', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '使用原键重试偏好操作', exact: true })).toBeDisabled()
    expect(await outbox(page)).toEqual(retained)
    expect(sent).toHaveLength(1)
    expect((await inspect(page, fixture.origin)).result.counts.memories).toBe(0)
    page.once('dialog', async dialog => { await dialog.accept() })
    await page.getByRole('button', { name: '清除这条本地请求', exact: true }).click()
    await expect.poll(() => outbox(page)).toEqual([])
    await page.getByRole('button', { name: '保存偏好', exact: true }).click()
    await expect(page.locator('[data-preference-id]')).toHaveCount(1)
    await expect.poll(() => outbox(page)).toEqual([])
    expect(sent).toHaveLength(2)
    expect(sent[1]!.expectedProfileEpoch).toBe(1)
    expect(sent[1]!.command.idempotencyKey).not.toBe(sent[0]!.command.idempotencyKey)
    expect(fixture.model.getCallCount()).toBe(0)
  } finally { await other.close(); await fixture.close() }
})
