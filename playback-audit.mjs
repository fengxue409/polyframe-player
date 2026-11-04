#!/usr/bin/env node
/**
 * 播放全链路审计（P21 排障用）
 *
 * 与 multi-source-test.mjs 的区别：那个只验证「代理清单 200 + EXTM3U」，
 * 本脚本按真实播放器行为逐级下钻，任一层失败都判失败：
 *
 *   清单层：playUrl 200 + EXTM3U + EXTINF 非 0 时长 + 分片数 > 0（HTML 伪清单会死在这）
 *   分片层：随机取 3 个分片真实 GET，要求 200/206 且字节数 > 0
 *   密钥层：有 EXT-X-KEY(METHOD≠NONE) 时 /key 必须 200 且 16 字节
 *   mpv 层：masterUrl（桌面端 mpv 内核唯一入口）必须非 5xx 且可解析
 *
 * 用例分四组：
 *   A 链接类型矩阵（固定公开流 + 负例）
 *   B 真实 CMS 点击路径（catalog.category → detail → 集数 URL → task.create，与 UI 一致）
 *   C 连点风暴（模拟「随意点几个视频」，每 250ms 发一个 create，创建后统一验证）
 *   D 同一 URL 重入（双击 / 断点续播复用）
 *
 * 用法：node playback-audit.mjs [--sources 8] [--per-source 2] [--storm 12] [--keep]
 */
import { spawn } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`)
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d
}
const N_SOURCES = arg('sources', 8)
const PER_SOURCE = arg('per-source', 2)
const STORM_N = arg('storm', 12)
const KEEP = process.argv.includes('--keep')
/** --no-proxy：剥掉环境代理，模拟「打包版在纯净网络下直连」的行为 */
const NO_PROXY = process.argv.includes('--no-proxy')
/** 只跑指定组（逗号分隔 A/B/C/D），默认全跑 */
const ONLY = (() => {
  const i = process.argv.indexOf('--only')
  const v = i >= 0 ? process.argv[i + 1] : ''
  return v ? new Set(v.toUpperCase().split(',')) : null
})()
const want = (g) => !ONLY || ONLY.has(g)

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

// ---------------- A 组：链接类型矩阵 ----------------
const TYPE_CASES = [
  {
    id: 'hls-media',
    label: 'HLS 单码率 media playlist',
    url: 'https://sf1-cdn-tos.huoshanstatic.com/obj/media-fe/xgplayer_doc_video/hls/xgplayer-demo.m3u8',
    expect: 'ok'
  },
  {
    id: 'hls-master-mux',
    label: 'HLS master（多码率 variant）',
    url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
    expect: 'ok'
  },
  {
    id: 'hls-master-audio',
    label: 'HLS master + 独立音轨（EXT-X-MEDIA）',
    url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/bipbop_16x9_variant.m3u8',
    expect: 'ok'
  },
  {
    id: 'mp4-aliyun',
    label: 'MP4 直链（146MB，CDN）',
    url: 'https://player.alicdn.com/video/aliyunmedia.mp4',
    expect: 'ok'
  },
  {
    id: 'mp4-tencent',
    label: 'MP4 直链（腾讯云点播）',
    url: 'https://200024424.vod.myqcloud.com/200024424_709ae516bdf811e6ad39991f76a4df69.f20.mp4',
    expect: 'ok'
  },
  {
    id: 'neg-html-page',
    label: '负例：HTML 播放页（非媒体）',
    url: 'https://www.w3schools.com/html/html5_video.asp',
    expect: 'fail'
  },
  {
    id: 'neg-dead-host',
    label: '负例：不可达域名',
    url: 'https://no-such-host.polyframe-test.invalid/video/index.m3u8',
    expect: 'fail'
  }
]

// ---------------- 内核启动 ----------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-audit-'))
const CORE = path.join('apps', 'core', 'target', 'release', 'pf-core.exe')
if (!fs.existsSync(CORE)) {
  console.error(`内核不存在：${CORE}（先 cargo build --release）`)
  process.exit(2)
}
// 数据根目录 = %LOCALAPPDATA%/PolyFrame（内核写死），因此用 LOCALAPPDATA 重定向做隔离，
// 避免污染本机真实片源库/缓存；内核首次启动会自动播种 18 个出厂源站。
const spawnEnv = { ...process.env, PF_NO_MPV: '1', LOCALAPPDATA: tmp }
if (NO_PROXY) {
  for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY'])
    delete spawnEnv[k]
}
const child = spawn(CORE, [], { env: spawnEnv, stdio: ['pipe', 'pipe', 'pipe'] })
child.stderr.setEncoding('utf8')
child.stderr.on('data', (d) => {
  const s = String(d).trim()
  if (s) logs.push({ level: 'stderr', message: s })
})

const logs = []
const boot = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('内核启动超时')), 20000)
  let port = 0
  let token = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', function onData(d) {
    for (const l of String(d).split('\n')) {
      let m = l.match(/^PF_CORE_PORT=(\d+)\s*$/)
      if (m) port = +m[1]
      m = l.match(/^PF_CORE_TOKEN=([0-9a-f]+)\s*$/)
      if (m) token = m[1]
    }
    if (port && token) {
      child.stdout.off('data', onData)
      clearTimeout(t)
      res({ port, token })
    }
  })
})
console.log(`[core] port=${boot.port} data=${tmp}`)

const sock = net.connect(boot.port, '127.0.0.1')
await new Promise((r) => sock.once('connect', r))
sock.write(`PF_AUTH ${boot.token}\n`)
let buf = ''
const pending = new Map()
sock.on('data', (d) => {
  buf += String(d)
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    try {
      const msg = JSON.parse(line)
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      } else if (msg.method === 'core.log') {
        logs.push({ level: msg.params?.level, message: msg.params?.message, ts: msg.params?.ts })
      }
    } catch {
      /* 忽略非 JSON 行 */
    }
  }
})
let rpcId = 0
function rpc(method, params, timeoutMs = 90000) {
  const id = `a${++rpcId}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ error: { message: `客户端超时 ${timeoutMs}ms` } })
    }, timeoutMs)
    pending.set(id, (msg) => {
      clearTimeout(timer)
      resolve(msg)
    })
    sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}
const logMark = () => logs.length
function logsSince(n) {
  return logs
    .slice(n)
    .filter((l) => l.level === 'warn' || l.level === 'error')
    .map((l) => `[${l.level}] ${l.message}`)
    .slice(-6)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------- 播放验证器 ----------------
const pick = (arr, n) => [...arr].sort(() => Math.random() - 0.5).slice(0, n)

async function httpGet(url, { range, timeout = 20000, keepText = false } = {}) {
  const t0 = Date.now()
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, ...(range ? { Range: range } : {}) },
      signal: AbortSignal.timeout(timeout),
      redirect: 'follow'
    })
    const ab = await r.arrayBuffer()
    const buf = Buffer.from(ab)
    return {
      ok: r.ok,
      status: r.status,
      ct: r.headers.get('content-type') ?? '',
      cl: Number(r.headers.get('content-length') ?? 0),
      bytes: buf.byteLength,
      // 清单可能上百 KB（4469 分片 ≈ 365KB），必须整份判断，不能按大小丢弃；
      // 只对「非文本」类响应（分片二进制）省钱。
      text: keepText || buf.byteLength < 2_000_000 ? buf.toString('utf8') : '',
      head: buf.subarray(0, 8).toString('hex'),
      sniff: buf.byteLength ? sniffSegment(buf) : 'empty',
      ms: Date.now() - t0
    }
  } catch (e) {
    return { ok: false, status: 0, err: String(e.message ?? e).slice(0, 120), bytes: 0, ms: Date.now() - t0 }
  }
}

/** 分片内容自检：TS 同步字节 0x47 / fMP4 box / 明显是 HTML 错误页 */
function sniffSegment(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  if (b.length === 0) return 'empty'
  if (b[0] === 0x47) return 'ts'
  const head = b.subarray(0, 16).toString('latin1')
  if (head.includes('ftyp') || head.includes('styp') || head.includes('moof')) return 'fmp4'
  const txt = b.subarray(0, 64).toString('utf8').trim().toLowerCase()
  if (txt.startsWith('<')) return 'html'
  if (txt.startsWith('{')) return 'json'
  return 'unknown'
}

/**
 * 全链路验证一个任务。
 * @returns {ok, stage, reason, details}
 */
async function verifyTask(task) {
  const d = { taskId: task?.id, proto: task?.protocol, status: task?.status }
  if (!task) return { ok: false, stage: 'create', reason: '未返回 task' }
  if (!task.playUrl && !task.play_url) return { ok: false, stage: 'create', reason: 'task 无 playUrl' }

  const playUrl = task.playUrl ?? task.play_url
  const masterUrl = task.masterUrl ?? task.master_url
  const proto = String(task.protocol ?? d.proto ?? '')

  // MP4：Range 取首块
  if (proto.toLowerCase() === 'mp4' || playUrl.includes('/file/')) {
    const r = await httpGet(playUrl, { range: 'bytes=0-65535' })
    d.firstBlock = { status: r.status, bytes: r.bytes, ct: r.ct }
    if (!r.ok) return { ok: false, stage: 'file', reason: `MP4 首块 HTTP ${r.status} ${r.err ?? ''}`, details: d }
    if (r.bytes < 1024) return { ok: false, stage: 'file', reason: `MP4 首块仅 ${r.bytes}B`, details: d }
    return { ok: true, stage: 'file', details: d }
  }

  // HLS：清单
  const pl = await httpGet(playUrl, { keepText: true })
  d.playlist = { status: pl.status, bytes: pl.bytes, ms: pl.ms }
  if (!pl.ok) return { ok: false, stage: 'playlist', reason: `清单 HTTP ${pl.status} ${pl.err ?? ''}`, details: d }
  const text = pl.text ?? ''
  if (!text.includes('#EXTM3U'))
    return {
      ok: false,
      stage: 'playlist',
      reason: `清单非 m3u8（${pl.bytes}B，前 60 字节：${text.slice(0, 60).replace(/\s+/g, ' ') || pl.head}）`,
      details: d
    }
  const infs = [...text.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]))
  const segs = [...text.matchAll(/^(?!#)(\S+)$/gm)].map((m) => m[1]).filter((u) => !u.startsWith('#'))
  d.segments = segs.length
  d.durations = { count: infs.length, zero: infs.filter((v) => v <= 0).length, max: Math.max(0, ...infs) }
  if (segs.length === 0) return { ok: false, stage: 'playlist', reason: '清单内 0 个分片', details: d }
  if (infs.length > 0 && infs.every((v) => v <= 0))
    return { ok: false, stage: 'playlist', reason: `全部 ${infs.length} 个 EXTINF 时长为 0（伪清单/HTML 误判）`, details: d }

  // 密钥：EXT-X-KEY(METHOD≠NONE)
  const keyUris = [...text.matchAll(/#EXT-X-KEY:([^\n]+)/g)]
    .map((m) => m[1])
    .filter((a) => !/METHOD=NONE/i.test(a))
    .map((a) => (a.match(/URI="([^"]+)"/) ?? [])[1])
    .filter(Boolean)
  if (keyUris.length) {
    const k = await httpGet(keyUris[0])
    d.key = { status: k.status, bytes: k.bytes }
    if (!k.ok || k.bytes === 0)
      return { ok: false, stage: 'key', reason: `密钥 HTTP ${k.status} bytes=${k.bytes}`, details: d }
  }

  // 分片：随机 3 个
  const sample = pick(segs, Math.min(3, segs.length))
  const segResults = []
  for (const u of sample) {
    const abs = u.startsWith('http') ? u : new URL(u, playUrl).toString()
    const s = await httpGet(abs)
    const kind = s.sniff ?? 'unknown'
    segResults.push({ status: s.status, bytes: s.bytes, ct: s.ct, ms: s.ms, kind })
    if (!s.ok) return { ok: false, stage: 'segment', reason: `分片 HTTP ${s.status} ${s.err ?? ''}`, details: { ...d, segResults } }
    if (s.bytes < 256)
      return { ok: false, stage: 'segment', reason: `分片仅 ${s.bytes}B（空分片/错误页）`, details: { ...d, segResults } }
    if (kind === 'html' || kind === 'json')
      return { ok: false, stage: 'segment', reason: `分片返回 ${kind}（非媒体数据，通常是防盗链/WAF 拦截页）`, details: { ...d, segResults } }
  }
  d.segResults = segResults

  // mpv 入口（桌面端 mpv 内核唯一入口，走的是实时回源透传）
  if (masterUrl) {
    const m = await httpGet(masterUrl)
    const mt = m.text ?? ''
    d.master = { status: m.status, bytes: m.bytes, variants: (mt.match(/#EXT-X-STREAM-INF/g) ?? []).length, ms: m.ms }
    if (!m.ok)
      return { ok: false, stage: 'master', reason: `masterUrl HTTP ${m.status}（mpv 内核无法起播）`, details: d }
    if (!mt.includes('#EXTM3U'))
      return { ok: false, stage: 'master', reason: `masterUrl 非 m3u8（前 60 字节：${mt.slice(0, 60).replace(/\s+/g, ' ')}）`, details: d }
  }
  return { ok: true, stage: 'ok', details: d }
}

async function createAndVerify(url, title) {
  const t0 = Date.now()
  const r = await rpc('task.create', { url, title, cacheMode: 'stream' }, 75000)
  const createMs = Date.now() - t0
  if (r.error) {
    return {
      ok: false,
      stage: 'create',
      reason: String(r.error.message).replace(/^create task failed:\s*/, '').slice(0, 200),
      createMs
    }
  }
  const task = r.result?.task
  const v = await verifyTask(task)
  return { ...v, createMs, taskId: task?.id, playUrl: task?.playUrl, protocol: task?.protocol }
}

// ---------------- 源站播种 ----------------
/** 内核首次启动已自动播种出厂源站，这里只按需补「预设库里缺的」并返回启用源 */
async function seedSources(n) {
  const pre = await rpc('catalog.source.presets', {})
  const missing = (pre.result?.presets ?? []).filter((p) => !p.installed)
  for (const p of missing.slice(0, Math.max(0, n))) {
    const r = await rpc('catalog.source.add', { name: p.name, api: p.api }, 30000)
    if (r.error) console.log(`  [源站探测失败] ${p.name}: ${String(r.error.message).slice(0, 70)}`)
  }
  const list = await rpc('catalog.source.list', {})
  return (list.result?.sources ?? []).filter((s) => s.enabled !== false).slice(0, n)
}

// ---------------- 报告 ----------------
const report = {
  startedAt: new Date().toISOString(),
  env: { core: CORE, dataDir: tmp, node: process.version, proxy: NO_PROXY ? 'disabled' : process.env.HTTPS_PROXY || process.env.https_proxy || 'none' },
  groups: { A: [], B: [], C: [], D: [] }
}
const tag = (s) => (s ? '✅' : '❌')
function printCase(c) {
  const head = `${tag(c.ok)} [${c.id}] ${c.label}${c.createMs != null ? `  create ${c.createMs}ms` : ''}`
  console.log(head)
  if (!c.ok) {
    console.log(`    ↳ 失败层=${c.stage} 现象=${c.reason}`)
    if (c.details) console.log(`    ↳ 细节 ${JSON.stringify(c.details).slice(0, 400)}`)
    if (c.upstream?.length) for (const l of c.upstream) console.log(`    ↳ 内核 ${l}`)
  }
}

// ================= A 组 =================
if (want('A')) {
  console.log('\n===== A 组：链接类型矩阵 =====')
  for (const c of TYPE_CASES) {
    const m0 = logMark()
    const r = await createAndVerify(c.url, c.label)
    const ok = c.expect === 'ok' ? r.ok : !r.ok // 负例：预期失败
    const item = {
      id: c.id,
      label: c.label,
      url: c.url,
      expect: c.expect,
      ok,
      verdict: c.expect === 'ok' ? (r.ok ? '可播放' : '不可播放') : r.ok ? '未拦截（预期应失败）' : '已正确拒绝',
      stage: r.stage,
      reason: r.reason ?? '',
      createMs: r.createMs,
      details: r.details,
      upstream: r.ok ? [] : logsSince(m0)
    }
    report.groups.A.push(item)
    printCase(item)
    if (r.taskId) await rpc('task.delete', { taskId: r.taskId })
  }
}

// ================= B 组 =================
const realPlayable = []
if (want('B')) {
console.log(`\n===== B 组：真实 CMS 点击路径（${N_SOURCES} 源 × ${PER_SOURCE} 片）=====`)
const sources = await seedSources(N_SOURCES)
console.log(`已播种源站 ${sources.length} 个`)

for (const s of sources) {
  const m0 = logMark()
  // 与首页一致：分类流（热门/更新）
  const cat = await rpc(
    'catalog.category',
    { category: '', pg: 1 + Math.floor(Math.random() * 5), sort: Math.random() < 0.5 ? 'hot' : 'time' },
    60000
  )
  if (cat.error) {
    const item = { id: `B-${s.name}`, label: `${s.name} 分类流`, ok: false, stage: 'catalog', reason: String(cat.error.message).slice(0, 160), upstream: logsSince(m0) }
    report.groups.B.push(item)
    printCase(item)
    continue
  }
  const cards = (cat.result?.cards ?? []).filter((c) => c.entries?.length)
  for (const card of pick(cards, PER_SOURCE)) {
    const e = card.entries[0]
    const dm = logMark()
    const det = await rpc('catalog.detail', { api: e.api, vodId: e.vodId, sourceId: e.sourceId }, 60000)
    if (det.error) {
      const item = { id: `B-${s.name}-${card.name}`, label: `《${card.name}》详情`, ok: false, stage: 'detail', reason: String(det.error.message).slice(0, 160), upstream: logsSince(dm) }
      report.groups.B.push(item)
      printCase(item)
      continue
    }
    const groups = det.result?.detail?.groups ?? []
    const group = groups.find((g) => g.episodes?.length) ?? groups[0]
    const eps = group?.episodes ?? []
    if (!eps.length) {
      const item = { id: `B-${s.name}-${card.name}`, label: `《${card.name}》集数`, ok: false, stage: 'detail', reason: `无可用集数（groups=${groups.length}）`, upstream: logsSince(dm) }
      report.groups.B.push(item)
      printCase(item)
      continue
    }
    // 取首集 + 中间一集（首集常在 CDN 预热，中间集更能暴露问题）
    const targets = [eps[0], eps[Math.floor(eps.length / 2)]].filter((v, i, a) => v && a.findIndex((x) => x.url === v.url) === i)
    for (const ep of targets) {
      const m1 = logMark()
      const r = await createAndVerify(ep.url, `${card.name} · ${ep.name}`)
      const item = {
        id: `B-${s.name}-${card.name}-${ep.name}`,
        label: `《${card.name}》${ep.name}（${group.from}，共${eps.length}集）`,
        url: ep.url,
        source: s.name,
        ok: r.ok,
        stage: r.stage,
        reason: r.reason ?? '',
        createMs: r.createMs,
        protocol: r.protocol,
        details: r.details,
        upstream: r.ok ? [] : logsSince(m1)
      }
      report.groups.B.push(item)
      printCase(item)
      if (r.ok) realPlayable.push({ url: ep.url, title: `${card.name} · ${ep.name}` })
      if (r.taskId) await rpc('task.delete', { taskId: r.taskId })
    }
  }
}
}

// ================= C 组：连点风暴 =================
console.log(`\n===== C 组：连点风暴（${STORM_N} 次，间隔 250ms）=====`)
const pool = realPlayable.length >= 4 ? realPlayable : TYPE_CASES.filter((c) => c.expect === 'ok').map((c) => ({ url: c.url, title: c.label }))
const stormTargets = []
for (let i = 0; i < STORM_N; i++) stormTargets.push(pool[i % pool.length])

const stormCreated = []
for (let i = 0; i < stormTargets.length; i++) {
  const t = stormTargets[i]
  const t0 = Date.now()
  // 不 await：用户连点时前端是「发一个、不等回包就点下一个」
  stormCreated.push({
    idx: i,
    ...t,
    promise: rpc('task.create', { url: t.url, title: t.title, cacheMode: 'stream' }, 90000).then((r) => ({ r, ms: Date.now() - t0 }))
  })
  await sleep(250)
}
const stormResults = []
for (const c of stormCreated) {
  const { r, ms } = await c.promise
  const item = { id: `C-${c.idx}`, label: `连点 #${c.idx + 1} ${c.title.slice(0, 28)}`, url: c.url, createMs: ms }
  if (r.error) {
    Object.assign(item, { ok: false, stage: 'create', reason: String(r.error.message).slice(0, 180) })
  } else {
    const v = await verifyTask(r.result?.task)
    Object.assign(item, { ok: v.ok, stage: v.stage, reason: v.reason ?? '', details: v.details, taskId: r.result?.task?.id })
  }
  stormResults.push(item)
  printCase(item)
}
report.groups.C = stormResults
// 5s 后复验（模拟起播/首帧解码窗口），确认不是「创建时能取、真播时已失效」
await sleep(5000)
let recheckFail = 0
for (const it of stormResults) {
  if (!it.ok || !it.taskId) continue
  const t = await rpc('task.list', {})
  const task = (t.result?.tasks ?? []).find((x) => x.id === it.taskId)
  const v = await verifyTask(task)
  if (!v.ok) {
    recheckFail++
    it.recheckFail = { stage: v.stage, reason: v.reason }
    console.log(`    ⚠ 复验失败 #${it.id} ${v.stage} ${v.reason}`)
  }
}
report.groups.C.recheckFail = recheckFail
console.log(`  C 组复验（+5s）：${stormResults.filter((x) => x.ok).length - recheckFail}/${stormResults.length} 仍可播放`)

// ================= D 组：同 URL 重入 =================
console.log('\n===== D 组：同一 URL 重入（双击/续播复用）=====')
const dTarget = pool[0]
const dReport = { id: 'D-dup', label: `双击同一集：${dTarget.title.slice(0, 30)}`, url: dTarget.url }
{
  const [r1, r2] = await Promise.all([
    rpc('task.create', { url: dTarget.url, title: dTarget.title, cacheMode: 'stream' }, 90000),
    rpc('task.create', { url: dTarget.url, title: dTarget.title, cacheMode: 'stream' }, 90000)
  ])
  const ok1 = !r1.error
  const ok2 = !r2.error
  const sameId = r1.result?.task?.id && r1.result?.task?.id === r2.result?.task?.id
  const v = ok1 ? await verifyTask(r1.result.task) : { ok: false, stage: 'create', reason: String(r1.error?.message) }
  Object.assign(dReport, {
    ok: ok1 && ok2 && v.ok,
    stage: v.stage,
    reason: [ok1 ? '' : `第1次失败 ${r1.error?.message}`, ok2 ? '' : `第2次失败 ${r2.error?.message}`, sameId ? '' : '两次返回不同 taskId（未复用）']
      .filter(Boolean)
      .join('；'),
    details: { sameTask: !!sameId, t1: r1.result?.task?.id, t2: r2.result?.task?.id, verify: v.details }
  })
}
report.groups.D.push(dReport)
printCase(dReport)
for (const it of [...report.groups.C, dReport]) if (it.taskId) await rpc('task.delete', { taskId: it.taskId })

// ================= 汇总 =================
const flat = [...report.groups.A, ...report.groups.B, ...report.groups.C, ...report.groups.D]
const positives = flat.filter((x) => x.expect !== 'fail')
const okCount = flat.filter((x) => x.ok).length
report.summary = {
  total: flat.length,
  ok: okCount,
  fail: flat.length - okCount,
  byStage: flat.filter((x) => !x.ok).reduce((m, x) => ((m[x.stage] = (m[x.stage] ?? 0) + 1), m), {})
}

console.log('\n===== 汇总 =====')
console.log(`用例 ${flat.length} 条：可播放 ${okCount}，不可播放 ${flat.length - okCount}（正例 ${positives.length}）`)
console.log('失败分层：', JSON.stringify(report.summary.byStage))
const fails = flat.filter((x) => !x.ok && x.expect !== 'fail')
if (fails.length) {
  console.log('\n失败清单：')
  for (const f of fails) console.log(`  · [${f.stage}] ${f.label}\n      ${f.reason}\n      ${f.url ?? ''}`)
}
fs.writeFileSync('playback-audit.json', JSON.stringify(report, null, 2))
console.log('\n报告：playback-audit.json')

child.kill()
if (!KEEP) fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fails.length ? 1 : 0)
