import { existsSync } from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { CoreBridge } from './rpc'
import { initDiag, logPathOf, write as diag } from './diag'
import { closeParseWindows, openParseWindow, sniffMediaUrl } from './sniff'
import { closeDanmakuOverlay, getDanmakuOverlay, registerOverlayIpc } from './overlay'
import { MIN_HEIGHT, MIN_WIDTH, loadWindowState, trackWindowState } from './window-state'

// P10：嗅探窗口要在无用户手势下自动起播（否则播放器不请求 manifest）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

let mainWindow: BrowserWindow | null = null
const core = new CoreBridge()

/** 长耗时 RPC 的超时放宽（默认 10s；批量探测类要并发跑多轮） */
const SLOW_RPC_TIMEOUT: Record<string, number> = {
  'catalog.source.import': 60_000,
  'catalog.source.probe_all': 60_000,
  'parse.resolve': 30_000,
  // P9b 网盘：目录分页 / 分享打开 / 加入任务都要真实回源（阿里云盘首屏常 1-3s）
  'netdisk.list': 45_000,
  'netdisk.account.add': 45_000,
  'netdisk.share.add': 60_000,
  'netdisk.play': 60_000,
  // 起播要探针主源/镜像 + fetch_text 软失败重试；挂死源最坏主源+兜底页两次链式拉取 ~63s，
  // 超时线要让真实错误浮出来而非掐成「RPC 超时」
  'task.create': 75_000,
  // 弹幕要回源弹弹play 搜片 + 匹配剧集 + 拉全量弹幕，慢网常 >10s
  'danmaku.open': 30_000
}

/** 定位 pf-core 可执行文件：环境变量 > 打包 resources/pf-core/ > dev release > debug */
function locateCoreBin(): string | null {
  const candidates: string[] = []
  if (process.env.PF_CORE_BIN) candidates.push(process.env.PF_CORE_BIN)
  if (app.isPackaged) {
    // electron-builder extraResources：<install>/resources/pf-core/（含 libmpv-2.dll）
    candidates.push(path.join(process.resourcesPath ?? '', 'pf-core', 'pf-core.exe'))
  }
  // dev/preview 模式 app.getAppPath() = apps/desktop，上两级即仓库根
  const workspaceRoot = path.resolve(app.getAppPath(), '../..')
  candidates.push(path.join(workspaceRoot, 'apps/core/target/release/pf-core.exe'))
  candidates.push(path.join(workspaceRoot, 'apps/core/target/debug/pf-core.exe'))
  return candidates.find((p) => p && existsSync(p)) ?? null
}

function registerIpc(): void {
  ipcMain.handle('pf:status', () => core.statusSnapshot())
  // P37：渲染层把播放失败 / hls 致命错误 / 起播状态转进同一个日志文件，
  // 让「关掉界面就查不到现场」的问题能事后复盘
  ipcMain.on('pf:diag-log', (_e, tag: string, msg: string) => diag(tag || 'ui', msg))
  ipcMain.handle('pf:diag-path', () => logPathOf())
  // 排障入口：资源管理器里定位当天日志文件
  ipcMain.handle('pf:open-log', () => {
    const p = logPathOf()
    if (!p || !existsSync(p)) return false
    shell.showItemInFolder(p)
    return true
  })
  ipcMain.handle('pf:rpc', (_e, payload: { method: string; params?: unknown }) =>
    core.request(payload.method, payload.params, SLOW_RPC_TIMEOUT[payload.method])
  )
  // P3：主窗口 HWND（Buffer 为小端 u64）→ 10 进制数字，供 mpv.attach 子窗口嵌入
  ipcMain.handle('pf:native-hwnd', () => {
    if (!mainWindow) return 0
    const buf = mainWindow.getNativeWindowHandle()
    return Number(buf.readBigUInt64LE(0))
  })
  // P34 主题：窗口底色跟随当前皮肤。只在拖拽/缩放新露出区域时可见，
  // 但缺了它，亮色主题下拖窗口边缘会闪出深色条。色值只收 #rrggbb，其余忽略。
  ipcMain.on('pf:appearance-set', (_e, payload: { theme?: string; bg?: string }) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const bg = payload?.bg
    if (typeof bg !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(bg)) return
    mainWindow.setBackgroundColor(bg)
  })
  // P6 合并导出：探测格式 → 保存对话框 → 分片 concat（大文件走长超时）
  ipcMain.handle('pf:export', async (_e, taskId: string) => {
    try {
      const info = (await core.request('task.exportInfo', { taskId })) as {
        ext: string
        done: number
        total: number
      }
      let title = 'export'
      try {
        const list = (await core.request('task.list')) as { tasks?: Array<{ id: string; title?: string }> }
        title = list.tasks?.find((t) => t.id === taskId)?.title || 'export'
      } catch {
        // 标题获取失败用保底名
      }
      const safe = title.replace(/[\\/:*?"<>|]/g, '_').trim() || 'export'
      if (!mainWindow) return { canceled: true, error: '主窗口未就绪' }
      const r = await dialog.showSaveDialog(mainWindow, {
        title: '合并导出',
        defaultPath: `${safe}.${info.ext}`,
        filters: [{ name: info.ext.toUpperCase(), extensions: [info.ext] }]
      })
      if (r.canceled || !r.filePath) return { canceled: true }
      const res = (await core.request('task.export', { taskId, outPath: r.filePath }, 600_000)) as {
        path: string
        bytes: number
        segments: number
      }
      return { canceled: false, ...res, done: info.done, total: info.total }
    } catch (err) {
      return { canceled: true, error: (err as Error).message }
    }
  })
  // P10 解析嗅探：隐藏窗口实跑播放页，从网络请求里截直链
  ipcMain.handle('pf:parse-sniff', (_e, payload: { url: string; timeoutMs?: number }) =>
    sniffMediaUrl(payload.url, payload.timeoutMs ?? 15_000)
  )
  // P10 新窗口打开播放页（嗅探失败时的人工兜底，可登录/点播）
  ipcMain.handle('pf:parse-open-window', (_e, url: string) => openParseWindow(url))
  // P17 弹幕覆盖层：窗口命令就地消化，数据命令转发覆盖层渲染页
  registerOverlayIpc(() => mainWindow)
}

function createWindow(): void {
  // P23：还原上次退出时的位置/尺寸/最大化；无历史状态时用主屏居中的默认值
  const saved = loadWindowState()
  mainWindow = new BrowserWindow({
    ...saved.bounds,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: 'PolyFrame Player',
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    // 先不显示：最大化要赶在首帧之前生效，否则会先闪一下普通尺寸的窗口
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // P23：跟踪位置/尺寸变化并在关闭时落盘（保存失败只告警，不影响退出）
  trackWindowState(mainWindow, saved)

  // P37：黑屏类问题的关键取证 —— 页面加载失败、渲染进程/GPU 进程崩溃。
  // 这些事件以前完全不记录，出现「整块黑」时无法区分是解码失败还是进程没了。
  const wc = mainWindow.webContents
  wc.on('did-fail-load', (_e, code, desc, url) => diag('web', `did-fail-load ${code} ${desc} ${url}`))
  wc.on('render-process-gone', (_e, d) =>
    diag('web', `render-process-gone reason=${d.reason} exitCode=${d.exitCode}`)
  )
  wc.on('unresponsive', () => diag('web', 'unresponsive'))
  wc.on('preload-error', (_e, p, err) => diag('web', `preload-error ${p} ${err?.message ?? err}`))

  const revealWindow = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (saved.maximized) mainWindow.maximize()
    mainWindow.show()
    // saved.minimized 只记录不还原：启动即最小化会让用户以为应用没起来
  }
  mainWindow.once('ready-to-show', revealWindow)
  // ready-to-show 依赖首帧渲染；页面异常时兜底，保证窗口一定会露面
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) revealWindow()
  }, 3000)

  // 内核事件/状态 → Renderer（P17：同步喂给弹幕覆盖层，供其维护 mpv 时钟）
  const overlayTargets = (): BrowserWindow[] => {
    const out: BrowserWindow[] = []
    if (mainWindow && !mainWindow.isDestroyed()) out.push(mainWindow)
    const ov = getDanmakuOverlay()
    if (ov) out.push(ov)
    return out
  }
  core.on('event', (ev) => {
    for (const w of overlayTargets()) w.webContents.send('pf:event', ev)
  })
  core.on('status', (st) => {
    for (const w of overlayTargets()) w.webContents.send('pf:status', st)
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(async () => {
  // P37：先开日志，后续内核拉起的每一行 stderr 都能落盘
  const p = initDiag()
  if (p) console.error(`[diag] log file: ${p}`)
  registerIpc()
  createWindow()
  await core.start(locateCoreBin())
})

// GPU 进程崩溃会直接表现为「视频区全黑但进度条在走」，必须留痕
app.on('child-process-gone', (_e, d) =>
  diag('app', `child-process-gone type=${d.type} reason=${d.reason} exitCode=${d.exitCode}`)
)

app.on('window-all-closed', () => {
  closeParseWindows()
  closeDanmakuOverlay()
  core.stop()
  app.quit()
})
