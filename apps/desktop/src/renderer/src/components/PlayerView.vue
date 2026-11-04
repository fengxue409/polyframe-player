<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RpcMethod, type CacheMode } from '@polyframe/shared'
import { usePlayerStore } from '../stores/player'
import { useCatalogStore } from '../stores/catalog'
import { useHistoryStore } from '../stores/history'
import { useDanmakuStore } from '../stores/danmaku'
import DanmakuLayer from './DanmakuLayer.vue'
import { overlayAvailable, overlayRect } from '../danmaku/overlay'

const store = usePlayerStore()
const catalog = useCatalogStore()
const history = useHistoryStore()
const dm = useDanmakuStore()
const videoEl = ref<HTMLVideoElement | null>(null)
const videoWrapEl = ref<HTMLDivElement | null>(null)
const dmLayer = ref<InstanceType<typeof DanmakuLayer> | null>(null)
/** P5：调试面板默认折叠（多源监控 + 事件日志） */
const debugOpen = ref(false)
/** P5：创建任务进行中（等待 playlist 就绪） */
const creating = ref(false)
/** 收起态胶囊上的小圆点：取最新一条日志的级别，不点开也能看出有没有报错 */
const lastLogLevel = computed(() => store.logs[0]?.level ?? 'debug')

// ---- P20 播放页信息侧栏 ----

const SIDE_PREF_KEY = 'pf.playerSide'
/** 侧栏是否收起：宽屏默认展开、窄屏默认收起；手动切换后按 localStorage 记忆 */
const sideCollapsed = ref(false)
const contentExpanded = ref(false)
const epListEl = ref<HTMLElement | null>(null)
/**
 * P24 单滚动容器：剧集列表/事件日志不再各自 `overflow:auto`（多层滚动条），
 * 改成「默认只显示一屏内可容纳的条数 + 展开全部」，展开后由页面主滚动条统一承载。
 */
const EP_PREVIEW = 12
const LOG_PREVIEW = 8
const epExpanded = ref(false)
const logExpanded = ref(false)
/** 正在切换的队列下标（-1 = 空闲）：驱动按钮禁用与加载提示 */
const picking = ref(-1)
const switchingGroup = ref(false)
/** P22 跨站换源进行中 */
const switchingSource = ref(false)
const sideError = ref('')
/** 当前播放位置/时长（侧栏进度条；与进度上报的 5s 节流互不影响） */
const playPos = ref(0)
const playDur = ref(0)

const playCtx = computed(() => catalog.playCtx)
const playGroups = computed(() => catalog.playGroups)
const queue = computed(() => catalog.queue)
const queueIndex = computed(() => catalog.queueIndex)
const currentEpName = computed(
  () => catalog.currentEpisode?.name ?? playCtx.value?.subtitle ?? ''
)
const ctxContent = computed(() => cleanRichText(playCtx.value?.content ?? ''))

/** 剧集折叠后的可见窗口：始终把当前集包含在预览里，否则换集后「当前集看不见」 */
const visibleEps = computed(() => {
  const q = queue.value
  if (epExpanded.value || q.length <= EP_PREVIEW) return q.map((ep, i) => ({ ep, i }))
  const half = Math.floor(EP_PREVIEW / 2)
  const maxStart = q.length - EP_PREVIEW
  const start = Math.min(Math.max(0, queueIndex.value - half), Math.max(0, maxStart))
  return q.slice(start, start + EP_PREVIEW).map((ep, k) => ({ ep, i: start + k }))
})
/** 折叠时前面/后面还藏了多少集（给提示文案） */
const epsHidden = computed(() => {
  const q = queue.value
  if (epExpanded.value || q.length <= EP_PREVIEW) return { before: 0, after: 0 }
  const visible = visibleEps.value
  const first = visible[0]?.i ?? 0
  const last = visible[visible.length - 1]?.i ?? -1
  return { before: first, after: q.length - 1 - last }
})
/** 事件日志：newest-first，折叠时只渲染最新若干条（overflow 交给页面） */
const visibleLogs = computed(() =>
  logExpanded.value ? store.logs : store.logs.slice(0, LOG_PREVIEW)
)

const progressPct = computed(() => {
  if (!playDur.value || playDur.value <= 0) return 0
  return Math.min(100, Math.max(0, (playPos.value / playDur.value) * 100))
})

/** 播放状态：mpv 看状态泵，hls 看 playing + video.paused */
const playStateLabel = computed(() => {
  if (store.engine === 'mpv') {
    const s = store.mpvState
    if (!s || (!s.playing && !s.eof)) return '待播放'
    if (s.eof) return '已播完'
    return s.pause ? '已暂停' : '播放中'
  }
  if (!store.playing) return '待播放'
  return videoEl.value?.paused ? '已暂停' : '播放中'
})

/** 采集站简介常带 HTML（<p>、&nbsp;）：剥标签 + 还原实体 + 压缩空白（与详情弹层同款） */
function cleanRichText(raw: string): string {
  if (!raw) return ''
  const text = raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#0?39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, '&')
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

/** 收起/展开侧栏：只改布局，不动播放；layout 变化后把 mpv 子窗口重对齐 */
function setSide(collapsed: boolean): void {
  if (sideCollapsed.value === collapsed) return
  sideCollapsed.value = collapsed
  localStorage.setItem(SIDE_PREF_KEY, collapsed ? '0' : '1')
  void nextTick(() => {
    syncMpvRect()
    window.setTimeout(syncMpvRect, 120)
  })
}

/**
 * 进度上报（收藏进度 + P26 历史记录共用入口）：
 * 两个落点都要写，否则「继续观看」与「历史」的进度会各说各话。
 */
function reportProgress(position: number, duration: number): void {
  void catalog.reportProgress(position, duration)
  void history.updateProgress(position, duration)
}

/** 切集/切线路前把当前进度落库（不等 5s 节流，否则最后几秒白看） */
function flushProgress(): void {
  if (store.engine === 'mpv') {
    const s = store.mpvState
    if (s?.timePos != null && s.duration) reportProgress(s.timePos, s.duration)
    return
  }
  const v = videoEl.value
  if (v && Number.isFinite(v.duration) && v.duration > 0) {
    lastReport = Date.now()
    reportProgress(v.currentTime, v.duration)
  }
}

/** 点当前集但已经停住：直接续播（重建任务会丢进度） */
function resumeCurrent(): void {
  if (store.engine === 'mpv') {
    if (store.mpvState?.pause) void store.mpvTogglePause()
    return
  }
  const v = videoEl.value
  if (v?.paused) void v.play().catch(() => {})
}

/** 侧栏选集：就地换集（播放页保活，不跳页不卸载）；失败留给侧栏提示并可重试 */
async function onPickEpisode(i: number, force = false): Promise<void> {
  if (picking.value >= 0 || i < 0 || i >= queue.value.length) return
  sideError.value = ''
  flushProgress()
  picking.value = i
  try {
    const started = await catalog.playAt(i, force)
    if (!started) resumeCurrent()
  } catch (e) {
    sideError.value = (e as Error).message
  } finally {
    picking.value = -1
  }
}

/** 侧栏切线路：按集名对齐尽量停在同集 */
async function onPickGroup(gi: number): Promise<void> {
  if (switchingGroup.value || gi === (playCtx.value?.groupIndex ?? 0)) return
  sideError.value = ''
  flushProgress()
  switchingGroup.value = true
  try {
    await catalog.switchPlayGroup(gi)
  } catch (e) {
    sideError.value = (e as Error).message
  } finally {
    switchingGroup.value = false
  }
}

/** 下拉选线路（原生 select 改值不回写状态，失败时要把值拨回去） */
function onPickGroupSelect(ev: Event): void {
  const el = ev.target as HTMLSelectElement
  const gi = Number(el.value)
  if (!Number.isFinite(gi)) return
  const cur = playCtx.value?.groupIndex ?? 0
  if (gi === cur) return
  onPickGroup(gi).then(() => {
    if ((playCtx.value?.groupIndex ?? 0) !== gi) el.value = String(playCtx.value?.groupIndex ?? 0)
  })
}

/** 下拉跨站换源：拉目标站详情后按集名对齐续播 */
async function onPickSource(ev: Event): Promise<void> {
  const el = ev.target as HTMLSelectElement
  const idx = Number(el.value)
  const cur = playCtx.value?.sourceIndex ?? 0
  if (!Number.isFinite(idx) || idx === cur || switchingSource.value) {
    el.value = String(cur)
    return
  }
  sideError.value = ''
  flushProgress()
  switchingSource.value = true
  try {
    await catalog.switchPlaySource(idx)
  } catch (e) {
    sideError.value = (e as Error).message
    el.value = String(playCtx.value?.sourceIndex ?? cur)
  } finally {
    switchingSource.value = false
  }
}

// 换集后：进度归零重算 + 当前集回到可视区
watch(queueIndex, async () => {
  playPos.value = 0
  playDur.value = 0
  if (sideCollapsed.value) return
  await nextTick()
  // 折叠态由 visibleEps 的预览窗口自动包含当前集，不必滚动；
  // 展开态才需要定位，且现在整页只有一个滚动容器，用 nearest 只滚最小距离
  if (!epExpanded.value) return
  epListEl.value?.querySelector<HTMLElement>('.ep-btn.active')?.scrollIntoView({ block: 'nearest' })
})
// 换片：简介回到收起态，避免上一部的展开状态带过来
watch(
  () => playCtx.value?.title,
  () => {
    contentExpanded.value = false
    epExpanded.value = false
  }
)

/**
 * P27 起播收口：每次「真的开始播」都会自增 `store.playSeq`，
 * 这里做两件事（顺序固定：先补上下文，再打点）：
 *   1) 任务起播（媒体库/任务页/网盘/解析）没有同名上下文时补一个「散片」上下文；
 *   2) 落一条历史记录（内核按「片」去重）。
 *
 * 为什么不再监听 `sourceTaskId`：内核按 URL 复用任务（`find_task_id_by_url`），
 * 同一集重播拿回的是同一个 id，watch 不触发 —— 表现为「重播不记录 / 历史不置顶」。
 */
watch(
  () => store.playSeq,
  () => {
    // 新一轮起播：自动重试额度重置（每轮只救一次）
    autoRetried = false
    const lp = store.lastPlay
    if (!lp) return
    const t = store.tasks.find((x) => x.id === lp.taskId)
    const cur = catalog.currentEpisode
    // 起播方没给上下文（媒体库/任务页/网盘）→ 兜一个只有标题的散片上下文
    if (!(cur && cur.url === lp.url) && catalog.playCtx?.title !== (t?.title || lp.title)) {
      catalog.setLooseContext(t?.title || lp.title || '', '本地任务')
    }
    const ctx = catalog.playCtx
    void history.record({
      title: ctx?.title || t?.title || lp.title || '未命名',
      episodeName: ctx?.subtitle ?? '',
      // 存原始 URL 而非代理地址：代理 token 每次启动轮换，存了也没法复用
      episodeUrl: lp.url,
      siteName: ctx?.siteName ?? '',
      api: ctx?.api,
      vodId: ctx?.vodId,
      poster: ctx?.poster,
      groups: ctx?.groups?.length ? ctx.groups : undefined,
      groupIndex: ctx?.groupIndex ?? 0
    })
  },
  { flush: 'post' }
)

onMounted(() => {
  const saved = localStorage.getItem(SIDE_PREF_KEY)
  sideCollapsed.value = saved === '1' ? false : saved === '0' ? true : window.innerWidth < 1180
})
onMounted(() => {
  // 卡片「视频以外」的高度实测（见 measuredChrome）：内容增减、窗口缩放都重算
  chromeRo = new ResizeObserver(syncCardChrome)
  if (cardEl.value) chromeRo.observe(cardEl.value)
  if (videoWrapEl.value) chromeRo.observe(videoWrapEl.value)
  void nextTick(syncCardChrome)
})

/** 调试抽屉是浮层，键盘用户要能退出 */
function onDebugEsc(e: KeyboardEvent) {
  if (e.key === 'Escape' && debugOpen.value) debugOpen.value = false
}
onMounted(() => window.addEventListener('keydown', onDebugEsc))

onMounted(() => {
  // 内核上线后探测 libmpv DLL（P3 徽章状态）+ P4 token 刷新（崩溃重启后自动重播）
  watch(
    () => store.online,
    (on) => {
      if (on) void store.probeMpv()
      if (on && videoEl.value) void store.replayAfterReconnect(videoEl.value)
      // 内核重启/上线期间丢掉的起播打点在这里补写
      if (on) void history.flushPending()
    },
    { immediate: true }
  )
  // P5：媒体库/任务页「播放」跨页起播（PlayerView 用 v-show 保活，video 元素常驻）
  watch(
    () => store.pendingPlay,
    (v) => {
      if (v && videoEl.value) {
        store.pendingPlay = false
        void store.play(videoEl.value)
      }
    }
  )
})

// ---- P9 连播 / 观看进度（吸收 GYING） ----

/** 播完自动连播：队列有下一集则起播（含 mpv eof 分支，见下方 watch） */
function onEnded(): void {
  // 播完这一集的真实进度要先落库，否则历史里永远停在上一次 5s 节流的位置，
  // 「已看完」判定会差最后几秒（以及片尾被当作没看完）
  flushProgress()
  if (store.engine !== 'mpv' && catalog.nextEpisode) {
    void catalog.playNext().catch(() => {})
  }
}

/** 进度上报节流（5s 一次；mpv 内核走 mpvState watch） */
let lastReport = 0
function onTimeUpdate(ev: Event): void {
  if (store.engine === 'mpv') return
  const v = ev.target as HTMLVideoElement
  // 侧栏进度条每拍都跟（不节流），进度上报才按 5s 节流
  playPos.value = Number.isFinite(v.currentTime) ? v.currentTime : 0
  playDur.value = Number.isFinite(v.duration) ? v.duration : 0
  const now = Date.now()
  if (now - lastReport < 5000) return
  lastReport = now
  reportProgress(v.currentTime, v.duration)
}

/** 续播定位：pendingSeek > 0 时在 canplay 后 seek 一次 */
function onCanplay(): void {
  markStall(false)
  stopWatchDog()
  if (catalog.pendingSeek > 0 && videoEl.value) {
    videoEl.value.currentTime = catalog.pendingSeek
    catalog.pendingSeek = 0
  }
  // P15：src 变化会重置 playbackRate，媒体就绪后补一次
  if (videoEl.value && store.playbackRate !== 1) {
    videoEl.value.playbackRate = store.playbackRate
  }
}

// ---- 无画面状态提示 ----
/**
 * 「在播但没有画面」必须说出来。
 *
 * 触发场景：hls.js 已经拿到清单、分片也在下行（调试面板能看到 MB/s），
 * 但 MSE 还没 append 出可解码的帧 —— 此时 video 是纯黑的，用户只会看到
 * 一块黑矩形，和「程序卡死」无法区分。
 *
 * 延迟 800ms 再出提示，避免 seek/切集时的正常抖动闪一下。
 */
const stallHint = ref('')
let stallTimer: number | null = null
/** 起播看门狗：15s 还没出画面就不再只是「正在缓冲」，给可操作的出口 */
const STALL_TIMEOUT_MS = 15_000
/** 9s 未出画面先自动重试一次（转圈多数是链路抖一下，重载即可） */
const STALL_RETRY_MS = 9_000
let watchDogTimer: number | null = null
let retryTimer: number | null = null
/** 每次起播只自动救一次，避免失败源上无限重载 */
let autoRetried = false
const stallStuck = ref(false)
/** 判定一次「在播但没画面」：只对 hls 内核，且 readyState 拿不到可解码帧 */
function checkNoPicture(): void {
  if (store.engine !== 'hls' || !store.playing) return
  const v = videoEl.value
  if (!v || v.readyState >= 2) return
  stallHint.value = v.videoWidth > 0 ? '画面未就绪，正在缓冲分片…' : '播放清单已拿到，等待首个可解码分片…'
}
function markStall(on: boolean): void {
  if (!on) {
    if (stallTimer !== null) {
      window.clearTimeout(stallTimer)
      stallTimer = null
    }
    stallHint.value = ''
    return
  }
  if (stallTimer !== null || stallHint.value) return
  stallTimer = window.setTimeout(() => {
    stallTimer = null
    checkNoPicture()
  }, 800)
}

function stopWatchDog(): void {
  if (watchDogTimer !== null) {
    window.clearTimeout(watchDogTimer)
    watchDogTimer = null
  }
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer)
    retryTimer = null
  }
  stallStuck.value = false
}

/**
 * 起播看门狗，两段式：
 *  - 9s 还没有帧 → **先自动救一次**（重解析 playUrl / 重新 startLoad + 拉分片）。
 *    黑屏转圈最常见的成因是 CDN 抖一下、代理 token 过期、首个分片被拦，
 *    这类情况重载一次就回来了，不该先让用户看错误。
 *  - 15s 仍然没有帧 → 说明这条线真的不行，把原因和「重新加载」摆到画面里。
 */
function startWatchDog(): void {
  stopWatchDog()
  if (store.engine !== 'hls') return
  if (!autoRetried) {
    retryTimer = window.setTimeout(() => {
      retryTimer = null
      const v = videoEl.value
      if (!store.playing || !v || v.readyState >= 2) return
      autoRetried = true
      store.pushLog('warn', '9 秒仍未出画面，自动重试一次')
      void store.play(v)
    }, STALL_RETRY_MS)
  }
  watchDogTimer = window.setTimeout(() => {
    watchDogTimer = null
    const v = videoEl.value
    if (!store.playing || !v || v.readyState >= 2) return
    stallStuck.value = true
    stallHint.value =
      v.videoWidth > 0
        ? '画面迟迟没有出现（已等 15 秒），分片可能被源站拦截'
        : '15 秒内没有拿到可播放的分片，这条线路可能已失效'
  }, STALL_TIMEOUT_MS)
}

/** 起播超时后的出口：重新加载（不清进度，队列/线路都还在） */
function retryPlay(): void {
  markStall(false)
  stopWatchDog()
  autoRetried = false
  const v = videoEl.value
  if (!v) return
  void store.play(v)
  startWatchDog()
}

/** P37：把现场压成一段可粘贴文本（同时落盘），省掉「黑屏 → 只能口述现象」的来回 */
const copiedDiag = ref(false)
function copyDiag(): void {
  const v = videoEl.value
  const snap = {
    time: new Date().toISOString(),
    engine: store.engine,
    url: store.url,
    taskId: store.sourceTaskId,
    playing: store.playing,
    playerError: store.playerError,
    video: v
      ? {
          readyState: v.readyState,
          networkState: v.networkState,
          size: `${v.videoWidth}x${v.videoHeight}`,
          currentTime: +v.currentTime.toFixed(2),
          duration: Number.isFinite(v.duration) ? +v.duration.toFixed(1) : null,
          paused: v.paused,
          error: v.error ? `${v.error.code} ${v.error.message}` : null,
          buffered: v.buffered.length
            ? `${v.buffered.length} 段 / 末端 ${v.buffered.end(v.buffered.length - 1).toFixed(1)}s`
            : 'empty',
          src: (v.currentSrc || v.src || '').slice(0, 180)
        }
      : null,
    logs: store.logs.slice(0, 20).map((l) => `${new Date(l.ts).toISOString()} ${l.level}: ${l.message}`)
  }
  const text = JSON.stringify(snap, null, 2)
  window.polyframe?.diag?.('ui-snapshot', text)
  const done = (): void => {
    copiedDiag.value = true
    window.setTimeout(() => (copiedDiag.value = false), 1600)
  }
  const fallback = (): void => {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
      done()
    } catch {
      // 剪贴板不可用：日志已经落盘，不影响排障
    }
    ta.remove()
  }
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, fallback)
  else fallback()
}

watch(
  () => store.playing,
  (playing) => {
    if (!playing) {
      markStall(false)
      stopWatchDog()
      return
    }
    // 有些情况下 video 从一开始就没有帧，`waiting` 不会触发 —— 起播后再补一次判定
    // （0.7s + markStall 内 0.8s ≈ 1.5s，正常起播早就 readyState>=2 了）
    window.setTimeout(() => {
      if (!stallHint.value) markStall(true)
    }, 700)
    startWatchDog()
  }
)


// ---- P15 倍速 ----
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3]
function onRateChange(ev: Event): void {
  const v = Number((ev.target as HTMLSelectElement).value)
  if (Number.isFinite(v) && v > 0) void store.setPlaybackRate(v).catch(() => {})
}
// hls 内核：倍速变化 / 内核切换时应用到 video 元素（mpv 侧由 store 写 speed 属性）
watch(
  [() => store.playbackRate, () => store.engine] as const,
  ([rate, engine]) => {
    if (engine !== 'mpv' && videoEl.value) {
      try {
        videoEl.value.playbackRate = rate
      } catch {
        /* 个别流媒体容器可能拒绝极端倍速，忽略 */
      }
    }
  },
  { immediate: true }
)

// mpv 内核：eof 触发连播 + timePos 节流上报进度
watch(
  () => store.mpvState,
  (s, prev) => {
    if (!s || store.engine !== 'mpv') return
    if (s.eof && !prev?.eof && catalog.nextEpisode) {
      void catalog.playNext().catch(() => {})
    }
    // 侧栏进度条跟随 mpv 状态泵（mpv 没有 timeupdate 事件）
    if (s.timePos != null) playPos.value = s.timePos
    if (s.duration) playDur.value = s.duration
    const now = Date.now()
    if (now - lastReport >= 5000 && s.timePos != null && !s.pause) {
      lastReport = now
      reportProgress(s.timePos, s.duration ?? 0)
    }
  }
)

// ---- P11 弹幕 ----

/** video 原生时长（hls 内核）；mpv 走 mpvState.duration */
const videoDuration = ref(0)
function onDurationChange(ev: Event): void {
  const d = (ev.target as HTMLVideoElement).duration
  videoDuration.value = Number.isFinite(d) && d > 0 ? d : 0
}

/** 当前媒体时长（弹幕时间轴缩放的基准） */
const mediaDuration = computed(() => {
  if (store.engine === 'mpv') {
    const d = store.mpvState?.duration
    return d && d > 0 ? d : 0
  }
  return videoDuration.value
})

/** 当前播放位置（发送弹幕时用） */
function currentTime(): number {
  if (store.engine === 'mpv') return store.mpvState?.timePos ?? 0
  const t = videoEl.value?.currentTime ?? 0
  return Number.isFinite(t) ? t : 0
}

/**
 * 标题像不像"片子名"：手输直链时任务标题常是 `index.m3u8` / 一串 hash，
 * 拿这种东西去弹幕库搜索只会命中垃圾条目，不如不搜。
 */
function looksLikeTitle(t: string): boolean {
  const s = t.trim()
  if (s.length < 2) return false
  if (/\.(m3u8|mpd|mp4|mkv|ts|flv|mp3)$/i.test(s)) return false
  if (/^[0-9a-f]{16,}$/i.test(s)) return false
  return true
}

/**
 * 弹幕「片名 + 集名」来源：
 *  - 优先连播队列（catalog 起播时一定有，且集名最准）
 *  - 其次任务标题（网盘起播的文件名往往含剧名与集数）
 * 都没有则不加载弹幕。
 */
const dmContext = computed<{ title: string; episode: string } | null>(() => {
  if (catalog.queueTitle) {
    const ep = catalog.queue[catalog.queueIndex]
    return { title: catalog.queueTitle, episode: ep?.name ?? '' }
  }
  const t = store.tasks.find((x) => x.id === store.sourceTaskId)
  if (t?.title && looksLikeTitle(t.title)) return { title: t.title, episode: '' }
  return null
})

const dmInput = ref('')
const dmMode = ref<'scroll' | 'top' | 'bottom'>('scroll')
const dmColor = ref('#FFFFFF')
/** P17 弹幕样式：普通 / 发光 / 渐变 */
const dmFx = ref<'glow' | 'gradient' | null>(null)
const dmSending = ref(false)

/**
 * 片名/集名或内核就绪状态变化时重新绑定频道并拉取。
 *
 * 必须同时 watch `store.online`：内核比界面晚就绪时，
 * 只 watch 片名会永远拿不到 channelId（下拉空白的老问题同源）。
 */
watch(
  [dmContext, () => store.online, () => dm.settings.provider] as const,
  async ([ctx, online]) => {
    if (!ctx || !online) return
    await dm.openChannel(ctx.title, ctx.episode || undefined)
    if (dm.channelId) {
      await dm.fetch(mediaDuration.value || undefined)
      void syncMpvAss()
    }
  },
  { immediate: true }
)

/** 切换弹幕总开关 */
function toggleDanmaku(): void {
  void dm.saveSettings({ enabled: !dm.settings.enabled })
}

/**
 * P31：弹幕状态提示（原先以角标形式叠在视频画面左上角）。
 *
 * 视频区只负责画弹幕本身 —— 加载中 / 暂无弹幕 / 未配凭据 / 未匹配这类
 * 信息一律放到控制条下方的状态行：角标常驻会一直压在片头字幕上，
 * 看着像渲染 bug 而不像提示，也挡画面。
 *
 * 优先级：错误 > 加载中 > 空态。空态按「有没有配凭据」给不同的动作。
 */
type DmStatusKind = 'info' | 'warn' | 'err' | 'busy'
interface DmStatus {
  kind: DmStatusKind
  text: string
  action?: string
  act?: 'settings' | 'picker'
}

const dmStatus = computed<DmStatus | null>(() => {
  if (!dm.settings.enabled) return null
  if (dm.errorKind === 'no_credentials') {
    return { kind: 'warn', text: '未配置弹弹play 凭据，仅显示本地弹幕', action: '去配置', act: 'settings' }
  }
  if (dm.errorKind === 'no_match') {
    return { kind: 'warn', text: dm.error || '未匹配到弹幕库条目', action: '手动指定', act: 'picker' }
  }
  if (dm.errorKind) return { kind: 'err', text: dm.error || '弹幕加载失败' }
  if (dm.loading) return { kind: 'busy', text: '加载弹幕…' }
  if (dm.itemCount === 0) {
    return dm.hasCredentials
      ? { kind: 'info', text: '暂无弹幕' }
      : { kind: 'info', text: '暂无弹幕（未配置弹弹play 凭据）', action: '去配置', act: 'settings' }
  }
  return null
})

function onDmStatusAct(): void {
  const act = dmStatus.value?.act
  if (act === 'picker') {
    dmLayer.value?.openPicker()
    return
  }
  if (act !== 'settings') return
  store.go('settings')
  scrollToDanmakuSettings()
}

/**
 * 跳到设置页后滚到弹幕区块。
 *
 * 设置页很长（内核状态 / 播放与缓存 / 片源缓存 / 内容源 / 弹幕 …），
 * 只切路由的话用户落在页首，还得自己往下找 —— 「去配置」等于只走了一半。
 *
 * 两点注意：
 *  - 设置页是 v-if 切换的，首帧 DOM 可能还没挂载，查不到就隔一会儿重试；
 *  - 用 `scrollIntoView` 不可靠（这里真正滚动的是 `.content`，而 smooth 滚动
 *    会被切换瞬间的内容重排打断，实测 scrollTop 一直是 0），所以直接算偏移量；
 *  - 用瞬时定位而不是 smooth：smooth 依赖 rAF，窗口不可见时一帧都不推进
 *    （Electron 隐藏窗口里实测滚不动），「直达」也更符合「点了去配置」的预期。
 */
function scrollToDanmakuSettings(tries = 5): void {
  window.setTimeout(() => {
    const sec = document.querySelector<HTMLElement>('.dm-settings')
    const content = document.querySelector<HTMLElement>('.content')
    if (!sec || !content) {
      if (tries > 0) scrollToDanmakuSettings(tries - 1)
      return
    }
    const delta = sec.getBoundingClientRect().top - content.getBoundingClientRect().top
    content.scrollTop = Math.max(0, content.scrollTop + delta - 8)
  }, 120)
}

/** 发送弹幕：成功后即时上屏（不重建时间轴） */
async function onSendDanmaku(): Promise<void> {
  const text = dmInput.value.trim()
  if (!text || dmSending.value) return
  dmSending.value = true
  dm.sendFeedback = ''
  try {
    const item = await dm.send(text, currentTime(), dmMode.value, dmColor.value, dmFx.value)
    if (item) {
      dmLayer.value?.push(item)
      dmInput.value = ''
      store.pushLog('info', '弹幕已发送')
    } else {
      store.pushLog('warn', `弹幕未发送：${dm.sendFeedback}`)
    }
  } finally {
    dmSending.value = false
  }
}

// ---- P15：本地弹幕文件导入（B 站 XML / 弹弹play JSON） ----
const dmImportEl = ref<HTMLInputElement | null>(null)
const dmImporting = ref(false)

function onImportDanmaku(): void {
  dmImportEl.value?.click()
}

async function onImportFile(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // 允许重复选同一个文件
  if (!file) return
  if (file.size > 8 * 1024 * 1024) {
    dm.sendFeedback = '弹幕文件过大（上限 8MB）'
    return
  }
  dmImporting.value = true
  dm.sendFeedback = ''
  try {
    const content = await file.text()
    const r = await dm.importLocal(content)
    dm.sendFeedback = r.message
    store.pushLog(r.ok ? 'info' : 'warn', `弹幕导入：${r.message}`)
  } catch (e) {
    dm.sendFeedback = `读取文件失败：${(e as Error).message}`
  } finally {
    dmImporting.value = false
  }
}

/**
 * libmpv 内核：把弹幕导出成 ASS 交给 mpv 自己渲染。
 *
 * 为什么不能在 DOM 层画：mpv 的视频是 Win32 子窗口（WS_CHILD + 父窗口 HWND），
 * 恒定绘制在父窗口客户区之上，renderer 的 Canvas 会被完全遮住。
 * 优先 `secondary-sub-add`（不抢视频自带字幕），旧版 libmpv 回落 `sub-add`。
 *
 * P17：开启「高级特效覆盖层」时跳过 —— 弹幕改由透明覆盖层窗口渲染，
 * ASS 与覆盖层同时跑会出现两份弹幕。
 */
const fxOverlayActive = computed(
  () => store.engine === 'mpv' && dm.settings.enabled && dm.settings.fxOverlay
)
let lastAssKey = ''
async function syncMpvAss(): Promise<void> {
  if (fxOverlayActive.value) return
  if (store.engine !== 'mpv' || !store.online) return
  if (!dm.channelId || dm.itemCount === 0 || !dm.settings.enabled) return
  // 时长/状态事件会多次触发本函数，同参数不重复生成 ASS（每次都是同步写文件）
  const key = [
    dm.channelId,
    dm.itemCount,
    Math.round(dm.settings.fontScale * 100),
    Math.round(dm.settings.opacity * 100),
    Math.round((mediaDuration.value || 0) / 5)
  ].join('|')
  if (key === lastAssKey) return
  lastAssKey = key
  try {
    const r = (await store.rpc(RpcMethod.DanmakuAss, {
      channelId: dm.channelId,
      fontScale: dm.settings.fontScale,
      opacity: dm.settings.opacity
    })) as { path: string | null; count: number; reason?: string }
    if (!r.path) return
    try {
      await store.rpc(RpcMethod.MpvCommand, { args: ['secondary-sub-add', r.path, 'select'] })
    } catch {
      await store.rpc(RpcMethod.MpvCommand, { args: ['sub-add', r.path, 'select'] })
    }
    store.pushLog('info', `弹幕已作为字幕载入 libmpv（${r.count} 条）`)
  } catch (e) {
    lastAssKey = '' // 失败允许下次重试
    store.pushLog('warn', `libmpv 弹幕加载失败：${(e as Error).message}`)
  }
}

// hls 内核 seek：立刻通知引擎重建在屏状态（不做这步会看到旧弹幕继续飞出屏幕）
function onSeeking(ev: Event): void {
  const t = (ev.target as HTMLVideoElement).currentTime
  if (Number.isFinite(t)) dmLayer.value?.seek(t)
}

// 弹幕数据 / 内核切换后，mpv 侧 ASS 需要重新生成
watch(
  [() => dm.itemsVersion, () => store.engine] as const,
  () => {
    void syncMpvAss()
  }
)

// 时长就绪：mpv 侧 ASS 与 DOM 侧缩放都要重算
watch(mediaDuration, (d) => {
  if (d > 0) void syncMpvAss()
})

// ---- P3 libmpv：子窗口矩形跟随视频区（ResizeObserver + 窗口滚动/缩放） ----
let mpvRectTimer: number | null = null
/** 节流起点：滚动等连续事件要「立即跟 + 限频」，纯尾随防抖会让画面在滚动全程错位 */
let mpvRectLast = 0
function syncMpvRect(): void {
  if (store.engine !== 'mpv') return
  // 不在播放页时窗口已被显式藏起，绝不能再把矩形写进去
  if (store.route !== 'player') return
  const el = videoWrapEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  // 未布局（display:none / 首帧 ref 刚挂）时 rect 全 0，
  // 写进 mpv.move 会把子窗口压成 1×1 —— 画面就再也回不来了
  if (r.width < 2 || r.height < 2) return
  void store.mpvMoveRect({ left: r.left, top: r.top, width: r.width, height: r.height })
  // P17：同一矩形喂给弹幕覆盖层（视口坐标，覆盖层窗口与主窗口内容区同原点）
  if (fxOverlayActive.value && overlayAvailable()) {
    overlayRect({ left: r.left, top: r.top, width: r.width, height: r.height })
  }
}
function scheduleMpvRect(): void {
  if (mpvRectTimer !== null) return // 已有待执行调用（兼作尾随兜底）
  const elapsed = performance.now() - mpvRectLast
  const run = (): void => {
    mpvRectTimer = null
    mpvRectLast = performance.now()
    syncMpvRect()
  }
  // 距上次执行 ≥60ms 立即同步（滚动跟手）；否则排到 60ms 节流窗口的尾部
  if (elapsed >= 60) run()
  else mpvRectTimer = window.setTimeout(run, 60 - elapsed)
}
let mpvRo: ResizeObserver | null = null
watch(
  () => [store.engine, store.mpvReady] as const,
  ([engine, ready]) => {
    if (engine === 'mpv' && ready) {
      mpvRo?.disconnect()
      mpvRo = new ResizeObserver(scheduleMpvRect)
      if (videoWrapEl.value) mpvRo.observe(videoWrapEl.value)
      window.addEventListener('resize', scheduleMpvRect)
      // 滚动也要跟：滚动不改变元素尺寸（ResizeObserver 不触发），只改
      // getBoundingClientRect 的位置，不重对齐 mpv 子窗口就会错位露黑。
      // capture=true 拦截页面滚动与一切内层滚动容器（scroll 事件不冒泡但走捕获）。
      window.addEventListener('scroll', scheduleMpvRect, true)
      syncMpvRect()
    } else {
      mpvRo?.disconnect()
      mpvRo = null
      window.removeEventListener('resize', scheduleMpvRect)
      window.removeEventListener('scroll', scheduleMpvRect, true)
    }
  },
  { immediate: true }
)
// ---- P46 预缓存窗口：侧栏显示「后面几集正在缓存 / 已缓存」 ----
const prefetchText = computed(() => {
  const p = catalog.prefetch
  if (!p || !p.items.length) return ''
  const ready = p.items.filter((i) => i.state === 'ready').length
  const failed = p.items.filter((i) => i.state === 'failed').length
  const caching = p.items.find((i) => i.state === 'caching')
  const first = p.items[0].index + 1
  const last = p.items[p.items.length - 1].index + 1
  const span = first === last ? `${first}` : `${first}–${last}`
  const tail = p.truncated ? ' · 剩余不足，已按实际集数' : ''
  if (caching) {
    return `预缓存第 ${span} 集：正在缓存第 ${caching.index + 1} 集（${ready}/${p.items.length}）${tail}`
  }
  if (failed && ready + failed === p.items.length) {
    return `预缓存第 ${span} 集：${ready} 集完成、${failed} 集失败${tail}`
  }
  return `预缓存第 ${span} 集：已缓存 ${ready}/${p.items.length}${tail}`
})

/** 窗口是内核 5s 一拍推进的，侧栏跟着刷即可（只读，不触发调度） */
const prefetchTimer = window.setInterval(() => {
  const tid = store.playingTaskId
  if (tid && catalog.queue.length > 1) void catalog.refreshPrefetchStatus(tid)
}, 5000)

onBeforeUnmount(() => {
  window.clearInterval(prefetchTimer)
  chromeRo?.disconnect()
  chromeRo = null
  window.removeEventListener('keydown', onDebugEsc)
  mpvRo?.disconnect()
  if (mpvRectTimer !== null) window.clearTimeout(mpvRectTimer)
  window.removeEventListener('scroll', scheduleMpvRect, true)
  window.clearInterval(surfaceWatchdog)
  if (stallTimer !== null) window.clearTimeout(stallTimer)
  if (watchDogTimer !== null) window.clearTimeout(watchDogTimer)
})

// ---- 切页显隐：离开播放页藏画面，播放继续 ----
/**
 * 播放页是 `v-show` 保活的（切页不卸载、不断播），但 mpv 的视频表面是
 * Win32 子窗口（WS_CHILD），只服 Win32 显隐、完全不吃 DOM 的 `display:none`——
 * 不显式处理就会一直盖在媒体库/设置等页面上面。
 *
 * 所以离开播放页时显式 `SW_HIDE`，回来时 `SW_SHOW` + 重新对齐矩形。
 * **全程不动播放状态**：不暂停、不停止，音频与进度照旧继续。
 */
function applySurface(): void {
  const onPlayer = store.route === 'player'
  // 意图：是否在播放页（决定起播时窗口该不该出来）
  store.setSurfaceWanted(onPlayer)
  if (store.engine === 'mpv') {
    // 到播放页也得「真有内容」才恢复画面：按过停止后回来不该显示一块空黑窗口。
    // 注意不能只看 `mpvState` 是否存在 —— stop 之后状态泵仍会推 idle 快照回来。
    const s = store.mpvState
    const hasSurface = store.playing || (!!s && (s.playing || s.eof))
    void store.mpvPushSurface(onPlayer && hasSurface)
  } else {
    // 非 mpv 内核：**显式**关一次。不能只是「什么都不做」—— 残留的子窗口是
    // Win32 句柄，会一直盖在视频区上（挡住画面、原生控制条与弹幕角标），
    // 而且此后没有任何 CSS/布局能把它弄走，用户看到的是一块永不消失的黑矩形。
    void store.mpvPushSurface(false)
  }
  if (!onPlayer) return
  // 刚切回来时 v-show 刚从 display:none 恢复，布局接连几拍才稳定
  void nextTick(() => {
    syncMpvRect()
    window.setTimeout(syncMpvRect, 80)
    window.setTimeout(syncMpvRect, 320)
  })
}
// 只盯 route / engine：mpvReady 的首次翻转发生在 playMpv 内部（attach 后紧接 loadfile），
// 若也在 watcher 里推一次显隐，会和 playMpv 的校准打架（可能把刚起播的窗口又藏了）
watch(() => [store.route, store.engine] as const, () => applySurface())

/**
 * 子窗口显隐兜底巡检。
 *
 * 视频表面是 Win32 子窗口，显隐只有 RPC 一条路：一旦某条时序把它 show 出来、
 * 之后又没人负责藏（engine 已经不是 mpv，`syncMpvRect` 早退、watcher 也不再触发），
 * 它就会以某次布局的旧矩形永久盖在视频区上 —— 画面、原生控制条、弹幕角标全被吃掉，
 * 而下面 hls 还在正常下数据，表现为「有速度、有声音、就是全黑」，且无法自愈。
 *
 * 已知时序都已在源头堵住（mpv.stop 清意图 / 切内核先显式藏 / playMpv 校验内核），
 * 这里再放一道低频巡检：只要不是 mpv 内核，就确保窗口是藏着的。
 * 只在真的用过 libmpv（mpvReady）之后才跑，没装 libmpv 的机器不会多一次 RPC。
 */
const surfaceWatchdog = window.setInterval(() => {
  if (store.engine !== 'mpv' && store.mpvReady) void store.mpvPushSurface(false)
}, 3000)

// ---- P3 libmpv：控制栏状态 ----
const mpvHasMedia = computed(() => !!store.mpvState && (store.mpvState.playing || store.mpvState.eof))

/**
 * P25 播放卡纵向预算（写在 .player-view 上，供 .video-wrap 反推宽度）。
 *
 * 默认 176px 是 hls 内核下「视频区之外的卡片高度」实测值；
 * mpv 内核多出一条进度/字幕轨行（约 46px），不把它算进去，
 * 卡片就会比视口高、被 sticky 裁掉一截。
 *
 * P31：弹幕状态行（.dm-status）出现时不再额外预留，已实测常态（高级面板折叠）
 * 下 1280×720 / 1366×768 / 1440×900 三档都还有 60px 以上余量，加一行 40px 不会顶出视口；
 * 反过来若把它算进 chrome，所有窗口的视频都会白缩 40px。
 */
const cardChrome = computed(() =>
  store.engine === 'mpv' && mpvHasMedia.value ? '222px' : '176px'
)
/**
 * 实测「视频区以外」的卡片高度，覆盖上面的估算值。
 *
 * cardChrome 是按内核写的常数，却永远追不上真实内容：浏览器模式提示条、弹幕未配置提示、
 * 「手动播放」折叠行展开，都能把实际值顶到 300+。而估算偏小的后果是视频区按错误预算放大、
 * 卡片比视口还高 —— 底部内容（以及 P30 起的调试抽屉）就被压住了。
 * 这里直接量 card - video 的差值回写，估算只当首帧兜底。差值本身与视频尺寸无关，
 * 所以不会和「宽度反推」形成循环。
 */
const cardEl = ref<HTMLElement | null>(null)
const measuredChrome = ref('')
let chromeRo: ResizeObserver | null = null
function syncCardChrome() {
  const c = cardEl.value?.getBoundingClientRect().height ?? 0
  const v = videoWrapEl.value?.getBoundingClientRect().height ?? 0
  if (c < 2 || v < 2) return
  const diff = Math.round(c - v)
  // 视频区被压成 0（窄屏/极矮窗口的过渡帧）时，差值会把整张卡片当成 chrome，
  // 写回去等于把预算锁死成不可能满足的值 —— 超过 70% 视口高度的一律当脏数据丢弃。
  if (diff < 0 || diff > window.innerHeight * 0.7) return
  const next = `${diff}px`
  if (next !== measuredChrome.value) measuredChrome.value = next
}
const mpvTimeLabel = computed(() => {
  const s = store.mpvState
  if (!s) return ''
  return `${fmtDur(s.timePos ?? 0)} / ${s.duration ? fmtDur(s.duration) : '--:--'}`
})
function fmtDur(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const mmss = `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
  return h > 0 ? `${h}:${mmss}` : mmss
}
function onEngineSwitch(engine: 'hls' | 'mpv'): void {
  void store.switchEngine(engine, videoEl.value ?? undefined).catch((e) => {
    store.pushLog('error', `切换内核失败：${(e as Error).message}`)
  })
}
function onMpvSeek(ev: Event): void {
  const v = Number((ev.target as HTMLInputElement).value)
  // 先通知弹幕引擎，避免 250ms 的 mpv 状态空窗期内旧弹幕继续跑
  dmLayer.value?.seek(v)
  void store.mpvSeekTo(v).catch(() => {})
}
function onTrackSelect(kind: 'audio' | 'sub', ev: Event): void {
  const id = Number((ev.target as HTMLSelectElement).value)
  void store.mpvSelectTrack(kind, id).catch(() => {})
}

/** P5：播放 = 创建任务（经本地代理边下边播）+ 自动起播；浏览器调试模式直连 */
async function onPlay(): Promise<void> {
  // 手动直链播放：与片源选集无关，清掉队列与侧栏上下文（否则侧栏还在显示上一部片）
  catalog.clearQueue()
  if (store.mode !== 'electron') {
    if (videoEl.value) void store.play(videoEl.value)
    return
  }
  creating.value = true
  try {
    await store.createTask(undefined, videoEl.value ?? undefined)
  } catch (e) {
    store.pushLog('error', (e as Error).message)
  } finally {
    creating.value = false
  }
}
function onStop(): void {
  if (videoEl.value) store.stop(videoEl.value)
}
function fmtTime(ts: number | string): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}

// ---- P2.5 缓存三档模式（新建任务默认档；P29 默认预缓存） ----
const cacheModeOptions: { value: CacheMode; label: string }[] = [
  { value: 'online', label: '在线（不落盘）' },
  { value: 'stream', label: '边下边播' },
  { value: 'precache', label: '预缓存（默认）' }
]

// ---- P2 调试面板辅助 ----
const sourceStateLabel: Record<string, string> = {
  active: '正常',
  half_open: '试探',
  circuit_open: '熔断'
}
function fmtBytes(b: number): string {
  if (b >= 1048576) return `${(b / 1048576).toFixed(1)} MB/s`
  if (b >= 1024) return `${Math.round(b / 1024)} KB/s`
  return `${Math.round(b)} B/s`
}
function pct(x: number): string {
  return `${Math.round(x * 100)}%`
}
</script>

<template>
  <div
    class="player-view"
    :class="{ 'side-collapsed': sideCollapsed, 'debug-open': debugOpen }"
    :style="{ '--pf-card-chrome': measuredChrome || cardChrome }"
  >
    <!-- 左列（stage）：只有播放卡。stage 被拉伸到与右列等高，
         播放卡才能在其中 sticky 跟随整段侧栏内容（窄屏 display:contents 拆平） -->
    <div class="stage">
      <!-- 播放区 -->
      <section ref="cardEl" class="card player">
        <div ref="videoWrapEl" class="video-wrap force-dark">
          <video
            ref="videoEl"
            controls
            playsinline
            @ended="onEnded"
            @timeupdate="onTimeUpdate"
            @canplay="onCanplay"
            @durationchange="onDurationChange"
            @seeking="onSeeking"
            @waiting="markStall(true)"
            @stalled="markStall(true)"
            @playing="markStall(false)"
          ></video>
          <!-- P11 弹幕层：pointer-events:none，不挡控制条 -->
          <DanmakuLayer ref="dmLayer" :video="videoEl" :duration="mediaDuration" />
          <div v-if="!store.playing && !store.playerError" class="placeholder">
            <p>输入 HLS / MP4 直链后点击「播放」</p>
            <p class="dim small">双内核：hls.js 页内播放 / libmpv 子窗口渲染 · 经本地代理分片缓存</p>
          </div>
          <!--
            有播放意图但画面还没出来时给一句人话。
            全黑却不解释等于把问题丢给用户；这段字同时也是一条诊断：
            如果黑区连这段字都盖住，说明盖在上面的不是 DOM（而是 mpv 子窗口）。
          -->
          <div v-if="stallHint" class="stall-hint" :class="{ stuck: stallStuck }">
            <span v-if="!stallStuck" class="stall-dot"></span>
            <span>{{ stallHint }}</span>
            <button v-if="stallStuck" class="stall-retry" @click="retryPlay">重新加载</button>
          </div>
          <!--
            P37：失败原因必须出现在画面里。之前错误只在卡片下方的一行 .alert，
            卡片高度被预算卡死时容易被挤出视野 —— 用户看到的就是「一片黑、什么都没说」。
            这里同时给出可操作出口：重试 + 复制诊断（诊断会落盘到日志文件）。
          -->
          <div v-if="store.playerError" class="video-error">
            <p class="ve-title">无法播放</p>
            <p class="ve-msg">{{ store.playerError }}</p>
            <div class="ve-acts">
              <button class="stall-retry" @click="retryPlay">重新加载</button>
              <button class="ve-copy" @click="copyDiag">{{ copiedDiag ? '已复制' : '复制诊断信息' }}</button>
            </div>
          </div>
        </div>
        <!-- P3 引擎切换 + mpv 控制栏 -->
        <div class="url-row engine-row">
          <span class="engine-label dim">内核</span>
          <button
            class="engine-btn"
            :class="{ active: store.engine === 'hls' }"
            title="hls.js 页内 MSE 播放（默认，兼容性最好）"
            @click="onEngineSwitch('hls')"
          >
            hls.js
          </button>
          <button
            class="engine-btn"
            :class="{ active: store.engine === 'mpv' }"
            :disabled="store.mpvAvailable === false"
            :title="store.mpvDllPath || 'libmpv 子窗口渲染（需 libmpv-2.dll）'"
            @click="onEngineSwitch('mpv')"
          >
            libmpv
            <span
              class="eng-dot"
              :class="store.mpvAvailable === true ? 'ok' : store.mpvAvailable === false ? 'off' : ''"
            ></span>
          </button>
          <span class="flex-sp"></span>
          <!-- P15 倍速（1.0 显示占位文案，与常见播放器一致） -->
          <select class="mode-select rate-select" :value="store.playbackRate" title="倍速播放" @change="onRateChange">
            <option v-for="r in RATES" :key="r" :value="r">{{ r === 1 ? '倍速' : `${r}x` }}</option>
          </select>
          <!-- P11 弹幕开关（带条数，便于确认"到底拉到没有"） -->
          <button
            class="engine-btn dm-toggle"
            :class="{ active: dm.settings.enabled }"
            :title="dm.settings.enabled ? '关闭弹幕' : '开启弹幕'"
            @click="toggleDanmaku"
          >
            弹幕
            <span class="dm-count">{{ dm.itemCount > 999 ? `${(dm.itemCount / 1000).toFixed(1)}k` : dm.itemCount }}</span>
          </button>
          <!-- P15 弹幕源：常驻入口，不必等自动匹配失败才能改 -->
          <button
            class="engine-btn dm-src"
            title="指定弹幕源（换一部剧的弹幕 / 只用本地弹幕）"
            @click="dmLayer?.openPicker()"
          >
            弹幕源
          </button>
          <!-- P9 连播：队列有下一集时显示快捷入口 -->
          <button
            v-if="catalog.nextEpisode"
            class="engine-btn next-btn"
            :title="`连播下一集：${catalog.nextEpisode.name}`"
            @click="catalog.playNext().catch(() => {})"
          >
            下一集 ›
          </button>
          <template v-if="store.engine === 'mpv'">
            <button class="engine-btn" :disabled="!mpvHasMedia" @click="store.mpvTogglePause()">
              {{ store.mpvState?.pause ? '▶ 继续播放' : '⏸ 暂停播放' }}
            </button>
            <span class="mono time-label">{{ mpvTimeLabel }}</span>
          </template>
        </div>
        <!-- P31 弹幕状态行：配置/空态/加载提示放这里，不叠在画面上 -->
        <div v-if="dmStatus" class="dm-status" :class="dmStatus.kind">
          <span class="dm-status-dot"></span>
          <span class="dm-status-text">{{ dmStatus.text }}</span>
          <button v-if="dmStatus.action" class="dm-status-act" @click="onDmStatusAct">{{ dmStatus.action }}</button>
        </div>
        <!-- P11 弹幕发送栏 -->
        <div v-if="dm.settings.enabled && dm.settings.showSendBar" class="url-row dm-send">
          <input
            v-model="dmInput"
            class="dm-input"
            maxlength="100"
            spellcheck="false"
            placeholder="发条弹幕…（落在当前播放时间点）"
            @keyup.enter="onSendDanmaku"
          />
          <select v-model="dmMode" class="mode-select" title="弹幕类型">
            <option value="scroll">滚动</option>
            <option value="top">顶部</option>
            <option value="bottom">底部</option>
          </select>
          <input v-model="dmColor" class="dm-color" type="color" title="弹幕颜色" />
          <select v-model="dmFx" class="mode-select" title="弹幕样式（特效在设置页开启覆盖层后 mpv 下也生效）">
            <option :value="null">普通</option>
            <option value="glow">发光</option>
            <option value="gradient">渐变</option>
          </select>
          <button :disabled="dmImporting || !dm.channelId" title="导入本地弹幕文件（B 站 XML / 弹弹play JSON）" @click="onImportDanmaku">
            {{ dmImporting ? '导入中…' : '导入' }}
          </button>
          <input ref="dmImportEl" type="file" accept=".xml,.json,application/xml,text/xml,application/json" style="display: none" @change="onImportFile" />
          <button class="primary" :disabled="dmSending || !dmInput.trim()" @click="onSendDanmaku">
            {{ dmSending ? '发送中…' : '发送' }}
          </button>
        </div>
        <p v-if="dm.sendFeedback" class="dm-feedback">{{ dm.sendFeedback }}</p>
        <div v-if="store.engine === 'mpv' && mpvHasMedia" class="url-row seek-row">
          <input
            class="seek-range"
            type="range"
            min="0"
            :max="store.mpvState?.duration ?? 0"
            step="0.5"
            :value="store.mpvState?.timePos ?? 0"
            @change="onMpvSeek"
          />
          <select
            v-if="store.mpvTracks.some((t) => t.kind === 'sub')"
            class="mode-select"
            title="字幕轨道"
            @change="onTrackSelect('sub', $event)"
          >
            <option value="0">字幕：关闭</option>
            <option v-for="t in store.mpvTracks.filter((t) => t.kind === 'sub')" :key="t.id" :value="t.id">
              {{ t.title || t.lang || `字幕#${t.id}` }}{{ t.selected ? ' ✓' : '' }}
            </option>
          </select>
          <select
            v-if="store.mpvTracks.filter((t) => t.kind === 'audio').length > 1"
            class="mode-select"
            title="音频轨道"
            @change="onTrackSelect('audio', $event)"
          >
            <option v-for="t in store.mpvTracks.filter((t) => t.kind === 'audio')" :key="t.id" :value="t.id">
              {{ t.title || t.lang || `音轨#${t.id}` }}{{ t.selected ? ' ✓' : '' }}
            </option>
          </select>
        </div>
        <!-- 手动播放 / 高级：默认折叠，有内容在播时不再占主视觉 -->
        <details class="manual" :open="!store.playing">
          <summary>
            手动播放 / 高级
            <span class="dim small">直链、镜像与缓存模式</span>
          </summary>
          <div class="url-row">
            <input
              v-model="store.url"
              spellcheck="false"
              placeholder="https://.../index.m3u8"
              @keyup.enter="onPlay"
            />
            <button class="primary" :disabled="creating" @click="onPlay">
              {{ creating ? '解析中…' : '播放' }}
            </button>
            <button @click="onStop">停止</button>
          </div>
          <div class="url-row">
            <input
              v-model="store.mirrorInput"
              spellcheck="false"
              placeholder="镜像 URL（可选，多个用逗号分隔；多源聚合逐片换源）"
            />
            <select
              v-model="store.newTaskCacheMode"
              class="mode-select"
              title="新建任务的缓存模式（默认预缓存）"
              @change="store.saveCacheModePref()"
            >
              <option v-for="o in cacheModeOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
          </div>
          <p class="url-hint">
            支持 m3u8 / mpd / mp4 直链；网页链接会自动扫描内嵌流，安装
            <code>yt-dlp.exe</code>（应用目录或 PATH）可解锁更多站点提取。
          </p>
        </details>
        <div v-if="store.playerError" class="alert">{{ store.playerError }}</div>
        <div v-if="store.mode === 'browser'" class="notice">
          浏览器调试模式：仅播放可用；内核 RPC 需通过 <code>pnpm dev</code> 启动桌面端。
        </div>
      </section>
    </div>

    <!-- P20 右侧信息栏：标题/简介/剧集/来源；可收缩成竖条，窄屏自动落到播放器下方 -->
    <aside class="info-side">
      <!-- 收起态：竖条（窄屏为一行摘要） -->
      <template v-if="sideCollapsed">
        <button class="rail-btn" title="展开视频信息" @click="setSide(false)">‹</button>
        <button
          v-if="playCtx?.poster"
          class="rail-poster"
          title="展开视频信息"
          @click="setSide(false)"
        >
          <img :src="catalog.posterUrl(playCtx.poster)" alt="" />
        </button>
        <div class="rail-text">{{ playCtx?.title || '视频信息' }}</div>
        <span v-if="queue.length" class="rail-badge">{{ queueIndex + 1 }}/{{ queue.length }}</span>
      </template>

      <template v-else>
        <div class="side-head">
          <h3>视频信息</h3>
          <button class="side-toggle" title="收起侧栏（播放不中断）" @click="setSide(true)">›</button>
        </div>

        <div v-if="!playCtx" class="side-empty">
          <div class="side-empty-ico" aria-hidden="true">🎬</div>
          <p class="side-empty-title">还没有正在播放的影片</p>
          <p class="side-empty-sub">在「发现」页选一部片并点选集，这里会自动带出简介、剧集列表与来源。</p>
          <button class="btn sm" @click="store.go('discover')">去发现页</button>
        </div>

        <template v-else>
          <div class="side-top">
            <div class="side-poster">
              <img v-if="playCtx.poster" :src="catalog.posterUrl(playCtx.poster)" alt="" />
              <div v-else class="poster-empty">无海报</div>
            </div>
            <div class="side-meta">
              <h2 class="side-title" :title="playCtx.title">{{ playCtx.title }}</h2>
              <div class="chips">
                <span v-if="playCtx.typeName" class="badge">{{ playCtx.typeName }}</span>
                <span v-if="playCtx.year" class="badge">{{ playCtx.year }}</span>
                <span v-if="playCtx.remarks" class="badge warn">{{ playCtx.remarks }}</span>
              </div>
              <p v-if="queue.length" class="side-now" :title="currentEpName">
                第 {{ queueIndex + 1 }}/{{ queue.length }} 集 · {{ currentEpName }}
              </p>
              <p v-if="playCtx.siteName" class="side-src" :title="playCtx.siteName">
                来源：{{ playCtx.siteName }}
              </p>
            </div>
          </div>

          <!-- P22 播放源：片源（跨站）+ 线路集中在一处，统一用下拉切换 -->
          <div class="side-block source-block">
            <div class="block-head">
              <h4>播放源</h4>
              <span v-if="switchingSource || switchingGroup" class="switching">
                <span class="spin" aria-hidden="true"></span>切换中…
              </span>
              <span v-else-if="playCtx.sources?.length" class="src-count">
                {{ playCtx.sources.length }} 个片源
              </span>
            </div>
            <label class="field">
              <span class="field-label">片源</span>
              <select
                class="side-select"
                :value="playCtx.sourceIndex ?? 0"
                :disabled="switchingSource || (playCtx.sources?.length ?? 0) < 2"
                :title="(playCtx.sources?.length ?? 0) < 2 ? '该片只有当前这一个片源' : '换到同片的另一个采集站'"
                @change="onPickSource"
              >
                <option v-if="!playCtx.sources?.length" :value="0">
                  {{ playCtx.siteName || '当前来源' }}
                </option>
                <option
                  v-for="(s, si) in playCtx.sources || []"
                  :key="`${s.api}-${s.vodId}`"
                  :value="si"
                >
                  {{ s.siteName }}{{ si === playCtx.sourceIndex ? '（当前）' : '' }}
                </option>
              </select>
            </label>
            <label class="field">
              <span class="field-label">线路</span>
              <select
                class="side-select"
                :value="playCtx.groupIndex ?? 0"
                :disabled="switchingGroup || playGroups.length < 2"
                :title="playGroups.length < 2 ? '该片源只有一个线路' : '换同一片源内的其它播放线路'"
                @change="onPickGroupSelect"
              >
                <option v-if="!playGroups.length" :value="0">默认线路</option>
                <option v-for="(g, gi) in playGroups" :key="`${g.from}-${gi}`" :value="gi">
                  {{ g.from }} · {{ g.episodes.length }} 集{{ gi === playCtx.groupIndex ? '（当前）' : '' }}
                </option>
              </select>
            </label>
            <p class="field-hint">换片源 / 线路会自动停在同名的集上。</p>
          </div>

          <!-- 播放状态与进度：切集/收起侧栏都不打断播放，这里实时跟随 -->
          <div class="side-progress">
            <div class="progress"><i :style="{ width: `${progressPct}%` }"></i></div>
            <div class="row">
              <span class="state" :class="{ live: playStateLabel === '播放中' }">{{ playStateLabel }}</span>
              <span class="mono">{{ fmtDur(playPos) }} / {{ playDur > 0 ? fmtDur(playDur) : '--:--' }}</span>
            </div>
          </div>

          <div class="side-block">
            <div class="block-head">
              <h4>剧集<span v-if="queue.length" class="count">{{ queue.length }}</span></h4>
              <div v-if="queue.length" class="nav-mini">
                <button class="mini" :disabled="queueIndex <= 0 || picking >= 0" @click="onPickEpisode(queueIndex - 1)">
                  上一集
                </button>
                <button
                  class="mini"
                  :disabled="queueIndex >= queue.length - 1 || picking >= 0"
                  @click="onPickEpisode(queueIndex + 1)"
                >
                  下一集
                </button>
              </div>
            </div>
            <p v-if="prefetchText" class="prefetch-line">{{ prefetchText }}</p>
            <p v-if="sideError" class="side-error">
              {{ sideError }}
              <button class="mini" @click="onPickEpisode(queueIndex, true)">重试</button>
            </p>
            <div v-if="picking >= 0" class="side-loading">
              <span class="spin" aria-hidden="true"></span>正在切换第 {{ picking + 1 }} 集…
            </div>
            <div v-if="queue.length" ref="epListEl" class="ep-list">
              <button
                v-for="it in visibleEps"
                :key="it.ep.url"
                class="ep-btn"
                :class="{ active: it.i === queueIndex }"
                :title="it.ep.name"
                :disabled="picking >= 0"
                @click="onPickEpisode(it.i)"
              >
                {{ it.ep.name }}
              </button>
            </div>
            <!-- 折叠替代内层滚动条：只显示预览窗口，其余交给「展开全部」 -->
            <div v-if="queue.length > EP_PREVIEW" class="ep-more-row">
              <button class="mini more" @click="epExpanded = !epExpanded">
                {{ epExpanded ? '收起剧集' : `展开全部 ${queue.length} 集` }}
              </button>
              <span v-if="!epExpanded && (epsHidden.before || epsHidden.after)" class="dim ep-hidden">
                已折叠 {{ epsHidden.before + epsHidden.after }} 集
              </span>
            </div>
            <!-- 注意：不能写成 v-else，否则会挂到上面的「展开全部」上（剧集少时误报无剧集） -->
            <p v-if="!queue.length" class="side-note">该片源没有剧集列表（单集播放或手动直链）。</p>
          </div>

          <div v-if="ctxContent" class="side-block">
            <h4>简介</h4>
            <p class="side-content" :class="{ expanded: contentExpanded }">{{ ctxContent }}</p>
            <button
              v-if="ctxContent.length > 80"
              class="mini more"
              @click="contentExpanded = !contentExpanded"
            >
              {{ contentExpanded ? '收起' : '展开全部' }}
            </button>
          </div>
          <dl v-if="playCtx.director || playCtx.actor" class="credits">
            <div v-if="playCtx.director">
              <dt>导演</dt>
              <dd>{{ playCtx.director }}</dd>
            </div>
            <div v-if="playCtx.actor">
              <dt>主演</dt>
              <dd>{{ playCtx.actor }}</dd>
            </div>
          </dl>
        </template>
      </template>
    </aside>

    <!-- P5 调试抽屉（底部 dock）
         原先它跟在播放卡后面、和播放卡在同一个滚动流里：只要右栏（剧集/简介）比左列高，
         页面就有了滚动空间，而播放卡是 sticky（钉住不动），调试面板于是从它下面滑过去被
         整块盖住——实测侧栏 60 集时可被压 271px，等于打不开。
         改成视口底部的固定抽屉后，它不再参与内容流，永远不会被播放卡遮挡；展开时通过
         --pf-card-room 反向压缩视频高度，做到「视频完整 + 面板完整」共存，而不是浮层盖住
         画面——mpv 是原生子窗口（WS_CHILD），任何 DOM 浮层都会被它吃掉。 -->
    <Transition name="pf-dock">
      <button
        v-if="!debugOpen"
        class="dock-pill"
        type="button"
        title="打开调试面板（多源监控 / 事件日志）"
        @click="debugOpen = true"
      >
        <span class="dock-dot" :class="`dot-${lastLogLevel}`" aria-hidden="true"></span>
        <span class="dock-pill-text">调试</span>
        <span class="dock-pill-num">{{ store.sources.length }} 源 · {{ store.logs.length }} 条</span>
      </button>
    </Transition>

    <Transition name="pf-dock-panel">
      <section v-if="debugOpen" class="card dock" aria-label="调试面板">
        <header class="dock-head">
          <h3>调试面板</h3>
          <span class="dock-stat">{{ store.sources.length }} 源 · {{ store.logs.length }} 条日志</span>
          <button class="mini" @click="debugOpen = false">收起 ⌄</button>
        </header>
        <div class="dock-body">
        <div class="debug-grid">
          <div>
            <h4>多源监控（{{ store.sources.length }} 源）</h4>
            <template v-if="store.sources.length">
              <div v-for="s in store.sources" :key="s.idx" class="src-row">
                <div class="src-head">
                  <span class="src-idx" :class="{ mirror: s.idx > 0 }">{{ s.idx === 0 ? '主' : `镜${s.idx}` }}</span>
                  <span class="mono src-url" :title="s.url">{{ s.url }}</span>
                  <span class="src-state" :class="`ss-${s.state}`">
                    {{ sourceStateLabel[s.state] ?? s.state
                    }}<template v-if="s.circuitRemainingSecs !== undefined"> {{ s.circuitRemainingSecs }}s</template>
                  </span>
                </div>
                <div class="src-metrics">
                  <span title="吞吐 EWMA">{{ fmtBytes(s.throughputEwma) }}</span>
                  <span title="时延 EWMA">{{ (s.latencyEwma * 1000).toFixed(0) }} ms</span>
                  <span title="成功率 EWMA">{{ pct(s.successRate) }}</span>
                  <span title="调度分">{{ s.score.toFixed(2) }}</span>
                  <span class="dim" title="请求/失败">{{ s.requests }}/{{ s.failures }}</span>
                </div>
              </div>
              <div v-if="store.proxyStats" class="kv pstat">
                <span class="k">代理命中 / 回源</span>
                <span class="mono">{{ store.proxyStats.cacheHits }} / {{ store.proxyStats.originFetches }}</span>
              </div>
            </template>
            <p v-else class="dim empty-hint">创建任务后显示各源健康度（EWMA / 熔断状态）</p>
          </div>
          <div>
            <h4>事件日志</h4>
            <ul v-if="store.logs.length" class="log">
              <li v-for="(l, i) in visibleLogs" :key="i">
                <span class="t mono">{{ fmtTime(l.ts) }}</span>
                <span class="lv" :class="`lv-${l.level}`">{{ l.level }}</span>
                <span class="msg">{{ l.message }}</span>
              </li>
            </ul>
            <p v-else class="dim empty-hint">暂无事件</p>
            <!-- 折叠替代内层滚动条 -->
            <button v-if="store.logs.length > LOG_PREVIEW" class="mini more log-more" @click="logExpanded = !logExpanded">
              {{ logExpanded ? '只看最新' : `展开全部 ${store.logs.length} 条` }}
            </button>
          </div>
        </div>
        </div>
      </section>
    </Transition>
  </div>
</template>

<style scoped>
/*
 * P24 布局：整页只有一个纵向滚动容器（App 的 .content）。
 *
 *   .content（唯一滚动条）
 *   └─ .player-view  grid[左列 stage | 右列 info-side]
 *      ├─ .stage           左列，stretch 到与右列等高
 *      │   └─ section.player    sticky 跟随，自身不产生滚动条
 *      └─ aside.info-side   普通流，不设 max-height / overflow
 *   └─ .dock（fixed 底部抽屉）   调试面板，脱离内容流
 *
 * 为什么要有 .stage 这一层：grid 里 sticky 的包含块就是它的 grid 区域，
 * 若播放卡直接占第一行，区域高度=自身高度，sticky 完全失效。套一层 stretch 的
 * 列容器后，包含块 = 整列高度（= 侧栏高度），播放卡才能真正跟随。
 *
 * 为什么调试面板不在 .stage 里（P30）：它原先排在播放卡下方，与 sticky 播放卡同处
 * 一个滚动流。右栏比左列高时页面产生滚动空间，播放卡钉住不动，调试面板就从它下面
 * 滑过去被整块盖住（60 集侧栏时实测被压 271px）。脱离内容流改成底部固定抽屉后，
 * 它不再受滚动与 sticky 的任何影响。
 */
.player-view {
  width: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 336px;
  align-items: start;
  gap: var(--sp-4);
  /*
   * P25 纵向预算：播放卡的高度上限由「视口 - 这两项」决定（详见 .video-wrap）。
   * 拆成两个变量是为了让「卡片自身有多高」和「卡片之外必须留多少」互不干扰，
   * 改控制条/弹幕栏高度只动 --pf-card-chrome，改顶栏或抽屉只动 --pf-card-room。
   *
   *   --pf-card-chrome  视频区以外的卡片高度：padding 32 + 控制条 46 + 弹幕栏 44
   *                     + 折叠行 24 + 若干 margin（实测 ≈174，取 176 留 2px 余量）。
   *                     真值由模板按内核写内联变量（mpv 多一行进度条 → 222px），
   *                     这里只作兜底默认值。
   *   --pf-card-room    卡片之外的开销：内容上留白 16 + 余量 61 + 下留白 16 = 93
   *                     （P30 去掉了调试面板收起态的 50px；P42 撤掉 56px 顶栏后再减 51px）
   *   --pf-dock-h       调试抽屉展开时的高度：280px，矮窗口自动降级
   */
  --pf-card-chrome: 176px;
  --pf-card-room: 93px;
  /* 展开时按视口比例给高度：大屏最多 240，小屏收到 25dvh，极矮窗口保底 150
     （再矮就只剩两三条日志，不如让用户先收起面板） */
  --pf-dock-h: clamp(150px, 25dvh, 240px);
}
.player-view.side-collapsed {
  grid-template-columns: minmax(0, 1fr) 56px;
}
/*
 * 抽屉展开：把抽屉高度算进「卡片之外的开销」，视频区按 16:9 反推后整体缩小，
 * 于是「视频完整 + 抽屉完整」同时成立，而不是抽屉盖住视频。
 * +53 = 抽屉高 + 间距 16 + 底部留白 16 + 余量 21（保证卡底停在抽屉顶上方 ~20px）。
 */
.player-view.debug-open {
  --pf-card-room: calc(var(--pf-dock-h) + 53px);
  /* 抽屉压在视口底部，补出等高的下内边距，滚到底时侧栏最后一块不被盖住 */
  padding-bottom: calc(var(--pf-dock-h) + var(--sp-4));
}
.stage {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  /* 撑满整行：sticky 的包含块要够高，否则只能跟随自身高度 */
  align-self: stretch;
}

/* ---- 视频区 ---- */
.video-wrap {
  position: relative;
  background: #000;
  /*
   * P38：禁止给视频区加 border-radius / overflow:hidden。
   *
   * 这两条会让 Chromium 先渲染到纹理再做 mask 裁剪；在 Intel 核显 + ANGLE/D3D11
   * （混合 GPU、多显示器/虚拟显示器环境下常见）这条呈现路径会失败：合成器里画面完好
   * （Page.startScreencast 有画面、截图也有），但真正上屏时是一整块纯黑，连原生控制条
   * 都不出现。全屏时 <video> 进入 top layer、绕过祖先裁剪，所以「全屏能看、窗口黑」。
   *
   * 症状复现与判定方式见 docs/P38-视频黑屏-呈现路径.md。要圆角请让视频区保持直角，
   * 由外层卡片提供圆角 —— 否则必然复发。
   */
  border-radius: 0;
  overflow: visible;
  aspect-ratio: 16 / 9;
  /*
   * P25：宽度只由「高度预算」反推，不再按列宽撑满。
   *
   * 旧写法是给 .card.player 加 `max-width: (100dvh - 260px) * 16/9 + 34px`。
   * 260px 的余量远小于卡片真实开销，于是卡片比视口还高，窗口再矮也永远看不全。
   *
   * 现在把预算直接写成「视口 - 卡片其他开销 - 卡片之外的开销」，
   * 算出视频区能用的高度，再按 16/9 求宽度；视频卡整体恒定比视口矮 --pf-card-room。
   * P30：--pf-card-room 里不再含调试面板（它已改为 fixed 抽屉），展开抽屉时该变量
   * 由 .player-view.debug-open 调大，视频随之等比缩小，给抽屉让出底部空间。
   */
  width: min(100%, calc(max(0px, 100dvh - var(--pf-card-chrome) - var(--pf-card-room)) * 16 / 9));
  margin-inline: auto;
}
video {
  width: 100%;
  height: 100%;
  display: block;
}
/*
 * P47：清掉原生控制条在「键盘聚焦」时画出来的系统焦点环。
 *
 * 这条边框不是我们写的样式，而是 Chromium UA 默认样式：
 *   video:focus-visible                     → outline: auto 1px（画满整个视频区一圈）
 *   video::-webkit-media-controls-timeline  → outline: auto 1px（画在进度条那一行外面）
 *
 * 鼠标交互时 :focus-visible 不成立，所以平时看不到；一旦用键盘（← / → 快进后退，
 * 或者 Tab 进控制条）焦点就变成「可见焦点」，这两条框立刻出现 —— 深色画面上一条
 * 1px 的浅色矩形，看起来就像凭空多出来的边框。点过进度条再按方向键时，焦点落在
 * 内部时间轴 <input type=range> 上，出现的就是进度条那一圈（P47 用户反馈的截图）。
 *
 * 只改外观，不改行为：方向键快进后退、空格暂停、点进度条拖动全部照旧。
 * 两条规则必须分开写 —— 伪元素选择器一旦不被支持会连累整条选择器列表失效。
 */
.video-wrap video:focus,
.video-wrap video:focus-visible {
  outline: none;
}
.video-wrap :deep(video::-webkit-media-controls-timeline) {
  outline: none;
}
.placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 var(--sp-4);
  text-align: center;
  pointer-events: none;
}
.placeholder p {
  font-size: var(--fs-sm);
  color: var(--text-dim);
}
.placeholder p.small {
  color: var(--text-faint);
  font-size: var(--fs-2xs);
}

/* 无画面时的状态条：居中、不吃鼠标事件（不能挡原生控制条） */
.stall-hint {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: min(80%, 420px);
  padding: 7px 14px;
  border-radius: var(--r-pill);
  font-size: var(--fs-2xs);
  line-height: 1.4;
  color: var(--text-dim);
  background: rgb(11 14 20 / 0.76);
  border: 1px solid var(--line-2);
  backdrop-filter: blur(6px);
  pointer-events: none;
  z-index: 3;
}
.stall-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  flex: none;
  animation: stall-pulse 1.1s ease-in-out infinite;
}
/* 超时态：从「耐心等」变成「给你出口」——圆角矩形 + 可点的重试按钮 */
.stall-hint.stuck {
  max-width: min(86%, 520px);
  border-radius: var(--r-md);
  padding: 10px 14px;
  color: var(--text);
  background: rgb(11 14 20 / 0.94);
  border-color: var(--danger-line);
  pointer-events: auto;
}
.stall-retry {
  flex: none;
  min-height: 24px;
  margin-left: 2px;
  padding: 0 11px;
  border-radius: var(--r-pill);
  border: 1px solid var(--accent-line);
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: var(--fs-2xs);
  cursor: pointer;
}
.stall-retry:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 26%, transparent);
  color: var(--text);
}
/* P37 画面内错误卡：任何失败都要在视频区说清楚，并给出两个出口 */
.video-error {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 4;
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: min(86%, 460px);
  padding: 14px 16px 12px;
  border-radius: var(--r-md);
  background: rgb(11 14 20 / 0.94);
  border: 1px solid var(--danger-line);
  backdrop-filter: blur(6px);
  text-align: left;
}
.ve-title {
  margin: 0;
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text);
}
.ve-msg {
  margin: 0;
  font-size: var(--fs-2xs);
  line-height: 1.5;
  color: var(--text-dim);
  overflow-wrap: anywhere;
}
.ve-acts {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
.ve-copy {
  flex: none;
  min-height: 24px;
  padding: 0 11px;
  border-radius: var(--r-pill);
  border: 1px solid var(--line-2);
  background: transparent;
  color: var(--text-dim);
  font-size: var(--fs-2xs);
  cursor: pointer;
}
.ve-copy:hover {
  border-color: var(--line-hover);
  color: var(--text);
}
@keyframes stall-pulse {
  0%,
  100% {
    opacity: 0.25;
  }
  50% {
    opacity: 1;
  }
}

/*
 * 播放卡：高度由 .video-wrap 的宽度上限反推，整体恒定比视口矮 --pf-card-room，
 * 所以 sticky 顶住时「视频 + 控制条」始终完整可见。
 * P30 起调试面板不再排在卡片下方，sticky 已没有「压住下方内容」的副作用。
 */
.card.player {
  position: sticky;
  top: 0;
  z-index: 2;
  align-self: flex-start;
  width: 100%;
}
/* 调试抽屉展开时播放卡照旧吸顶：抽屉是 fixed 定位、不参与内容流，
   视频已按 --pf-card-room 缩小让位，两者不会互相遮挡，没必要再取消 sticky。 */

/* ---- 控制条 ---- */
.url-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  margin-top: var(--sp-3);
}
.url-row input {
  flex: 1 1 260px;
  min-width: 0;
}
.url-row .mode-select,
.url-row .time-label {
  flex: none;
}
.engine-row {
  gap: 6px;
}
.engine-label {
  font-size: var(--fs-2xs);
  color: var(--text-faint);
  margin-right: 2px;
}
/* 控制条按钮：和全局 .btn 同源，但压到 28px 高以塞进一行 */
.engine-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 0 11px;
  border: 1px solid var(--line-2);
  border-radius: var(--r-sm);
  background: var(--panel-2);
  color: var(--text-dim);
  font-size: var(--fs-2xs);
  box-shadow: none;
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease),
    color var(--t-fast) var(--ease);
}
.engine-btn:hover:not(:disabled) {
  background: var(--panel-3);
  border-color: var(--line-hover);
  color: var(--text);
  transform: none;
}
.engine-btn.active {
  background: var(--accent-soft);
  border-color: var(--accent-line);
  color: var(--accent-ink);
  font-weight: 500;
}
.engine-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
/* P15 倍速选择器（窄选项，与内核按钮同排） */
.rate-select {
  width: 84px;
}
/* P9 连播入口：与内核按钮同级，强调但不喧宾 */
.next-btn {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-color: var(--accent-line);
  color: var(--accent-ink);
}
.eng-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-faint);
  flex: none;
}
.eng-dot.ok {
  background: var(--ok);
  box-shadow: 0 0 0 3px var(--ok-bg);
}
.eng-dot.off {
  background: var(--danger);
}
.flex-sp {
  flex: 1;
}

/* ---- P11 弹幕 ---- */
.dm-toggle .dm-count {
  min-width: 18px;
  padding: 0 5px;
  border-radius: var(--r-pill);
  background: var(--panel-3);
  color: var(--text-faint);
  font-size: var(--fs-2xs);
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.dm-toggle.active .dm-count {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.dm-send {
  margin-top: var(--sp-2);
}
.dm-send .dm-input {
  flex: 1 1 200px;
}
/* ---- P31 弹幕状态行（从视频画面里挪出来的配置/状态提示） ---- */
.dm-status {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  padding: 0 2px;
  font-size: var(--fs-2xs);
  line-height: 1.6;
  color: var(--text-dim);
}
.dm-status-dot {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--text-faint);
}
.dm-status-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dm-status-act {
  flex: none;
  padding: 0;
  border: 0;
  background: none;
  font-size: inherit;
  color: var(--accent);
  text-decoration: underline;
  cursor: pointer;
}
.dm-status-act:hover {
  color: var(--accent-ink);
}
.dm-status.warn .dm-status-dot {
  background: var(--warn);
}
.dm-status.warn .dm-status-text {
  color: var(--warn);
}
.dm-status.err .dm-status-dot {
  background: var(--danger);
}
.dm-status.err .dm-status-text {
  color: var(--danger);
}
.dm-status.busy .dm-status-dot {
  background: var(--accent);
  animation: dm-status-pulse 1s ease-in-out infinite;
}
@keyframes dm-status-pulse {
  50% {
    opacity: 0.25;
  }
}
.dm-send .dm-color {
  flex: none;
  width: 36px;
  height: 30px;
  padding: 2px;
  border-radius: var(--r-sm);
  background: var(--panel-2);
  border: 1px solid var(--line-2);
  cursor: pointer;
}
.dm-send button {
  min-height: 30px;
}
.dm-feedback {
  margin-top: 6px;
  font-size: var(--fs-2xs);
  color: var(--text-dim);
}
.time-label {
  padding: 0 4px;
  font-size: var(--fs-2xs);
  color: var(--text-dim);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
/* mpv 专用进度条行：range + 字幕/音轨下拉 */
.seek-row {
  gap: var(--sp-3);
}
.seek-range {
  flex: 1 1 200px;
  min-width: 0;
  height: 4px;
  accent-color: var(--accent);
  cursor: pointer;
}

/* 手动播放 / 高级：折叠后主视觉只剩播放器与控制条 */
.manual {
  margin-top: var(--sp-3);
  padding-top: var(--sp-2);
  border-top: 1px solid var(--line);
}
.manual > summary {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 3px 0;
  font-size: var(--fs-2xs);
  color: var(--text-dim);
  cursor: pointer;
  list-style: none;
  user-select: none;
}
.manual > summary::-webkit-details-marker {
  display: none;
}
.manual > summary::before {
  content: '▸';
  font-size: 9px;
  color: var(--text-faint);
  transition: transform var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.manual[open] > summary::before {
  transform: rotate(90deg);
  color: var(--accent);
}
.manual > summary:hover {
  color: var(--text);
}
.manual .url-row {
  margin-top: var(--sp-2);
}
.manual .url-hint {
  margin-top: 6px;
}

/* ---- P5 调试抽屉（底部 dock，脱离内容流） ---- */
/* 收起态：右下角胶囊入口。只占一个小角，不遮挡内容，也不参与布局 */
.dock-pill {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 30;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 30px;
  padding: 0 11px;
  border: 1px solid var(--line-2);
  border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--panel) 88%, transparent);
  backdrop-filter: blur(10px);
  color: var(--text-dim);
  font-size: var(--fs-2xs);
  box-shadow: var(--shadow-2);
  transition:
    color var(--t-fast) var(--ease),
    border-color var(--t-fast) var(--ease),
    transform var(--t-fast) var(--ease);
}
.dock-pill:hover {
  color: var(--text);
  border-color: var(--accent-line);
  transform: translateY(-1px);
}
.dock-pill-num {
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
/* 小圆点 = 最新一条日志的级别，不点开也能看出有没有报错 */
.dock-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-faint);
}
.dot-error {
  background: var(--danger);
  box-shadow: 0 0 0 3px var(--danger-bg);
}
.dot-warn {
  background: var(--warn);
  box-shadow: 0 0 0 3px var(--warn-bg);
}
.dot-info {
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.dot-debug {
  background: var(--text-faint);
}

/* 展开态：贴底全宽抽屉，固定定位，永不参与页面滚动 */
.dock {
  position: fixed;
  inset: auto 0 0 0;
  z-index: 45;
  display: flex;
  flex-direction: column;
  height: var(--pf-dock-h);
  padding: 0;
  border-radius: var(--r-lg) var(--r-lg) 0 0;
  border-bottom: none;
  border-color: var(--line-2);
  background: var(--panel);
  /* 抽屉是浮层：阴影跟随皮肤（暗色近乎纯黑，亮色要淡很多） */
  box-shadow: 0 -16px 40px -20px var(--shadow-color);
}
.dock-head {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex: none;
  height: 44px;
  padding: 0 var(--sp-4);
  border-bottom: 1px solid var(--line);
}
/* 顶部把手条已去掉：面板高度不可拖拽调整，留着会误导成「可以拉」。 */
.dock-head h3 {
  margin: 0;
  font-size: var(--fs-sm);
}
.dock-stat {
  flex: 1;
  min-width: 0;
  color: var(--text-faint);
  font-size: var(--fs-2xs);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 抽屉内部是工具面板，允许自己滚动（页面主滚动条不受影响） */
.dock-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--sp-3) var(--sp-4) var(--sp-4);
}
.debug-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--sp-5);
}

/* 收起/展开动效：胶囊淡入上浮，抽屉自下而上滑入 */
.pf-dock-enter-active,
.pf-dock-leave-active {
  transition:
    opacity var(--t-base) var(--ease),
    transform var(--t-base) var(--ease);
}
.pf-dock-enter-from,
.pf-dock-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
.pf-dock-panel-enter-active,
.pf-dock-panel-leave-active {
  transition:
    transform var(--t-base) var(--ease),
    opacity var(--t-fast) var(--ease);
}
.pf-dock-panel-enter-from,
.pf-dock-panel-leave-to {
  opacity: 0;
  transform: translateY(100%);
}

/* 矮窗口降级靠 --pf-dock-h 的 clamp 自适应，不再单独用媒体查询覆盖。
   注意别把下一条选择器接到收尾大括号后面，否则该规则整条失效。 */
h4 {
  margin-bottom: var(--sp-2);
  font-size: var(--fs-2xs);
  font-weight: 600;
  color: var(--text-dim);
  letter-spacing: 0.3px;
}
.src-row {
  padding: 8px 0;
  border-bottom: 1px solid var(--line);
}
.src-row:last-of-type {
  border-bottom: none;
}
.src-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.src-idx {
  flex: none;
  width: 26px;
  padding: 1px 0;
  border-radius: var(--r-sm);
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: var(--fs-2xs);
  text-align: center;
}
.src-idx.mirror {
  background: var(--warn-bg);
  color: var(--warn);
}
.src-url {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-faint);
  font-size: 10.5px;
}
.src-state {
  flex: none;
  padding: 1px 6px;
  border-radius: var(--r-sm);
  font-size: var(--fs-2xs);
  background: var(--panel-3);
  color: var(--text-dim);
}
.ss-active {
  background: var(--ok-bg);
  color: var(--ok);
}
.ss-half_open {
  background: var(--warn-bg);
  color: var(--warn);
}
.ss-circuit_open {
  background: var(--danger-bg);
  color: var(--danger);
}
.src-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 5px;
  padding-left: 34px;
  font-size: 10.5px;
  color: var(--text-faint);
  font-family: 'Cascadia Code', Consolas, monospace;
  font-variant-numeric: tabular-nums;
}
.pstat {
  margin-top: var(--sp-2);
  padding-top: 8px;
  border-top: 1px dashed var(--line-2);
}
.log {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: var(--fs-2xs);
}
/* 日志折叠按钮（替代原来的 max-height + overflow:auto） */
.log-more {
  margin-top: 8px;
}
.log li {
  display: flex;
  gap: 8px;
  align-items: baseline;
}
.log .t {
  color: var(--text-faint);
  flex: none;
  font-variant-numeric: tabular-nums;
}
.lv {
  flex: none;
  padding: 0 6px;
  border-radius: var(--r-sm);
  font-size: 10px;
  text-transform: lowercase;
}
.lv-info {
  background: var(--info-bg);
  color: var(--info);
}
.lv-warn {
  background: var(--warn-bg);
  color: var(--warn);
}
.lv-error {
  background: var(--danger-bg);
  color: var(--danger);
}
.lv-debug {
  background: var(--panel-3);
  color: var(--text-faint);
}
.msg {
  word-break: break-all;
  color: var(--text-dim);
  line-height: 1.55;
}

/* ---- P20 信息侧栏 ---- */
.info-side {
  width: 100%;
  min-width: 0;
  align-self: start;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-4);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
}
/* 收起态：一根窄条（海报 + 竖排片名 + 集序） */
.player-view.side-collapsed .info-side {
  min-height: 220px;
  padding: 10px 6px;
  align-items: center;
  gap: 10px;
  overflow: hidden;
}
@media (max-width: 1280px) {
  .player-view {
    grid-template-columns: minmax(0, 1fr) 300px;
  }
}
.rail-btn,
.side-toggle {
  flex: none;
  padding: 0;
  border: 1px solid var(--line-2);
  border-radius: var(--r-sm);
  background: var(--panel-2);
  color: var(--text-dim);
  line-height: 1;
  box-shadow: none;
  cursor: pointer;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.rail-btn {
  width: 100%;
  height: 26px;
  font-size: 14px;
}
.side-toggle {
  width: 26px;
  height: 26px;
  font-size: 14px;
}
.rail-btn:hover,
.side-toggle:hover {
  background: var(--panel-3);
  border-color: var(--line-hover);
  color: var(--text);
  transform: none;
}
.rail-poster {
  flex: none;
  width: 40px;
  aspect-ratio: 2 / 3;
  padding: 0;
  border: 1px solid var(--line-2);
  border-radius: var(--r-sm);
  overflow: hidden;
  background: var(--panel-2);
  cursor: pointer;
}
.rail-poster img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.rail-text {
  writing-mode: vertical-rl;
  text-orientation: mixed;
  max-height: 42vh;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: var(--fs-xs);
  letter-spacing: 1px;
  color: var(--text-dim);
}
.rail-badge {
  padding: 1px 5px;
  border-radius: var(--r-pill);
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.side-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}
.side-head h3 {
  margin: 0;
  font-size: var(--fs-sm);
  font-weight: 600;
}
.side-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: var(--sp-6) var(--sp-2) var(--sp-4);
  text-align: center;
}
.side-empty-ico {
  font-size: 22px;
  opacity: 0.75;
  line-height: 1.2;
}
.side-empty-title {
  font-size: var(--fs-xs);
  color: var(--text);
}
.side-empty-sub {
  font-size: var(--fs-2xs);
  line-height: 1.65;
  color: var(--text-faint);
}
.side-empty .btn {
  margin-top: var(--sp-2);
}
.side-top {
  display: flex;
  gap: var(--sp-3);
}
.side-poster {
  flex: none;
  width: 78px;
  aspect-ratio: 2 / 3;
  border-radius: var(--r-sm);
  overflow: hidden;
  background: var(--panel-2);
  border: 1px solid var(--line);
}
.side-poster img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.poster-empty {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-2xs);
  color: var(--text-faint);
  border: 1px dashed var(--line-2);
  border-radius: var(--r-sm);
}
.side-meta {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.side-title {
  font-size: var(--fs-md);
  font-weight: 600;
  line-height: 1.35;
  color: var(--text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.side-now,
.side-src {
  font-size: var(--fs-2xs);
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.side-now {
  color: var(--accent-ink);
}
/* P22 播放源：片源 + 线路两个下拉集中在一个区块 */
.side-block {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--line);
}
.side-block h4 {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-2xs);
  font-weight: 600;
  color: var(--text-dim);
}
.side-block h4 .count {
  padding: 0 5px;
  border-radius: var(--r-pill);
  background: var(--panel-3);
  color: var(--text-faint);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}
.nav-mini {
  display: flex;
  gap: 4px;
}
.source-block {
  gap: 8px;
}
.field {
  display: flex;
  align-items: center;
  gap: 8px;
}
.field-label {
  flex: none;
  width: 28px;
  font-size: var(--fs-2xs);
  color: var(--text-faint);
}
.side-select {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 26px 0 9px;
  border: 1px solid var(--line-2);
  border-radius: var(--r-sm);
  background-color: var(--panel-2);
  color: var(--text);
  font-size: var(--fs-2xs);
  cursor: pointer;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%237b879b' stroke-width='1.6' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 9px center;
  text-overflow: ellipsis;
}
.side-select:hover:not(:disabled) {
  border-color: var(--line-hover);
}
.side-select:disabled {
  opacity: 0.6;
  cursor: default;
}
.field-hint {
  margin: 0;
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--text-faint);
}
.switching {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-2xs);
  color: var(--accent-ink);
}
.switching .spin {
  width: 10px;
  height: 10px;
  border-width: 2px;
}
.src-count {
  font-size: var(--fs-2xs);
  color: var(--text-faint);
}
.side-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: var(--sp-3);
  border-top: 1px solid var(--line);
}
.side-progress .row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-2);
  font-size: var(--fs-2xs);
  color: var(--text-faint);
}
.side-progress .state {
  color: var(--text-dim);
}
.side-progress .live {
  color: var(--ok);
}
.side-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  padding: 6px 8px;
  border: 1px solid var(--danger-line);
  border-radius: var(--r-sm);
  background: var(--danger-bg);
  color: var(--danger);
  font-size: var(--fs-2xs);
  line-height: 1.5;
}
.side-loading {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--info-line);
  border-radius: var(--r-sm);
  background: var(--info-bg);
  color: var(--info);
  font-size: var(--fs-2xs);
}
/* P46 预缓存窗口：低调一行，不抢选集列表的注意力 */
.prefetch-line {
  margin: 0 0 8px;
  padding: 4px 8px;
  border-left: 2px solid var(--line-hover);
  color: var(--dim);
  font-size: var(--fs-2xs);
  line-height: 1.5;
}
.side-loading .spin {
  width: 11px;
  height: 11px;
  border-width: 2px;
  border-top-color: var(--info);
}
/* 剧集网格：等距等宽，长集名不互相挤压 */
.ep-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
  gap: 5px;
}
.ep-btn {
  min-height: 28px;
  min-width: 0;
  padding: 4px 6px;
  border: 1px solid var(--line-2);
  border-radius: var(--r-sm);
  background: var(--panel-2);
  color: var(--text-dim);
  font-size: var(--fs-2xs);
  font-variant-numeric: tabular-nums;
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease),
    color var(--t-fast) var(--ease);
}
.ep-btn:hover:not(:disabled) {
  background: var(--panel-3);
  border-color: var(--line-hover);
  color: var(--text);
  transform: none;
}
.ep-btn.active {
  background: var(--accent-soft);
  border-color: var(--accent-line);
  color: var(--accent-ink);
  font-weight: 600;
}
.ep-btn:disabled {
  opacity: 0.55;
}
/* 剧集折叠提示行 */
.ep-more-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.ep-hidden {
  font-size: 10.5px;
  color: var(--text-faint);
}
.side-note {
  margin: 0;
  font-size: var(--fs-2xs);
  line-height: 1.6;
  color: var(--text-faint);
}
.side-content {
  margin: 0;
  font-size: var(--fs-2xs);
  line-height: 1.7;
  color: var(--text-dim);
  white-space: pre-wrap;
  display: -webkit-box;
  -webkit-line-clamp: 5;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.side-content.expanded {
  display: block;
  overflow: visible;
}
.more {
  align-self: flex-start;
}
.credits {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: var(--fs-2xs);
}
.credits > div {
  display: flex;
  gap: var(--sp-2);
  min-width: 0;
}
.credits dt {
  flex: none;
  color: var(--text-faint);
}
.credits dd {
  margin: 0;
  min-width: 0;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 900px) {
  .debug-grid {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 640px) {
  /* 窄屏：输入独占一行，动作按钮均分次行 */
  .url-row input {
    flex: 1 1 100%;
  }
  .url-row .engine-btn,
  .url-row .mode-select {
    flex: 1 1 auto;
  }
  .debug-grid {
    gap: var(--sp-3);
  }
  .credits dd {
    white-space: normal;
  }
}

/* 窄屏：单列堆叠（stage 用 display:contents 拆平，让侧栏插到播放器下方），
   播放器不再 sticky（否则占满半屏还要滚动），侧栏跟随页面滚动。
   调试抽屉不参与 grid —— 它是 fixed 的，窄屏下自然也是全宽贴底。 */
@media (max-width: 900px) {
  .player-view,
  .player-view.side-collapsed {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      'player'
      'side';
  }
  .stage {
    display: contents;
  }
  .card.player {
    grid-area: player;
    position: static;
  }
  /*
   * 窄屏不再用「视口高度预算」限宽：列宽本身就是瓶颈，dvh 预算在矮窗口 + 抽屉展开时
   * 会算成负数，min(100%, 负数) 直接把视频区压成 0 宽（画面整个消失）。
   * 窄屏一律撑满列宽，高度交给 16:9 自然决定。
   */
  .video-wrap {
    width: 100%;
  }
  /* 窄屏是覆盖式（视频不压缩），抽屉可以给得高一些：两栏已并成一栏，
     150px 只够看一两条日志，而这里多占的高度并不会挤压视频。 */
  .player-view {
    --pf-dock-h: min(45dvh, 320px);
  }
  .info-side {
    grid-area: side;
    width: 100%;
  }
  .player-view.side-collapsed .info-side {
    width: 100%;
    min-height: 0;
    flex-direction: row;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
  }
  .player-view.side-collapsed .rail-btn {
    width: 24px;
    height: 24px;
  }
  .player-view.side-collapsed .rail-poster {
    width: 22px;
    height: 30px;
    aspect-ratio: auto;
  }
  .player-view.side-collapsed .rail-text {
    writing-mode: horizontal-tb;
    max-height: none;
    flex: 1;
    min-width: 0;
    font-size: var(--fs-2xs);
  }
  .ep-list {
    grid-template-columns: repeat(auto-fill, minmax(64px, 1fr));
  }
  /* 窄屏弹幕栏：输入独占一行，其余控件均分第二行（否则「发送」会被挤到第三行） */
  .dm-send {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 8px;
  }
  .dm-send .dm-input {
    grid-column: 1 / -1;
  }
  .dm-send .mode-select,
  .dm-send .dm-color {
    width: 100%;
    min-width: 0;
  }
  .dm-send button {
    width: 100%;
  }
}

/* 手机宽度：5 等分会把「滚动/普通」压成单字，退到 3 列（模式+颜色+样式一行，动作一行） */
@media (max-width: 560px) {
  .dm-send {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .dm-send .dm-color {
    width: 100%;
  }
}

/*
 * 矮窗口降级：窗口太矮时「视频 + 控制条」本身就接近一屏，sticky 会把下半截钉在屏外，
 * 所以退回普通流——此时页面滚动能完整看到整张卡。
 * 阈值取 620：常见 1366×768 / 1280×720 窗口（innerHeight 约 640~700）仍保留跟随。
 */
@media (max-height: 620px) {
  .card.player {
    position: static;
  }
}
</style>
