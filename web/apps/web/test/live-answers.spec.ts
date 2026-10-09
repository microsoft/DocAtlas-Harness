import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { AnswerResponse, CitationFocus, ConversationSnapshot, NativeHistoryOrigin } from '@docatlas/contracts'
import { LiveClient, type EventStream } from '../src/live/client'
import { LiveAnswerBody, citationReaderTarget } from '../src/live/Answers'

const fixtures = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/product-answer.json', import.meta.url), 'utf8')) as { bases: { response: AnswerResponse, focus: CitationFocus } }
const observations = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/conversation-observations.json', import.meta.url), 'utf8')) as { valid: Array<ConversationSnapshot> }
const cleanup: Array<() => void> = []
afterEach(() => { while (cleanup.length) cleanup.pop()!() })
const hash = (text: string) => createHash('sha256').update(text).digest('hex')

function setup() {
  const response = structuredClone(fixtures.bases.response), focus = structuredClone(fixtures.bases.focus), manifest = response.manifest!
  const snapshot = structuredClone(observations.valid.find(value => value.kind === 'conversation-snapshot')!)
  snapshot.binding.conversationId = response.conversationId; snapshot.binding.workspaceId = manifest.workspaceId
  snapshot.runs = []; snapshot.live = []; snapshot.activity = []
  const rawText = `[${manifest.blocks[0]!.segments[0]!.text}](#docatlas.v1.support.${manifest.citations[0]!.locator.locatorId})`
  snapshot.history = { hasEarlier: false, checkpoint: {
    schemaVersion: 1, kind: 'pi-checkpoint', submissionId: 'submission:answer', requestHash: 'a'.repeat(64), runtimeSessionId: snapshot.binding.runtimeSessionId,
    userEntryId: 'entry:question', leafEntryId: response.messageId, transcriptHash: 'b'.repeat(64), byteLength: 1234, entryCount: 3, settledAt: snapshot.binding.updatedAt,
  }, messages: [{ entryId: response.messageId, role: 'assistant', text: rawText, truncated: false }] }
  response.nativeTextHash = hash(rawText)
  response.manifest!.answerTextHash = hash(manifest.blocks.map(block => block.segments.map(segment => segment.text).join('')).join('\n\n'))
  const other = { ...snapshot.binding, conversationId: 'conversation:other', bindingId: 'binding:other', runtimeSessionId: 'session:other' }
  const stored = new Map<string, string>(), requests: Array<{ path: string, options: RequestInit | undefined }> = []
  let reply: unknown = response, gate: Promise<void> | undefined
  const requested = Promise.withResolvers<void>(), json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
  const client = new LiveClient({ storage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => { stored.set(key, value) }, removeItem: key => { stored.delete(key) }, key: index => [...stored.keys()][index] ?? null, get length() { return stored.size } },
    events: () => ({ addEventListener() {}, close() {}, onerror: null, onopen: null }) satisfies EventStream,
    fetch: (async (input, options) => {
      const path = String(input)
      if (path === '/api/bootstrap') return json({ schemaVersion: 1, kind: 'bootstrap', actor: { actorId: snapshot.binding.ownerActorId, workspaceId: snapshot.binding.workspaceId }, csrfToken: 'a'.repeat(43) })
      if (path === '/api/conversations') return json({ schemaVersion: 1, kind: 'conversation-list', items: [snapshot.binding, other], nextCursor: null })
      if (path.endsWith('/snapshot')) return json(path.includes(encodeURIComponent(other.conversationId)) ? { ...snapshot, binding: other, history: { checkpoint: null, messages: [], hasEarlier: false } } : snapshot)
      if (path.includes('/answers/')) { requests.push({ path, options }); requested.resolve(); await gate; return json(path.includes('/citations/') ? focus : reply) }
      if (path === '/api/auth/logout') return new Response(null, { status: 204 })
      throw new Error(`Unexpected test route ${path}`)
    }) as typeof fetch,
  })
  cleanup.push(() => client.dispose())
  return { client, response, focus, snapshot, other, requests, requested, reply(value: unknown) { reply = value }, delay(value: Promise<void>) { gate = value } }
}

describe('live saved Answer binding and original-PDF presentation', () => {
  it('binds a saved native marker message and the displayed spans using separate hashes', async () => {
    const fixture = setup(); await fixture.client.start()
    expect(fixture.response.nativeTextHash).not.toBe(fixture.response.manifest!.answerTextHash)
    await expect(fixture.client.answerRequest(fixture.response.conversationId, fixture.response.messageId)).resolves.toEqual(fixture.response)
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.requests[0]!.options?.method).toBe('GET')
    const unavailable: AnswerResponse = { ...fixture.response, status: 'unavailable', nativeTextHash: null, manifest: null }
    fixture.reply(unavailable)
    await expect(fixture.client.answerRequest(fixture.response.conversationId, fixture.response.messageId)).resolves.toEqual(unavailable)
  })

  it('rejects wrong native/display hashes, foreign identity, and unresolved citation references', async () => {
    const fixture = setup(); await fixture.client.start()
    const variants = [
      (value: AnswerResponse) => { value.nativeTextHash = 'f'.repeat(64) },
      (value: AnswerResponse) => { value.manifest!.answerTextHash = 'f'.repeat(64) },
      (value: AnswerResponse) => { value.manifest!.workspaceId = 'workspace:foreign' },
      (value: AnswerResponse) => { value.messageId = 'message:foreign' },
      (value: AnswerResponse) => { value.manifest!.blocks[0]!.segments[0]!.visibleCitationIds = ['citation:missing'] },
    ]
    for (const mutate of variants) {
      const next = structuredClone(fixture.response); mutate(next); fixture.reply(next)
      await expect(fixture.client.answerRequest(fixture.response.conversationId, fixture.response.messageId)).rejects.toThrow()
    }
  })

  it('never requests citations for live-only, user or truncated messages', async () => {
    const fixture = setup(); await fixture.client.start()
    await expect(fixture.client.answerRequest(fixture.response.conversationId, 'live:pending')).rejects.toThrow('complete persisted message')
    for (const change of ['user', 'truncated'] as const) {
      fixture.snapshot.history.messages[0] = { ...fixture.snapshot.history.messages[0]!, role: change === 'user' ? 'user' : 'assistant', truncated: change === 'truncated' }
      await fixture.client.refresh()
      await expect(fixture.client.answerRequest(fixture.response.conversationId, fixture.response.messageId)).rejects.toThrow('complete persisted message')
    }
    expect(fixture.requests).toHaveLength(0)
  })

  it('sends only the citation ID with CSRF and builds an original-PDF route for that exact revision', async () => {
    const fixture = setup(); await fixture.client.start()
    const citation = fixture.response.manifest!.citations[0]!
    const result = await fixture.client.answerRequest(fixture.response.conversationId, fixture.response.messageId, citation.citationId)
    expect(result).toEqual(fixture.focus)
    expect(fixture.requests[0]!.options).toMatchObject({ method: 'POST', body: '{}', credentials: 'same-origin', headers: { 'x-docatlas-csrf': 'a'.repeat(43) } })
    const target = citationReaderTarget(fixture.response.conversationId, fixture.response.messageId, citation, fixture.focus)
    expect(target.source.kind).toBe('server'); expect(target.source.url).toMatch(/^\/api\/conversations\/[^/]+\/documents\/[^/]+\/[^/]+\/original$/)
    expect(target.source.url).not.toContain('markdown'); expect(target.focus).toMatchObject({ context: 'citation', resolution: 'resolved', quote: fixture.focus.exactText, page: fixture.focus.physicalPage })
    for (const status of ['page-only', 'ambiguous'] as const) expect(citationReaderTarget(fixture.response.conversationId, fixture.response.messageId, citation, { ...fixture.focus, status, exactText: null }).focus).toMatchObject({ resolution: status, quote: '' })
    const foreign = structuredClone(fixture.focus); foreign.locator.representationContentHash = 'c'.repeat(64)
    expect(() => citationReaderTarget(fixture.response.conversationId, fixture.response.messageId, citation, foreign)).toThrow('identity changed')
    foreign.locator = structuredClone(fixture.focus.locator); foreign.original.revisionId = 'revision:other'
    expect(() => citationReaderTarget(fixture.response.conversationId, fixture.response.messageId, citation, foreign)).toThrow('identity changed')
  })

  it('rejects responses that arrive after logout or a conversation switch', async () => {
    for (const transition of ['logout', 'switch'] as const) {
      const fixture = setup(), gate = Promise.withResolvers<void>(); await fixture.client.start(); fixture.delay(gate.promise)
      const outcome = fixture.client.answerRequest(fixture.response.conversationId, fixture.response.messageId).then(value => ({ value }), error => ({ error }))
      await fixture.requested.promise
      if (transition === 'logout') await fixture.client.logout(); else await fixture.client.select(fixture.other.conversationId)
      gate.resolve()
      expect(await outcome).toMatchObject({ error: { message: 'Answer context changed' } })
    }
  })

  it.each(['navigation', 'fork'] as const)('preserves the original canonical Answer and original-PDF focus after %s', async kind => {
    const fixture = setup(), parent = fixture.response.conversationId, original = structuredClone(fixture.response.manifest!)
    const origin: NativeHistoryOrigin = { conversationId: parent, bindingId: fixture.snapshot.binding.bindingId, generation: fixture.snapshot.binding.generation,
      runtimeSessionId: fixture.snapshot.binding.runtimeSessionId, entryId: fixture.response.messageId }
    fixture.snapshot.binding = { ...fixture.snapshot.binding, conversationId: kind === 'fork' ? 'conversation:fork' : parent, bindingId: 'binding:selected',
      generation: kind === 'fork' ? 1 : origin.generation + 1, runtimeSessionId: kind === 'fork' ? 'session:fork' : origin.runtimeSessionId }
    const cid = fixture.snapshot.binding.conversationId
    fixture.snapshot.history = { ...fixture.snapshot.history, checkpoint: null, selectedHead: { version: 1,
      fileSeal: { version: 1, sessionId: fixture.snapshot.binding.runtimeSessionId, transcriptHash: 'b'.repeat(64), byteLength: 1234, entryCount: 5, tailEntryId: 'entry:tail' },
      selectedLeafEntryId: 'entry:selected', contextHash: 'c'.repeat(64) }, messages: fixture.snapshot.history.messages.map(message => ({ ...message, origin })) }
    fixture.response.conversationId = cid; fixture.response.origin = origin; fixture.focus.conversationId = cid
    await fixture.client.start()
    await expect(fixture.client.answerRequest(cid, fixture.response.messageId)).resolves.toMatchObject({ origin, manifest: original })
    const focus = await fixture.client.answerRequest(cid, fixture.response.messageId, fixture.focus.citationId)
    expect(focus).toEqual(fixture.focus)
    const target = citationReaderTarget(cid, fixture.response.messageId, original.citations[0]!, fixture.focus)
    expect(target.source.url).toContain(encodeURIComponent(cid)); expect(target.source.serverRevision?.revisionId).toBe(fixture.focus.locator.revisionId)
    expect(fixture.response.manifest).toEqual(original); expect(fixture.response.manifest!.sessionId).toBe(parent)
  })

  it('requires an inherited Answer origin to exactly match saved native history, not only its text hash', async () => {
    const fixture = setup(), parent = fixture.response.conversationId
    const origin: NativeHistoryOrigin = { conversationId: parent, bindingId: 'binding:original', generation: 1, runtimeSessionId: 'session:original', entryId: fixture.response.messageId }
    fixture.snapshot.binding.conversationId = 'conversation:child'; fixture.response.conversationId = 'conversation:child'; fixture.response.origin = origin
    fixture.snapshot.history.messages[0]!.origin = origin
    await fixture.client.start()
    await expect(fixture.client.answerRequest('conversation:child', fixture.response.messageId)).resolves.toMatchObject({ origin })
    for (const change of ['missing', 'generation', 'binding', 'session', 'conversation'] as const) {
      const value = structuredClone(fixture.response)
      if (change === 'missing') { delete value.origin; value.manifest!.sessionId = 'conversation:child' }
      else if (change === 'generation') value.origin!.generation++
      else if (change === 'binding') value.origin!.bindingId = 'binding:wrong'
      else if (change === 'session') value.origin!.runtimeSessionId = 'session:wrong'
      else { value.origin!.conversationId = 'conversation:wrong'; value.manifest!.sessionId = 'conversation:wrong' }
      fixture.reply(value)
      await expect(fixture.client.answerRequest('conversation:child', fixture.response.messageId)).rejects.toThrow()
    }
  })

  it('rejects a citation response when the selected head changes with identical file bytes and no new question', async () => {
    const fixture = setup(), gate = Promise.withResolvers<void>()
    fixture.snapshot.history = { ...fixture.snapshot.history, checkpoint: null, selectedHead: { version: 1,
      fileSeal: { version: 1, sessionId: fixture.snapshot.binding.runtimeSessionId, transcriptHash: 'b'.repeat(64), byteLength: 1234, entryCount: 5, tailEntryId: 'entry:tail' },
      selectedLeafEntryId: 'entry:selected', contextHash: 'c'.repeat(64) } }
    await fixture.client.start(); fixture.delay(gate.promise)
    const outcome = fixture.client.answerRequest(fixture.response.conversationId, fixture.response.messageId, fixture.focus.citationId).then(value => ({ value }), error => ({ error }))
    await fixture.requested.promise; fixture.snapshot.history.selectedHead!.contextHash = 'd'.repeat(64); await fixture.client.refresh(); gate.resolve()
    expect(await outcome).toMatchObject({ error: { message: 'Answer context changed' } })
  })

  it('renders distinct relation buttons and unresolved labels, never model-supplied HTML/Markdown links', () => {
    for (const [relation, label] of [['support', '支持'], ['refute', '反驳'], ['qualify', '限定']] as const) {
      const manifest = structuredClone(fixtures.bases.response.manifest!)
      manifest.citations[0]!.relation = relation
      manifest.blocks[0]!.segments[0]!.text = '<script>unsafe()</script> [fake](https://example.invalid/file.md)'
      manifest.blocks[0]!.segments[0]!.status = 'unresolved'
      const html = renderToStaticMarkup(createElement(LiveAnswerBody, { manifest, busy: false, onCitation() {} }))
      expect(html).toContain(`live-citation ${relation}`); expect(html).toContain(label); expect(html).not.toContain('live-citation-explanation')
      expect(html).toContain('Agent 的判断'); expect(html).toContain('&lt;script&gt;')
      expect(html).not.toContain('<script>'); expect(html).not.toContain('<a '); expect(html).not.toContain('href=')
    }
  })

  it('keeps locator-only citations as noninteractive unverified page clues', () => {
    const manifest = structuredClone(fixtures.bases.response.manifest!), citation = manifest.citations[0]!
    citation.verificationStatus = 'locator-only'; delete citation.evidence
    manifest.blocks[0]!.segments[0]!.status = 'unresolved'
    const html = renderToStaticMarkup(createElement(LiveAnswerBody, { manifest, busy: false, onCitation() { throw new Error('Unverified citation must not open') } }))
    expect(html).toContain('data-citation-state="locator-only"'); expect(html).toContain('定位线索 1 · 第 17 页（未核验）')
    expect(html).not.toContain('live-citation-explanation'); expect(html).not.toContain('live-answer-actions'); expect(html).not.toContain('live-answer-disclaimer')
    expect(html).not.toContain('<button'); expect(html).not.toContain('打开原始 PDF'); expect(html).not.toContain('data-citation-id=')
    expect(() => citationReaderTarget(manifest.sessionId, manifest.messageId, citation, fixtures.bases.focus)).toThrow('no verified Read evidence')
  })
})
