import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import {
  assetDescriptorIssues,
  type AssetDescriptor,
} from '@docatlas/contracts'
import { parseContract } from '@docatlas/contracts/node'

import type { ActiveDocAtlasSourceScope } from '@docatlas/core'

export { DOCATLAS_ASSET_PATH } from './asset-url.js'
const ASSET_DESCRIPTOR_FILE = 'descriptor.json'
const ASSET_CONTENT_FILE = 'content.bin'
const MAX_DESCRIPTOR_BYTES = 64 * 1024
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

export interface CompatibleConnectionFetch {
  register(route: {
    readonly path: string
    readonly methods: readonly ('GET' | 'HEAD')[]
    readonly fetch: (request: Request) => Promise<Response>
  }): () => Promise<void>
}

export function connectionFetchRegistry(connection: unknown): CompatibleConnectionFetch | undefined {
  if (typeof connection !== 'object' || connection === null) return undefined
  const fetch = Reflect.get(connection, 'fetch') as unknown
  if (typeof fetch !== 'object' || fetch === null) return undefined
  const register = Reflect.get(fetch, 'register') as unknown
  if (typeof register !== 'function') return undefined
  return fetch as CompatibleConnectionFetch
}

interface OpenedAsset {
  descriptor: AssetDescriptor
  handle: Awaited<ReturnType<typeof open>>
}

export class AssetIntegrityError extends Error {
  constructor() {
    super('DocAtlas asset integrity check failed')
    this.name = 'AssetIntegrityError'
  }
}

export class DocAtlasAssetStore {
  private readonly assetsRoot: string

  constructor(cacheRoot: string) {
    this.assetsRoot = join(cacheRoot, 'assets')
  }

  async openAuthorized(
    assetId: string,
    scope: ActiveDocAtlasSourceScope | undefined,
    authorizeLibrary?: (descriptor: AssetDescriptor) => boolean | Promise<boolean>,
  ): Promise<OpenedAsset | undefined> {
    if (!OPAQUE_ID.test(assetId) || (scope === undefined && authorizeLibrary === undefined)) return undefined
    const key = createHash('sha256').update(assetId).digest('hex')
    const directory = join(this.assetsRoot, key)
    const descriptorPath = join(directory, ASSET_DESCRIPTOR_FILE)
    const contentPath = join(directory, ASSET_CONTENT_FILE)
    let descriptorHandle: Awaited<ReturnType<typeof open>> | undefined
    let contentHandle: Awaited<ReturnType<typeof open>> | undefined
    try {
      const directoryStat = await lstat(directory)
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw new AssetIntegrityError()
      }
      const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
      descriptorHandle = await open(descriptorPath, constants.O_RDONLY | noFollow)
      const descriptorStat = await descriptorHandle.stat({ bigint: true })
      if (!descriptorStat.isFile() || descriptorStat.size > BigInt(MAX_DESCRIPTOR_BYTES)) {
        throw new AssetIntegrityError()
      }
      contentHandle = await open(contentPath, constants.O_RDONLY | noFollow)
      const contentStat = await contentHandle.stat({ bigint: true })
      if (!contentStat.isFile()) throw new AssetIntegrityError()
      const raw = await descriptorHandle.readFile({ encoding: 'utf8' })
      let candidate: unknown
      try {
        candidate = JSON.parse(raw)
      } catch {
        throw new AssetIntegrityError()
      }
      const descriptor = parseContract('asset-descriptor', candidate)
      if (assetDescriptorIssues(descriptor).length > 0
        || descriptor.assetId !== assetId
        || BigInt(descriptor.byteLength) !== contentStat.size) {
        throw new AssetIntegrityError()
      }
      const inScope = scope?.scope.included.some(source =>
        source.documentId === descriptor.documentId && source.revisionId === descriptor.revisionId) === true
      if (!inScope && !(await authorizeLibrary?.(descriptor))) {
        await contentHandle.close()
        contentHandle = undefined
        return undefined
      }
      const digest = await hashFileHandle(contentHandle, descriptor.byteLength)
      if (digest !== descriptor.contentHash) throw new AssetIntegrityError()
      await descriptorHandle.close()
      descriptorHandle = undefined
      return { descriptor, handle: contentHandle }
    } catch (error) {
      if (isMissing(error)) return undefined
      if (error instanceof AssetIntegrityError) throw error
      throw new AssetIntegrityError()
    } finally {
      await descriptorHandle?.close().catch(() => undefined)
      if (contentHandle !== undefined && descriptorHandle !== undefined) {
        await contentHandle.close().catch(() => undefined)
      }
    }
  }

}

export async function docAtlasAssetResponse(
  store: DocAtlasAssetStore,
  resolveScope: (sessionId: string) => ActiveDocAtlasSourceScope | undefined,
  request: Request,
  authorizeLibrary?: (sessionId: string, descriptor: AssetDescriptor) => boolean | Promise<boolean>,
): Promise<Response> {
  const url = new URL(request.url)
  const values = url.searchParams.getAll('assetId')
  const sessions = url.searchParams.getAll('sessionId')
  if (values.length !== 1 || sessions.length !== 1
    || [...url.searchParams.keys()].some(key => key !== 'assetId' && key !== 'sessionId')) {
    return new Response('bad request', { status: 400 })
  }
  let opened: OpenedAsset | undefined
  try {
    const sessionId = sessions[0]!
    opened = await store.openAuthorized(
      values[0]!,
      resolveScope(sessionId),
      authorizeLibrary === undefined
        ? undefined
        : descriptor => authorizeLibrary(sessionId, descriptor),
    )
  } catch (error) {
    if (error instanceof AssetIntegrityError) {
      return new Response('asset unavailable', { status: 500 })
    }
    throw error
  }
  if (opened === undefined) return new Response('not found', { status: 404 })
  const { descriptor, handle } = opened
  const etag = `"${descriptor.contentHash}"`
  const commonHeaders = new Headers({
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-cache, must-revalidate',
    'content-type': descriptor.mediaType,
    etag,
    'x-content-type-options': 'nosniff',
  })
  if (ifNoneMatch(request.headers.get('if-none-match'), etag)) {
    await handle.close()
    return new Response(null, { status: 304, headers: commonHeaders })
  }

  const rangeHeader = request.headers.get('range')
  const ifRange = request.headers.get('if-range')
  const useRange = rangeHeader !== null && (ifRange === null || ifRange === etag)
  const range = useRange ? parseRange(rangeHeader, descriptor.byteLength) : undefined
  if (useRange && range === null) {
    await handle.close()
    commonHeaders.set('content-range', `bytes */${descriptor.byteLength}`)
    commonHeaders.set('content-length', '0')
    return new Response(null, { status: 416, headers: commonHeaders })
  }
  const start = range?.start ?? 0
  const end = range?.end ?? descriptor.byteLength - 1
  const contentLength = descriptor.byteLength === 0 ? 0 : end - start + 1
  commonHeaders.set('content-length', String(contentLength))
  if (range !== undefined && range !== null) {
    commonHeaders.set('content-range', `bytes ${start}-${end}/${descriptor.byteLength}`)
  }
  const status = range === undefined ? 200 : 206
  if (request.method === 'HEAD' || contentLength === 0) {
    await handle.close()
    return new Response(null, { status, headers: commonHeaders })
  }
  try {
    const stream = handle.createReadStream({
      autoClose: true,
      start,
      end,
      signal: request.signal,
    })
    return new Response(Readable.toWeb(stream) as ReadableStream, { status, headers: commonHeaders })
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

interface ByteRange {
  start: number
  end: number
}

export function parseRange(value: string, length: number): ByteRange | null {
  if (!Number.isSafeInteger(length) || length < 0 || !value.startsWith('bytes=')) return null
  const spec = value.slice(6)
  if (spec.includes(',') || !/^\d*-\d*$/.test(spec)) return null
  const [rawStart, rawEnd] = spec.split('-', 2) as [string, string]
  if (rawStart === '' && rawEnd === '') return null
  if (length === 0) return null
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
    return { start: Math.max(0, length - suffix), end: length - 1 }
  }
  const start = Number(rawStart)
  if (!Number.isSafeInteger(start) || start < 0 || start >= length) return null
  if (rawEnd === '') return { start, end: length - 1 }
  const requestedEnd = Number(rawEnd)
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return null
  return { start, end: Math.min(requestedEnd, length - 1) }
}

function ifNoneMatch(value: string | null, etag: string): boolean {
  if (value === null) return false
  return value.split(',').map(candidate => candidate.trim()).some(candidate =>
    candidate === '*' || candidate === etag)
}

async function hashFileHandle(
  handle: Awaited<ReturnType<typeof open>>,
  length: number,
): Promise<string> {
  const digest = createHash('sha256')
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, length)))
  let position = 0
  while (position < length) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.byteLength, length - position),
      position,
    )
    if (bytesRead === 0) throw new AssetIntegrityError()
    digest.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
  return digest.digest('hex')
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && ((error as { code?: unknown }).code === 'ENOENT'
      || (error as { code?: unknown }).code === 'ENOTDIR')
}
