// P20 播放页信息侧栏 E2E（裸 CDP + 截图取证）
// 运行：node apps/core/scripts/e2e-p20.mjs（需先 pnpm -r build；内核默认 release 产物）
//
// 断言重点：
//  1) 侧栏默认展开、在播放器右侧，标题/年份/来源/简介/剧集条数与当前集全部对上
//  2) 收起后变窄条（海报 + 竖排片名），播放区反而变宽 —— 布局是真的让位
//  3) 侧栏点集 → queueIndex 跟随（就地换集，不跳页）
//  4) 切线路 → groupIndex 跟随（按集名对齐）
//  5) 窄屏（760px）→ 侧栏落到播放器下方（不再并排）
//  6) 无播放上下文 → 空态提示
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const coreRoot = path.resolve(here, '..')
const root = path.resolve(coreRoot, '../..')
const desktop = path.join(root, 'apps/desktop')
const require = createRequire(path.join(desktop, 'package.json'))
const electronBin = require('electron')
const coreBin = process.env.PF_CORE_BIN || path.join(coreRoot, 'target/release/pf-core.exe')
const userData = mkdtempSync(path.join(process.env.TEMP ?? '.', 'pf-e2e-p20-'))
// 截图放稳定目录（userData 在 finally 里会删掉）
const shots = path.join(process.env.TEMP ?? '.', 'pf-p20-shots')
mkdirSync(shots, { recursive: true })

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

if (!existsSync(coreBin)) {
  console.error(`缺少内核：${coreBin}（先跑 cargo build --release）`)
  process.exit(1)
}

const MEDIA =
  'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/bipbop_16x9_variant.m3u8'
const PORT = 10411 + (process.pid % 150)
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

let target = null
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('devtools://'))
    target = pages.find((t) => t.url.includes('index.html')) ?? pages[0] ?? null
  } catch {
    /* retry */
  }
  if (target) break
  await sleep(500)
}
if (!target) {
  console.error('未找到 CDP page target\n' + appLog.slice(-1500))
  process.exit(1)
}
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
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }),
    sleep(20000).then(() => {
      throw new Error(`CDP 无响应：${expr.slice(0, 60).replace(/\s+/g, ' ')}`)
    })
  ])
  if (r.exceptionDetails) {
    throw new Error(`JS 异常: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`)
  }
  return r.result?.value
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const p = path.join(shots, `${name}.png`)
  writeFileSync(p, Buffer.from(r.data, 'base64'))
  return p
}
const viewport = (width, height) =>
  send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })

const cleanup = () => {
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
}

try {
  await send('Page.enable')
  // 宽屏优先：侧栏默认展开依赖 innerWidth ≥ 1180
  await viewport(1440, 900)

  let online = false
  for (let i = 0; i < 60; i++) {
    online = await evalJs(`(async () => {
      const st = await window.polyframe?.status?.()
      return !!st && st.status === 'online'
    })()`).catch(() => false)
    if (online) break
    await sleep(500)
  }
  check('内核在线', online)

  // 进播放页
  await evalJs(`(() => {
    const nav = [...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('播放'));
    nav?.click(); return !!nav
  })()`)
  await sleep(500)

  // 注入播放上下文（等价于「详情弹层选集起播」写入的状态）
  const injected = await evalJs(`(() => {
    const app = document.querySelector('#app').__vue_app__
    const pinia = app?.config?.globalProperties?.$pinia
    const cat = pinia?._s?.get('catalog')
    if (!cat) return 'no-store'
    const eps = Array.from({ length: 12 }, (_, i) => ({ name: '第' + (i + 1) + '集', url: ${JSON.stringify(MEDIA)} }))
    cat.queue = eps
    cat.queueIndex = 1
    cat.queueTitle = '星际穿越'
    cat.playCtx = {
      title: '星际穿越',
      poster: '',
      content: '近未来的地球黄沙遍野，粮食接连绝收。' +
        '一支探险队穿越虫洞，为人类寻找新的家园。' +
        '他们面对的不只是时间膨胀，还有跨越星系的离别。' +
        '这是一段关于父女、时间与引力的旅程。',
      year: '2014',
      typeName: '科幻片',
      remarks: 'HD中字',
      siteName: '测试采集站',
      groups: [
        { from: 'm3u8', episodes: eps },
        { from: 'wjm3u8', episodes: eps }
      ],
      groupIndex: 0,
      sources: [],
      sourceIndex: 0,
      startedAt: Date.now()
    }
    return 'ok'
  })()`)
  check('注入播放上下文', injected === 'ok', String(injected))
  await sleep(500)

  // ---- 1) 默认展开 + 内容对得上 ----
  const layout = await evalJs(`(() => {
    const side = document.querySelector('.info-side')
    const v = document.querySelector('.video-wrap')
    if (!side || !v) return null
    const s = side.getBoundingClientRect()
    const vr = v.getBoundingClientRect()
    return {
      sideW: Math.round(s.width),
      sideTop: Math.round(s.top),
      sideLeft: Math.round(s.left),
      videoW: Math.round(vr.width),
      videoRight: Math.round(vr.right),
      videoBottom: Math.round(vr.bottom),
      title: document.querySelector('.side-title')?.textContent?.trim() || '',
      now: (document.querySelector('.side-now')?.textContent || '').replace(/\\s+/g, ' ').trim(),
      src: document.querySelector('.side-src')?.textContent?.trim() || '',
      eps: document.querySelectorAll('.ep-list .ep-btn').length,
      active: document.querySelector('.ep-btn.active')?.textContent?.trim() || '',
      chips: [...document.querySelectorAll('.source-block select')].map(s => [...s.options].map(o => o.textContent.trim())),
      tags: [...document.querySelectorAll('.side-meta .tag')].map(t => t.textContent.trim()),
      content: (document.querySelector('.side-content')?.textContent || '').length,
      state: document.querySelector('.side-progress .row span')?.textContent?.trim() || '',
      bar: !!document.querySelector('.side-progress .bar i')
    }
  })()`)
  check('侧栏默认展开且宽度足够', !!layout && layout.sideW >= 300, `sideW=${layout?.sideW}`)
  check('侧栏在播放器右侧（并排）', !!layout && layout.sideLeft > layout.videoRight - 40, JSON.stringify({ sideLeft: layout?.sideLeft, videoRight: layout?.videoRight }))
  check('标题正确', layout?.title === '星际穿越', layout?.title)
  check('当前集序号 2/12', /2\/12/.test(layout?.now ?? ''), layout?.now)
  check('来源站名展示', /测试采集站/.test(layout?.src ?? ''), layout?.src)
  check('剧集列表 12 条', layout?.eps === 12, `eps=${layout?.eps}`)
  check('当前集高亮唯一且为第2集', layout?.active === '第2集', layout?.active)
  check('线路下拉 2 项', layout?.chips?.[1]?.length === 2, JSON.stringify(layout?.chips))
  check('元信息标签 3 个（类型/年份/状态）', layout?.tags?.length === 3, JSON.stringify(layout?.tags))
  check('简介已渲染', (layout?.content ?? 0) > 60, `len=${layout?.content}`)
  check('进度条与状态文案就位', !!layout?.bar && ['待播放', '播放中', '已暂停', '已播完'].includes(layout?.state ?? ''), layout?.state)
  const shot1 = await shot('01-expanded')

  // ---- 2) 收起：窄条 + 播放区变宽 ----
  await evalJs(`(() => { document.querySelector('.side-toggle')?.click(); return true })()`)
  await sleep(400)
  const collapsed = await evalJs(`(() => {
    const side = document.querySelector('.info-side')
    const v = document.querySelector('.video-wrap')
    const s = side.getBoundingClientRect()
    const vr = v.getBoundingClientRect()
    return {
      sideW: Math.round(s.width),
      videoW: Math.round(vr.width),
      rail: !!document.querySelector('.rail-btn'),
      railText: document.querySelector('.rail-text')?.textContent?.trim() || '',
      badge: document.querySelector('.rail-badge')?.textContent?.trim() || '',
      stored: localStorage.getItem('pf.playerSide')
    }
  })()`)
  check('收起后变窄条', collapsed.sideW <= 60, `sideW=${collapsed.sideW}`)
  check('收起后播放区变宽（让位真实生效）', collapsed.videoW > layout.videoW + 100, `${layout.videoW} → ${collapsed.videoW}`)
  check('窄条保留片名与集序', collapsed.rail && collapsed.railText === '星际穿越' && collapsed.badge === '2/12', JSON.stringify(collapsed))
  check('收起状态已记忆', collapsed.stored === '0', collapsed.stored)
  const shot2 = await shot('02-collapsed')

  // ---- 3) 展开回来 + 点集换集 ----
  await evalJs(`(() => { document.querySelector('.rail-btn')?.click(); return true })()`)
  await sleep(400)
  const reopened = await evalJs(`Math.round(document.querySelector('.info-side').getBoundingClientRect().width)`)
  check('点窄条按钮可展开回来', reopened >= 300, `sideW=${reopened}`)

  await evalJs(`(() => {
    const btns = document.querySelectorAll('.ep-list .ep-btn')
    btns[3]?.click(); return btns.length
  })()`)
  let switched = null
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    switched = await evalJs(`(() => {
      const app = document.querySelector('#app').__vue_app__
      const cat = app.config.globalProperties.$pinia._s.get('catalog')
      return {
        idx: cat.queueIndex,
        active: document.querySelector('.ep-btn.active')?.textContent?.trim() || '',
        now: (document.querySelector('.side-now')?.textContent || '').replace(/\\s+/g, ' ').trim(),
        err: document.querySelector('.side-error')?.textContent?.trim() || ''
      }
    })()`)
    if (switched.idx === 3) break
  }
  check('侧栏点第4集 → queueIndex=3', switched?.idx === 3, JSON.stringify(switched))
  check('高亮与当前集文案同步', switched?.active === '第4集' && /4\/12/.test(switched?.now ?? ''), JSON.stringify(switched))

  // ---- 4) 切线路：按集名对齐 ----
  await evalJs(`(() => {
    const sel = document.querySelectorAll('.source-block select')[1]
    if (!sel) return -1
    sel.value = '1'
    sel.dispatchEvent(new Event('change'))
    return sel.options.length
  })()`)
  let group = null
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    group = await evalJs(`(() => {
      const app = document.querySelector('#app').__vue_app__
      const cat = app.config.globalProperties.$pinia._s.get('catalog')
      return { gi: cat.playCtx.groupIndex, idx: cat.queueIndex, active: document.querySelector('.ep-btn.active')?.textContent?.trim() || '' }
    })()`)
    if (group.gi === 1) break
  }
  check('切到第2线路 → groupIndex=1', group?.gi === 1, JSON.stringify(group))
  check('换线路停在同集（第4集）', group?.idx === 3 && group?.active === '第4集', JSON.stringify(group))

  // ---- 5) 窄屏：侧栏落到播放器下方 ----
  await viewport(760, 900)
  await sleep(600)
  const narrow = await evalJs(`(() => {
    const side = document.querySelector('.info-side')
    const v = document.querySelector('.video-wrap')
    const s = side.getBoundingClientRect()
    const vr = v.getBoundingClientRect()
    return {
      sideW: Math.round(s.width),
      sideTop: Math.round(s.top),
      videoBottom: Math.round(vr.bottom),
      stacked: s.top >= vr.bottom - 4,
      full: Math.abs(s.width - vr.width) < 40
    }
  })()`)
  check('窄屏侧栏落到播放器下方', narrow.stacked, JSON.stringify(narrow))
  check('窄屏侧栏占满宽度', narrow.full, `sideW=${narrow.sideW} videoW≈`)
  const shot3 = await shot('03-narrow')

  // ---- 6) 直链/解析起播：有标题、无剧集列表 ----
  await viewport(1440, 900)
  // 等上一轮换线路起的任务落定（sourceTaskId 变化会触发侧栏上下文刷新）
  await sleep(1500)
  await evalJs(`(() => {
    const app = document.querySelector('#app').__vue_app__
    const cat = app.config.globalProperties.$pinia._s.get('catalog')
    cat.setLooseContext('解析出来的片子', '解析直链')
    return true
  })()`)
  await sleep(400)
  const loose = await evalJs(`(() => ({
    title: document.querySelector('.side-title')?.textContent?.trim() || '',
    src: document.querySelector('.side-src')?.textContent?.trim() || '',
    noEps: /没有剧集列表/.test(document.querySelector('.info-side')?.textContent || ''),
    nav: document.querySelectorAll('.side-block .nav-mini').length,
    now: document.querySelectorAll('.side-now').length
  }))()`)
  check('直链起播：标题与来源就位', loose.title === '解析出来的片子' && /解析直链/.test(loose.src), JSON.stringify(loose))
  check('直链起播：无剧集时不显示选集引导', loose.noEps && loose.nav === 0 && loose.now === 0, JSON.stringify(loose))

  // ---- 7) 无上下文 → 空态 ----
  await evalJs(`(() => {
    const app = document.querySelector('#app').__vue_app__
    const cat = app.config.globalProperties.$pinia._s.get('catalog')
    cat.playCtx = null
    cat.queue = []
    cat.queueIndex = -1
    return true
  })()`)
  await sleep(400)
  const empty = await evalJs(`(() => ({
    empty: !!document.querySelector('.side-empty'),
    text: (document.querySelector('.side-empty')?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40)
  }))()`)
  check('无上下文显示空态引导', empty.empty && /还没有正在播放/.test(empty.text), empty.text)

  const passed = results.filter((r) => r.ok).length
  console.log(`\n${passed === results.length ? GREEN : RED}P20 侧栏 E2E：${passed}/${results.length}${RESET}`)
  console.log(`${DIM}截图：${shot1}\n      ${shot2}\n      ${shot3}${RESET}`)
  if (passed !== results.length) process.exitCode = 1
} catch (e) {
  console.error(String(e?.stack ?? e))
  process.exitCode = 1
} finally {
  cleanup()
}
