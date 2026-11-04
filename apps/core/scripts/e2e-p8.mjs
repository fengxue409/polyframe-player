// P8 真实窗口 E2E（裸 CDP）：验证源站工具条在 UI 上确实可用
// 运行：node apps/core/scripts/e2e-p8.mjs（需先 pnpm -r build && pnpm core:build）
// 1) 打开「源站」面板 → 三个新按钮存在 + 预设库计数
// 2) 批量导入：粘贴本地假 CMS 站 → toast「已导入 1 个源站」+ 表格出现该行
// 3) 全部测速 → toast「测速完成：可用 N 个」
// 4) 删除该测试站（还原）
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
const userData = path.join(process.env.TEMP ?? '.', `pf-e2e-p8-${process.pid}`)

// ---- 假 CMS 站 ----
const origin = http.createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (u.searchParams.get('ac') === 'list' || u.searchParams.get('ac') === 'detail') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 1, page: 1, total: 1, list: [{ vod_id: 1, vod_name: 'E2E影片', vod_play_from: 'm3u8' }] }))
  } else {
    res.writeHead(404).end()
  }
})
const originUrl = await new Promise((resolve) =>
  origin.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${origin.address().port}/api.php/provide/vod`))
)

const PORT = 9411 + (process.pid % 200)
const app = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: desktop,
  env: (() => { const e = { ...process.env, PF_CORE_BIN: coreBin, LOCALAPPDATA: userData }; delete e.ELECTRON_RUN_AS_NODE; return e })(),
  stdio: ['ignore', 'pipe', 'pipe']
})
let appLog = ''
app.stdout.on('data', (d) => (appLog += d))
app.stderr.on('data', (d) => (appLog += d))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await r.json()
      const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('devtools://'))
      const page = pages.find((t) => t.url.includes('index.html')) ?? pages[0]
      if (page) {
        console.log(`CDP target: ${page.url}`)
        return page
      }
    } catch {
      /* 还没起来 */
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
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(`JS 异常: ${JSON.stringify(r.exceptionDetails.text)} ${r.exceptionDetails.exception?.description ?? ''}`)
  return r.result?.value
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`  ${ok ? '\x1b[32mPASS' : '\x1b[31mFAIL'}\x1b[0m ${name}${detail ? ` (${detail})` : ''}`)
}

try {
  await send('Runtime.enable')
  // 等内核在线（侧边栏/状态文案）
  let ready = false
  for (let i = 0; i < 60; i++) {
    try {
      ready = await evalJs(`document.readyState === 'complete' && !!document.body && document.body.innerText.length > 20`)
    } catch {
      ready = false
    }
    if (ready) break
    await sleep(500)
  }
  check('窗口渲染完成', ready)

  // 先切到「发现」页，保证后续操作与截图都在可见视图里
  await evalJs(`
    (() => {
      const nav = [...document.querySelectorAll('nav *')].find((el) => el.textContent.trim() === '发现')
      nav && nav.click()
      return !!nav
    })()
  `)
  await sleep(700)
  const onDiscover = await evalJs(`!!document.querySelector('.discover-view') && getComputedStyle(document.querySelector('.discover-view')).display !== 'none'`)
  check('切到发现页（视图可见）', onDiscover === true)

  // 打开源站面板
  await evalJs(`
    (() => {
      const btns = [...document.querySelectorAll('button')]
      const b = btns.find((x) => x.textContent.trim().startsWith('源站'))
      b && b.click()
      return !!b
    })()
  `)
  await sleep(800)
  const tools = await evalJs(`[...document.querySelectorAll('.sources-tools button')].map(b => b.textContent.trim())`)
  check('源站面板出现三个新工具按钮', Array.isArray(tools) && tools.length === 3, JSON.stringify(tools))
  let presetText = ''
  for (let i = 0; i < 20; i++) {
    presetText = await evalJs(
      `(document.querySelector('.sources-card .muted')?.textContent ?? '').replace(/\\s+/g,' ').trim()`
    )
    if (/预设库 [1-9]\d*\/[1-9]\d*/.test(presetText)) break
    await sleep(300)
  }
  check('预设库计数可见（已加载）', /预设库 [1-9]\d*\/[1-9]\d*/.test(presetText), presetText)

  // 打开批量导入面板
  await evalJs(`[...document.querySelectorAll('.sources-tools button')].find(b => b.textContent.includes('批量导入')).click()`)
  await sleep(400)
  check('批量导入面板展开', await evalJs(`!!document.querySelector('.import-panel textarea')`))

  // 粘贴本地假 CMS 站并导入
  const fake = `E2E测试站$${originUrl}`
  await evalJs(`
    (() => {
      const ta = document.querySelector('.import-panel textarea')
      ta.value = ${JSON.stringify(fake)}
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      const btn = [...document.querySelectorAll('.import-panel button')].find(b => b.textContent.includes('解析并导入'))
      btn.click()
      return true
    })()
  `)
  let imported = ''
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    imported = (await evalJs(`document.querySelector('.toast')?.textContent ?? ''`)) || ''
    if (imported.includes('已导入')) break
  }
  check('UI 批量导入成功（toast）', imported.includes('已导入 1 个源站'), imported)
  const hasRow = await evalJs(
    `[...document.querySelectorAll('.sources-card tbody tr')].some(tr => tr.textContent.includes('E2E测试站'))`
  )
  check('导入行出现在源站表格', hasRow === true)

  // 全部测速
  await evalJs(`[...document.querySelectorAll('.sources-tools button')].find(b => b.textContent.includes('全部测速')).click()`)
  let probeMsg = ''
  for (let i = 0; i < 90; i++) {
    await sleep(500)
    probeMsg = (await evalJs(`document.querySelector('.toast')?.textContent ?? ''`)) || ''
    if (probeMsg.includes('测速完成')) break
  }
  check('全部测速完成（toast 统计）', /测速完成：可用 \d+ 个/.test(probeMsg), probeMsg)

  // 截图存档
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const shotPath = path.join(root, '.screenshots', 'p8-sources.png')
  fs.mkdirSync(path.dirname(shotPath), { recursive: true })
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
  console.log(`  截图: ${shotPath}`)

  // 清理：删掉测试站
  await evalJs(`
    (() => {
      const rows = [...document.querySelectorAll('.sources-card tbody tr')]
      const row = rows.find(tr => tr.textContent.includes('E2E测试站'))
      if (!row) return false
      const del = [...row.querySelectorAll('button')].find(b => b.textContent.includes('删除'))
      del && del.click()
      return true
    })()
  `)
  await sleep(600)
  const gone = await evalJs(
    `![...document.querySelectorAll('.sources-card tbody tr')].some(tr => tr.textContent.includes('E2E测试站'))`
  )
  check('删除测试站（还原）', gone === true)
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
  origin.close()
  // 内核可能仍持锁，清理失败不影响结论
  try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
  process.exit(passed === results.length ? 0 : 1)
}
