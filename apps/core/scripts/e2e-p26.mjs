// P26 历史播放记录 E2E（真播放 + 真 UI）
// 运行：node apps/core/scripts/e2e-p26.mjs（需先 pnpm -r build && cargo build --release）
//
// 断言的是「播过就有记录、记录能点回去」这条需求本身：
//  1) 播放页真起播后，历史自动落一条（不需要手动操作「历史」页）
//  2) 播放 6s 后进度上报落库（position > 0），不同步阻塞播放
//  3) 历史页渲染：片名 / 进度百分比 / 时间 / 操作按钮
//  4) 点历史行 → 回到播放页并续播到记录位置（pendingSeek 生效）
//  5) 删除单条 → 立即从列表消失；清空 → 回空态
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const coreRoot = path.resolve(here, '..')
const root = path.resolve(coreRoot, '../..')
const desktop = path.join(root, 'apps/desktop')
const require = createRequire(path.join(desktop, 'package.json'))
const electronBin = require('electron')
const coreBin = path.join(coreRoot, 'target/release/pf-core.exe')
const tmp = mkdtempSync(path.join(os.tmpdir(), 'pf-e2e-p26-'))

/** 公开测试用 mp4（10s / 支持 Range）：短，但足够走过 5s 进度节流 */
const MEDIA = 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4'

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

const PORT = 11500 + (process.pid % 200)
const app = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(tmp, 'profile')}`], {
  cwd: desktop,
  env: (() => {
    const e = {
      ...process.env,
      PF_CORE_BIN: coreBin,
      LOCALAPPDATA: tmp,
      PF_WINDOW_STATE: path.join(tmp, 'window-state.json')
    }
    delete e.ELECTRON_RUN_AS_NODE
    return e
  })(),
  stdio: ['ignore', 'pipe', 'pipe']
})
let appLog = ''
app.stdout.on('data', (d) => (appLog += d))
app.stderr.on('data', (d) => (appLog += d))

let target = null
for (let i = 0; i < 80; i++) {
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
  app.kill()
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
    sleep(25000).then(() => {
      throw new Error(`CDP 无响应：${expr.slice(0, 60).replace(/\s+/g, ' ')}`)
    })
  ])
  if (r.exceptionDetails) {
    throw new Error(`JS 异常: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`)
  }
  return r.result?.value
}
const rpc = (m, p) => evalJs(`window.polyframe.rpc(${JSON.stringify(m)}, ${JSON.stringify(p ?? null)})`)
const goPage = (label) =>
  evalJs(`(() => {
    const nav = [...document.querySelectorAll('.nav-item')].find(b => b.textContent.trim().includes(${JSON.stringify(label)}));
    if (!nav) return false;
    nav.click(); return true
  })()`)

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
    rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

try {
  // ---- 1) 内核在线 ----
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
  if (!online) throw new Error('内核未上线')

  const empty = await rpc('catalog.history.list', { limit: 20, offset: 0 })
  check('起始历史为空（干净库）', empty.total === 0, `total=${empty.total}`)

  // ---- 2) 播放页起播 ----
  await goPage('播放')
  await sleep(400)
  const urlSet = await evalJs(`(() => {
    const i = document.querySelector('input[placeholder^="https://"]')
    if (!i) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(i, ${JSON.stringify(MEDIA)})
    i.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  check('填入测试直链', urlSet)
  await evalJs(`document.querySelector('.url-row button.primary')?.click()`)

  // 等真起播（currentTime 前进）
  let t0 = 0
  for (let i = 0; i < 60; i++) {
    await sleep(700)
    t0 = await evalJs(`(() => {
      const v = document.querySelector('video')
      return v && Number.isFinite(v.currentTime) ? v.currentTime : 0
    })()`).catch(() => 0)
    if (t0 > 1) break
  }
  check('测试片真起播（currentTime 前进）', t0 > 1, `t=${t0?.toFixed?.(2)}s`)

  // ---- 3) 起播即落历史 ----
  let item = null
  for (let i = 0; i < 20; i++) {
    const l = await rpc('catalog.history.list', { limit: 20, offset: 0 })
    if (l.items?.length) {
      item = l.items[0]
      break
    }
    await sleep(500)
  }
  check('起播后自动写入历史（无需手动操作）', !!item, item ? `key=${item.key}` : 'null')
  check('记录的是原始 URL 而非代理地址', !!item && item.episodeUrl === MEDIA, item?.episodeUrl)
  check('标题来自播放页输入', !!item && !!item.title, item?.title)
  check('无来源站时按 URL 去重生成 key', !!item && String(item.key).startsWith('url|'), item?.key)

  // ---- 4) 进度上报（5s 节流） ----
  await sleep(7000)
  const after = await rpc('catalog.history.list', { limit: 20, offset: 0 })
  const posItem = after.items?.[0]
  check(
    '播放 7s 后进度已落库（position > 0）',
    !!posItem && posItem.positionSec > 0,
    `pos=${posItem?.positionSec} dur=${posItem?.durationSec}`
  )
  check('历史条数仍为 1（同一片不重复记）', after.total === 1, `total=${after.total}`)

  // ---- 5) 历史页渲染 ----
  await goPage('历史')
  await sleep(900)
  const pageTitle = await evalJs(`document.querySelector('.page-title')?.textContent?.trim()`)
  check('侧栏「历史」可进入', pageTitle === '播放历史', pageTitle)
  const rows = await evalJs(`(() => {
    const r = document.querySelectorAll('.hist-row')
    const first = r[0]
    return {
      count: r.length,
      name: first?.querySelector('.name')?.textContent?.trim() ?? '',
      meta: first?.querySelector('.meta')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
      ops: [...(first?.querySelectorAll('.ops button') ?? [])].map(b => b.textContent.trim()),
      barWidth: first?.querySelector('.pbar i')?.style?.width ?? ''
    }
  })()`)
  check('历史页渲染出 1 条记录', rows.count === 1, JSON.stringify(rows))
  check('显示片名', !!rows.name, rows.name)
  check('显示已看时长与百分比', /已看 .*%/.test(rows.meta), rows.meta)
  check('显示播放时间（今天/昨天/日期）', /今天|昨天|\d+-\d+/.test(rows.meta), rows.meta)
  check('操作按钮齐备（播放 + 删除）', rows.ops.length === 2 && rows.ops.some((t) => t.includes('播放')) && rows.ops.some((t) => t.includes('删除')), JSON.stringify(rows.ops))
  check('进度条宽度与百分比一致（>0）', /%$/.test(rows.barWidth) && parseFloat(rows.barWidth) > 0, rows.barWidth)

  // ---- 6) 点历史行续播 ----
  const seekFrom = Number(posItem.positionSec)
  await evalJs(`document.querySelector('.hist-row')?.click()`)
  await sleep(1500)
  const titleAfter = await evalJs(`document.querySelector('.page-title')?.textContent?.trim()`)
  check('点历史行回到播放页', titleAfter === '播放', titleAfter)
  // 续播定位：等播放器把 seek 落下去
  let seeked = 0
  for (let i = 0; i < 20; i++) {
    await sleep(700)
    seeked = await evalJs(`(() => {
      const v = document.querySelector('video')
      return v && Number.isFinite(v.currentTime) ? v.currentTime : 0
    })()`).catch(() => 0)
    if (seeked > 2) break
  }
  check(
    '续播定位到记录的进度（pendingSeek 生效）',
    seekFrom <= 15 ? seeked > 0 : seeked > 2,
    `记录 ${seekFrom.toFixed(0)}s → 当前 ${seeked.toFixed(1)}s`
  )

  // ---- 7) 删除 / 清空 ----
  await goPage('历史')
  await sleep(800)
  const beforeDel = await evalJs(`document.querySelectorAll('.hist-row').length`)
  await evalJs(`document.querySelector('.hist-row .ops button:last-child')?.click()`)
  await sleep(800)
  const afterDel = await evalJs(`document.querySelectorAll('.hist-row').length`)
  const dbDel = await rpc('catalog.history.list', { limit: 20, offset: 0 })
  check('删除单条：UI 立即移除且库里同步', beforeDel === 1 && afterDel === 0 && dbDel.total === 0, `${beforeDel} → ${afterDel}, total=${dbDel.total}`)
  const emptyHint = await evalJs(`document.querySelector('.history-view .empty-title')?.textContent?.trim() ?? ''`)
  check('删除后回空态文案', emptyHint.includes('还没有播放记录'), emptyHint)

  // 再播一次，验证「清空历史」按钮
  await rpc('catalog.history.record', { title: '临时片', episodeUrl: 'https://cdn.example.com/tmp.mp4' })
  await goPage('历史')
  await sleep(600)
  await evalJs(`(() => {
    window.__pfConfirm = window.confirm
    window.confirm = () => true
    const btn = [...document.querySelectorAll('.head button')].find(b => b.textContent.includes('清空历史'))
    btn?.click()
    return !!btn
  })()`)
  await sleep(1000)
  const afterClear = await rpc('catalog.history.list', { limit: 20, offset: 0 })
  const rowsAfterClear = await evalJs(`document.querySelectorAll('.hist-row').length`)
  check('清空历史：库与 UI 都清干净', afterClear.total === 0 && rowsAfterClear === 0, `total=${afterClear.total} rows=${rowsAfterClear}`)
} catch (e) {
  check(`异常：${e.message}`, false)
} finally {
  const pass = results.filter((r) => r.ok).length
  console.log(`\n${pass}/${results.length} 通过`)
  if (pass !== results.length) console.log(`${DIM}app log 尾部：\n${appLog.slice(-1200)}${RESET}`)
  cleanup()
  process.exit(pass === results.length ? 0 : 1)
}
