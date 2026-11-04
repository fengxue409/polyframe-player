#!/usr/bin/env node
/**
 * 多源片源压力测试：
 * 1) 从 18 个预设 CMS 源随机拉影片，抽取集数媒体直链（过滤 share/html 页），凑 100 条
 * 2) 拉起真实 pf-core，并发创建 task.create + 经代理验证播放清单 200/EXTM3U + task.delete
 * 输出按源统计的成功率/耗时/错误样本
 */
import { spawn } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const TARGET = 100
const CONCURRENCY = 4
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const SOURCES = [
  'http://caiji.dyttzyapi.com/api.php/provide/vod',
  'http://cj.lziapi.com/api.php/provide/vod',
  'https://360zy.com/api.php/provide/vod',
  'https://api.apibdzy.com/api.php/provide/vod',
  'https://api.guangsuapi.com/api.php/provide/vod',
  'https://api.maoyanapi.top/api.php/provide/vod',
  'https://api.ukuapi88.com/api.php/provide/vod',
  'https://api.wujinapi.com/api.php/provide/vod',
  'https://api.zuidapi.com/api.php/provide/vod',
  'https://bfzyapi.com/api.php/provide/vod',
  'https://caiji.moduapi.cc/api.php/provide/vod',
  'https://cj.ffzyapi.com/api.php/provide/vod',
  'https://hhzyapi.com/api.php/provide/vod',
  'https://iqiyizyapi.com/api.php/provide/vod',
  'https://jszyapi.com/api.php/provide/vod',
  'https://jyzyapi.com/provide/vod/from/jinyingyun/at/json',
  'https://subocaiji.com/api.php/provide/vod',
  'https://www.hongniuzy2.com/api.php/provide/vod'
]

const isNonMedia = (u) => /\/share\//.test(u) || /\.html?$/i.test(u)
const host = (u) => new URL(u).host
async function jget(api, qs) {
  const sep = api.includes('?') ? '&' : '?'
  const r = await fetch(api + sep + qs, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

// ---------- 1) 采集 ----------
async function collect() {
  const perSource = []
  await Promise.all(
    SOURCES.map(async (api) => {
      const got = []
      try {
        // 随机页拿 id 列表
        const pg = 1 + Math.floor(Math.random() * 30)
        const list = await jget(api, `ac=list&pg=${pg}`)
        const ids = (list.list ?? []).map((v) => v.vod_id).filter(Boolean)
        // 随机挑 3 部取详情
        const picks = ids.sort(() => Math.random() - 0.5).slice(0, 3)
        for (const id of picks) {
          try {
            const d = await jget(api, `ac=detail&ids=${id}`)
            const v = d.list?.[0]
            if (!v) continue
            const names = String(v.vod_play_from ?? '').split('$$$')
            const groups = String(v.vod_play_url ?? '').split('$$$')
            for (const g of groups) {
              for (const ep of g.split('#')) {
                const u = ep.split('$').pop()?.trim()
                if (u && /^https?:\/\//.test(u) && !isNonMedia(u)) got.push(u)
              }
            }
            void names
            if (got.length >= 8) break
          } catch {}
        }
      } catch (e) {
        console.log(`  [采集失败] ${host(api)}: ${String(e.message).slice(0, 60)}`)
      }
      perSource.push({ api, urls: [...new Set(got)] })
    })
  )
  // 轮转取满 100
  const picked = []
  let idx = 0
  while (picked.length < TARGET && perSource.some((s) => s.urls.length)) {
    const s = perSource[idx % perSource.length]
    const u = s.urls.shift()
    if (u) picked.push({ url: u, api: s.api })
    idx++
  }
  return picked
}

// ---------- 2) 内核测试 ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-multi-'))
const CORE = path.join('apps', 'core', 'target', 'release', 'pf-core.exe')
const child = spawn(CORE, [], { env: { ...process.env, PF_NO_MPV: '1' }, stdio: ['pipe', 'pipe', 'inherit'] })
const boot = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('内核启动超时')), 15000)
  let port = 0, token = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', function onData(d) {
    for (const l of String(d).split('\n')) {
      let m = l.match(/^PF_CORE_PORT=(\d+)\s*$/); if (m) port = +m[1]
      m = l.match(/^PF_CORE_TOKEN=([0-9a-f]+)\s*$/); if (m) token = m[1]
    }
    if (port && token) { child.stdout.off('data', onData); clearTimeout(t); res({ port, token }) }
  })
})
console.log(`[core] port=${boot.port}`)

const sock = net.connect(boot.port, '127.0.0.1')
await new Promise((r) => sock.once('connect', r))
sock.write(`PF_AUTH ${boot.token}\n`)
let buf = ''
const pending = new Map()
sock.on('data', (d) => {
  buf += String(d)
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    try {
      const msg = JSON.parse(line)
      if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
    } catch {}
  }
})
let rpcId = 0
function rpc(method, params, timeoutMs = 95000) {
  const id = `m${++rpcId}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ error: { message: '客户端超时' } }) }, timeoutMs)
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg) })
    sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

async function testOne(item) {
  const t0 = Date.now()
  const r = await rpc('task.create', { url: item.url })
  const ms = Date.now() - t0
  if (r.error) return { ...item, ok: false, ms, err: String(r.error.message).slice(0, 90) }
  const task = r.result?.task
  const playUrl = task?.playUrl ?? r.result?.playUrl
  let verified = false
  try {
    const resp = await fetch(playUrl, { signal: AbortSignal.timeout(15000) })
    const text = await resp.text()
    verified = resp.ok && text.includes('#EXTM3U')
  } catch {}
  if (task?.id) await rpc('task.delete', { id: task.id })
  return { ...item, ok: verified, ms, err: verified ? '' : '代理清单验证失败' }
}

console.log(`开始测试前先采集链接…`)
const collect_res = await collect()
const queue = collect_res
console.log(`采集到 ${collect_res.length} 条，来源分布：`)
const results = []
let cursor = 0
async function worker() {
  while (cursor < queue.length) {
    const item = queue[cursor++]
    process.stdout.write(`  [${results.length + 1}/${queue.length}] ${host(item.url)} … `)
    const res = await testOne(item)
    results.push(res)
    console.log(res.ok ? `✅ ${res.ms}ms` : `❌ ${res.ms}ms ${res.err}`)
  }
}
console.log(`采集到 ${collect_res.length} 条，来源分布：`)
const dist = {}
for (const c of collect_res) dist[host(c.api)] = (dist[host(c.api)] ?? 0) + 1
for (const [h, n] of Object.entries(dist).sort((a, b) => b[1] - a[1])) console.log(`  ${h}: ${n}`)
await Promise.all(Array.from({ length: CONCURRENCY }, worker))

// ---------- 3) 汇总 ----------
child.kill()
fs.rmSync(tmp, { recursive: true, force: true })
const ok = results.filter((r) => r.ok)
const bySrc = {}
for (const r of results) {
  const h = host(r.api)
  bySrc[h] ??= { total: 0, ok: 0, fail: 0, ms: [], errs: [] }
  bySrc[h].total++
  if (r.ok) { bySrc[h].ok++; bySrc[h].ms.push(r.ms) } else { bySrc[h].fail++; bySrc[h].errs.push(r.err) }
}
console.log('\n===== 按源统计 =====')
for (const [h, s] of Object.entries(bySrc).sort((a, b) => b[1].total - a[1].total)) {
  const avg = s.ms.length ? Math.round(s.ms.reduce((a, b) => a + b, 0) / s.ms.length) : '-'
  console.log(`${h}: ${s.ok}/${s.total} 成功, 均 ${avg}ms${s.errs.length ? ', 错误: ' + [...new Set(s.errs)].slice(0, 2).join(' | ') : ''}`)
}
console.log(`\n总计: ${ok.length}/${results.length} 成功`)
fs.writeFileSync('multi-source-result.json', JSON.stringify(results, null, 2))
process.exit(ok.length === results.length ? 0 : 1)
