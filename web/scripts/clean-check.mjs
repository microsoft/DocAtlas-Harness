import { spawn, execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Verification only. Import the same actual guard; never invent a monitor-only launcher.
// Node 22.19.0 needs --experimental-transform-types for constructor parameter properties.
const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)))
const mode = process.argv[2] ?? 'check'
if (!['check', 'browser', 'coverage'].includes(mode) || process.platform !== 'linux' || process.versions.node !== '22.19.0') throw new Error('Use pinned Node on Linux; mode must be check, browser or coverage')
const name = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name
if (!['docatlas-dsh-workspace', 'docatlas-grounded-web'].includes(name) || root === homedir() || root === '/') throw new Error('Expected a dedicated DocAtlas project root')
const { SandboxProcess } = await import(pathToFileURL(join(root, 'packages/runtime-document/src/sandbox-process.ts')).href)
const executable = name => realpathSync(execFileSync('which', [name], { encoding: 'utf8' }).trim())
const uv = executable('uv'), rg = executable('rg'), nodeRoot = dirname(dirname(realpathSync(process.execPath)))
const python = realpathSync(execFileSync(uv, ['python', 'find', '3.12.12'], { encoding: 'utf8' }).trim())
const pythonRoot = dirname(dirname(python))
const cache = realpathSync(execFileSync(uv, ['cache', 'dir'], { encoding: 'utf8' }).trim())
if ([cache, nodeRoot, pythonRoot].some(path => !isAbsolute(path) || path === '/' || path === homedir())) throw new Error('Refusing a broad runtime/cache mount')
const own = (parent, path) => { const child = relative(parent, path); return !child || (!child.startsWith('..') && !isAbsolute(child)) }
const temporary = mkdtempSync(join(tmpdir(), 'docatlas-clean-test-host-'))
let guard
try {
  const args = ['--unshare-user', '--unshare-pid', '--unshare-net', '--die-with-parent', '--new-session', '--info-fd', '3']
  for (const path of ['/usr', '/bin', '/lib', '/lib64', '/etc']) if (existsSync(path)) args.push('--ro-bind', path, path)
  args.push('--proc', '/proc', '--dev', '/dev', '--dir', '/runtime', '--bind', root, root,
    '--bind', temporary, '/tmp', '--bind', cache, cache,
    '--ro-bind', uv, '/runtime/uv', '--ro-bind', rg, '/runtime/rg')
  for (const path of new Set([nodeRoot, pythonRoot])) if (!own(root, path) && !own('/usr', path)) args.push('--ro-bind', path, path)
  const sources = join(root, '.sources')
  if (existsSync(sources)) { if (lstatSync(sources).isSymbolicLink()) throw new Error('Research sources cannot be a symlink'); args.push('--ro-bind', sources, sources) }
  if (mode === 'browser') {
    const require = createRequire(join(root, 'package.json'))
    const { chromium } = require('@playwright/test')
    const browsers = resolve(process.env.PLAYWRIGHT_BROWSERS_PATH ?? dirname(dirname(dirname(chromium.executablePath()))))
    if (!existsSync(browsers) || browsers === '/' || browsers === homedir()) throw new Error('Install the pinned Playwright browsers before this check')
    args.push('--ro-bind', browsers, browsers)
    mkdirSync(join(root, '.cache'), { recursive: true })
  }
  const command = mode === 'check' ? ['scripts/check.sh'] : mode === 'coverage'
    ? ['scripts/pnpmw', 'exec', 'vitest', 'run', '--coverage', ...process.argv.slice(3)]
    : ['scripts/pnpmw', 'exec', 'playwright', 'test', '--config', 'playwright.live.config.ts', '--output', '.cache/playwright-clean-host-results', ...process.argv.slice(3)]
  args.push('--chdir', root, '--', '/bin/bash', ...command)
  const env = { PATH: `/runtime:${dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C.UTF-8', HOME: homedir(), UV_CACHE_DIR: cache, GIT_OPTIONAL_LOCKS: '0', DOCATLAS_CLEAN_TEST_HOST: '1',
    ...(process.env.CI ? { CI: process.env.CI } : {}), ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}) }
  const child = spawn('/usr/bin/bwrap', args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] })
  guard = new SandboxProcess(child)
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr)
  const stop = () => guard.stop()
  process.on('SIGINT', stop); process.on('SIGTERM', stop)
  console.log(`Clean verification host: ${mode}; real nested namespaces, original deadlines and assertions; no production state migration`)
  const result = await guard.done
  process.off('SIGINT', stop); process.off('SIGTERM', stop)
  if (guard.failure) throw guard.failure
  process.exitCode = result.exitCode ?? 1
} finally {
  if (guard) { guard.stop(); await guard.done }
  // This is only the fresh temporary /tmp of the completed verification host.
  rmSync(temporary, { recursive: true, force: true })
}
