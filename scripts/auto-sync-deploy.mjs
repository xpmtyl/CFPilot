#!/usr/bin/env node
/**
 * 季度自动同步 + 部署脚本（供 GitHub Actions 调用，也可本地手动运行）
 *
 * 流程：
 *   1. 检查 upstream/main 是否比当前 main 新
 *   2. 若无更新：打印 "NO_UPDATES" 并退出（CI 据此跳过部署）
 *   3. 若有更新：fast-forward 合并 upstream → 重新构建 → 提交 + 推送 → 部署 Cloudflare
 *
 * 需要的环境变量：
 *   GH_TOKEN    — GitHub token（repo + workflow 权限），CI 中用 secrets.GITHUB_TOKEN
 *   CF_TOKEN    — Cloudflare API token，CI 中用 secrets.CF_TOKEN
 *   CF_ACCT     — Cloudflare Account ID，CI 中用 secrets.CF_ACCOUNT_ID
 *
 * 输出约定：
 *   末行打印 "RESULT: UPDATED" 或 "RESULT: NO_UPDATES" 或 "RESULT: FAILED: <原因>"
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const API = 'https://api.cloudflare.com/client/v4'
const CF_TOKEN = process.env.CF_TOKEN
const CF_ACCT = process.env.CF_ACCT
const GH_TOKEN = process.env.GH_TOKEN
const REPO = 'xpmtyl/CFPilot'
const UPSTREAM = 'xmwengxing/CFPilot'

const run = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', stdio: opts.stdio || 'pipe', ...opts })
const log = (...a) => console.log(...a)

function getResultLine(result) {
  log(`RESULT: ${result}`)
}

async function cf(path, opts = {}) {
  const headers = { Authorization: `Bearer ${CF_TOKEN}` }
  const init = { method: opts.method || 'GET', headers }
  if (opts.body) {
    if (opts.body instanceof FormData) {
      init.body = opts.body
    } else {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(opts.body)
    }
  }
  const res = await fetch(`${API}${path}`, init)
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  if (!res.ok || json.success === false) {
    throw new Error(`${opts.method || 'GET'} ${path} (${res.status}): ${JSON.stringify(json.errors || json).slice(0, 300)}`)
  }
  return json.result
}

async function deployToCloudflare() {
  const ROOT = process.cwd()
  const control = readFileSync(`${ROOT}/packages/worker-core/dist/control.js`, 'utf8')
  const dataplane = readFileSync(`${ROOT}/packages/worker-core/dist/dataplane.js`, 'utf8')

  // Pages: 控制面 <- control.js，数据面 <- dataplane.js
  const pagesTargets = [
    { name: 'ldp7eov5', code: control },
    { name: 'xyuk4s93', code: dataplane },
    { name: 'hfs6bzpkx6', code: control },
    { name: 'ivb1ad8aa6', code: dataplane },
  ]
  for (const t of pagesTargets) {
    const bundle = new FormData()
    bundle.set('metadata', new Blob([JSON.stringify({ main_module: '_worker.js', bindings: {} })], { type: 'application/json' }), 'metadata.json')
    bundle.set('_worker.js', new Blob([t.code], { type: 'application/javascript+module' }), '_worker.js')
    const bundleReq = new Request('https://placeholder.invalid', { method: 'POST', body: bundle })
    const form = new FormData()
    form.set('branch', 'main')
    form.set('manifest', '{}')
    form.set('_worker.bundle', new Blob([await bundleReq.arrayBuffer()], { type: bundleReq.headers.get('content-type') ?? 'multipart/form-data' }), '_worker.bundle')
    await cf(`/accounts/${CF_ACCT}/pages/projects/${t.name}/deployments`, { method: 'POST', body: form })

    // 轮询部署状态
    const deadline = Date.now() + 180000
    for (;;) {
      const list = await cf(`/accounts/${CF_ACCT}/pages/projects/${t.name}/deployments`)
      const latest = Array.isArray(list) ? list[0] : null
      const status = latest?.latest_stage?.status ?? 'unknown'
      if (status === 'success') { log(`  Pages ${t.name}: success`); break }
      if (status === 'failure' || status === 'canceled') throw new Error(`Pages ${t.name} 部署失败: ${status}`)
      if (Date.now() > deadline) throw new Error(`Pages ${t.name} 部署超时`)
      await new Promise((r) => setTimeout(r, 4000))
    }
  }

  // cfe Worker: 读取现有绑定并沿用，仅替换代码
  const settings = await cf(`/accounts/${CF_ACCT}/workers/scripts/cfe/settings`)
  const bindings = settings.bindings || []
  const compatDate = settings.compatibility_date || '2024-09-01'
  const form = new FormData()
  form.set('metadata', new Blob([JSON.stringify({ main_module: 'worker.js', compatibility_date: compatDate, bindings })], { type: 'application/json' }), 'metadata.json')
  form.set('worker.js', new Blob([dataplane], { type: 'application/javascript+module' }), 'worker.js')
  await cf(`/accounts/${CF_ACCT}/workers/scripts/cfe`, { method: 'PUT', body: form })
  log('  Worker cfe: success')
}

async function main() {
  if (!CF_TOKEN || !CF_ACCT || !GH_TOKEN) throw new Error('缺少 GH_TOKEN / CF_TOKEN / CF_ACCT 环境变量')

  // 1. 配置 git（CI 环境无全局身份）
  try { run(['config', 'user.email', 'cfpilot-bot@users.noreply.github.com']) } catch {}
  try { run(['config', 'user.name', 'CFPilot Auto Sync']) } catch {}

  // 2. fetch upstream
  log('检查上游更新...')
  run(['fetch', 'upstream', 'main'])
  const local = run(['rev-parse', 'HEAD']).trim()
  const remote = run(['rev-parse', 'upstream/main']).trim()
  // 用祖先关系判断，而非字符串相等：fork 自带 workflow 等提交，
  // HEAD 永远不等于 upstream/main，用 != 判断会导致每次都误判为有更新。
  let upstreamIsAncestor = true
  try {
    run(['merge-base', '--is-ancestor', remote, 'HEAD'])
  } catch {
    upstreamIsAncestor = false
  }
  if (upstreamIsAncestor) {
    log('上游无新提交（upstream 已是 HEAD 的祖先），无需更新。')
    getResultLine('NO_UPDATES')
    return
  }
  log(`发现上游新提交: ${local.slice(0, 8)} -> ${remote.slice(0, 8)}`)

  // 3. 合并 + 构建
  // fork 可能自带 workflow 等额外提交，无法 fast-forward，用 --no-edit 合并；
  // 若上游是 HEAD 祖先（理论已在上面跳过）才走 ff-only。
  try {
    run(['merge', '--ff-only', 'upstream/main'])
  } catch {
    run(['merge', '--no-edit', '-m', 'chore: merge upstream updates', 'upstream/main'])
  }
  log('安装依赖并构建...')
  execFileSync('npm', ['ci'], { stdio: 'inherit' })
  execFileSync('npm', ['run', 'build'], { stdio: 'inherit' })

  // 4. 提交 + 推送
  const changed = run(['status', '--short']).trim()
  if (changed) {
    run(['add', '-A'])
    run(['commit', '-m', `chore: auto-sync upstream to ${remote.slice(0, 8)} and rebuild assets`])
    const pushUrl = `https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git`
    execFileSync('git', ['push', pushUrl, 'main'], { stdio: 'inherit' })
    log('已推送更新到 fork。')
  }

  // 5. 部署 Cloudflare
  log('部署到 Cloudflare...')
  await deployToCloudflare()
  getResultLine('UPDATED')
}

main().catch((e) => {
  console.error('错误:', e.message || e)
  getResultLine(`FAILED: ${e.message || e}`)
  process.exit(1)
})
