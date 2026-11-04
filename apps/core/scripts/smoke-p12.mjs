/**
 * P12 无头冒烟测试：磁力/BT 片源
 *  A. 参数校验：乱写的地址要报错，不能静默建任务
 *  B. 建任务：本机做种（pf-bt-seed）+ 直连 peer → 拿到元数据
 *  C. 选片：自动挑最大的视频文件，跳过说明/字幕
 *  D. 下载：进度推进到 100%，文件大小与源文件一致
 *  E. 播放：/bt 路由 200 全量、206 Range、Content-Range 正确
 *  F. 未下完不许播：错误文案要说清原因
 *  G. 删除：记录消失，且 /bt 立刻 404
 *
 * 全程不依赖公网：做种器与内核都在本机，peer 直连（不经 DHT/tracker）。
 * 运行：node apps/core/scripts/smoke-p12.mjs（需先 cargo build --release -p pf-core -p pf-magnet）
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const coreRoot = path.resolve(here, '..')
const binCandidates = [
  path.join(coreRoot, 'target/release/pf-core.exe'),
  path.join(coreRoot, 'target/debug/pf-core.exe')
]
const seedBinCandidates = [
  path.join(coreRoot, 'target/release/pf-bt-seed.exe'),
  path.join(coreRoot, 'target/debug/pf-bt-seed.exe')
]

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(
    `  ${ok ? GREEN + 'PASS' : RED + 'FAIL'}${RESET} ${name}${detail ? ` ${DIM}(${detail})${RESET}` : ''}`
  )
}

let rpcToken = ''

function startCore(envOverride = {}) {
  const bin = binCandidates.find((p) => fs.existsSync(p))
  if (!bin) throw new Error('未找到 pf-core.exe，请先 cargo build --release -p pf-core')
  const proc = spawn(bin, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...envOverride }
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
  socket.on('error', () => {})
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

/** 起做种器：返回 magnet / peer / 名字 */
function startSeeder(target) {
  const bin = seedBinCandidates.find((p) => fs.existsSync(p))
  if (!bin) throw new Error('未找到 pf-bt-seed.exe，请先 cargo build --release -p pf-magnet')
  const proc = spawn(bin, [target], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const ready = new Promise((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error('做种器启动超时')), 30000)
    const onData = (d) => {
      out += d.toString()
      const magnet = out.match(/PF_BT_SEED_MAGNET=(magnet:\S+)/)?.[1]
      const peer = out.match(/PF_BT_SEED_PEER=([\d.]+:\d+)/)?.[1]
      if (magnet && peer) {
        clearTimeout(timer)
        proc.stdout.off('data', onData)
        resolve({ magnet, peer })
      }
    }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', (d) => {
      const s = d.toString()
      if (s.trim()) console.log(`  ${DIM}[seeder] ${s.trim()}${RESET}`)
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`做种器提前退出 code=${code}`))
    })
  })
  return { proc, ready }
}

/** GET 一个本地 URL，返回 {status, headers, body:Buffer} */
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
      )
    })
    req.on('error', reject)
    req.setTimeout(30000, () => req.destroy(new Error('HTTP 超时')))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (b) => createHash('sha256').update(b).digest('hex')

let core = null
let seeder = null
let workspace = ''
let socket = null
let request = null

/** 起内核并连上 RPC（重启测试会调用两次） */
async function bootCore(appDataDir) {
  core = startCore({ LOCALAPPDATA: appDataDir })
  const port = await core.portReady
  const conn = connectRpc(port)
  socket = conn.socket
  request = conn.request
}

async function main() {
  console.log('\n=== P12 磁力片源冒烟 ===\n')

  // ---- 准备素材：一个「视频」+ 一个说明文件（验证选片会跳过后者的体积干扰）----
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-p12-'))
  const payloadDir = path.join(workspace, 'payload')
  fs.mkdirSync(payloadDir, { recursive: true })
  const videoBytes = Buffer.alloc(3 * 1024 * 1024)
  for (let i = 0; i < videoBytes.length; i++) videoBytes[i] = (i * 31 + 7) & 0xff
  fs.writeFileSync(path.join(payloadDir, 'movie.2026.1080p.mp4'), videoBytes)
  fs.writeFileSync(path.join(payloadDir, 'readme.txt'), 'PolyFrame P12 smoke payload\n')
  fs.writeFileSync(path.join(payloadDir, 'movie.sample.mp4'), Buffer.alloc(64 * 1024, 1))
  const videoHash = sha256(videoBytes)

  // ---- 起做种器 ----
  seeder = startSeeder(payloadDir)
  const { magnet, peer } = await seeder.ready
  check('本机做种器就绪（magnet + peer）', magnet.startsWith('magnet:?xt=urn:btih:') && /:\d+$/.test(peer), peer)

  // ---- 起内核 ----
  const appData = path.join(workspace, 'appdata')
  await bootCore(appData)

  // A. 参数校验
  let badMsg = ''
  try {
    await request('magnet.add', { url: '这不是磁力链接' })
  } catch (e) {
    badMsg = e.message
  }
  check('非法地址被拒绝且文案可读', /看不懂这个链接|磁力/.test(badMsg), badMsg.slice(0, 40))

  const l0 = await request('magnet.list')
  check('新装磁力任务为空', Array.isArray(l0.tasks) && l0.tasks.length === 0)

  // B. 建任务（直连 peer，不依赖 DHT）
  const added = await request('magnet.add', { url: magnet, initialPeers: [peer] })
  const taskId = added.task?.id
  check('建任务立即返回（不等元数据）', !!taskId && ['adding', 'downloading'].includes(added.task.status), added.task?.status)

  // F. 未下完不许播（刚建任务时状态还是 adding/downloading）
  let playErr = ''
  try {
    await request('magnet.play', { id: taskId })
  } catch (e) {
    playErr = e.message
  }
  check('未下完播放被拒绝且说明原因', /还没下完/.test(playErr), playErr.slice(0, 40))

  // C/D. 等下载完成
  let task = null
  let doneOk = false
  for (let i = 0; i < 120; i++) {
    const l = await request('magnet.list')
    task = l.tasks.find((t) => t.id === taskId)
    if (task && (task.status === 'done' || task.status === 'error')) {
      doneOk = task.status === 'done'
      break
    }
    await sleep(500)
  }
  check('下载完成（状态 done）', doneOk, task ? `${task.status} ${task.doneBytes}/${task.totalBytes}` : '未取到任务')
  if (!doneOk) throw new Error(`任务未完成: ${JSON.stringify(task)}`)

  check(
    '自动挑中正片（跳过 readme/sample）',
    task.fileName === 'movie.2026.1080p.mp4',
    task.fileName ?? ''
  )
  check('文件长度与源一致', task.fileLen === videoBytes.length, `${task.fileLen} vs ${videoBytes.length}`)
  check('种子文件列表已回传', Array.isArray(task.files) && task.files.length === 3, `${task.files?.length} 个`)

  // E. 播放地址 + Range
  const play = await request('magnet.play', { id: taskId })
  // 重启后代理端口会变，最终 404 校验要用最新地址
  let lastPlayUrl = play.playUrl
  check('/bt 播放地址生成', /\/bt\/[0-9a-f]+\//.test(play.playUrl), play.playUrl.slice(-40))

  const full = await httpGet(play.playUrl)
  check('全量 GET 200', full.status === 200, `status=${full.status}`)
  check('全量内容与源文件字节一致', sha256(full.body) === videoHash, `${full.body.length}B`)

  const part = await httpGet(play.playUrl, { Range: 'bytes=1024-2047' })
  const expect = videoBytes.subarray(1024, 2048)
  check('Range GET 206', part.status === 206, `status=${part.status}`)
  check(
    'Content-Range 正确',
    part.headers['content-range'] === `bytes 1024-2047/${videoBytes.length}`,
    part.headers['content-range'] ?? ''
  )
  check('Range 内容正确', sha256(part.body) === sha256(expect), `${part.body.length}B`)

  // G. 重启内核：任务与文件都在，已完成的仍能播放
  try {
    socket?.destroy()
    core?.proc?.kill()
    await sleep(1200)
    await bootCore(appData)
    const after = await request('magnet.list')
    const still = after.tasks.find((t) => t.id === taskId)
    check('重启后任务仍在（状态 done）', still?.status === 'done', still?.status ?? 'lost')
    const play2 = await request('magnet.play', { id: taskId })
    lastPlayUrl = play2.playUrl
    const full2 = await httpGet(play2.playUrl)
    check('重启后仍可播放且内容一致', full2.status === 200 && sha256(full2.body) === videoHash, `status=${full2.status}`)
  } catch (e) {
    check('重启后仍可播放且内容一致', false, e.message)
  }

  // H. 重复添加同一磁力 → 复用既有任务（不产生第二条记录）
  const dup = await request('magnet.add', { url: magnet, initialPeers: [peer] })
  check('重复添加复用既有任务', dup.task?.id === taskId && dup.duplicated === true, dup.task?.id ?? '')

  // I. 删除（连文件）
  const rm = await request('magnet.remove', { id: taskId, deleteFiles: true })
  check('删除返回 removed', rm.removed === true)
  const l1 = await request('magnet.list')
  check('任务列表清空', l1.tasks.length === 0, `${l1.tasks.length} 个`)

  const after = await httpGet(lastPlayUrl)
  check('删除后 /bt 归档为 404', after.status === 404, `status=${after.status}`)

  socket?.destroy()
}

main()
  .catch((e) => {
    check('执行未抛异常', false, e.message)
  })
  .finally(async () => {
    try {
      core?.proc?.kill()
    } catch {}
    try {
      seeder?.proc?.kill()
    } catch {}
    await sleep(400)
    try {
      fs.rmSync(workspace, { recursive: true, force: true })
    } catch {}
    const passed = results.filter((r) => r.ok).length
    console.log(`\n合计 ${passed}/${results.length} 项通过\n`)
    process.exit(passed === results.length ? 0 : 1)
  })
