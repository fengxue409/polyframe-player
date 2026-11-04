import Hls from 'hls.js'
import { defineStore } from 'pinia'
import {
  DEFAULT_CACHE_MODE,
  LEGACY_DEFAULT_CACHE_MODE,
  RpcEvent,
  RpcMethod,
  type CacheMode,
  type CoreInfo,
  type MpvState,
  type MpvTrack,
  type ProxyStat,
  type RpcNotification,
  type SourceStat,
  type Task
} from '@polyframe/shared'
import type { CoreStatusPayload } from '@/types'

/** P1 默认测试源（Apple bipbop：CORS 开放、大陆可达，见 DESIGN.md §6） */
export const DEFAULT_TEST_URL =
  'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/bipbop_16x9_variant.m3u8'

/**
 * 剥掉 Electron / Node 的错误外壳：
 * `Error invoking remote method 'pf:rpc': Error: xxx` → `xxx`。
 * 这些前缀对用户毫无意义，直接摆到界面和提示条里只会让人以为程序坏了。
 */
export function cleanRpcMessage(raw: string): string {
  let msg = String(raw || '').trim()
  msg = msg.replace(/^Error invoking remote method '[^']*':\s*/i, '')
  msg = msg.replace(/^(?:Uncaught\s+)?(?:Error|TypeError|RangeError):\s*/i, '')
  return msg.trim()
}

export interface LogEntry {
  ts: number
  level: string
  message: string
}

/**
 * 批量清理结果（P35）。
 *
 * `failed` 是逐条失败而不是整体失败：列表快照过期（任务已被别处删掉、
 * 收藏已在另一台设备取消）在清理场景里是常态，不该让整批回滚。
 */
export interface BatchCleanupResult {
  /** delete_many 返回 */
  deleted?: number
  /** purge_cache_many 返回 */
  purged?: number
  freedBytes: number
  failed: { id: string; error: string }[]
}

/**
 * RPC 参数纯化：Vue 的 reactive/ref 是 Proxy，Electron IPC 的结构化克隆会拒绝它。
 * JSON 往返是最省事且足够安全的做法（参数全是纯数据，无 Date/BigInt/循环引用）。
 * 序列化失败就原样透传——不要因为「参数不好复制」让整个调用直接失败。
 */
export function toPlainParams(params: unknown): unknown {
  if (params === undefined || params === null) return params
  try {
    return JSON.parse(JSON.stringify(params)) as unknown
  } catch {
    return params
  }
}

/** P5 视图路由（App 壳切换，无 vue-router 依赖）；P7 增发现页；P8 增首页 */
export type AppRoute =
  | 'home'
  | 'player'
  | 'history'
  | 'parse'
  | 'netdisk'
  | 'magnet'
  | 'discover'
  | 'tasks'
  | 'library'
  | 'settings'

/** P5：从 URL 派生任务标题（文件名 / 主机名） */
export function deriveTitle(u: string): string {
  try {
    const url = new URL(u)
    const seg = url.pathname.split('/').filter(Boolean).pop()
    return seg || url.host
  } catch {
    return u
  }
}

/** 任务的显示名（日志里别只写 id，排查时认不出是哪部片） */
function taskLabel(t: Task): string {
  return t.title || deriveTitle(t.url)
}

/**
 * 判断一个非 HLS 地址是不是「能直接喂给 <video> 的媒体」。
 *
 * 只用于拦截明显不是媒体的地址（解析页、网盘分享页这类网页 URL），
 * 判不准时放行 —— 宁可让 <video> 自己报错，也不要误伤带签名参数的直链。
 */
function looksLikeDirectMedia(src: string): boolean {
  if (src.startsWith('blob:') || src.startsWith('data:')) return true
  // 本地代理的虚拟文件路径（MP4 / 网盘 v.mp4 都走这里），不带扩展名也可能成立
  if (/\/file(\/|$)|\.mp4(\?|$)/i.test(src)) return true
  try {
    const p = new URL(src).pathname.toLowerCase()
    return /\.(mp4|mkv|webm|mov|m4v|flv|ts|m4s|aac|mp3|m4a)$/.test(p)
  } catch {
    // 相对路径 / 非法 URL：交给 <video> 自己判定
    return true
  }
}

// hls.js 实例不放进 Pinia state（非序列化对象）
let hlsInstance: Hls | null = null
/** P40：停播后的延迟收敛定时器（切内核是 stop→立刻重播，见 stop 注释） */
let stopReconcileTimer: number | null = null

function destroyHls(): void {
  if (hlsInstance) {
    hlsInstance.destroy()
    hlsInstance = null
  }
}

/** 把 hls.js 的 `[networkError]: manifestLoadError` 翻成用户能照着做的话 */
function describeHlsError(type: string, details: string): string {
  if (details === 'manifestLoadError')
    return '片源清单加载失败：源站无响应、被限流或该线路已失效，建议换源后重试'
  if (details.includes('manifestParsingError'))
    return '片源清单格式异常（源站返回的不是有效 m3u8），建议换源'
  if (details === 'levelLoadError') return '清晰度清单加载失败（码率列表不可达），建议换源'
  if (details === 'fragLoadError' || details === 'fragLoadTimeOut')
    return '分片持续下载失败：源站断流或被限流，建议换源'
  if (details === 'bufferStalledError') return '缓冲停滞：带宽不足或源站限速，可降低清晰度后重试'
  if (type === 'mediaError')
    return `解码失败（${details}）：该片源编码可能不受支持，可切换 libmpv 内核重试`
  return `播放失败 [${type}]: ${details}`
}

export const usePlayerStore = defineStore('player', {
  state: () => ({
    /** electron：preload API 可用；browser：纯浏览器调试 */
    mode: window.polyframe ? 'electron' : 'browser',
    status: window.polyframe ? 'idle' : 'browser',
    statusError: '',
    coreInfo: null as CoreInfo | null,
    rpcPort: null as number | null,
    proxyPort: null as number | null,
    /** P7：代理路径 token（/pic 海报透传拼 URL 用，来自 core.hello） */
    proxyToken: '',
    url: DEFAULT_TEST_URL,
    /** P2 多镜像：逗号/空格分隔的镜像 URL（可空） */
    mirrorInput: '',
    playing: false,
    playerError: '',
    tasks: [] as Task[],
    logs: [] as LogEntry[],
    pingMs: null as number | null,
    /** P2 调试面板：源健康度快照（跟随最近一次事件的任务） */
    sourceTaskId: '' as string,
    sources: [] as SourceStat[],
    proxyStats: null as ProxyStat | null,
    /** P2.5：新建任务的缓存模式（三档选择器，localStorage 持久化）；P29 默认改为预缓存 */
    newTaskCacheMode: DEFAULT_CACHE_MODE as CacheMode,
    /** P15：播放倍速（0.25–4，localStorage 持久化；hls 写 video、mpv 写 speed 属性） */
    playbackRate: 1,
    // ---- P5 产品化：视图路由 + 跨页播放调度 ----
    route: 'home' as AppRoute,
    /** 媒体库/任务页点「播放」后置位，PlayerView 挂到 video 元素后消费 */
    pendingPlay: false,
    /**
     * P27 起播序号：每次「真的开始播一个东西」自增。
     * 历史记录/侧栏上下文都以它为准，**不能监听 sourceTaskId**——
     * 内核按 URL 复用任务（同集重播拿到同一个 id），值不变就等于事件不触发。
     */
    playSeq: 0,
    /** 最近一次起播的任务快照（playSeq 变化时由 PlayerView 消费） */
    lastPlay: null as null | { taskId: string; url: string; title: string; at: number },
    // ---- P3 libmpv 双内核 ----
    /** 播放内核：hls（页内 MSE）/ mpv（libmpv 子窗口） */
    engine: 'hls' as 'hls' | 'mpv',
    /** DLL 可用性（null = 未探测） */
    mpvAvailable: null as boolean | null,
    mpvDllPath: '',
    /** 已 attach（子窗口已创建） */
    mpvReady: false,
    /**
     * 视频表面「应当可见」的意图（离开播放页 = false）。
     *
     * 只控制 mpv 子窗口的显隐，**与播放状态无关**：切页只是把画面藏起来，
     * 解码/音频/进度照旧。放在 store 里是为了「在别的页面自动连播下一集」时
     * playMpv 能沿用同一意图，不会把窗口重新弹出来盖住当前页。
     */
    surfaceWanted: true,
    mpvState: null as MpvState | null,
    mpvTracks: [] as MpvTrack[],
    // ---- P40 单一下载槽 ----
    /**
     * 用户手动「启动」的任务 id。
     *
     * 同一时刻只允许一个任务下载（其余自动暂停）：播放中的任务优先级最高，
     * 因此起播时这里会被清空，让位给播放任务；停播后不会自动回到它身上。
     */
    manualDownloadId: '' as string,
    /**
     * 本轮会话里被**自动**暂停的任务（界面标「自动」，说明不是用户按的）。
     * 只活在内存：重启后它们就是普通暂停，语义一致（都要手动启动）。
     */
    autoPausedIds: {} as Record<string, boolean>
  }),

  getters: {
    online: (s) => s.status === 'online',
    /** 正在播放的任务 id（播放页当前承载的那个）；空串 = 没有在播的东西 */
    playingTaskId: (s) => (s.playing && s.sourceTaskId ? s.sourceTaskId : ''),
    /** 当前允许下载的任务 id：播放中优先，其次手动启动的那个 */
    downloadSlotId(): string {
      return this.playingTaskId || this.manualDownloadId
    },
    statusText: (s) => {
      if (s.mode === 'browser') return '浏览器调试模式'
      const map: Record<string, string> = {
        idle: '初始化…',
        starting: '内核启动中…',
        online: '内核在线',
        unavailable: '内核未构建',
        error: '内核异常',
        stopped: '内核已停止'
      }
      return map[s.status] ?? s.status
    }
  },

  actions: {
    async init() {
      const api = window.polyframe
      // P5：恢复 UI 偏好（默认缓存模式）
      const savedMode = localStorage.getItem('pf.newTaskCacheMode') as CacheMode | null
      if (savedMode === 'online' || savedMode === 'stream' || savedMode === 'precache') {
        this.newTaskCacheMode = savedMode
      }
      // P29 迁移：旧版本每次改倍速都会把当时的默认档（stream）写进 localStorage，
      // 那不是用户的选择。没有显式标记、且值正好等于旧默认 → 升级为新默认；
      // 值停在 online/precache 的必然是用户改过的（旧默认写不出这两个），原样保留。
      if (
        this.newTaskCacheMode === LEGACY_DEFAULT_CACHE_MODE &&
        localStorage.getItem('pf.newTaskCacheModeUser') !== '1'
      ) {
        this.newTaskCacheMode = DEFAULT_CACHE_MODE
      }
      // P15：恢复倍速记忆
      const savedRate = Number(localStorage.getItem('pf.playbackRate'))
      if (Number.isFinite(savedRate) && savedRate >= 0.25 && savedRate <= 4) {
        this.playbackRate = savedRate
      }
      if (!api) return // 浏览器模式：仅本地直连播放可用

      api.onStatus((st) => this.applyStatus(st as CoreStatusPayload))
      api.onEvent((ev) => this.handleEvent(ev as RpcNotification))

      const st = (await api.status()) as CoreStatusPayload
      this.applyStatus(st)
      if (st.status === 'online') {
        await this.refreshTasks().catch(() => {})
      }
    },

    applyStatus(st: CoreStatusPayload) {
      const wasOnline = this.status === 'online'
      this.status = st.status
      this.statusError = st.error ?? ''
      this.rpcPort = st.port ?? null
      this.proxyPort = st.proxyPort ?? st.info?.proxyPort ?? null
      if (st.info) {
        this.coreInfo = st.info
        this.proxyToken = st.info.proxyToken ?? ''
      }
      // P40：内核（重）上线时对齐下载槽。内核启动恢复会把未完结任务重新拉起来
      // （见 pf-engine restore_from_db），而此刻没有播放、也没有手动启动 →
      // 按策略它们都该是「已暂停」。这条同时兜住「重启后自动恢复下载」。
      if (st.status === 'online' && !wasOnline) void this.reconcileDownloads()
    },

    handleEvent(ev: RpcNotification) {
      switch (ev.method) {
        case RpcEvent.TaskUpdated: {
          const t = (ev.params as { task: Task }).task
          const i = this.tasks.findIndex((x) => x.id === t.id)
          const prevStatus = i >= 0 ? this.tasks[i].status : ''
          if (i >= 0) this.tasks.splice(i, 1, t)
          else this.tasks.unshift(t)
          // 同一任务同一状态会随分片进度反复推送（precache 全量下载时每秒十几条）。
          // 只有状态真的变了才记一行：否则 100 条日志槽被 `→ downloading` 占满，
          // 真正的失败原因反而被淹掉，排查时什么也看不到。
          if (prevStatus !== t.status) {
            this.pushLog('info', `任务更新：${t.id} → ${t.status}`)
          }
          break
        }
        case RpcEvent.CoreLog: {
          const p = ev.params as { level: string; message: string; ts: number }
          this.pushLog(p.level, p.message, p.ts)
          break
        }
        case RpcEvent.SourcesUpdated: {
          const p = ev.params as { taskId: string; sources: SourceStat[] }
          // 只跟随当前播放任务：`sourceTaskId` 只能由起播/删除显式改写。
          // 早前这里是「为空就认领任意任务」，后台预取任务的事件会把 sourceTaskId
          // 抢到用户没播过的东西上，历史记录就会落一条张冠李戴的假记录。
          if (this.sourceTaskId === p.taskId) this.sources = p.sources
          break
        }
        case RpcEvent.ProxyStats: {
          const p = ev.params as { taskId: string; stats: ProxyStat }
          if (!this.sourceTaskId || this.sourceTaskId === p.taskId) {
            this.proxyStats = p.stats
          }
          break
        }
        case RpcEvent.MpvState: {
          this.mpvState = ev.params as MpvState
          break
        }
      }
    },

    pushLog(level: string, message: string, ts: number = Date.now()) {
      this.logs.unshift({ ts, level, message })
      if (this.logs.length > 100) this.logs.length = 100
      // P37：warn/error 同步落盘一份。info 不转发 —— 内核 stderr 已经原样写进同一个文件，
      // 逐条走 IPC 只会在预缓存刷屏时把主进程拖慢。
      if (level === 'warn' || level === 'error') {
        window.polyframe?.diag?.(`ui-${level}`, message)
      }
    },

    // ---- P5 产品化：导航 / 任务管理 / 跨页播放 ----

    go(route: AppRoute) {
      this.route = route
    },

    saveUiPrefs() {
      localStorage.setItem('pf.newTaskCacheMode', this.newTaskCacheMode)
      localStorage.setItem('pf.playbackRate', String(this.playbackRate))
    },

    /**
     * 用户显式改「播放默认档」时调用。
     * 必须与 saveUiPrefs 分开：改倍速也会写一次偏好，若那里顺手打上标记，
     * P29 迁移就再也分不清「默认档是旧默认自动写的」还是「用户真的选了 stream」。
     */
    saveCacheModePref() {
      localStorage.setItem('pf.newTaskCacheModeUser', '1')
      this.saveUiPrefs()
    },

    /**
     * P15 倍速：hls 内核由 PlayerView 写 video.playbackRate（video 元素归它管），
     * mpv 内核走 speed 属性。memorize=false 用于临时恢复，不落偏好。
     */
    async setPlaybackRate(rate: number, memorize = true) {
      const r = Math.min(4, Math.max(0.25, rate))
      this.playbackRate = r
      if (memorize) this.saveUiPrefs()
      if (this.engine === 'mpv' && this.mpvReady) {
        await this.rpc(RpcMethod.MpvSet, { name: 'speed', value: String(r) }).catch(() => {})
      }
    },

    // ---- P40 单一下载槽：同一时刻只允许一个任务下载 ----
    //
    // 规则（任务页的分组、徽章、按钮全部由它推导）：
    //  · 播放中的任务优先占槽，起播即启动它（paused/failed 会被恢复），其余下载中任务自动暂停；
    //  · 没有播放时，用户手动「启动」的那个任务占槽，切到有预取的缓存档也算一次启动；
    //  · 被自动暂停的任务**不会自动恢复**：停播、重启、切档位都不会把它叫醒，
    //    必须用户点「启动」。所以这里从不做「记住上次谁在跑、事后恢复」。

    /** 标记「这个任务是自动暂停的」（界面据此显示「自动」，与用户手按的暂停区分） */
    markAutoPaused(taskId: string, on: boolean): void {
      if (on) this.autoPausedIds = { ...this.autoPausedIds, [taskId]: true }
      else if (this.autoPausedIds[taskId]) {
        const next = { ...this.autoPausedIds }
        delete next[taskId]
        this.autoPausedIds = next
      }
    },

    /**
     * 收敛到「只有 `keepId` 在下载」。
     *
     * `keepId` 不传时按 `downloadSlotId`（播放中 → 手动启动）判定。
     * 显式传参是给起播用的：那一刻 `playing` 还没置真（要等 video 真的播起来），
     * 靠 getter 会算出空槽，把正要播的任务自己停掉。
     */
    async enforceSingleDownload(keepId?: string): Promise<void> {
      if (this.mode !== 'electron' || this.status !== 'online') return
      const keep = keepId ?? this.downloadSlotId
      const victims = this.tasks.filter((t) => t.status === 'downloading' && t.id !== keep)
      if (!victims.length) return
      let paused = 0
      for (const t of victims) {
        try {
          await this.rpc(RpcMethod.TaskPause, { taskId: t.id })
          this.markAutoPaused(t.id, true)
          paused += 1
        } catch (e) {
          // 单个失败不该让整轮停摆：把原因写进日志就够了
          this.pushLog('warn', `自动暂停失败（${taskLabel(t)}）：${cleanRpcMessage((e as Error).message)}`)
        }
      }
      await this.refreshTasks().catch(() => {})
      if (paused) {
        this.pushLog('info', `已自动暂停 ${paused} 个非播放任务（同一时刻只允许一个任务下载）`)
      }
    },

    /**
     * 起播即启动：把下载槽交给正在播的任务。
     *
     * 播放是用户的显式动作，所以「播放即启动」不算「自动恢复」——
     * 但仅限这一次：停播后它照样回到「已暂停」，要再播/再点启动才继续。
     */
    async syncDownloadSlotForPlayback(taskId: string): Promise<void> {
      // 起播作废掉「停播收敛」：切内核会走一次 stop，别让那次停播把槽收走
      if (stopReconcileTimer !== null) {
        window.clearTimeout(stopReconcileTimer)
        stopReconcileTimer = null
      }
      this.manualDownloadId = ''
      const t = this.tasks.find((x) => x.id === taskId)
      if (t && (t.status === 'paused' || t.status === 'failed') && t.cacheMode !== 'online') {
        try {
          await this.rpc(RpcMethod.TaskResume, { taskId })
          this.markAutoPaused(taskId, false)
          await this.refreshTasks()
        } catch (e) {
          this.pushLog('warn', `起播时未能启动任务下载：${cleanRpcMessage((e as Error).message)}`)
        }
      }
      await this.enforceSingleDownload(taskId)
    },

    /** 用户手动「启动」：占住下载槽，其他下载中的任务让位（自动暂停） */
    async startTask(taskId: string): Promise<void> {
      const t = this.tasks.find((x) => x.id === taskId)
      if (t && t.cacheMode === 'online') {
        throw new Error('online 档没有预取可启动，先把缓存档切成「边下边播」或「预缓存」')
      }
      // 播放优先：别的任务正在播时不吃掉它的下载槽 —— 否则画面缺分片卡住，
      // 而用户只会看到「点启动后视频卡了」。UI 上这颗按钮此刻也是禁用的。
      const playing = this.playingTaskId
      if (playing && playing !== taskId) {
        throw new Error('正在播放其他任务，播放结束后再启动该下载')
      }
      this.manualDownloadId = taskId
      this.markAutoPaused(taskId, false)
      try {
        await this.rpc(RpcMethod.TaskResume, { taskId })
      } catch (e) {
        if (this.manualDownloadId === taskId) this.manualDownloadId = ''
        throw e
      }
      await this.refreshTasks()
      // 不传 keepId：走 downloadSlotId（播放中优先），保证播放任务的下载不被抢走
      await this.enforceSingleDownload()
    },

    /** 内核上线 / 播放状态变化后的对齐：刷新列表再收敛下载槽 */
    async reconcileDownloads(): Promise<void> {
      await this.refreshTasks().catch(() => {})
      await this.enforceSingleDownload()
    },

    async pauseTask(taskId: string) {
      await this.rpc(RpcMethod.TaskPause, { taskId })
      // 用户自己按的暂停：让出下载槽，也不该被标成「自动暂停」
      if (this.manualDownloadId === taskId) this.manualDownloadId = ''
      this.markAutoPaused(taskId, false)
      await this.refreshTasks()
    },

    async resumeTask(taskId: string) {
      // 所有「继续下载」入口统一走 startTask：否则恢复出来的任务不占槽，
      // 会被下一次收敛当成「非播放任务」立刻停掉（看起来像按钮没反应）
      await this.startTask(taskId)
    },

    /** 删除任务（缓存 + 记录）；正在播放该任务则先停 */
    async deleteTask(taskId: string, video?: HTMLVideoElement) {
      if (this.sourceTaskId === taskId && this.playing) this.stop(video)
      if (this.sourceTaskId === taskId) this.sourceTaskId = ''
      if (this.lastPlay?.taskId === taskId) this.lastPlay = null
      await this.rpc(RpcMethod.TaskDelete, { taskId })
      await this.refreshTasks()
    },

    /**
     * P35 批量删除（媒体库 / 任务页清理）。
     *
     * 单条 `task.delete` 每次都会等 400ms worker 收尾，清几十个任务要十几秒；
     * 走 `task.delete_many` 由内核把等待折叠成一次。
     * 正在播的任务被删掉时必须先停：否则 hls/mpv 还挂着已删任务的播放地址。
     */
    async deleteTasks(taskIds: string[]): Promise<BatchCleanupResult> {
      const ids = taskIds.filter(Boolean)
      if (!ids.length) return { deleted: 0, freedBytes: 0, failed: [] }
      if (this.sourceTaskId && ids.includes(this.sourceTaskId)) {
        this.stop()
        this.sourceTaskId = ''
      }
      if (this.lastPlay?.taskId && ids.includes(this.lastPlay.taskId)) this.lastPlay = null
      const r = (await this.rpc(RpcMethod.TaskDeleteMany, { taskIds: ids })) as BatchCleanupResult
      await this.refreshTasks()
      return r
    },

    /** P35 批量清缓存（保留任务记录与播放能力），清完任务回到 ready */
    async purgeTasks(taskIds: string[]): Promise<BatchCleanupResult> {
      const ids = taskIds.filter(Boolean)
      if (!ids.length) return { deleted: 0, freedBytes: 0, failed: [] }
      const r = (await this.rpc(RpcMethod.TaskPurgeCacheMany, { taskIds: ids })) as BatchCleanupResult
      await this.refreshTasks()
      return r
    },

    /** P6 合并导出：保存对话框 + 分片 concat（主进程编排，成功/取消/失败都经日志反馈） */
    async exportTask(taskId: string) {
      const api = window.polyframe
      if (!api?.exportTask) throw new Error('导出不可用（需桌面端运行）')
      const r = (await api.exportTask(taskId)) as {
        canceled: boolean
        path?: string
        bytes?: number
        segments?: number
        done?: number
        total?: number
        error?: string
      }
      if (r.canceled && r.error) {
        this.pushLog('warn', `导出失败：${r.error}`)
        throw new Error(r.error)
      }
      if (!r.canceled && r.path) {
        this.pushLog(
          'info',
          `导出完成：${r.path}（${((r.bytes ?? 0) / 1048576).toFixed(2)} MB / ${r.segments ?? 0} 分片${
            (r.done ?? 0) < (r.total ?? 0) ? '，未完成缓存导出' : ''
          }）`
        )
      }
      return r
    },

    /** 从媒体库/任务页发起播放：切播放页 + 换代理地址 + 置起播标记 */
    playTask(t: Task) {
      const u =
        this.engine === 'mpv' ? (t.masterUrl ?? t.playUrl ?? t.url) : (t.playUrl ?? t.url)
      this.url = u
      this.sourceTaskId = t.id
      this.pendingPlay = true
      this.route = 'player'
      this.markPlayStart(t)
    },

    /**
     * 起播打点：只做一件事——把「这一次起播」变成一个可观测事件。
     * 调用点必须是所有「真的开始播」的汇合处（playTask / createTask），
     * 别写成 watch(sourceTaskId)：同集重播会复用任务 id，watch 不触发。
     */
    markPlayStart(t: Task) {
      this.playSeq += 1
      this.lastPlay = { taskId: t.id, url: t.url, title: t.title ?? '', at: Date.now() }
      // P40：起播即接管下载槽（不 await —— 起播路径是同步的，画面不能被 RPC 排队）
      void this.syncDownloadSlotForPlayback(t.id)
    },

    /** 任意公开 URL 直接起播（首页等跨页入口复用；与 catalog.playEpisode 同管线） */
    async playDirect(url: string, title: string) {
      if (this.mode !== 'electron') {
        throw new Error('浏览器调试模式无内核，无法起播（请用 pnpm dev 启动桌面端）')
      }
      await this.rpc(RpcMethod.TaskCreate, {
        url,
        title,
        cacheMode: this.newTaskCacheMode
      })
      await this.refreshTasks()
      const t = this.tasks.find((x) => x.url === url)
      if (!t) throw new Error('任务创建失败')
      this.playTask(t)
    },

    rpc(method: string, params?: unknown): Promise<unknown> {
      const api = window.polyframe
      if (!api) {
        return Promise.reject(new Error('浏览器调试模式无内核 RPC（用 pnpm dev 启动桌面端）'))
      }
      // Vue reactive 是 Proxy，Electron 的 IPC 结构化克隆会直接抛
      // `An object could not be cloned`，而 Promise 拒绝点常常在 fire-and-forget
      // 里（历史打点就是），表现为「功能静默不生效」。所有 RPC 参数统一过一遍纯对象。
      return api.rpc(method, toPlainParams(params)).catch((e: unknown) => {
        // 统一成「能直接给用户看」的错误文案
        throw new Error(cleanRpcMessage(e instanceof Error ? e.message : String(e)))
      })
    },

    async ping() {
      const t0 = performance.now()
      await this.rpc(RpcMethod.CorePing)
      this.pingMs = Math.max(1, Math.round(performance.now() - t0))
    },

    async createTask(url?: string, video?: HTMLVideoElement) {
      const u = (url ?? this.url).trim()
      if (!u) throw new Error('URL 为空')
      // P2 多镜像：mirrorInput 支持逗号/空格分隔多个镜像 URL
      const sources = this.mirrorInput
        .split(/[\s,，]+/)
        .map((s) => s.trim())
        .filter(Boolean)
      if (sources.length) {
        this.pushLog('info', `多源聚合：主源 + ${sources.length} 镜像`)
      }
      const res = (await this.rpc(RpcMethod.TaskCreate, {
        url: u,
        title: deriveTitle(u),
        sources,
        cacheMode: this.newTaskCacheMode
      })) as { task?: Task }
      await this.refreshTasks()
      // P1：创建成功后自动切换到本地代理播放（Stremio 模式）；P3 mpv 内核走 masterUrl（轨道选择）
      //
      // 任务快照**直接用 create 的返回值**：内核保证成功时含 playUrl（见 pf-core 的
      // `ok_response(json!({ "task": task }))`）。早前这里丢掉返回值、改用
      // `tasks.find(x => x.url === u)` 反查 —— 一旦内核侧把 URL 规范化过（补协议/去尾斜杠），
      // 严格相等就失配，函数静默返回：不起播、不报错、页面停在黑底占位，
      // 用户看到的就是「点了播放没反应」。反查只留作返回值缺失时的兜底。
      const t = res?.task ?? this.tasks.find((x) => x.url === u)
      if (!t) {
        throw new Error('任务已创建，但没拿到任务快照（内核返回异常）')
      }
      if (!t.playUrl) {
        // 不静默：清单还没解析出来时给一句能操作的话，而不是留一块黑屏
        this.playerError = '任务已创建，但还没拿到播放地址（清单解析中），请稍后重试'
        this.pushLog('warn', `任务 ${t.id} 无 playUrl（status=${t.status}），未能起播`)
        return
      }
      const mpvUrl = this.engine === 'mpv' ? (t.masterUrl ?? t.playUrl) : t.playUrl
      this.pushLog('info', `经代理播放：${mpvUrl}`)
      this.url = mpvUrl
      this.sourceTaskId = t.id
      if (video) {
        this.markPlayStart(t)
        this.play(video)
      }
    },

    /** P2.5：切换任务缓存模式（→ online 停预取清缓存；→ stream/precache 恢复调度） */
    async setCacheMode(taskId: string, mode: CacheMode) {
      await this.rpc(RpcMethod.TaskSetCacheMode, { taskId, cacheMode: mode })
      await this.refreshTasks()
      // P40：切到有预取的档位 = 用户明确「我要下这部」→ 占住下载槽（旧槽让位）。
      // 否则内核把 job 起来、下一次收敛又立刻把它停掉，看起来就是「切了预缓存却不动」。
      // 播放中例外：槽归播放任务，这里只登记意图，别把正在播的画面的分片停掉。
      if (mode === 'online') {
        if (this.manualDownloadId === taskId) this.manualDownloadId = ''
        this.markAutoPaused(taskId, false)
        return
      }
      const playing = this.playingTaskId
      if (playing && playing !== taskId) {
        await this.enforceSingleDownload()
        this.markAutoPaused(taskId, true)
        this.pushLog('info', '已切到预缓存；当前正在播放其他任务，停播后点「启动」才会开始下载')
        return
      }
      this.manualDownloadId = taskId
      this.markAutoPaused(taskId, false)
      await this.enforceSingleDownload()
    },

    // ---- P3 libmpv 双内核 ----

    /** 探测 DLL 可用性（attach 前调用一次） */
    async probeMpv(): Promise<boolean> {
      if (this.mpvAvailable !== null) return this.mpvAvailable
      try {
        const r = (await this.rpc(RpcMethod.MpvProbe)) as { available: boolean; path?: string }
        this.mpvAvailable = r.available
        this.mpvDllPath = r.path ?? ''
        if (r.available) this.pushLog('info', `libmpv 可用：${r.path}`)
        else this.pushLog('warn', 'libmpv 不可用（未找到 libmpv-2.dll），保持 hls.js 内核')
      } catch (e) {
        this.mpvAvailable = false
        this.pushLog('warn', `libmpv 探测失败：${(e as Error).message}`)
      }
      return this.mpvAvailable
    },

    /** attach（幂等）：主窗口 HWND → Rust 创建子窗口挂接 */
    async attachMpv(): Promise<void> {
      if (this.mpvReady) return
      const api = window.polyframe
      if (!api) throw new Error('浏览器模式不支持 libmpv')
      const hwnd = await api.nativeHwnd()
      if (!hwnd) throw new Error('主窗口句柄不可用')
      const r = (await this.rpc(RpcMethod.MpvAttach, { hwnd })) as {
        attached: boolean
        reused?: boolean
      }
      if (r.attached) {
        this.mpvReady = true
        this.pushLog('info', `libmpv 已挂接主窗口（hwnd=${hwnd}${r.reused ? '，复用实例' : ''}）`)
      }
    },

    /** 切换播放内核（停止当前播放后生效） */
    async switchEngine(engine: 'hls' | 'mpv', video?: HTMLVideoElement) {
      if (engine === this.engine) return
      if (engine === 'mpv') {
        const ok = await this.probeMpv()
        if (!ok) {
          this.playerError = 'libmpv 不可用（未找到 libmpv-2.dll）'
          return
        }
      }
      // 离开 mpv 时先把子窗口藏掉（此刻 engine 还是 mpv，这条 RPC 一定发得出去）。
      // 只靠 stop() 不够：stop 是「此刻藏一下」，而视频表面是 Win32 子窗口，
      // 一旦有并发的 playMpv 还在飞、在切完之后才落地，它会把窗口重新 show 出来，
      // 那时 engine 已经变成 hls，再没有任何调用方会来藏它了（见 mpv.stop 注释）。
      if (this.engine === 'mpv') await this.mpvPushSurface(false)
      this.stop(video)
      this.engine = engine
      this.pushLog('info', `播放内核切换 → ${engine === 'mpv' ? 'libmpv' : 'hls.js'}`)
    },

    /** mpv 播放（attach + loadfile；URL 需为本地代理地址） */
    async playMpv(url: string): Promise<void> {
      // 起播途中被切回 hls 内核时，这条流程不能再往下走：attach/loadfile 会把
      // 黑子窗口重新亮出来，而此后没有任何人负责藏它（历史黑屏的成因之一）。
      if (this.engine !== 'mpv') return
      this.playerError = ''
      await this.attachMpv()
      if (this.engine !== 'mpv') return
      // loadfile 会把子窗口 show 出来 → 必须先把当前意图校准给内核：
      //  - 在别的页面上自动连播（surfaceWanted=false）不该把窗口弹出来盖住当前页；
      //  - 从「停止」状态再播（surfaceWanted=true）要能重新显示画面。
      await this.mpvPushSurface(this.surfaceWanted)
      await this.rpc(RpcMethod.MpvLoad, { url })
      // P15：新 attach 的 mpv 实例 speed 归 1，载入后补一次倍速
      if (this.playbackRate !== 1) {
        await this.rpc(RpcMethod.MpvSet, { name: 'speed', value: String(this.playbackRate) }).catch(() => {})
      }
      const [tracks] = await Promise.all([
        this.rpc(RpcMethod.MpvTracklist) as Promise<{ tracks: MpvTrack[] }>
      ])
      this.mpvTracks = tracks?.tracks ?? []
      this.playing = true
    },

    /** mpv 子窗口移动（CSS px × dpr = 物理像素） */
    async mpvMoveRect(css: { left: number; top: number; width: number; height: number }) {
      if (!this.mpvReady) return
      const dpr = window.devicePixelRatio || 1
      await this.rpc(RpcMethod.MpvMove, {
        x: Math.round(css.left * dpr),
        y: Math.round(css.top * dpr),
        w: Math.round(css.width * dpr),
        h: Math.round(css.height * dpr)
      })
    },

    /**
     * 视频表面显隐（切页隐藏画面，播放不停）。
     *
     * 分两步是为了区分「意图」与「当下是否该让窗口出来」：
     *  - `setSurfaceWanted`：记意图（是否在播放页）。即使当前是 hls 内核 /
     *    尚未 attach 也要记，等切到 mpv 或真正起播时按同一意图生效；
     *  - `mpvPushSurface`：只落 RPC，不改意图。
     * 回到播放页但已经按过「停止」时，意图是可见、实际不该显示空窗口。
     */
    setSurfaceWanted(visible: boolean) {
      this.surfaceWanted = visible
    },

    async mpvPushSurface(visible: boolean) {
      // 显示要「已挂接 + 内核是 mpv」两个前提；**隐藏不要任何前提**。
      // 视频表面是 Win32 句柄，只要它还在屏幕上，就必须保证有人关得掉它：
      //  - 内核已是 hls（切内核后 late playMpv 落地）→ 仍要能关；
      //  - `mpvReady` 因为内核重启等原因失真 → 仍要能关。
      // 内核侧对「未 attach」的 mpv.visible 会直接回 ok，所以多发一次没有副作用。
      if (visible && (this.engine !== 'mpv' || !this.mpvReady)) return
      await this.rpc(RpcMethod.MpvVisible, { visible }).catch(() => {})
    },

    async mpvTogglePause() {
      if (!this.mpvState) return
      await this.rpc(RpcMethod.MpvSet, { name: 'pause', value: this.mpvState.pause ? 'no' : 'yes' })
    },

    async mpvSeekTo(seconds: number) {
      await this.rpc(RpcMethod.MpvSeek, { seconds, absolute: true })
    },

    /** 轨道切换：aid/sid/vid（id=0 表示关闭字幕） */
    async mpvSelectTrack(kind: 'audio' | 'sub' | 'video', id: number) {
      const prop = kind === 'audio' ? 'aid' : kind === 'sub' ? 'sid' : 'vid'
      await this.rpc(RpcMethod.MpvSet, { name: prop, value: String(id) })
    },

    async refreshTasks() {
      const res = (await this.rpc(RpcMethod.TaskList)) as { tasks: Task[] }
      this.tasks = res.tasks
    },

    async play(video: HTMLVideoElement) {
      this.playerError = ''
      const src = this.url.trim()
      if (!src) {
        this.playerError = '请输入播放地址'
        return
      }
      // P3：libmpv 内核（URL 已是本地代理地址，mpv 直连即可，MP4 /file 同样支持 Range）
      if (this.engine === 'mpv') {
        const ok = await this.probeMpv()
        if (!ok) {
          this.playerError = 'libmpv 不可用（未找到 libmpv-2.dll），请切回 hls.js 内核'
          return
        }
        try {
          await this.playMpv(src)
        } catch (e) {
          this.playerError = `mpv 播放失败：${(e as Error).message}`
          this.playing = false
        }
        return
      }
      destroyHls()
      // P4：按源类型分流——HLS（.m3u8 / 代理 /m3u8/ 路径）走 hls.js；
      // MP4 直链 / 代理 /file 虚拟文件走 <video> 原生 Range 播放
      const isHlsSrc = /\.m3u8($|\?)/.test(src) || src.includes('/m3u8/')
      if (!isHlsSrc) {
        // 非 HLS 分支把 src 直接丢给 <video>：若它不是媒体地址（解析页、网盘分享页等
        // 网页 URL），浏览器只会静默失败，而下面又把 playing 置真 ——
        // 表现为「黑屏、没有画面、也没有任何报错」，最容易被当成播放器坏了。
        if (!looksLikeDirectMedia(src)) {
          this.playing = false
          this.playerError = '该地址不是可直接播放的媒体直链（需要 m3u8 / mp4，或先经解析拿到直链）'
          return
        }
        video.src = src
        this.playing = true
        void video.play().catch((e: unknown) => {
          this.playing = false
          this.playerError = `播放失败：${(e as Error)?.message || '该地址无法解码'}`
        })
        return
      }
      if (Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true })
        hlsInstance = hls
        hls.loadSource(src)
        hls.attachMedia(video)
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          void video.play().catch(() => {})
          this.playing = true
        })
        // fatal 错误 hls.js 自己不会恢复，必须显式 startLoad / recoverMediaError，
        // 否则一次边缘抖动就是永久黑屏（用户看到的 `[networkError]: manifestLoadError`
        // 多半是源站或本地代理抖了一下，重试就能回来）
        let netRetry = 0
        let mediaRetry = 0
        hls.on(Hls.Events.ERROR, (_evt, data) => {
          if (!data.fatal) return
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR && netRetry < 2) {
            netRetry++
            this.pushLog('warn', `播放清单/分片拉取失败（${data.details}），${netRetry}s 后重试 ${netRetry}/2`)
            window.setTimeout(() => {
              if (hlsInstance === hls) hls.startLoad()
            }, netRetry * 1000)
            return
          }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRetry < 2) {
            mediaRetry++
            this.pushLog('warn', `解码失败（${data.details}），尝试恢复 ${mediaRetry}/2`)
            hls.recoverMediaError()
            return
          }
          this.playing = false
          this.playerError = describeHlsError(data.type, data.details)
        })
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // 原生 HLS（Safari 系）
        video.src = src
        void video.play().catch(() => {})
        this.playing = true
      } else {
        this.playerError = '当前环境不支持 HLS 播放'
      }
    },

    /** P4 token 刷新：内核崩溃重启后 proxy token 变化，旧代理 URL 全部失效——
     *  刷新任务列表拿新 playUrl，正在播放且源为本地代理时自动重播 */
    async replayAfterReconnect(video: HTMLVideoElement) {
      if (!this.playing) return
      const isProxySrc = this.url.includes('/m3u8/') || this.url.includes('/file/')
      if (!isProxySrc) return // 手输外链不依赖 token，无需处理
      try {
        await this.refreshTasks()
        const t = this.tasks.find((x) => x.id === this.sourceTaskId)
        const fresh = this.engine === 'mpv' ? (t?.masterUrl ?? t?.playUrl) : t?.playUrl
        if (fresh) {
          this.url = fresh
          this.pushLog('info', '内核已重连，播放地址已刷新（token 更新）')
          await this.play(video)
        }
      } catch (e) {
        this.pushLog('warn', `重连恢复播放失败：${(e as Error).message}`)
      }
    },

    stop(video?: HTMLVideoElement) {
      destroyHls()
      if (video) {
        video.pause()
        video.removeAttribute('src')
        video.load()
      }
      // P3：mpv 内核停止（keep-open 下 timePos 归零由内核保证）
      if (this.mpvReady) {
        void this.rpc(RpcMethod.MpvStop).catch(() => {})
        this.mpvState = null
        this.mpvTracks = []
      }
      this.playing = false
      // P40：停播 → 它不再是「播放中」，按策略自动暂停。
      // 但 switchEngine 是 stop→立刻重播，中间必然经过这里：延迟一拍再判定，
      // 真停了才暂停，避免切内核时把正在重播的任务停掉（下载掉了但画面还在，最难查）。
      this.scheduleStopReconcile()
    },

    /** 停播后的延迟收敛：1.5s 内又播起来就作废 */
    scheduleStopReconcile(): void {
      if (stopReconcileTimer !== null) window.clearTimeout(stopReconcileTimer)
      stopReconcileTimer = window.setTimeout(() => {
        stopReconcileTimer = null
        if (this.playing) return
        void this.enforceSingleDownload('')
      }, 1500)
    }
  }
})
