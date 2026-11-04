// P17 弹幕高级特效 E2E（裸 CDP，像素级断言）
// 运行：node apps/core/scripts/e2e-p17.mjs（需先 pnpm -r build && pnpm core:build）
//
// 断言重点是「特效真的画出来了」，全部用 canvas 像素取证：
//  1) 构建产物里有 overlay.html（覆盖层页面已进产物）
//  2) 普通弹幕 → 发光弹幕：光晕让非透明像素包围盒显著变大
//  3) 渐变弹幕：包围盒左端明显比右端亮（亮→主色→暗 三停渐变）
//  4) 图片弹幕：data URL 图片真的画上 canvas（蓝色像素出现）
//  5) 发送栏有样式下拉（普通/发光/渐变），走 store 发送 fx=glow 后内核回读一致
//  6) 设置页有「mpv 高级特效弹幕」开关，且 fxOverlay 设置可写入
//  7) fx=gradient 的弹幕画出的像素**不是**纯色填充（左端色 ≠ 主色）
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const coreRoot = path.resolve(here, '..')
const root = path.resolve(coreRoot, '../..')
const desktop = path.join(root, 'apps/desktop')
const require = createRequire(path.join(desktop, 'package.json'))
const electronBin = require('electron')
const coreBin = path.join(coreRoot, 'target/release/pf-core.exe')
const userData = mkdtempSync(path.join(process.env.TEMP ?? '.', 'pf-e2e-p17-'))

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`  ${ok ? GREEN + 'PASS' : RED + 'FAIL'}${RESET} ${name}${detail ? ` ${DIM}(${detail})${RESET}` : ''}`)
}

// ---- 1) 构建产物检查（不开窗口就能断言） ----
const overlayBuilt = ['out/renderer/overlay.html', 'out/preload/index.js'].map((p) =>
  path.join(desktop, p)
)
check('覆盖层页面已进构建产物', overlayBuilt.every((p) => existsSync(p)), overlayBuilt.map((p) => path.basename(p)).join(','))

// ---- 假媒体源（video 有 src 即可，断言全走 debugInject，不真播放） ----
const origin = http.createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (u.pathname === '/media/ep.m3u8') {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
    res.end(
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:4.0,\nseg0.ts\n#EXT-X-ENDLIST\n'
    )
    return
  }
  if (u.pathname === '/media/seg0.ts') {
    res.writeHead(200, { 'Content-Type': 'video/mp2t' })
    res.end(Buffer.alloc(188 * 10))
    return
  }
  res.writeHead(404).end()
})
await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve))

const PORT = 9911 + (process.pid % 150)
const app = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: desktop,
  env: (() => {
    const e = { ...process.env, PF_CORE_BIN: coreBin, LOCALAPPDATA: userData }
    delete e.ELECTRON_RUN_AS_NODE
    return e
  })(),
  stdio: ['ignore', 'pipe', 'pipe']
})
let appLog = ''
app.stdout.on('data', (d) => (appLog += d))
app.stderr.on('data', (d) => (appLog += d))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let target = null
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const pages = list.filter(
      (t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('devtools://')
    )
    target = pages.find((t) => t.url.includes('index.html')) ?? pages[0] ?? null
  } catch {
    /* retry */
  }
  if (target) break
  await sleep(500)
}
if (!target) throw new Error('未找到 CDP page target')

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res)
  ws.addEventListener('error', rej)
})
let msgId = 1
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id)
    pending.delete(m.id)
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.ok(m.result)
  }
})
const send = (method, params) =>
  new Promise((ok, rej) => {
    const id = msgId++
    pending.set(id, { ok, rej })
    ws.send(JSON.stringify({ id, method, params }))
  })
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true
  })
  if (r.exceptionDetails) {
    throw new Error(`JS 异常: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`)
  }
  return r.result?.value
}

// 包围盒：canvas 上 alpha>8 的像素范围 + 数量
const BBOX = `(() => {
  const c = document.querySelector('.danmaku-canvas')
  if (!c) return null
  const ctx = c.getContext('2d')
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, n = 0
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const a = d[(y * c.width + x) * 4 + 3]
      if (a > 8) {
        n++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  return n === 0 ? { n: 0 } : { n, minX, maxX, w: maxX - minX + 1, h: maxY - minY + 1 }
})()`

/** 左右端平均亮度（用包围盒内 25% 边带采样；返回 {l, r} 平均 RGB 之和） */
const SIDES = `(() => {
  const c = document.querySelector('.danmaku-canvas')
  const ctx = c.getContext('2d')
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    if (d[(y * c.width + x) * 4 + 3] > 8) {
      if (x < minX) minX = x; if (x > maxX) maxX = x
      if (y < minY) minY = y; if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return { l: -1, r: -1 }
  const band = Math.max(1, Math.round((maxX - minX) * 0.25))
  const avg = (x0, x1) => {
    let s = 0, n = 0
    for (let y = minY; y <= maxY; y++) for (let x = x0; x <= x1; x++) {
      const i = (y * c.width + x) * 4
      if (d[i + 3] > 8) { s += d[i] + d[i + 1] + d[i + 2]; n++ }
    }
    return n ? s / n : -1
  }
  return { l: avg(minX, minX + band), r: avg(maxX - band, maxX) }
})()`

/** 清空引擎并注入单条弹幕（mode=top 居中静止，位置确定） */
const INJECT_ONE = (item, t) => `(() => {
  const dm = window.__pfDanmaku
  dm.engine.setItems([], 0)          // 清掉在屏 + 游标
  dm.engine.resize(true)
  dm.engine.start()
  const r = dm.engine.debugInject([Object.assign({
    id: 'e2e17-' + Math.random().toString(36).slice(2),
    time: ${t}, mode: 'top', color: '#FF0000', source: 'local'
  }, ${JSON.stringify(item)}), ], ${t}, ${t})
  dm.engine.step(2)
  return r
})()`

// 3×1 蓝色 BMP（24bpp）→ data URL；比手写 PNG 编码器省 40 行
function blueBmpDataUrl() {
  const w = 3, h = 1
  const rowSize = Math.ceil((w * 3) / 4) * 4
  const dataSize = rowSize * h
  const buf = Buffer.alloc(54 + dataSize)
  buf.write('BM', 0)
  buf.writeUInt32LE(buf.length, 2)
  buf.writeUInt32LE(54, 10)
  buf.writeUInt32LE(40, 14)
  buf.writeInt32LE(w, 18)
  buf.writeInt32LE(h, 22)
  buf.writeUInt16LE(1, 26)
  buf.writeUInt16LE(24, 28)
  buf.writeUInt32LE(dataSize, 34)
  // BGR：蓝 = (255,0,0) in BGR；一行 3 个像素都要写（否则 2/3 是黑）
  for (let px = 0; px < w; px++) buf[54 + px * 3] = 255 // B
  return 'data:image/bmp;base64,' + buf.toString('base64')
}

try {
  await send('Runtime.enable')
  let ready = false
  for (let i = 0; i < 90; i++) {
    try {
      ready = await evalJs(`document.readyState === 'complete' && !!document.querySelector('nav')`)
    } catch {
      ready = false
    }
    if (ready) break
    await sleep(500)
  }
  check('窗口渲染完成', ready)
  if (!ready) throw new Error('窗口未就绪')

  // 播放页
  await evalJs(`
    (() => {
      const el = [...document.querySelectorAll('nav *')].find(x => x.textContent.trim() === '播放')
      if (el) el.click()
    })()
  `)
  await sleep(900)

  const engineReady = await evalJs(`!!window.__pfDanmaku?.engine`)
  check('弹幕引擎已挂载', engineReady === true)
  if (!engineReady) throw new Error('engine missing')

  // 可推进假时钟（与 e2e-p14 同一套做法）
  await evalJs(`
    (() => {
      const dm = window.__pfDanmaku
      window.__pfClock = { t: 1.0, playing: true }
      dm.engine.clock = { now: () => window.__pfClock.t, isPlaying: () => window.__pfClock.playing }
      dm.engine.seek(0)
      return true
    })()
  `)

  console.log('\n[1] 发光 vs 普通：光晕包围盒')
  await evalJs(INJECT_ONE({ text: '特效AB测试', fx: null }, 1.0))
  await sleep(150)
  const plain = await evalJs(BBOX)
  check('普通弹幕画出像素', (plain?.n ?? 0) > 50, JSON.stringify(plain))
  await evalJs(INJECT_ONE({ text: '特效AB测试', fx: 'glow' }, 1.0))
  await sleep(150)
  const glow = await evalJs(BBOX)
  check('发光弹幕画出像素', (glow?.n ?? 0) > 50, JSON.stringify(glow))
  check(
    '光晕使包围盒扩大（宽 > 普通的 1.05 倍；短文本光晕占比小，像素量才是主断言）',
    (glow?.w ?? 0) > (plain?.w ?? 0) * 1.05,
    `w ${plain?.w} → ${glow?.w}`
  )
  check(
    '光晕使像素量显著增加（> 普通的 1.2 倍）',
    (glow?.n ?? 0) > (plain?.n ?? 0) * 1.2,
    `n ${plain?.n} → ${glow?.n}`
  )

  console.log('\n[2] 渐变：左亮右暗')
  await evalJs(INJECT_ONE({ text: '渐变宽度测试文本', fx: 'gradient' }, 1.0))
  await sleep(150)
  const grad = await evalJs(SIDES)
  check('渐变两端都可采样', (grad?.l ?? -1) > 0 && (grad?.r ?? -1) > 0, JSON.stringify(grad))
  check(
    '渐变左端亮于右端（三停：亮→主色→暗）',
    (grad?.l ?? 0) > (grad?.r ?? 0) + 15,
    `l=${Math.round(grad?.l ?? 0)} r=${Math.round(grad?.r ?? 0)}`
  )
  // 渐变左端应比主色 #FF0000 亮（提亮 55%）——用红色通道 + 其他通道区分纯色
  const gradHue = await evalJs(`(() => {
    const c = document.querySelector('.danmaku-canvas')
    const ctx = c.getContext('2d')
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      if (d[(y * c.width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x; if (x > maxX) maxX = x
        if (y < minY) minY = y; if (y > maxY) maxY = y
      }
    }
    // 左端带里非红通道的平均值：纯 #FF0000 填充应接近 0，提亮端应明显 > 0
    let s = 0, n = 0
    const band = Math.max(1, Math.round((maxX - minX) * 0.25))
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= minX + band; x++) {
      const i = (y * c.width + x) * 4
      if (d[i + 3] > 8) { s += d[i + 1] + d[i + 2]; n++ }
    }
    return n ? s / n : -1
  })()`)
  check(
    '渐变不是纯色填充（左端 G+B 通道 > 25）',
    (gradHue ?? -1) > 25,
    `gb=${Math.round(gradHue ?? 0)}`
  )

  console.log('\n[3] 图片弹幕')
  const imgUrl = blueBmpDataUrl()
  await evalJs(INJECT_ONE({ text: imgUrl }, 1.0))
  // 图片解码是异步的：等一拍再出帧
  await sleep(700)
  await evalJs(`window.__pfDanmaku.engine.step(2)`)
  const imgPix = await evalJs(`(() => {
    const c = document.querySelector('.danmaku-canvas')
    const ctx = c.getContext('2d')
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let blue = 0, other = 0
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 8) {
        if (d[i + 2] > 150 && d[i] < 100) blue++
        else other++
      }
    }
    return { blue, other }
  })()`)
  check('图片弹幕画出蓝色像素', (imgPix?.blue ?? 0) > 10, JSON.stringify(imgPix))
  check('图片绘制不是按文本兜底（无文字型杂像素簇）', (imgPix?.blue ?? 0) > (imgPix?.other ?? 0), JSON.stringify(imgPix))

  console.log('\n[4] 样式下拉 + fx 发送链路')
  const fxSelect = await evalJs(`!!document.querySelector('.dm-send select.mode-select')`)
  check('发送栏有样式下拉', fxSelect === true)
  const sent = await evalJs(`
    (async () => {
      const dm = window.__pfDanmaku.store
      await dm.openChannel('E2E P17 特效', '第1集')
      const item = await dm.send('E2E发光' + Date.now(), 1.0, 'top', '#FF0000', 'glow')
      return { ok: !!item, fx: item?.fx ?? null }
    })()
  `)
  check('store.send 带 fx 发送成功', sent?.ok === true && sent?.fx === 'glow', JSON.stringify(sent))
  // 内核回读（真实落库）
  const readBack = await evalJs(`
    (async () => {
      const dm = window.__pfDanmaku.store
      await dm.reloadList()
      const it = dm.items.find(x => x.fx === 'glow')
      return { found: !!it, text: it?.text?.slice(0, 10) ?? '' }
    })()
  `)
  check('内核回读 fx=glow（落库生效）', readBack?.found === true, JSON.stringify(readBack))

  console.log('\n[5] 设置页 fxOverlay 开关')
  await evalJs(`
    (() => {
      const el = [...document.querySelectorAll('nav *')].find(x => x.textContent.trim() === '设置')
      if (el) el.click()
    })()
  `)
  await sleep(900)
  const toggles = await evalJs(`
    [...document.querySelectorAll('.dm-settings .dm-switch')]
      .map(l => l.textContent.trim())
  `)
  check('设置页出现 fxOverlay 开关', toggles.some((t) => t.includes('高级特效')), toggles.join(' / '))
  const saved = await evalJs(`
    (async () => {
      const dm = window.__pfDanmaku.store
      await dm.saveSettings({ fxOverlay: true })
      const on = dm.settings.fxOverlay === true
      await dm.saveSettings({ fxOverlay: false })
      return { on, off: dm.settings.fxOverlay === false }
    })()
  `)
  check('fxOverlay 设置可写可还原', saved?.on === true && saved?.off === true, JSON.stringify(saved))
} catch (e) {
  check('E2E 执行无异常', false, String(e?.message ?? e))
} finally {
  try {
    ws.close()
  } catch {
    /* ignore */
  }
  try {
    app.kill()
  } catch {
    /* ignore */
  }
  origin.close()
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length === 0 ? GREEN : RED}${results.length - failed.length}/${results.length} 通过${RESET}`)
if (failed.length) {
  console.log(`${RED}失败项：${RESET}`)
  for (const f of failed) console.log(`  - ${f.name}`)
  if (process.env.PF_E2E_VERBOSE) console.log('\n--- app log ---\n' + appLog.slice(-4000))
  process.exit(1)
}
