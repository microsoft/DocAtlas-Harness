import { expect, it } from 'vitest'
import type { FauxModelDefinition, Message } from '@earendil-works/pi-ai'
import { createPiTestModel } from '../src/testing.js'

it('resolves explicit test-only callbacks from the received model context after response gating', async () => {
  const order: string[] = [], received: Array<readonly unknown[]> = []
  const fixture = await createPiTestModel({
    answers: [
      'static response still works',
      messages => { order.push('resolve'); received.push([...messages]); return { calls: [{ name: 'docatlas_read', args: { documentId: 'doc:from-context' } }] } },
      async messages => { order.push('resolve'); received.push([...messages]); return 'Citation based on the provided tool receipt.' },
    ],
    inspectMessages: () => { order.push('inspect') },
    beforeResponse: async () => { order.push('before') },
  })
  const messages: Message[] = [{ role: 'user', content: 'Read the selected source.', timestamp: 1 }]
  const run = async () => {
    const stream = fixture.modelRuntime.streamSimple(fixture.models[0]!, { messages }, { maxTokens: 256 })
    for await (const _event of stream) { /* Consume the real test provider stream. */ }
    return stream.result()
  }
  const first = await run()
  expect(first.content).toEqual(expect.arrayContaining([{ type: 'text', text: 'static response still works' }]))
  const second = await run()
  expect(second.stopReason).toBe('toolUse')
  expect(second.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'toolCall', name: 'docatlas_read', arguments: { documentId: 'doc:from-context' } })]))
  const third = await run()
  expect(third.content).toEqual(expect.arrayContaining([{ type: 'text', text: 'Citation based on the provided tool receipt.' }]))
  expect(received).toEqual([messages, messages])
  expect(order).toEqual(['inspect', 'before', 'inspect', 'before', 'resolve', 'inspect', 'before', 'resolve'])
  expect(fixture.getCallCount()).toBe(3)
})

it('registers an explicit bounded two-model catalog and uses each actually selected request model in native responses', async () => {
  const catalog: FauxModelDefinition[] = [{ id: 'plain', name: 'Plain test model', reasoning: false }, { id: 'reason', name: 'Reasoning test model', reasoning: true, contextWindow: 64000, maxTokens: 8000 }]
  const fixture = await createPiTestModel({ models: catalog, answers: ['first model response', 'second model response'] })
  expect(fixture.models.map(model => [model.id, model.reasoning])).toEqual([['plain', false], ['reason', true]])
  expect(fixture.models[1]).toMatchObject({ contextWindow: 64000, maxTokens: 8000 })
  catalog[0]!.id = 'mutated-after-registration'
  for (const model of fixture.models) {
    const stream = fixture.modelRuntime.streamSimple(model, { messages: [{ role: 'user', content: 'Use the selected test model.', timestamp: 1 }] }, { maxTokens: 256 })
    for await (const _event of stream) { /* Consume the same registered provider, not a cloned model alias. */ }
    const result = await stream.result()
    expect(result.model).toBe(model.id); expect(result.provider).toBe(model.provider)
  }
  expect(fixture.models[0]!.id).toBe('plain'); expect(fixture.getCallCount()).toBe(2)
})

it('rejects unbounded, ambiguous or network-shaped test catalogs while preserving default and modelLimits behavior', async () => {
  for (const models of [[], Array.from({ length: 9 }, (_, index) => ({ id: `model-${index}` })), [{ id: 'same' }, { id: 'same' }], [{ id: '' }],
    [{ id: 'private', endpoint: 'https://external.invalid' }], [{ id: 'small', contextWindow: 1000 }], [{ id: 'overflow', maxTokens: Number.POSITIVE_INFINITY }],
    [{ id: 'oversized', contextWindow: 2000, maxTokens: 3000 }], [{ id: 'defaults-exceed-context', contextWindow: 2048 }]]) {
    await expect(createPiTestModel({ models: models as FauxModelDefinition[], answers: [] })).rejects.toThrow(/test model/u)
  }
  await expect(createPiTestModel({ models: [{ id: 'one' }], modelLimits: { contextWindow: 32000, maxTokens: 1000 }, answers: [] })).rejects.toThrow('catalog')
  expect((await createPiTestModel({ answers: [] })).models).toHaveLength(1)
  expect((await createPiTestModel({ answers: [], modelLimits: { contextWindow: 32000, maxTokens: 1000 } })).models[0]).toMatchObject({ id: 'docatlas-bounded-context-test', contextWindow: 32000, maxTokens: 1000 })
})
