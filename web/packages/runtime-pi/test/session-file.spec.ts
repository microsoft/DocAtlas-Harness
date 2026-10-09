import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { inspectNativeSession, openNativeSession } from '../src/worker/session-file.js'

it('validates sealed native bytes without repairing malformed/foreign/ambiguous history', () => {
  const root = mkdtempSync(join(tmpdir(), 'docatlas-session-file-')), file = join(root, 'native.jsonl'), id = randomUUID()
  const header = { type: 'session', version: 3, id, cwd: root, timestamp: '2026-09-09T00:00:00.000Z' }
  const user = { type: 'message', id: 'user0001', parentId: null, timestamp: '2026-09-09T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'retained' }], timestamp: 1 } }
  const put = (entries: unknown[]) => writeFileSync(file, entries.map(value => JSON.stringify(value)).join('\n') + '\n')
  try {
    put([header, user])
    const original = inspectNativeSession(file, id, root).seal
    expect(openNativeSession(file, root, original).getSessionId()).toBe(id)
    expect(() => inspectNativeSession(file, randomUUID(), root)).toThrow('identity')
    expect(() => inspectNativeSession(file, id, join(root, 'other'))).toThrow('identity')
    put([header, user, user]); expect(() => inspectNativeSession(file, id, root)).toThrow('topology')
    put([header, { ...user, parentId: 'missing' }]); expect(() => inspectNativeSession(file, id, root)).toThrow('topology')
    writeFileSync(file, Buffer.from([0xff])); expect(() => inspectNativeSession(file, id, root)).toThrow()
    put([header, { ...user, message: { ...user.message, content: [{ type: 'text', text: 'altered' }] } }])
    expect(() => openNativeSession(file, root, original)).toThrow('seal mismatch')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
