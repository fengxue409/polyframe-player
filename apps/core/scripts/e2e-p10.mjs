// P10 真实窗口 E2E（裸 CDP）：验证「视频解析」页在 UI 上确实可用
// 运行：node apps/core/scripts/e2e-p10.mjs（需先 pnpm -r build && pnpm core:build）
// 1) 侧栏出现「解析」→ 页面工具条在位（接口下拉 / 地址框 / 4 个动作）
// 2) 接口管理：新增本地假接口 → 表格出现该行且状态「可用」
// 3) JSON 直链解析：点「解析播放」→ 拿到直链 → 自动切播放页并起播（代理地址）
// 4) 内嵌播放：播放页型接口 → iframe 出现且 src 为接口地址
// 5) 新窗口：IPC 真的开了独立窗口（CDP target 增加）
// 6) 失效接口：明确提示「已关停」而不是「解析失败」
// 7) 清理：删掉测试接口（还原）
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
const userData = path.join(process.env.TEMP ?? '.', `pf-e2e-p10-${process.pid}`)

// ---- 假解析站点（json 直链 / 播放页可内嵌 / 关停页 / 可播 m3u8） ----
const hits = { json: 0, embed: 0, dead: 0, media: 0, sniff: 0 }
const origin = http.createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://127.0.0.1')
  const base = `http://127.0.0.1:${origin.address().port}`
  if (u.pathname === '/json') {
    hits.json++
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: 200, data: { url: `${base}/media/ep.m3u8` } }))
    return
  }
  if (u.pathname === '/embed') {
    hits.embed++
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<html><body style="background:#111"><video id="v" controls src="about:blank"></video></body></html>')
    return
  }
  if (u.pathname === '/sniffpage') {
    hits.sniff = (hits.sniff ?? 0) + 1
    // 直链在运行时拼出：静态扫描抓不到，只有真跑 JS（嗅探窗口）才能命中
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<html><body><div id="player"></div><script>
      const ext = 'm' + '3u8';
      const target = '/media/ep.' + ext + '?src=sniff';
      setTimeout(() => { fetch(target).catch(() => {}) }, 700);
    </script></body></html>`)
    return
  }
  if (u.pathname === '/dead') {
    hits.dead++
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<html><body><h1>江湖路远，后会无期</h1></body></html>')
    return
  }
  if (u.pathname === '/media/ep.m3u8') {
    hits.media++
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
    res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:4.0,\nseg0.ts\n#EXT-X-ENDLIST\n')
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

const PORT = 9711 + (process.pid % 200)
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
    const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('devtools://'))
    const page = pages.find((t) => t.url.includes('index.html')) ?? pages[0]
    if (page) {
      console.log(`CDP target: ${page.url}`)
      return page
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

/** 点击含指定文字的按钮 */
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

  // 侧栏有「解析」，切过去
  const navOk = await evalJs(`
    (() => {
      const el = [...document.querySelectorAll('nav *')].find(x => x.textContent.trim() === '解析')
      if (!el) return false
      el.click()
      return true
    })()
  `)
  await sleep(800)
  check('侧栏有「解析」入口', navOk === true)
  const visible = await evalJs(
    `!!document.querySelector('.parse-view') && getComputedStyle(document.querySelector('.parse-view')).display !== 'none'`
  )
  check('解析页可见', visible === true)

  const tools = await evalJs(`
    (() => ({
      sel: !!document.querySelector('.parse-view .sel'),
      url: !!document.querySelector('.parse-view .url'),
      btns: [...document.querySelectorAll('.parse-view .bar button')].map(b => b.textContent.trim())
    }))()
  `)
  check('工具条：接口下拉 + 地址框', tools.sel === true && tools.url === true, JSON.stringify(tools))
  check(
    '工具条：解析播放 / 内嵌播放 / 新窗口 / 接口管理',
    ['解析播放', '内嵌播放', '新窗口', '接口管理'].every((t) => tools.btns.some((b) => b.includes(t))),
    JSON.stringify(tools.btns)
  )
  check(
    '空状态给出使用说明与支持站点',
    await evalJs(
      `document.querySelector('.parse-view .ph-title')?.textContent.includes('解析播放') === true &&
       (document.querySelector('.parse-view .site-list')?.children.length ?? 0) >= 8`
    )
  )

  // ---- 接口管理：新增假接口 ----
  await evalJs(clickByText('.parse-view .bar button', '接口管理'))
  await sleep(600)
  check('接口管理面板展开', await evalJs(`!!document.querySelector('.parse-view .table')`))
  const presetCount = await evalJs(`document.querySelectorAll('.parse-view .table tbody tr').length`)
  check('预置接口已列出（含内置嗅探）', presetCount >= 6, `${presetCount} 行`)

  const addOne = async (name, api) => {
    await evalJs(`
      (() => {
        const row = document.querySelector('.parse-view .add-row')
        const inputs = row.querySelectorAll('input')
        inputs[0].value = ${JSON.stringify(name)}
        inputs[0].dispatchEvent(new Event('input', { bubbles: true }))
        inputs[1].value = ${JSON.stringify(api)}
        inputs[1].dispatchEvent(new Event('input', { bubbles: true }))
        const btn = [...row.querySelectorAll('button')].find(b => b.textContent.includes('添加'))
        btn.click()
        return true
      })()
    `)
    for (let i = 0; i < 30; i++) {
      await sleep(400)
      const has = await evalJs(
        `[...document.querySelectorAll('.parse-view .table tbody tr')].some(tr => tr.textContent.includes(${JSON.stringify(name)}))`
      )
      if (has) return true
    }
    return false
  }

  check('新增 JSON 接口入表', await addOne('E2E-JSON', `${originBase}/json?url=`))
  check('新增播放页接口入表', await addOne('E2E-EMBED', `${originBase}/embed?url=`))
  check('新增关停接口入表', await addOne('E2E-DEAD', `${originBase}/dead?url=`))
  check('新增嗅探型接口入表', await addOne('E2E-SNIFF', `${originBase}/sniffpage?url=`))
  const statusText = await evalJs(`
    (() => {
      const tr = [...document.querySelectorAll('.parse-view .table tbody tr')].find(t => t.textContent.includes('E2E-JSON'))
      return tr ? tr.textContent.replace(/\\s+/g, ' ').trim() : ''
    })()
  `)
  check('新增后测活状态显示「可用」', /可用 \d+ms/.test(statusText), statusText)

  // ---- JSON 直链：解析播放 → 切播放页起播 ----
  const pageUrl = 'https://v.qq.com/x/cover/e2e.html'
  await evalJs(`
    (() => {
      // 选中 E2E-JSON
      const sel = document.querySelector('.parse-view .sel')
      const opt = [...sel.options].find(o => o.textContent.includes('E2E-JSON'))
      sel.value = opt.value
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      const input = document.querySelector('.parse-view .url')
      input.value = ${JSON.stringify(pageUrl)}
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()
  `)
  await sleep(300)
  await evalJs(clickByText('.parse-view .bar button', '解析播放'))

  let playing = false
  let playDetail = ''
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    const st = await evalJs(
      `(() => {
         const view = document.querySelector('.player-view')
         const v = document.querySelector('.player-view video')
         const src = (v && (v.currentSrc || v.src)) || ''
         return {
           visible: !!view && getComputedStyle(view).display !== 'none',
           src,
           // hls.js 走 MSE：src 是 blob:，代理地址在 manifest 请求里
           media: src.startsWith('blob:') || src.includes('/m3u8/'),
           ready: v ? v.readyState : -1
         }
       })()`
    )
    playing = st && st.visible === true && st.media === true
    playDetail = JSON.stringify(st)
    if (playing) break
  }
  check('直链解析后自动切播放页并起播', playing === true, playDetail)
  check('假接口确实被请求', hits.json > 0, `${hits.json} 次`)
  check('代理已回源播放列表', hits.media > 0, `${hits.media} 次`)

  // ---- 内嵌播放 ----
  await evalJs(clickByText('nav *', '解析'))
  await sleep(400)
  await evalJs(`
    (() => {
      const sel = document.querySelector('.parse-view .sel')
      const opt = [...sel.options].find(o => o.textContent.includes('E2E-EMBED'))
      sel.value = opt.value
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()
  `)
  await evalJs(clickByText('.parse-view .bar button', '内嵌播放'))
  let frameSrc = ''
  for (let i = 0; i < 40; i++) {
    await sleep(400)
    frameSrc = (await evalJs(`document.querySelector('.parse-view .frame')?.getAttribute('src') ?? ''`)) || ''
    if (frameSrc) break
  }
  check('内嵌播放出现 iframe 且指向接口地址', frameSrc.includes('/embed?url='), frameSrc)
  check('内嵌状态显示「播放页」徽章', await evalJs(`!!document.querySelector('.parse-view .badge')`))

  // 内嵌播放器在位时截图（这一张是功能主界面）
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const shotPath = path.join(root, '.screenshots', 'p10-parse.png')
  fs.mkdirSync(path.dirname(shotPath), { recursive: true })
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
  console.log(`  截图: ${shotPath}`)

  // ---- 新窗口 ----
  const before = (await listTargets()).filter((t) => t.type === 'page').length
  await evalJs(clickByText('.parse-view .bar button', '新窗口'))
  let opened = false
  for (let i = 0; i < 20; i++) {
    await sleep(400)
    const list = await listTargets()
    if (list.filter((t) => t.type === 'page').length > before) {
      opened = list.some((t) => (t.url ?? '').includes('/embed'))
      break
    }
  }
  check('「新窗口」真的开了独立窗口', opened === true)

  // ---- 嗅探：接口页没有直链，只有真跑 JS 才能抓到 ----
  await evalJs(clickByText('nav *', '解析'))
  await sleep(300)
  await evalJs(`
    (() => {
      const sel = document.querySelector('.parse-view .sel')
      const opt = [...sel.options].find(o => o.textContent.includes('E2E-SNIFF'))
      sel.value = opt.value
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      const input = document.querySelector('.parse-view .url')
      input.value = ${JSON.stringify(pageUrl)}
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()
  `)
  await evalJs(clickByText('.parse-view .bar button', '解析播放'))
  let snifed = false
  let sniffDetail = ''
  for (let i = 0; i < 80; i++) {
    await sleep(500)
    const st = await evalJs(
      `(() => {
         const view = document.querySelector('.player-view')
         const v = document.querySelector('.player-view video')
         const src = (v && (v.currentSrc || v.src)) || ''
         return { visible: !!view && getComputedStyle(view).display !== 'none',
                  media: src.startsWith('blob:') || src.includes('/m3u8/') }
       })()`
    )
    snifed = st && st.visible === true && st.media === true
    sniffDetail = JSON.stringify(st)
    if (snifed) break
  }
  check('嗅探抓到运行时直链并起播', snifed === true, sniffDetail)
  check('嗅探窗口真的加载了播放页', hits.sniff > 0, `${hits.sniff} 次`)
  check('候选里有嗅探到的 m3u8', hits.media >= 2, `media 命中 ${hits.media} 次`)

  // ---- 失效接口的提示 ----
  await evalJs(clickByText('nav *', '解析'))
  await sleep(300)
  await evalJs(`
    (() => {
      const sel = document.querySelector('.parse-view .sel')
      const opt = [...sel.options].find(o => o.textContent.includes('E2E-DEAD'))
      sel.value = opt.value
      sel.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()
  `)
  await evalJs(clickByText('.parse-view .bar button', '解析播放'))
  let errText = ''
  for (let i = 0; i < 30; i++) {
    await sleep(400)
    errText = (await evalJs(`document.querySelector('.parse-view .ph.err .ph-sub')?.textContent ?? ''`)) || ''
    if (errText) break
  }
  check('失效接口提示「已关停」', /已关停/.test(errText), errText)

  // ---- 截图（错误态另存） ----
  const shotErr = await send('Page.captureScreenshot', { format: 'png' })
  const shotErrPath = path.join(root, '.screenshots', 'p10-parse-error.png')
  fs.mkdirSync(path.dirname(shotErrPath), { recursive: true })
  fs.writeFileSync(shotErrPath, Buffer.from(shotErr.data, 'base64'))
  console.log(`  截图(错误态): ${shotErrPath}`)

  // ---- 清理：删掉三个测试接口 ----
  await evalJs(clickByText('.parse-view .bar button', '接口管理'))
  await sleep(500)
  for (const name of ['E2E-JSON', 'E2E-EMBED', 'E2E-DEAD', 'E2E-SNIFF']) {
    await evalJs(`
      (() => {
        const tr = [...document.querySelectorAll('.parse-view .table tbody tr')].find(t => t.textContent.includes(${JSON.stringify(name)}))
        if (!tr) return false
        const del = [...tr.querySelectorAll('button')].find(b => b.textContent.includes('删除'))
        if (!del) return false
        del.click()
        return true
      })()
    `)
    await sleep(500)
  }
  const leftover = await evalJs(
    `[...document.querySelectorAll('.parse-view .table tbody tr')].filter(t => t.textContent.includes('E2E-')).length`
  )
  check('删除测试接口（还原）', leftover === 0, `剩余 ${leftover}`)
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
  try {
    fs.rmSync(userData, { recursive: true, force: true })
  } catch {}
  process.exit(passed === results.length ? 0 : 1)
}
