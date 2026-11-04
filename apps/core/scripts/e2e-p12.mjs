// P12 真实窗口 E2E（裸 CDP）：验证「磁力」页在 UI 上确实可用
// 运行：node apps/core/scripts/e2e-p12.mjs（需先 pnpm -r build && cargo build --release -p pf-core -p pf-magnet）
// 1) 侧栏出现「磁力」→ 页面可见，输入框与空态在位
// 2) 通过内核 RPC 加一个本机做种的磁力（UI 不支持指定 peer，这里直接调内核）
// 3) 列表出现任务并推进到「已完成」，进度条走满
// 4) 点「播放」→ 切到播放页且视频源是 /bt 代理地址
// 5) 删除任务 → 列表回到空态
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const desktop = path.join(root, 'apps/desktop')
const require = createRequire(path.join(desktop, 'package.json'))
const electronBin = require('electron')
const coreBin = path.join(root, 'apps/core/target/release/pf-core.exe')
const seedBin = path.join(root, 'apps/core/target/release/pf-bt-seed.exe')
const userData = path.join(process.env.TEMP ?? '.', `pf-e2e-p12-${process.pid}`)
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-e2e-p12-ws-'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 准备素材 + 做种 ----
const payloadDir = path.join(workspace, 'payload')
fs.mkdirSync(payloadDir, { recursive: true })
const videoPath = path.join(payloadDir, 'bigbuck.2026.mp4')
// 用 ffmpeg 生成一个**真能解码**的 mp4：否则「播放器加载出媒体」这条断言只能验证空气
const ff = spawnSync(
  'ffmpeg',
  ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15', '-t', '2',
   '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoPath],
  { stdio: 'ignore' }
)
if (ff.status !== 0) {
  console.log('  (未找到 ffmpeg，退化为随机字节文件，播放断言仅验证请求)')
  fs.writeFileSync(videoPath, Buffer.alloc(512 * 1024, 7))
}
fs.writeFileSync(path.join(payloadDir, 'readme.txt'), 'p12 e2e payload\n')

const seeder = spawn(seedBin, [payloadDir], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
const seedInfo = await new Promise((resolve, reject) => {
  let out = ''
  const timer = setTimeout(() => reject(new Error('做种器启动超时')), 30000)
  seeder.stdout.on('data', (d) => {
    out += d.toString()
    const magnet = out.match(/PF_BT_SEED_MAGNET=(magnet:\S+)/)?.[1]
    const peer = out.match(/PF_BT_SEED_PEER=([\d.]+:\d+)/)?.[1]
    if (magnet && peer) {
      clearTimeout(timer)
      resolve({ magnet, peer })
    }
  })
})
console.log(`seeder ready: ${seedInfo.peer}`)

const PORT = 9911 + (process.pid % 200)
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

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const pages = list.filter(
        (t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('devtools://')
      )
      const page = pages.find((t) => t.url.includes('index.html')) ?? pages[0]
      if (page) {
        console.log(`CDP target: ${page.url}`)
        return page
      }
    } catch {
      // 还没起来
    }
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
    throw new Error(`JS 异常: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`)
  }
  return r.result?.value
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`  ${ok ? '\x1b[32mPASS' : '\x1b[31mFAIL'}\x1b[0m ${name}${detail ? ` (${detail})` : ''}`)
}

const clickByText = (sel, text) => `
  (() => {
    const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.textContent.trim().includes(${JSON.stringify(text)}))
    if (!b) return false
    b.click()
    return true
  })()
`

try {
  await send('Runtime.enable')
  let ready = false
  for (let i = 0; i < 80; i++) {
    try {
      ready = await evalJs(`document.readyState === 'complete' && !!document.querySelector('nav')`)
    } catch {
      ready = false
    }
    if (ready) break
    await sleep(500)
  }
  check('窗口渲染完成', ready)

  const navOk = await evalJs(`
    (() => {
      const el = [...document.querySelectorAll('nav *')].find(x => x.textContent.trim() === '磁力')
      if (!el) return false
      el.click()
      return true
    })()
  `)
  await sleep(700)
  check('侧栏有「磁力」入口', navOk === true)
  const visible = await evalJs(
    `!!document.querySelector('.magnet-view') && getComputedStyle(document.querySelector('.magnet-view')).display !== 'none'`
  )
  check('磁力页可见', visible === true)

  const shell = await evalJs(`
    (() => ({
      input: !!document.querySelector('.magnet-view .url'),
      addBtn: [...document.querySelectorAll('.magnet-view .bar button')].map(b => b.textContent.trim()),
      empty: !!document.querySelector('.magnet-view .empty')
    }))()
  `)
  check('输入框与「添加任务」按钮在位', shell.input === true && shell.addBtn.join('').includes('添加任务'), JSON.stringify(shell))
  check('空态提示在位', shell.empty === true)

  // ---- 通过内核 RPC 加任务（UI 没有指定 peer 的入口）----
  const added = await evalJs(`
    window.polyframe.rpc('magnet.add', {
      url: ${JSON.stringify(seedInfo.magnet)},
      initialPeers: [${JSON.stringify(seedInfo.peer)}]
    }).then(r => r.task.id)
  `)
  check('内核接受磁力任务', typeof added === 'string' && added.length > 6, added)

  // 等列表出现任务并完成（前端 1.5s 轮询）
  let done = false
  let lastText = ''
  for (let i = 0; i < 120; i++) {
    await sleep(500)
    const st = await evalJs(`
      (() => {
        const row = document.querySelector('.magnet-view .row')
        if (!row) return { has: false }
        return {
          has: true,
          badge: row.querySelector('.badge')?.textContent.trim() ?? '',
          name: row.querySelector('.name')?.textContent.trim() ?? '',
          width: row.querySelector('.fill')?.style.width ?? ''
        }
      })()
    `)
    lastText = JSON.stringify(st)
    if (st.has && /已完成/.test(st.badge)) {
      done = true
      break
    }
  }
  check('任务出现在列表并推进到「已完成」', done === true, lastText)

  const rowInfo = await evalJs(`
    (() => {
      const row = document.querySelector('.magnet-view .row')
      return {
        badge: row?.querySelector('.badge')?.textContent.trim() ?? '',
        width: row?.querySelector('.fill')?.style.width ?? '',
        playBtn: [...(row?.querySelectorAll('.row-actions button') ?? [])].map(b => b.textContent.trim())
      }
    })()
  `)
  check('进度条走满 100%', rowInfo.width === '100%', rowInfo.width)
  check('已完成任务出现「播放」按钮', rowInfo.playBtn.includes('播放'), JSON.stringify(rowInfo.playBtn))

  // ---- 截图（列表态）----
  const shot1 = await send('Page.captureScreenshot', { format: 'png' })
  const shot1Path = path.join(root, '.screenshots', 'p12-magnet.png')
  fs.mkdirSync(path.dirname(shot1Path), { recursive: true })
  fs.writeFileSync(shot1Path, Buffer.from(shot1.data, 'base64'))
  console.log(`  截图: ${shot1Path}`)

  // ---- 点播放 → 切播放页且源为 /bt ----
  await evalJs(clickByText('.magnet-view .row-actions button', '播放'))
  let playing = false
  let playDetail = ''
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    const st = await evalJs(`
      (() => {
        const view = document.querySelector('.player-view')
        const v = document.querySelector('.player-view video')
        const src = (v && (v.currentSrc || v.src)) || ''
        return { visible: !!view && getComputedStyle(view).display !== 'none', src: src.slice(-40) }
      })()
    `)
    playing = st.visible === true
    playDetail = JSON.stringify(st)
    if (playing) break
  }
  check('点播放后切到播放页', playing === true, playDetail)

  const srcOk = await evalJs(`
    (() => {
      const v = document.querySelector('.player-view video')
      const s = (v && (v.currentSrc || v.src)) || ''
      return { bt: s.includes('/bt/'), ready: v ? v.readyState : -1, len: s.length }
    })()
  `)
  check('视频源指向 /bt 本地代理', srcOk.bt === true, JSON.stringify(srcOk))

  // 播放器真的起播（readyState >= 2 表示有元数据/可播；再等到 currentTime 前进）
  let canPlay = false
  let playReadyDetail = ''
  for (let i = 0; i < 30; i++) {
    await sleep(500)
    const st = await evalJs(`
      (() => {
        const v = document.querySelector('.player-view video')
        return v ? { rs: v.readyState, t: Number(v.currentTime.toFixed(2)), err: v.error?.code ?? 0 } : null
      })()
    `)
    playReadyDetail = JSON.stringify(st)
    if (st && st.rs >= 2 && !st.err && st.t > 0.05) {
      canPlay = true
      break
    }
  }
  check('播放器加载出媒体（readyState ≥ 2）', canPlay === true, playReadyDetail)

  // ---- 删除还原 ----
  await evalJs(clickByText('nav *', '磁力'))
  await sleep(400)
  await evalJs(clickByText('.magnet-view .row-actions button', '删除'))
  let emptyAgain = false
  for (let i = 0; i < 20; i++) {
    await sleep(400)
    emptyAgain = await evalJs(`!!document.querySelector('.magnet-view .empty')`)
    if (emptyAgain) break
  }
  check('删除后列表回到空态', emptyAgain === true)
} catch (e) {
  check('未捕获异常', false, e.message)
  console.log('\n--- app log tail ---\n' + appLog.slice(-1500))
} finally {
  const passed = results.filter((r) => r.ok).length
  console.log(`\n${passed === results.length ? '\x1b[32m' : '\x1b[31m'}E2E：${passed}/${results.length}\x1b[0m\n`)
  try {
    ws.close()
  } catch {}
  app.kill()
  seeder.kill()
  try {
    fs.rmSync(userData, { recursive: true, force: true })
  } catch {}
  try {
    fs.rmSync(workspace, { recursive: true, force: true })
  } catch {}
  process.exit(passed === results.length ? 0 : 1)
}
