import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPiTestModel } from '@docatlas/runtime-pi/testing'
import { parseContract } from '@docatlas/contracts/node'
import type { LibraryDocument, M4RpcResult, ProductBinding, ProductReviewCommand, ProductReviewWorkspace, ProductRunReceipt, ScopedSourceIdentity, TextBlockItem } from '@docatlas/contracts'
import { startDocAtlasApplication, type DocAtlasApplicationOptions } from '../src/application.js'

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })
type Application = Awaited<ReturnType<typeof startDocAtlasApplication>>
interface Session { app: Application, binding: ProductBinding, cookie: string, headers: Record<string, string> }
async function open(options: DocAtlasApplicationOptions): Promise<Session> {
  const app = await startDocAtlasApplication(options); cleanups.push(() => app.close())
  const response = await fetch(`${app.origin}/api/auth/exchange`, { method: 'POST', headers: { origin: app.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ schemaVersion: 1, kind: 'auth-exchange', code: app.pairingCode }) })
  expect(response.status).toBe(200)
  const paired = parseContract('product-http', await response.json())
  if (paired.kind !== 'bootstrap') throw new Error('Expected authenticated bootstrap')
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!, headers = { cookie, origin: app.origin, 'content-type': 'application/json', 'x-docatlas-csrf': paired.csrfToken }
  const listed = await fetch(`${app.origin}/api/conversations`, { headers })
  expect(listed.status).toBe(200)
  const listing = parseContract('product-http', await listed.json())
  if (listing.kind !== 'conversation-list' || listing.items.length !== 1) throw new Error('Expected the same one durable conversation')
  return { app, binding: listing.items[0]!, cookie, headers }
}
function url(session: Session, path: string) { return `${session.app.origin}/api/conversations/${encodeURIComponent(session.binding.conversationId)}/${path}` }
async function workspace(session: Session): Promise<ProductReviewWorkspace> {
  const response = await fetch(url(session, 'reviews'), { headers: { cookie: session.cookie } })
  expect(response.status).toBe(200)
  const value = parseContract('product-review', await response.json())
  if (value.kind !== 'review-workspace') throw new Error('Expected durable human Review workspace')
  return value
}
async function command<T extends M4RpcResult['resultType']>(session: Session, input: ProductReviewCommand, kind: T): Promise<Extract<M4RpcResult, { resultType: T }>> {
  const response = await fetch(url(session, 'reviews'), { method: 'POST', headers: session.headers, body: JSON.stringify(input) })
  expect(response.status).toBe(200)
  const value = parseContract('product-review', await response.json())
  if (value.kind !== 'review-result' || value.result.resultType !== kind) throw new Error(`Expected ${kind} durable receipt`)
  expect(value.idempotencyKey).toBe(input.idempotencyKey)
  return value.result as Extract<M4RpcResult, { resultType: T }>
}
async function snapshot(session: Session) {
  const response = await fetch(url(session, 'snapshot'), { headers: { cookie: session.cookie } })
  expect(response.status).toBe(200)
  const result = parseContract('conversation-observation', await response.json())
  if (result.kind !== 'conversation-snapshot') throw new Error('Expected native history projection')
  return result
}
async function receipt(session: Session, id: string): Promise<ProductRunReceipt> {
  const response = await fetch(`${session.app.origin}/api/submissions/${encodeURIComponent(id)}`, { headers: { cookie: session.cookie } })
  expect(response.status).toBe(200)
  const value = parseContract('product-control', await response.json())
  if (value.kind !== 'run-receipt') throw new Error('Expected actual submission receipt')
  return value
}
function nativeBytes(options: DocAtlasApplicationOptions, binding: ProductBinding): Buffer {
  const directory = join(options.root, 'runtime', binding.runtimeSessionId, 'sessions'), files = readdirSync(directory).filter(name => name.endsWith('.jsonl'))
  expect(files).toHaveLength(1)
  return readFileSync(join(directory, files[0]!))
}
/** Inspect the model's actual preceding native tool result, not a second document API. */
function toolResult(messages: readonly unknown[], name: string): unknown {
  const value = [...messages].reverse().find(message => message !== null && typeof message === 'object' && Reflect.get(message, 'role') === 'toolResult' && Reflect.get(message, 'toolName') === name)
  if (!value || typeof value !== 'object' || Reflect.get(value, 'isError')) throw new Error(`Expected successful ${name} result`)
  const content: unknown = Reflect.get(value, 'content')
  if (!Array.isArray(content)) throw new Error('Native result has no content')
  const text = content.find(part => part !== null && typeof part === 'object' && Reflect.get(part, 'type') === 'text')
  if (!text || typeof text.text !== 'string') throw new Error('Native result has no JSON text')
  return JSON.parse(text.text)
}

describe.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/bwrap'))('actual isolated Pi, real PDF and authenticated human Review; explicit faux model only', () => {
  it('persists uploaded-PDF Evidence through Claim, Review, approval and publication, then reopens without repeating native generation', async () => {
    let selected: ScopedSourceIdentity | undefined, readItem: TextBlockItem | undefined
    const model = await createPiTestModel({ answers: [
      { calls: [{ name: 'docatlas_sources', args: {} }] },
      messages => {
        const result = toolResult(messages, 'docatlas_sources') as { sources: ScopedSourceIdentity[], scopeVersionId: string }
        expect(result.sources).toHaveLength(1); expect(result.scopeVersionId).toBeTruthy(); selected = result.sources[0]!
        return { calls: [{ name: 'docatlas_read', args: { documentId: selected.documentId, revisionId: selected.revisionId, mode: 'page', physicalPage: 2, maxItems: 20, maxChars: 6000 } }] }
      },
      messages => {
        const result = parseContract('sidecar-document-rpc', toolResult(messages, 'docatlas_read'))
        if (!('resultType' in result) || result.resultType !== 'read' || result.mode !== 'page') throw new Error('Expected actual page Read result')
        expect(result.source.documentId).toBe(selected!.documentId)
        readItem = result.items.filter((item): item is TextBlockItem => item.itemType === 'block' && item.text.includes('Q4')).sort((a, b) => b.text.length - a.text.length)[0]
        if (!readItem) throw new Error('The real sample PDF Read has no Q4 block')
        expect(readItem.locator.selectors.some(selector => selector.type === 'text-quote' && selector.exact === readItem!.text)).toBe(true)
        return `[原文列出了 Q4 营收数据。](#docatlas.v1.support.${readItem.locator.locatorId})`
      },
    ] })
    const temporary = mkdtempSync(join(tmpdir(), 'docatlas-real-review-')); cleanups.push(() => rmSync(temporary, { recursive: true, force: true }))
    const projectRoot = realpathSync(resolve('.')), options: DocAtlasApplicationOptions = { root: join(temporary, 'app'), projectRoot, webRoot: join(projectRoot, 'apps/web/dist'),
      port: 0, modelRuntime: model.modelRuntime, models: model.models }
    const session = await open(options), pdf = readFileSync(join(projectRoot, 'apps/web/public/documents/sample-report.pdf')), originalHash = hash(pdf)
    expect(model.getCallCount()).toBe(0)
    const reservation = await fetch(url(session, 'uploads'), { method: 'POST', headers: session.headers, body: JSON.stringify({ schemaVersion: 1, kind: 'upload-start',
      idempotencyKey: 'upload:real-review', name: '真实审阅测试.pdf', byteLength: pdf.length, contentHash: originalHash }) })
    expect(reservation.status).toBe(200)
    const upload = parseContract('document-http', await reservation.json())
    if (upload.kind !== 'upload') throw new Error('Expected actual upload reservation')
    const transferred = await fetch(url(session, `uploads/${encodeURIComponent(upload.uploadId)}`), { method: 'PUT', headers: { ...session.headers, 'content-type': 'application/pdf' }, body: pdf })
    expect(transferred.status).toBe(200)
    const imported = await fetch(url(session, `uploads/${encodeURIComponent(upload.uploadId)}/import`), { method: 'POST', headers: session.headers, body: '{}' })
    expect(imported.status).toBe(202)
    let document: LibraryDocument | undefined
    await expect.poll(async () => {
      const response = await fetch(url(session, `uploads/${encodeURIComponent(upload.uploadId)}/job`), { headers: { cookie: session.cookie } })
      expect(response.status).toBe(200)
      const job = parseContract('document-http', await response.json())
      if (job.kind !== 'library-response' || job.result.resultType !== 'library-job') throw new Error('Expected actual PDF import state')
      if (job.result.status === 'failed' || job.result.status === 'cancelled') throw new Error(`PDF import ${job.result.status}: ${job.result.error?.code}`)
      document = job.result.document; return job.result.status
    }, { timeout: 60000, interval: 250 }).toBe('succeeded')
    expect(document?.currentRevision.contentHash).toBe(originalHash); expect(model.getCallCount()).toBe(0)
    const submission = { schemaVersion: 1, kind: 'submission', conversationId: session.binding.conversationId, expectedGeneration: session.binding.generation,
      idempotencyKey: 'submission:real-review', mode: 'prompt', text: '阅读第二页 Q4 条目，并提供可回到原文的引用。', sourceRefs: [{ documentId: document!.documentId, revisionId: document!.currentRevision.revisionId }], selectionContextIds: [] }
    const accepted = await fetch(`${session.app.origin}/api/submissions`, { method: 'POST', headers: session.headers, body: JSON.stringify(submission) })
    expect(accepted.status).toBe(202)
    const first = parseContract('product-control', await accepted.json())
    if (first.kind !== 'run-receipt') throw new Error('Expected accepted source-bound submission')
    await expect.poll(async () => ['completed', 'failed', 'cancelled'].includes((await receipt(session, first.submissionId)).state), { timeout: 60000, interval: 250 }).toBe(true)
    expect((await receipt(session, first.submissionId)).state).toBe('completed')
    expect(model.getCallCount()).toBe(3)
    const history = await snapshot(session), messageId = history.history.messages.filter(message => message.role === 'assistant').at(-1)!.entryId
    const answerResponse = await fetch(url(session, `answers/${encodeURIComponent(messageId)}`), { headers: { cookie: session.cookie } })
    expect(answerResponse.status).toBe(200)
    const answer = parseContract('product-answer', await answerResponse.json())
    if (answer.kind !== 'answer-response' || answer.status !== 'available' || !answer.manifest?.citations[0]?.evidence) throw new Error('Expected completed native Read-backed canonical Answer')
    const evidence = answer.manifest.citations[0].evidence, initial = await workspace(session), scopeVersionId = initial.scope!.scopeVersionId
    expect(initial.evidence).toMatchObject([{ evidenceId: evidence.evidenceId, physicalPage: 2, contentHash: evidence.contentHash }])
    expect(evidence.content.text).toBe(readItem!.text); expect(answer.manifest.citations[0].locator.locatorId).toBe(readItem!.locator.locatorId)
    let ordinal = 0
    const input = (fields: Record<string, unknown>): ProductReviewCommand => ({ schemaVersion: 1, kind: 'review-command', expectedGeneration: session.binding.generation,
      scopeVersionId, idempotencyKey: `human-review:${++ordinal}`, ...fields }) as ProductReviewCommand
    const claimRequest = input({ action: 'claim-save', expectedClaimVersionId: null, statement: evidence.content.text!, basis: 'document-supported', epistemicStatus: 'supported', reviewStatus: 'accepted',
      evidenceRelations: [{ evidenceId: evidence.evidenceId, kind: 'supports', coverage: 'full' }], derivation: { operation: 'extract', inputClaimVersionIds: [] } })
    expect((await fetch(url(session, 'reviews'))).status).toBe(401)
    const { 'x-docatlas-csrf': _csrf, ...noCsrf } = session.headers
    expect((await fetch(url(session, 'reviews'), { method: 'POST', headers: noCsrf, body: JSON.stringify(claimRequest) })).status).toBe(403)
    for (const [body, status] of [[{ ...claimRequest, actorId: 'actor:admin' }, 400], [{ ...claimRequest, scopeVersionId: 'scope:foreign' }, 403], [{ ...claimRequest, expectedGeneration: session.binding.generation + 1 }, 409]] as const) {
      expect((await fetch(url(session, 'reviews'), { method: 'POST', headers: session.headers, body: JSON.stringify(body) })).status).toBe(status)
    }
    expect(await workspace(session)).toEqual(initial)
    const claim = await command(session, claimRequest, 'm4-claim-record')
    const artifact = await command(session, input({ action: 'artifact-create', artifactKind: 'brief', title: 'Q4 原文审阅', claims: [{ claimVersionId: claim.claim.claimVersionId, useKind: 'assertion' }] }), 'm4-artifact-draft')
    const failure = await command(session, input({ action: 'review-run', artifactManifestId: artifact.manifest.artifactManifestId }), 'm4-review-run')
    expect(failure.review).toMatchObject({ decision: 'fail', issues: expect.arrayContaining([expect.objectContaining({ code: 'conflict-search-incomplete' })]) })
    const approveFailed = await fetch(url(session, 'reviews'), { method: 'POST', headers: session.headers, body: JSON.stringify(input({ action: 'review-decide', reviewResultId: failure.review.reviewResultId, decision: 'approved' })) })
    expect(approveFailed.status).toBe(409)
    await command(session, input({ action: 'review-attest', artifactManifestId: artifact.manifest.artifactManifestId, attestation: 'listed-evidence-reviewed' }), 'm4-conflict-search-assurance')
    const reviewed = await command(session, input({ action: 'review-run', artifactManifestId: artifact.manifest.artifactManifestId }), 'm4-review-run')
    expect(reviewed.review).toMatchObject({ decision: 'needs-human', issues: [], signoffRequirement: 'required' })
    const approved = await command(session, input({ action: 'review-decide', reviewResultId: reviewed.review.reviewResultId, decision: 'approved', rationale: '已核对原文引用，保留完整出处。' }), 'm4-human-decision')
    const publish = input({ action: 'artifact-publish', artifactManifestId: artifact.manifest.artifactManifestId, reviewResultId: reviewed.review.reviewResultId, humanReviewDecisionId: approved.reviewDecision.reviewDecisionId })
    const published = await command(session, publish, 'm4-artifact-publish')
    expect(published.manifest).toMatchObject({ status: 'published', contentHash: artifact.manifest.contentHash, content: artifact.manifest.content })
    expect(await command(session, publish, 'm4-artifact-publish')).toEqual({ ...published, status: 'replayed' })
    const focusResponse = await fetch(url(session, `reviews/evidence/${encodeURIComponent(evidence.evidenceId)}/focus`), { method: 'POST', headers: session.headers, body: JSON.stringify({ scopeVersionId }) })
    expect(focusResponse.status).toBe(200)
    expect(parseContract('product-review', await focusResponse.json())).toMatchObject({ kind: 'review-focus', status: 'resolved', physicalPage: 2, exactText: readItem!.text,
      locator: { locatorId: readItem!.locator.locatorId }, original: { contentHash: originalHash, documentId: selected!.documentId, revisionId: selected!.revisionId } })
    const originalPath = `documents/${encodeURIComponent(selected!.documentId)}/${encodeURIComponent(selected!.revisionId)}/original`
    const originalResponse = await fetch(url(session, originalPath), { headers: { cookie: session.cookie } })
    expect(originalResponse.status).toBe(200); expect(Buffer.from(await originalResponse.arrayBuffer()).equals(pdf)).toBe(true)
    const before = await workspace(session), transcript = nativeBytes(options, session.binding)
    expect(before.artifacts[0]).toEqual(published.manifest); expect(before.decisions).toEqual([approved.reviewDecision]); expect(model.getCallCount()).toBe(3)
    await session.app.close()
    expect(nativeBytes(options, session.binding).equals(transcript)).toBe(true)
    const resumedModel = await createPiTestModel({ answers: [] }), reopened = await open({ ...options, modelRuntime: resumedModel.modelRuntime, models: resumedModel.models })
    expect(reopened.binding).toEqual(session.binding); expect(resumedModel.getCallCount()).toBe(0)
    expect(await workspace(reopened)).toEqual(before)
    expect((await snapshot(reopened)).history.messages).toEqual(history.history.messages)
    expect((await receipt(reopened, first.submissionId)).state).toBe('completed')
    expect(await command(reopened, publish, 'm4-artifact-publish')).toEqual({ ...published, status: 'replayed' })
    expect(nativeBytes(options, reopened.binding).equals(transcript)).toBe(true)
    expect(resumedModel.getCallCount()).toBe(0); expect(model.getCallCount()).toBe(3)
  }, 180000)
})
