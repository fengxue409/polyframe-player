/**
 * P9b 网盘视频源无头冒烟测试（全本地，不依赖真实网盘）
 *
 * 用一个「HTTP 目录网关」假 origin 跑通插件契约（apps/core/crates/pf-netdisk/src/http.rs 顶部）：
 *  A. 适配器能力表 + 分享链接解析（百度/阿里云盘/OneDrive，纯逻辑）
 *  B. 账号鉴权：错 token 拒绝 / 正确 token 入库并回显延迟
 *  C. 目录分页：游标翻页 2+2+1，到底后 nextCursor 为空；子目录独立分页
 *  D. 播放地址：shim URL 形态（/nd/…/v.mp4）+ 直链有效期
 *  E. shim 透传：无 Range → 200 全量；带 Range → 206 精确区间；provider 头已注入
 *  F. 直链缓存：重复请求不再换链（resolve 计数不增）
 *  G. **有效期刷新机制**：服务端作废旧签名 → shim 请求 403 → 自动强制换链 → 200
 *  H. 加入任务：走既有 MP4 分块管线（playUrl=/file/…、segTotal>0、/file Range 字节一致）
 *  I. 账号续期：refresh 回源并回写 expiresAt
 *  J. 分享不支持提示 + 参数校验 + 删账号
 *
 * 运行：node apps/core/scripts/smoke-netdisk.mjs（需先 pnpm core:build）
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

const TOKEN = 'tok-ok'
/** 1MiB 确定性内容（首字节 0x47 无意义，引擎只按字节搬运） */
const FILE = Buffer.alloc(1024 * 1024)
for (let i = 0; i < FILE.length; i++) FILE[i] = (i * 31 + 7) & 0xff

/** 假「HTTP 目录网关」：分页 + 短命直链（可主动作废）+ Range */
function startGateway() {
  const state = {
    sig: 'sig-1',
    seq: 0,
    resolveHits: 0,
    refreshHits: 0,
    listHits: 0,
    /** 上次 /dl 收到的 provider 头（验证注入） */
    lastAuth: '',
    lastCustom: '',
    expire() {
      state.seq++
      state.sig = `sig-${state.seq + 1}`
    }
  }

  const DIRS = {
    root: [
      { id: 'd1', name: '电影', isDir: true },
      { id: 'd2', name: '剧集', isDir: true },
      { id: 'f1', name: '预告片.mp4', isDir: false, size: FILE.length },
      { id: 'f2', name: '花絮.mkv', isDir: false, size: FILE.length },
      { id: 'f3', name: '说明.txt', isDir: false, size: 128 }
    ],
    d1: [
      { id: 'f1', name: '预告片.mp4', isDir: false, size: FILE.length },
      { id: 'f2', name: '花絮.mkv', isDir: false, size: FILE.length }
    ],
    d2: []
  }

  function sendJson(res, code, obj) {
    const body = JSON.stringify(obj)
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
    res.end(body)
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1')
    const auth = req.headers['authorization'] ?? ''

    // ---- 目录 ----
    if (u.pathname === '/api/list') {
      state.listHits++
      if (auth !== `Bearer ${TOKEN}`) return sendJson(res, 401, { error: 'bad token' })
      const dir = u.searchParams.get('dir') || 'root'
      const size = Math.max(1, Number(u.searchParams.get('size') || 100))
      const cursor = u.searchParams.get('cursor')
      const all = DIRS[dir] ?? []
      if (cursor === 'bogus') return sendJson(res, 400, { error: 'bad cursor' })
      const start = cursor ? Number(cursor) : 0
      const items = all.slice(start, start + size)
      const next = start + size < all.length ? String(start + size) : null
      return sendJson(res, 200, {
        items: items.map((it) => ({ ...it, modifiedAt: 1_700_000_000 })),
        nextCursor: next,
        total: all.length
      })
    }

    // ---- 解析直链（每次换链都会 +1） ----
    if (u.pathname === '/api/resolve') {
      if (auth !== `Bearer ${TOKEN}`) return sendJson(res, 401, { error: 'bad token' })
      state.resolveHits++
      const id = u.searchParams.get('id') || ''
      return sendJson(res, 200, {
        url: `/dl/${id}?sig=${state.sig}`,
        // 90s：>60s skew → 缓存有效；作废后靠 403 兜底换链
        expiresAt: Date.now() + 90_000,
        headers: { 'X-Gw-Header': 'injected' }
      })
    }

    // ---- 续期 ----
    if (u.pathname === '/api/refresh' && req.method === 'POST') {
      state.refreshHits++
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        sendJson(res, 200, { accessToken: TOKEN, expiresAt: Date.now() + 3600_000, refreshToken: TOKEN })
      })
      return
    }

    // ---- 文件（短命签名 + Range） ----
    if (u.pathname.startsWith('/dl/')) {
      state.lastAuth = auth
      state.lastCustom = String(req.headers['x-gw-header'] ?? '')
      if (auth !== `Bearer ${TOKEN}`) return sendJson(res, 401, { error: 'bad token' })
      if (u.searchParams.get('sig') !== state.sig) return sendJson(res, 403, { error: 'signature expired' })
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
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': FILE.length,
        'Accept-Ranges': 'bytes'
      })
      return res.end(FILE)
    }

    sendJson(res, 404, { error: 'not found' })
  })

  let port = 0
  return {
    state,
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

function startCore(envOverride = {}) {
  const bin = binCandidates.find((p) => existsSync(p))
  if (!bin) throw new Error('未找到 pf-core.exe，请先执行: pnpm core:build')
  const proc = spawn(bin, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...envOverride, PF_PROXY_ALLOW_PRIVATE: '1' } // M5/L1：本地测试源需放开私网目标
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
      }, 120000)
      pending.set(id, { resolve, reject, timer })
      socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  return { socket, request }
}

async function httpGet(url, headers = {}) {
  const resp = await fetch(url, { headers })
  const buf = Buffer.from(await resp.arrayBuffer())
  return { status: resp.status, headers: resp.headers, buf }
}

let proc = null
let gateway = null

try {
  gateway = startGateway()
  const base = await gateway.start()
  console.log(`${DIM}假网关: ${base}${RESET}`)

  const bin = binCandidates.find((p) => existsSync(p))
  console.log(`${DIM}启动内核: ${bin}${RESET}`)
  const started = startCore({
    LOCALAPPDATA: path.join(process.env.TEMP ?? '.', `pf-smoke-netdisk-${process.pid}`)
  })
  proc = started.proc
  const { core: corePort, proxy: proxyPort } = await started.portsReady
  const { request } = connectRpc(corePort)
  await request('core.hello')

  // ============ A 能力表 + 分享解析 ============
  console.log(`\n${DIM}—— A 适配器能力 / 分享解析 ——${RESET}`)
  const prov = await request('netdisk.providers')
  const kinds = prov.providers.map((p) => p.kind)
  check(
    '暴露 4 个适配器（baidu/aliyun/onedrive/http）',
    ['baidu', 'aliyun', 'onedrive', 'http'].every((k) => kinds.includes(k)),
    kinds.join(',')
  )
  const baiduProv = prov.providers.find((p) => p.kind === 'baidu')
  const aliProv = prov.providers.find((p) => p.kind === 'aliyun')
  check(
    '能力字段完整（授权方式 / 是否支持分享）',
    baiduProv.authModes.includes('cookie') &&
      aliProv.authModes.includes('token') &&
      aliProv.supportsShare === true &&
      baiduProv.supportsShare === false
  )

  const pBaidu = await request('netdisk.share.parse', { url: 'https://pan.baidu.com/s/1AbCdEf?pwd=xy12' })
  const pAli = await request('netdisk.share.parse', { url: 'https://www.alipan.com/s/shr123' })
  const pOd = await request('netdisk.share.parse', { url: 'https://1drv.ms/u/s!Ap123' })
  check(
    '分享链接识别三家网盘并提取提取码',
    pBaidu.provider === 'baidu' && pBaidu.pwd === 'xy12' && pAli.provider === 'aliyun' && pOd.provider === 'onedrive',
    `${pBaidu.provider}/${pAli.provider}/${pOd.provider}`
  )
  let parseErr = ''
  try {
    await request('netdisk.share.parse', { url: 'https://example.com/x' })
  } catch (e) {
    parseErr = e.message
  }
  check('未知分享链接报错', /暂不支持/.test(parseErr), parseErr)

  // ============ B 账号鉴权 ============
  console.log(`\n${DIM}—— B 账号鉴权 ——${RESET}`)
  let badTokenErr = ''
  try {
    await request('netdisk.account.add', { provider: 'http', baseUrl: base, accessToken: 'wrong' })
  } catch (e) {
    badTokenErr = e.message
  }
  check('错误 token 不入库并报错', /401|授权校验失败/.test(badTokenErr), badTokenErr)

  const added = await request('netdisk.account.add', {
    provider: 'http',
    baseUrl: base,
    accessToken: TOKEN,
    name: '冒烟网关'
  })
  const accId = added.account.id
  check('正确 token 入库并回显延迟', added.account.name === '冒烟网关' && added.probe.latencyMs >= 0, `${added.probe.latencyMs}ms`)
  check('账号出参不含凭据字段', added.account.cred === undefined && added.account.cookie === undefined)

  const accList = await request('netdisk.account.list')
  check('账号列表可读（1 个）', accList.accounts.length === 1 && accList.accounts[0].needReauth === false)

  // ============ C 目录分页 ============
  console.log(`\n${DIM}—— C 目录分页 ——${RESET}`)
  const p1 = await request('netdisk.list', { accountId: accId, pageSize: 2 })
  check('首页 2 项且有 nextCursor', p1.items.length === 2 && !!p1.nextCursor, `cursor=${p1.nextCursor}`)
  const p2 = await request('netdisk.list', { accountId: accId, pageSize: 2, cursor: p1.nextCursor })
  check('第二页 2 项仍有 nextCursor', p2.items.length === 2 && !!p2.nextCursor, `cursor=${p2.nextCursor}`)
  const p3 = await request('netdisk.list', { accountId: accId, pageSize: 2, cursor: p2.nextCursor })
  check('第三页 1 项且到底（nextCursor 为空）', p3.items.length === 1 && !p3.nextCursor)
  check(
    '条目归类（目录/视频/其他）',
    p1.items[0].isDir === true &&
      p1.items[0].kind === 'dir' &&
      [...p2.items, ...p3.items].some((i) => i.kind === 'video') &&
      [...p2.items, ...p3.items].some((i) => i.kind === 'other')
  )
  check('目录名/大小回带', p1.items[0].name === '电影' && typeof p1.items[0].size === 'number')
  check('时间戳秒 → 毫秒归一', typeof p1.items[0].modifiedAt === 'number' && p1.items[0].modifiedAt > 1e12)
  const sub = await request('netdisk.list', { accountId: accId, dirId: 'd1' })
  check('子目录独立列举（2 项）', sub.items.length === 2 && sub.items.every((i) => i.kind === 'video'))

  // ============ D 播放地址 ============
  console.log(`\n${DIM}—— D 播放地址 ——${RESET}`)
  const play = await request('netdisk.resolve', { accountId: accId, fileId: 'f1' })
  check(
    'shim 地址形态正确（/nd/…/v.mp4）',
    play.url.includes(`:${proxyPort}/nd/`) && play.url.endsWith('/v.mp4'),
    play.url.replace(/\/nd\/[0-9a-f]+/, '/nd/<secret>')
  )
  check('直链有效期回带（>60s）', play.expiresInSecs >= 60, `${play.expiresInSecs}s`)
  check('注入头数量回带（>=1）', play.headerCount >= 1, `${play.headerCount}`)
  check('直链主机（诊断字段）', play.host === `127.0.0.1:${new URL(base).port}` || play.host === new URL(base).host, play.host)

  // ============ E shim 透传（200 / 206 / 头注入） ============
  console.log(`\n${DIM}—— E shim 透传 ——${RESET}`)
  const full = await httpGet(play.url)
  check('无 Range → 200 且字节数一致', full.status === 200 && full.buf.length === FILE.length, `${full.buf.length}B`)
  check('内容与源文件一致', full.buf.equals(FILE))
  check(
    'provider 请求头已注入（Authorization + 自定义头）',
    gateway.state.lastAuth === `Bearer ${TOKEN}` && gateway.state.lastCustom === 'injected',
    `${gateway.state.lastAuth} / ${gateway.state.lastCustom}`
  )

  const ranged = await httpGet(play.url, { Range: 'bytes=100-199' })
  check(
    '带 Range → 206 精确区间 + Content-Range',
    ranged.status === 206 &&
      ranged.buf.length === 100 &&
      ranged.headers.get('content-range') === `bytes 100-199/${FILE.length}`,
    `${ranged.status} ${ranged.headers.get('content-range')}`
  )
  check('区间字节正确', ranged.buf.equals(FILE.subarray(100, 200)))

  // ============ F 直链缓存 ============
  console.log(`\n${DIM}—— F 直链缓存 ——${RESET}`)
  const hitsBefore = gateway.state.resolveHits
  await httpGet(play.url, { Range: 'bytes=0-99' })
  await httpGet(play.url, { Range: 'bytes=200-299' })
  check('命中缓存：重复播放不重复换链', gateway.state.resolveHits === hitsBefore, `${hitsBefore} → ${gateway.state.resolveHits}`)

  // ============ G 有效期刷新机制（403 → 强制换链） ============
  console.log(`\n${DIM}—— G 直链过期/403 自动换链 ——${RESET}`)
  gateway.state.expire()
  const stale = await httpGet(play.url, { Range: 'bytes=0-63' })
  check(
    '直链作废后 shim 仍可播（代理内部换链，206 + 正确字节）',
    stale.status === 206 && stale.buf.length === 64 && stale.buf.equals(FILE.subarray(0, 64)),
    `${stale.status} ${stale.buf.length}B`
  )
  check('换链确实发生（resolve 计数 +1）', gateway.state.resolveHits === hitsBefore + 1, `${gateway.state.resolveHits}`)

  // ============ H 加入任务（复用 MP4 分块管线） ============
  console.log(`\n${DIM}—— H 加入任务 ——${RESET}`)
  const taskRes = await request('netdisk.play', { accountId: accId, fileId: 'f1', name: '预告片.mp4', cacheMode: 'stream' })
  const task = taskRes.task
  check('任务协议判定为 mp4（走分块管线）', task.protocol === 'mp4', task.protocol)
  check('playUrl 指向本地虚拟文件', (task.playUrl ?? '').includes('/file/'), task.playUrl)
  check('任务标题使用文件名', task.title === '预告片.mp4', task.title)

  // 等首块下载完成
  let segTotal = 0
  for (let i = 0; i < 60; i++) {
    const list = await request('task.list')
    const t = list.tasks.find((x) => x.id === task.id)
    segTotal = t?.segTotal ?? 0
    if ((t?.segDone ?? 0) >= segTotal && segTotal > 0) break
    await new Promise((r) => setTimeout(r, 200))
  }
  check('分片清单已生成（1MiB → 1 块）', segTotal >= 1, `segTotal=${segTotal}`)

  const viaFile = await httpGet(task.playUrl, { Range: 'bytes=0-1023' })
  check(
    '/file Range 回包字节与网盘源一致',
    viaFile.status === 206 && viaFile.buf.length === 1024 && viaFile.buf.equals(FILE.subarray(0, 1024)),
    `${viaFile.status} ${viaFile.buf.length}B`
  )

  // ============ I 账号续期 ============
  console.log(`\n${DIM}—— I 账号续期 ——${RESET}`)
  const beforeRefresh = gateway.state.refreshHits
  const refreshed = await request('netdisk.account.refresh', { id: accId })
  check(
    '续期回源并回写新过期时刻',
    gateway.state.refreshHits === beforeRefresh + 1 && (refreshed.account.expiresAt ?? 0) > Date.now(),
    `expiresAt=${refreshed.account.expiresAt}`
  )
  check('续期后状态复位为 ok', refreshed.account.status === 'ok' && refreshed.account.needReauth === false)

  // ============ J 分享不支持 / 参数校验 / 清理 ============
  console.log(`\n${DIM}—— J 边界与清理 ——${RESET}`)
  let shareErr = ''
  try {
    await request('netdisk.share.add', { url: 'https://pan.baidu.com/s/1AbCdEf' })
  } catch (e) {
    shareErr = e.message
  }
  check('分享不支持时给出可操作提示', /暂不支持分享|需要先添加/.test(shareErr), shareErr)

  let paramErr = ''
  try {
    await request('netdisk.list', {})
  } catch (e) {
    paramErr = e.message
  }
  check('缺 accountId/shareId 报参数错误', /网盘账号不存在|需要 accountId/.test(paramErr), paramErr)

  let fileErr = ''
  try {
    await request('netdisk.resolve', { accountId: accId })
  } catch (e) {
    fileErr = e.message
  }
  check('缺 fileId 报参数错误', /fileId required/.test(fileErr), fileErr)

  const del = await request('netdisk.account.remove', { id: accId })
  const after = await request('netdisk.account.list')
  check('删除账号后列表清空', del.removed === true && after.accounts.length === 0)
} catch (e) {
  check('未捕获异常', false, e.message)
} finally {
  if (gateway) gateway.close()
  if (proc) proc.kill()
  const passed = results.filter((r) => r.ok).length
  const total = results.length
  console.log(`\n${passed === total ? GREEN : RED}P9b 网盘冒烟：${passed}/${total}${RESET}\n`)
  process.exit(passed === total ? 0 : 1)
}
