#!/usr/bin/env node
/**
 * CFPilot 完整实例重建 + 部署脚本（供 GitHub Actions workflow_dispatch 调用）
 *
 * 重建两组实例（控制面+数据面），内核首次启动会用环境变量自动初始化 KV：
 *   实例B(主): hfs6bzpkx6(控制) + ivb1ad8aa6(数据)
 *   实例A(新): ldp7eov5(控制)   + xyuk4s93(数据)
 *
 * 全部敏感值从 GitHub Secrets 注入（仓库为 public，禁止明文写入）：
 *   CF_TOKEN, CF_ACCOUNT_ID
 *   CFP_PW_B, CFP_UUID_B, CFP_TROJAN_B  — 实例B 面板密码/UUID/Trojan密码
 *   CFP_PW_A, CFP_UUID_A, CFP_TROJAN_A  — 实例A（可为空，由内核随机生成）
 */
import { readFileSync } from 'node:fs'

const CF_TOKEN = process.env.CF_TOKEN
const CF_ACCT = process.env.CF_ACCOUNT_ID
const API = 'https://api.cloudflare.com/client/v4'
const ROOT = process.cwd()

if (!CF_TOKEN || !CF_ACCT) {
  console.error('缺少 CF_TOKEN / CF_ACCOUNT_ID'); process.exit(1)
}

// 非敏感的固定配置（路径沿用原实例；密码/UUID 从 Secret 读）
const INSTANCES = [
  {
    key: 'B',
    control: 'hfs6bzpkx6',
    data: 'ivb1ad8aa6',
    panelPath: '/p-4cmvtcjk',
    wsPath: '/ftdz5ee67k',
    kvTitle: 'cfpilot-kv-rebuilt-mwoendo6',
    panelPassword: process.env.CFP_PW_B || '',
    uuid: process.env.CFP_UUID_B || '',
    trojanPassword: process.env.CFP_TROJAN_B || '',
    customDomain: 'cfp.xpyxm.eu.cc',
  },
  {
    key: 'A',
    control: 'ldp7eov5',
    data: 'xyuk4s93',
    panelPath: '/gzuzg64sdbi3',
    wsPath: '/ecaefgzhti',
    kvTitle: 'cfpilot-kv-rebuilt-6590vulx',
    panelPassword: process.env.CFP_PW_A || '',
    uuid: process.env.CFP_UUID_A || '',
    trojanPassword: process.env.CFP_TROJAN_A || '',
    customDomain: '',
  },
]

async function cf(path, opts = {}) {
  const headers = { Authorization: `Bearer ${CF_TOKEN}` }
  const init = { method: opts.method || 'GET', headers }
  if (opts.body !== undefined) {
    if (opts.body instanceof FormData) init.body = opts.body
    else if (opts.raw) { headers['Content-Type'] = 'text/plain'; init.body = String(opts.body) }
    else { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body) }
  }
  const res = await fetch(`${API}${path}`, init)
  const text = await res.text()
  let json; try { json = JSON.parse(text) } catch { json = { raw: text } }
  if (!res.ok || json.success === false) {
    throw new Error(`${opts.method || 'GET'} ${path} (${res.status}): ${JSON.stringify(json.errors || json).slice(0, 400)}`)
  }
  return json.result
}

async function findOrCreateKV(title) {
  const list = await cf(`/accounts/${CF_ACCT}/storage/kv/namespaces?per_page=100`)
  const found = (list || []).find((n) => n.title === title)
  if (found) { console.log(`  KV ${title} 已存在: ${found.id}`); return found.id }
  const created = await cf(`/accounts/${CF_ACCT}/storage/kv/namespaces`, { method: 'POST', body: { title } })
  console.log(`  KV ${title} 新建: ${created.id}`)
  return created.id
}

async function findOrCreatePages(name) {
  try {
    await cf(`/accounts/${CF_ACCT}/pages/projects/${name}`)
    console.log(`  Pages ${name} 已存在`)
  } catch {
    await cf(`/accounts/${CF_ACCT}/pages/projects`, {
      method: 'POST',
      body: { name, production_branch: 'main' },
    })
    console.log(`  Pages ${name} 新建`)
  }
}

async function setPagesVars(name, envVars, kvIds) {
  await cf(`/accounts/${CF_ACCT}/pages/projects/${name}/environments/production/vars`, {
    method: 'PATCH',
    body: { env_vars: envVars, kv_namespaces: kvIds },
  })
  console.log(`  Pages ${name} 变量/KV绑定 已配置`)
}

async function deployPages(name, code) {
  const bundle = new FormData()
  bundle.set('metadata', new Blob([JSON.stringify({ main_module: '_worker.js', bindings: {} })], { type: 'application/json' }), 'metadata.json')
  bundle.set('_worker.js', new Blob([code], { type: 'application/javascript+module' }), '_worker.js')
  const req = new Request('https://placeholder.invalid', { method: 'POST', body: bundle })
  const form = new FormData()
  form.set('branch', 'main'); form.set('manifest', '{}')
  form.set('_worker.bundle', new Blob([await req.arrayBuffer()], { type: req.headers.get('content-type') ?? 'multipart/form-data' }), '_worker.bundle')
  // 新建项目首次部署可能返回 8000119（风控），重试一次
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await cf(`/accounts/${CF_ACCT}/pages/projects/${name}/deployments`, { method: 'POST', body: form })
      break
    } catch (e) {
      if (attempt === 3) throw e
      console.log(`  Pages ${name} 部署请求重试 ${attempt}...`)
      await new Promise((r) => setTimeout(r, 5000))
    }
  }
  const deadline = Date.now() + 180000
  for (;;) {
    const list = await cf(`/accounts/${CF_ACCT}/pages/projects/${name}/deployments`)
    const st = Array.isArray(list) ? (list[0]?.latest_stage?.status) : null
    if (st === 'success') { console.log(`  Pages ${name} 部署成功`); break }
    if (st === 'failure' || st === 'canceled') throw new Error(`Pages ${name} 部署失败: ${st}`)
    if (Date.now() > deadline) throw new Error(`Pages ${name} 部署超时`)
    await new Promise((r) => setTimeout(r, 4000))
  }
}

async function main() {
  const control = readFileSync(`${ROOT}/packages/worker-core/dist/control.js`, 'utf8')
  const dataplane = readFileSync(`${ROOT}/packages/worker-core/dist/dataplane.js`, 'utf8')

  for (const inst of INSTANCES) {
    console.log(`\n========== 重建实例 ${inst.key}: ${inst.control} + ${inst.data} ==========`)
    const kvId = await findOrCreateKV(inst.kvTitle)
    await findOrCreatePages(inst.control)
    await findOrCreatePages(inst.data)

    const kvBinding = { K: { namespace_id: kvId }, KV: { namespace_id: kvId } }
    const controlVars = {
      DATA_HOST: { type: 'plain_text', value: `${inst.data}.pages.dev` },
      PANEL_PATH: { type: 'plain_text', value: inst.panelPath },
    }
    if (inst.panelPassword) controlVars.PANEL_PASSWORD = { type: 'secret_text', value: inst.panelPassword }
    await setPagesVars(inst.control, controlVars, kvBinding)

    const dataVars = {
      ENABLE_TROJAN: { type: 'plain_text', value: 'true' },
      ENABLE_XHTTP: { type: 'plain_text', value: 'true' },
      WS_PATH: { type: 'plain_text', value: inst.wsPath },
      PATH: { type: 'plain_text', value: inst.wsPath },
      RESOLVE_PREFERRED: { type: 'plain_text', value: 'true' },
    }
    if (inst.uuid) dataVars.UUID = { type: 'plain_text', value: inst.uuid }
    if (inst.trojanPassword) dataVars.TROJAN_PASSWORD = { type: 'plain_text', value: inst.trojanPassword }
    await setPagesVars(inst.data, dataVars, kvBinding)

    await deployPages(inst.control, control)
    await deployPages(inst.data, dataplane)

    console.log(`实例 ${inst.key} 完成: 面板 https://${inst.control}.pages.dev${inst.panelPath} | 数据面 ${inst.data}.pages.dev`)
    if (inst.customDomain) console.log(`  自定义域名 ${inst.customDomain} 如需恢复请到 Cloudflare 手动绑定 Pages 项目 ${inst.control}`)
  }
  console.log('\n========== 全部重建完成 ==========')
}

main().catch((e) => { console.error('重建失败:', e.message || e); process.exit(1) })
