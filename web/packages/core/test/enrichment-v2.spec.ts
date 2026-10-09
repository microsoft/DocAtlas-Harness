import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import type { EnrichmentResult, EnrichmentStart, TreeData, TreeGeneration } from '@docatlas/contracts'
import { enrichTree, EnrichmentError, enrichmentHash, type EnrichmentInput, type EnrichmentModelPort } from '../src/document/enrichment.js'

afterEach(() => vi.restoreAllMocks())
type Spec = { title: string, start: number, end: number, parent?: number }
type Output = Awaited<ReturnType<EnrichmentModelPort['complete']>>
function fixture(specs: Spec[] = [{ title: 'A', start: 1, end: 1 }, { title: 'B', start: 2, end: 2 }, { title: 'C', start: 3, end: 3 }], mode: EnrichmentStart['mode'] = 'summary') {
  const values = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/document/tree-index.json', import.meta.url), 'utf8')) as { valid: Array<TreeGeneration | TreeData> }
  const generation = structuredClone(values.valid.find(value => value.kind === 'tree-generation')!) as TreeGeneration
  const tree: TreeData = { schemaVersion: 1, kind: 'tree-data', generationId: generation.generationId, pageCount: Math.max(...specs.map(value => value.end)), nodes: [] }
  tree.nodes = specs.map((spec, index) => ({ nodeId: `${generation.generationId}:fixture:${index}`, parentId: spec.parent === undefined ? null : `${generation.generationId}:fixture:${spec.parent}`,
    title: spec.title, startPage: spec.start, endPage: spec.end, sourceNodeId: null, keyItems: [] }))
  generation.pageCount = tree.pageCount; generation.nodeCount = tree.nodes.length; generation.treeHash = enrichmentHash(tree)
  const input: EnrichmentInput = { tree, generation, source: { documentId: generation.documentId, revisionId: generation.revisionId, representationId: 'rep:v2', representationContentHash: 'b'.repeat(64) },
    pages: Array.from({ length: tree.pageCount }, (_, index) => ({ page: index + 1, text: `Page ${index + 1}\n${'Source material about the experiment and its limitations. '.repeat(10)}` })) }
  const request: EnrichmentStart = { schemaVersion: 1, kind: 'enrichment-start', idempotencyKey: 'enrichment:v2:fixture', recipe: 'docatlas-flash-enrichment.v2',
    documentId: generation.documentId, revisionId: generation.revisionId, nodeIds: tree.nodes.filter(node => node.parentId === null).map(node => node.nodeId), baseMode: generation.config.mode, mode,
    budget: { maxNodes: 64, maxPages: 50, maxModelCalls: 64, maxInputChars: 300000, maxOutputTokens: 32768, maxOutputChars: 100000, wallMs: 60000 } }
  return { input, request }
}
function data(prompt: string): { title: string, pages: Array<{ page: number, text: string }>, children?: Array<{ title: string, summary: string }> } {
  return JSON.parse(prompt.slice(prompt.indexOf('\nDATA:\n') + 7))
}
const summary = (prompt: string): Output => ({ text: JSON.stringify({ summary: `${data(prompt).title} navigation` }), inputTokens: 20, outputTokens: 10 })
function scripted(reverse: boolean, respond = summary) {
  const calls: Array<{ prompt: string, limits: { maxTokens: number, maxChars: number } }> = [], queue: Array<{ prompt: string, done: ReturnType<typeof Promise.withResolvers<Output>> }> = []
  let active = 0, peak = 0
  const port: EnrichmentModelPort = { identity: { provider: 'scripted-test', model: 'same-source' }, complete(prompt, limits) {
    calls.push({ prompt, limits: { ...limits } }); active++; peak = Math.max(peak, active)
    const done = Promise.withResolvers<Output>(); queue.push({ prompt, done })
    queueMicrotask(() => {
      const ready = queue.splice(0); if (reverse) ready.reverse()
      for (const call of ready) try { call.done.resolve(respond(call.prompt)) } catch (error) { call.done.reject(error) }
    })
    return done.promise.finally(() => { active-- })
  } }
  return { port, calls, active: () => active, peak: () => peak }
}
function controlled() {
  type Call = { prompt: string, limits: { maxTokens: number, maxChars: number }, signal: AbortSignal, done: ReturnType<typeof Promise.withResolvers<Output>>, aborted: ReturnType<typeof Promise.withResolvers<void>> }
  const calls: Call[] = [], waiting: Array<{ count: number, done: ReturnType<typeof Promise.withResolvers<void>> }> = []
  let active = 0, peak = 0
  const port: EnrichmentModelPort = { identity: { provider: 'controlled-test', model: 'held-provider' }, complete(prompt, limits, signal) {
    const done = Promise.withResolvers<Output>(), aborted = Promise.withResolvers<void>(), call = { prompt, limits: { ...limits }, signal, done, aborted }
    if (signal.aborted) aborted.resolve(); else signal.addEventListener('abort', () => aborted.resolve(), { once: true })
    active++; peak = Math.max(peak, active); calls.push(call)
    for (const item of waiting.splice(0)) { if (calls.length >= item.count) item.done.resolve(); else waiting.push(item) }
    // Deliberately ignore AbortSignal settlement: tests must release this actual
    // promise before Core is allowed to release ownership or return a result.
    return done.promise.finally(() => { active-- })
  } }
  return { port, calls, active: () => active, peak: () => peak, wait: (count: number) => { if (calls.length >= count) return Promise.resolve(); const done = Promise.withResolvers<void>(); waiting.push({ count, done }); return done.promise } }
}
function comparable(result: EnrichmentResult) {
  const names = new Map(result.nodes.map(node => [node.nodeId, `${node.title}:${node.startPage}:${node.endPage}`]))
  return { nodes: result.nodes.map(node => ({ ...node, nodeId: names.get(node.nodeId), parentId: node.parentId ? names.get(node.parentId) ?? node.parentId : null })),
    decisions: result.decisions.map(value => ({ ...value, nodeId: names.get(value.nodeId) })), usage: result.usage }
}

it('dispatches two real siblings, joins a stable batch before its third call, and preserves exact result hashes under reversed completion', async () => {
  const f = fixture(), original = JSON.stringify(f), model = controlled()
  const work = enrichTree(f.request, f.input, 'job:stable', model.port, () => {}, new AbortController().signal)
  await model.wait(2); expect(model.active()).toBe(2)
  model.calls[1]!.done.resolve(summary(model.calls[1]!.prompt))
  await model.calls[1]!.done.promise; await Promise.resolve()
  expect(model.calls).toHaveLength(2)
  model.calls[0]!.done.resolve(summary(model.calls[0]!.prompt)); await model.wait(3)
  expect(data(model.calls[2]!.prompt).title).toBe('C'); model.calls[2]!.done.resolve(summary(model.calls[2]!.prompt))
  const result = await work
  expect(model.peak()).toBe(2); expect(model.active()).toBe(0); expect(result.nodes.map(node => node.title)).toEqual(['A', 'B', 'C'])
  expect(JSON.stringify(f)).toBe(original)
  const forward = scripted(false), reverse = scripted(true)
  const first = await enrichTree(f.request, f.input, 'job:deterministic', forward.port, () => {}, new AbortController().signal)
  const second = await enrichTree(f.request, f.input, 'job:deterministic', reverse.port, () => {}, new AbortController().signal)
  expect(second).toEqual(first); expect(forward.peak()).toBe(2); expect(reverse.peak()).toBe(2)
  const { resultHash, ...unsigned } = second; expect(enrichmentHash(unsigned)).toBe(resultHash)
})
it('uses a child-before-parent DAG and reproduces the serial recipe semantics without changing v1 identities', async () => {
  const f = fixture([{ title: 'Root', start: 1, end: 3 }, { title: 'Branch', start: 1, end: 2, parent: 0 },
    { title: 'Leaf one', start: 1, end: 1, parent: 1 }, { title: 'Leaf two', start: 2, end: 2, parent: 1 }, { title: 'Leaf three', start: 3, end: 3, parent: 0 }])
  const parallel = scripted(true), serial = scripted(false), { recipe: _recipe, ...legacy } = f.request
  const v2 = await enrichTree(f.request, f.input, 'job:dag', parallel.port, () => {}, new AbortController().signal)
  const v1 = await enrichTree(legacy, f.input, 'job:dag', serial.port, () => {}, new AbortController().signal)
  expect(v2.recipe).toBe('docatlas-flash-enrichment.v2'); expect(v1.recipe).toBe('docatlas-flash-enrichment.v1')
  expect(v2.enrichmentId).not.toBe(v1.enrichmentId); expect(v2.inputHash).not.toBe(v1.inputHash)
  expect(comparable(v2)).toEqual(comparable(v1)); expect(serial.peak()).toBe(1); expect(parallel.peak()).toBe(2)
  const order = parallel.calls.map(call => data(call.prompt).title)
  expect(order).toEqual(['Leaf one', 'Leaf two', 'Branch', 'Leaf three', 'Root'])
  expect(data(parallel.calls[2]!.prompt).children).toEqual([{ title: 'Leaf one', summary: 'Leaf one navigation' }, { title: 'Leaf two', summary: 'Leaf two navigation' }])
  expect(data(parallel.calls[4]!.prompt).children).toEqual([{ title: 'Branch', summary: 'Branch navigation' }, { title: 'Leaf three', summary: 'Leaf three navigation' }])
  expect(new Map(parallel.calls.map(call => [data(call.prompt).title, call.prompt]))).toEqual(new Map(serial.calls.map(call => [data(call.prompt).title, call.prompt])))
})
it('expands only stable independent frontiers, recursively exposes accepted children, and matches serial full-mode navigation', async () => {
  const f = fixture([{ title: 'A', start: 1, end: 12 }, { title: 'B', start: 13, end: 24 }], 'full')
  const headings = new Map<string, Array<{ title: string, page: number }>>()
  for (const [title, start] of [['A', 1], ['B', 13]] as const) {
    headings.set(title, [{ title: `${title}.1`, page: start }, { title: `${title}.2`, page: start + 6 }])
    headings.set(`${title}.1`, [{ title: `${title}.1.a`, page: start }, { title: `${title}.1.b`, page: start + 3 }])
    headings.set(`${title}.2`, [{ title: `${title}.2.a`, page: start + 6 }, { title: `${title}.2.b`, page: start + 9 }])
  }
  for (const [title, page] of [...headings.values()].flat().map(item => [item.title, item.page] as const)) f.input.pages[page - 1]!.text = `${title}\n${f.input.pages[page - 1]!.text}`
  const respond = (prompt: string): Output => prompt.includes('Return only {"subsections"') ? { text: JSON.stringify({ subsections: headings.get(data(prompt).title) ?? [] }), inputTokens: 20, outputTokens: 10 } : summary(prompt)
  const normal = scripted(false, respond), reverse = scripted(true, respond), serial = scripted(false, respond), { recipe: _recipe, ...legacy } = f.request
  const before = JSON.stringify(f.input), first = await enrichTree(f.request, f.input, 'job:frontier', normal.port, () => {}, new AbortController().signal)
  const reversed = await enrichTree(f.request, f.input, 'job:frontier', reverse.port, () => {}, new AbortController().signal)
  const old = await enrichTree(legacy, f.input, 'job:frontier', serial.port, () => {}, new AbortController().signal)
  expect(reversed).toEqual(first); expect(comparable(first)).toEqual(comparable(old)); expect(first.nodes).toHaveLength(14)
  expect(first.decisions.map(value => first.nodes.find(node => node.nodeId === value.nodeId)!.title)).toEqual(['A', 'B', 'A.1', 'A.2', 'B.1', 'B.2'])
  expect(first.decisions.every(value => value.decision === 'expanded' && value.costAfter < value.costBefore)).toBe(true)
  expect(normal.calls.slice(0, 6).map(call => data(call.prompt).title)).toEqual(['A', 'B', 'A.1', 'A.2', 'B.1', 'B.2'])
  expect(normal.peak()).toBe(2); expect(JSON.stringify(f.input)).toBe(before)
})
it('reserves worst-case outputs across both in-flight calls and returns unused quota only after the batch joins', async () => {
  const f = fixture(), model = controlled()
  f.request.budget.maxOutputTokens = 256; f.request.budget.maxOutputChars = 256
  const work = enrichTree(f.request, f.input, 'job:bank', model.port, () => {}, new AbortController().signal)
  await model.wait(2)
  expect(model.calls.slice(0, 2).map(call => call.limits)).toEqual([{ maxTokens: 128, maxChars: 128 }, { maxTokens: 128, maxChars: 128 }])
  for (const call of model.calls.slice(0, 2)) call.done.resolve(summary(call.prompt))
  await model.wait(3)
  const joinedChars = model.calls.slice(0, 2).reduce((sum, call) => sum + [...summary(call.prompt).text].length, 0)
  expect(model.calls[2]!.limits).toEqual({ maxTokens: 236, maxChars: 256 - joinedChars })
  model.calls[2]!.done.resolve(summary(model.calls[2]!.prompt))
  const result = await work
  expect(result.usage.outputTokens).toBe(30); expect(result.usage.outputChars).toBeLessThanOrEqual(256); expect(result.usage.calls).toBe(3)
})
it('reduces a frontier to one when 128-minimum reservations cannot fit twice and fails without overspending calls/input', async () => {
  const f = fixture(), single = scripted(false)
  f.request.budget.maxOutputTokens = 255
  const result = await enrichTree(f.request, f.input, 'job:one-slot', single.port, () => {}, new AbortController().signal)
  expect(single.peak()).toBe(1); expect(result.usage.calls).toBe(3); expect(single.calls[0]!.limits.maxTokens).toBe(255)
  for (const constrained of [{ ...f.request.budget, maxModelCalls: 1 }, { ...f.request.budget, maxInputChars: f.input.pages.reduce((sum, page) => sum + [...page.text].length, 0) }]) {
    const model = scripted(false)
    await expect(enrichTree({ ...f.request, budget: constrained }, f.input, 'job:exhaustion', model.port, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'budget-exceeded' })
    expect(model.calls.length).toBeLessThanOrEqual(constrained.maxModelCalls)
    expect(model.calls.reduce((sum, call) => sum + [...call.prompt].length, 0)).toBeLessThanOrEqual(constrained.maxInputChars)
    expect(model.active()).toBe(0)
  }
})
it('charges short source excerpts to the same output bank without issuing any hidden model request', async () => {
  const f = fixture(), model = scripted(false)
  for (const page of f.input.pages) page.text = 'short source'
  const result = await enrichTree(f.request, f.input, 'job:excerpts', model.port, () => {}, new AbortController().signal)
  expect(model.calls).toEqual([]); expect(result.usage.outputChars).toBe(3 * 'short source'.length); expect(result.nodes.every(node => node.summaryKind === 'source-excerpt')).toBe(true)
  f.input.pages[2]!.text = 'Long source '.repeat(50); f.request.budget.maxOutputChars = 128
  await expect(enrichTree(f.request, f.input, 'job:excerpt-bank', model.port, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'budget-exceeded' })
  expect(model.calls).toEqual([])
})
it('shares reservations across expansion and summary, retaining no-gain decisions and rejecting invented structure', async () => {
  const f = fixture([{ title: 'Report', start: 1, end: 8 }], 'full'), model = scripted(false, prompt => prompt.includes('Return only {"subsections"')
    ? { text: '{"subsections":[]}', inputTokens: 20, outputTokens: 100 } : summary(prompt))
  f.request.budget.maxOutputTokens = 128
  await expect(enrichTree(f.request, f.input, 'job:phases', model.port, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'budget-exceeded' })
  expect(model.calls).toHaveLength(1)
  const kept = await enrichTree({ ...f.request, mode: 'expand' }, f.input, 'job:kept', scripted(false, () => ({ text: '{"subsections":[]}', inputTokens: 1, outputTokens: 1 })).port, () => {}, new AbortController().signal)
  expect(kept.decisions[0]).toMatchObject({ decision: 'kept-collapsed', costBefore: 8, costAfter: 8 })
  await expect(enrichTree({ ...f.request, mode: 'expand' }, f.input, 'job:invented', scripted(false, () => ({ text: '{"subsections":[{"title":"Invented","page":1}]}', inputTokens: 1, outputTokens: 1 })).port, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid-output' })
})
it('aborts a sibling on invalid JSON but never releases an abort-ignoring actual provider before its promise joins', async () => {
  const f = fixture(), model = controlled()
  let settled = false
  const work = enrichTree(f.request, f.input, 'job:invalid-sibling', model.port, () => {}, new AbortController().signal)
  void work.then(() => { settled = true }, () => { settled = true })
  const rejected = expect(work).rejects.toMatchObject({ code: 'invalid-output' })
  await model.wait(2); model.calls[0]!.done.resolve({ text: 'not JSON', inputTokens: 1, outputTokens: 1 })
  await model.calls[1]!.aborted.promise
  expect(settled).toBe(false); expect(model.active()).toBe(1); expect(model.calls).toHaveLength(2)
  model.calls[1]!.done.resolve(summary(model.calls[1]!.prompt)); await rejected
  expect(settled).toBe(true); expect(model.active()).toBe(0); expect(model.calls).toHaveLength(2)
})
it('joins all actual calls on user cancellation, controlled deadline and source revocation before returning failure', async () => {
  for (const cause of ['cancel', 'deadline', 'source'] as const) {
    const f = fixture(), model = controlled(), signal = new AbortController(), timer = new AbortController()
    let authorized = true, settled = false
    const clock = cause === 'deadline' ? vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timer.signal) : undefined
    const work = enrichTree(f.request, f.input, `job:${cause}`, model.port, () => { if (!authorized) throw new EnrichmentError('source-changed', 'Source permission changed') }, signal.signal)
    void work.then(() => { settled = true }, () => { settled = true })
    const rejected = expect(work).rejects.toThrow()
    await model.wait(2)
    if (cause === 'cancel') signal.abort(new Error('User cancelled'))
    else if (cause === 'deadline') timer.abort(new Error('Controlled wall deadline'))
    else { authorized = false; model.calls[0]!.done.resolve(summary(model.calls[0]!.prompt)) }
    await model.calls[1]!.aborted.promise
    expect(settled).toBe(false); expect(model.calls).toHaveLength(2)
    for (const call of model.calls) call.done.resolve(summary(call.prompt))
    await rejected; expect(model.active()).toBe(0); expect(model.calls).toHaveLength(2)
    clock?.mockRestore()
  }
})
it('does not dispatch a second reserved call after a synchronous first provider failure or dispatch-time abort', async () => {
  for (const cancel of [false, true]) {
    const f = fixture(), signal = new AbortController(); let calls = 0
    const port: EnrichmentModelPort = { identity: { provider: 'test', model: 'sync-failure' }, complete() {
      calls++
      if (cancel) { signal.abort(new Error('abort during first dispatch')); return Promise.resolve({ text: '{"summary":"first"}', inputTokens: 1, outputTokens: 1 }) }
      throw new EnrichmentError('invalid-output', 'Synchronous provider failure')
    } }
    await expect(enrichTree(f.request, f.input, 'job:sync', port, () => {}, signal.signal)).rejects.toThrow()
    expect(calls).toBe(1)
  }
})
it('rejects reservation overruns and invalid provider usage, with no partial overlay or new call after failure', async () => {
  for (const wrong of ['tokens', 'chars', 'negative', 'fraction', 'aggregate'] as const) {
    const f = fixture(), model = scripted(false, () => ({ text: wrong === 'chars' ? '文'.repeat(12001) : '{"summary":"small"}',
      inputTokens: wrong === 'aggregate' ? Number.MAX_SAFE_INTEGER : 1, outputTokens: wrong === 'tokens' ? 2049 : wrong === 'negative' ? -1 : wrong === 'fraction' ? 0.5 : 1 }))
    const before = JSON.stringify(f.input)
    await expect(enrichTree(f.request, f.input, 'job:invalid-usage', model.port, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid-output' })
    expect(model.calls).toHaveLength(2); expect(model.active()).toBe(0); expect(JSON.stringify(f.input)).toBe(before)
  }
})
it('freezes request, source pages/tree and provider attribution/method before caller mutation across an await', async () => {
  const f = fixture(), original = structuredClone(f), port = scripted(false), first = port.port.complete
  let changed = false
  port.port.complete = function (prompt, limits, signal) {
    if (!changed) {
      changed = true; f.request.budget.maxModelCalls = 1; f.request.nodeIds.length = 0; f.input.pages[2]!.text = 'MUTATED SOURCE'
      f.input.tree.nodes[2]!.title = 'MUTATED TITLE'; f.input.source.representationContentHash = 'f'.repeat(64)
      port.port.identity.provider = 'changed-provider'; port.port.complete = () => { throw new Error('Changed method must not be called') }
    }
    return first.call(this, prompt, limits, signal)
  }
  const result = await enrichTree(f.request, f.input, 'job:frozen', port.port, () => {}, new AbortController().signal)
  expect(result.provider).toEqual({ provider: 'scripted-test', model: 'same-source' }); expect(result.usage.calls).toBe(3)
  expect(result.nodes.map(node => node.title)).toEqual(['A', 'B', 'C']); expect(port.calls.every(call => !call.prompt.includes('MUTATED'))).toBe(true)
  expect(result.inputHash).toBe(enrichmentHash({ input: original.input, request: original.request })); expect(result.representationHash).toBe(original.input.source.representationContentHash)
})
it('fails closed before model dispatch for tampered base seals, missing source pages, node budgets and pre-cancelled requests', async () => {
  const f = fixture(), model = scripted(false)
  const tampered = structuredClone(f.input); tampered.tree.nodes[0]!.title = 'Wrong sealed title'
  await expect(enrichTree(f.request, tampered, 'job:tampered', model.port, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'source-changed' })
  await expect(enrichTree(f.request, { ...f.input, pages: f.input.pages.slice(1) }, 'job:missing', model.port, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid-output' })
  await expect(enrichTree({ ...f.request, budget: { ...f.request.budget, maxNodes: 1 } }, f.input, 'job:nodes', model.port, () => {}, new AbortController().signal)).rejects.toMatchObject({ code: 'budget-exceeded' })
  await expect(enrichTree(f.request, f.input, 'job:cancelled', model.port, () => {}, AbortSignal.abort(new Error('Already cancelled')))).rejects.toThrow('Already cancelled')
  expect(model.calls).toEqual([])
})
