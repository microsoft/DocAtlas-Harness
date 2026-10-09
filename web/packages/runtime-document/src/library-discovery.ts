import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'

import {
  libraryRpcIssues,
  type LibraryCandidate,
  type LibraryDiscoverRequest,
  type LibraryDiscoverResult,
} from '@docatlas/contracts'

const CANDIDATE_TTL_MS = 5 * 60 * 1000
const MAX_DISCOVERED_FILES = 10_000
const MAX_DIRECTORY_DEPTH = 32
const MAX_TRANSIENT_CANDIDATES = 20_000
const MAX_TRANSIENT_CURSORS = 2_000

interface FileFacts {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

interface CandidateBinding {
  candidate: LibraryCandidate
  sessionId: string
  workspaceId: string
  rootPath: string
  relativePath: string
  facts: FileFacts
}

interface CursorBinding {
  sessionId: string
  workspaceId: string
  rootId?: string
  query?: string
  candidates: LibraryCandidate[]
  offset: number
  total: number
  complete: boolean
  expiresAtMs: number
}

import { LibraryDiscoveryError, type MaterializedLibraryCandidate } from '@docatlas/core'
export { LibraryDiscoveryError, type MaterializedLibraryCandidate } from '@docatlas/core'

export class LibraryDiscovery {
  private readonly candidates = new Map<string, CandidateBinding>()
  private readonly cursors = new Map<string, CursorBinding>()

  private constructor(
    private readonly roots: ReadonlyMap<string, string>,
    private readonly maxDocumentBytes: number,
  ) {}

  static async create(
    sourceRoots: Readonly<Record<string, string>>,
    maxDocumentBytes = 100 * 1024 * 1024,
  ): Promise<LibraryDiscovery> {
    if (!Number.isSafeInteger(maxDocumentBytes) || maxDocumentBytes < 1) {
      throw new LibraryDiscoveryError('invalid-request', 'Library document byte limit is invalid')
    }
    const roots = new Map<string, string>()
    const physical = new Set<string>()
    for (const [rootId, rootPath] of Object.entries(sourceRoots)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(rootId) || !isAbsolute(rootPath)) {
        throw new LibraryDiscoveryError('invalid-request', 'Library source root is invalid')
      }
      const resolved = await realpath(rootPath)
      const rootStat = await stat(resolved)
      if (!rootStat.isDirectory() || physical.has(resolved)) {
        throw new LibraryDiscoveryError('invalid-request', 'Library source roots must be unique directories')
      }
      physical.add(resolved)
      roots.set(rootId, resolved)
    }
    return new LibraryDiscovery(roots, maxDocumentBytes)
  }

  async discover(
    request: LibraryDiscoverRequest,
    now = Date.now(),
    signal?: AbortSignal,
  ): Promise<LibraryDiscoverResult> {
    signal?.throwIfAborted()
    this.collect(now)
    if (request.cursor !== undefined) return this.continue(request, now)
    if (request.rootId !== undefined && !this.roots.has(request.rootId)) {
      throw new LibraryDiscoveryError('not-found', 'Library source root is not available')
    }
    const observedAt = new Date(now).toISOString()
    const expiresAtMs = now + CANDIDATE_TTL_MS
    const expiresAt = new Date(expiresAtMs).toISOString()
    const matches: Array<{ binding: CandidateBinding, sortKey: string }> = []
    let complete = true
    roots: for (const [rootId, rootPath] of this.roots) {
      if (request.rootId !== undefined && request.rootId !== rootId) continue
      const discovered = await scanRoot(rootPath, signal)
      complete &&= discovered.complete
      for (const file of discovered.files) {
        if (matches.length >= MAX_DISCOVERED_FILES) {
          complete = false
          break roots
        }
        if (request.query !== undefined
          && !file.relativePath.toLowerCase().includes(request.query.toLowerCase())) continue
        const candidateId = `candidate:${randomBytes(16).toString('base64url')}`
        const candidate: LibraryCandidate = {
          candidateId,
          rootId,
          displayName: basename(file.relativePath),
          mediaType: file.mediaType,
          byteLength: Number(file.facts.size),
          modifiedAt: new Date(Number(file.facts.mtimeNs / 1_000_000n)).toISOString(),
          observedAt,
          expiresAt,
        }
        const binding = {
          candidate,
          sessionId: request.sessionId,
          workspaceId: request.workspaceId,
          rootPath,
          relativePath: file.relativePath,
          facts: file.facts,
        }
        this.candidates.set(candidateId, binding)
        matches.push({ binding, sortKey: `${rootId}\0${file.relativePath}` })
      }
    }
    matches.sort((left, right) => left.sortKey.localeCompare(right.sortKey))
    while (this.candidates.size > MAX_TRANSIENT_CANDIDATES) {
      const oldest = this.candidates.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.candidates.delete(oldest)
    }
    const all = matches.map(match => match.binding.candidate)
    return this.page(request, all, 0, all.length, complete, expiresAtMs)
  }

  async materialize(
    candidateId: string,
    sessionId: string,
    workspaceId: string,
    now = Date.now(),
  ): Promise<MaterializedLibraryCandidate> {
    this.collect(now)
    const binding = this.candidates.get(candidateId)
    if (binding === undefined
      || binding.sessionId !== sessionId
      || binding.workspaceId !== workspaceId) {
      throw new LibraryDiscoveryError('not-found', 'Library candidate is not available')
    }
    if (Date.parse(binding.candidate.expiresAt) <= now) {
      this.candidates.delete(candidateId)
      throw new LibraryDiscoveryError('stale', 'Library candidate expired')
    }
    const path = join(binding.rootPath, ...binding.relativePath.split('/'))
    const resolved = await realpath(path).catch(() => undefined)
    if (resolved === undefined
      || (resolved !== binding.rootPath && !resolved.startsWith(`${binding.rootPath}${sep}`))) {
      throw new LibraryDiscoveryError('stale', 'Library candidate escaped its configured root')
    }
    const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0
    const handle = await open(path, constants.O_RDONLY | noFollow).catch(() => {
      throw new LibraryDiscoveryError('stale', 'Library candidate changed after discovery')
    })
    try {
      const before = await handle.stat({ bigint: true })
      if (!before.isFile() || !sameFacts(before, binding.facts)) {
        throw new LibraryDiscoveryError('stale', 'Library candidate changed after discovery')
      }
      if (before.size > BigInt(this.maxDocumentBytes)) {
        throw new LibraryDiscoveryError('limit-exceeded', 'Library candidate exceeds the document byte limit')
      }
      const hash = createHash('sha256')
      for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk)
      const after = await handle.stat({ bigint: true })
      if (!sameFacts(before, after)) {
        throw new LibraryDiscoveryError('stale', 'Library candidate changed while hashing')
      }
      return {
        candidateId,
        rootId: binding.candidate.rootId,
        relativePath: binding.relativePath,
        displayName: binding.candidate.displayName,
        mediaType: binding.candidate.mediaType,
        byteLength: Number(after.size),
        contentHash: hash.digest('hex'),
      }
    } finally {
      await handle.close()
    }
  }

  private continue(request: LibraryDiscoverRequest, now: number): LibraryDiscoverResult {
    const cursor = this.cursors.get(request.cursor!)
    if (cursor === undefined
      || cursor.expiresAtMs <= now
      || cursor.sessionId !== request.sessionId
      || cursor.workspaceId !== request.workspaceId
      || cursor.rootId !== request.rootId
      || cursor.query !== request.query) {
      throw new LibraryDiscoveryError('stale', 'Library discovery cursor is invalid or expired')
    }
    return this.page(
      request,
      cursor.candidates,
      cursor.offset,
      cursor.total,
      cursor.complete,
      cursor.expiresAtMs,
    )
  }

  private page(
    request: LibraryDiscoverRequest,
    candidates: LibraryCandidate[],
    offset: number,
    total: number,
    complete: boolean,
    expiresAtMs: number,
  ): LibraryDiscoverResult {
    const items = candidates.slice(offset, offset + request.limit)
    const nextOffset = offset + items.length
    let nextCursor: string | undefined
    if (nextOffset < candidates.length) {
      nextCursor = `library-cursor:${randomBytes(16).toString('base64url')}`
      this.cursors.set(nextCursor, {
        sessionId: request.sessionId,
        workspaceId: request.workspaceId,
        ...(request.rootId === undefined ? {} : { rootId: request.rootId }),
        ...(request.query === undefined ? {} : { query: request.query }),
        candidates,
        offset: nextOffset,
        total,
        complete,
        expiresAtMs,
      })
      while (this.cursors.size > MAX_TRANSIENT_CURSORS) {
        const oldest = this.cursors.keys().next().value as string | undefined
        if (oldest === undefined) break
        this.cursors.delete(oldest)
      }
    }
    const result: LibraryDiscoverResult = {
      schemaVersion: 1,
      resultType: 'library-candidates',
      workspaceId: request.workspaceId,
      candidates: items,
      pageInfo: {
        schemaVersion: 1,
        limit: request.limit,
        returned: items.length,
        total,
        usedChars: 0,
        truncated: nextCursor !== undefined || !complete,
        completeness: complete ? 'complete' : 'partial',
        ...(nextCursor === undefined ? {} : { nextCursor }),
      },
    }
    const issues = libraryRpcIssues(result)
    if (issues.length > 0) throw new Error(`invalid Library discovery result: ${issues[0]!.message}`)
    return result
  }

  private collect(now: number): void {
    for (const [id, binding] of this.candidates) {
      if (Date.parse(binding.candidate.expiresAt) <= now) this.candidates.delete(id)
    }
    for (const [id, binding] of this.cursors) {
      if (binding.expiresAtMs <= now) this.cursors.delete(id)
    }
  }
}

async function scanRoot(rootPath: string, signal?: AbortSignal): Promise<{
  files: Array<{
    relativePath: string
    mediaType: LibraryCandidate['mediaType']
    facts: FileFacts
  }>
  complete: boolean
}> {
  const files: Array<{
    relativePath: string
    mediaType: LibraryCandidate['mediaType']
    facts: FileFacts
  }> = []
  const pending: Array<{ path: string, depth: number }> = [{ path: rootPath, depth: 0 }]
  let complete = true
  while (pending.length > 0 && files.length < MAX_DISCOVERED_FILES) {
    signal?.throwIfAborted()
    const current = pending.shift()!
    const directory = await opendir(current.path).catch(() => undefined)
    if (directory === undefined) {
      complete = false
      continue
    }
    for await (const entry of directory) {
      signal?.throwIfAborted()
      if (entry.isSymbolicLink()) continue
      const path = join(current.path, entry.name)
      if (entry.isDirectory()) {
        if (current.depth < MAX_DIRECTORY_DEPTH) pending.push({ path, depth: current.depth + 1 })
        else complete = false
        continue
      }
      if (!entry.isFile()) continue
      const mediaType = mediaTypeOf(entry.name)
      if (mediaType === undefined) continue
      const fileStat = await lstat(path, { bigint: true }).catch(() => undefined)
      if (fileStat === undefined || !fileStat.isFile() || fileStat.size <= 0n
        || fileStat.size > BigInt(Number.MAX_SAFE_INTEGER)) continue
      const relativePath = relative(rootPath, path).split(sep).join('/')
      if (relativePath === '' || relativePath.startsWith('../') || relativePath.includes('/../')) continue
      if (relativePath.includes(':') || relativePath.includes('\\')) continue
      files.push({ relativePath, mediaType, facts: fileStat })
      if (files.length >= MAX_DISCOVERED_FILES) {
        complete = false
        break
      }
    }
  }
  if (pending.length > 0) complete = false
  return { files, complete }
}

function mediaTypeOf(name: string): LibraryCandidate['mediaType'] | undefined {
  const lower = name.toLocaleLowerCase()
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown'
  if (lower.endsWith('.txt')) return 'text/plain'
  return undefined
}

function sameFacts(left: FileFacts, right: FileFacts): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}
