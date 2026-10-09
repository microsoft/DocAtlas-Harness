import { parseArgs } from 'node:util'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createAzureLunaModel } from '@docatlas/runtime-pi'
import { startDocAtlasApplication } from './application.js'

const { values } = parseArgs({ options: { port: { type: 'string', default: '4177' }, 'state-root': { type: 'string' }, 'resource-hash': { type: 'string' }, help: { type: 'boolean' } }, allowPositionals: false, strict: true })
if (values.help) {
  process.stdout.write('DocAtlas Pi Web (single-user loopback beta)\nUsage: bash scripts/run-docatlas-web.sh [--port 4177] [--state-root /dedicated/path] [--resource-hash reviewed-sha256]\nRequires az login. Model: GPT-5.6 Luna; original PDF citations, local durable history.\n')
} else {
  const projectRoot = fileURLToPath(new URL('../../../', import.meta.url))
  try {
    if (!/^\d+$/.test(values.port!) || Number(values.port) > 65535) throw new Error('invalid-port')
    try { execFileSync('az', ['account', 'show', '--only-show-errors'], { stdio: 'ignore', timeout: 15000 }) }
    catch { throw new Error('Run az login before starting the Azure-backed service.') }
    const model = await createAzureLunaModel()
    const application = await startDocAtlasApplication({ ...model, projectRoot, webRoot: resolve(projectRoot, 'apps/web/dist'),
      root: resolve(values['state-root'] ?? resolve(projectRoot, '.cache/product')), port: Number(values.port), localAccess: true, ...(values['resource-hash'] ? { trustedResourceHash: values['resource-hash'] } : {}) })
    process.stdout.write(`DocAtlas Pi Web · 本机测试版\n打开：${application.origin}/\n无需登录或配对，打开即可使用。\n模型：GPT-5.6 Luna（Azure Entra，凭据只在服务内存）\n原生工具工作目录：${application.workspaceRoot}\n远程使用请通过 SSH 转发同一端口；能访问本机端口的人即可使用此工作区，不要暴露到公网或共享代理。\nCtrl+C 正常关闭并保存会话。\n`)
    let closing = false
    const stop = () => {
      if (closing) return; closing = true
      void application.close().then(() => { process.stdout.write('DocAtlas 已正常关闭。\n') }, () => { process.stderr.write('关闭未完全核验；保留了状态，请检查后再启动。\n'); process.exitCode = 1 })
    }
    process.on('SIGINT', stop); process.on('SIGTERM', stop)
  } catch (error) {
    // Only these local setup messages are safe to print. Provider errors/headers/tokens never go to the terminal.
    const message = error instanceof Error ? error.message : ''
    process.stderr.write(message.startsWith('Trusted resources require explicit review:') || message.startsWith('Run az login') ? `${message}\n` : 'DocAtlas 启动失败；请检查构建、Azure登录、独立状态目录与端口。未切换为演示模型。\n')
    process.exitCode = 1
  }
}
