/**
 * P19 无头冒烟测试：片源内容缓存（src_cache）
 *
 *  A. 搜索缓存：同一关键词第二次不再回源（origin 命中数不变），出参 cache.fromCache=1
 *  B. 详情缓存：同一 vodId 第二次命中缓存
 *  C. 海报缓存：/pic 首次 miss 落盘，二次 x-pf-cache=hit，图床只被打一次
 *  D. 解析直链缓存：二次 resolve 返回 cached=true，解析接口只被打一次
 *  E. TTL 过期 + 源站挂掉 → 回退旧数据（cache.stale=1，卡片仍在）
 *  F. 关闭 offlineFallback → 过期后不再回退，源站失败即报失败
 *  G. 统计：命中/未命中/按类分布有值
 *  H. 按类清空后重新回源
 *  I. 策略读写 + 越界夹取
 *
 * 说明：TTL 用 `PF_SRC_CACHE_TTL_MS=2500` 压成 2.5s（默认按分钟计，无法在冒烟里等）。
 * 全部使用本地假源（CMS / 图床 / 解析接口），不依赖外网。
 * 运行：node apps/core/scripts/smoke-p19.mjs（需先 pnpm core:build）
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import { existsSync, statSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const coreRoot = path.resolve(here, '..')
// 取**最新构建**的那个（release 可能落后于刚改的代码，跑旧二进制会得出假结论）
const binCandidates = [
  path.join(coreRoot, 'target/release/pf-core.exe'),
  path.join(coreRoot, 'target/debug/pf-core.exe')
]
  .filter((p) => existsSync(p))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`  ${ok ? GREEN + 'PASS' : RED + 'FAIL'}${RESET} ${name}${detail ? ` ${DIM}(${detail})${RESET}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 假源：苹果CMS 采集站 + 图床 + 解析接口（fail=true 时全站 503） */
function startOrigin() {
  const state = { fail: false }
  const hits = { list: 0, search: 0, fallback: 0, detail: 0, poster: 0, parse: 0 }
  const VOD = {
    vod_id: 1,
    vod_name: '冒烟影片',
    vod_year: '2026',
    vod_type_name: '电影',
    vod_remarks: '正片',
    vod_pic: '',
    vod_time: '2026-10-28 10:00:00',
    vod_play_from: 'm3u8',
    vod_play_url: '正片$http://127.0.0.1:1/media/ep.m3u8'
  }
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (state.fail) {
      res.writeHead(503).end('down')
      return
    }
    if (u.pathname.endsWith('/api.php/provide/vod')) {
      const ac = u.searchParams.get('ac')
      if (ac === 'list') {
        hits.list++
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ code: 1, page: 1, total: 1, list: [VOD] }))
        return
      }
      if (ac === 'detail' && u.searchParams.get('ids')) {
        hits.detail++
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ code: 1, list: [VOD] }))
        return
      }
      if (ac === 'detail') {
        hits.search++
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ code: 1, list: [{ ...VOD, vod_name: `冒烟影片 ${u.searchParams.get('wd') ?? ''}` }] }))
        return
      }
      if (ac === 'videolist') {
        hits.fallback++
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ code: 1, list: [VOD] }))
        return
      }
    }
    if (u.pathname === '/poster.jpg') {
      hits.poster++
      res.writeHead(200, { 'Content-Type': 'image/jpeg' })
      // JPEG 魔数 + 填充（缓存层按魔数推 content-type）
      res.end(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 7)]))
      return
    }
    if (u.pathname === '/json') {
      hits.parse++
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ code: 200, url: `http://127.0.0.1:1/media/ep.m3u8?t=${hits.parse}` }))
      return
    }
    res.writeHead(404).end()
  })
  let origin = ''
  return {
    hits,
    state,
    start: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          origin = `http://127.0.0.1:${server.address().port}`
          resolve(origin)
        })
      }),
    get origin() {
      return origin
    },
    close: () => new Promise((r) => server.close(r))
  }
}

let rpcToken = ''
function startCore(envOverride = {}) {
  const bin = binCandidates.find((p) => existsSync(p))
  if (!bin) throw new Error('未找到 pf-core.exe，请先执行: pnpm core:build')
  const proc = spawn(bin, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...envOverride, PF_PROXY_ALLOW_PRIVATE: '1' }
  })
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

function connectRpc(port) {
  const socket = net.connect(port, '127.0.0.1')
  socket.write('PF_AUTH ' + rpcToken + '\n')
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
      }, 60000)
      pending.set(id, { resolve, reject, timer })
      socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  return { socket, request }
}

let proc = null
let origin = null
const TTL = 2500

try {
  console.log(`${DIM}启动内核…${RESET}`)
  const first = startCore({
    LOCALAPPDATA: path.join(process.env.TEMP ?? '.', `pf-smoke-p19-${process.pid}`),
    PF_SRC_CACHE_TTL_MS: String(TTL)
  })
  proc = first.proc
  const port = await first.portReady
  const { request } = connectRpc(port)
  const hello = await request('core.hello')
  const proxyBase = `http://127.0.0.1:${hello.proxyPort}/pic/${hello.proxyToken}`

  origin = startOrigin()
  const base = await origin.start()
  const api = `${base}/api.php/provide/vod`

  // ============ 准备：注册源站 ============
  console.log(`\n${DIM}—— A 搜索缓存 ——${RESET}`)
  await request('catalog.source.add', { name: '冒烟源', api })
  const q = '冒烟'
  const s1 = await request('catalog.search', { q })
  const searchHits1 = origin.hits.search
  check('首次搜索回到结果', s1.cards.length === 1, `${s1.cards.length} 张`)
  check('首次未走缓存', s1.cache.fromCache === 0 && s1.cache.stale === 0, JSON.stringify(s1.cache))
  check('首次真实回源', searchHits1 >= 1, `${searchHits1} 次`)

  const s2 = await request('catalog.search', { q })
  check('二次搜索命中缓存', s2.cache.fromCache === 1, JSON.stringify(s2.cache))
  check('二次搜索零回源', origin.hits.search === searchHits1, `${origin.hits.search} 次`)
  check('缓存结果内容一致', s2.cards.length === 1 && s2.cards[0].name === s1.cards[0].name)
  check('出参带缓存写入时刻', typeof s2.cache.oldestMs === 'number')

  // ============ B 详情缓存 ============
  console.log(`\n${DIM}—— B 详情缓存 ——${RESET}`)
  const d1 = await request('catalog.detail', { api, vodId: '1' })
  const detailHits = origin.hits.detail
  const d2 = await request('catalog.detail', { api, vodId: '1' })
  check('首次详情回源', detailHits >= 1 && d1.cache.fromCache === 0, `${detailHits} 次`)
  check('二次详情命中缓存', d2.cache.fromCache === 1, JSON.stringify(d2.cache))
  check('二次详情零回源', origin.hits.detail === detailHits)
  check('详情剧集仍在', (d2.detail.groups?.[0]?.episodes ?? []).length === 1)

  // ============ C 海报缓存 ============
  console.log(`\n${DIM}—— C 海报缓存 ——${RESET}`)
  const posterUrl = `${proxyBase}?u=${encodeURIComponent(`${base}/poster.jpg`)}`
  const p1 = await fetch(posterUrl)
  const b1 = await p1.arrayBuffer()
  const p2 = await fetch(posterUrl)
  const b2 = await p2.arrayBuffer()
  check('首次海报回源', p1.headers.get('x-pf-cache') === 'miss', p1.headers.get('x-pf-cache'))
  check('二次海报命中缓存', p2.headers.get('x-pf-cache') === 'hit', p2.headers.get('x-pf-cache'))
  check('图床只被打一次', origin.hits.poster === 1, `${origin.hits.poster} 次`)
  check('缓存字节与回源一致', b1.byteLength === b2.byteLength && b1.byteLength > 600, `${b2.byteLength}B`)
  check('按魔数还原 content-type', (p2.headers.get('content-type') ?? '').includes('image/jpeg'))

  // ============ D 解析直链缓存 ============
  console.log(`\n${DIM}—— D 解析直链缓存 ——${RESET}`)
  const page = 'https://v.qq.com/x/cover/p19.html'
  const r1 = await request('parse.resolve', { url: page, api: `${base}/json?url=` })
  const parseHits = origin.hits.parse
  const r2 = await request('parse.resolve', { url: page, api: `${base}/json?url=` })
  check('首次解析未命中缓存', r1.kind === 'direct' && r1.cached === false, `${r1.kind}/${r1.cached}`)
  check('二次解析命中直链缓存', r2.kind === 'direct' && r2.cached === true, `${r2.kind}/${r2.cached}`)
  check('via=cache', r2.via === 'cache', r2.via)
  check('解析接口只被打一次', origin.hits.parse === parseHits, `${origin.hits.parse} 次`)
  check('命中时回显缓存时刻', typeof r2.cachedAtMs === 'number')

  // ============ E 过期 + 源站挂掉 → 回退旧值 ============
  console.log(`\n${DIM}—— E 过期回退 ——${RESET}`)
  origin.state.fail = true
  await sleep(TTL + 400)
  const s3 = await request('catalog.search', { q })
  check('源站不可达仍给出旧数据', s3.cards.length === 1, `${s3.cards.length} 张`)
  check('标注为回退旧值', s3.cache.stale === 1, JSON.stringify(s3.cache))
  const d3 = await request('catalog.detail', { api, vodId: '1' }).catch((e) => ({ err: e.message }))
  check('详情同样回退旧值', d3.cache?.stale === 1, JSON.stringify(d3.cache ?? d3))

  // ============ F 关闭回退 ============
  console.log(`\n${DIM}—— F 关闭 offlineFallback ——${RESET}`)
  const pv = await request('config.set_src_cache_policy', { offlineFallback: false })
  check('回退开关已落库', pv.policy.offlineFallback === false)
  await sleep(TTL + 400)
  const s4 = await request('catalog.search', { q })
  check('关闭回退后不再给旧值', s4.cards.length === 0, `${s4.cards.length} 张`)
  check('失败源站计数正确', s4.cache.failed === 1, JSON.stringify(s4.cache))
  await request('config.set_src_cache_policy', { offlineFallback: true })

  // ============ G 统计 ============
  console.log(`\n${DIM}—— G 缓存统计 ——${RESET}`)
  const st = await request('cache.src_stats')
  const kinds = st.stats.kinds.map((k) => k.kind)
  check('统计有占用', st.stats.entries > 0 && st.stats.bytes > 0, `${st.stats.entries} 条 / ${st.stats.bytes}B`)
  check('按类分布覆盖 search/detail/poster/parselink', ['search', 'detail', 'poster', 'parselink'].every((k) => kinds.includes(k)), kinds.join(','))
  check('命中与未命中都有计数', st.stats.hits > 0 && st.stats.misses > 0, `hits=${st.stats.hits} misses=${st.stats.misses}`)
  check('回退次数已记账', st.stats.staleServed >= 1, `${st.stats.staleServed}`)

  // ============ H 按类清空 ============
  console.log(`\n${DIM}—— H 按类清空 ——${RESET}`)
  origin.state.fail = false
  const cl = await request('cache.src_clear', { kind: 'search' })
  check('清空 search 类', cl.removed >= 1 && cl.freedBytes > 0, `${cl.removed} 条 / ${cl.freedBytes}B`)
  const before = origin.hits.search
  const s5 = await request('catalog.search', { q })
  check('清空后重新回源', origin.hits.search > before && s5.cache.fromCache === 0, `${origin.hits.search} 次`)
  const st2 = await request('cache.src_stats')
  check('统计里 search 条目回落', (st2.stats.kinds.find((k) => k.kind === 'search')?.entries ?? 0) <= 1)

  // ============ I 策略读写 ============
  console.log(`\n${DIM}—— I 策略读写 ——${RESET}`)
  const sv = await request('config.set_src_cache_policy', {
    ttlSearchMin: 20,
    ttlPosterDays: 30,
    capacityMb: 128,
    ttlParseMin: 5
  })
  check('保存后回显新值', sv.policy.ttlSearchMin === 20 && sv.policy.capacityMb === 128 && sv.policy.ttlPosterDays === 30)
  const gv = await request('config.get_src_cache_policy')
  check('读取与写入一致', gv.policy.ttlSearchMin === 20 && gv.policy.ttlParseMin === 5)
  const bad = await request('config.set_src_cache_policy', { ttlSearchMin: 1, capacityMb: 0 })
  check('越界入参被夹取', bad.policy.ttlSearchMin === 2 && bad.policy.capacityMb === 8, `ttl=${bad.policy.ttlSearchMin} cap=${bad.policy.capacityMb}`)

  // ============ J 删源站连带失效 ============
  console.log(`\n${DIM}—— J 删源站连带失效 ——${RESET}`)
  const srcs = await request('catalog.source.list')
  const sid = srcs.sources.find((s) => s.api === api)?.id
  await request('cache.src_clear', {})
  await request('catalog.search', { q })
  await request('catalog.source.remove', { id: sid })
  const st3 = await request('cache.src_stats')
  const searchEntries = st3.stats.kinds.find((k) => k.kind === 'search')?.entries ?? 0
  check('删源站后其名下搜索缓存被清', searchEntries === 0, `${searchEntries} 条`)
} catch (e) {
  check('冒烟执行未抛异常', false, e.message)
} finally {
  try {
    origin?.close()
  } catch {
    /* ignore */
  }
  try {
    proc?.kill()
  } catch {
    /* ignore */
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length ? RED : GREEN}P19 片源缓存冒烟：${results.length - failed.length}/${results.length}${RESET}`)
if (failed.length) {
  console.log(failed.map((f) => ` - ${f.name}`).join('\n'))
  process.exitCode = 1
}
