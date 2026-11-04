#!/usr/bin/env node
/**
 * CORS 回归：在真实 Chromium（项目自带 Electron）里跑 hls.js，验证清单能不能被读到。
 *
 * 为什么必须用浏览器：CORS 是浏览器侧策略，curl / node fetch 完全不拦。
 * 修复前代理清单响应没有 `Access-Control-Allow-Origin`，分片却有，
 * 于是 hls.js 首跳就死在 `networkError / manifestLoadError`（status 0），
 * 而服务端日志里一切都是 200 —— 极难从后端现象看出来。
 *
 * 两个用例：
 *   1. 对照组：页面在 127.0.0.1，清单取自 localhost（跨源）且服务端故意不发 ACAO
 *      → 必须复现 manifestLoadError。它证明本测试真的能检测该缺陷，而不是恒为绿。
 *   2. 正例：真实内核的代理 playlist.m3u8 → 应 MANIFEST_PARSED 并推进到 playing。
 *
 * 用法：node e2e-cors.mjs [--show]
 *   --show 会显示窗口（默认无头）。
 *
 * 踩过的坑（改脚本时注意）：
 *   · 本机 shell 带 ELECTRON_RUN_AS_NODE=1，不清掉 Electron 会退化成纯 Node；
 *   · electron.exe 必须用**相对路径** spawn，绝对路径（含空格）直接返回 -1 且无 stderr；
 *   · 入口必须是「目录 + package.json(main)」，直接给 .cjs 会被当 node 脚本；
 *   · 命令行里带 http:// 参数会让 Electron 静默拒绝启动 → 参数一律走 args.json；
 *   · Windows 上 electron.exe 是 GUI 子系统，stdout 管道拿不到 → 结果写文件。
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const SHOW = process.argv.includes('--show')
const ELECTRON = 'apps/desktop/node_modules/electron/dist/electron.exe'
const HLS_DIST = 'apps/desktop/node_modules/hls.js/dist/hls.js'
const APP_DIR = 'apps/desktop/.e2e-app'
const OUT_FILE = '.e2e-result.json'
const DEMO = 'https://sf1-cdn-tos.huoshanstatic.com/obj/media-fe/xgplayer_doc_video/hls/xgplayer-demo.m3u8'
// 可传第二个 URL 覆盖默认演示流，例如用真实采集站集数链接验一遍
const TARGET = process.argv.find((a) => a.startsWith('http')) ?? DEMO

// ---------------- 1. 真实内核建任务，拿 playUrl ----------------
async function createTask(url) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-e2e-'))
  const core = spawn(path.join('apps', 'core', 'target', 'release', 'pf-core.exe'), [], {
    env: { ...process.env, PF_NO_MPV: '1', LOCALAPPDATA: tmp },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  core.stderr.on('data', () => {})
  const boot = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('内核启动超时')), 20000)
    let port = 0
    let token = ''
    core.stdout.setEncoding('utf8')
    core.stdout.on('data', function onData(d) {
      for (const l of String(d).split('\n')) {
        let m = l.match(/^PF_CORE_PORT=(\d+)\s*$/)
        if (m) port = +m[1]
        m = l.match(/^PF_CORE_TOKEN=([0-9a-f]+)\s*$/)
        if (m) token = m[1]
      }
      if (port && token) {
        core.stdout.off('data', onData)
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
        const msg = JSON.parse(line)
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)(msg)
          pending.delete(msg.id)
        }
      } catch {}
    }
  })
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const id = `e${Math.random().toString(36).slice(2)}`
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve({ error: { message: '客户端超时' } })
      }, 90000)
      pending.set(id, (m) => {
        clearTimeout(timer)
        resolve(m)
      })
      sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  const r = await rpc('task.create', { url, cacheMode: 'stream' })
  const cleanup = () => {
    core.kill()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  if (r.error) {
    cleanup()
    throw new Error(`task.create 失败：${r.error.message}`)
  }
  return { playUrl: r.result.task.playUrl, cleanup }
}

// ---------------- 2. 测试页面 ----------------
const MINI = ['#EXTM3U', '#EXT-X-TARGETDURATION:2', '#EXT-X-VERSION:3', '#EXTINF:2.0,', '/nocors-seg.ts', '#EXT-X-ENDLIST', ''].join('\n')
const PAGE = `<!doctype html><meta charset="utf-8"><body style="background:#111">
<video id="v" muted playsinline></video>
<script src="/hls.js"></script>
<script>
window.__state = { phase: 'init' }
const src = new URLSearchParams(location.search).get('src')
const v = document.getElementById('v')
const done = (o) => { window.__state = Object.assign(window.__state, o) }
const hls = new Hls({ enableWorker: true })
hls.on(Hls.Events.MANIFEST_PARSED, (_e, d) => {
  done({ phase: 'parsed', levels: d.levels.length })
  v.play().catch((e) => done({ playErr: String((e && e.name) || e) }))
})
hls.on(Hls.Events.ERROR, (_e, d) => {
  if (d.fatal) done({ phase: 'fatal', type: d.type, details: d.details, reason: String((d.error && d.error.message) || '') })
})
hls.on(Hls.Events.FRAG_LOADED, () => done({ frags: (window.__state.frags || 0) + 1 }))
hls.loadSource(src)
hls.attachMedia(v)
setInterval(() => {
  if (v.currentTime > 0.2 && window.__state.phase === 'parsed') done({ phase: 'playing', t: v.currentTime })
}, 300)
</script>`

const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://127.0.0.1').pathname
  if (p === '/hls.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' })
    res.end(fs.readFileSync(HLS_DIST))
  } else if (p === '/nocors.m3u8') {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }) // 故意不发 ACAO
    res.end(MINI)
  } else if (p === '/nocors-seg.ts') {
    res.writeHead(200, { 'content-type': 'video/mp2t' })
    res.end(Buffer.alloc(1024))
  } else if (p === '/page.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  } else {
    res.writeHead(404).end()
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const pagePort = server.address().port

// ---------------- 3. Electron 驱动 ----------------
fs.mkdirSync(APP_DIR, { recursive: true })
fs.writeFileSync(path.join(APP_DIR, 'package.json'), JSON.stringify({ name: 'e2e-cors', main: 'main.cjs' }))
fs.writeFileSync(
  path.join(APP_DIR, 'main.cjs'),
  `const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const cfg = JSON.parse(fs.readFileSync(require('path').join(__dirname, 'args.json'), 'utf8'))
const dump = (o) => { try { fs.writeFileSync(cfg.outFile, JSON.stringify(o)) } catch {} }
process.on('uncaughtException', (e) => dump({ state: { phase: 'crash', msg: String((e && e.stack) || e).slice(0, 400) }, console: [] }))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 960, height: 600, show: cfg.mode === 'show', webPreferences: { backgroundThrottling: false } })
  const log = []
  win.webContents.on('console-message', (...a) => {
    const d = a[0] && typeof a[0] === 'object' && 'message' in a[0] ? a[0] : { level: a[1], message: a[2] }
    log.push(d.message)
  })
  await win.loadURL(cfg.pageUrl)
  let state = { phase: 'init' }
  for (let i = 0; i < 70; i++) {
    await new Promise((r) => setTimeout(r, 400))
    state = await win.webContents.executeJavaScript('window.__state || {phase:"none"}').catch(() => ({ phase: 'eval-err' }))
    if (state.phase === 'fatal' || state.phase === 'playing') break
    if (state.phase === 'parsed' && i > 8) break
  }
  dump({ state: state, console: log.filter((l) => /CORS|manifestLoadError|ERR_FAILED|Access-Control/i.test(l)).slice(0, 2) })
  app.exit(0)
}).catch((e) => {
  dump({ state: { phase: 'fail', msg: String((e && e.stack) || e).slice(0, 400) }, console: [] })
  app.exit(1)
})`
)

function runOne(label, src, waitMs) {
  return new Promise((resolve) => {
    fs.rmSync(OUT_FILE, { force: true })
    fs.writeFileSync(
      path.join(APP_DIR, 'args.json'),
      JSON.stringify({
        pageUrl: `http://127.0.0.1:${pagePort}/page.html?src=${encodeURIComponent(src)}`,
        mode: SHOW ? 'show' : 'hide',
        outFile: OUT_FILE
      })
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const p = spawn(ELECTRON, [APP_DIR], { stdio: ['ignore', 'pipe', 'pipe'], env })
    let err = ''
    p.stderr.setEncoding('utf8')
    p.stderr.on('data', (d) => (err += d))
    const timer = setTimeout(() => p.kill(), waitMs)
    p.on('exit', () => {
      clearTimeout(timer)
      let r = { state: { phase: 'no-result' }, console: [] }
      try {
        r = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'))
      } catch {
        if (err.trim()) console.log('   stderr:', err.slice(-300))
      }
      console.log(`\n=== ${label}`)
      console.log('   状态：', JSON.stringify(r.state))
      if (r.console?.length) console.log('   控制台：', r.console.join(' | ').slice(0, 300))
      resolve(r.state)
    })
  })
}

// ---------------- 4. 执行 ----------------
const { playUrl, cleanup } = await createTask(TARGET)
console.log('playUrl =', playUrl)

const neg = await runOne(
  '对照组 · 跨源清单且无 ACAO（应复现 manifestLoadError）',
  `http://localhost:${pagePort}/nocors.m3u8`,
  30000
)
const pos = await runOne('正例 · 内核代理 playlist.m3u8（应可播）', playUrl, 45000)

server.close()
cleanup()
fs.rmSync(OUT_FILE, { force: true })
fs.rmSync(APP_DIR, { recursive: true, force: true })

const pass =
  neg.phase === 'fatal' && neg.details === 'manifestLoadError' && (pos.phase === 'playing' || pos.phase === 'parsed')
console.log('\n----------------------------------------')
console.log(`对照组：${neg.phase}${neg.details ? ' / ' + neg.details : ''}（期望 fatal / manifestLoadError）`)
console.log(
  `正例  ：${pos.phase}${pos.levels !== undefined ? ` / ${pos.levels} 档` : ''}${pos.t ? ` / t=${pos.t.toFixed(2)}s` : ''}（期望 parsed|playing）`
)
console.log(pass ? 'PASS' : 'FAIL')
process.exit(pass ? 0 : 1)
