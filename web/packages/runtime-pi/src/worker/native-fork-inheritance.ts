import { createHash } from 'node:crypto'
import type { NativeLineageAction } from '@docatlas/contracts'

type Entry = Record<string, unknown>
interface ForkLabel { targetId: string, label: string, timestamp: string }
export interface NativeForkExport { entries: Entry[], labels: ForkLabel[], inheritedEntryCount: number, inheritanceHash: string }
const object = (value: unknown): value is Entry => value !== null && typeof value === 'object' && !Array.isArray(value)
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => object(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
const invalid = (): never => { throw new Error('Native fork inheritance verification failed') }

/** Public-ID origin mapping and exact Pi 0.85.1 export rules, independently checked against actual SDK bytes. */
export function nativeForkExport(parentEntries: readonly Entry[], action: Extract<NativeLineageAction, { kind: 'fork' }>): NativeForkExport {
  const byId = new Map(parentEntries.map(entry => [entry.id, entry])), target = byId.get(action.targetEntryId)
  if (!target || action.position !== 'before' && action.position !== 'at') return invalid()
  if (action.position === 'before' && (target.type !== 'message' || !object(target.message) || target.message.role !== 'user')) return invalid()
  const leafId = action.position === 'before' ? target.parentId : target.id, path: Entry[] = []
  let entry = byId.get(leafId)
  while (entry) { path.unshift(entry); entry = byId.get(entry.parentId); if (path.length > parentEntries.length) return invalid() }
  if (leafId !== null && !path.length) return invalid()
  const entries: Entry[] = [], replacements = new Map<unknown, unknown>(), pending: unknown[] = []
  let parentId: unknown = null
  for (const entry of path) {
    if (entry.type === 'label') { pending.push(entry.id); continue }
    for (const label of pending) replacements.set(label, entry.id)
    pending.length = 0
    entries.push(entry.type === 'compaction' ? { ...entry, parentId, firstKeptEntryId: replacements.get(entry.firstKeptEntryId) ?? entry.firstKeptEntryId } : { ...entry, parentId })
    parentId = entry.id
  }
  const retained = new Set(entries.map(entry => entry.id)), labelsById = new Map<string, ForkLabel>()
  for (const entry of parentEntries) if (entry.type === 'label') {
    if (typeof entry.targetId !== 'string') return invalid()
    if (entry.label) {
      if (typeof entry.label !== 'string' || typeof entry.timestamp !== 'string') return invalid()
      labelsById.set(entry.targetId, { targetId: entry.targetId, label: entry.label, timestamp: entry.timestamp })
    } else labelsById.delete(entry.targetId)
  }
  const labels = [...labelsById.values()].filter(label => retained.has(label.targetId))
  return { entries: structuredClone(entries), labels, inheritedEntryCount: entries.length + labels.length,
    inheritanceHash: createHash('sha256').update(canonical({ entries, labels })).digest('hex') }
}

/** Labels have SDK-generated IDs; verify their exact payload, order and real parent chain separately. */
export function matchesNativeForkExport(expected: NativeForkExport, inheritedEntries: readonly Entry[]): boolean {
  if (inheritedEntries.length !== expected.inheritedEntryCount || canonical(inheritedEntries.slice(0, expected.entries.length)) !== canonical(expected.entries)) return false
  let parentId = expected.entries.at(-1)?.id ?? null
  const seen = new Set(expected.entries.map(entry => entry.id))
  for (const [index, label] of expected.labels.entries()) {
    const actual = inheritedEntries[expected.entries.length + index]
    if (!actual || Object.keys(actual).sort().join(',') !== 'id,label,parentId,targetId,timestamp,type' || actual.type !== 'label'
      || typeof actual.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/u.test(actual.id) || seen.has(actual.id)
      || actual.parentId !== parentId || actual.targetId !== label.targetId || actual.label !== label.label || actual.timestamp !== label.timestamp) return false
    seen.add(actual.id); parentId = actual.id
  }
  return true
}
