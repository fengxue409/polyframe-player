/**
 * P4 无头冒烟测试：MP4 P2SP 多源聚合 + /file 虚拟文件 + live 滑动窗口 + token 刷新
 *  A. MP4 单源：本地 origin 供 24MiB 合成 MP4 → task.create(protocol=mp4, playUrl=/file)
 *     → /file Range 三形态（精确/开放式/后缀）字节与 206/Content-Range 断言
 *     → precache 全量落盘 + /file 全量字节 == origin 字节
 *  B. MP4 双镜像聚合：双 origin 同内容（不同 URL）→ 全部下载自两源分摊（两源都被命中）
 *  C. 镜像剔除：第二镜像内容不同（hash 不一致）→ 被剔除且任务正常
 *  D. token 刷新：kill 内核 → 重启同 DB → 重建任务 → 新 playUrl token 生效（/file 200）
 *  E. live 滑动窗口：live origin（12 片无 ENDLIST）→ playlist 只含最近 8 片 + MEDIA-SEQUENCE=4
 *
 * 运行：node apps/core/scripts/smoke-p4.mjs（需先 pnpm core:build）
 */
import { spawn, execSync } from 'node:child_process'
import http from 'node:http'
import crypto from 'node:crypto'
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const httpGet = (url, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = http.get(url, { headers, timeout: 20000 }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }))
    })
    req.on('timeout', () => req.destroy(new Error('http 超时')))
    req.on('error', reject)
  })

/** 本地 MP4 origin：确定性伪随机字节（sizeMiB 可调；seed 变体做镜像剔除） */
function startMp4Origin(seed, state, sizeMiB = 24) {
  const size = sizeMiB * 1024 * 1024
  const data = crypto.createHash('sha256').update(String(seed)).digest()
  const body = Buffer.alloc(size)
  for (let i = 0; i < size; i += 4096) {
    const h = crypto.createHash('md5').update(data).update(String(i)).digest()
    h.copy(body, i, 0, Math.min(4096, size - i))
  }
  const origin = http.createServer((req, res) => {
    const r = req.headers.range
    state.hits++
    if (!r) {
      res.writeHead(200, { 'content-length': size })
      res.end(body)
      return
    }
    const m = r.match(/bytes=(\d+)-(\d*)/)
    if (!m) {
      res.writeHead(416)
      res.end()
      return
    }
    const start = Number(m[1])
    const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
    state.rangeHits++
    res.writeHead(206, {
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': end - start + 1,
      'accept-ranges': 'bytes'
    })
    res.end(body.subarray(start, end + 1))
  })
  return new Promise((resolve) => {
    origin.listen(0, '127.0.0.1', () =>
      resolve({ server: origin, url: `http://127.0.0.1:${origin.address().port}/video.mp4`, state, body, size })
    )
  })
}

/** live HLS origin：12 片 × 4s，无 ENDLIST，每片内容不同 */
function startLiveOrigin(state) {
  const segs = Array.from({ length: 12 }, (_, i) => Buffer.from(`live-seg-${i}-` + 'x'.repeat(64)))
  const origin = http.createServer((req, res) => {
    const p = (req.url || '/').split('?')[0]
    if (p.endsWith('/live.m3u8')) {
      const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0']
      segs.forEach((_, i) => lines.push('#EXTINF:4.000000,', `seg${i}.ts`))
      state.plHits++
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
      res.end(lines.join('\n'))
      return
    }
    const m = p.match(/seg(\d+)\.ts$/)
    if (m) {
      state.segHits++
      res.writeHead(200, { 'content-type': 'video/mp2t' })
      res.end(segs[Number(m[1])])
      return
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve) => {
    origin.listen(0, '127.0.0.1', () =>
      resolve({ server: origin, url: `http://127.0.0.1:${origin.address().port}/live.m3u8`, state })
    )
  })
}

/** 启动内核并等待端口发现 */
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
      }, 30000)
      pending.set(id, { resolve, reject, timer })
      socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  return { socket, request, notifications }
}

const tmpRoot = path.join(process.env.TEMP ?? '.', `pf-smoke-p4-${process.pid}`)
let proc = null
let request = null
const extra = []

try {
  const bin = binCandidates.find((p) => existsSync(p))
  console.log(`${DIM}启动内核: ${bin}${RESET}`)
  const first = startCore({ LOCALAPPDATA: tmpRoot })
  proc = first.proc
  const port = await first.portReady
  ;({ request } = await connectRpc(port))

  // ================= A 轮：MP4 单源 + /file Range =================
  console.log(`\n${DIM}—— A 轮：MP4 单源 + /file 虚拟文件 ——${RESET}`)
  const stA = { hits: 0, rangeHits: 0 }
  const originA = await startMp4Origin(1, stA)
  extra.push(originA.server)

  const createA = await request('task.create', { url: originA.url, title: 'P4-mp4', cacheMode: 'precache' })
  const taskA = createA?.task
  check(
    'task.create（protocol=mp4 + playUrl=/file）',
    taskA?.protocol === 'mp4' &&
      typeof taskA?.playUrl === 'string' &&
      taskA.playUrl.includes('/file/') &&
      taskA.masterUrl === undefined,
    `playUrl=${taskA?.playUrl}`
  )

  const fileBase = taskA.playUrl
  const total = originA.size

  // 精确 Range：起点在块 1（4MiB 处），跨块
  const r1 = await httpGet(fileBase, { Range: `bytes=${4 * 1024 * 1024}-${4 * 1024 * 1024 + 65535}` })
  check(
    '/file 精确 Range（206 + 字节对齐 origin）',
    r1.status === 206 &&
      r1.body.length === 65536 &&
      r1.headers['content-range'] === `bytes ${4 * 1024 * 1024}-${4 * 1024 * 1024 + 65535}/${total}` &&
      r1.body.equals(originA.body.subarray(4 * 1024 * 1024, 4 * 1024 * 1024 + 65536)),
    `${r1.body.length}B cr=${r1.headers['content-range']}`
  )

  // 开放式 Range（播放器初请求形态）
  const r2 = await httpGet(fileBase, { Range: 'bytes=0-' })
  check(
    '/file 开放式 Range（206 + 首块字节一致）',
    r2.status === 206 && r2.body.length === total && r2.body.equals(originA.body),
    `${r2.body.length}B`
  )

  // 后缀 Range（bytes=-N）
  const r3 = await httpGet(fileBase, { Range: `bytes=-1048576` })
  check(
    '/file 后缀 Range（尾 1MiB 一致）',
    r3.status === 206 && r3.body.equals(originA.body.subarray(total - 1048576)),
    `${r3.body.length}B`
  )

  // precache 全量落盘（24MiB / 4MiB = 6 块）
  let segDone = 0
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    const list = await request('task.list')
    segDone = list?.tasks?.find((t) => t.id === taskA.id)?.segDone ?? 0
    if (segDone >= 6) break
  }
  check('precache 全量落盘（segDone=6）', segDone === 6, `${segDone}/6`)

  // 落盘后 /file 命中读盘（再拉一次全量字节一致）
  const r4 = await httpGet(fileBase, { Range: `bytes=${8 * 1024 * 1024}-` })
  check('/file 命中缓存读盘（尾 16MiB 一致）', r4.status === 206 && r4.body.equals(originA.body.subarray(8 * 1024 * 1024)))

  // ================= B 轮：MP4 双镜像聚合 =================
  console.log(`\n${DIM}—— B 轮：MP4 双镜像 P2SP 聚合 ——${RESET}`)
  const stB1 = { hits: 0, rangeHits: 0 }
  const stB2 = { hits: 0, rangeHits: 0 }
  const originB1 = await startMp4Origin(1, stB1) // 与 A 同 seed = 同内容
  const originB2 = await startMp4Origin(1, stB2)
  extra.push(originB1.server, originB2.server)

  const createB = await request('task.create', {
    url: originB1.url,
    sources: [originB2.url],
    title: 'P4-p2sp',
    cacheMode: 'precache'
  })
  const taskB = createB?.task
  check('双镜像任务创建（两源均被接受）', !!taskB?.id, `id=${taskB?.id}`)

  let segDoneB = 0
  for (let i = 0; i < 80; i++) {
    await sleep(500)
    const list = await request('task.list')
    segDoneB = list?.tasks?.find((t) => t.id === taskB.id)?.segDone ?? 0
    if (segDoneB >= 6) break
  }
  check('双镜像全量落盘', segDoneB === 6, `${segDoneB}/6`)
  check(
    'P2SP 分摊（两源均被回源命中）',
    stB1.rangeHits > 0 && stB2.rangeHits > 0,
    `src1=${stB1.rangeHits} src2=${stB2.rangeHits}`
  )
  // 聚合完整性：/file 全量字节 == origin
  const rb = await httpGet(taskB.playUrl, { Range: 'bytes=0-' })
  check('P2SP 聚合字节完整性', rb.body.equals(originB1.body), `${rb.body.length}B`)

  // ================= C 轮：镜像剔除（内容不同） =================
  console.log(`\n${DIM}—— C 轮：镜像 hash 预检剔除 ——${RESET}`)
  const stC = { hits: 0, rangeHits: 0 }
  const originC1 = await startMp4Origin(2, stC) // 不同 seed
  const originC2 = await startMp4Origin(3, stC) // 不同内容
  extra.push(originC1.server, originC2.server)
  const createC = await request('task.create', {
    url: originC1.url,
    sources: [originC2.url],
    title: 'P4-reject',
    cacheMode: 'precache'
  })
  const taskC = createC?.task
  let segDoneC = 0
  for (let i = 0; i < 80; i++) {
    await sleep(500)
    const list = await request('task.list')
    segDoneC = list?.tasks?.find((t) => t.id === taskC.id)?.segDone ?? 0
    if (segDoneC >= 6) break
  }
  const rc = await httpGet(taskC.playUrl, { Range: 'bytes=0-1048575' })
  check(
    '异源镜像被剔除 + 任务照常完成（字节 == 主源）',
    segDoneC === 6 && rc.body.equals(originC1.body.subarray(0, 1048576)),
    `seg=${segDoneC}/6`
  )

  // ================= D 轮：token 刷新（下载中 kill → 重启同 DB 续传） =================
  console.log(`\n${DIM}—— D 轮：内核重启 token 刷新 + 续传 ——${RESET}`)
  const stD = { hits: 0, rangeHits: 0 }
  // 256MiB：本地 origin 下不完，保证 kill 时任务处于 downloading（完结任务不参与恢复）
  const originD = await startMp4Origin(4, stD, 256)
  extra.push(originD.server)
  const createD = await request('task.create', { url: originD.url, title: 'P4-kill', cacheMode: 'stream' })
  const taskD = createD?.task
  // /file Range 请求驱动播放头 → 引擎开窗调度落盘；segDone≥1 且 downloading 时立即 kill
  let segDoneD = 0
  let statusD = ''
  for (let i = 0; i < 40; i++) {
    await httpGet(taskD.playUrl, { Range: `bytes=${(i % 3) * 4 * 1024 * 1024}-` }).catch(() => {})
    await sleep(300)
    const list = await request('task.list')
    const t = list?.tasks?.find((x) => x.id === taskD.id)
    segDoneD = t?.segDone ?? 0
    statusD = t?.status ?? ''
    if (segDoneD >= 1 && statusD === 'downloading') break
  }
  check('kill 前置条件（downloading + 已落 ≥1 块）', statusD === 'downloading' && segDoneD >= 1, `${statusD} ${segDoneD}`)
  proc.kill()
  await sleep(300)
  try {
    execSync(`taskkill /PID ${proc.pid} /F 2>nul`)
  } catch {}
  const second = startCore({ LOCALAPPDATA: tmpRoot })
  proc = second.proc
  const port2 = await second.portReady
  ;({ request } = await connectRpc(port2))
  // 启动恢复是后台任务，轮询等任务回列表（downloading 状态任务参与恢复）
  let restored = null
  for (let i = 0; i < 30; i++) {
    await sleep(500)
    const listD = await request('task.list')
    restored = listD?.tasks?.find((t) => t.id === taskD.id)
    if (restored?.playUrl) break
  }
  const oldToken = new URL(taskD.playUrl).pathname.split('/')[2]
  check('重启后任务恢复（playUrl 换新 token）', !!restored?.playUrl && !restored.playUrl.includes(oldToken), `${restored?.playUrl}`)
  const rd = await httpGet(restored.playUrl, { Range: 'bytes=0-65535' })
  check(
    '新 token /file 可用 + 字节续传一致',
    rd.status === 206 && rd.body.equals(originD.body.subarray(0, 65536)),
    `segDone=${restored?.segDone}`
  )

  // ================= E 轮：live 滑动窗口 =================
  console.log(`\n${DIM}—— E 轮：live 滑动窗口 ——${RESET}`)
  const stE = { plHits: 0, segHits: 0 }
  const originE = await startLiveOrigin(stE)
  extra.push(originE.server)
  const createE = await request('task.create', { url: originE.url, title: 'P4-live', cacheMode: 'stream' })
  const taskE = createE?.task
  check('live 任务创建（live=true）', taskE?.protocol === 'hls', `id=${taskE?.id}`)
  const plE = await httpGet(taskE.playUrl)
  const lines = plE.body.toString().split('\n').map((l) => l.trim()).filter(Boolean)
  const mediaSeq = Number(lines.find((l) => l.startsWith('#EXT-X-MEDIA-SEQUENCE:'))?.split(':')[1] ?? -1)
  const segLines = lines.filter((l) => l.startsWith('/seg/'))
  check(
    'live playlist 滑动窗口（最近 8 片 + MEDIA-SEQUENCE=4 + 无 ENDLIST）',
    mediaSeq === 4 && segLines.length === 8 && segLines[7].endsWith('/11') && !plE.body.toString().includes('ENDLIST'),
    `seq=${mediaSeq} segs=${segLines.length}`
  )
  const segE = await httpGet(`http://127.0.0.1:${new URL(taskE.playUrl).port}${segLines[0]}`)
  check('live 分片回源可用', segE.status === 200 && segE.body.length > 0, `${segE.body.length}B`)
} catch (e) {
  check('P4 冒烟执行', false, String(e.message).slice(0, 300))
} finally {
  try {
    for (const s of extra) s.close()
    proc?.kill()
    execSync('taskkill /IM pf-core.exe /F 2>nul')
  } catch {}
}

await sleep(500)
const failed = results.filter((x) => !x.ok).length
console.log(`\n${failed === 0 ? GREEN + '全部通过' : RED + `${failed}/${results.length} 项失败`}${RESET}（${results.length} 项）`)
process.exit(failed === 0 ? 0 : 1)
