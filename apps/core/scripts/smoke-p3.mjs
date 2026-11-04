/**
 * P3 无头冒烟测试：libmpv 集成 + master 透传 + series 剧集队列
 *  1. mpv.probe：DLL 发现（PF_MPV_DLL 显式注入 vendor 路径）
 *  2. mpv.attach hwnd=0（headless vo=null/ao=null）→ attached
 *  3. mpv.load 真实 HLS（本地 origin 按需回源 Apple bipbop gear1 真实分片）
 *     → mpv.state 通知 playing=true + timePos 推进（解复用/解码管线打通）
 *  4. mpv.tracklist 非空（video/audio 轨）；mpv.set/get pause 往返
 *  5. mpv.seek 绝对跳转 → timePos 跳变；mpv.stop → playing=false
 *  6. master.m3u8 透传重写（bipbop 多码率 variant）：
 *     最高 BANDWIDTH → /m3u8/.../playlist.m3u8（走引擎）；其余 variant 与
 *     EXT-X-MEDIA rendition → /raw/ 本地化；全部 URI 不泄漏远端域名
 *  7. raw playlist / segraw 分片透传 200
 *  8. series 队列：e0 precache + 经代理 /seg 触发播放头 → e0 全量完成 ≥95%
 *     → 队列 tick 自动激活 e1（segDone 开始推进）
 *
 * 运行：node apps/core/scripts/smoke-p3.mjs（需先 pnpm core:build）
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
const MPV_DLL = path.join(coreRoot, 'vendor', 'mpv', 'libmpv-2.dll')

const TEST_URL =
  'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/bipbop_16x9_variant.m3u8'

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

const httpGet = (url, timeoutMs = 20000) =>
  new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
    })
    req.on('timeout', () => req.destroy(new Error('http 超时')))
    req.on('error', reject)
  })

/** P3-C series 用合成字节 origin（引擎只下载不解复用，mpv 不参与本轮） */
function startByteOrigin() {
  const origin = http.createServer((req, res) => {
    const p = (req.url || '/').split('?')[0]
    if (p.endsWith('/media.m3u8')) {
      const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0']
      for (let i = 0; i < 6; i++) lines.push('#EXTINF:4.000000,', `seg${i}.ts`)
      lines.push('#EXT-X-ENDLIST', '')
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
      res.end(lines.join('\n'))
      return
    }
    const m = p.match(/seg(\d+)\.ts$/)
    if (m) {
      res.writeHead(200, { 'content-type': 'video/mp2t' })
      res.end(Buffer.alloc(32 * 1024, 0x30 + Number(m[1])))
      return
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve) => {
    origin.listen(0, '127.0.0.1', () => resolve({ server: origin, port: origin.address().port }))
  })
}

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
  const request = (method, params, timeoutMs = 20000) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`超时: ${method}`))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  return { socket, request, notifications }
}

/** 等 mpv.state 满足谓词 */
function waitMpvState(rpc, predicate, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    const poll = () => {
      const states = rpc.notifications.filter((n) => n.method === 'mpv.state')
      for (let i = states.length - 1; i >= 0; i--) {
        const s = states[i].params
        if (predicate(s)) {
          clearTimeout(timer)
          resolve(s)
          return
        }
      }
    }
    const onData = () => poll()
    rpc.socket.on('data', onData)
    poll()
  })
}

let proc = null
const extraProcs = []
const servers = []

try {
  if (!existsSync(MPV_DLL)) throw new Error(`未找到 libmpv-2.dll: ${MPV_DLL}`)

  // ================= A 轮：libmpv headless 播放管线 =================
  console.log(`${DIM}[A] libmpv headless（vo=null/ao=null）直连真实 HLS${RESET}`)
  const tmpA = path.join(process.env.TEMP ?? '.', `pf-smoke-p3-${process.pid}-a`)
  const coreA = startCore({ LOCALAPPDATA: tmpA, PF_MPV_DLL: MPV_DLL })
  proc = coreA.proc
  const portA = await coreA.portReady
  const rpcA = await connectRpc(portA)

  const probe = await rpcA.request('mpv.probe')
  check('mpv.probe（DLL 发现）', probe?.available === true, probe?.path ?? '')

  const attach = await rpcA.request('mpv.attach', { hwnd: 0 })
  check('mpv.attach（headless）', attach?.attached === true && attach?.headless === true)

  // 直连真实多码率 master（P2 冒烟已验证可达；含 video/audio/sub 多轨）
  await rpcA.request('mpv.load', { url: TEST_URL })
  const playingState = await waitMpvState(rpcA, (s) => s.playing === true && (s.timePos ?? 0) > 0, 60000)
  check(
    'mpv.state 起播（playing + timePos 推进）',
    !!playingState,
    playingState ? `t=${playingState.timePos?.toFixed(1)}s dur=${playingState.duration?.toFixed(0)}s` : '60s 未起播'
  )

  const tl = await rpcA.request('mpv.tracklist')
  const kinds = new Set((tl?.tracks ?? []).map((t) => t.kind))
  check(
    'mpv.tracklist（video+audio 轨归并）',
    kinds.has('video') && kinds.has('audio'),
    `${tl?.tracks?.length ?? 0} 轨`
  )

  const setPause = await rpcA.request('mpv.set', { name: 'pause', value: 'yes' })
  const pausedState = await waitMpvState(rpcA, (s) => s.pause === true, 8000)
  check('mpv.set pause → state 回传 pause=true', setPause?.set === true && !!pausedState)

  const cur = pausedState?.timePos ?? 0
  await rpcA.request('mpv.seek', { seconds: Math.min(25, (pausedState?.duration ?? 40) - 5), absolute: true })
  const seekedState = await waitMpvState(rpcA, (s) => (s.timePos ?? 0) > cur + 3, 10000)
  check(
    'mpv.seek 绝对跳转（timePos 跳变）',
    !!seekedState,
    seekedState ? `${cur.toFixed(1)}s → ${seekedState.timePos?.toFixed(1)}s` : '未观察到跳变'
  )

  const stopped = await rpcA.request('mpv.stop')
  const stoppedState = await waitMpvState(rpcA, (s) => s.playing === false, 8000)
  check('mpv.stop（playing=false）', stopped?.stopped === true && !!stoppedState)
  await rpcA.request('mpv.detach')
  rpcA.socket.destroy()

  // ================= B 轮：master playlist 透传重写（bipbop 多码率 + rendition） =================
  console.log(`${DIM}[B] master.m3u8 透传重写（bipbop variant）${RESET}`)
  const tmpB = path.join(process.env.TEMP ?? '.', `pf-smoke-p3-${process.pid}-b`)
  const coreB = startCore({ LOCALAPPDATA: tmpB, PF_MPV_DLL: MPV_DLL })
  extraProcs.push(coreB.proc)
  const portB = await coreB.portReady
  const rpcB = await connectRpc(portB)
  const createB = await rpcB.request('task.create', {
    url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/bipbop_16x9_variant.m3u8',
    cacheMode: 'online',
    title: 'P3 master 透传'
  })
  const tB = createB?.task
  check(
    'task.create 返回 masterUrl（HLS）',
    typeof tB?.masterUrl === 'string' && tB.masterUrl.endsWith('/master.m3u8'),
    tB?.masterUrl ?? '缺失'
  )
  const master = await httpGet(tB.masterUrl)
  const masterText = master.body.toString()
  const variantLines = masterText.split('\n').filter((l) => l.startsWith('/m3u8/'))
  const engineVariants = variantLines.filter((l) => l.includes('/playlist.m3u8'))
  const rawVariants = variantLines.filter((l) => l.includes('/raw/'))
  check(
    'master 透传：最高码率走引擎 + 其余 /raw 本地化',
    master.status === 200 &&
      engineVariants.length === 1 &&
      rawVariants.length >= 1 &&
      !masterText.includes('devstreaming-cdn'),
    `${engineVariants.length} 引擎 / ${rawVariants.length} 透传`
  )
  const mediaLine = masterText.split('\n').find((l) => l.includes('TYPE=AUDIO') || l.includes('TYPE=SUBTITLES'))
  check(
    'master 透传：EXT-X-MEDIA rendition 行保留（无远端泄漏）',
    !!mediaLine && !masterText.includes('devstreaming-cdn'),
    mediaLine?.slice(0, 100) ?? '无 EXT-X-MEDIA 行'
  )
  // raw playlist + segraw 分片透传
  const rawUri = rawVariants[0]
  const rawPl = await httpGet(`http://127.0.0.1:${new URL(tB.masterUrl).port}${rawUri}`)
  const rawPlText = rawPl.body.toString()
  const rawSeg = rawPlText.split('\n').map((s) => s.trim()).find((l) => l.startsWith('/segraw/'))
  check(
    'raw playlist 透传（分片本地化 /segraw）',
    rawPl.status === 200 && rawPlText.startsWith('#EXTM3U') && !!rawSeg,
    rawSeg ?? rawPlText.slice(0, 80)
  )
  if (rawSeg) {
    const segRaw = await httpGet(`http://127.0.0.1:${new URL(tB.masterUrl).port}${rawSeg}`)
    check('segraw 分片透传（200 + 非空）', segRaw.status === 200 && segRaw.body.length > 0, `${segRaw.body.length} bytes`)
  }
  // 端到端：mpv 播 masterUrl（最高码率 variant 经引擎 BYTERANGE 分片）→ 起播 + 多轨
  const attachB = await rpcB.request('mpv.attach', { hwnd: 0 })
  check('mpv.attach（B 轮 headless）', attachB?.attached === true)
  await rpcB.request('mpv.load', { url: tB.masterUrl })
  const playB = await waitMpvState(rpcB, (s) => s.playing === true && (s.timePos ?? 0) >= 0, 60000)
  check('mpv 播 masterUrl（经代理+引擎）起播', !!playB, playB ? `t=${playB.timePos?.toFixed(1)}s` : '60s 未起播')
  const tlB = await rpcB.request('mpv.tracklist')
  const kindsB = new Set((tlB?.tracks ?? []).map((t) => t.kind))
  check(
    'mpv tracklist（masterUrl 多轨归并）',
    kindsB.has('video') && kindsB.has('audio'),
    `${tlB?.tracks?.length ?? 0} 轨`
  )
  await rpcB.request('mpv.detach')
  rpcB.socket.destroy()

  // ================= C 轮：series 剧集预缓存队列推进 =================
  console.log(`${DIM}[C] series 队列：e0 ≥95% → 自动激活 e1${RESET}`)
  const tmpC = path.join(process.env.TEMP ?? '.', `pf-smoke-p3-${process.pid}-c`)
  const originC = await startByteOrigin()
  servers.push(originC.server)
  const coreC = startCore({ LOCALAPPDATA: tmpC, PF_MPV_DLL: MPV_DLL })
  extraProcs.push(coreC.proc)
  const portC = await coreC.portReady
  const rpcC = await connectRpc(portC)
  const mk = (ep) =>
    rpcC.request('task.create', {
      url: `http://127.0.0.1:${originC.port}/media.m3u8`,
      cacheMode: 'precache',
      title: `P3 series e${ep}`
    })
  const e0 = (await mk(0))?.task
  const e1 = (await mk(1))?.task
  check('series 两个任务创建', typeof e0?.id === 'string' && typeof e1?.id === 'string')
  await rpcC.request('task.attach_series', { taskId: e0.id, seriesId: 'smoke-series', episodeIndex: 0 })
  await rpcC.request('task.attach_series', { taskId: e1.id, seriesId: 'smoke-series', episodeIndex: 1 })

  // 经代理请求 e0 首个 /seg → note_playhead 记账（当前集识别）
  const plC = await httpGet(e0.playUrl)
  const segLineC = plC.body.toString().split('\n').map((s) => s.trim()).find((l) => l.startsWith('/seg/'))
  await httpGet(`http://127.0.0.1:${new URL(e0.playUrl).port}${segLineC}`)

  // 等 e0 全量完成（precache 无锚点也全量，很快）
  let e0Done = false
  const dlC = Date.now() + 40000
  while (Date.now() < dlC) {
    const l = await rpcC.request('task.list')
    const t0 = l?.tasks?.find((t) => t.id === e0.id)
    if (t0 && t0.segTotal > 0 && t0.segDone >= t0.segTotal) {
      e0Done = true
      break
    }
    await sleep(500)
  }
  check('e0 precache 全量完成（≥95%）', e0Done)

  // 队列 tick（5s 一轮）应激活 e1：segDone 从 0 开始推进
  let e1Started = false
  const dlC2 = Date.now() + 25000
  while (Date.now() < dlC2) {
    const l = await rpcC.request('task.list')
    const t1 = l?.tasks?.find((t) => t.id === e1.id)
    if ((t1?.segDone ?? 0) >= 2) {
      e1Started = true
      break
    }
    await sleep(500)
  }
  const finalList = await rpcC.request('task.list')
  const e1fin = finalList?.tasks?.find((t) => t.id === e1.id)
  check('series 队列自动激活 e1（segDone 推进）', e1Started, `e1 segDone=${e1fin?.segDone}/${e1fin?.segTotal}`)

  // 手动清理：purge e1 缓存 → freedBytes > 0
  const purge = await rpcC.request('task.purge_cache', { taskId: e1.id })
  check('task.purge_cache（释放字节 > 0）', (purge?.freedBytes ?? 0) > 0, `${((purge?.freedBytes ?? 0) / 1024).toFixed(0)} KB`)

  // 缓存策略读写往返
  const polSet = await rpcC.request('config.set_cache_policy', { retainDays: 7, unfinishedDays: 30, capacityGb: 50 })
  const polGet = await rpcC.request('config.get_cache_policy')
  check(
    'config.set/get_cache_policy 往返',
    polSet?.retainDays === 7 && polGet?.retainDays === 7 && polGet?.unfinishedDays === 30 && polGet?.capacityGb === 50
  )
  rpcC.socket.destroy()
  originC.server.close()
} catch (e) {
  check('用例执行', false, e.message)
} finally {
  proc?.kill()
  extraProcs.forEach((p) => p.kill())
  servers.forEach((s) => s.close())
  await sleep(300)
}

const failed = results.filter((r) => !r.ok)
console.log(
  failed.length === 0
    ? `\n${GREEN}P3 冒烟测试全部通过（${results.length} 项）${RESET}`
    : `\n${RED}${failed.length}/${results.length} 项失败${RESET}`
)
process.exit(failed.length === 0 ? 0 : 1)
