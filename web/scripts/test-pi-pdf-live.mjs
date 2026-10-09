// Opt-in real Azure model + actual product HTTP/Pi/PDF publication smoke, using only the repository's synthetic PDF.
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startDocAtlasApplication } from '../apps/server/lib/index.js'
import { createAzureLunaModel } from '../packages/runtime-pi/lib/index.js'

if (process.argv.slice(2).join(' ') !== '--live') {
  process.stderr.write('Opt-in only: bash scripts/pnpmw exec node scripts/test-pi-pdf-live.mjs --live\n'); process.exitCode = 2
} else {
  const root = await mkdtemp(join(tmpdir(), 'docatlas-pi-pdf-live-'))
  let application, modelCalls = 0, phase = 'startup', lastReceiptState = null, lastRunError = null, lastApiStatus = null, conversationId, selectedDocument
  const transportStatuses = []
  const callBudget = process.env.DOCATLAS_SMOKE_CALL_BUDGET === '3' ? 3 : 8
  const naturalQuestion = process.env.DOCATLAS_SMOKE_NATURAL_QUESTION === '1'
  try {
    const provider = await createAzureLunaModel({ fetch: async (...args) => {
      if (++modelCalls > callBudget) throw new Error('smoke-call-budget')
      const response = await fetch(...args)
      transportStatuses.push(response.status)
      return response
    } })
    application = await startDocAtlasApplication({ ...provider, root, port: 0, projectRoot: resolve('.'), webRoot: resolve('apps/web/dist'), ...(naturalQuestion ? { localAccess: true } : {}) })
    const origin = application.origin
    const exchange = naturalQuestion ? await fetch(`${origin}/api/bootstrap`) : await fetch(`${origin}/api/auth/exchange`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, kind: 'auth-exchange', code: application.pairingCode }) })
    if (!exchange.ok) throw new Error('pairing')
    const session = await exchange.json(), cookie = exchange.headers.get('set-cookie')?.split(';')[0] ?? ''
    if (!cookie && !naturalQuestion) throw new Error('pairing-cookie')
    const api = async (path, body) => {
      const response = await fetch(`${origin}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, Cookie: cookie, 'x-docatlas-csrf': session.csrfToken, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000) })
      lastApiStatus = response.status
      if (!response.ok) throw new Error('product-api')
      return response.json()
    }
    const conversation = (await api('conversations')).items[0], base = `conversations/${encodeURIComponent(conversation.conversationId)}`
    conversationId = conversation.conversationId
    phase = 'pdf-import'
    const bytes = Buffer.from(await readFile('apps/web/fixtures/sample-report.pdf.base64', 'utf8'), 'base64'), contentHash = createHash('sha256').update(bytes).digest('hex')
    const upload = await api(`${base}/uploads`, { schemaVersion: 1, kind: 'upload-start', idempotencyKey: 'smoke:pi:real-pdf-upload', name: 'DocAtlas synthetic smoke.pdf', byteLength: bytes.length, contentHash })
    const stored = await fetch(`${origin}/api/${base}/uploads/${encodeURIComponent(upload.uploadId)}`, { method: 'PUT', headers: { Origin: origin, Cookie: cookie, 'x-docatlas-csrf': session.csrfToken, 'Content-Type': 'application/pdf' }, body: bytes, signal: AbortSignal.timeout(60000) })
    if (!stored.ok) throw new Error('pdf-upload')
    await api(`${base}/uploads/${encodeURIComponent(upload.uploadId)}/import`, {})
    const importDeadline = Date.now() + 60000
    for (;;) {
      const status = (await api(`${base}/uploads/${encodeURIComponent(upload.uploadId)}/job`)).result.status
      if (status === 'succeeded') break
      if (status === 'failed' || status === 'cancelled' || Date.now() >= importDeadline) throw new Error('pdf-import')
      await new Promise(resolve => setTimeout(resolve, 400))
    }
    const document = (await api(`${base}/documents`)).result.documents[0]
    selectedDocument = document
    phase = 'pi-answer'
    const accepted = await api('submissions', { schemaVersion: 1, kind: 'submission', conversationId: conversation.conversationId, expectedGeneration: conversation.generation,
      idempotencyKey: 'smoke:pi:real-pdf-question', mode: 'prompt',
      text: naturalQuestion ? '总结全文' : 'Use docatlas_sources, then docatlas_read with mode="page" and physicalPage=2 for the selected synthetic report. What Q4 revenue is reported? Answer in one short sentence, with that complete factual sentence wrapped as [factual sentence](#docatlas.v1.support.LOCATOR_ID), using the exact real Locator ID from Read. Do not invent an ID; do not use Bash or filesystem tools for this document question.',
      sourceRefs: [{ documentId: document.documentId, revisionId: document.currentRevisionId }], selectionContextIds: [] })
    const deadline = Date.now() + 150000
    let receipt
    for (;;) {
      receipt = await api(`submissions/${encodeURIComponent(accepted.submissionId)}`)
      lastReceiptState = receipt.state; lastRunError = receipt.errorCode ?? null
      if (receipt.state === 'completed') break
      if (['failed', 'cancelled', 'outcome-unknown'].includes(receipt.state) || Date.now() >= deadline) throw new Error('pi-answer')
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    phase = 'citation-publication'
    const snapshot = await api(`${base}/snapshot`), message = snapshot.history.messages.filter(message => message.role === 'assistant').at(-1)
    if (naturalQuestion && message) process.stdout.write(`SYNTHETIC_PDF_SUMMARY\n${message.text.slice(0,6000)}\n`)
    if (!message || (naturalQuestion ? message.text.trim().length < 80 : !/15\.2/.test(message.text))) throw new Error('incorrect-fixture-answer')
    if (naturalQuestion) {
      const runtime = await application.manager.get(application.actor, conversationId), native = await runtime.worker.snapshot()
      const reads = native.entries.filter(entry => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolName === 'docatlas_read' && !entry.message.isError)
        .map(entry => JSON.parse(entry.message.content.find(item => item.type === 'text').text)).filter(result => result.resultType === 'read' && result.mode === 'sequential'
          && result.source.documentId === document.documentId && result.source.revisionId === document.currentRevisionId)
      const pageCount = application.documents.store.getLibraryDocument(application.actor.workspaceId, document.documentId).currentRevision.pageCount
      const pages = new Set(reads.flatMap(result => result.items.map(item => item.physicalPage)))
      if (!pageCount || !reads.length || reads.at(-1).pageInfo.nextCursor || reads.at(-1).pageInfo.truncated
        || Array.from({ length: pageCount }, (_, index) => index + 1).some(page => !pages.has(page))) throw new Error('incomplete-fixture-read')
      process.stdout.write(`NATURAL_READ_COVERAGE ${pages.size}/${pageCount} pages; sequential EOF verified\n`)
    }
    const answer = await api(`${base}/answers/${encodeURIComponent(message.entryId)}`)
    if (answer.status !== 'available' || !answer.manifest?.citations.some(citation => citation.verificationStatus === 'read-verified')) throw new Error('citation-unavailable')
    const citation = answer.manifest.citations.find(citation => citation.verificationStatus === 'read-verified' && (naturalQuestion || citation.locator.physicalPage === 2))
    if (!citation) throw new Error('citation-unavailable')
    const focus = await api(`${base}/answers/${encodeURIComponent(message.entryId)}/citations/${encodeURIComponent(citation.citationId)}`, {})
    if (focus.status !== 'resolved' || focus.physicalPage !== citation.locator.physicalPage || focus.original.contentHash !== contentHash
      || (naturalQuestion ? !focus.exactText?.trim() : !focus.exactText?.includes('15.2'))) throw new Error('citation-resolution')
    process.stdout.write(`${naturalQuestion ? 'PI_AZURE_LUNA_NATURAL_PDF_OK' : 'PI_AZURE_LUNA_PDF_CITATION_OK'}\nReal Azure model calls: ${modelCalls}; completed checkpoint, attested citation and exact source-page resolution verified.\nThis synthetic-document smoke is not a corpus quality benchmark.\n`)
  } catch (error) {
    const failure = ['pairing', 'pairing-cookie', 'product-api', 'pdf-upload', 'pdf-import', 'pi-answer', 'incorrect-fixture-answer', 'incomplete-fixture-read', 'citation-unavailable', 'citation-resolution'].includes(error?.message) ? error.message : 'local-failure'
    let nativeStructure = []
    if (application && conversationId && lastReceiptState) try {
      const runtime = await application.manager.get(application.actor, conversationId), snapshot = await runtime.worker.snapshot()
      const names = new Set(['docatlas_sources', 'docatlas_search', 'docatlas_read', 'docatlas_tree', 'docatlas_enrichment', 'read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'])
      const argNames = new Set(['documentId', 'revisionId', 'mode', 'query', 'blockIds', 'targetBlockId', 'before', 'after', 'cursor', 'physicalPage', 'figureId', 'maxPixels', 'maxItems', 'maxChars'])
      nativeStructure = snapshot.entries.filter(entry => entry.type === 'message').map(entry => ({ role: entry.message.role,
        stop: entry.message.stopReason, error: entry.message.isError, tool: names.has(entry.message.toolName) ? entry.message.toolName : undefined,
        calls: Array.isArray(entry.message.content) ? entry.message.content.filter(item => item.type === 'toolCall').map(item => ({ name: names.has(item.name) ? item.name : 'other',
          ...(item.name === 'docatlas_read' ? { callIdLength: item.id?.length, args: Object.entries(item.arguments ?? {}).filter(([key]) => argNames.has(key)).map(([key, value]) => [key, value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value]),
            mode: ['locate', 'blocks', 'expand', 'sequential', 'visual', 'page'].includes(item.arguments?.mode) ? item.arguments.mode : 'other',
            documentMatches: item.arguments?.documentId === selectedDocument?.documentId, revisionMatches: item.arguments?.revisionId === undefined || item.arguments.revisionId === selectedDocument?.currentRevisionId,
            physicalPage: Number.isSafeInteger(item.arguments?.physicalPage) ? item.arguments.physicalPage : null } : {}) })) : [],
        documentError: entry.message.isError && Array.isArray(entry.message.content) ? /^Document operation ([a-z-]+);/.exec(entry.message.content.find(item => item.type === 'text')?.text ?? '')?.[1] ?? 'validation-or-other' : undefined }))
    } catch { /* Diagnostic failure cannot expand authority or replay the task. */ }
    process.stderr.write(`Real Pi PDF smoke did not pass at ${phase}; no credentials or raw error payloads were printed.\n${JSON.stringify({ failure, modelCalls, transportStatuses, lastApiStatus, lastReceiptState, lastRunError, nativeStructure })}\n`); process.exitCode = 1
  }
  finally { if (application) await application.close(); await rm(root, { recursive: true, force: true }) }
}
