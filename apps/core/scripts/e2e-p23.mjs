// P23 窗口状态持久化 E2E（真窗口 + Win32 取证，跨多次启动）
// 运行：node apps/core/scripts/e2e-p23.mjs（需先 pnpm -r build && cargo build --release）
//
// 覆盖的需求点：
//  1) 首次运行无历史状态 → 默认尺寸/居中，且能正常启动
//  2) 移动/缩放后自动落盘（无需退出就先写一次），JSON 合法
//  3) 关闭时同步 flush；进程正常退出（状态文件读写绝不阻塞退出）
//  4) 重启后位置与尺寸精确还原
//  5) 最大化关闭 → maximized 落盘（normalBounds 不被最大化矩形污染）→ 重启即最大化
//  6) 最小化关闭 → minimized 落盘 → 重启窗口可见（不还原最小化）
//  7) 状态文件损坏 → 回落默认值照常启动
//  8) 状态文件写不进去（父路径是文件）→ 启动/退出不受影响
//  9) 状态文件读不出来（路径是目录）→ 照常启动
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const base = mkdtempSync(path.join(os.tmpdir(), 'pf-e2e-p23-'))
const stateFile = path.join(base, 'window-state.json')
const profile = path.join(base, 'profile')

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

// ---- Win32 取证脚本（按 PID + 窗口标题定位 Electron 主窗口） ----
const psPath = path.join(base, 'win.ps1')
writeFileSync(
  psPath,
  `param([string]$Action, [long]$TargetPid, [int]$BoxX = 0, [int]$BoxY = 0, [int]$BoxW = 0, [int]$BoxH = 0)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class PFWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT wp);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint act, uint p, out RECT r, uint winIni);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT { public int length, flags, showCmd; public POINT p1, p2; public RECT r; }
  static IntPtr found = IntPtr.Zero;
  public static IntPtr Find(uint pid) {
    found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid) return true;
      var sb = new StringBuilder(256); GetWindowTextW(h, sb, 256);
      if (!sb.ToString().Contains("PolyFrame")) return true;
      var cn = new StringBuilder(128); GetClassNameW(h, cn, 128);
      if (!cn.ToString().StartsWith("Chrome_WidgetWin")) return true;
      found = h; return false;
    }, IntPtr.Zero);
    return found;
  }
}
"@
if ($Action -eq 'workarea') {
  $wa = New-Object PFWin+RECT
  [void][PFWin]::SystemParametersInfo(0x0030, 0, [ref]$wa, 0)
  @{ found = $true; x = $wa.Left; y = $wa.Top; w = $wa.Right - $wa.Left; h = $wa.Bottom - $wa.Top } | ConvertTo-Json -Compress
  exit
}
$h = [PFWin]::Find($TargetPid)
if ($h -eq [IntPtr]::Zero) { '{"found":false}'; exit }
function Probe {
  $r = New-Object PFWin+RECT
  [void][PFWin]::GetWindowRect($h, [ref]$r)
  $wp = New-Object PFWin+WINDOWPLACEMENT
  $wp.length = [System.Runtime.InteropServices.Marshal]::SizeOf($wp)
  [void][PFWin]::GetWindowPlacement($h, [ref]$wp)
  @{ found = $true; visible = [PFWin]::IsWindowVisible($h); x = $r.Left; y = $r.Top; w = $r.Right - $r.Left; h = $r.Bottom - $r.Top; showCmd = $wp.showCmd } | ConvertTo-Json -Compress
}
switch ($Action) {
  'probe'    { Probe }
  'move'     { [void][PFWin]::SetWindowPos($h, [IntPtr]::Zero, $BoxX, $BoxY, $BoxW, $BoxH, 0x0004); Start-Sleep -Milliseconds 200; Probe }
  'maximize' { [void][PFWin]::ShowWindow($h, 3); Start-Sleep -Milliseconds 350; Probe }
  'restore'  { [void][PFWin]::ShowWindow($h, 9); Start-Sleep -Milliseconds 350; Probe }
  'minimize' { [void][PFWin]::ShowWindow($h, 6); Start-Sleep -Milliseconds 350; Probe }
  'close'    { [void][PFWin]::PostMessageW($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero); '{"posted":true}' }
  default    { '{"error":"unknown action"}' }
}
`,
  'utf8'
)
const shellExe = process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\' + 'power' + 'shell.exe'
function win(action, pid = 0, box = null) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath, '-Action', action, '-TargetPid', String(pid)]
  if (box) args.push('-BoxX', String(box.x), '-BoxY', String(box.y), '-BoxW', String(box.w), '-BoxH', String(box.h))
  try {
    const out = execFileSync(shellExe, args, { encoding: 'utf8', timeout: 25000 })
    return JSON.parse(out.trim().split('\n').pop())
  } catch {
    return { found: false, error: 'ps failed' }
  }
}

// ---- 启动一个实例（同一份 userData/状态文件，跨启动验证持久化） ----
const instances = []
function launch(tag, env = {}) {
  const port = 11000 + (process.pid % 300) + instances.length * 7
  const proc = spawn(electronBin, ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], {
    cwd: desktop,
    env: (() => {
      const e = { ...process.env, PF_CORE_BIN: coreBin, LOCALAPPDATA: base, PF_WINDOW_STATE: stateFile, ...env }
      delete e.ELECTRON_RUN_AS_NODE
      return e
    })(),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const inst = { tag, proc, port, log: '', exited: false, code: null }
  proc.stdout.on('data', (d) => (inst.log += d))
  proc.stderr.on('data', (d) => (inst.log += d))
  proc.on('exit', (code) => {
    inst.exited = true
    inst.code = code
  })
  instances.push(inst)
  return inst
}

/** 等主窗口出现（可见） */
async function waitWindow(inst, timeoutMs = 35_000) {
  const t0 = Date.now()
  let last = { found: false }
  while (Date.now() - t0 < timeoutMs) {
    last = win('probe', inst.proc.pid)
    if (last.found && last.visible) return last
    await sleep(350)
  }
  return last
}

/** 读状态文件（不存在/损坏返回 null，交给断言去判） */
function readState() {
  try {
    if (!existsSync(stateFile)) return null
    return JSON.parse(readFileSync(stateFile, 'utf8'))
  } catch {
    return null
  }
}

/** 关闭窗口并等进程退出，返回退出码（超时返回 'timeout'） */
async function closeAndWait(inst, timeoutMs = 20_000) {
  win('close', inst.proc.pid)
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (inst.exited) return inst.code
    await sleep(200)
  }
  return 'timeout'
}

/** 通过 CDP 取渲染端 devicePixelRatio（Electron bounds 是 DIP，Win32 是物理像素） */
async function dprOf(inst) {
  let target = null
  for (let i = 0; i < 40 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${inst.port}/json/list`)).json()
      const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('devtools://'))
      target = pages.find((t) => t.url.includes('index.html')) ?? pages[0] ?? null
    } catch {
      /* retry */
    }
    if (!target) await sleep(400)
  }
  if (!target) return 1
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  try {
    const r = await new Promise((ok, rej) => {
      const id = 1
      const timer = setTimeout(() => rej(new Error('cdp timeout')), 15_000)
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data)
        if (m.id === id) {
          clearTimeout(timer)
          ok(m.result?.result?.value)
        }
      })
      ws.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression: 'window.devicePixelRatio || 1', returnByValue: true }
        })
      )
    })
    return Number(r) || 1
  } catch {
    return 1
  } finally {
    try {
      ws.close()
    } catch {
      /* ignore */
    }
  }
}

const near = (a, b, tol = 4) => Math.abs(a - b) <= tol

const cleanup = () => {
  for (const i of instances) {
    try {
      i.proc.kill()
    } catch {
      /* ignore */
    }
  }
  try {
    rmSync(base, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

try {
  const wa = win('workarea')
  check('拿到主屏工作区', wa.found === true, `${wa.w}×${wa.h} @ ${wa.x},${wa.y}`)

  // ================= 第 1 次启动：首次运行 =================
  console.log(`${DIM}— 第 1 次启动：首次运行（无历史状态）${RESET}`)
  check('首次启动前状态文件不存在', !existsSync(stateFile))
  let inst = launch('A')
  let w1 = await waitWindow(inst)
  check('首次运行窗口正常出现且可见', w1.found === true && w1.visible === true, JSON.stringify(w1))
  const dpr = await dprOf(inst)
  // 默认值 = min(1280, 工作区宽) × min(800, 工作区高)（DIP → 物理像素）
  const expW = Math.round(Math.min(1280, wa.w / dpr) * dpr)
  const expH = Math.round(Math.min(800, wa.h / dpr) * dpr)
  check(
    '首次运行使用默认尺寸（1280×800 自适应工作区）',
    near(w1.w, expW, 6) && near(w1.h, expH, 6),
    `${w1.w}×${w1.h} vs 期望 ${expW}×${expH}（dpr=${dpr}）`
  )
  check('首次运行窗口位于屏内（未被默认坐标甩出画面）', w1.x >= wa.x - 2 && w1.y >= wa.y - 2 && w1.x + w1.w <= wa.x + wa.w + 2, `x=${w1.x} y=${w1.y}`)

  // ---- 移动 + 缩放 → 自动落盘（不用等退出） ----
  const box = { x: wa.x + 120, y: wa.y + 90, w: Math.min(1000, wa.w - 200), h: Math.min(700, wa.h - 200) }
  const moved = win('move', inst.proc.pid, box)
  check('SetWindowPos 移动到目标矩形', near(moved.w, box.w, 6) && near(moved.h, box.h, 6), `${moved.x},${moved.y} ${moved.w}×${moved.h}`)
  await sleep(1200)
  const st1 = readState()
  check('移动/缩放后自动写入状态文件', !!st1 && !!st1.bounds, JSON.stringify(st1?.bounds ?? null))
  check(
    '落盘 bounds 与窗口一致（物理 ÷ dpr = DIP）',
    !!st1 && near(st1.bounds.width * dpr, box.w, 6) && near(st1.bounds.height * dpr, box.h, 6) && near(st1.bounds.x * dpr, box.x, 6),
    `${st1 ? `${st1.bounds.width}×${st1.bounds.height} @ ${st1.bounds.x},${st1.bounds.y}` : 'null'}`
  )

  // ---- 关闭 → 正常退出 ----
  const code1 = await closeAndWait(inst)
  check('关闭窗口后进程正常退出（状态写入不阻退出）', code1 === 0, `exit=${code1}`)
  const st1b = readState()
  check('退出路径 flush 后状态文件仍完整', !!st1b && near(st1b.bounds.width * dpr, box.w, 6), JSON.stringify(st1b?.bounds ?? null))

  // ================= 第 2 次启动：还原位置/尺寸 =================
  console.log(`${DIM}— 第 2 次启动：还原位置与尺寸${RESET}`)
  inst = launch('B')
  let w2 = await waitWindow(inst)
  check('重启后窗口正常出现', w2.found === true && w2.visible === true)
  check(
    '重启后位置/尺寸精确还原',
    near(w2.x, box.x, 6) && near(w2.y, box.y, 6) && near(w2.w, box.w, 6) && near(w2.h, box.h, 6),
    `${w2.x},${w2.y} ${w2.w}×${w2.h} vs 期望 ${box.x},${box.y} ${box.w}×${box.h}`
  )

  // ---- 最大化 → 关闭 ----
  const maxed = win('maximize', inst.proc.pid)
  check('窗口进入最大化（showCmd=3）', maxed.showCmd === 3, `showCmd=${maxed.showCmd} ${maxed.w}×${maxed.h}`)
  await sleep(1000)
  const code2 = await closeAndWait(inst)
  const st2 = readState()
  check('最大化状态下关闭仍正常退出', code2 === 0, `exit=${code2}`)
  check('最大化状态已落盘（maximized=true）', st2?.maximized === true, JSON.stringify(st2?.maximized))
  check(
    '落盘的 normal bounds 未被最大化矩形污染',
    !!st2 && near(st2.bounds.width * dpr, box.w, 6) && near(st2.bounds.height * dpr, box.h, 6),
    `${st2?.bounds.width}×${st2?.bounds.height}`
  )

  // ================= 第 3 次启动：还原最大化 =================
  console.log(`${DIM}— 第 3 次启动：还原最大化${RESET}`)
  inst = launch('C')
  let w3 = await waitWindow(inst)
  await sleep(600)
  w3 = win('probe', inst.proc.pid)
  check('重启后窗口可见', w3.found === true && w3.visible === true, JSON.stringify(w3))
  check('重启后恢复为最大化（showCmd=3）', w3.showCmd === 3, `showCmd=${w3.showCmd}`)
  // Windows 最大化窗口会把不可见边框（约 8px）探出工作区，所以留 16px 余量
  check('最大化窗口铺满工作区', near(w3.w, wa.w, 16) && near(w3.h, wa.h, 16), `${w3.w}×${w3.h} vs ${wa.w}×${wa.h}`)

  // ---- 还原 → 最小化 → 关闭（验证 minimized 记录） ----
  win('restore', inst.proc.pid)
  await sleep(700)
  const mini = win('minimize', inst.proc.pid)
  check('窗口进入最小化（Win32 生效）', mini.found === true, `showCmd=${mini.showCmd}`)
  await sleep(900)
  const code3 = await closeAndWait(inst)
  const st3 = readState()
  check('最小化状态下关闭仍正常退出', code3 === 0, `exit=${code3}`)
  check('最小化状态已落盘（minimized=true, maximized=false）', st3?.minimized === true && st3?.maximized === false, `minimized=${st3?.minimized} maximized=${st3?.maximized}`)

  // ================= 第 4 次启动：最小化只记录不还原 =================
  console.log(`${DIM}— 第 4 次启动：最小化只记录、不还原（否则像是启动失败）${RESET}`)
  inst = launch('D')
  const w4 = await waitWindow(inst)
  await sleep(500)
  const w4b = win('probe', inst.proc.pid)
  check('上次是最小化 → 这次窗口照常可见', w4.found === true && w4b.visible === true && w4b.showCmd !== 2, JSON.stringify(w4b))
  check(
    '并回到最小化前的正常尺寸',
    near(w4b.w, box.w, 6) && near(w4b.h, box.h, 6),
    `${w4b.w}×${w4b.h} vs 期望 ${box.w}×${box.h}`
  )
  await closeAndWait(inst)

  // ================= 容错 1：状态文件损坏 =================
  console.log(`${DIM}— 容错：状态文件损坏${RESET}`)
  writeFileSync(stateFile, '{ 这不是 JSON ', 'utf8')
  inst = launch('E')
  const w5 = await waitWindow(inst)
  check('状态文件损坏时仍能正常启动', w5.found === true && w5.visible === true, JSON.stringify(w5))
  check('损坏数据被忽略，回落到默认尺寸', near(w5.w, expW, 6) && near(w5.h, expH, 6), `${w5.w}×${w5.h} vs ${expW}×${expH}`)
  const code5 = await closeAndWait(inst)
  check('损坏状态下仍能正常退出', code5 === 0, `exit=${code5}`)
  check('退出后用合法 JSON 覆盖了损坏文件', (() => {
    const s = readState()
    return !!s && Number.isFinite(s.bounds?.width) && s.bounds.width > 0
  })(), JSON.stringify(readState()?.bounds ?? null))

  // ================= 容错 2：写不进去（父路径是普通文件） =================
  console.log(`${DIM}— 容错：状态文件不可写${RESET}`)
  const blocker = path.join(base, 'blocker')
  writeFileSync(blocker, 'x', 'utf8')
  const badPath = path.join(blocker, 'window-state.json')
  inst = launch('F', { PF_WINDOW_STATE: badPath })
  const w6 = await waitWindow(inst)
  check('状态文件不可写时仍能正常启动', w6.found === true && w6.visible === true, JSON.stringify(w6))
  win('move', inst.proc.pid, { x: wa.x + 60, y: wa.y + 60, w: 900, h: 640 })
  await sleep(900)
  const code6 = await closeAndWait(inst)
  check('保存失败不影响退出（无崩溃）', code6 === 0, `exit=${code6}`)
  check('失败路径没写出半截文件', !existsSync(badPath))

  // ================= 容错 3：读不出来（路径是目录） =================
  console.log(`${DIM}— 容错：状态路径是目录${RESET}`)
  const dirPath = path.join(base, 'state-as-dir')
  execFileSync(shellExe, ['-NoProfile', '-Command', `New-Item -ItemType Directory -Force -Path '${dirPath}' | Out-Null`], { timeout: 20_000 })
  inst = launch('G', { PF_WINDOW_STATE: dirPath })
  const w7 = await waitWindow(inst)
  check('状态路径不可读时仍能正常启动', w7.found === true && w7.visible === true, JSON.stringify(w7))
  check('读取异常回落到默认尺寸', near(w7.w, expW, 6) && near(w7.h, expH, 6), `${w7.w}×${w7.h}`)
  const code7 = await closeAndWait(inst)
  check('读取异常不影响退出', code7 === 0, `exit=${code7}`)
} catch (e) {
  check(`异常：${e.message}`, false)
} finally {
  const pass = results.filter((r) => r.ok).length
  console.log(`\n${pass}/${results.length} 通过`)
  if (pass !== results.length) {
    for (const i of instances) {
      if (i.log) console.log(`${DIM}[${i.tag}] ${i.log.slice(-800)}${RESET}`)
    }
  }
  cleanup()
  process.exit(pass === results.length ? 0 : 1)
}
