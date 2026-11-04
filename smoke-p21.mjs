#!/usr/bin/env node
/**
 * P21 回归：直链失败与 mpv 入口的确定性验证（不依赖外网）
 *
 * 用本地 HTTP 服务器扮演片源，精确制造三种源站行为：
 *   1) 正常 master + media playlist         → task.create 成功、四级验证全通
 *   2) 直链 404（采集数据滞后）              → 必须直接报 404 + 处置建议，且不再走页面提取
 *   3) 直链 403（防盗链/风控）               → 必须报 403 + 处置建议
 *   4) 建任务后源站掉线                      → /master.m3u8 必须退回本地清单（不得 502，mpv 不能黑屏）
 *
 * 用法：node smoke-p21.mjs
 */
import { spawn } from 'node:child_process'
import net from 'node:net'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-p20-'))
const CORE = path.join('apps', 'core', 'target', 'release', 'pf-core.exe')

// ---------------- 假片源 ----------------
const MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:4.0,
seg0.ts
#EXTINF:4.0,
seg1.ts
#EXTINF:4.0,
seg2.ts
#EXT-X-ENDLIST
`
const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=400000,RESOLUTION=640x360
v360/index.m3u8
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=1600000,RESOLUTION=1280x720
v720/index.m3u8
`
const TS = Buffer.concat([Buffer.from([0x47]), Buffer.alloc(4095, 0x11)])

let mode = 'ok' // ok | 404 | 403
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0]
  if (mode !== 'ok') {
    res.writeHead(mode === '404' ? 404 : 403, { 'content-type': 'text/html' })
    return res.end(`<html><body>${mode} from edge</body></html>`)
  }
  if (url === '/master.m3u8') {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
    return res.end(MASTER)
  }
  if (url === '/v720/index.m3u8' || url === '/v360/index.m3u8') {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
    return res.end(MEDIA)
  }
  if (url.endsWith('.ts')) {
    res.writeHead(200, { 'content-type': 'video/mp2t' })
    return res.end(TS)
  }
  res.writeHead(404)
  res.end('not found')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const ORIGIN = `http://127.0.0.1:${server.address().port}`

// ---------------- 内核 ----------------
const child = spawn(CORE, [], {
  env: { ...process.env, PF_NO_MPV: '1', LOCALAPPDATA: TMP },
  stdio: ['pipe', 'pipe', 'pipe']
})
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
      const m = JSON.parse(line)
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m)
        pending.delete(m.id)
      }
    } catch {
      /* 非 JSON */
    }
  }
})
let id = 0
const rpc = (method, params, ms = 80000) =>
  new Promise((resolve) => {
    const rid = `s${++id}`
    const timer = setTimeout(() => {
      pending.delete(rid)
      resolve({ error: { message: '客户端超时' } })
    }, ms)
    pending.set(rid, (m) => {
      clearTimeout(timer)
      resolve(m)
    })
    sock.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n')
  })

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++
    console.log(`✅ ${name}`)
  } else {
    fail++
    console.log(`❌ ${name} ${extra}`)
  }
}
const get = async (u) => {
  const r = await fetch(u, { signal: AbortSignal.timeout(15000) })
  const t = await r.text()
  return { status: r.status, text: t }
}

// 1) 正常链路
const okTask = await rpc('task.create', { url: `${ORIGIN}/master.m3u8`, cacheMode: 'stream' })
check('正常 master：create 成功', !okTask.error, JSON.stringify(okTask.error))
const task = okTask.result?.task
check('正常 master：返回 hls 任务 + masterUrl', task?.protocol === 'hls' && !!task?.masterUrl, JSON.stringify(task))

const pl = await get(task.playUrl)
check('正常 master：本地 playlist 为 media playlist（含 EXTINF）', pl.status === 200 && /#EXTINF:4/.test(pl.text), `${pl.status} ${pl.text.slice(0, 60)}`)

// 分片行是 /seg/{token}/{task}/{seq} 相对路径，必须相对 playUrl 解析
const segLine = pl.text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'))
const seg = await get(new URL(segLine, task.playUrl).toString())
check('正常 master：分片可下载且为 TS', seg.status === 200 && seg.text.length > 0)

const m = await get(task.masterUrl)
check('正常 master：/master.m3u8 透传 2 个 variant', m.status === 200 && (m.text.match(/#EXT-X-STREAM-INF/g) ?? []).length === 2, m.text.slice(0, 80))

// 2) 源站掉线后 master 入口不得 502（mpv 黑屏根因）
server.close()
await new Promise((r) => setTimeout(r, 300))
const mDead = await get(task.masterUrl)
check('源站掉线：/master.m3u8 退回本地清单而非 502', mDead.status === 200 && mDead.text.includes('#EXTM3U'), `${mDead.status} ${mDead.text.slice(0, 80)}`)
const plDead = await get(task.playUrl)
check('源站掉线：本地 playlist 仍可用（已解析 IR 不依赖回源）', plDead.status === 200 && plDead.text.includes('#EXTINF'), `${plDead.status}`)

// 3) 直链 404 / 403 的错误信息
const server2 = http.createServer((req, res) => {
  res.writeHead(mode === '404' ? 404 : 403, { 'content-type': 'text/html' })
  res.end('<html><body>edge refused</body></html>')
})
await new Promise((r) => server2.listen(0, '127.0.0.1', r))
const O2 = `http://127.0.0.1:${server2.address().port}`

mode = '404'
const t404 = await rpc('task.create', { url: `${O2}/missing/index.m3u8`, cacheMode: 'stream' })
const msg404 = String(t404.error?.message ?? '')
check('404 直链：报「已无此文件」建议', /404/.test(msg404) && /换源/.test(msg404), msg404)
check('404 直链：不再出现误导性的「页面未发现 m3u8」', !/页面未发现/.test(msg404), msg404)

mode = '403'
const t403 = await rpc('task.create', { url: `${O2}/locked/index.m3u8`, cacheMode: 'stream' })
const msg403 = String(t403.error?.message ?? '')
check('403 直链：报防盗链/风控建议', /403/.test(msg403) && /防盗链|风控/.test(msg403), msg403)
check('403 直链：不再出现「页面未发现 m3u8」', !/页面未发现/.test(msg403), msg403)

// 4) 非媒体页仍应走站点提取（不能被上面的改动误伤）
const server3 = http.createServer((req, res) => {
  if (req.url === '/play/abc') {
    res.writeHead(200, { 'content-type': 'text/html' })
    return res.end(`<!doctype html><html><body><script>var u="/hls/x/index.m3u8"</script></body></html>`)
  }
  if (req.url === '/hls/x/index.m3u8') {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
    return res.end(MEDIA)
  }
  if (req.url.endsWith('.ts')) {
    res.writeHead(200, { 'content-type': 'video/mp2t' })
    return res.end(TS)
  }
  res.writeHead(404)
  res.end('nf')
})
await new Promise((r) => server3.listen(0, '127.0.0.1', r))
const O3 = `http://127.0.0.1:${server3.address().port}`
const tPage = await rpc('task.create', { url: `${O3}/play/abc`, cacheMode: 'stream' })
check('HTML 播放页：站点提取兜底仍生效', !tPage.error, String(tPage.error?.message ?? ''))

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
child.kill()
server2.close()
server3.close()
fs.rmSync(TMP, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
