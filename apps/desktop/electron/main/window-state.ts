import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app, screen, type BrowserWindow, type Rectangle } from 'electron'

/**
 * P23：主窗口状态持久化（位置 / 尺寸 / 最大化 / 最小化）。
 *
 * 设计要点：
 * - 状态文件放 `app.getPath('userData')/window-state.json`（与内核的 `%LOCALAPPDATA%/PolyFrame` 分离，
 *   因为那是内核数据根，不该混进 UI 偏好）；测试可用 `PF_WINDOW_STATE` 指到别处。
 * - 读/写全程 try-catch + 最终兜底默认值：状态文件坏掉、目录不可写都不能影响启动与退出。
 * - 写入用「临时文件 + rename」原子替换，避免进程被杀时留下半个 JSON。
 * - 拖拽/缩放连续触发 move/resize，用 400ms 节流落盘；`close` 时同步 flush 一次。
 */

/** 与 createWindow 的最小尺寸共用一套常量，避免两处漂移 */
export const MIN_WIDTH = 720
export const MIN_HEIGHT = 560
const DEFAULT_WIDTH = 1280
const DEFAULT_HEIGHT = 800
/** 拖拽/缩放期间的落盘节流窗口 */
const SAVE_DEBOUNCE_MS = 400
/** 还原时至少要有一块「够抓得住」的区域落在某个屏幕的工作区内 */
const MIN_VISIBLE = 80
/** 尺寸上限：防止脏数据（比如 1e9）把窗口撑成怪物 */
const MAX_SIZE = 20_000

export interface WindowState {
  version: number
  bounds: Rectangle
  maximized: boolean
  minimized: boolean
  /** 上次落盘时间（ms），仅便于排查 */
  savedAt: number
}

/** 状态文件路径：环境变量可覆盖（E2E 隔离用），默认 userData 下 */
export function windowStatePath(): string {
  const override = process.env['PF_WINDOW_STATE']
  if (override) return path.resolve(override)
  return path.join(app.getPath('userData'), 'window-state.json')
}

/** 首次运行 / 无历史状态时的默认值：主屏工作区居中的 1280×800（不够大则自适应） */
export function defaultWindowState(): WindowState {
  return { version: 1, bounds: centeredDefault(), maximized: false, minimized: false, savedAt: 0 }
}

function centeredDefault(): Rectangle {
  let area = { x: 0, y: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }
  try {
    area = screen.getPrimaryDisplay().workArea
  } catch {
    // 拿不到屏幕信息（极端环境）就用左上角兜底，绝不抛
  }
  const width = Math.min(DEFAULT_WIDTH, Math.max(MIN_WIDTH, area.width))
  const height = Math.min(DEFAULT_HEIGHT, Math.max(MIN_HEIGHT, area.height))
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height
  }
}

/** 两个矩形是否有「够用」的重叠（用来判断这扇窗该归属哪块屏） */
function overlaps(a: Rectangle, b: Rectangle): boolean {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w >= MIN_VISIBLE && h >= MIN_VISIBLE
}

/**
 * 把历史 bounds 收拾成「当前屏幕下真能看到」的矩形：
 * 屏幕变小 / 换了显示器 / 拔掉副屏 都会让旧坐标落到画面外，这里压尺寸 + 拉回工作区。
 */
function fitBounds(raw: Rectangle): Rectangle {
  let displays: Electron.Display[] = []
  try {
    displays = screen.getAllDisplays()
  } catch {
    return centeredDefault()
  }
  if (!displays.length) return centeredDefault()

  const width = Math.max(MIN_WIDTH, Math.min(Math.round(raw.width), MAX_SIZE))
  const height = Math.max(MIN_HEIGHT, Math.min(Math.round(raw.height), MAX_SIZE))
  const probe: Rectangle = { x: Math.round(raw.x), y: Math.round(raw.y), width, height }

  const host = displays.find((d) => overlaps(d.workArea, probe))
  if (!host) return centeredDefault()

  const wa = host.workArea
  // 先按屏幕压尺寸（副屏拔掉后 2560 宽塞进 1366 屏也不行），再保证左上角露在屏内
  const w = Math.min(width, Math.max(MIN_WIDTH, wa.width))
  const h = Math.min(height, Math.max(MIN_HEIGHT, wa.height))
  const x = Math.min(Math.max(probe.x, wa.x), wa.x + wa.width - MIN_VISIBLE)
  const y = Math.min(Math.max(probe.y, wa.y), wa.y + wa.height - MIN_VISIBLE)
  return { x: Math.round(x), y: Math.round(y), width: w, height: h }
}

/** 读取历史状态；文件缺失 / 损坏 / 字段非法 / 读取异常 一律回落到默认值 */
export function loadWindowState(): WindowState {
  const fallback = defaultWindowState()
  const file = windowStatePath()
  try {
    if (!existsSync(file)) return fallback
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<WindowState> | null
    const b = raw?.bounds
    const ok =
      !!b &&
      Number.isFinite(b.x) &&
      Number.isFinite(b.y) &&
      Number.isFinite(b.width) &&
      Number.isFinite(b.height) &&
      b.width > 0 &&
      b.height > 0
    if (!ok) {
      console.warn('[window-state] 状态文件字段非法，改用默认窗口状态')
      return fallback
    }
    return {
      version: 1,
      bounds: fitBounds(b as Rectangle),
      // 布尔位只认 true，其余（字符串 / null / 缺字段）一律 false
      maximized: raw?.maximized === true,
      minimized: raw?.minimized === true,
      savedAt: typeof raw?.savedAt === 'number' ? raw.savedAt : 0
    }
  } catch (err) {
    console.warn('[window-state] 读取失败，改用默认窗口状态:', (err as Error).message)
    return fallback
  }
}

/** 原子写状态文件；任何失败只告警不抛（退出链路上绝不能因它卡住或崩） */
export function saveWindowState(state: WindowState): void {
  const file = windowStatePath()
  const tmp = `${file}.tmp`
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    const body: WindowState = { ...state, version: 1, savedAt: Date.now() }
    writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf8')
    renameSync(tmp, file) // Windows 上 rename 覆盖已有文件是原子替换
  } catch (err) {
    console.warn('[window-state] 保存失败（忽略）:', (err as Error).message)
    try {
      rmSync(tmp, { force: true })
    } catch {
      // 清理临时文件也失败就算了
    }
  }
}

/**
 * 给窗口挂上状态跟踪：
 * - move/resize/maximize/unmaximize/minimize/restore → 更新内存快照 + 节流落盘
 * - close → 同步 flush（退出前最后一次，保证不丢）
 */
export function trackWindowState(win: BrowserWindow, initial: WindowState): void {
  let current: WindowState = initial
  let timer: NodeJS.Timeout | null = null

  const capture = (): void => {
    if (win.isDestroyed()) return
    const minimized = win.isMinimized()
    // Windows 上最小化后 isMaximized() 会变 false，直接采信会冲掉「本来是最大化」的意图，
    // 所以最小化期间沿用上一次已知值。
    const maximized = minimized ? current.maximized : win.isMaximized()
    // 最大化/最小化时 getBounds() 给的是铺满屏幕的矩形，getNormalBounds() 才是「还原后」的尺寸
    const bounds = maximized || minimized ? win.getNormalBounds() : win.getBounds()
    current = { ...current, bounds, maximized, minimized }
  }

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    capture()
    saveWindowState(current)
  }

  const schedule = (): void => {
    capture()
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      saveWindowState(current)
    }, SAVE_DEBOUNCE_MS)
  }

  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('maximize', schedule)
  win.on('unmaximize', schedule)
  win.on('minimize', schedule)
  win.on('restore', schedule)
  win.on('close', flush)
  win.on('closed', () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  })
}
