/**
 * P17 弹幕高级特效：透明覆盖层窗口（libmpv 内核专用）。
 *
 * ## 为什么需要这个窗口
 *
 * mpv 的视频表面是 Win32 子窗口（WS_CHILD + 父窗口 HWND），恒定绘制在父窗口
 * 客户区之上 —— 主窗口 renderer 的 DOM/Canvas 必然被完全遮住。ASS 字幕能画
 * 文字，但发光/渐变/图片这类富特效 libass 表达不了（图片更是完全不可能）。
 *
 * 解法：再开一个**透明无边框窗口**，owner 挂在主窗口上。Windows 的 owned
 * window 永远浮在 owner 之上（连同其子窗口 mpv 表面），于是覆盖层里用与
 * hls 路径同一套 DanmakuEngine（Canvas 2D）画弹幕，就能盖在视频上。
 *
 * ## 约束
 *
 *  - 点击穿透：`setIgnoreMouseEvents(true)`，绝不挡视频控件；
 *  - 跟随：窗口尺寸恒等于主窗口 contentBounds（500ms 兜底轮询 + 事件驱动），
 *    弹幕画布在覆盖层内的位置由主窗口 renderer 上报的视频区矩形决定；
 *  - 生命周期：惰性创建（首次 show 命令时），主窗口关闭即销毁；
 *  - 不抢焦点：focusable:false + showInactive。
 */

import path from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'

let overlayWin: BrowserWindow | null = null
let parentWin: BrowserWindow | null = null
let syncTimer: ReturnType<typeof setInterval> | null = null

export function getDanmakuOverlay(): BrowserWindow | null {
  return overlayWin && !overlayWin.isDestroyed() ? overlayWin : null
}

/** 主窗口关闭 / app 退出时调用，防泄漏 */
export function closeDanmakuOverlay(): void {
  if (syncTimer !== null) {
    clearInterval(syncTimer)
    syncTimer = null
  }
  const w = overlayWin
  overlayWin = null
  if (w && !w.isDestroyed()) w.destroy()
}

/** bounds 是否一致（避免每 500ms 白白 setBounds 抖动） */
function sameBounds(a: Electron.Rectangle, b: Electron.Rectangle): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** 覆盖层窗口尺寸恒等于主窗口内容区（DIP 坐标，与 renderer CSS px 同基准） */
function syncBounds(): void {
  const w = getDanmakuOverlay()
  if (!w || !parentWin || parentWin.isDestroyed()) return
  const target = parentWin.getContentBounds()
  if (!sameBounds(w.getBounds(), target)) w.setBounds(target)
}

/**
 * 惰性创建覆盖层。已存在直接返回（幂等）。
 * 创建后保持隐藏，等 renderer 的 `show` 命令再 showInactive。
 */
export function ensureDanmakuOverlay(parent: BrowserWindow): BrowserWindow {
  const existing = getDanmakuOverlay()
  if (existing) {
    parentWin = parent
    return existing
  }
  parentWin = parent
  overlayWin = new BrowserWindow({
    width: 1280,
    height: 800,
    parent,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    roundedCorners: false,
    // toolbar 型窗口：无任务栏项 + 不进 alt-tab，视觉上就是主窗口的一部分
    type: 'toolbar',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  overlayWin.setMenu(null)
  overlayWin.setIgnoreMouseEvents(true)
  if (process.env['ELECTRON_RENDERER_URL']) {
    void overlayWin.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/overlay.html`)
  } else {
    void overlayWin.loadFile(path.join(__dirname, '../renderer/overlay.html'))
  }
  overlayWin.on('closed', () => {
    overlayWin = null
  })
  // 事件兜底 + 低频轮询（窗口拖动/maximize 等场景事件可能漏）
  if (syncTimer === null) {
    syncTimer = setInterval(syncBounds, 500)
  }
  syncBounds()
  return overlayWin
}

/** 主窗口尺寸/位置变化时立即贴合（事件驱动，比轮询快） */
export function pokeDanmakuOverlay(): void {
  syncBounds()
}

/** 注册覆盖层相关 IPC。在 app ready 后、createWindow 前调用一次。 */
export function registerOverlayIpc(getMain: () => BrowserWindow | null): void {
  // 主窗口 renderer → 覆盖层（数据/控制命令）。`ensure/show/hide` 是窗口级命令就地消化，其余转发。
  ipcMain.on('pf:overlay-cmd', (_e, payload: { type?: string } | unknown) => {
    const type = (payload as { type?: string } | null)?.type
    const main = getMain()
    if (!main || main.isDestroyed()) return
    if (type === 'ensure') {
      if (!parentWin || parentWin.isDestroyed()) parentWin = main
      ensureDanmakuOverlay(main)
      return
    }
    const w = getDanmakuOverlay()
    if (!w) return
    if (type === 'show') {
      syncBounds()
      w.showInactive()
      return
    }
    if (type === 'hide') {
      w.hide()
      return
    }
    // 覆盖层渲染页就绪 → 广播给主窗口 renderer（重发全量弹幕状态）
    if (type === 'ready') {
      main.webContents.send('pf:overlay-ready')
      return
    }
    // 其余（items/opts/duration/seek/reset/push/rect/enabled）原样转发给覆盖层渲染页
    w.webContents.send('pf:overlay-apply', payload)
  })

  // 覆盖层就绪 → 通知主窗口 renderer 重发全量状态（覆盖层刚加载完是空数据）
  ipcMain.on('pf:overlay-ready', () => {
    const main = getMain()
    if (main && !main.isDestroyed()) main.webContents.send('pf:overlay-ready')
  })
}
