/**
 * P2 无头冒烟测试：验证 Rust 内核 RPC + 多源聚合 + 本地代理边下边播
 *  1. 启动 pf-core（release 优先，其次 debug）
 *  2. stdout 端口发现（PF_CORE_PORT / PF_PROXY_PORT）
 *  3. RPC：core.ping / core.hello / task.create（含 playUrl + sources）/ task.list / -32601
 *  4. 代理链路：GET playUrl（重写 playlist 含 /seg）→ GET 首个 /seg（200 + 字节）
 *  5. 下载进度：轮询 task.list 直到 segDone >= 3
 *  6. 断点续传：kill 内核 → 重启 → 同 URL 重建任务 → 进度立即 >= kill 前
 *  7. P2 多源容错：本地双源 origin（主源健康 / 镜像 404）→ 任务照常起播，镜像被熔断剔除
 *  8. P2 AES-128：本地加密分片 + key → 代理 playlist 输出 METHOD=NONE、/seg 返回明文
 *  9. P2.5 online：cacheMode=online → 引擎不预取（segDone=0）且缓存目录无 .bin；
 *     /seg 纯实时回源可用；task.set_cache_mode → stream 后引擎恢复调度开始落盘
 * 10. P2.5 precache：cacheMode=precache → 播放头未动也全量预取（segDone == segTotal）
 *
 * 运行：pnpm smoke
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import crypto from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const coreRoot = path.resolve(here, '..') // apps/core
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const TEST_URL =
  'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/bipbop_16x9_variant.m3u8'

const httpGet = (url) =>
  new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 15000 }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
    })
    req.on('timeout', () => req.destroy(new Error('http 超时')))
    req.on('error', reject)
  })

/**
 * P2 本地测试 origin：单码率 HLS（可 AES-128 加密），便于确定性验证多源/解密
 *  opts.segs     明文分片数组
 *  opts.key/iv   提供时启用 AES-128-CBC 加密（PKCS7，对齐 Rust cbc::cipher）
 *  opts.failSegs 分片全部返回 404（playlist 正常，用于模拟主源故障）
 */
function startLocalOrigin(opts) {
  const state = { segHits: 0, seg404: 0 }
  const origin = http.createServer((req, res) => {
    const p = (req.url || '/').split('?')[0]
    if (p.endsWith('/master.m3u8')) {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
      res.end(['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360', 'media.m3u8', ''].join('\n'))
      return
    }
    if (p.endsWith('/media.m3u8')) {
      const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0']
      if (opts.key) lines.push(`#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV="0x${opts.iv.toString('hex')}"`)
      opts.segs.forEach((_, i) => lines.push('#EXTINF:4.000000,', `seg${i}.ts`))
      lines.push('#EXT-X-ENDLIST', '')
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
      res.end(lines.join('\n'))
      return
    }
    if (p.endsWith('/key.bin')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(opts.key)
      return
    }
    const m = p.match(/seg(\d+)\.ts$/)
    if (m) {
      const i = Number(m[1])
      if (opts.failSegs) {
        state.seg404++
        res.writeHead(404)
        res.end('not found')
        return
      }
      let body = opts.segs[i]
      if (opts.key && opts.iv) {
        const cipher = crypto.createCipheriv('aes-128-cbc', opts.key, opts.iv)
        body = Buffer.concat([cipher.update(opts.segs[i]), cipher.final()])
      }
      state.segHits++
      res.writeHead(200, { 'content-type': 'video/mp2t' })
      res.end(body)
      return
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve) => {
    origin.listen(0, '127.0.0.1', () => resolve({ server: origin, port: origin.address().port, state }))
  })
}

/** 启动内核并等待端口发现（envOverride 用于隔离 LOCALAPPDATA 数据目录） */
function startCore(envOverride = {}) {
  const bin = binCandidates.find((p) => existsSync(p))
  if (!bin) throw new Error('未找到 pf-core.exe，请先执行: pnpm core:build')
  const proc = spawn(bin, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...envOverride, PF_PROXY_ALLOW_PRIVATE: '1' } // M5/L1：本地测试源需放开私网目标
  })
  const portReady = new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error('等待 PF_CORE_PORT 超时')), 15000)
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

/** 连接 RPC 并返回 { request, notifications, socket } */
let rpcToken = '' // H2：pf-core stdout 端口发现一并下发的连接鉴权 token
async function connectRpc(port) {
  const socket = net.connect(port, '127.0.0.1')
  socket.write('PF_AUTH ' + rpcToken + '\n') // H2 连接鉴权（首行）
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  socket.setNoDelay(true)
  const notifications = []
  const pending = new Map()
  let lineBuf = ''
  let nextId = 1
  socket.on('data', (d) => {
    lineBuf += d.toString()
    let idx
    while ((idx = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, idx).trim()
      lineBuf = lineBuf.slice(idx + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.method) {
        notifications.push(msg)
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
      }, 15000)
      pending.set(id, { resolve, reject, timer })
      socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  return { socket, request, notifications }
}

let proc = null
let socket = null
let request = null
let notifications = null
let segDoneBeforeKill = 0
const extraProcs = [] // P2 轮次的临时内核实例

try {
  // ================= 第一轮：创建任务 + 代理链路 =================
  // 独立数据目录：冒烟全程 hermetic，不受本机历史任务污染（断点续传依赖同目录持久化）
  const tmpMain = path.join(process.env.TEMP ?? '.', `pf-smoke-main-${process.pid}`)
  const bin = binCandidates.find((p) => existsSync(p))
  console.log(`${DIM}启动内核: ${bin}${RESET}`)
  const first = startCore({ LOCALAPPDATA: tmpMain })
  proc = first.proc
  const port = await first.portReady
  console.log(`${DIM}RPC 端口: ${port}${RESET}`)
  ;({ socket, request, notifications } = await connectRpc(port))

  // ---------- RPC 基础 ----------
  const ping = await request('core.ping')
  check('core.ping', ping?.pong === true && typeof ping?.ts === 'number')

  const hello = await request('core.hello')
  check(
    'core.hello',
    hello?.name === 'polyframe-core' && hello?.protocolVersion === 1 && hello?.proxyPort > 0,
    `proxyPort=${hello?.proxyPort}`
  )

  // ---------- task.create 返回 playUrl ----------
  const create = await request('task.create', { url: TEST_URL, title: '冒烟测试' })
  const task = create?.task
  check(
    'task.create（playUrl + 状态）',
    typeof task?.id === 'string' &&
      task?.protocol === 'hls' &&
      ['ready', 'downloading'].includes(task?.status) &&
      typeof task?.playUrl === 'string' &&
      task.playUrl.includes('/m3u8/') &&
      task.playUrl.startsWith('http://127.0.0.1'),
    `id=${task?.id}`
  )
  const playUrl = task?.playUrl

  // ---------- 重写 playlist ----------
  const pl = await httpGet(playUrl)
  const plText = pl.body.toString()
  const segPath = plText
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('/seg/'))
  check(
    'GET playUrl → 重写 playlist',
    pl.status === 200 &&
      plText.startsWith('#EXTM3U') &&
      !!segPath &&
      !plText.includes('devstreaming-cdn'),
    `${segPath ?? 'no /seg line'}`
  )

  // ---------- 分片回源 + 落盘 ----------
  if (segPath) {
    const seg = await httpGet(`http://127.0.0.1:${new URL(playUrl).port}${segPath}`)
    check('GET /seg（回源 200 + 非空）', seg.status === 200 && seg.body.length > 0, `${seg.body.length} bytes`)
  } else {
    check('GET /seg（回源 200 + 非空）', false, 'playlist 无 /seg 行')
  }

  // ---------- 事件推送 ----------
  const taskUpdatedSeen = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 10000)
    const check = () => {
      if (notifications.some((n) => n.method === 'task.updated' && n.params?.task?.id === task?.id)) {
        clearTimeout(timer)
        resolve(true)
      }
    }
    const onData = () => check()
    socket.on('data', onData)
    check()
  })
  check('事件推送 task.updated', taskUpdatedSeen)

  // ---------- 下载进度（引擎并发预取） ----------
  let list = null
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    list = await request('task.list')
    if ((list?.tasks?.[0]?.segDone ?? 0) >= 3) break
    await sleep(500)
  }
  segDoneBeforeKill = list?.tasks?.[0]?.segDone ?? 0
  const bytes = list?.tasks?.[0]?.bytesDone ?? 0
  check(
    '下载进度推进（segDone >= 3）',
    segDoneBeforeKill >= 3 && list.tasks.length === 1,
    `${segDoneBeforeKill}/${list?.tasks?.[0]?.segTotal} · ${bytes} bytes`
  )

  try {
    await request('core.nope')
    check('未知方法 → -32601', false, '未返回错误')
  } catch (e) {
    check('未知方法 → -32601', /not found/i.test(e.message), e.message)
  }

  // ================= 第二轮：kill 内核 → 重启 → 断点续传 =================
  socket.destroy()
  proc.kill()
  await sleep(800)

  console.log(`${DIM}重启内核（验证断点续传）…${RESET}`)
  const r2 = startCore({ LOCALAPPDATA: tmpMain })
  proc = r2.proc
  const port2 = await r2.portReady
  const rpc2 = await connectRpc(port2)
  socket = rpc2.socket
  // 同 URL 重建：应复用任务 id 并从缓存续传
  const create2 = await rpc2.request('task.create', { url: TEST_URL, title: '冒烟测试' })
  const t2 = create2?.task
  check(
    '重启后同 URL 复用任务',
    t2?.id === task?.id,
    `id=${t2?.id}`
  )

  // 新 token/port 下 playUrl 依然可用（进程轮换后重写链路重建）
  const pl2 = await httpGet(t2?.playUrl)
  check(
    '重启后 playUrl 可用',
    pl2.status === 200 && pl2.body.toString().startsWith('#EXTM3U')
  )

  // 进度立即恢复（>= kill 前的完成数，未重下）
  const list2 = await rpc2.request('task.list')
  const done2 = list2?.tasks?.[0]?.segDone ?? 0
  check(
    '断点续传（进度不回退）',
    done2 >= segDoneBeforeKill,
    `重启前 ${segDoneBeforeKill} → 重启后 ${done2}`
  )

  // ================= 第三轮（P2）：双源容错——主源分片 404，镜像兜底 =================
  const tmp3 = path.join(process.env.TEMP ?? '.', `pf-smoke-p2-${process.pid}-a`)
  const segsPlain = Array.from({ length: 6 }, (_, i) => Buffer.alloc(64 * 1024 + i * 1024, 0x41 + i))
  const originA = await startLocalOrigin({ segs: segsPlain, failSegs: true })
  const originB = await startLocalOrigin({ segs: segsPlain })
  const r3 = startCore({ LOCALAPPDATA: tmp3 })
  extraProcs.push(r3.proc)
  const port3 = await r3.portReady
  const rpc3 = await connectRpc(port3)
  const create3 = await rpc3.request('task.create', {
    url: `http://127.0.0.1:${originA.port}/master.m3u8`,
    sources: [`http://127.0.0.1:${originB.port}/master.m3u8`],
    title: 'P2 容错'
  })
  const t3 = create3?.task
  check(
    'P2 双源 task.create（playUrl）',
    typeof t3?.id === 'string' && typeof t3?.playUrl === 'string' && t3.playUrl.startsWith('http://127.0.0.1'),
    `id=${t3?.id}`
  )
  const pl3 = await httpGet(t3.playUrl)
  const pl3Text = pl3.body.toString()
  check('P2 重写 playlist 含 /seg', pl3.status === 200 && pl3Text.includes('/seg/'))

  // 经代理取分片：主源 404 → 健康度择优换镜像 → 200 且字节与明文一致
  const segLine3 = pl3Text.split('\n').map((s) => s.trim()).find((l) => l.startsWith('/seg/'))
  const seg3 = await httpGet(`http://127.0.0.1:${new URL(t3.playUrl).port}${segLine3}`)
  check(
    'P2 主源故障 → 镜像兜底回包',
    seg3.status === 200 && seg3.body.length > 0 && seg3.body.equals(segsPlain[0]),
    `${seg3.body.length} bytes（主源 404 计数 ${originA.state.seg404}）`
  )

  // sources.updated：双源登记 + 主源健康度恶化（熔断或失败计数 > 0）
  const srcOk = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 20000)
    const poll = () => {
      const n = rpc3.notifications.filter((x) => x.method === 'sources.updated' && x.params?.taskId === t3.id)
      if (n.length > 0 && Array.isArray(n[n.length - 1].params.sources) && n[n.length - 1].params.sources.length >= 2) {
        const s = n[n.length - 1].params.sources
        const primary = s.find((x) => x.idx === 0)
        if (primary && (primary.failures > 0 || primary.state === 'circuit_open')) {
          clearTimeout(timer)
          resolve(s)
        }
      }
    }
    const onData = () => poll()
    rpc3.socket.on('data', onData)
    poll()
  })
  check(
    'P2 sources.updated：主源熔断/失败记账',
    Array.isArray(srcOk) && srcOk.length === 2,
    srcOk ? `主源 state=${srcOk[0]?.state} failures=${srcOk[0]?.failures}` : '未观察到'
  )
  check(
    'P2 镜像健康度正常记账',
    Array.isArray(srcOk) && srcOk.some((s) => s.idx === 1 && s.requests > 0 && s.failures === 0),
    srcOk ? `镜像 req=${srcOk[1]?.requests} fail=${srcOk[1]?.failures}` : ''
  )

  // 引擎经镜像兜底推进进度
  let list3 = null
  const dl3 = Date.now() + 30000
  while (Date.now() < dl3) {
    list3 = await rpc3.request('task.list')
    if ((list3?.tasks?.[0]?.segDone ?? 0) >= 3) break
    await sleep(500)
  }
  check(
    'P2 引擎经镜像下载推进（segDone >= 3）',
    (list3?.tasks?.[0]?.segDone ?? 0) >= 3,
    `${list3?.tasks?.[0]?.segDone}/${list3?.tasks?.[0]?.segTotal}`
  )
  rpc3.socket.destroy()
  originA.server.close()
  originB.server.close()

  // ================= 第四轮（P2）：AES-128 本地解密 =================
  const tmp4 = path.join(process.env.TEMP ?? '.', `pf-smoke-p2-${process.pid}-b`)
  const key4 = crypto.randomBytes(16)
  const iv4 = crypto.randomBytes(16)
  const segs4 = Array.from({ length: 4 }, (_, i) => Buffer.alloc(48 * 1024 + i * 2048, 0x10 + i))
  const originC = await startLocalOrigin({ segs: segs4, key: key4, iv: iv4 })
  const r4 = startCore({ LOCALAPPDATA: tmp4 })
  extraProcs.push(r4.proc)
  const port4 = await r4.portReady
  const rpc4 = await connectRpc(port4)
  const create4 = await rpc4.request('task.create', {
    url: `http://127.0.0.1:${originC.port}/master.m3u8`,
    title: 'P2 AES'
  })
  const t4 = create4?.task
  check('P2 AES task.create', typeof t4?.id === 'string' && !!t4?.playUrl, `id=${t4?.id}`)
  const pl4 = await httpGet(t4.playUrl)
  const pl4Text = pl4.body.toString()
  check(
    'P2 AES playlist 输出 METHOD=NONE（对播放器隐藏加密）',
    pl4.status === 200 &&
      pl4Text.includes('#EXT-X-KEY:METHOD=NONE') &&
      !pl4Text.includes('AES-128') &&
      !pl4Text.includes('/key/'),
    pl4Text.split('\n').find((l) => l.includes('EXT-X-KEY'))?.trim() ?? ''
  )
  const segLine4 = pl4Text.split('\n').map((s) => s.trim()).find((l) => l.startsWith('/seg/'))
  const seg4 = await httpGet(`http://127.0.0.1:${new URL(t4.playUrl).port}${segLine4}`)
  check(
    'P2 AES /seg 返回明文（CBC 解密）',
    seg4.status === 200 && seg4.body.equals(segs4[0]),
    `${seg4.body.length} bytes`
  )
  rpc4.socket.destroy()
  originC.server.close()

  // ================= 第五轮（P2.5）：online 纯在线不落盘 + 模式切换 =================
  const tmp5 = path.join(process.env.TEMP ?? '.', `pf-smoke-p25-${process.pid}-a`)
  const segs5 = Array.from({ length: 6 }, (_, i) => Buffer.alloc(48 * 1024 + i * 1024, 0x50 + i))
  const originD = await startLocalOrigin({ segs: segs5 })
  const r5 = startCore({ LOCALAPPDATA: tmp5 })
  extraProcs.push(r5.proc)
  const port5 = await r5.portReady
  const rpc5 = await connectRpc(port5)
  const create5 = await rpc5.request('task.create', {
    url: `http://127.0.0.1:${originD.port}/master.m3u8`,
    title: 'P2.5 online',
    cacheMode: 'online'
  })
  const t5 = create5?.task
  check(
    'P2.5 online task.create（cacheMode 回带）',
    t5?.cacheMode === 'online' && typeof t5?.playUrl === 'string',
    `id=${t5?.id}`
  )
  check(
    'P2.5 online 任务即 ready（不启动下载）',
    t5?.status === 'ready' && (t5?.segTotal ?? 0) === 0 && (t5?.segDone ?? 0) === 0,
    `status=${t5?.status} segTotal=${t5?.segTotal}`
  )
  // /seg 纯实时回源可用
  const pl5 = await httpGet(t5.playUrl)
  const segLine5 = pl5.body.toString().split('\n').map((s) => s.trim()).find((l) => l.startsWith('/seg/'))
  const seg5 = await httpGet(`http://127.0.0.1:${new URL(t5.playUrl).port}${segLine5}`)
  check(
    'P2.5 online /seg 实时回源（200 + 明文）',
    seg5.status === 200 && seg5.body.equals(segs5[0]),
    `${seg5.body.length} bytes`
  )
  // 引擎确实没在预取（2s 内 segDone 恒 0）
  await sleep(2000)
  const list5 = await rpc5.request('task.list')
  check(
    'P2.5 online 引擎不预取（segDone 恒 0）',
    (list5?.tasks?.[0]?.segDone ?? 0) === 0,
    `segDone=${list5?.tasks?.[0]?.segDone}`
  )
  // 缓存目录无 .bin（不落盘）
  const cacheDir5 = path.join(tmp5, 'PolyFrame', 'cache', t5.id)
  const bins5 = existsSync(cacheDir5) ? readdirSync(cacheDir5).filter((f) => f.endsWith('.bin')) : []
  check('P2.5 online 缓存目录无 .bin（不落盘）', bins5.length === 0, `${bins5.length} 个`)
  // 切 stream：引擎恢复调度开始落盘
  const sw5 = await rpc5.request('task.set_cache_mode', { taskId: t5.id, cacheMode: 'stream' })
  check(
    'P2.5 set_cache_mode → stream（cacheMode 回带）',
    sw5?.task?.cacheMode === 'stream'
  )
  let list5b = null
  const dl5 = Date.now() + 30000
  while (Date.now() < dl5) {
    list5b = await rpc5.request('task.list')
    if ((list5b?.tasks?.[0]?.segDone ?? 0) >= 3) break
    await sleep(500)
  }
  check(
    'P2.5 online→stream 恢复调度（segDone >= 3）',
    (list5b?.tasks?.[0]?.segDone ?? 0) >= 3,
    `${list5b?.tasks?.[0]?.segDone}/${list5b?.tasks?.[0]?.segTotal}`
  )
  rpc5.socket.destroy()
  originD.server.close()

  // ================= 第六轮（P2.5）：precache 全量预取 =================
  const tmp6 = path.join(process.env.TEMP ?? '.', `pf-smoke-p25-${process.pid}-b`)
  const originE = await startLocalOrigin({ segs: segs5 })
  const r6 = startCore({ LOCALAPPDATA: tmp6 })
  extraProcs.push(r6.proc)
  const port6 = await r6.portReady
  const rpc6 = await connectRpc(port6)
  const create6 = await rpc6.request('task.create', {
    url: `http://127.0.0.1:${originE.port}/master.m3u8`,
    title: 'P2.5 precache',
    cacheMode: 'precache'
  })
  const t6 = create6?.task
  check(
    'P2.5 precache task.create（cacheMode 回带）',
    t6?.cacheMode === 'precache' && typeof t6?.playUrl === 'string',
    `id=${t6?.id}`
  )
  // 播放头未动（不请求 /seg），引擎也应全量预取
  let list6 = null
  const dl6 = Date.now() + 30000
  while (Date.now() < dl6) {
    list6 = await rpc6.request('task.list')
    if ((list6?.tasks?.[0]?.segDone ?? 0) >= (list6?.tasks?.[0]?.segTotal ?? 99)) break
    await sleep(500)
  }
  check(
    'P2.5 precache 无播放头全量预取（segDone == segTotal）',
    (list6?.tasks?.[0]?.segDone ?? 0) === (list6?.tasks?.[0]?.segTotal ?? -1) && (list6?.tasks?.[0]?.segTotal ?? 0) >= 6,
    `${list6?.tasks?.[0]?.segDone}/${list6?.tasks?.[0]?.segTotal}`
  )
  rpc6.socket.destroy()
  originE.server.close()

  // ================= 第七轮（P5）：任务暂停 / 恢复 / 删除 =================
  const tmp7 = path.join(process.env.TEMP ?? '.', `pf-smoke-p5-${process.pid}`)
  const originF = await startLocalOrigin({ segs: segs5 })
  const r7 = startCore({ LOCALAPPDATA: tmp7 })
  extraProcs.push(r7.proc)
  const port7 = await r7.portReady
  const rpc7 = await connectRpc(port7)
  const create7 = await rpc7.request('task.create', {
    url: `http://127.0.0.1:${originF.port}/master.m3u8`,
    title: 'P5 任务管理',
    cacheMode: 'precache'
  })
  const t7 = create7?.task
  let list7a = null
  const dl7 = Date.now() + 30000
  while (Date.now() < dl7) {
    list7a = await rpc7.request('task.list')
    if ((list7a?.tasks?.[0]?.segDone ?? 0) >= 2) break
    await sleep(400)
  }
  check('P5 任务下载起步（segDone >= 2）', (list7a?.tasks?.[0]?.segDone ?? 0) >= 2)

  // 暂停：状态 paused + 进度冻结
  const pause7 = await rpc7.request('task.pause', { taskId: t7.id })
  check('P5 task.pause（status=paused 回带）', pause7?.task?.status === 'paused', `status=${pause7?.task?.status}`)
  const d1 = (await rpc7.request('task.list'))?.tasks?.find((x) => x.id === t7.id)?.segDone ?? 0
  await sleep(2500)
  const d2 = (await rpc7.request('task.list'))?.tasks?.find((x) => x.id === t7.id)?.segDone ?? 0
  check('P5 暂停后进度冻结（segDone 不再增长）', d2 === d1, `d1=${d1} d2=${d2}`)

  // 恢复：状态回带 + 进度继续推进
  const resume7 = await rpc7.request('task.resume', { taskId: t7.id })
  check(
    'P5 task.resume（status 回带）',
    resume7?.task?.status === 'downloading' || resume7?.task?.status === 'ready',
    `status=${resume7?.task?.status}`
  )
  let d3 = 0
  let gone = false
  const dl7b = Date.now() + 30000
  while (Date.now() < dl7b) {
    const row = (await rpc7.request('task.list'))?.tasks?.find((x) => x.id === t7.id)
    if (!row) {
      gone = true
      break
    }
    d3 = row.segDone ?? 0
    if (d3 > d2) break
    await sleep(400)
  }
  // 回归（P2.5 潜伏 bug）：retain_until 曾被写成「时长」→ 1970 过期 → resume 后 2s 内被清理循环误删；
  // 修复后任务必须保留（若有新增可下分片则进度还应推进）
  check('P5 恢复后任务保留且进度不回退', !gone && d3 >= d2, `gone=${gone} d2=${d2} d3=${d3}`)

  // 删除：列表清空 + 缓存目录移除 + 同 URL 可重建（DB 行确删，UNIQUE 不冲突）
  const del7 = await rpc7.request('task.delete', { taskId: t7.id })
  check('P5 task.delete（freedBytes 回带）', typeof del7?.freedBytes === 'number')
  const list7b = await rpc7.request('task.list')
  check('P5 删除后任务列表为空', (list7b?.tasks?.length ?? 1) === 0, `${list7b?.tasks?.length} 个`)
  check(
    'P5 删除后缓存目录已移除',
    !existsSync(path.join(tmp7, 'PolyFrame', 'cache', t7.id))
  )
  const recreate7 = await rpc7.request('task.create', {
    url: `http://127.0.0.1:${originF.port}/master.m3u8`,
    cacheMode: 'online'
  })
  check(
    'P5 删除后同 URL 可重建（新任务）',
    typeof recreate7?.task?.id === 'string' && recreate7.task.id !== t7.id
  )

  // 暂停任务跨重启保留（restore 只恢复内存表，不起 job）
  const create7b = await rpc7.request('task.create', {
    url: `http://127.0.0.1:${originF.port}/master.m3u8`,
    cacheMode: 'stream'
  })
  const t7b = create7b?.task
  let seg7b = 0
  const dl7c = Date.now() + 30000
  while (Date.now() < dl7c) {
    seg7b = (await rpc7.request('task.list'))?.tasks?.find((x) => x.id === t7b.id)?.segDone ?? 0
    if (seg7b >= 1) break
    await sleep(400)
  }
  await rpc7.request('task.pause', { taskId: t7b.id })
  rpc7.socket.destroy()
  r7.proc.kill()
  const r7b = startCore({ LOCALAPPDATA: tmp7 })
  extraProcs.push(r7b.proc)
  const port7b = await r7b.portReady
  const rpc7b = await connectRpc(port7b)
  const list7c = await rpc7b.request('task.list')
  const paused7 = list7c?.tasks?.find((x) => x.id === t7b.id)
  check(
    'P5 暂停任务跨重启保留（status=paused + playUrl 重建）',
    paused7?.status === 'paused' && typeof paused7?.playUrl === 'string',
    `status=${paused7?.status}`
  )
  const d4 = paused7?.segDone ?? 0
  await sleep(2000)
  const d5 = (await rpc7b.request('task.list'))?.tasks?.find((x) => x.id === t7b.id)?.segDone ?? 0
  check('P5 重启后暂停任务不自动续传（segDone 恒定）', d5 === d4, `d4=${d4} d5=${d5}`)
  rpc7b.socket.destroy()
  originF.server.close()

  // ================= 第八轮（P6）：合并导出（TS 二进制 concat） =================
  // 分片须以 MPEG-TS 同步字节 0x47 开头（引擎按首字节嗅探 TS/fMP4）
  const segs8 = Array.from({ length: 4 }, (_, i) => {
    const b = Buffer.alloc(48 * 1024 + i * 2048, 0x47)
    b[b.length - 1] = i
    return b
  })
  const tmp8 = path.join(process.env.TEMP ?? '.', `pf-smoke-p6-${process.pid}`)
  const originG = await startLocalOrigin({ segs: segs8 })
  const r8 = startCore({ LOCALAPPDATA: tmp8 })
  extraProcs.push(r8.proc)
  const port8 = await r8.portReady
  const rpc8 = await connectRpc(port8)
  const create8 = await rpc8.request('task.create', {
    url: `http://127.0.0.1:${originG.port}/master.m3u8`,
    title: 'P6 导出',
    cacheMode: 'precache'
  })
  const t8 = create8?.task
  let list8 = null
  const dl8 = Date.now() + 30000
  while (Date.now() < dl8) {
    list8 = await rpc8.request('task.list')
    if ((list8?.tasks?.[0]?.segDone ?? 0) >= (list8?.tasks?.[0]?.segTotal ?? 99)) break
    await sleep(400)
  }
  check('P6 导出前置：全量预取完成', (list8?.tasks?.[0]?.segDone ?? 0) === (list8?.tasks?.[0]?.segTotal ?? -1))

  // exportInfo：TS 嗅探（首片 0x47）→ ext=ts + 完成度
  const info8 = await rpc8.request('task.exportInfo', { taskId: t8.id })
  check(
    'P6 task.exportInfo（ext=ts + 完成度）',
    info8?.ext === 'ts' && info8?.done === 4 && info8?.total === 4,
    JSON.stringify(info8)
  )

  // task.export：.part 先写 → rename，成品字节 == 分片顺序 concat
  const out8 = path.join(tmp8, 'export-out.ts')
  const exp8 = await rpc8.request('task.export', { taskId: t8.id, outPath: out8 })
  check(
    'P6 task.export（segments/bytes 回带）',
    exp8?.segments === 4 && exp8?.bytes === segs8.reduce((a, b) => a + b.length, 0) && exp8?.path === out8,
    JSON.stringify(exp8)
  )
  const exported = existsSync(out8) ? (await import('node:fs')).readFileSync(out8) : Buffer.alloc(0)
  check('P6 导出成品字节一致（TS concat）', exported.equals(Buffer.concat(segs8)), `${exported.length} bytes`)
  check('P6 无 .part 残留', !existsSync(out8 + '.part'))

  // 空任务导出应报错
  try {
    await rpc8.request('task.exportInfo', { taskId: 'nonexistent' })
    check('P6 导出未知任务报错', false, '未返回错误')
  } catch (e) {
    check('P6 导出未知任务报错', /任务不存在/.test(e.message), e.message)
  }
  rpc8.socket.destroy()
  originG.server.close()
} catch (e) {
  check('用例执行', false, e.message)
} finally {
  socket?.destroy()
  proc?.kill()
  extraProcs.forEach((p) => p.kill())
}

const failed = results.filter((r) => !r.ok)
console.log(
  failed.length === 0
    ? `\n${GREEN}冒烟测试全部通过（${results.length} 项）${RESET}`
    : `\n${RED}${failed.length}/${results.length} 项失败${RESET}`
)
process.exit(failed.length === 0 ? 0 : 1)
