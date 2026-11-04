import { contextBridge, ipcRenderer } from 'electron'

/**
 * preload：向 Renderer 暴露最小受控 API（contextBridge）
 * 事件与状态变化均走命名通道，Renderer 侧返回取消订阅函数。
 */
const api = {
  status: (): Promise<unknown> => ipcRenderer.invoke('pf:status'),
  rpc: (method: string, params?: unknown): Promise<unknown> =>
    ipcRenderer.invoke('pf:rpc', { method, params }),
  /** 主窗口 HWND（10 进制；0 = 不可用） */
  nativeHwnd: (): Promise<number> => ipcRenderer.invoke('pf:native-hwnd'),
  /** P6 合并导出：探测 → 保存对话框 → 分片 concat；返回 { canceled } 或导出结果 */
  exportTask: (taskId: string): Promise<unknown> => ipcRenderer.invoke('pf:export', taskId),
  /** P10 嗅探：隐藏窗口实跑播放页，返回抓到的媒体直链候选 */
  sniffMedia: (url: string, timeoutMs?: number): Promise<unknown> =>
    ipcRenderer.invoke('pf:parse-sniff', { url, timeoutMs }),
  /** P10 用独立窗口打开播放页（嗅探失败兜底 / 需要登录点播时） */
  openParseWindow: (url: string): Promise<unknown> =>
    ipcRenderer.invoke('pf:parse-open-window', url),
  /**
   * P34 主题：把当前皮肤与窗口底色同步给主进程。
   * 只影响窗口在拖拽/缩放时新露出区域的填充色，不影响任何渲染逻辑。
   */
  setAppearance: (theme: string, bg: string): void => {
    ipcRenderer.send('pf:appearance-set', { theme, bg })
  },
  /**
   * P37 诊断：把渲染层的播放失败/起播状态转进主进程日志文件。
   * 只写日志，不回传任何东西；一次会话上限由主进程侧反压保护兜住。
   */
  diag: (tag: string, msg: string): void => {
    ipcRenderer.send('pf:diag-log', tag, msg)
  },
  /** 日志文件路径（用于「打开日志目录」这类排障入口） */
  diagPath: (): Promise<string> => ipcRenderer.invoke('pf:diag-path'),
  /** 资源管理器定位日志文件；文件还没生成时返回 false */
  openLog: (): Promise<boolean> => ipcRenderer.invoke('pf:open-log'),
  onEvent: (cb: (ev: unknown) => void): (() => void) => {
    const listener = (_e: unknown, ev: unknown): void => cb(ev)
    ipcRenderer.on('pf:event', listener)
    return () => ipcRenderer.removeListener('pf:event', listener)
  },
  onStatus: (cb: (st: unknown) => void): (() => void) => {
    const listener = (_e: unknown, st: unknown): void => cb(st)
    ipcRenderer.on('pf:status', listener)
    return () => ipcRenderer.removeListener('pf:status', listener)
  },
  // ---- P17 弹幕高级特效：透明覆盖层 ----
  /** 主窗口 renderer / 覆盖层页 → 主进程（窗口命令就地消化，数据命令转发覆盖层） */
  overlayCmd: (payload: unknown): void => {
    ipcRenderer.send('pf:overlay-cmd', payload)
  },
  /** 覆盖层页接收主进程转发的数据/控制命令 */
  onOverlayApply: (cb: (payload: unknown) => void): (() => void) => {
    const listener = (_e: unknown, payload: unknown): void => cb(payload)
    ipcRenderer.on('pf:overlay-apply', listener)
    return () => ipcRenderer.removeListener('pf:overlay-apply', listener)
  },
  /** 覆盖层加载完成通知（主窗口 renderer 收到后重发全量弹幕状态） */
  onOverlayReady: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('pf:overlay-ready', listener)
    return () => ipcRenderer.removeListener('pf:overlay-ready', listener)
  }
}

/**
 * 安全守卫（H1）：preload 默认注入所有 frame。
 * 主窗口会内嵌第三方播放页 iframe（ParseView），这些远程内容绝不能拿到本 API ——
 * 顶层 frame 之外一律不暴露任何能力，直接跳过 contextBridge。
 */
const isTopFrame = (() => {
  try {
    // 不用 `window` 字面量：tsconfig.node 的 lib 只有 ES2023，没有 DOM 声明。
    // preload 隔离世界里 globalThis 就是该 frame 的 window。
    const g = globalThis as unknown as { self?: unknown; top?: unknown }
    return g.self === g.top
  } catch {
    // 取 top 时若被跨源限制拦住 ⇒ 必然在子 frame 中
    return false
  }
})()

if (isTopFrame) {
  contextBridge.exposeInMainWorld('polyframe', api)
}

export type PolyframeApi = typeof api
