import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import type { ContinuityAssessResult } from '@docatlas/contracts'
import { describe, expect, it } from 'vitest'

import {
  InvestigationContinuityStore,
} from '../src/storage/investigation-continuity-store.ts'

const fixture = JSON.parse(readFileSync(
  new URL('../../../contracts/fixtures/m5/research-continuity.valid.json', import.meta.url),
  'utf8',
)) as { assessments: { continuing: { result: ContinuityAssessResult } } }

describe('InvestigationContinuityStore', () => {
  it('persists an idempotent append-only continuity link and restores it', () => {
    const database = new DatabaseSync(':memory:')
    const link = {
      ...fixture.assessments.continuing.result.link,
      continuityLinkId: 'continuity:runtime:finance:1',
    }
    const store = InvestigationContinuityStore.attach(database, link.workspaceId)
    const requestHash = digest('request:finance:1')

    expect(store.commitLink('idempotency:runtime:finance:1', requestHash, link))
      .toMatchObject({ status: 'created', link: { state: 'continuing' } })
    expect(store.commitLink('idempotency:runtime:finance:1', requestHash, link).status)
      .toBe('replayed')
    expect(store.listLinks(link.investigationId)).toEqual([link])
    expect(store.getLink(link.continuityLinkId)).toEqual(link)
    expect(store.listJournal(link.investigationId)).toHaveLength(1)

    const reopened = InvestigationContinuityStore.attach(database, link.workspaceId)
    expect(reopened.getLink(link.continuityLinkId)).toEqual(link)
    InvestigationContinuityStore.verifyExisting(database, link.workspaceId)
    database.close()
  })

  it('rejects idempotency drift, cross-workspace writes, and journal tampering', () => {
    const database = new DatabaseSync(':memory:')
    const link = {
      ...fixture.assessments.continuing.result.link,
      continuityLinkId: 'continuity:runtime:finance:2',
    }
    const store = InvestigationContinuityStore.attach(database, link.workspaceId)
    store.commitLink('idempotency:runtime:finance:2', digest('request:finance:2'), link)

    expect(() => store.commitLink(
      'idempotency:runtime:finance:2',
      digest('different-request'),
      link,
    )).toThrowError(expect.objectContaining({ code: 'conflict' }))
    expect(() => store.commitLink(
      'idempotency:runtime:cross-workspace',
      digest('cross-workspace'),
      { ...link, workspaceId: 'workspace:forged' },
    )).toThrowError(expect.objectContaining({ code: 'invalid-request' }))

    database.exec('DROP TRIGGER investigation_continuity_events_no_update')
    database.prepare(`
      UPDATE investigation_continuity_events SET result_hash = ? WHERE sequence = 1
    `).run('f'.repeat(64))
    expect(() => store.verifyIntegrity()).toThrowError(expect.objectContaining({
      code: 'integrity-error',
    }))
    database.close()
  })

  it('refuses destructive mutation at the SQLite boundary', () => {
    const database = new DatabaseSync(':memory:')
    const link = {
      ...fixture.assessments.continuing.result.link,
      continuityLinkId: 'continuity:runtime:finance:3',
    }
    const store = InvestigationContinuityStore.attach(database, link.workspaceId)
    store.commitLink('idempotency:runtime:finance:3', digest('request:finance:3'), link)
    expect(() => database.exec('DELETE FROM investigation_continuity_events'))
      .toThrowError(/append-only/)
    expect(() => database.exec('UPDATE investigation_continuity_metadata SET schema_version = 2'))
      .toThrowError(/immutable/)
    database.close()
  })
})

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
