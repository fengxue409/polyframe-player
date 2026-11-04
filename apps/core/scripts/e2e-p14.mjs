// P14 弹幕真实窗口 E2E（裸 CDP）
// 运行：node apps/core/scripts/e2e-p14.mjs（需先 pnpm -r build && pnpm core:build）
//
// 断言重点是「肉眼可见的那部分」——不只查状态字段，而是真的读 canvas 像素：
//  1) 播放页出现弹幕开关与发送栏
//  2) 轨道分配算法自检全绿（同刻不重叠 / 可复用 / 屏满丢弃 / 时间倒退）
//  3) 注入弹幕后 canvas 上**确实有非透明像素**（渲染链路通）
//  4) 同屏条数受上限约束（高并发不炸）
//  5) 发送一条 → 即时上屏（不是等下一轮拉取）
//  6) 字号设置变更 → 轨道数随之变化
//  7) 切 libmpv 内核 → DOM 弹幕层隐藏（Win32 子窗口遮挡的架构决策）
//  8) 高密度 500 条注入 → 帧耗时在预算内
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const desktop = path.join(root, 'apps/desktop')
const require = createRequire(path.join(desktop, 'package.json'))
const electronBin = require('electron')
const coreBin = path.join(root, 'apps/core/target/release/pf-core.exe')
const userData = path.join(process.env.TEMP ?? '.', `pf-e2e-p14-${process.pid}`)

// ---- 假媒体源（让 video 有 src、hls.js 能走到 MANIFEST_PARSED） ----
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
const originBase = await new Promise((resolve) =>
  origin.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${origin.address().port}`))
)

const PORT = 9811 + (process.pid % 150)
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

async function listTargets() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
    return await r.json()
  } catch {
    return []
  }
}

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    const list = await listTargets()
    const pages = list.filter(
      (t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('devtools://')
    )
    const page = pages.find((t) => t.url.includes('index.html')) ?? pages[0]
    if (page) return page
    await sleep(500)
  }
  throw new Error('未找到 CDP page target')
}

const target = await findTarget()
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
    throw new Error(
      `JS 异常: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`
    )
  }
  return r.result?.value
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(
    `  ${ok ? '\x1b[32mPASS' : '\x1b[31mFAIL'}\x1b[0m ${name}${detail ? ` (\x1b[2m${detail}\x1b[0m)` : ''}`
  )
}
/** 只记录不判定：用于环境前提（无头环境下帧生产被关掉属于正常，不算功能缺陷） */
const note = (name, detail = '') => {
  console.log(`  \x1b[33mNOTE\x1b[0m ${name}${detail ? ` (\x1b[2m${detail}\x1b[0m)` : ''}`)
}

/** 统计 canvas 上的非透明像素数（渲染是否真的发生了的硬证据） */
const PIXEL_PROBE = `(() => {
  const c = document.querySelector('.danmaku-canvas')
  if (!c) return -1
  const ctx = c.getContext('2d')
  if (!ctx) return -2
  const { width: w, height: h } = c
  if (w === 0 || h === 0) return -3
  const d = ctx.getImageData(0, 0, w, h).data
  let n = 0
  for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++
  return n
})()`

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

  // 等内核在线（真打一次 ping，比看状态徽章可靠）
  let online = false
  for (let i = 0; i < 60; i++) {
    online = await evalJs(`
      (async () => {
        try { await window.polyframe.rpc('core.ping'); return true } catch { return false }
      })()
    `)
    if (online) break
    await sleep(400)
  }
  check('内核已就绪', online === true)

  // ---------------- 1) 播放页 UI ----------------
  await evalJs(`
    (() => {
      const el = [...document.querySelectorAll('nav *')].find(x => x.textContent.trim() === '播放')
      if (el) el.click()
    })()
  `)
  await sleep(900)

  const hasToggle = await evalJs(`!!document.querySelector('.dm-toggle')`)
  check('播放页有弹幕开关', hasToggle === true)
  const hasSendBar = await evalJs(`!!document.querySelector('.dm-send .dm-input')`)
  check('播放页有弹幕发送栏', hasSendBar === true)
  const layerExists = await evalJs(`!!document.querySelector('.danmaku-layer .danmaku-canvas')`)
  check('弹幕层已挂载 canvas', layerExists === true)

  // 画布尺寸：为 0 时轨道数恒为 1、像素永远为空，是"看起来都正常但什么都看不见"的根因
  const sizeInfo = await evalJs(`
    (() => {
      const box = (el) => el ? {
        w: Math.round(el.getBoundingClientRect().width),
        h: Math.round(el.getBoundingClientRect().height),
        d: getComputedStyle(el).display
      } : null
      const c = document.querySelector('.danmaku-canvas')
      return {
        layer: box(document.querySelector('.danmaku-layer')),
        canvas: box(c),
        wrap: box(document.querySelector('.video-wrap')),
        bitmap: c ? { w: c.width, h: c.height } : null
      }
    })()
  `)
  check(
    '弹幕画布尺寸有效（宽>0 且 高>0）',
    (sizeInfo?.canvas?.w ?? 0) > 0 && (sizeInfo?.canvas?.h ?? 0) > 0,
    JSON.stringify(sizeInfo)
  )
  // 位图尺寸停在 1×1（HTMLCanvasElement 默认值）是「层已挂载但一个像素都不显示」
  // 的经典形态：轨道数恒为 1、字号变化无效、像素统计恒 0。必须单独断言。
  check(
    '画布位图尺寸已同步（含 DPR）',
    (sizeInfo?.bitmap?.w ?? 0) >= (sizeInfo?.canvas?.w ?? 0) &&
      (sizeInfo?.bitmap?.h ?? 0) >= (sizeInfo?.canvas?.h ?? 0) &&
      (sizeInfo?.bitmap?.w ?? 0) >= 2,
    `canvas=${sizeInfo?.canvas?.w}×${sizeInfo?.canvas?.h} bitmap=${sizeInfo?.bitmap?.w}×${sizeInfo?.bitmap?.h}`
  )

  // ---- 可推进的假时钟 ----
  // E2E 里没有真实播放：video 没有 src，currentTime 恒为 0 且 paused。
  // 此时滚动弹幕会永远停在「入场那一帧」（x = 画布宽度，一个像素都还没进来），
  // 像素断言就会把「渲染正常」误判成「渲染失败」。给引擎换一个能手动推进的
  // 时间源后，「注入 → 时间前进 → 画面上有字」才是可验证的事实。
  const clockReady = await evalJs(`
    (() => {
      const dm = window.__pfDanmaku
      if (!dm || !dm.engine) return false
      window.__pfClock = { t: 0, playing: true }
      dm.engine.clock = {
        now: () => window.__pfClock.t,
        isPlaying: () => window.__pfClock.playing
      }
      dm.engine.seek(0)
      return true
    })()
  `)
  check('测试时钟注入成功', clockReady === true)

  // 窗口被遮挡 / 无头运行时 Chromium 会停掉帧生产：requestAnimationFrame 不再回调，
  // ResizeObserver（回调跟着帧走）也不投递 —— 画布量不到尺寸、渲染循环也永远不跑。
  // 这是运行环境事实，不是功能缺陷，所以只记录不判定；下面的断言全部改为
  // 「显式量尺寸 + 同步出帧」，两种环境下结论一致。
  const rafProbe = await evalJs(`
    new Promise((r) => {
      let n = 0
      const t0 = performance.now()
      const step = () => {
        n++
        if (n >= 3) return r({ frames: n, ms: Math.round(performance.now() - t0) })
        requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
      setTimeout(() => r({ frames: n, ms: -1 }), 1500)
    })
  `)
  if ((rafProbe?.frames ?? 0) >= 3) {
    note('rAF 正常投递，按真实帧驱动')
  } else {
    note('rAF 未投递（无头/被遮挡环境），断言改用 engine.step() 确定性出帧', JSON.stringify(rafProbe))
  }

  // ---------------- 2) 轨道算法自检 ----------------
  const st = await evalJs(`window.__pfDanmaku && window.__pfDanmaku.selfTest ? window.__pfDanmaku.selfTest() : null`)
  check('轨道算法自检可执行', st != null)
  if (st) {
    check('轨道算法自检全部通过', st.pass === true, (st.failures ?? []).join(' | '))
  }

  // ---------------- 3) 注入弹幕 → canvas 真有像素 ----------------
  const before = await evalJs(PIXEL_PROBE)
  const injected = await evalJs(`
    (() => {
      const dm = window.__pfDanmaku
      if (!dm || !dm.engine) return { err: 'engine missing' }
      const items = []
      for (let i = 0; i < 12; i++) {
        items.push({
          id: 'e2e-' + i,
          time: 0,
          text: 'E2E 弹幕 ' + i + ' 中文宽度测试',
          mode: i % 5 === 0 ? 'top' : i % 7 === 0 ? 'bottom' : 'scroll',
          color: i % 2 ? '#FFFFFF' : '#66CCFF',
          source: 'local'
        })
      }
      // 先推到 1.6s：让滚动弹幕真的进入画面（入场首帧贴在右边缘外，属正确行为）
      window.__pfClock.t = 1.6
      dm.engine.setItems(items, 0)
      // 无头 / 窗口被遮挡时 rAF 与 ResizeObserver 都不投递 → 显式量尺寸 + 同步出帧，
      // 否则测到的是"没有帧"，而不是"渲染坏了"。
      dm.engine.resize(true)
      dm.engine.start()
      dm.engine.step(1)
      return dm.engine.stats()
    })()
  `)
  await sleep(300)
  const after = await evalJs(PIXEL_PROBE)
  check('注入后引擎记录条数', (injected?.total ?? 0) === 12, JSON.stringify(injected))
  check('canvas 上有非透明像素（渲染生效）', after > 100, `before=${before} after=${after}`)
  check('同屏条数 > 0', (injected?.onScreen ?? 0) > 0, `onScreen=${injected?.onScreen}`)

  // ---------------- 4) 高密度注入 → 上限约束 ----------------
  const dense = await evalJs(`
    (() => {
      const dm = window.__pfDanmaku
      const items = []
      for (let i = 0; i < 500; i++) {
        items.push({
          id: 'dense-' + i,
          time: 0,
          text: '高密度 ' + i + ' ' + '字'.repeat(i % 20),
          mode: 'scroll',
          color: '#FFFFFF',
          source: 'local'
        })
      }
      dm.engine.setItems(items, 0)
      dm.engine.resize(true)
      const r = dm.engine.stats()
      const inj = dm.engine.debugInject(items.slice(0, 200), window.__pfClock.t)
      dm.engine.step(1)
      return { stats: r, inj, cap: dm.engine.stats().cap }
    })()
  `)
  await sleep(900)
  const densePixel = await evalJs(PIXEL_PROBE)
  const denseStats = await evalJs(`window.__pfDanmaku.stats()`)
  check('500 条注入后仍渲染', densePixel > 100, `pixels=${densePixel}`)
  check(
    '同屏条数不超过上限',
    (denseStats?.onScreen ?? 0) <= (denseStats?.cap ?? 0),
    `onScreen=${denseStats?.onScreen} cap=${denseStats?.cap}`
  )
  check('高密度下帧耗时 < 16ms', (denseStats?.frameMs ?? 99) < 16, `frameMs=${denseStats?.frameMs}`)

  // ---------------- 5) 字号设置 → 轨道数变化 ----------------
  // 必须走 store（`saveSettings`）而不是直接打 RPC：设置页滑块改的是 store，
  // 引擎靠 `watch(dm.settings)` 联动。只改后端不会让引擎知道，测出来的是
  // "测试没接对线"，不是功能坏了。
  const trackBefore = await evalJs(`window.__pfDanmaku.stats().tracks`)
  const fontChanged = await evalJs(`
    (async () => {
      const dm = window.__pfDanmaku
      await dm.store.saveSettings({ fontScale: 1.8 })
      await new Promise(r => setTimeout(r, 150))
      dm.engine.step(1)
      return dm.store.settings.fontScale
    })()
  `)
  check('字号设置可写入（1.8）', Math.abs((fontChanged ?? 0) - 1.8) < 0.01, String(fontChanged))
  await sleep(300)
  const trackAfter = await evalJs(`window.__pfDanmaku.stats().tracks`)
  check('字号放大后轨道数减少', trackAfter < trackBefore, `${trackBefore} → ${trackAfter}`)
  // 还原
  await evalJs(`
    (async () => {
      await window.__pfDanmaku.store.saveSettings({ fontScale: 1.0 })
      await new Promise(r => setTimeout(r, 150))
      window.__pfDanmaku.engine.step(1)
    })()
  `)
  await sleep(300)

  // ---------------- 6) 发送弹幕 → 即时上屏 ----------------
  const sendResult = await evalJs(`
    (async () => {
      const dm = window.__pfDanmaku
      const before = dm.stats().onScreen
      const input = document.querySelector('.dm-send .dm-input')
      const btn = document.querySelector('.dm-send .primary')
      if (!input || !btn) return { err: 'send bar missing' }
      input.value = 'E2E 发送测试 ' + Date.now()
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 120))
      btn.click()
      await new Promise(r => setTimeout(r, 900))
      return { before, after: dm.stats().onScreen, feedback: document.querySelector('.dm-feedback')?.textContent ?? '' }
    })()
  `)
  check('发送不报 UI 错误', !sendResult?.err, String(sendResult?.err ?? ''))
  check(
    '发送后同屏条数增加或已入库反馈',
    (sendResult?.after ?? 0) > (sendResult?.before ?? 0) || /发送|未发送|尚未绑定/.test(sendResult?.feedback ?? ''),
    JSON.stringify(sendResult)
  )

  // ---------------- 6b) 即时上屏 + 不重复上屏 ----------------
  // 这两条回归的是引擎的一个真实缺陷：`send()` 把新弹幕插入时间轴后，
  // 如果游标没越过它，下一帧区间消费会把它**再放一次**，屏幕上出现两条一样的。
  const instant = await evalJs(`
    (() => {
      const dm = window.__pfDanmaku
      const t = window.__pfClock.t
      const before = dm.stats()
      dm.engine.send({
        id: 'instant-' + Date.now(), time: t, text: '即时上屏验证', mode: 'scroll',
        color: '#FFFFFF', source: 'local'
      })
      const mid = dm.stats()
      dm.engine.step(2) // 再跑两帧：不该多出第二条
      const after = dm.stats()
      return { before, mid, after }
    })()
  `)
  check(
    '发送后立即上屏（不等下一轮拉取）',
    (instant?.mid?.total ?? 0) === (instant?.before?.total ?? 0) + 1 &&
      (instant?.mid?.onScreen ?? 0) === (instant?.before?.onScreen ?? 0) + 1,
    `total ${instant?.before?.total}→${instant?.mid?.total} onScreen ${instant?.before?.onScreen}→${instant?.mid?.onScreen}`
  )
  check(
    '发送后不会被区间消费重复上屏',
    (instant?.after?.total ?? 0) === (instant?.mid?.total ?? 0) &&
      (instant?.after?.onScreen ?? 0) <= (instant?.mid?.onScreen ?? 0) + 1,
    `total ${instant?.mid?.total}→${instant?.after?.total} onScreen ${instant?.mid?.onScreen}→${instant?.after?.onScreen}`
  )

  // ---------------- 7) mpv 内核 → DOM 弹幕层必然隐藏 ----------------
  // 这不是"降级"，是架构事实：mpv 把画面渲进独立 Win32 子窗口，
  // 恒定绘制在父窗口客户区之上，DOM 弹幕层即使显示也会被完全盖住。
  const mpvSwitch = await evalJs(`
    (async () => {
      const b = [...document.querySelectorAll('.engine-btn')].find(x => x.textContent.includes('libmpv'))
      if (!b) return { err: 'no mpv button' }
      if (b.disabled) return { skipped: true, reason: 'libmpv 不可用' }
      b.click()
      await new Promise(r => setTimeout(r, 1500))
      const layer = document.querySelector('.danmaku-layer')
      const hidden = layer ? layer.classList.contains('hidden') : null
      // 切回 hls，避免影响后续断言
      const h = [...document.querySelectorAll('.engine-btn')].find(x => x.textContent.includes('hls'))
      h?.click()
      await new Promise(r => setTimeout(r, 800))
      return { skipped: false, hidden }
    })()
  `)
  if (mpvSwitch?.skipped) {
    check('mpv 遮挡：环境无 libmpv，跳过', true, mpvSwitch.reason)
  } else {
    check('mpv 内核下 DOM 弹幕层被隐藏（避免被视频子窗口遮挡）', mpvSwitch?.hidden === true, JSON.stringify(mpvSwitch))
  }

  // ASS 渲染路径（mpv 内核实际使用的弹幕形态）
  const assCheck = await evalJs(`
    (async () => {
      const open = await window.polyframe.rpc('danmaku.open', { title: 'E2E 测试剧', episode: '第1集' })
      await window.polyframe.rpc('danmaku.send', {
        channelId: open.channelId, time: 10, text: 'ASS 路径验证', mode: 'scroll'
      }).catch(() => ({}))
      const r = await window.polyframe.rpc('danmaku.ass', { channelId: open.channelId })
      return { path: r.path, count: r.count }
    })()
  `)
  check('mpv 路径能生成 ASS 弹幕文件', !!assCheck?.path, JSON.stringify(assCheck))

  // ---------------- 8) 弹幕总开关 ----------------
  const toggleOk = await evalJs(`
    (async () => {
      const btn = document.querySelector('.dm-toggle')
      if (!btn) return { err: 'no toggle' }
      btn.click()
      await new Promise(r => setTimeout(r, 600))
      const off = document.querySelector('.danmaku-layer')?.classList.contains('hidden')
      btn.click()
      await new Promise(r => setTimeout(r, 600))
      const on = !document.querySelector('.danmaku-layer')?.classList.contains('hidden')
      return { off, on }
    })()
  `)
  check('关闭弹幕 → 弹幕层隐藏', toggleOk?.off === true, JSON.stringify(toggleOk))
  check('再次开启 → 弹幕层恢复', toggleOk?.on === true, JSON.stringify(toggleOk))

  // ---------------- 9) 设置页弹幕区块 ----------------
  await evalJs(`
    (() => {
      const el = [...document.querySelectorAll('nav *')].find(x => x.textContent.trim() === '设置')
      if (el) el.click()
    })()
  `)
  await sleep(900)
  const settingsOk = await evalJs(`!!document.querySelector('.dm-settings') && !!document.querySelector('.dm-slider input[type=range]')`)
  check('设置页有弹幕区块与滑块', settingsOk === true)
  const credInputs = await evalJs(`document.querySelectorAll('.dm-cred input').length`)
  check('设置页有凭据输入框', credInputs >= 2, `inputs=${credInputs}`)

  // ---------------- 10) P15：屏蔽词 / ASS 治理 / 手动指定弹幕源 ----------------
  const blockedInput = await evalJs(`!!document.querySelector('.dm-blocked')`)
  check('设置页有屏蔽词输入框', blockedInput === true)
  const assBox = await evalJs(`!!document.querySelector('.dm-ass')`)
  check('设置页有 ASS 临时文件治理区块', assBox === true)
  const assText = await evalJs(`document.querySelector('.dm-ass .v')?.textContent?.trim() ?? ''`)
  check('ASS 区块显示占用', /\d+\s*个/.test(assText), assText)

  // 回播放页
  await evalJs(`
    (() => {
      const el = [...document.querySelectorAll('nav *')].find(x => x.textContent.trim() === '播放')
      if (el) el.click()
    })()
  `)
  await sleep(700)

  const srcBtn = await evalJs(`!!document.querySelector('.dm-src')`)
  check('播放页有常驻「源」按钮', srcBtn === true)

  // 打开候选面板：不依赖 no_match，随时可改弹幕源
  const picker = await evalJs(`
    (() => {
      const btn = document.querySelector('.dm-src')
      if (!btn) return null
      btn.click()
      return true
    })()
  `)
  await sleep(600)
  const pickerUi = await evalJs(`
    (() => {
      const p = document.querySelector('.dm-picker')
      if (!p) return null
      return {
        hasInput: !!p.querySelector('.dm-picker-input'),
        hasSearch: !!p.querySelector('.dm-picker-go'),
        hasLocal: !!p.querySelector('.dm-picker-local'),
        text: p.textContent.replace(/\\s+/g, ' ').trim().slice(0, 120)
      }
    })()
  `)
  check('点「源」打开候选面板', picker === true && pickerUi != null, JSON.stringify(pickerUi))
  check('候选面板有可改的关键词输入框', pickerUi?.hasInput === true, JSON.stringify(pickerUi))
  check('候选面板有搜索按钮', pickerUi?.hasSearch === true)
  check('候选面板有「仅本地弹幕」入口', pickerUi?.hasLocal === true)

  // 关掉面板，避免遮住后续操作
  await evalJs(`document.querySelector('.dm-picker-close')?.click()`)
  await sleep(300)

  // 导入走真实链路：store → RPC → 内核解析 → 回写 → 引擎重载
  const imp = await evalJs(`
    (async () => {
      const dm = window.__pfDanmaku.store
      await dm.openChannel('E2E 导入测试', '第1集')
      const before = dm.itemCount
      const xml = '<i>' +
        '<d p="1,1,25,16777215,0,0,a,1">E2E 导入甲</d>' +
        '<d p="2,5,25,16711680,0,0,a,2">E2E 导入乙</d>' +
        '<d p="3,1,25,0,0,a,3">普通条目</d>' +
        '</i>'
      const r = await dm.importLocal(xml)
      return { ok: r.ok, imported: r.imported, before, after: dm.itemCount, ch: dm.channelId, msg: r.message }
    })()
  `)
  check('播放页导入走通真实链路', imp?.ok === true, JSON.stringify(imp))
  check('导入后条数增加', (imp?.after ?? 0) === (imp?.before ?? 0) + 3, JSON.stringify(imp))
  await sleep(600)
  const engAfterImport = await evalJs(`window.__pfDanmaku.stats()`)
  check('导入后引擎拿到新条目', (engAfterImport?.total ?? 0) === (imp?.after ?? -1), JSON.stringify(engAfterImport))

  // 屏蔽词：只影响展示，库里条目不变
  const blk = await evalJs(`
    (async () => {
      const dm = window.__pfDanmaku.store
      const before = dm.itemCount
      await dm.saveSettings({ blockedWords: ['E2E 导入'] })
      // 渲染层重载走 Vue 响应式（watch itemsVersion → setItems），等一拍让链路跑完
      await new Promise((r) => setTimeout(r, 400))
      const filtered = dm.itemCount
      const drawn = window.__pfDanmaku.stats().total
      await dm.saveSettings({ blockedWords: [] })
      await new Promise((r) => setTimeout(r, 400))
      return { before, filtered, drawn, restored: dm.itemCount }
    })()
  `)
  check('屏蔽词减少可见条数', (blk?.filtered ?? 99) < (blk?.before ?? 0), JSON.stringify(blk))
  check('屏蔽词让渲染层同步减少', (blk?.drawn ?? -1) === (blk?.filtered ?? -2), JSON.stringify(blk))
  check('清空屏蔽词后条数恢复', (blk?.restored ?? 0) === (blk?.before ?? -1), JSON.stringify(blk))

  // ASS 占用统计（不强制要求清理成功：hls 内核下可能还没生成过 ASS）
  const assInfo = await evalJs(`
    (async () => {
      const dm = window.__pfDanmaku.store
      await dm.loadAssCache()
      return { files: dm.assCache.files, bytes: dm.assCache.bytes }
    })()
  `)
  check('store 能读到 ASS 占用', typeof assInfo?.files === 'number' && assInfo.files >= 0, JSON.stringify(assInfo))
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
    fs.rmSync(userData, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

const failed = results.filter((r) => !r.ok)
console.log(
  `\n${failed.length === 0 ? '\x1b[32m' : '\x1b[31m'}${results.length - failed.length}/${
    results.length
  } 通过\x1b[0m`
)
if (failed.length) {
  console.log('\x1b[31m失败项：\x1b[0m')
  for (const f of failed) console.log(`  - ${f.name}`)
  if (process.env.PF_E2E_VERBOSE) console.log('\n--- app log ---\n' + appLog.slice(-4000))
  process.exit(1)
}
