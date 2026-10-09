import { expect, it } from 'vitest'
import { ProductAuth } from '../src/http/auth.js'
const actor = { actorId: 'actor:paired', workspaceId: 'workspace:paired' }
it('local access has no code, cookie or login expiry but retains a host-owned actor and CSRF', () => {
  let now = 0
  const supplied = { actorId: 'actor:local', workspaceId: 'workspace:local' }
  const auth = new ProductAuth('http://127.0.0.1:4177', () => now, undefined, supplied)
  expect(auth.localAccess).toBe(true)
  const bootstrap = auth.authenticate(undefined)
  supplied.actorId = 'actor:changed'; bootstrap.actor.actorId = 'actor:client'
  now = 20 * 86400000
  expect(auth.authenticate(undefined, bootstrap.csrfToken).actor.actorId).toBe('actor:local')
  expect(auth.authenticate('stale-browser-cookie').csrfToken).toBe(bootstrap.csrfToken)
  expect(() => auth.authenticate(undefined, 'x'.repeat(43))).toThrow('forbidden')
  expect(() => auth.issueBootstrap(actor)).toThrow('not-found')
  expect(() => auth.exchange('x'.repeat(43))).toThrow('not-found')
  expect(() => auth.logout(undefined)).toThrow('not-found')
  const unsubscribe = auth.watch(undefined, () => { throw new Error('No login expiry') }); unsubscribe()
  expect(Reflect.get(auth, 'watchers').size).toBe(0)
})
it('never enables login-free access on a non-loopback or HTTPS origin', () => {
  for (const origin of ['https://example.test', 'https://127.0.0.1:4177', 'http://localhost:4177', 'http://0.0.0.0:4177']) {
    expect(() => new ProductAuth(origin, undefined, undefined, actor)).toThrow()
  }
  expect(() => new ProductAuth('http://127.0.0.1:4177', undefined, undefined, { ...actor, actorId: 'not an actor' })).toThrow()
})
it('uses single-use pairing, HttpOnly cookies, session-scoped CSRF, expiry and logout', () => {
  let now = 1000
  const auth = new ProductAuth('http://127.0.0.1:8080', () => now, 2000)
  const bootstrap = auth.issueBootstrap(actor), session = auth.exchange(bootstrap.code), cookie = session.cookie.split(';')[0]!
  expect(session.cookie).toContain('HttpOnly; SameSite=Strict')
  expect(session.cookie).not.toContain('Secure')
  expect(() => auth.exchange(bootstrap.code)).toThrow('unauthenticated')
  expect(auth.authenticate(cookie, session.csrfToken).actor).toEqual(actor)
  expect(() => auth.authenticate(cookie, 'forged')).toThrow('forbidden')
  expect(() => auth.authenticate(`${cookie}; ${cookie}`)).toThrow('unauthenticated')
  now += 2000
  expect(() => auth.authenticate(cookie)).toThrow('unauthenticated')
  const next = auth.exchange(auth.issueBootstrap(actor).code), nextCookie = next.cookie.split(';')[0]!
  expect(auth.logout(nextCookie)).toContain('Max-Age=0')
  expect(() => auth.authenticate(nextCookie)).toThrow('unauthenticated')
})
it('does not retain bootstrap/session bearer tokens and isolates concurrent session CSRF', () => {
  const auth = new ProductAuth('https://example.test')
  const code = auth.issueBootstrap(actor).code
  expect([...Reflect.get(auth, 'codes').keys()]).not.toContain(code)
  const first = auth.exchange(code), second = auth.exchange(auth.issueBootstrap(actor).code)
  expect(first.cookie).toContain('__Host-docatlas_session=')
  expect(first.cookie).toContain('; Secure')
  expect([...Reflect.get(auth, 'sessions').keys()]).not.toContain(first.cookie.split(';')[0]!.split('=')[1])
  expect(() => auth.authenticate(first.cookie.split(';')[0], second.csrfToken)).toThrow('forbidden')
  first.actor.actorId = 'actor:forged'
  expect(auth.authenticate(first.cookie.split(';')[0]).actor).toEqual(actor)
})
it('bounds pairing state and rejects expired codes and insecure non-local origins', () => {
  let now = 0
  const auth = new ProductAuth('http://localhost:8080', () => now)
  const first = auth.issueBootstrap(actor)
  for (let index = 1; index < 64; index++) auth.issueBootstrap(actor)
  expect(() => auth.issueBootstrap(actor)).toThrow('limit-exceeded')
  now = first.expiresAt
  expect(() => auth.exchange(first.code)).toThrow('unauthenticated')
  expect(auth.issueBootstrap(actor).code).toHaveLength(43)
  for (const origin of ['http://example.test', 'https://example.test/path', 'https://user:pass@example.test', 'file:///tmp']) expect(() => new ProductAuth(origin)).toThrow()
})
