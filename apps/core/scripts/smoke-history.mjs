/**
 * smoke-history.mjs — P26 历史播放记录 RPC 行为自测（不依赖桌面端）
 *
 * 直连 pf-core，覆盖内核侧全部语义：
 *   T1  空列表 / 总数 0
 *   T2  首次记录（采集站式：api+vodId+剧集快照）
 *   T3  同片换集 → 仍 1 条，集名更新且进度归零
 *   T4  同集重播 → 保留旧进度（用户是来续播的，不是来清零的）
 *   T5  history.progress 只刷位置（元数据不动）；未知 key 返回 saved:false 不报错
 *   T6  直链去重：带 query / 尾斜杠 / host 大小写视为同一条
 *   T7  列表按最近播放倒序 + total + 分页
 *   T8  delete / clear
 *   T9  非法参数（缺 title / 缺 key）返回 -32602
 *
 * 用法：node apps/core/scripts/smoke-history.mjs
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(here, '../target/release/pf-core.exe')
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'pf-hist-'))

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`  ${ok ? GREEN + 'PASS' : RED + 'FAIL'}${RESET} ${name}${detail ? ` ${DIM}(${detail})${RESET}` : ''}`)
}

const proc = spawn(BIN, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, LOCALAPPDATA: dataDir } })
proc.stderr.on('data', () => {})
proc.on('exit', (c) => console.log(`[core] exited code=${c}`))

let port = 0
let token = ''
let buf = ''
const ready = new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('等待端口/token 超时')), 20000)
  const onData = (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      let m = line.match(/^PF_CORE_PORT=(\d+)$/)
      if (m) port = +m[1]
      m = line.match(/^PF_CORE_TOKEN=([0-9a-f]+)$/)
      if (m) token = m[1]
      if (port && token) {
        clearTimeout(t)
        proc.stdout.off('data', onData)
        resolve()
      }
    }
  }
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', onData)
})

await ready

const socket = net.connect(port, '127.0.0.1')
await new Promise((res, rej) => {
  socket.once('connect', res)
  socket.once('error', rej)
})
socket.write(`PF_AUTH ${token}\n`)

const pending = new Map()
let nextId = 1
readline.createInterface({ input: socket, crlfDelay: Infinity }).on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg?.id != null && ('result' in msg || 'error' in msg)) {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    msg.error ? p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code })) : p.resolve(msg.result)
  }
})

function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

const epsA = [
  { name: '第01集', url: 'https://cdn.a/1.m3u8' },
  { name: '第02集', url: 'https://cdn.a/2.m3u8' }
]
const groups = [{ from: '线路一', episodes: epsA }]

try {
  // ---- T1 空列表 ----
  const l0 = await rpc('catalog.history.list', { limit: 20, offset: 0 })
  check('T1 初始历史为空', Array.isArray(l0.items) && l0.items.length === 0 && l0.total === 0, JSON.stringify(l0))

  // ---- T2 首次记录 ----
  const rec1 = await rpc('catalog.history.record', {
    title: '流浪地球',
    episodeName: '第01集',
    episodeUrl: 'https://cdn.a/1.m3u8',
    siteName: '测试站A',
    api: 'https://api.a/',
    vodId: '42',
    poster: 'https://img/p.jpg',
    groups,
    groupIndex: 0
  })
  const it1 = rec1.item
  check(
    'T2 首次记录入库（按片生成 key）',
    it1?.key === 'vod|https://api.a|42' && it1.title === '流浪地球' && it1.episodeName === '第01集',
    JSON.stringify({ key: it1?.key, ep: it1?.episodeName })
  )
  check('T2 剧集快照已存（续播不用回源）', String(it1?.groups ?? '').includes('第02集'))
  check('T2 起播进度为 0', it1.positionSec === 0 && it1.durationSec === 0)

  // ---- 先写一次进度，供 T4 校验「同集重播不清零」 ----
  const p1 = await rpc('catalog.history.progress', { key: it1.key, position: 600, duration: 2700 })
  check('T5 进度上报成功', p1.saved === true, JSON.stringify(p1))

  // ---- T3 同片换集 ----
  const rec2 = await rpc('catalog.history.record', {
    title: '流浪地球',
    episodeName: '第02集',
    episodeUrl: 'https://cdn.a/2.m3u8',
    siteName: '测试站A',
    api: 'https://api.a',
    vodId: '42',
    groups,
    groupIndex: 0
  })
  const l2 = await rpc('catalog.history.list', { limit: 20, offset: 0 })
  check('T3 同一影片换集不新增行', l2.total === 1 && l2.items[0].key === it1.key, `total=${l2.total}`)
  check('T3 集名更新为新集', rec2.item.episodeName === '第02集')
  check('T3 换集后进度归零', rec2.item.positionSec === 0, `pos=${rec2.item.positionSec}`)
  check('T3 元数据保留（海报/快照）', rec2.item.poster === 'https://img/p.jpg' && String(rec2.item.groups).includes('线路一'))

  // ---- T4 同集重播 ----
  await rpc('catalog.history.progress', { key: it1.key, position: 900, duration: 2700 })
  const rec3 = await rpc('catalog.history.record', {
    title: '流浪地球',
    episodeName: '第02集',
    episodeUrl: 'https://cdn.a/2.m3u8',
    api: 'https://api.a',
    vodId: '42'
  })
  check('T4 同集重播保留旧进度', Math.abs(rec3.item.positionSec - 900) < 0.001, `pos=${rec3.item.positionSec}`)
  check('T4 未传 groups 时保留旧快照', String(rec3.item.groups).includes('第02集'))

  // ---- T5 进度语义 ----
  const p2 = await rpc('catalog.history.progress', { key: 'not-exist', position: 10, duration: 20 })
  check('T5 未知 key 不报错（saved:false）', p2.saved === false, JSON.stringify(p2))
  const afterP2 = await rpc('catalog.history.list', { limit: 20, offset: 0 })
  check('T5 未知 key 不会凭空建行', afterP2.total === 1)

  // ---- T6 直链去重 ----
  const direct = (url) => rpc('catalog.history.record', { title: '直链片', episodeUrl: url })
  const d1 = await direct('https://CDN.example.com/v/a.mp4?sig=111&t=1#frag')
  const d2 = await direct('https://cdn.example.com/v/a.mp4/')
  check('T6 直链按 URL 归一化去重（query/fragment/尾斜杠/host 大小写）', d1.item.key === d2.item.key, `${d1.item.key} vs ${d2.item.key}`)
  const l6 = await rpc('catalog.history.list', { limit: 20, offset: 0 })
  check('T6 去重后共 2 条', l6.total === 2, `total=${l6.total}`)
  check('T6 最近播放排在最前', l6.items[0].key === d1.item.key, l6.items[0].key)

  // ---- T7 分页 ----
  const page1 = await rpc('catalog.history.list', { limit: 1, offset: 0 })
  const page2 = await rpc('catalog.history.list', { limit: 1, offset: 1 })
  check(
    'T7 分页返回不同记录',
    page1.items.length === 1 && page2.items.length === 1 && page1.items[0].key !== page2.items[0].key && page1.total === 2,
    `${page1.items[0]?.key} / ${page2.items[0]?.key}`
  )

  // ---- T9 非法参数（先测，避免影响后续计数） ----
  const bad1 = await rpc('catalog.history.record', { title: '', episodeUrl: '' }).then(
    () => ({ code: 0 }),
    (e) => e
  )
  check('T9 缺 title/episodeUrl 返回 -32602', bad1.code === -32602, String(bad1.code))
  const bad2 = await rpc('catalog.history.progress', {}).then(
    () => ({ code: 0 }),
    (e) => e
  )
  check('T9 缺 key 返回 -32602', bad2.code === -32602, String(bad2.code))
  const bad3 = await rpc('catalog.history.delete', {}).then(
    () => ({ code: 0 }),
    (e) => e
  )
  check('T9 delete 缺 key 返回 -32602', bad3.code === -32602, String(bad3.code))

  // ---- T8 删除 / 清空 ----
  const del = await rpc('catalog.history.delete', { key: d1.item.key })
  check('T8 删除单条', del.removed === true)
  const delAgain = await rpc('catalog.history.delete', { key: d1.item.key })
  check('T8 重复删除返回 removed:false', delAgain.removed === false)
  const l8 = await rpc('catalog.history.list', { limit: 20, offset: 0 })
  check('T8 删除后只剩 1 条', l8.total === 1, `total=${l8.total}`)
  const clr = await rpc('catalog.history.clear')
  check('T8 清空返回删除条数', clr.cleared === 1, `cleared=${clr.cleared}`)
  const l9 = await rpc('catalog.history.list', { limit: 20, offset: 0 })
  check('T8 清空后列表为空', l9.total === 0 && l9.items.length === 0)
} catch (e) {
  check(`异常：${e.message}`, false)
} finally {
  const pass = results.filter((r) => r.ok).length
  console.log(`\n${pass}/${results.length} 通过`)
  try {
    socket.destroy()
  } catch {
    /* ignore */
  }
  try {
    proc.kill()
  } catch {
    /* ignore */
  }
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  process.exit(pass === results.length ? 0 : 1)
}
