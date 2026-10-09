import { spawn } from 'node:child_process'

import {
  capabilitiesRequest,
  healthRequest,
  isCapabilitiesSuccess,
  isHealthSuccess,
} from '../packages/contracts/lib/index.js'
import { parseContract } from '../packages/contracts/lib/node.js'

const env = { ...process.env }
delete env.VIRTUAL_ENV

const child = spawn('uv', [
  'run', '--locked', '--project', 'python/docatlas-sidecar', 'docatlas-sidecar',
], {
  cwd: new URL('..', import.meta.url),
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
})

let stdout = ''
let stderr = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', chunk => { stdout += chunk })
child.stderr.on('data', chunk => { stderr += chunk })

child.stdin.end([
  JSON.stringify(healthRequest('cross-language-health')),
  JSON.stringify(capabilitiesRequest('cross-language-capabilities')),
  '',
].join('\n'))

const timeout = setTimeout(() => {
  child.kill('SIGTERM')
}, 10_000)

const [code, signal] = await new Promise(resolve => {
  child.once('close', (exitCode, exitSignal) => resolve([exitCode, exitSignal]))
})
clearTimeout(timeout)

if (code !== 0 || signal !== null) {
  throw new Error(`sidecar exited with code=${String(code)} signal=${String(signal)}: ${stderr.trim()}`)
}
const lines = stdout.trim().split('\n')
if (lines.length !== 2) throw new Error(`sidecar returned ${lines.length} lines`)
const health = JSON.parse(lines[0])
const capabilities = JSON.parse(lines[1])
parseContract('sidecar-envelope', health)
parseContract('sidecar-envelope', capabilities)
if (!isHealthSuccess(health)) throw new Error(`invalid sidecar health response: ${lines[0]}`)
if (!isCapabilitiesSuccess(capabilities)) {
  throw new Error(`invalid sidecar capabilities response: ${lines[1]}`)
}
parseContract('sidecar-capabilities', capabilities.result)

console.log('cross-language sidecar health and capabilities verified')
