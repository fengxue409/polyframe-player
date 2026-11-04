/**
 * P8 无头冒烟测试：视频源预设库 / 批量导入 / 全量测速
 *  A. 预设库：新装播种 19 个预设 + presets 返回 total/installed/installedFlag
 *  B. 批量导入（文本）：混合「名称$URL」/ 注释 / 重复 / 不可达 → imported/skipped/failed 计数正确且幂等
 *  C. 批量导入（JSON）：LibreTV-SourceList 形态；isAdult 条目不入库
 *  D. 批量导入（Base58）：Base58(JSON) 订阅文本可解析
 *  E. 批量导入（无参）：-32602 参数错误
 *  F. 全量测速：probe_all 命中本地假源（ok=1）并回写延迟
 *
 * 全部使用本地假 CMS origin，不依赖外网。
 * 运行：node apps/core/scripts/smoke-p8.mjs（需先 pnpm core:build）
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import { existsSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const coreRoot = path.resolve(here, '..')
const binCandidates = [
  path.join(coreRoot, 'target/release/pf-core.exe'),
  path.join(coreRoot, 'target/debug/pf-core.exe')
]

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`  ${ok ? GREEN + 'PASS' : RED + 'FAIL'}${RESET} ${name}${detail ? ` ${DIM}(${detail})${RESET}` : ''}`)
}

/** 假 CMS 采集站（苹果CMS V10：ac=list 返回 JSON 列表） */
function startCmsOrigin() {
  const state = { listHits: 0 }
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (u.pathname.endsWith('/api.php/provide/vod') && u.searchParams.get('ac') === 'list') {
      state.listHits++
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          code: 1,
          page: 1,
          total: 1,
          list: [{ vod_id: 1, vod_name: '冒烟影片', vod_year: '2026', vod_play_from: 'm3u8' }]
        })
      )
      return
    }
    res.writeHead(404).end()
  })
  let port = 0
  return {
    state,
    start: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          port = server.address().port
          resolve(`http://127.0.0.1:${port}/api.php/provide/vod`)
        })
      }),
    close: () => server.close()
  }
}

/** Base58 编码（构造订阅样例） */
function base58Encode(input) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  const digits = [0]
  for (const b of input) {
    let carry = b
    for (let i = 0; i < digits.length; i++) {
      const x = digits[i] * 256 + carry
      digits[i] = x % 58
      carry = Math.floor(x / 58)
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }
  let s = ''
  for (const d of digits.reverse()) s += ALPHABET[d]
  return s
}

function startCore(envOverride = {}) {
  const bin = binCandidates.find((p) => existsSync(p))
  if (!bin) throw new Error('未找到 pf-core.exe，请先执行: pnpm core:build')
  const proc = spawn(bin, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...envOverride, PF_PROXY_ALLOW_PRIVATE: '1' } }) // M5/L1：本地测试源需放开私网目标
  const portReady = new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error('等待 PF_CORE_PORT 超时')), 20000)
    const onData = (d) => {
      buf += d.toString()
      const m = buf.match(/PF_CORE_PORT=(\d+)/)
      const t = buf.match(/PF_CORE_TOKEN=([0-9a-f]+)/)
      if (t) rpcToken = t[1]

      if (m) {
        clearTimeout(timer)
        proc.stdout.off('data', onData)
        resolve(Number(m[1]))
      }
    }
    proc.stdout.on('data', onData)
    proc.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`内核提前退出 code=${code}`))
    })
  })
  return { proc, portReady }
}

let rpcToken = '' // H2：pf-core stdout 端口发现一并下发的连接鉴权 token
function connectRpc(port) {
  const socket = net.connect(port, '127.0.0.1')
  socket.write('PF_AUTH ' + rpcToken + '\n') // H2 连接鉴权（首行）
  let buf = ''
  let nextId = 1
  const pending = new Map()
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.id !== undefined) {
        const p = pending.get(msg.id)
        if (p) {
          pending.delete(msg.id)
          clearTimeout(p.timer)
          msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
        }
      }
    }
  })
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`超时: ${method}`))
      }, 90000)
      pending.set(id, { resolve, reject, timer })
      socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  return { socket, request }
}

let proc = null
const origins = []

try {
  const bin = binCandidates.find((p) => existsSync(p))
  console.log(`${DIM}启动内核: ${bin}${RESET}`)
  const first = startCore({ LOCALAPPDATA: path.join(process.env.TEMP ?? '.', `pf-smoke-p8-${process.pid}`) })
  proc = first.proc
  const port = await first.portReady
  const { request } = connectRpc(port)
  await request('core.hello')

  // ============ A 预设库 ============
  console.log(`\n${DIM}—— A 预设库 ——${RESET}`)
  const pre = await request('catalog.source.presets')
  check('presets 返回版本与全量列表', pre?.version >= 2 && pre.total === pre.presets.length, `v${pre.version} total=${pre.total}`)
  check('新装即播种全部预设（installed == total）', pre.installed === pre.total, `${pre.installed}/${pre.total}`)
  check(
    '预设均为 http(s) 且带 installed 标记',
    pre.presets.every((p) => /^https?:\/\//.test(p.api) && typeof p.installed === 'boolean')
  )

  // ============ B 文本导入（含重复 / 不可达） ============
  console.log(`\n${DIM}—— B 文本批量导入 ——${RESET}`)
  const originA = startCmsOrigin()
  origins.push(originA)
  const apiA = await originA.start()
  const text = [
    '# 注释行应被忽略',
    `冒烟站A$${apiA}`,
    `${apiA}`,
    '坏站$http://127.0.0.1:1/api.php/provide/vod',
    '无链接的无用行'
  ].join('\n')
  const imp1 = await request('catalog.source.import', { text, probe: true })
  check(
    '文本导入：1 条入库 / 重复行解析期去重 / 1 条探测失败',
    imp1.importedCount === 1 && imp1.skipped === 0 && imp1.failedCount === 1,
    JSON.stringify({ i: imp1.importedCount, s: imp1.skipped, f: imp1.failedCount })
  )
  check('入库行带延迟（探测成功回写）', imp1.imported[0]?.latencyMs > 0, `${imp1.imported[0]?.latencyMs}ms`)

  const imp1b = await request('catalog.source.import', { text: `冒烟站A$${apiA}`, probe: true })
  check('重复导入幂等（全跳过）', imp1b.importedCount === 0 && imp1b.skipped === 1)

  // ============ C JSON 导入（LibreTV 形态 + isAdult） ============
  console.log(`\n${DIM}—— C JSON 订阅导入 ——${RESET}`)
  const originB = startCmsOrigin()
  origins.push(originB)
  const apiB = await originB.start()
  const libreJson = JSON.stringify({
    name: '冒烟源列表',
    version: 2,
    sources: [
      { name: '冒烟站B', url: apiB },
      { name: '成人站', url: 'http://127.0.0.1:1/api.php/provide/vod', isAdult: true }
    ],
    liveSources: [{ name: '直播', url: 'http://127.0.0.1:1/list.m3u' }]
  })
  const imp2 = await request('catalog.source.import', { text: libreJson, probe: true })
  check('JSON 导入：1 入库 / isAdult 丢弃 1', imp2.importedCount === 1 && imp2.adultDropped === 1, JSON.stringify({ i: imp2.importedCount, a: imp2.adultDropped }))
  check('直播源不入采集站', imp2.imported.every((s) => !s.api.endsWith('.m3u')))

  // ============ D Base58 订阅导入 ============
  console.log(`\n${DIM}—— D Base58 订阅导入 ——${RESET}`)
  const b58 = base58Encode(
    Buffer.from(JSON.stringify({ sources: [{ name: '冒烟站C', url: apiA.replace('/api.php/provide/vod', '/api.php/provide/vod') }] }))
  )
  const imp3 = await request('catalog.source.import', { text: b58, probe: true })
  check('Base58 订阅可解析（重复站跳过）', imp3.skipped === 1 && imp3.importedCount === 0, JSON.stringify({ i: imp3.importedCount, s: imp3.skipped }))

  // ============ E 参数校验 ============
  console.log(`\n${DIM}—— E 参数校验 ——${RESET}`)
  let paramErr = ''
  try {
    await request('catalog.source.import', {})
  } catch (e) {
    paramErr = e.message
  }
  check('无 text/url 报参数错误', /text \/ url required/.test(paramErr), paramErr)

  // ============ F 全量测速 ============
  console.log(`\n${DIM}—— F 全量测速 ——${RESET}`)
  const list = await request('catalog.source.list')
  const smokeRows = list.sources.filter((s) => s.name.startsWith('冒烟站'))
  check('列表含导入的两个冒烟站', smokeRows.length === 2, `${smokeRows.length} 个`)
  const probeAll = await request('catalog.source.probe_all', { ids: smokeRows.map((s) => s.id) })
  check('probe_all 全部命中（ok=2 / fail=0）', probeAll.ok === 2 && probeAll.fail === 0, JSON.stringify({ ok: probeAll.ok, fail: probeAll.fail }))
  check(
    'probe_all 回写延迟',
    probeAll.results.every((r) => r.ok && typeof r.latencyMs === 'number'),
    JSON.stringify(probeAll.results.map((r) => r.latencyMs))
  )

  // ============ 清理 ============
  for (const s of smokeRows) await request('catalog.source.remove', { id: s.id })
  const after = await request('catalog.source.list')
  check('清理后仅剩预设源站', after.sources.filter((s) => s.name.startsWith('冒烟站')).length === 0)
} catch (e) {
  check('未捕获异常', false, e.message)
} finally {
  for (const o of origins) o.close()
  if (proc) proc.kill()
  const passed = results.filter((r) => r.ok).length
  const total = results.length
  console.log(`\n${passed === total ? GREEN : RED}P8 冒烟：${passed}/${total}${RESET}\n`)
  process.exit(passed === total ? 0 : 1)
}
