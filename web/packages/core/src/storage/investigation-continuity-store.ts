import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import {
  continuityRpcIssues,
  type ContinuityAssessResult,
  type ContinuityLink,
} from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'

const CONTINUITY_STORE_SCHEMA_VERSION = 1
const MAX_CONTINUITY_EVENTS = 50_000

export type InvestigationContinuityStoreErrorCode =
  | 'invalid-request'
  | 'conflict'
  | 'limit-exceeded'
  | 'integrity-error'

export class InvestigationContinuityStoreError extends Error {
  constructor(
    readonly code: InvestigationContinuityStoreErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'InvestigationContinuityStoreError'
  }
}

export interface ContinuityMutationResult {
  status: 'created' | 'replayed'
  link: ContinuityLink
}

export interface ContinuityJournalEntry {
  sequence: number
  eventId: string
  investigationId: string
  continuityLinkId: string
  createdAt: string
  eventHash: string
}

interface StoredContinuityEvent {
  sequence: number
  eventId: string
  workspaceId: string
  investigationId: string
  continuityLinkId: string
  idempotencyKey: string
  requestHash: string
  payloadJson: string
  payloadHash: string
  resultJson: string
  resultHash: string
  previousEventHash: string
  eventHash: string
  createdAt: string
}

/**
 * Append-only Research Continuity adapter over the workspace-owned
 * Investigation SQLite database. The caller owns the database lifecycle.
 */
export class InvestigationContinuityStore {
  private constructor(
    private readonly database: DatabaseSync,
    private readonly workspaceId: string,
  ) {}

  static attach(database: DatabaseSync, workspaceId: string): InvestigationContinuityStore {
    requireId(workspaceId, 'workspaceId')
    initializeSchema(database, workspaceId)
    const store = new InvestigationContinuityStore(database, workspaceId)
    store.verifyIntegrity()
    return store
  }

  static verifyExisting(database: DatabaseSync, workspaceId: string): void {
    const table = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'investigation_continuity_events'
    `).get()
    if (table === undefined) return
    const metadata = database.prepare(`
      SELECT schema_version, workspace_id
      FROM investigation_continuity_metadata
      WHERE singleton = 1
    `).get() as Record<string, unknown> | undefined
    if (metadata === undefined
      || integerColumn(metadata, 'schema_version') !== CONTINUITY_STORE_SCHEMA_VERSION
      || stringColumn(metadata, 'workspace_id') !== workspaceId) {
      integrity('Continuity store metadata is missing or belongs to another workspace')
    }
    new InvestigationContinuityStore(database, workspaceId).verifyIntegrity()
  }

  commitLink(
    idempotencyKey: string,
    requestHash: string,
    linkCandidate: ContinuityLink,
  ): ContinuityMutationResult {
    requireId(idempotencyKey, 'idempotencyKey')
    requireSha256(requestHash, 'requestHash')
    const link = parseContinuityLink(linkCandidate)
    if (link.workspaceId !== this.workspaceId) {
      invalid('Continuity link cannot cross the attached workspace identity')
    }
    const authenticatedEvents = this.loadEvents()
    const replay = authenticatedEvents.find(event => event.idempotencyKey === idempotencyKey)
    if (replay !== undefined) {
      if (replay.requestHash !== requestHash) {
        conflict('Continuity idempotency key was already used for a different request')
      }
      if (canonicalJson(withoutCreatedAt(replay.link)) !== canonicalJson(withoutCreatedAt(link))) {
        integrity('Continuity replay does not match the admitted link')
      }
      return { status: 'replayed', link: clone(replay.link) }
    }
    if (authenticatedEvents.length >= MAX_CONTINUITY_EVENTS) {
      limitExceeded('Continuity Investigation event limit is reached')
    }
    if (authenticatedEvents.some(event => event.continuityLinkId === link.continuityLinkId)) {
      conflict('Continuity link identity is already used by another request')
    }
    const previous = authenticatedEvents.at(-1)
    const previousEventHash = previous === undefined
      ? ZERO_HASH
      : previous.eventHash
    const eventId = `continuity-event:${sha256(`${this.workspaceId}\0${idempotencyKey}`).slice(0, 32)}`
    const payload = {
      schemaVersion: 1 as const,
      eventType: 'continuity-link.recorded' as const,
      link,
    }
    const result: ContinuityAssessResult = {
      schemaVersion: 1,
      resultType: 'continuity-assessed',
      status: 'created',
      link,
    }
    const payloadJson = canonicalJson(payload)
    const resultJson = canonicalJson(result)
    const envelope = {
      eventId,
      workspaceId: this.workspaceId,
      investigationId: link.investigationId,
      continuityLinkId: link.continuityLinkId,
      idempotencyKey,
      requestHash,
      payloadHash: sha256(payloadJson),
      resultHash: sha256(resultJson),
      previousEventHash,
      createdAt: link.createdAt,
    }
    const eventHash = sha256(canonicalJson(envelope))
    try {
      this.database.prepare(`
        INSERT INTO investigation_continuity_events(
          event_id, workspace_id, investigation_id, continuity_link_id,
          idempotency_key, request_hash, payload_json, payload_hash,
          result_json, result_hash, previous_event_hash, event_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        eventId,
        this.workspaceId,
        link.investigationId,
        link.continuityLinkId,
        idempotencyKey,
        requestHash,
        payloadJson,
        envelope.payloadHash,
        resultJson,
        envelope.resultHash,
        previousEventHash,
        eventHash,
        link.createdAt,
      )
    } catch (error) {
      throw translateSqliteError(error)
    }
    return { status: 'created', link: clone(link) }
  }

  getLink(continuityLinkId: string): ContinuityLink | undefined {
    requireId(continuityLinkId, 'continuityLinkId')
    const rows = this.loadEvents()
    return clone(rows.find(row => row.link.continuityLinkId === continuityLinkId)?.link)
  }

  /** Reconcile only a previously committed exact command; never re-run assessment or change its pinned version. */
  replayLink(idempotencyKey: string, requestHash: string): ContinuityMutationResult | undefined {
    requireId(idempotencyKey, 'idempotencyKey'); requireSha256(requestHash, 'requestHash')
    const previous = this.loadEvents().find(event => event.idempotencyKey === idempotencyKey)
    if (!previous) return undefined
    if (previous.requestHash !== requestHash) conflict('Continuity idempotency key was already used for a different request')
    return { status: 'replayed', link: clone(previous.link) }
  }

  listLinks(investigationId: string, limit = 100): ContinuityLink[] {
    requireId(investigationId, 'investigationId')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      invalid('Continuity list limit must be between 1 and 500')
    }
    return this.loadEvents()
      .filter(row => row.link.investigationId === investigationId)
      .slice(-limit)
      .reverse()
      .map(row => clone(row.link))
  }

  listJournal(investigationId?: string): ContinuityJournalEntry[] {
    return this.loadEvents()
      .filter(row => investigationId === undefined || row.link.investigationId === investigationId)
      .map(row => ({
        sequence: row.sequence,
        eventId: row.eventId,
        investigationId: row.investigationId,
        continuityLinkId: row.continuityLinkId,
        createdAt: row.createdAt,
        eventHash: row.eventHash,
      }))
  }

  verifyIntegrity(): void {
    this.loadEvents()
  }

  private loadEvents(): Array<StoredContinuityEvent & { link: ContinuityLink }> {
    const rows = this.database.prepare(`
      SELECT * FROM investigation_continuity_events ORDER BY sequence
    `).all() as Record<string, unknown>[]
    const events: Array<StoredContinuityEvent & { link: ContinuityLink }> = []
    let previousEventHash = ZERO_HASH
    const linkIds = new Set<string>()
    const idempotencyKeys = new Set<string>()
    for (const row of rows) {
      const event = verifyRow(row, previousEventHash)
      if (linkIds.has(event.link.continuityLinkId) || idempotencyKeys.has(event.idempotencyKey)) {
        integrity('Continuity journal contains a duplicate aggregate or idempotency identity')
      }
      linkIds.add(event.link.continuityLinkId)
      idempotencyKeys.add(event.idempotencyKey)
      events.push(event)
      previousEventHash = event.eventHash
    }
    return events
  }
}

const ZERO_HASH = '0'.repeat(64)

function initializeSchema(database: DatabaseSync, workspaceId: string): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS investigation_continuity_metadata(
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL,
      workspace_id TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS investigation_continuity_events(
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      investigation_id TEXT NOT NULL,
      continuity_link_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL UNIQUE,
      request_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      result_hash TEXT NOT NULL,
      previous_event_hash TEXT NOT NULL,
      event_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS investigation_continuity_by_investigation
      ON investigation_continuity_events(investigation_id, sequence);
    CREATE TRIGGER IF NOT EXISTS investigation_continuity_events_no_update
      BEFORE UPDATE ON investigation_continuity_events
      BEGIN SELECT RAISE(ABORT, 'Continuity journal is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS investigation_continuity_events_no_delete
      BEFORE DELETE ON investigation_continuity_events
      BEGIN SELECT RAISE(ABORT, 'Continuity journal is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS investigation_continuity_metadata_no_update
      BEFORE UPDATE ON investigation_continuity_metadata
      BEGIN SELECT RAISE(ABORT, 'Continuity metadata is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS investigation_continuity_metadata_no_delete
      BEFORE DELETE ON investigation_continuity_metadata
      BEGIN SELECT RAISE(ABORT, 'Continuity metadata is immutable'); END;
  `)
  const metadata = readRow(database, `
    SELECT schema_version, workspace_id FROM investigation_continuity_metadata
    WHERE singleton = 1
  `)
  if (metadata === undefined) {
    database.prepare(`
      INSERT INTO investigation_continuity_metadata(singleton, schema_version, workspace_id)
      VALUES (1, ?, ?)
    `).run(CONTINUITY_STORE_SCHEMA_VERSION, workspaceId)
    return
  }
  if (integerColumn(metadata, 'schema_version') !== CONTINUITY_STORE_SCHEMA_VERSION
    || stringColumn(metadata, 'workspace_id') !== workspaceId) {
    integrity('Continuity SQLite adapter is bound to an incompatible workspace or schema')
  }
}

function verifyRow(
  row: Record<string, unknown>,
  expectedPreviousEventHash: string,
): StoredContinuityEvent & { link: ContinuityLink } {
  const event: StoredContinuityEvent = {
    sequence: integerColumn(row, 'sequence'),
    eventId: stringColumn(row, 'event_id'),
    workspaceId: stringColumn(row, 'workspace_id'),
    investigationId: stringColumn(row, 'investigation_id'),
    continuityLinkId: stringColumn(row, 'continuity_link_id'),
    idempotencyKey: stringColumn(row, 'idempotency_key'),
    requestHash: stringColumn(row, 'request_hash'),
    payloadJson: stringColumn(row, 'payload_json'),
    payloadHash: stringColumn(row, 'payload_hash'),
    resultJson: stringColumn(row, 'result_json'),
    resultHash: stringColumn(row, 'result_hash'),
    previousEventHash: stringColumn(row, 'previous_event_hash'),
    eventHash: stringColumn(row, 'event_hash'),
    createdAt: stringColumn(row, 'created_at'),
  }
  if (event.previousEventHash !== expectedPreviousEventHash
    || sha256(event.payloadJson) !== event.payloadHash
    || sha256(event.resultJson) !== event.resultHash
    || event.eventId !== `continuity-event:${sha256(`${event.workspaceId}\0${event.idempotencyKey}`).slice(0, 32)}`) {
    integrity('Continuity journal identity or content hash is invalid')
  }
  requireSha256(event.requestHash, 'stored requestHash')
  const parsedPayload = parseJson(event.payloadJson)
  if (!isRecord(parsedPayload)
    || parsedPayload.schemaVersion !== 1
    || parsedPayload.eventType !== 'continuity-link.recorded') {
    integrity('Continuity journal payload is invalid')
  }
  const link = parseContinuityLink(parsedPayload.link)
  const result = parseContinuityResult(event.resultJson)
  if (result.status !== 'created'
    || canonicalJson(result.link) !== canonicalJson(link)
    || link.workspaceId !== event.workspaceId
    || link.investigationId !== event.investigationId
    || link.continuityLinkId !== event.continuityLinkId
    || link.createdAt !== event.createdAt) {
    integrity('Continuity journal result or aggregate identity is invalid')
  }
  const expectedHash = sha256(canonicalJson({
    eventId: event.eventId,
    workspaceId: event.workspaceId,
    investigationId: event.investigationId,
    continuityLinkId: event.continuityLinkId,
    idempotencyKey: event.idempotencyKey,
    requestHash: event.requestHash,
    payloadHash: event.payloadHash,
    resultHash: event.resultHash,
    previousEventHash: event.previousEventHash,
    createdAt: event.createdAt,
  }))
  if (event.eventHash !== expectedHash) integrity('Continuity journal chain hash is invalid')
  return { ...event, link }
}

function parseContinuityResult(value: string): ContinuityAssessResult {
  let parsed: ReturnType<typeof parseContract<'continuity-rpc'>>
  try {
    parsed = parseContract('continuity-rpc', JSON.parse(value))
  } catch {
    integrity('stored Continuity result is invalid')
  }
  if (!('resultType' in parsed) || parsed.resultType !== 'continuity-assessed'
    || continuityRpcIssues(parsed).length > 0) {
    integrity('stored Continuity result is invalid')
  }
  return parsed
}

function parseContinuityLink(value: unknown): ContinuityLink {
  const result = parseContinuityResult(canonicalJson({
    schemaVersion: 1,
    resultType: 'continuity-assessed',
    status: 'created',
    link: value,
  }))
  return clone(result.link)
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    integrity('stored Continuity JSON is invalid')
  }
}

function withoutCreatedAt(link: ContinuityLink): Omit<ContinuityLink, 'createdAt'> {
  const { createdAt: _createdAt, ...stable } = link
  return stable
}

function readRow(
  database: DatabaseSync,
  sql: string,
  ...parameters: string[]
): Record<string, unknown> | undefined {
  return database.prepare(sql).get(...parameters) as Record<string, unknown> | undefined
}

function stringColumn(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') integrity(`Continuity database column ${key} is invalid`)
  return value
}

function integerColumn(row: Record<string, unknown>, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    integrity(`Continuity database column ${key} is invalid`)
  }
  return value
}

function requireId(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)) invalid(`${name} is invalid`)
}

function requireSha256(value: string, name: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) invalid(`${name} must be a SHA-256 digest`)
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonicalValue(child)]))
}

function clone<T>(value: T): T
function clone<T>(value: T | undefined): T | undefined
function clone<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : structuredClone(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function translateSqliteError(error: unknown): InvestigationContinuityStoreError {
  if (error instanceof InvestigationContinuityStoreError) return error
  const message = error instanceof Error ? error.message : 'Continuity SQLite write failed'
  if (message.includes('append-only') || message.includes('immutable')) {
    return new InvestigationContinuityStoreError('integrity-error', message)
  }
  if (message.includes('UNIQUE constraint failed')) {
    return new InvestigationContinuityStoreError('conflict', 'Continuity journal identity collided')
  }
  return new InvestigationContinuityStoreError('integrity-error', 'Continuity SQLite write failed')
}

function invalid(message: string): never {
  throw new InvestigationContinuityStoreError('invalid-request', message)
}

function conflict(message: string): never {
  throw new InvestigationContinuityStoreError('conflict', message)
}

function limitExceeded(message: string): never {
  throw new InvestigationContinuityStoreError('limit-exceeded', message)
}

function integrity(message: string): never {
  throw new InvestigationContinuityStoreError('integrity-error', message)
}
