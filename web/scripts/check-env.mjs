import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const EXPECTED_NODE = '22.19.0'
const EXPECTED_PNPM = '11.7.0'
const EXPECTED_PYTHON = '3.12.12'
const EXPECTED_UV = '0.9.21'

function text(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').trim()
}

function fail(message) {
  throw new Error(`environment check failed: ${message}`)
}

if (process.versions.node !== EXPECTED_NODE) {
  fail(`Node ${process.versions.node} is active; expected ${EXPECTED_NODE}`)
}
if (text('.node-version') !== EXPECTED_NODE) fail('.node-version drifted')
if (text('.python-version') !== EXPECTED_PYTHON) fail('.python-version drifted')

const packageManager = JSON.parse(text('package.json')).packageManager
if (packageManager !== `pnpm@${EXPECTED_PNPM}`) fail('packageManager drifted')
const userAgent = process.env.npm_config_user_agent ?? ''
if (!userAgent.startsWith(`pnpm/${EXPECTED_PNPM} `)) {
  fail(`pnpm ${EXPECTED_PNPM} is required; received ${userAgent || 'no package-manager user agent'}`)
}

const uv = execFileSync('uv', ['--version'], { encoding: 'utf8' }).trim()
if (uv !== `uv ${EXPECTED_UV}`) fail(`expected uv ${EXPECTED_UV}; received ${uv}`)

console.log(`environment verified: Node ${EXPECTED_NODE}, pnpm ${EXPECTED_PNPM}, Python ${EXPECTED_PYTHON}, uv ${EXPECTED_UV}`)
if (process.env.DOCATLAS_CLEAN_TEST_HOST === '1') console.log(`verification mount table: ${readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n').length} entries (real nested isolation tests unchanged)`)
