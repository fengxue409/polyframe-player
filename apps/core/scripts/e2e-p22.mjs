// P22 点卡片直接播放 + 播放页右侧源切换 E2E（裸 CDP，无外网）
// 运行：node apps/core/scripts/e2e-p22.mjs（需先 pnpm -r build；内核用 release 产物）
//
// 假 CMS 起在本机，两个站返回同一部片的不同剧集；catalog.playEpisode 被替换成
// 「记录 + 跳页」，因此整条断言链只验证 UI/状态，不依赖真实媒体探测。
//
// 断言点：
//  1) 发现页点卡片主按钮 → 直接进播放页（不弹详情层），第一集入队
//  2) 侧栏「片源」下拉列出全部站，切站后标题/剧集/来源同步刷新
//  3) 侧栏「线路」下拉切换后仍停在同名的集
//  4) 播放中「手动播放/高级」默认折叠；侧栏在右；窄屏落到播放器下方
import { spawn } from 'node:child_process'
import http from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const coreRoot = path.resolve(here, '..')
const root = path.resolve(coreRoot, '../..')
const desktop = path.join(root, 'apps/desktop')
const require = createRequire(path.join(desktop, 'package.json'))
const electronBin = require('electron')
const coreBin = process.env.PF_CORE_BIN || path.join(coreRoot, 'target/release/pf-core.exe')
const userData = mkdtempSync(path.join(process.env.TEMP ?? '.', 'pf-e2e-p22-'))
const shots = path.join(process.env.TEMP ?? '.', 'pf-p22-shots')
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

// ---------- 假 CMS：/a 两个线路 3 集，/b 一个线路 5 集 ----------
const CMS_PORT = 10411 + (process.pid % 150)
const CMS = `http://127.0.0.1:${CMS_PORT}`
const eps = (prefix, n) =>
  Array.from({ length: n }, (_, i) => `第${i + 1}集$${CMS}/hls/${prefix}${i + 1}.m3u8`).join('#')

const vodItem = (playFrom, playUrl) => ({
  vod_id: 1,
  vod_name: '星际穿越',
  vod_pic: '',
  vod_year: '2014',
  vod_type_name: '科幻片',
  vod_remarks: 'HD中字',
  vod_area: '美国',
  vod_actor: '马修·麦康纳',
  vod_director: '克里斯托弗·诺兰',
  vod_content: '<p>近未来的地球黄沙遍野，粮食接连绝收。</p>',
  vod_play_from: playFrom,
  vod_play_url: playUrl
})

const cms = http.createServer((req, res) => {
  const u = new URL(req.url, CMS)
  if (u.pathname.startsWith('/a/')) {
    const body = {
      code: 1,
      msg: 'ok',
      list: [vodItem('m3u8$$$wjm3u8', eps('a', 3) + '$$$' + eps('a2', 3))]
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
    return
  }
  if (u.pathname.startsWith('/b/')) {
    const body = { code: 1, msg: 'ok', list: [vodItem('m3u8', eps('b', 5))] }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
    return
  }
  res.writeHead(404)
  res.end('no')
})
await new Promise((r) => cms.listen(CMS_PORT, '127.0.0.1', r))

const API_A = `${CMS}/a/api.php/provide/vod/`
const API_B = `${CMS}/b/api.php/provide/vod/`

const PORT = CMS_PORT + 1
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
  cms.close()
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
  try {
    cms.close()
  } catch {
    /* ignore */
  }
}

try {
  await send('Page.enable')
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

  // ---- 0) 打桩：playEpisode 只记录 + 跳页（不碰真实媒体探测） ----
  await evalJs(`(() => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
    const cat = pinia._s.get('catalog')
    const player = pinia._s.get('player')
    window.__pf = { cat, player, calls: [] }
    cat.playEpisode = async function (url, title) {
      window.__pf.calls.push({ url, title })
      player.playing = true
      player.route = 'player'
    }
    return true
  })()`)

  // ---- 1) 发现页注入卡片并点「▶ 播放」 ----
  const card = {
    key: '星际穿越|2014',
    name: '星际穿越',
    year: '2014',
    typeName: '科幻片',
    remarks: 'HD中字',
    sourceCount: 2,
    entries: [
      { siteName: 'A站', api: API_A, vodId: '1' },
      { siteName: 'B站', api: API_B, vodId: '1' }
    ]
  }
  await evalJs(`(() => {
    const cat = window.__pf.cat
    cat.cards = [${JSON.stringify(card)}]
    cat.searching = false
    cat.lastQuery = '星际穿越'
    cat.route = 'discover'
    window.__pf.player.route = 'discover'
    return true
  })()`)
  // 走导航切到发现页（保证组件挂载与真实用户一致）
  await evalJs(`(() => {
    const nav = [...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('发现'));
    nav?.click(); return !!nav
  })()`)
  await sleep(600)

  const btnText = await evalJs(
    `document.querySelector('.movie-actions .btn.primary')?.textContent?.trim() || ''`
  )
  check('卡片主按钮是「播放」', btnText.includes('播放'), btnText)

  await evalJs(`(() => { document.querySelector('.movie-actions .btn.primary')?.click(); return true })()`)
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    const r = await evalJs(`window.__pf.player.route`)
    if (r === 'player') break
  }
  const afterClick = await evalJs(`(() => {
    const { cat, player, calls } = window.__pf
    return {
      route: player.route,
      modal: !!document.querySelector('.modal-mask'),
      calls: calls.length,
      title: cat.playCtx?.title || '',
      site: cat.playCtx?.siteName || '',
      eps: cat.queue.length,
      idx: cat.queueIndex,
      sources: (cat.playCtx?.sources || []).map(s => s.siteName),
      srcIndex: cat.playCtx?.sourceIndex,
      groups: (cat.playCtx?.groups || []).map(g => g.from + ':' + g.episodes.length)
    }
  })()`)
  check('点卡片直接进播放页', afterClick.route === 'player', afterClick.route)
  check('没有弹详情层', afterClick.modal === false, String(afterClick.modal))
  check('起播第 1 集（A 站 3 集入队）', afterClick.eps === 3 && afterClick.idx === 0, JSON.stringify({ eps: afterClick.eps, idx: afterClick.idx }))
  check('侧栏片源列表 = 2 站', afterClick.sources.length === 2 && afterClick.srcIndex === 0, JSON.stringify(afterClick.sources))
  check('标题与来源正确', afterClick.title === '星际穿越' && afterClick.site === 'A站', `${afterClick.title}/${afterClick.site}`)
  check('A 站两条线路入队', JSON.stringify(afterClick.groups) === JSON.stringify(['m3u8:3', 'wjm3u8:3']), JSON.stringify(afterClick.groups))
  await sleep(400)
  const shot1 = await shot('01-after-play')

  // ---- 2) 播放页：源/线路下拉 ----
  const selects = await evalJs(`(() => {
    const sels = [...document.querySelectorAll('.source-block select')]
    return {
      count: sels.length,
      source: sels[0] ? [...sels[0].options].map(o => o.textContent.trim()) : [],
      line: sels[1] ? [...sels[1].options].map(o => o.textContent.trim()) : [],
      sourceDisabled: sels[0]?.disabled,
      lineDisabled: sels[1]?.disabled
    }
  })()`)
  check('播放源区两个下拉就位', selects.count === 2, `count=${selects.count}`)
  check('片源下拉 = A站（当前）/ B站', JSON.stringify(selects.source) === JSON.stringify(['A站（当前）', 'B站']), JSON.stringify(selects.source))
  check('线路下拉 2 项且可切换', selects.line.length === 2 && selects.lineDisabled === false, JSON.stringify(selects.line))

  // ---- 3) 先换到第 2 线路（同集名对齐），再跨站换源 ----
  await evalJs(`(() => {
    const sel = document.querySelectorAll('.source-block select')[1]
    sel.value = '1'
    sel.dispatchEvent(new Event('change'))
    return true
  })()`)
  await sleep(800)
  const lineSwitched = await evalJs(`(() => {
    const { cat } = window.__pf
    const sel = document.querySelectorAll('.source-block select')[1]
    return { gi: cat.playCtx.groupIndex, idx: cat.queueIndex, val: sel.value, calls: window.__pf.calls.length }
  })()`)
  check('切线路 → groupIndex=1', lineSwitched.gi === 1, JSON.stringify(lineSwitched))
  check('切线路后下拉自身回显正确', lineSwitched.val === '1', lineSwitched.val)

  await evalJs(`(() => {
    const sel = document.querySelectorAll('.source-block select')[0]
    sel.value = '1'
    sel.dispatchEvent(new Event('change'))
    return true
  })()`)
  await sleep(1200)
  const srcSwitched = await evalJs(`(() => {
    const { cat } = window.__pf
    const sels = document.querySelectorAll('.source-block select')
    return {
      srcIndex: cat.playCtx.sourceIndex,
      site: cat.playCtx.siteName,
      title: cat.playCtx.title,
      eps: cat.queue.length,
      gi: cat.playCtx.groupIndex,
      groups: (cat.playCtx.groups || []).map(g => g.from + ':' + g.episodes.length),
      srcText: sels[0]?.options[sels[0].selectedIndex]?.textContent?.trim() || '',
      lineCount: sels[1]?.options.length,
      srcOptions: sels[0]?.options.length,
      err: document.querySelector('.side-error')?.textContent?.trim() || ''
    }
  })()`)
  check('跨站换源 → sourceIndex=1', srcSwitched.srcIndex === 1, JSON.stringify({ i: srcSwitched.srcIndex, err: srcSwitched.err }))
  check('换源后剧集换成 B 站 5 集', srcSwitched.eps === 5, `eps=${srcSwitched.eps}`)
  check('换源后线路重置为该站 1 条', srcSwitched.groups.length === 1 && srcSwitched.gi === 0, JSON.stringify(srcSwitched.groups))
  check('来源站名同步为 B站', srcSwitched.site === 'B站', srcSwitched.site)
  check('片源下拉回显 B站（当前）', srcSwitched.srcText === 'B站（当前）', srcSwitched.srcText)
  check('换源未留下错误提示', srcSwitched.err === '', srcSwitched.err)
  const shot2 = await shot('02-source-switched')

  // ---- 4) 布局：手动播放折叠 + 侧栏位置 ----
  const layout = await evalJs(`(() => {
    const side = document.querySelector('.info-side').getBoundingClientRect()
    const v = document.querySelector('.video-wrap').getBoundingClientRect()
    const manual = document.querySelector('details.manual')
    return {
      sideW: Math.round(side.width),
      sideLeft: Math.round(side.left),
      videoRight: Math.round(v.right),
      manualOpen: manual?.open ?? null,
      manualSummary: manual?.querySelector('summary')?.textContent?.replace(/\\s+/g, ' ').trim() || ''
    }
  })()`)
  check('侧栏仍在播放器右侧', layout.sideLeft >= layout.videoRight - 40, JSON.stringify(layout))
  check('播放中「手动播放」默认折叠', layout.manualOpen === false, String(layout.manualOpen))

  // ---- 5) 窄屏：侧栏落到播放器下方 ----
  await viewport(760, 900)
  await sleep(500)
  const narrow = await evalJs(`(() => {
    const side = document.querySelector('.info-side').getBoundingClientRect()
    const v = document.querySelector('.video-wrap').getBoundingClientRect()
    const doc = document.documentElement
    return {
      sideTop: Math.round(side.top),
      videoBottom: Math.round(v.bottom),
      sideW: Math.round(side.width),
      videoW: Math.round(v.width),
      overflowX: doc.scrollWidth - doc.clientWidth
    }
  })()`)
  check('窄屏侧栏落到播放器下方', narrow.sideTop >= narrow.videoBottom - 4, JSON.stringify(narrow))
  check('窄屏无横向溢出', narrow.overflowX <= 1, `overflowX=${narrow.overflowX}`)
  const shot3 = await shot('03-narrow')
  await viewport(1440, 900)

  const failed = results.filter((r) => !r.ok)
  console.log(
    `\n${failed.length ? RED + 'FAILED' : GREEN + 'ALL PASS'}${RESET} ${results.length - failed.length}/${results.length}`
  )
  console.log(`${DIM}截图：${shots}${RESET}`)
  console.log(`${DIM}shots: ${shot1} ${shot2} ${shot3}${RESET}`)
  if (failed.length) process.exitCode = 1
} catch (e) {
  console.error(e)
  console.error(appLog.slice(-1200))
  process.exitCode = 1
} finally {
  cleanup()
}
