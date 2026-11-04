// P18 切页隐藏画面 E2E（真窗口 + 真播放 + Win32 取证）
// 运行：node apps/core/scripts/e2e-p18.mjs（需先 pnpm -r build && cargo build --release）
//
// 断言的是「离开播放页把 mpv 子窗口藏起来，但播放不停」这条需求本身：
//  1) mpv.visible RPC 语义：未挂接不报错（attached:false）；挂接后 attached:true
//  2) libmpv 真起播（本地代理 + 远端 mp4），子窗口可见且尺寸 = 视频区
//  3) 切到媒体库：子窗口 IsWindowVisible=false（画面藏起来），
//     期间 time-pos 继续增长、pause 仍为 no —— 播放没有被暂停
//  4) 切回播放页：子窗口重新可见，尺寸与离开前一致（矩形已重对齐）
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
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
const userData = mkdtempSync(path.join(os.tmpdir(), 'pf-e2e-p18-'))

/** 公开测试用 mp4（10s / 支持 Range；mpv 经本地代理播放） */
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

// ---- Win32 取证：主窗口下按类名找 mpv 子窗口，读可见性 + 矩形 ----
const psPath = path.join(userData, 'winq.ps1')
writeFileSync(
  psPath,
  `param([long]$Parent)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PFW {
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr c, string cls, string win);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$h = [PFW]::FindWindowEx([IntPtr]$Parent, [IntPtr]::Zero, "PF_MpvChild", $null)
if ($h -eq [IntPtr]::Zero) { '{"found":false}'; exit }
$r = New-Object PFW+RECT
[void][PFW]::GetWindowRect($h, [ref]$r)
@{ found = $true; visible = [PFW]::IsWindowVisible($h); x = $r.Left; y = $r.Top; w = $r.Right - $r.Left; h = $r.Bottom - $r.Top } | ConvertTo-Json -Compress
`,
  'utf8'
)
const shellExe = process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\' + 'power' + 'shell.exe'
function childWindow(parent) {
  try {
    const out = execFileSync(shellExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath, '-Parent', String(parent)], {
      encoding: 'utf8',
      timeout: 20000
    })
    return JSON.parse(out.trim().split('\n').pop())
  } catch {
    return { found: false }
  }
}

// ---- 启动 app ----
const PORT = 10211 + (process.pid % 150)
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
    rmSync(userData, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

try {
  // ---- 1) 内核上线 ----
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

  // ---- 2) RPC 语义：未挂接不报错 ----
  const rpc = (m, p) => evalJs(`window.polyframe.rpc(${JSON.stringify(m)}, ${JSON.stringify(p ?? null)})`)
  const before = await rpc('mpv.visible', { visible: false })
  check('mpv.visible 未挂接不报错', before?.attached === false, JSON.stringify(before))

  // ---- 3) 进播放页 → libmpv 内核 → 填 URL → 播放 ----
  await evalJs(`(() => {
    const nav = [...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('播放'));
    nav?.click(); return !!nav
  })()`)
  await sleep(300)
  const switched = await evalJs(`(() => {
    const b = [...document.querySelectorAll('.engine-btn')].find(x => x.textContent.includes('libmpv'))
    if (!b || b.disabled) return false
    b.click(); return true
  })()`)
  check('切到 libmpv 内核', switched)
  await sleep(300)
  const urlSet = await evalJs(`(() => {
    const i = document.querySelector('input[placeholder^="https://"]')
    if (!i) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(i, ${JSON.stringify(MEDIA)})
    i.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  check('填入测试直链', urlSet)
  const clickedPlay = await evalJs(`(() => {
    // 按文案精确找「播放」按钮（弹幕发送栏也有一个 primary 按钮）
    const b = [...document.querySelectorAll('button.primary')].find(x => x.textContent.trim() === '播放')
    if (!b || b.disabled) return false
    b.click(); return true
  })()`)
  check('点击播放（建任务 + 起播）', clickedPlay)

  const hwnd = await evalJs('window.polyframe.nativeHwnd()')
  let win = { found: false }
  let pos = 0
  for (let i = 0; i < 90; i++) {
    await sleep(1000)
    win = childWindow(hwnd)
    const v = await rpc('mpv.get', { name: 'time-pos' }).catch(() => null)
    pos = Number(v?.value ?? 0)
    if (win.found && win.visible && pos > 0.3) break
  }
  check('libmpv 真起播（子窗口出现 + time-pos 前进）', win.found && win.visible && pos > 0.3, `pos=${pos.toFixed(2)}s win=${JSON.stringify(win)}`)
  const rectOnPlayer = { w: win.w, h: win.h }

  // 测试片只有 10s：起播确认后归零 + 解除暂停，给「离开 → 回来」留足时长
  await rpc('mpv.set', { name: 'pause', value: 'no' }).catch(() => {})
  await rpc('mpv.seek', { seconds: 0, absolute: true }).catch(() => {})
  await sleep(1200)
  const dur = Number((await rpc('mpv.get', { name: 'duration' }).catch(() => null))?.value ?? 0)
  const t1 = Number((await rpc('mpv.get', { name: 'time-pos' }).catch(() => null))?.value ?? 0)
  check('归零后仍在播放', t1 > 0.2, `duration=${dur.toFixed(1)}s pos=${t1.toFixed(2)}s`)

  // ---- 4) 切到媒体库：画面必须藏起来，播放继续 ----
  await evalJs(`(() => {
    const nav = [...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('媒体库'));
    nav?.click(); return !!nav
  })()`)
  await sleep(900)
  win = childWindow(hwnd)
  check('切页后 mpv 子窗口不可见', win.found && win.visible === false, JSON.stringify(win))

  await sleep(1800)
  const v2 = await rpc('mpv.get', { name: 'time-pos' })
  const t2 = Number(v2?.value ?? 0)
  check('切页期间播放未暂停（time-pos 继续走）', t2 > t1 + 1.0, `${t1.toFixed(2)}s → ${t2.toFixed(2)}s`)
  const paused = await rpc('mpv.get', { name: 'pause' })
  const forCache = await rpc('mpv.get', { name: 'paused-for-cache' })
  const eof = await rpc('mpv.get', { name: 'eof-reached' })
  check(
    'pause 属性仍为 no（没被切页操作暂停）',
    String(paused?.value) === 'no',
    `pause=${paused?.value} for-cache=${forCache?.value} eof=${eof?.value}`
  )

  // ---- 5) 切回播放页：重新可见 + 矩形对齐 ----
  await evalJs(`(() => {
    const nav = [...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('播放'));
    nav?.click(); return !!nav
  })()`)
  await sleep(900)
  win = childWindow(hwnd)
  check('回到播放页后画面恢复', win.found && win.visible === true, JSON.stringify(win))
  check(
    '恢复后矩形与视频区一致',
    Math.abs(win.w - rectOnPlayer.w) <= 2 && Math.abs(win.h - rectOnPlayer.h) <= 2,
    `${rectOnPlayer.w}×${rectOnPlayer.h} → ${win.w}×${win.h}`
  )
  const v3 = await rpc('mpv.get', { name: 'time-pos' })
  check('回到播放页仍在播放', Number(v3?.value ?? 0) > t2, `${t2.toFixed(2)}s → ${Number(v3?.value ?? 0).toFixed(2)}s`)

  // ---- 6) 停止后再切页回来，不该留一块空的黑窗口 ----
  await evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '停止')
    if (!b) return false
    b.click(); return true
  })()`)
  await sleep(600)
  await evalJs(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('媒体库'))?.click()`)
  await sleep(500)
  await evalJs(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('播放'))?.click()`)
  await sleep(900)
  win = childWindow(hwnd)
  check('停止后回到播放页不留空黑窗口', win.found === false || win.visible === false, JSON.stringify(win))
} catch (e) {
  check(`异常：${e.message}`, false)
} finally {
  const pass = results.filter((r) => r.ok).length
  console.log(`\n${pass}/${results.length} 通过`)
  if (pass !== results.length) console.log(`${DIM}app log 尾部：\n${appLog.slice(-1200)}${RESET}`)
  cleanup()
  process.exit(pass === results.length ? 0 : 1)
}
