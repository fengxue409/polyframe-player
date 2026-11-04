/**
 * P16 网盘 × 收藏体系打通 无头冒烟测试（全本地，不依赖真实网盘）
 *
 * 用假「HTTP 目录网关」验证 netdisk.favorite 与追更分支：
 *  A. 目录收藏 = 剧集：视频文件自动成为剧集快照（shim URL），非视频剔除
 *  B. 幂等：同目录重复收藏不重复挂源
 *  C. 同名归并：另一账号收藏同名目录 → 归并同一条收藏（多源）
 *  D. 单文件收藏 = 电影：文件名去扩展名
 *  E. 进度打通：progress.set 挂 favoriteId → 继续观看列表可见
 *  F. 追更：目录新增视频 → favorite.refresh 检出 added 并回写快照
 *  G. 清理
 *
 * 运行：node apps/core/scripts/smoke-p16.mjs（需先 cargo build --release -p pf-core）
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import { existsSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
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

const TOKEN = 'tok-ok'
const FILE = Buffer.alloc(256 * 1024)
for (let i = 0; i < FILE.length; i++) FILE[i] = (i * 17 + 3) & 0xff

/** 假网关：目录可变（追更用）+ 短命直链 + Range */
function startGateway() {
  const DIRS = {
    root: [
      { id: 'dx', name: '剧集X', isDir: true },
      { id: 'mv1', name: '流浪地球2.mp4', isDir: false, size: FILE.length }
    ],
    dx: [
      { id: 'e1', name: '第01集.mp4', isDir: false, size: FILE.length },
      { id: 'e2', name: '第02集.mp4', isDir: false, size: FILE.length },
      { id: 'e3', name: '第03集.mkv', isDir: false, size: FILE.length },
      { id: 'cover', name: '封面.jpg', isDir: false, size: 64 }
    ]
  }

  function sendJson(res, code, obj) {
    const body = JSON.stringify(obj)
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
    res.end(body)
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.headers['authorization'] !== `Bearer ${TOKEN}`) return sendJson(res, 401, { error: 'bad token' })

    if (u.pathname === '/api/list') {
      const dir = u.searchParams.get('dir') || 'root'
      const size = Math.max(1, Number(u.searchParams.get('size') || 100))
      const cursor = u.searchParams.get('cursor')
      const all = DIRS[dir] ?? []
      const start = cursor ? Number(cursor) : 0
      const items = all.slice(start, start + size)
      return sendJson(res, 200, {
        items: items.map((it) => ({ ...it, modifiedAt: 1_700_000_000 })),
        nextCursor: start + size < all.length ? String(start + size) : null,
        total: all.length
      })
    }
    if (u.pathname === '/api/resolve') {
      const id = u.searchParams.get('id') || ''
      return sendJson(res, 200, {
        url: `/dl/${id}?sig=s1`,
        expiresAt: Date.now() + 600_000,
        headers: {}
      })
    }
    if (u.pathname.startsWith('/dl/')) {
      const range = req.headers.range
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range)
        const start = Number(m?.[1] ?? 0)
        const end = m?.[2] ? Math.min(Number(m[2]), FILE.length - 1) : FILE.length - 1
        const chunk = FILE.subarray(start, end + 1)
        res.writeHead(206, {
          'Content-Type': 'video/mp4',
          'Content-Length': chunk.length,
          'Content-Range': `bytes ${start}-${end}/${FILE.length}`,
          'Accept-Ranges': 'bytes'
        })
        return res.end(chunk)
      }
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': FILE.length, 'Accept-Ranges': 'bytes' })
      return res.end(FILE)
    }
    sendJson(res, 404, { error: 'not found' })
  })

  let port = 0
  return {
    DIRS,
    start: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          port = server.address().port
          resolve(`http://127.0.0.1:${port}`)
        })
      }),
    close: () => server.close()
  }
}

import { mkdtempSync, rmSync } from 'node:fs'
const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'pf-p16-'))

function startCore() {
  const bin = binCandidates.find((p) => existsSync(p))
  if (!bin) throw new Error('未找到 pf-core.exe，请先构建')
  const proc = spawn(bin, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, PF_PROXY_ALLOW_PRIVATE: '1', LOCALAPPDATA: dataRoot }
  })
  const portsReady = new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error('等待端口发现超时')), 25000)
    const onData = (d) => {
      buf += d.toString()
      const core = buf.match(/PF_CORE_PORT=(\d+)/)
      const proxy = buf.match(/PF_PROXY_PORT=(\d+)/)
      const t = buf.match(/PF_CORE_TOKEN=([0-9a-f]+)/)
      if (t) rpcToken = t[1]
      if (core && proxy) {
        clearTimeout(timer)
        proc.stdout.off('data', onData)
        resolve({ core: Number(core[1]), proxy: Number(proxy[1]) })
      }
    }
    proc.stdout.on('data', onData)
    proc.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`内核提前退出 code=${code}`))
    })
  })
  return { proc, portsReady }
}

let rpcToken = ''
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
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
        else resolve(msg.result)
      }
    }
  })
  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`RPC 超时: ${method}`))
        }
      }, 20000)
    })
  const close = () => socket.destroy()
  return { rpc, close }
}

const parseEps = (v) => (typeof v === 'string' ? JSON.parse(v) : v)
// ================= 主流程 =================
const gw = startGateway()
const gwUrl = await gw.start()
const core = startCore()
const { core: corePort } = await core.portsReady
const { rpc, close } = connectRpc(corePort)

try {
  // ---------- 准备：两个账号 ----------
  const addA = await rpc('netdisk.account.add', { provider: 'http', name: '账号A', baseUrl: gwUrl, accessToken: 'tok-ok' })
  const addB = await rpc('netdisk.account.add', { provider: 'http', name: '账号B', baseUrl: gwUrl, accessToken: 'tok-ok' })
  const acctA = addA.account.id
  const acctB = addB.account.id

  console.log('\n[A] 目录收藏 = 剧集')
  const r1 = await rpc('netdisk.favorite.add', { accountId: acctA, dirId: 'dx', name: '剧集X' })
  const fav1 = r1.favorite
  check('收藏返回 favorite 且名称正确', fav1?.name === '剧集X')
  check('type_name = 网盘', fav1?.typeName === '网盘')
  check('remarks 含网盘标识与账号名', typeof fav1?.remarks === 'string' && fav1.remarks.includes('HTTP') && fav1.remarks.includes('账号A'), fav1?.remarks)
  const srcs1 = (await rpc('catalog.favorite.sources', { id: fav1.id })).sources
  check('片源 site_name = 网盘·HTTP 目录网关·账号A', srcs1.length === 1 && srcs1[0].siteName === '网盘·HTTP 目录网关·账号A', srcs1[0]?.siteName)
  check('片源 origin = netdisk 且 api 引用形态正确', srcs1[0].origin === 'netdisk' && srcs1[0].api === `netdisk:a-${acctA}:dx`, srcs1[0]?.api)
  const eps1 = parseEps(srcs1[0].episodes)
  check('目录内 3 个视频 → 3 集（非视频剔除）', eps1.length === 3, `n=${eps1.length}`)
  check('集名去扩展名', eps1[0].name === '第01集' && eps1[2].name === '第03集', eps1.map((e) => e.name).join('/'))
  check(
    '集 URL 为稳定 shim 形态',
    eps1.every((e) => new RegExp(`^http://127\\.0\\.0\\.1:\\d+/nd/[0-9a-f]{16,}/a-${acctA}/e\\d+/v\\.mp4$`).test(e.url)),
    eps1[0]?.url?.slice(0, 60)
  )

  console.log('\n[B] 幂等 + 同名归并')
  const r2 = await rpc('netdisk.favorite.add', { accountId: acctA, dirId: 'dx', name: '剧集X' })
  check('重复收藏归并同一条收藏', r2.favorite.id === fav1.id)
  const srcs2 = (await rpc('catalog.favorite.sources', { id: fav1.id })).sources
  check('重复收藏不重复挂源（幂等）', srcs2.length === 1, `n=${srcs2.length}`)
  const r3 = await rpc('netdisk.favorite.add', { accountId: acctB, dirId: 'dx', name: '剧集X' })
  check('另一账号收藏同名目录 → 归并同一条收藏', r3.favorite.id === fav1.id)
  const srcs3 = (await rpc('catalog.favorite.sources', { id: fav1.id })).sources
  check('多账号同名合并为两个片源', srcs3.length === 2 && srcs3.every((s) => s.origin === 'netdisk'), `n=${srcs3.length}`)

  console.log('\n[C] 单文件收藏 = 电影')
  const r4 = await rpc('netdisk.favorite.add', { accountId: acctA, fileId: 'mv1', name: '流浪地球2.mp4' })
  const fav2 = r4.favorite
  check('电影收藏独立成条（不同名）', fav2.id !== fav1.id && fav2.name === '流浪地球2', fav2?.name)
  const srcs4 = (await rpc('catalog.favorite.sources', { id: fav2.id })).sources
  const eps4 = parseEps(srcs4[0].episodes)
  check('单文件 → 1 集', eps4.length === 1)
  check('文件名去扩展名作为条目名', eps4[0].name === '流浪地球2', eps4[0]?.name)
  // 空目录收藏应报错
  let emptyErr = ''
  try {
    await rpc('netdisk.account.add', { provider: 'http', name: '账号C', baseUrl: gwUrl, accessToken: 'tok-ok' })
    // root 下没有空目录可收藏单文件以外的场景：收藏不存在的目录
    await rpc('netdisk.favorite.add', { accountId: acctA, dirId: 'nope', name: '不存在' })
  } catch (e) {
    emptyErr = e.message
  }
  check('收藏不存在的目录被拒绝', /读取目录失败|没有可播放|list/i.test(emptyErr), emptyErr.slice(0, 60))

  console.log('\n[D] 进度打通（继续观看）')
  const progUrl = eps4[0].url
  await rpc('catalog.favorite.progress.set', {
    favoriteId: fav2.id,
    episodeName: '流浪地球2',
    episodeUrl: progUrl,
    position: 600,
    duration: 7200
  })
  const prog = (await rpc('catalog.progress.list', { limit: 20 })).items
  const hit = prog.find((p) => p.favoriteId === fav2.id)
  check('进度记录挂在网盘收藏上', !!hit && hit.positionSec === 600 && hit.episodeUrl === progUrl, hit ? `${hit.favoriteName} ${hit.positionSec}s` : '未找到')

  console.log('\n[E] 追更：目录新增视频')
  gw.DIRS.dx.push({ id: 'e4', name: '第04集.mp4', isDir: false, size: FILE.length })
  const ref = await rpc('catalog.favorite.refresh', {})
  const up = ref.updated.find((u) => u.favoriteId === fav1.id)
  check('refresh 检出网盘片源更新', !!up && up.added === 1, up ? `old=${up.oldCount} new=${up.newCount}` : '未检出')
  const srcs5 = (await rpc('catalog.favorite.sources', { id: fav1.id })).sources
  const epsA = parseEps(srcs5.find((s) => s.api === `netdisk:a-${acctA}:dx`).episodes)
  check('快照回写为 4 集', epsA.length === 4 && epsA[3].name === '第04集', `n=${epsA.length}`)
  // 再次 refresh：无新增不动
  const ref2 = await rpc('catalog.favorite.refresh', {})
  check('无新增时不再报更新', !ref2.updated.some((u) => u.favoriteId === fav1.id))

  console.log('\n[F] 清理')
  const rm1 = await rpc('catalog.favorite.remove', { id: fav1.id })
  const rm2 = await rpc('catalog.favorite.remove', { id: fav2.id })
  check('收藏删除成功', rm1.removed === true && rm2.removed === true)
  const progAfter = (await rpc('catalog.progress.list', { limit: 20 })).items
  check('删收藏联动清进度', !progAfter.some((p) => p.favoriteId === fav2.id))
  await rpc('netdisk.account.remove', { id: acctA })
  await rpc('netdisk.account.remove', { id: acctB })
  check('账号清理成功', true)
} catch (e) {
  check(`主流程异常中断: ${e.message}`, false)
} finally {
  close()
  core.proc.kill()
  gw.close()
  try { rmSync(dataRoot, { recursive: true, force: true }) } catch {}
}

const pass = results.filter((r) => r.ok).length
console.log(`\n${GREEN}P16 网盘收藏冒烟：${pass}/${results.length}${RESET}`)
process.exit(pass === results.length ? 0 : 1)
