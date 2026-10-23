import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ProductActor } from '../storage/control-store.js'

export type ApiErrorCode = 'unauthenticated' | 'forbidden' | 'invalid-request' | 'not-found' | 'conflict' | 'limit-exceeded' | 'unavailable'
export class ApiError extends Error { constructor(readonly code: ApiErrorCode) { super(code) } }
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
// Opaque random lookup tokens, never encoded credentials or user data.
const randomToken = () => randomBytes(32).toString('base64url')
interface Session { actor: ProductActor, csrf: string, expiresAt: number }

/** Local pairing authority is supplied by the application, never by a request body. */
export class ProductAuth {
  readonly origin: string
  readonly host: string
  readonly cookieName: string
  private readonly secure: boolean
  private readonly codes = new Map<string, { actor: ProductActor, expiresAt: number }>()
  private readonly sessions = new Map<string, Session>()
  private readonly watchers = new Map<string, Set<() => void>>()
  private readonly local: { actor: ProductActor, csrf: string } | undefined
  constructor(origin: string, private readonly clock: () => number = Date.now, private readonly sessionMs = 8 * 60 * 60 * 1000, localActor?: ProductActor) {
    const url = new URL(origin)
    if (url.origin !== origin || url.username || url.password || !['http:', 'https:'].includes(url.protocol)
      || url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) throw new Error('Use an exact secure or loopback origin')
    if (!Number.isSafeInteger(sessionMs) || sessionMs < 1 || sessionMs > 86400000) throw new Error('Invalid session lifetime')
    this.origin = origin; this.host = url.host; this.secure = url.protocol === 'https:'
    this.cookieName = this.secure ? '__Host-docatlas_session' : 'docatlas_session'
    if (localActor) {
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
        || ![localActor.actorId, localActor.workspaceId].every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/.test(value))) throw new Error('Local access requires a loopback origin and server-owned actor')
      this.local = { actor: { ...localActor }, csrf: randomToken() }
    }
  }
  get localAccess(): boolean { return this.local !== undefined }
  issueBootstrap(actor: ProductActor): { code: string, expiresAt: number } {
    if (this.local) throw new ApiError('not-found')
    if (![actor.actorId, actor.workspaceId].every(value => /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,127}$/.test(value))) throw new Error('Invalid pairing actor')
    this.prune()
    if (this.codes.size >= 64) throw new ApiError('limit-exceeded')
    const code = randomToken(), expiresAt = this.now() + 5 * 60 * 1000
    this.codes.set(hash(code), { actor: { ...actor }, expiresAt })
    return { code, expiresAt }
  }
  exchange(code: string): { cookie: string, actor: ProductActor, csrfToken: string } {
    if (this.local) throw new ApiError('not-found')
    this.prune()
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw new ApiError('unauthenticated')
    const key = hash(code), paired = this.codes.get(key)
    if (!paired) throw new ApiError('unauthenticated')
    if (this.sessions.size >= 64) throw new ApiError('limit-exceeded')
    this.codes.delete(key)
    const token = randomToken(), csrf = randomToken()
    // Only the session lookup token goes in the HttpOnly cookie. The bootstrap
    // code, CSRF token and actor stay separate; server lookup uses a token hash.
    this.sessions.set(hash(token), { actor: paired.actor, csrf, expiresAt: this.now() + this.sessionMs })
    return { cookie: this.cookie(token, Math.floor(this.sessionMs / 1000)), actor: { ...paired.actor }, csrfToken: csrf }
  }
  authenticate(cookie: string | undefined, csrf?: string): { actor: ProductActor, csrfToken: string } {
    if (this.local) {
      if (csrf !== undefined && !timingSafeEqual(Buffer.from(hash(csrf)), Buffer.from(hash(this.local.csrf)))) throw new ApiError('forbidden')
      return { actor: { ...this.local.actor }, csrfToken: this.local.csrf }
    }
    this.prune()
    const key = this.cookieKey(cookie), session = this.sessions.get(key)
    if (!session) throw new ApiError('unauthenticated')
    if (csrf !== undefined && !timingSafeEqual(Buffer.from(hash(csrf)), Buffer.from(hash(session.csrf)))) throw new ApiError('forbidden')
    return { actor: { ...session.actor }, csrfToken: session.csrf }
  }
  watch(cookie: string | undefined, revoked: () => void): () => void {
    this.authenticate(cookie)
    const key = this.cookieKey(cookie), listeners = this.watchers.get(key) ?? new Set<() => void>()
    if (listeners.size >= (this.local ? 32 : 8)) throw new ApiError('limit-exceeded')
    listeners.add(revoked); this.watchers.set(key, listeners)
    return () => { listeners.delete(revoked); if (!listeners.size) this.watchers.delete(key) }
  }
  logout(cookie: string | undefined): string { if (this.local) throw new ApiError('not-found'); this.revoke(this.cookieKey(cookie)); return this.cookie('', 0) }
  private cookieKey(header: string | undefined): string {
    if (this.local) return 'local'
    if (!header || header.length > 8192) throw new ApiError('unauthenticated')
    const values = header.split(';').map(value => value.trim()).filter(value => value.startsWith(`${this.cookieName}=`))
    if (values.length !== 1) throw new ApiError('unauthenticated')
    const token = values[0]!.slice(this.cookieName.length + 1)
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ApiError('unauthenticated')
    return hash(token)
  }
  private cookie(token: string, seconds: number): string { return `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${this.secure ? '; Secure' : ''}` }
  private prune(): void {
    const now = this.now()
    for (const [key, value] of this.codes) if (value.expiresAt <= now) this.codes.delete(key)
    for (const [key, value] of this.sessions) if (value.expiresAt <= now) this.revoke(key)
  }
  private revoke(key: string): void {
    this.sessions.delete(key)
    const listeners = this.watchers.get(key); this.watchers.delete(key)
    for (const callback of listeners ?? []) try { callback() } catch { /* Session revocation cannot be vetoed. */ }
  }
  private now(): number { const value = this.clock(); if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid auth clock'); return value }
}
