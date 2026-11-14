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
  // P58：单档源没有 RESOLUTION 可读，用实际解码高度显示「1080P」这类标签
  mediaH.value = videoEl.value?.videoHeight ?? 0
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
  // P48：点/拖原生进度条后焦点会留在控件的 closed shadow 内（那里的事件到不了 DOM），
  // 借着这次 seek 把焦点收回 <video>，方向键才能继续生效
  reclaimVideoFocus()
  // P55：seek 后已缓冲区间会变，自研进度条的浅色底要跟着重画
  syncBuffered()
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

// ---- P54 容器全屏（画面内「选集 / 下一集」） ----

/**
 * 全屏对象是「视频区容器」（`.video-wrap`），而不是 `<video>` 本身。
 *
 * 原生元素全屏只把 video 推进 top layer：弹幕层、无画面提示、错误卡、画面内按钮
 * 都是它的兄弟节点，一律不渲染（这也是过去全屏下弹幕消失的原因）。改成容器全屏后，
 * 全屏元素里的一切都跟着进全屏；换集只替换 `<video>` 的 src，全屏状态不丢。
 *
 * 原生控制条里的全屏按钮必须摘掉（`controlsList="nofullscreen"` 在这版 Chromium 上
 * 不生效，实际靠隐藏 `::-webkit-media-controls-fullscreen-button` 伪元素）：它走元素全屏，
 * 一点到就把这套覆盖 UI 整个遮掉，等于退回旧行为。全屏入口统一留在控制条的「全屏」按钮。
 */
const isFullscreen = ref(false)
/** 是否有任何全屏（含系统手势触发的原生 video 全屏），只用于按钮文案 */
const fsAny = ref(false)
/** 全屏选集面板是否展开 */
const fsEpOpen = ref(false)
/**
 * P58 全屏弹层：速度 / 清晰度（null = 全关）。同一时刻只开一个，
 * 且与选集面板互斥 —— 三者都挂在控制条上方同一片区域，叠起来谁也点不准。
 */
const fsMenu = ref<'speed' | 'quality' | null>(null)
const fsEpListEl = ref<HTMLElement | null>(null)
/**
 * 全屏底部控制条高度（px）。**必须与 CSS 的 `--pf-fs-bar` 一致**：
 * mpv 子窗口矩形按它扣减（子窗口恒画在 DOM 之上，不让出这条，玻璃条就被画面
 * 永久盖住），弹幕层与快进提示也按它让位。
 * P57 起画面本身不再扣这一条 —— 控制条是压在画面上的半透明玻璃（见 .fs-bar）。
 */
const FS_BAR_H = 72

async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen()
      return
    }
    const el = videoWrapEl.value
    if (!el) return
    await el.requestFullscreen()
  } catch (e) {
    store.pushLog('warn', `全屏切换失败：${(e as Error).message}`)
  }
}

/**
 * 全屏状态同步。挂在 document 的 fullscreenchange 上，而不是只认自家按钮：
 * Esc、系统手势、以及（万一没被 controlsList 摘掉的）原生全屏按钮都会走到这里。
 */
function onFullscreenChange(): void {
  const el = document.fullscreenElement
  fsAny.value = !!el
  isFullscreen.value = !!videoWrapEl.value && el === videoWrapEl.value
  if (!isFullscreen.value) fsEpOpen.value = false
  // P58：退出全屏时弹层一起收（它们只在全屏里存在）
  if (!isFullscreen.value) fsMenu.value = null
  // 进出全屏都要丢掉拖动/悬停残留：控制条会重建，留着只会是上一个布局的幽灵状态
  fsScrubbing.value = false
  fsHoverPos.value = null
  // P56 退出全屏：收起状态必须清干净（窗口模式没有这条控件，
  // 留着会让下次进全屏的头 2.6s 直接是「已收起」）
  if (!isFullscreen.value) {
    fsLastActive = 0
    fsIdle.value = false
    fsBarHover.value = false
    fsAnim.value = false
  }
  // 全屏切换同时改了视频区的尺寸和位置：mpv 子窗口必须跟着搬一次
  //（ResizeObserver 只看尺寸，位置变化它看不到）
  scheduleMpvRect()
  if (isFullscreen.value) {
    // 键盘快进/快退要能用：焦点必须回到 <video>（焦点一旦停在原生控制的 closed
    // shadow 里，键盘事件连 window 都到不了，见 P47）。容器全屏不会自动转移焦点。
    videoEl.value?.focus({ preventScroll: true })
    // P55：自研控制条接管后，暂停/静音/缓冲状态都从 video 现读一次，
    // 免得进全屏的第一帧还显示着窗口模式里的旧状态
    if (store.engine !== 'mpv') {
      const v = videoEl.value
      if (v) {
        videoPaused.value = v.paused
        fsMuted.value = v.muted
      }
      syncBuffered()
    }
    // 音量以渲染层这份状态为准（窗口模式下原生控制条改的音量已经回写过），
    // 进全屏推一次，mpv 内核刚起来时也靠这一步对齐
    applyVolume()
    // P56 进全屏先亮出控制条，再开始空闲计时
    fsLastPt = { x: -1, y: -1 }
    fsBarHover.value = false
    noteActivity()
    // 等全屏布局落定再开过渡（用定时器而不是 rAF：隐藏窗口里 rAF 不回调，
    // 而这里只需要「一帧之后」，120ms 足够，且两种窗口都可靠）
    window.setTimeout(() => {
      if (isFullscreen.value) fsAnim.value = true
    }, 120)
  } else {
    reclaimVideoFocus()
  }
}

/** 打开面板时把当前集滚进可视区：几十集的剧里点开就能看到「正在播的这集」 */
watch(fsEpOpen, async (open) => {
  if (!open) return
  await nextTick()
  fsEpListEl.value?.querySelector<HTMLElement>('.ep-btn.active')?.scrollIntoView({ block: 'center' })
})

/** 离开播放页必须退出全屏：否则整页只剩一块全屏画面，导航也点不到 */
watch(
  () => store.route,
  (r) => {
    if (r !== 'player' && document.fullscreenElement) void document.exitFullscreen().catch(() => {})
  }
)

/** 全屏内换集：成功后收起面板；失败把原因留在面板里，可原地重试 */
async function onPickFsEpisode(i: number): Promise<void> {
  if (picking.value >= 0) return
  await onPickEpisode(i)
  if (!sideError.value) fsEpOpen.value = false
}

/** 全屏内「下一集」：与侧栏同一入口（playAt），复用「切换中」状态与失败提示 */
function onFsNext(): void {
  if (!catalog.nextEpisode || picking.value >= 0) return
  void onPickFsEpisode(queueIndex.value + 1)
}

/** 全屏内「上一集」：队列首集时按钮 disabled，这里再兜一道（键盘/程序调用） */
function onFsPrev(): void {
  if (queueIndex.value <= 0 || picking.value >= 0) return
  void onPickFsEpisode(queueIndex.value - 1)
}

// ==========================================================================
// P58 全屏控制条：传输组图标化 + 倍速 + 清晰度
// --------------------------------------------------------------------------
// 左侧原来只有一个孤零零的播放键，右边却挤着三个文字按钮 —— 视觉重心全压在右半。
// 现在左侧是一个「传输组」（上一集 / 播放暂停 / 下一集，纯图标 + 悬浮提示），
// 倍速与清晰度以「值胶囊」跟在轨道右侧（和音量组同属菜单型控件），
// 右侧只留选集与退出全屏。整套动作的收益：文字按钮少一个、左侧成组、窄屏不挤。
// ==========================================================================

/**
 * 点开弹层那一下的 pointerdown 已经被按钮自己吃掉了，紧随其后的 click 不能再去
 * 触发「点画面 = 播放/暂停」—— 否则关个菜单顺手把片子暂停了。
 * 用一个 400ms 的自动复位兜底：某些情况下 click 不会来（拖拽、按键），
 * 留着 true 会把下一次真正的画面点击吃掉。
 */
let fsSwallowClick = false
function swallowNextVideoClick(): void {
  fsSwallowClick = true
  window.setTimeout(() => (fsSwallowClick = false), 400)
}

function toggleFsMenu(which: 'speed' | 'quality'): void {
  const next = fsMenu.value === which ? null : which
  fsMenu.value = next
  if (next === 'quality') void ensureVariants()
  // 收起选集面板：两个弹层共用控制条上方这片空间
  if (next) fsEpOpen.value = false
}

function toggleFsPanel(): void {
  fsMenu.value = null
  fsEpOpen.value = !fsEpOpen.value
}

// ---- 倍速 ----
/** 胶囊上永远带一位小数：`1×` 看着像「第一档」，`1.0×` 才是「正常速度」 */
const fsRateLabel = computed(() => {
  const r = store.playbackRate
  return `${Number.isInteger(r) ? r.toFixed(1) : r}×`
})

function pickFsRate(r: number): void {
  fsMenu.value = null
  void store.setPlaybackRate(r).catch(() => {})
}

// ---- 清晰度 ----
/**
 * 取档来源：任务自带的 master playlist（`task.masterUrl`，P3 就为「多清晰度」建过）。
 *
 * 为什么不在 hls.js 上直接换档（`hls.currentLevel`）：
 *   页内播放用的是 `playUrl`（代理本地化后的**单档** media playlist，走下载引擎、
 *   缓存/多源/解密全部生效）。它没有 variants，`levels` 恒为 1 —— 在它上面换档
 *   是换不动的。要拿到全部档位只有一条路：把 master 里的某一档重新载入。
 *   代价是换档要重载一次（丢了缓冲区，但有位置续播），换来的是「最高档仍然走
 *   下载引擎」这条不能丢的性质 —— 其余档在代理侧是 `/raw` 透传（同 mpv 的既有行为）。
 */
interface FsVariant {
  key: string
  url: string
  height: number
  bandwidth: number
  /** 最高码率那档 = 代理本地化的 playlist.m3u8，也就是当前默认播放的那档 */
  top: boolean
}
const fsVariants = ref<FsVariant[]>([])
/** 这份档位表是从哪个 master 解析出来的（判断「当前播的是 master 本身」用） */
const fsVariantsMaster = ref('')
/** 已解析过的任务 id（同一个任务反复开菜单不重复回源；force 可强制刷新） */
const fsVariantsFor = ref('')
const fsVariantsBusy = ref(false)
const fsVariantsErr = ref('')
/** 当前解码高度（单档源用来显示真实分辨率；mpv 侧拿不到，保持 0） */
const mediaH = ref(0)

/** 只认 `#EXT-X-STREAM-INF` 段：RESOLUTION 可能缺省，BANDWIDTH 一定有 */
function parseMasterPlaylist(text: string): { url: string; height: number; bandwidth: number }[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  const out: { url: string; height: number; bandwidth: number }[] = []
  for (let i = 0; i < lines.length; i++) {
    const tag = /^#EXT-X-STREAM-INF:(.*)$/.exec(lines[i])
    if (!tag) continue
    const uri = lines[i + 1]
    if (!uri || uri.startsWith('#')) continue
    const res = /RESOLUTION=(\d+)x(\d+)/i.exec(tag[1])
    const bw = /(?:^|,)BANDWIDTH=(\d+)/i.exec(tag[1])
    out.push({ url: uri, height: res ? Number(res[2]) : 0, bandwidth: bw ? Number(bw[1]) : 0 })
    i++ // URI 行已消费
  }
  return out
}

async function ensureVariants(force = false): Promise<void> {
  const task = store.tasks.find((t) => t.id === store.sourceTaskId)
  // 任务走它自己的 masterUrl（P3 那个「全 variant + EXT-X-MEDIA」的重写地址）；
  // 手动直链没有任务，就直接拿当前 URL 试一次 —— 手动贴 master 也能列档位。
  const master = task?.masterUrl ?? (/\.m3u8(\?|$)/.test(store.url) ? store.url : '')
  const cacheKey = task?.id ?? master
  if (!master) {
    fsVariants.value = []
    fsVariantsBusy.value = false
    return
  }
  if (!force && fsVariantsFor.value === cacheKey) return
  fsVariantsBusy.value = true
  fsVariantsErr.value = ''
  try {
    const res = await fetch(master, { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const parsed = parseMasterPlaylist(await res.text())
    const maxBw = parsed.reduce((m, v) => Math.max(m, v.bandwidth), 0)
    fsVariants.value = parsed
      .map((v, i) => ({
        key: `v${i}`,
        // master 里的 URI 是代理重写过的绝对路径，按 masterUrl 补全 origin
        url: new URL(v.url, master).href,
        height: v.height,
        bandwidth: v.bandwidth,
        top: maxBw > 0 && v.bandwidth === maxBw
      }))
      .sort((a, b) => (a.height || a.bandwidth) - (b.height || b.bandwidth))
    fsVariantsMaster.value = master
    fsVariantsFor.value = cacheKey
  } catch (e) {
    fsVariants.value = []
    fsVariantsErr.value = (e as Error).message
    // 失败也记一次：菜单里给「重试」而不是每次打开都回源
    fsVariantsFor.value = cacheKey
  } finally {
    fsVariantsBusy.value = false
  }
}

/** 当前播放的是哪一档；-1 = 认不出（手输直链、档位刚切换完） */
const fsVariantCurrent = computed(() => {
  const u = store.url
  const hit = fsVariants.value.findIndex((v) => v.url === u)
  if (hit >= 0) return hit
  // playUrl 指向代理本地化的最高档（/playlist.m3u8），与 master 里的 URI 字面不同
  if (/\/playlist\.m3u8(\?|$)/.test(u)) {
    const topIdx = fsVariants.value.findIndex((v) => v.top)
    if (topIdx >= 0) return topIdx
  }
  /*
   * 正在播 master 本身（手贴 master 直链 / 无任务的源）：hls.js 在内部按 ABR 选档，
   * 档位表里推不出来，只能拿**实际解码高度**就近匹配。一个帧都没解出来时
   * （清单还在解析 / 分片不是真 HLS）退回最高档 —— 那本来也是播放器的默认行为。
   */
  if (u === fsVariantsMaster.value) {
    const h = mediaH.value
    if (h > 0) {
      let best = -1
      let bestDiff = Infinity
      fsVariants.value.forEach((v, i) => {
        if (!v.height) return
        const d = Math.abs(v.height - h)
        if (d < bestDiff) {
          bestDiff = d
          best = i
        }
      })
      // 差太远说明这不是同一张表里的档（源已经换了），别硬套一个上去
      if (best >= 0 && bestDiff <= 180) return best
    }
    const topIdx = fsVariants.value.findIndex((v) => v.top)
    if (topIdx >= 0) return topIdx
  }
  return -1
})

const fsQualityLabel = computed(() => {
  const idx = fsVariantCurrent.value
  if (idx >= 0 && fsVariants.value[idx]?.height) return `${fsVariants.value[idx].height}P`
  if (fsVariants.value.length > 1) return '清晰度'
  if (mediaH.value > 0) return `${mediaH.value}P`
  return '原画'
})

interface FsMenuOpt {
  key: string
  label: string
  meta?: string
  active?: boolean
  disabled?: boolean
  run: () => void
}

const fsQualityOpts = computed<FsMenuOpt[]>(() => {
  if (fsVariantsBusy.value) return [{ key: 'busy', label: '正在读取清晰度…', disabled: true, run: () => {} }]
  if (fsVariantsErr.value) {
    return [
      { key: 'err', label: '读取失败', meta: fsVariantsErr.value.slice(0, 24), disabled: true, run: () => {} },
      { key: 'retry', label: '重试', run: () => void ensureVariants(true) }
    ]
  }
  const list = fsVariants.value
  // 单档/无档时胶囊上已经显示了真实解码高度（`mediaH`），条目文案要跟它一致，
  // 否则会出现「胶囊写着 720P、菜单里却只有一条『原画』」的自我矛盾。
  const realLabel = mediaH.value > 0 ? `${mediaH.value}P` : '原画'
  if (!list.length) {
    return [{ key: 'only', label: realLabel, meta: '源仅一档', active: true, disabled: true, run: () => {} }]
  }
  if (list.length === 1) {
    const v = list[0]
    return [
      {
        key: v.key,
        label: v.height ? `${v.height}P` : realLabel,
        meta: '源仅一档',
        active: true,
        disabled: true,
        run: () => {}
      }
    ]
  }
  return list.map((v, i) => ({
    key: v.key,
    label: v.height ? `${v.height}P` : `${Math.round(v.bandwidth / 1000)} kbps`,
    meta: i === fsVariantCurrent.value ? '当前' : `${(v.bandwidth / 1_000_000).toFixed(1)} Mbps`,
    active: i === fsVariantCurrent.value,
    run: () => void pickFsQuality(i)
  }))
})

/**
 * 换档 = 用目标档的 playlist 重新载入一次，并回到原位置。
 * 续播位置走 `catalog.pendingSeek`（hls 在 canplay 里消费），mpv 没有 canplay
 * 这条路径，等 loadfile 落地后直接 seek。
 */
async function pickFsQuality(idx: number): Promise<void> {
  const v = fsVariants.value[idx]
  fsMenu.value = null
  if (!v || idx === fsVariantCurrent.value || picking.value >= 0) return
  const at = playPos.value
  const dur = fsDur.value
  // 片尾 5s 内不折腾：续播位置会让它立刻结束，看起来像「切完就停」
  const resumeAt = at > 3 && dur > 0 && at < dur - 5 ? at : 0
  const label = v.height ? `${v.height}P` : `${Math.round(v.bandwidth / 1000)} kbps`
  store.pushLog('info', `切换清晰度 → ${label}${resumeAt ? `（${Math.round(resumeAt)}s 处续播）` : ''}`)
  catalog.pendingSeek = resumeAt
  store.url = v.url
  const video = videoEl.value
  if (!video) return
  await store.play(video)
  if (store.engine === 'mpv' && resumeAt > 0) {
    // mpv 的 loadfile 是异步的：等一拍再定位（提前 seek 会被内核丢掉）
    window.setTimeout(() => {
      void store.mpvSeekTo(resumeAt).catch(() => {})
    }, 600)
  }
}

// 换集/换任务：档位列表作废（新任务的 master 是另一份），下次开菜单再回源
watch(
  () => store.sourceTaskId,
  () => {
    fsVariantsFor.value = ''
    fsVariants.value = []
    fsVariantsErr.value = ''
    fsVariantsBusy.value = false
    mediaH.value = 0
    fsMenu.value = null
  }
)
/*
 * 手动直链换了地址（没有 task）时同样作废 —— 但**自己切档要放过**：
 * pickFsQuality 会把 store.url 改成某一档的地址，如果这里无脑清空，
 * 菜单下次打开就会去 parse 那个 media playlist，档位列表直接消失。
 */
watch(
  () => store.url,
  (u) => {
    if (fsVariants.value.some((v) => v.url === u)) return
    fsVariantsFor.value = ''
    fsVariants.value = []
    fsVariantsErr.value = ''
  }
)


// ---- P55 全屏控制条：进度条与按钮是一个整体 ----

/**
 * 单一数据源。`playPos` / `playDur` 本来就由两条内核分别喂（hls 走 timeupdate、
 * mpv 走 mpvState 状态泵），控制条的填充宽度、游标、时间文本、aria 值全部从
 * 这两个 ref 派生 —— 不存在「按钮那边记一份、进度条那边记一份」的第二份状态。
 */
const fsDur = computed(() => (Number.isFinite(playDur.value) && playDur.value > 0 ? playDur.value : 0))
const fsReady = computed(() => fsDur.value > 0)
/** hls 的暂停态（mpv 读 mpvState.pause）；两条内核统一成一个布尔给按钮用 */
const videoPaused = ref(true)
/**
 * P56 音量。mpv 侧 `MpvState` 不带 volume（内核只泵播放态），所以这里由渲染层持有
 * 唯一一份音量：hls 写 `video.volume`、mpv 写 `volume` 属性，两边都从这份状态出发。
 * 0–100 整数，与 mpv 的 `volume` 属性量纲一致（`volume-max` 默认 100）。
 */
const VOLUME_KEY = 'pf.player.volume'
interface VolumeMemo {
  v: number
  m: boolean
}
function loadVolumeMemo(): VolumeMemo {
  try {
    const raw = localStorage.getItem(VOLUME_KEY)
    if (!raw) return { v: 100, m: false }
    const o = JSON.parse(raw) as Partial<VolumeMemo>
    const v = typeof o.v === 'number' && Number.isFinite(o.v) ? Math.min(100, Math.max(0, Math.round(o.v))) : 100
    return { v, m: !!o.m }
  } catch {
    return { v: 100, m: false }
  }
}
const volMemo = loadVolumeMemo()
const fsVolume = ref(volMemo.v)
const fsMuted = ref(volMemo.m)
/** 拖动音量滑杆中：期间不吃 timeupdate / volumechange 的反向同步，避免自己打自己 */
const fsVolDragging = ref(false)
/** 静音前的音量：取消静音要回到这个值，而不是回到 100 */
let volBeforeMute = volMemo.v > 0 ? volMemo.v : 100
/** 拖动期间 mpv 侧的推送节流（每帧一次 mpv.set volume 太浪费） */
let volPushTimer: number | null = null
let volPushLast = 0
let volPushPending: number | null = null
/** 拖动中：显示值冻结在手指位置，不让 timeupdate 把游标拽回去 */
const fsScrubbing = ref(false)
const fsScrubPos = ref(0)
/** 悬停/拖动落点（秒）；null = 不显示气泡 */
const fsHoverPos = ref<number | null>(null)
/** 已缓冲到的位置（秒）；mpv 是原生子窗口，拿不到就恒为 0（浅色底不画） */
const bufEnd = ref(0)

const fsPaused = computed(() =>
  store.engine === 'mpv' ? (store.mpvState?.pause ?? true) : videoPaused.value
)
const fsShownPos = computed(() => {
  const p = fsScrubbing.value ? fsScrubPos.value : playPos.value
  if (!Number.isFinite(p) || p < 0) return 0
  return fsDur.value > 0 ? Math.min(p, fsDur.value) : p
})
const fsPct = computed(() => (fsDur.value > 0 ? `${(fsShownPos.value / fsDur.value) * 100}%` : '0%'))
const fsBufPct = computed(() => {
  if (fsDur.value <= 0 || bufEnd.value <= 0) return '0%'
  return `${Math.min(100, (bufEnd.value / fsDur.value) * 100)}%`
})
const fsTimeLabel = computed(
  () => `${fmtDur(fsShownPos.value)} / ${fsDur.value > 0 ? fmtDur(fsDur.value) : '--:--'}`
)
/** 气泡跟「拖动落点 > 悬停点」走：拖动时它显示的就是松手后会跳到的时间 */
const fsTipPos = computed(() => (fsScrubbing.value ? fsScrubPos.value : fsHoverPos.value))
const fsTipPct = computed(() => {
  const p = fsTipPos.value
  if (p === null || fsDur.value <= 0) return '0%'
  return `${Math.min(100, Math.max(0, (p / fsDur.value) * 100))}%`
})
const fsTipLabel = computed(() => {
  const p = fsTipPos.value
  if (p === null || fsDur.value <= 0) return ''
  return fmtDur(p)
})

function onVideoPlayState(paused: boolean): void {
  videoPaused.value = paused
  reclaimVideoFocus()
}

/**
 * 音量/静音变化（也可能是键盘音量键、窗口模式下的原生控制条）同步到控件。
 * 拖动滑杆期间忽略反向同步：我们自己刚写下去的值会以 volumechange 的形式弹回来，
 * 一旦接受就会和手指位置打架（拖到 30 又被弹回 28）。
 */
function onVideoVolumeChange(): void {
  const v = videoEl.value
  if (v && store.engine !== 'mpv' && !fsVolDragging.value) {
    fsMuted.value = v.muted
    fsVolume.value = Math.round(v.volume * 100)
    if (!v.muted && v.volume > 0) volBeforeMute = fsVolume.value
    persistVolume()
  }
  reclaimVideoFocus()
}

/** 音量落盘：换集、换内核、重启都要保持一致，不受单个 <video> 实例的生死影响 */
function persistVolume(): void {
  try {
    localStorage.setItem(VOLUME_KEY, JSON.stringify({ v: fsVolume.value, m: fsMuted.value }))
  } catch {
    /* 隐私模式 / 配额满：音量只是体验项，丢了不影响播放 */
  }
}

/** 把当前音量推到内核（hls 直接写元素；mpv 走 mpv.set，属性量纲 0–100） */
function applyVolume(): void {
  const mute = fsMuted.value || fsVolume.value === 0
  if (store.engine === 'mpv') {
    void store.rpc(RpcMethod.MpvSet, { name: 'volume', value: String(fsVolume.value) }).catch(() => {})
    void store.rpc(RpcMethod.MpvSet, { name: 'mute', value: mute ? 'yes' : 'no' }).catch(() => {})
    return
  }
  const v = videoEl.value
  if (!v) return
  v.volume = Math.min(1, Math.max(0, fsVolume.value / 100))
  v.muted = mute
}

/** mpv 侧推送节流：拖动时 100ms 一次，始终发送最新值（尾随） */
function pushVolumeThrottled(): void {
  volPushPending = fsVolume.value
  const flush = (): void => {
    volPushTimer = null
    volPushLast = performance.now()
    const v = volPushPending
    volPushPending = null
    if (v === null) return
    void store.rpc(RpcMethod.MpvSet, { name: 'volume', value: String(v) }).catch(() => {})
  }
  if (volPushTimer !== null) return
  const wait = Math.max(0, 100 - (performance.now() - volPushLast))
  if (wait === 0) flush()
  else volPushTimer = window.setTimeout(flush, wait)
}

/** 改音量：统一入口（滑杆、静音恢复、键盘都走这里） */
function setVolume(next: number): void {
  const v = Math.min(100, Math.max(0, Math.round(next)))
  fsVolume.value = v
  // 拖到 0 视为静音；从 0 往上拉自动解除静音 —— 否则会出现「拉到 60 还是没声音」
  if (v === 0) fsMuted.value = true
  else if (fsMuted.value) fsMuted.value = false
  if (v > 0) volBeforeMute = v
  if (store.engine === 'mpv') {
    if (fsVolDragging.value) pushVolumeThrottled()
    else applyVolume()
    return
  }
  const el = videoEl.value
  if (el) {
    el.volume = v / 100
    el.muted = fsMuted.value
  }
  if (!fsVolDragging.value) persistVolume()
}

function fsToggleMute(): void {
  const next = !fsMuted.value
  fsMuted.value = next
  if (!next && fsVolume.value === 0) {
    // 从 0 取消静音：恢复到静音前的音量，别把用户扔在「0 音量但没静音」的死角
    fsVolume.value = volBeforeMute > 0 ? volBeforeMute : 50
  }
  if (next) volBeforeMute = fsVolume.value > 0 ? fsVolume.value : volBeforeMute
  applyVolume()
  persistVolume()
  noteActivity()
}

/** 音量滑杆的指针纵坐标无关，横坐标映射 0–100 */
function volPos(e: PointerEvent): number {
  const el = e.currentTarget as HTMLElement | null
  if (!el) return 0
  const r = el.getBoundingClientRect()
  if (r.width <= 0) return 0
  return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * 100
}
function onVolDown(e: PointerEvent): void {
  if (e.button !== 0) return
  fsVolDragging.value = true
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  e.preventDefault()
  setVolume(volPos(e))
  noteActivity()
}
function onVolMove(e: PointerEvent): void {
  if (!fsVolDragging.value) return
  setVolume(volPos(e))
  noteActivity()
}
function onVolUp(e: PointerEvent): void {
  if (!fsVolDragging.value) return
  const el = e.currentTarget as HTMLElement
  if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
  fsVolDragging.value = false
  // 拖动期间 hls 是逐帧写元素的，落盘与 mpv 的收尾推送在这里补
  applyVolume()
  persistVolume()
  noteActivity()
}
/** 取消静音要回到的音量（滑杆填充与 0 对齐，因为静音 = 无声） */
const fsVolFillPct = computed(() => (fsMuted.value ? 0 : fsVolume.value))

// ---- P56 控制条自动隐藏 ----

/**
 * 空闲多久后收起控制条。2.6s 是个折中：短了「还在看时间轴」就被抽走，
 * 长了又会挡住画面。任何一次交互都会重置计时（见 noteActivity）。
 */
const FS_IDLE_MS = 2600
/**
 * 指针停在控制条上时用更长的阈值：用户可能正在瞄准按钮。但**不是永不收起** ——
 * 早前把 hover 当硬阻止，鼠标最后停在底部条上（很常见：看完控制条顺手把鼠标搁那）
 * 就永远不收，看起来就是「自动隐藏根本没生效」。
 */
const FS_IDLE_HOVER_MS = 4200
/** 心跳间隔：不靠一次性 setTimeout 决策，见 tickFsIdle */
const FS_IDLE_TICK_MS = 400
/** 控制条已收起（画面同时铺满整屏，见 CSS 的 .fs-idle） */
const fsIdle = ref(false)
/** 全屏布局稳定后置 true：只有这时才允许画面高度做过渡（否则进全屏会长大一次） */
const fsAnim = ref(false)
let fsIdleTick: number | null = null
/** 最后一次交互的时刻（performance.now），0 = 还没进过全屏 */
let fsLastActive = 0
/** 指针正停在控制条上：只是延长阈值，不再阻止收起 */
const fsBarHover = ref(false)

/**
 * 什么情况下禁止收起。逐条都是「收起来会让人骂」的场景：
 * 暂停（正在看画面/找按钮）、拖进度或拖音量（手还在上面）、选集面板开着、正在换集、报错。
 *
 * 刻意**不**包含 `fsBarHover`（改为延长阈值）和 `!fsReady`：
 * 后者是「还没起播」，而那时 `fsPaused` 必然为 true，已经被前一条覆盖；
 * 但 `fsReady` 依赖 `duration > 0`，容器格式 / 直播源拿不到时长时会恒为 false ——
 * 那会让控制条永久定在画面里，正好是这次要修的毛病。
 */
function fsIdleBlocked(): boolean {
  return (
    !isFullscreen.value ||
    fsPaused.value ||
    fsScrubbing.value ||
    fsVolDragging.value ||
    fsEpOpen.value ||
    // P58：速度/清晰度弹层开着时不能收条 —— 收条会把弹层一起拖走
    fsMenu.value !== null ||
    picking.value >= 0 ||
    !!store.playerError
  )
}

/**
 * 交互叫醒：立即显示并重置计时窗口。每次 pointermove 都会调，只写两个变量，可忽略。
 */
function noteActivity(): void {
  if (!isFullscreen.value) return
  fsLastActive = performance.now()
  if (fsIdle.value) fsIdle.value = false
}

/**
 * 心跳自检（每 400ms）。
 *
 * 为什么要有心跳，而不是一次 setTimeout 定生死：收起与否取决于 6 个状态，任何一次
 * 状态变化都可能把「刚建好的计时器」变成错的（进全屏那一刻 `fsPaused` / `picking`
 * 可能还没同步，`kickFsBar` 直接 return 了，之后就再也没有代码来建这个计时器）。
 * 心跳每拍重算一遍，状态一旦满足就自己开始计时，不依赖「某次事件恰好触发」。
 */
function tickFsIdle(): void {
  if (!isFullscreen.value) {
    fsLastActive = 0
    if (fsIdle.value) fsIdle.value = false
    return
  }
  if (fsIdleBlocked()) {
    // 阻塞期（暂停 / 拖动 / 面板 / 换集 / 报错）视为持续交互：
    // 解除后要重新计满一个完整窗口，而不是一恢复就立刻收起
    fsLastActive = performance.now()
    if (fsIdle.value) fsIdle.value = false
    return
  }
  const limit = fsBarHover.value ? FS_IDLE_HOVER_MS : FS_IDLE_MS
  if (!fsIdle.value && performance.now() - fsLastActive >= limit) fsIdle.value = true
}

/** 状态变化后立刻重算一次（不必等下一拍，但也不再依赖它来建计时器） */
function refreshFsIdle(): void {
  tickFsIdle()
}

/**
 * 全屏内的活动事件：鼠标移动（含触屏拖动）、按下、滚轮。
 *
 * 「指针是否停在控制条上」用**事件目标**判断，而不是 pointerenter/pointerleave 配一对布尔：
 * 后者一旦丢了 leave（窗口失焦、指针直接飞出窗口、隐藏窗口里不派发 hover）就永久卡在
 * 「停在条上」，控制条再也不收 —— 这是最容易出现的死锁。pointermove 一定会带 target，
 * 每次移动顺手校正一次，状态就永远跟得上。
 */
/** 上一次指针坐标：用来识别「原地补发」的 pointermove（见 onFsActivity） */
let fsLastPt = { x: -1, y: -1 }

function onFsActivity(e?: Event): void {
  if (!isFullscreen.value) return
  // 布局变化（控制条收起、画面长高）之后 Chromium 会给鼠标下方补发一次 pointermove，
  // 坐标与上次完全相同。把它当用户操作就会「收起 → 立刻唤醒」无限循环（每 2.6s 闪一下），
  // 所以坐标没变直接忽略 —— 真移动必然带新坐标。
  const pe = e as PointerEvent | undefined
  if (pe && typeof pe.clientX === 'number') {
    if (pe.clientX === fsLastPt.x && pe.clientY === fsLastPt.y) return
    fsLastPt = { x: pe.clientX, y: pe.clientY }
  }
  const t = e?.target as HTMLElement | null
  fsBarHover.value = !!t && typeof t.closest === 'function' && !!t.closest('.fs-bar')
  noteActivity()
}

/**
 * 收起/展开时画面几何要跟着变：收起后视频铺满整屏（否则画面下方留一条 72px 黑带）。
 * mpv 是原生子窗口，CSS 改了它不动，必须显式把矩形重新喂一次。
 */
watch(fsIdle, () => {
  scheduleMpvRect()
})

/** 这些状态一变，能不能收起就得重算（暂停、面板、换集、起播、报错、拖音量） */
watch([fsPaused, fsEpOpen, picking, fsReady, fsVolDragging, () => store.playerError], refreshFsIdle)

/** 媒体就绪 / 切内核：把持久化的音量推到当前内核（新实例默认是 100） */
watch(
  [fsReady, () => store.engine],
  () => {
    if (fsReady.value) applyVolume()
  },
  { immediate: true }
)

/**
 * 已缓冲区间：分片缓存下 `buffered` 可能有多段，取「覆盖当前播放位置的那一段」，
 * 都不覆盖时退回最远的一段 —— 浅色底只做「还能拖多远」的提示，不追求精确。
 */
function syncBuffered(): void {
  const v = videoEl.value
  if (!v || store.engine === 'mpv') {
    bufEnd.value = 0
    return
  }
  const b = v.buffered
  if (!b || b.length === 0) {
    bufEnd.value = 0
    return
  }
  const t = v.currentTime
  let end = 0
  for (let i = 0; i < b.length; i++) {
    if (b.start(i) <= t + 0.5 && b.end(i) >= t) {
      end = b.end(i)
      break
    }
    end = Math.max(end, b.end(i))
  }
  bufEnd.value = Number.isFinite(end) ? end : 0
}

function fsTogglePlay(): void {
  if (!fsReady.value) return
  if (store.engine === 'mpv') {
    void store.mpvTogglePause()
    return
  }
  const v = videoEl.value
  if (!v) return
  if (v.paused) {
    void v.play().catch((e: unknown) => store.pushLog('warn', `播放失败：${(e as Error).message}`))
  } else {
    v.pause()
  }
}

/**
 * 全屏下点画面 = 播放/暂停，双击 = 退出全屏。
 *
 * 全屏时原生控制条整体下线（P55），Chromium 自带的「点画面暂停」是控制条的一部分，
 * 一起没了；不补这两下，用户在全屏里点画面会觉得「点了没反应」。
 * 只挂在 <video> 上：控制条、选集面板的点击不会冒泡到它。
 */
function onVideoClick(): void {
  if (!isFullscreen.value) return
  // P58：这一下点击是用来关弹层的（pointerdown 已处理），别再顺手暂停
  if (fsSwallowClick) {
    fsSwallowClick = false
    return
  }
  reclaimVideoFocus()
  fsTogglePlay()
}

/**
 * P58：控制条之外按一下 = 关弹层。
 * 只关弹层、不动播放：画面上那一下 click 由 `fsSwallowClick` 吃掉。
 */
function onFsPointerDown(e: PointerEvent): void {
  onFsActivity(e)
  if (!fsMenu.value) return
  const t = e.target as HTMLElement | null
  // 点在「胶囊 / 弹层」里：交给它们自己的 click（可能是换另一个弹层）
  if (t?.closest('.fs-menu-wrap') || t?.closest('.fs-menu')) return
  fsMenu.value = null
  // 点在画面上（不在控制条内）才需要吞掉随后的 click
  if (!t?.closest('.fs-bar')) swallowNextVideoClick()
}

function onVideoDblClick(): void {
  if (!isFullscreen.value) return
  void toggleFullscreen()
}

/** 指针横坐标 → 目标时间（track 的整条命中区都算，不是只有 5px 的细条） */
function trackPos(e: PointerEvent): number {
  const el = e.currentTarget as HTMLElement | null
  if (!el || fsDur.value <= 0) return 0
  const r = el.getBoundingClientRect()
  const ratio = r.width > 0 ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0
  return ratio * fsDur.value
}

function onTrackDown(e: PointerEvent): void {
  if (!fsReady.value || e.button !== 0) return
  fsScrubbing.value = true
  fsScrubPos.value = trackPos(e)
  fsHoverPos.value = fsScrubPos.value
  // 指针捕获：拖出轨道甚至拖出画面也继续跟手，松手仍能在轨道上收到 pointerup
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  e.preventDefault()
}

function onTrackMove(e: PointerEvent): void {
  if (!fsReady.value) return
  const p = trackPos(e)
  fsHoverPos.value = p
  if (fsScrubbing.value) fsScrubPos.value = p
}

function onTrackLeave(): void {
  if (fsScrubbing.value) return
  fsHoverPos.value = null
}

/**
 * 松手才真正 seek：拖动过程只更新游标与气泡（零请求），
 * 否则 mpv 侧每一帧都会发一次 mpv.seek，长距离拖动会把内核拖到卡死。
 */
function onTrackUp(e: PointerEvent): void {
  if (!fsScrubbing.value) return
  const el = e.currentTarget as HTMLElement
  if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
  const t = fsScrubPos.value
  fsScrubbing.value = false
  commitSeek(t, `跳到 ${fmtDur(t)} / ${fmtDur(fsDur.value)}`)
}

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
  // P54 全屏：底部控制条是 DOM 浮层，而 mpv 是 Win32 子窗口，永远画在 DOM 之上。
  // 不把这条高度让出来，「选集 / 下一集」就会被画面整块盖住（同 P38 的叠层结论）。
  // P56 控制条收起后画面铺满，子窗口也要跟着长高，否则底部留一条黑。
  const pad = isFullscreen.value && !fsIdle.value ? FS_BAR_H : 0
  const h = Math.max(2, r.height - pad)
  void store.mpvMoveRect({ left: r.left, top: r.top, width: r.width, height: h })
  // P17：同一矩形喂给弹幕覆盖层（视口坐标，覆盖层窗口与主窗口内容区同原点）
  if (fxOverlayActive.value && overlayAvailable()) {
    overlayRect({ left: r.left, top: r.top, width: r.width, height: h })
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
  // P48 键盘快进/快退
  window.removeEventListener('keydown', onSeekKey, true)
  // P56 任意按键叫醒控制条
  window.removeEventListener('keydown', onAnyKey, true)
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  if (seekTimer !== null) window.clearTimeout(seekTimer)
  if (seekHintTimer !== null) window.clearTimeout(seekHintTimer)
  // P56 空闲收起的心跳 / 音量推送的计时器
  if (fsIdleTick !== null) window.clearInterval(fsIdleTick)
  if (volPushTimer !== null) window.clearTimeout(volPushTimer)
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
  /*
   * P48：离开播放页必须让 <video> 主动失焦。
   * v-show 只是 display:none，不解除焦点；而焦点一旦停在原生控制的 closed shadow 里，
   * 键盘事件就连 window 都到不了 —— 我们的路由判断根本没机会执行，原生会继续在
   * 首页按「1% 时长」悄悄 seek（实测 +0.2s）。blur 之后事件才回到 body。
   */
  if (!onPlayer) videoEl.value?.blur()
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

// ---- P48 键盘快进/快退（← / →） ----

/**
 * 单次按键的跳转步长（秒）。
 *
 * 取 5s 是因为它同时满足两种典型用法：40 分钟一集 ≈ 480 次步进，够细则能回到
 * 「刚才那句台词」，够粗则连按十几下就能跳过片头。按住 Shift 走 30s 大步。
 */
const KEY_SEEK_STEP = 5
const KEY_SEEK_STEP_FAR = 30
/**
 * 连击判定窗口：mpv 的 `timePos` 要 ~250ms 才回填，这段时间里读「真实播放位置」
 * 会一直落在旧值上，按住方向键就等于原地打转。窗口内的连击一律以上次落点为基准。
 */
const KEY_SEEK_CHAIN_MS = 700
/** 提交节流：键盘 auto-repeat 约 30 次/秒，不节流会把 mpv 的 RPC 打穿 */
const KEY_SEEK_THROTTLE_MS = 120
/** 提示条停留时长 */
const KEY_SEEK_HINT_MS = 1100
/** 片尾留白：clamp 到 duration 本身会立刻触发 ended，留 50ms 躲开 */
const SEEK_TAIL_GUARD = 0.05

/** 键盘跳转的即时反馈（不显示的话用户不知道一下跳了多远） */
const seekHint = ref('')
let seekHintTimer: number | null = null

/** 键盘连击的累积落点与时间戳 */
let seekAnchor: number | null = null
let seekAnchorAt = 0
/** 待提交的落点（节流窗口内累积） */
let seekQueued: number | null = null
let seekTimer: number | null = null
let seekFlushAt = 0
/** 最近一次按键的方向与步长，仅用于提示文案 */
let seekDir: 1 | -1 = 1
let seekStep = KEY_SEEK_STEP

/**
 * 当前可跳转的时间轴；null = 现在没有可跳的媒体。
 *
 * 两条内核的时长来源不同：hls 读 `<video>.duration`，mpv 读 `mpvState.duration`。
 * 直播流两条都是 0 / 非有限值，此时直接放弃 —— 直播往回跳没有意义。
 */
function seekTimeline(): { pos: number; dur: number } | null {
  if (store.engine === 'mpv') {
    const s = store.mpvState
    if (!s || !mpvHasMedia.value) return null
    const dur = s.duration ?? 0
    if (!Number.isFinite(dur) || dur <= 0) return null
    return { pos: Math.max(0, s.timePos ?? 0), dur }
  }
  const v = videoEl.value
  if (!v) return null
  const dur = v.duration
  if (!Number.isFinite(dur) || dur <= 0) return null
  return { pos: Number.isFinite(v.currentTime) ? v.currentTime : 0, dur }
}

/** 画面里的即时反馈文本（键盘快进与进度条拖动共用一套定时器） */
function showSeekText(text: string): void {
  seekHint.value = text
  if (seekHintTimer !== null) window.clearTimeout(seekHintTimer)
  seekHintTimer = window.setTimeout(() => {
    seekHint.value = ''
    seekHintTimer = null
  }, KEY_SEEK_HINT_MS)
}

function showSeekHint(pos: number, dur: number): void {
  const arrow = seekDir > 0 ? '快进' : '快退'
  showSeekText(`${arrow} ${seekStep}s · ${fmtDur(pos)} / ${fmtDur(dur)}`)
}

/** 真正落盘到播放器（两种内核各一条路径）；hintText 给进度条拖动用 */
function commitSeek(target: number, hintText?: string): void {
  const tl = seekTimeline()
  if (!tl) return
  const t = Math.min(Math.max(0, target), Math.max(0, tl.dur - SEEK_TAIL_GUARD))
  if (store.engine === 'mpv') {
    // 先喂弹幕引擎：mpv 状态空窗期里旧弹幕会继续飞
    dmLayer.value?.seek(t)
    void store.mpvSeekTo(t).catch(() => {})
  } else {
    const v = videoEl.value
    if (v) v.currentTime = t
    // hls 由 onSeeking 统一同步弹幕，这里不重复
  }
  // P55：两条内核都先把 UI 落到位 —— mpv 的状态泵有往返延迟，
  // 不先写 playPos 的话游标会在松手后回跳一下（视觉上像没拖成功）。
  playPos.value = t
  if (hintText) showSeekText(hintText)
  else showSeekHint(t, tl.dur)
}

/** 节流窗口结束时提交；窗口内只累积落点，不发请求 */
function flushSeek(): void {
  if (seekTimer !== null) {
    window.clearTimeout(seekTimer)
    seekTimer = null
  }
  const t = seekQueued
  seekQueued = null
  if (t === null) return
  seekFlushAt = performance.now()
  commitSeek(t)
}

function nudgeSeek(delta: number): void {
  const tl = seekTimeline()
  if (!tl) return
  const now = performance.now()
  const chained = seekAnchor !== null && now - seekAnchorAt < KEY_SEEK_CHAIN_MS
  const base = chained ? (seekAnchor as number) : tl.pos
  const t = Math.min(Math.max(0, base + delta), Math.max(0, tl.dur - SEEK_TAIL_GUARD))
  seekDir = delta > 0 ? 1 : -1
  seekStep = Math.abs(delta)
  seekAnchor = t
  seekAnchorAt = now
  seekQueued = t
  if (seekTimer !== null) return
  const wait = KEY_SEEK_THROTTLE_MS - (now - seekFlushAt)
  if (wait <= 0) flushSeek()
  else seekTimer = window.setTimeout(flushSeek, wait)
}

/** 焦点是否在能吃方向键的控件里（输入框 / 下拉 / 可编辑区） */
function inEditableField(el: EventTarget | null): boolean {
  const n = el as HTMLElement | null
  if (!n || typeof n.tagName !== 'string') return false
  const tag = n.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  return n.isContentEditable === true
}

function onSeekKey(e: KeyboardEvent): void {
  // 播放页是 v-show 保活的：切到首页/媒体库/设置时这个监听还在，
  // 所以「只在播放页生效」必须在这里显式判路由，不能只靠组件挂载与否。
  if (store.route !== 'player') return
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  if (e.defaultPrevented) return
  // 搜索框、弹幕输入框、选集下拉里方向键是光标/选项操作，不能抢
  if (inEditableField(e.target)) return
  // 调试抽屉是浮层且带输入框；Ctrl/Alt/Meta 组合留给系统与其它快捷键
  if (debugOpen.value || e.ctrlKey || e.metaKey || e.altKey) return
  if (!seekTimeline()) return
  /*
   * 必须 preventDefault：原生 video 时间轴在键盘焦点下还有一条「跳 1% 时长」的
   * 默认动作（P47 那条焦点环就来自同一套键盘焦点逻辑）。不拦住会变成 5s + 1% 双跳。
   */
  e.preventDefault()
  const step = e.shiftKey ? KEY_SEEK_STEP_FAR : KEY_SEEK_STEP
  nudgeSeek(e.key === 'ArrowRight' ? step : -step)
}

/*
 * 用捕获阶段：原生 video 控制条在 shadow tree 内部处理键盘（点过进度条后焦点会钻进去），
 * 冒泡阶段可能根本收不到，或在内部已经跳了 1% 才轮到我。捕获阶段先手拦下最稳。
 */
onMounted(() => window.addEventListener('keydown', onSeekKey, true))

/**
 * 任何按键都要叫醒控制条（空格暂停、Esc 退出、M 静音之后用户得看得见状态）。
 * 单独挂一个监听而不是塞进 onSeekKey：那个函数满是「方向键才处理」的早退。
 */
function onAnyKey(): void {
  if (store.route === 'player') noteActivity()
}
onMounted(() => window.addEventListener('keydown', onAnyKey, true))
// 全屏状态（进出 + Esc + 原生全屏按钮统一入口）：同步覆盖 UI，并把焦点收回 <video>
onMounted(() => document.addEventListener('fullscreenchange', onFullscreenChange))
/**
 * P56 空闲收起的心跳。用定时器自检而不是「进全屏时排一个 setTimeout」：
 * 收起条件有 6 项，任何一项在进全屏那一刻还没同步（暂停判定、换集、面板）都会让
 * 那唯一一次 setTimeout 直接不排，之后就没有任何东西来重建它 —— 表现就是「永不收起」。
 */
onMounted(() => {
  if (fsIdleTick !== null) window.clearInterval(fsIdleTick)
  fsIdleTick = window.setInterval(tickFsIdle, FS_IDLE_TICK_MS)
})

/**
 * 把焦点从原生媒体控件的 closed shadow 里抢回 <video>。
 *
 * 实测（.probe/probe48-diag.mjs / probe48-fix.mjs）：点过进度条之后焦点会钻进媒体控件的
 * closed shadow tree，此时 `document.activeElement` 仍是 VIDEO 但 `video.matches(':focus')`
 * 为 false。**这个状态下 keydown / pointerdown 全都到不了 DOM**（window 捕获计数是 0，
 * video 与 .video-wrap 上的 pointerdown 也一个都不触发），方向键就此退化成原生时间轴的
 * 「跳 1% 时长」。而 `video.focus()` 能把焦点拉回宿主（同一次实验里 match 变 true、
 * 后续 keydown 立刻恢复）。
 *
 * 因为连 pointerdown 都收不到，只能挂在这个状态下必然发生的事件上（seek / 播放暂停 /
 * 音量 / 全屏），逐个动作后纠正一次。
 */
function reclaimVideoFocus(): void {
  const v = videoEl.value
  if (!v) return
  if (document.activeElement === v && !v.matches(':focus')) v.focus({ preventScroll: true })
}

function onEngineSwitch(engine: 'hls' | 'mpv'): void {
  // P58：切内核会重载媒体，弹层里的档位/倍速状态要重读
  fsMenu.value = null
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
        <div
          ref="videoWrapEl"
          class="video-wrap force-dark"
          :class="{ 'fs-idle': fsIdle, 'fs-anim': fsAnim, 'engine-mpv': store.engine === 'mpv' }"
          @pointermove="onFsActivity"
          @pointerdown="onFsPointerDown"
          @wheel.passive="onFsActivity"
        >
          <!--
            P55：全屏时交出原生控制条（`:controls="!isFullscreen"`）。
            原生控制条是 closed shadow tree —— 既不能往里塞按钮，也读不到它的
            进度/悬停状态，所以「按钮贴进度条」只能靠自研控制条：轨道与按钮
            在同一个 flex 行里，天然共享中线和间距。窗口模式仍用原生控制条。
          -->
          <video
            ref="videoEl"
            :controls="!isFullscreen"
            controlsList="nofullscreen"
            playsinline
            @ended="onEnded"
            @timeupdate="onTimeUpdate"
            @progress="syncBuffered"
            @canplay="onCanplay"
            @durationchange="onDurationChange"
            @seeking="onSeeking"
            @waiting="markStall(true)"
            @stalled="markStall(true)"
            @playing="markStall(false)"
            @play="onVideoPlayState(false)"
            @pause="onVideoPlayState(true)"
            @volumechange="onVideoVolumeChange"
            @click="onVideoClick"
            @dblclick="onVideoDblClick"
            @pointerdown="reclaimVideoFocus"
          ></video>
          <!-- P11 弹幕层：pointer-events:none，不挡控制条 -->
          <DanmakuLayer ref="dmLayer" :video="videoEl" :duration="mediaDuration" />
          <!-- P48：← → 跳转的即时反馈（1.1s 后自动消失，不占布局、不挡控制条） -->
          <div v-if="seekHint" class="seek-hint">{{ seekHint }}</div>
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

          <!--
            P54/P55/P57 全屏覆盖 UI：只在「容器全屏」时渲染。
            画面铺满整个全屏面，控制条是压在画面下沿的一层半透明玻璃（blur + 压暗），
            所以玻璃后面真的有画面可采样；mpv 子窗口按 wrap 矩形减 --pf-fs-bar 停在上沿，
            不会被玻璃盖住。全屏期间原生控制条整体下线（video 的 controls 绑定在
            isFullscreen 上），播放/暂停、进度、静音、全屏退出全部由这条自研控制条接管 ——
            只有这样进度条与按钮才可能真正同处一行、共享中线。
            整层 pointer-events:none，只有控件自己吃事件 —— 点画面照旧是播放/暂停。
          -->
          <div v-if="isFullscreen" class="fs-ui" :class="{ idle: fsIdle }">
            <Transition name="pf-fs-pop">
              <div v-if="fsEpOpen && queue.length" class="fs-panel" role="dialog" aria-label="选集">
                <header class="fs-panel-head">
                  <h4>选集<span class="fs-panel-count">共 {{ queue.length }} 集</span></h4>
                  <button class="fs-icon-btn" title="关闭选集" @click="fsEpOpen = false">✕</button>
                </header>
                <div ref="fsEpListEl" class="fs-panel-body">
                  <button
                    v-for="(ep, i) in queue"
                    :key="ep.url"
                    class="ep-btn"
                    :class="{ active: i === queueIndex }"
                    :title="ep.name"
                    :disabled="picking >= 0"
                    @click="onPickFsEpisode(i)"
                  >
                    {{ ep.name }}
                  </button>
                </div>
                <p v-if="sideError" class="fs-panel-err">{{ sideError }}</p>
              </div>
            </Transition>

            <!--
              P55/P58 控制条：**一条**组件，不是「一排按钮 + 别处的进度条」。
              结构 = 上一行文字信息 + 下一行控制行：
                [⏮][▶][⏭] [00:12 / 01:30] [====轨道====] [1.0×][1080P] [🔊 ▬▬] [选集][退出全屏]
              按钮是轨道的**兄弟节点**（紧贴其末端），不是绝对定位悬浮在轨道上：
              整行一个 flex、一个 align-items:center，轨道的可视细条垂直居中于
              30px 命中区，按钮也是 30px —— 两者的中线天然重合，不需要任何
              top/translate 魔法，也不会因为字号或换行而错位。
            -->
            <div class="fs-bar">
              <div class="fs-bar-head">
                <span class="fs-bar-title" :title="playCtx?.title || ''">{{ playCtx?.title || '正在播放' }}</span>
                <span v-if="queue.length" class="fs-bar-ep">
                  第 {{ queueIndex + 1 }}/{{ queue.length }} 集 · {{ currentEpName }}
                </span>
                <span v-else class="fs-bar-ep">手动直链 / 单集播放</span>
                <span v-if="picking >= 0" class="fs-bar-busy">
                  <span class="spin" aria-hidden="true"></span>正在切换第 {{ picking + 1 }} 集…
                </span>
              </div>

              <div class="fs-bar-row">
                <!--
                  P58 传输组：三个**纯图标**按钮成组（组内 2px、组外一行 gap），
                  每个都带 data-tip 悬浮提示 —— 图标省宽度，提示补语义。
                  上一集/下一集在首尾集时 disabled（提示照常显示，说明为什么点不动）。
                -->
                <div class="fs-transport">
                  <button
                    class="fs-icon tip-start"
                    :disabled="queueIndex <= 0 || picking >= 0"
                    data-tip="上一集"
                    aria-label="上一集"
                    @click="onFsPrev"
                  >
                    <span class="ico-skip prev" aria-hidden="true"></span>
                  </button>
                  <button
                    class="fs-icon play"
                    :disabled="!fsReady"
                    :data-tip="fsPaused ? '播放（空格）' : '暂停（空格）'"
                    :aria-label="fsPaused ? '播放' : '暂停'"
                    @click="fsTogglePlay"
                  >
                    <span :class="fsPaused ? 'ico-play' : 'ico-pause'" aria-hidden="true"></span>
                  </button>
                  <button
                    class="fs-icon"
                    :disabled="!catalog.nextEpisode || picking >= 0"
                    :data-tip="catalog.nextEpisode ? `下一集 · ${catalog.nextEpisode.name}` : '已是最后一集'"
                    aria-label="下一集"
                    @click="onFsNext"
                  >
                    <span class="ico-skip next" aria-hidden="true"></span>
                  </button>
                </div>
                <span class="fs-time">{{ fsTimeLabel }}</span>
                <div
                  class="fs-track"
                  :class="{ scrubbing: fsScrubbing, idle: !fsReady }"
                  role="slider"
                  aria-label="播放进度"
                  :aria-valuemin="0"
                  :aria-valuemax="Math.round(fsDur)"
                  :aria-valuenow="Math.round(fsShownPos)"
                  :aria-disabled="!fsReady"
                  @pointerdown="onTrackDown"
                  @pointermove="onTrackMove"
                  @pointerup="onTrackUp"
                  @pointercancel="onTrackUp"
                  @pointerleave="onTrackLeave"
                >
                  <div class="fs-rail">
                    <div class="fs-rail-buf" :style="{ width: fsBufPct }"></div>
                    <div class="fs-rail-fill" :style="{ width: fsPct }"></div>
                    <div class="fs-rail-knob" :style="{ left: fsPct }"></div>
                  </div>
                  <span v-if="fsTipLabel" class="fs-track-tip" :style="{ left: fsTipPct }">{{ fsTipLabel }}</span>
                </div>

                <!--
                  P58 倍速 / 清晰度：两个「值胶囊」。菜单型控件（点开选一档）而不是
                  滑杆 —— 档位是离散且互斥的，用列表一眼看全；宽度固定只随文字变化，
                  不会因为「1.0× → 1.25×」把右边的东西推走（tabular-nums）。
                -->
                <div class="fs-menu-wrap">
                  <button
                    class="fs-chip"
                    :class="{ open: fsMenu === 'speed' }"
                    data-tip="播放速度"
                    aria-label="播放速度"
                    :aria-expanded="fsMenu === 'speed'"
                    @click="toggleFsMenu('speed')"
                  >
                    <svg class="ico-chip" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                      <path
                        d="M2.6 11.4a5.6 5.6 0 119.8 0"
                        stroke="currentColor"
                        stroke-width="1.4"
                        fill="none"
                        stroke-linecap="round"
                      />
                      <path d="M8 11.4 10.7 6.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
                    </svg>
                    <b>{{ fsRateLabel }}</b>
                  </button>
                  <Transition name="pf-fs-pop">
                    <div v-if="fsMenu === 'speed'" class="fs-menu" role="menu" aria-label="播放速度">
                      <p class="fs-menu-head">播放速度</p>
                      <button
                        v-for="r in RATES"
                        :key="r"
                        class="fs-menu-item"
                        :class="{ active: r === store.playbackRate }"
                        role="menuitemradio"
                        :aria-checked="r === store.playbackRate"
                        @click="pickFsRate(r)"
                      >
                        <span>{{ r === 1 ? '1.0× 正常' : `${r}×` }}</span>
                        <span v-if="r === store.playbackRate" class="fs-menu-check" aria-hidden="true">✓</span>
                      </button>
                    </div>
                  </Transition>
                </div>
                <div class="fs-menu-wrap">
                  <button
                    class="fs-chip"
                    :class="{ open: fsMenu === 'quality' }"
                    data-tip="清晰度"
                    aria-label="清晰度"
                    :aria-expanded="fsMenu === 'quality'"
                    @click="toggleFsMenu('quality')"
                  >
                    <svg class="ico-chip" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                      <rect
                        x="2"
                        y="3.4"
                        width="12"
                        height="7.6"
                        rx="1.3"
                        stroke="currentColor"
                        stroke-width="1.3"
                        fill="none"
                      />
                      <path d="M6 13.6h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
                    </svg>
                    <b>{{ fsQualityLabel }}</b>
                  </button>
                  <Transition name="pf-fs-pop">
                    <div v-if="fsMenu === 'quality'" class="fs-menu" role="menu" aria-label="清晰度">
                      <p class="fs-menu-head">清晰度</p>
                      <button
                        v-for="opt in fsQualityOpts"
                        :key="opt.key"
                        class="fs-menu-item"
                        :class="{ active: opt.active }"
                        role="menuitemradio"
                        :aria-checked="!!opt.active"
                        :disabled="opt.disabled"
                        @click="opt.run()"
                      >
                        <span>{{ opt.label }}</span>
                        <span class="fs-menu-meta">{{ opt.meta }}</span>
                      </button>
                      <p class="fs-menu-foot" title="非最高档直连源站，不经过分片缓存">切档需重载并续播</p>
                    </div>
                  </Transition>
                </div>
                <!--
                  P56 音量组：喇叭按钮 + 滑杆，**常显**而不是 hover 才展开 ——
                  触屏没有 hover，常显是唯一在鼠标/触控/手写笔上都成立的做法。
                  滑杆与进度条同一套视觉（同一中线、同一轨道粗细），只是更窄。
                -->
                <div class="fs-vol">
                  <button
                    class="fs-icon vol"
                    :class="{ active: fsMuted || fsVolume === 0 }"
                    :title="fsMuted ? '取消静音' : '静音'"
                    :aria-label="fsMuted ? '取消静音' : '静音'"
                    :aria-pressed="fsMuted"
                    @click="fsToggleMute"
                  >
                    <svg class="ico-vol" viewBox="0 0 18 16" width="15" height="14" aria-hidden="true">
                      <path d="M2 6h2.6L8 3.1v9.8L4.6 10H2z" fill="currentColor" />
                      <template v-if="fsMuted || fsVolume === 0">
                        <path d="M11.4 5.4l5 5.2M16.4 5.4l-5 5.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" />
                      </template>
                      <template v-else>
                        <path d="M10.6 4.6a4.4 4.4 0 010 6.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none" />
                        <path
                          v-if="fsVolume >= 45"
                          d="M12.9 2.6a7.3 7.3 0 010 10.8"
                          stroke="currentColor"
                          stroke-width="1.4"
                          stroke-linecap="round"
                          fill="none"
                        />
                      </template>
                    </svg>
                  </button>
                  <div
                    class="fs-vol-track"
                    :class="{ scrubbing: fsVolDragging, muted: fsMuted }"
                    role="slider"
                    aria-label="音量"
                    :aria-valuemin="0"
                    :aria-valuemax="100"
                    :aria-valuenow="fsMuted ? 0 : fsVolume"
                    :aria-valuetext="fsMuted ? '已静音' : fsVolume + '%'"
                    :title="`音量 ${fsMuted ? '已静音' : fsVolume + '%'}`"
                    @pointerdown="onVolDown"
                    @pointermove="onVolMove"
                    @pointerup="onVolUp"
                    @pointercancel="onVolUp"
                  >
                    <div class="fs-vol-rail">
                      <div class="fs-vol-fill" :style="{ width: fsVolFillPct + '%' }"></div>
                      <div class="fs-vol-knob" :style="{ left: fsVolFillPct + '%' }"></div>
                    </div>
                    <!-- 百分比气泡：悬停或拖动时淡入（纯 CSS，不占布局、不依赖 JS 计时器） -->
                    <span class="fs-track-tip fs-vol-tip">{{ fsMuted ? '已静音' : `${fsVolume}%` }}</span>
                  </div>
                </div>
                <!--
                  P58：右侧只留「面板 / 退出」两个动作按钮 —— 「下一集」已经在左侧
                  传输组里（图标 + 提示），留一份文字按钮就是同一件事两个入口。
                  窄屏（≤1180px）下两个按钮收成图标，靠 data-tip 说明功能。
                -->
                <div class="fs-bar-acts">
                  <button
                    class="fs-act"
                    :class="{ active: fsEpOpen }"
                    :disabled="!queue.length"
                    :aria-expanded="fsEpOpen"
                    data-tip="选集"
                    aria-label="选集"
                    @click="toggleFsPanel"
                  >
                    <svg class="ico-act" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                      <path
                        d="M2.5 4.2h11M2.5 8h11M2.5 11.8h7"
                        stroke="currentColor"
                        stroke-width="1.4"
                        stroke-linecap="round"
                        fill="none"
                      />
                    </svg>
                    <span class="fs-act-label">选集</span>
                    <span v-if="queue.length" class="fs-act-num">{{ queueIndex + 1 }}/{{ queue.length }}</span>
                  </button>
                  <button
                    class="fs-act tip-end"
                    data-tip="退出全屏（Esc）"
                    aria-label="退出全屏"
                    @click="toggleFullscreen"
                  >
                    <svg class="ico-act" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                      <path
                        d="M6 2.6H3.4a.8.8 0 00-.8.8V6M10 2.6h2.6a.8.8 0 01.8.8V6M6 13.4H3.4a.8.8 0 01-.8-.8V10M10 13.4h2.6a.8.8 0 00.8-.8V10"
                        stroke="currentColor"
                        stroke-width="1.4"
                        stroke-linecap="round"
                        fill="none"
                      />
                    </svg>
                    <span class="fs-act-label">退出全屏</span>
                  </button>
                </div>
              </div>
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
          <!-- P54 全屏入口：走容器全屏（原生控制条的按钮已摘掉），全屏内才有选集/下一集 -->
          <button
            class="engine-btn"
            :class="{ active: fsAny }"
            :title="fsAny ? '退出全屏（Esc）' : '全屏播放：画面内提供选集与下一集'"
            @click="toggleFullscreen"
          >
            {{ fsAny ? '退出全屏' : '全屏' }}
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
          <button class="btn sm" @click="store.goDiscover()">去发现页</button>
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
/*
 * P54：原生控制条里的「全屏」按钮必须摘掉。
 *
 * 它走的是**元素全屏**（只把 <video> 推进 top layer），而我们的全屏 UI（选集 /
 * 下一集 / 弹幕）都是 video 的兄弟节点 —— 一旦点了它，这些全被遮掉，等于退回旧行为。
 * `controlsList="nofullscreen"` 在这版 Chromium 上不生效（实测按钮仍在），
 * 只能直接隐藏这个伪元素；隐藏后全屏入口只保留控制条上的「全屏」按钮。
 */
.video-wrap :deep(video::-webkit-media-controls-fullscreen-button) {
  display: none;
}
/*
 * P48：键盘跳转提示。
 * 只做视觉反馈，pointer-events 关掉，绝不挡住控制条；也不给 .video-wrap 加裁剪
 * （P38：含 video 的容器一旦 overflow:hidden 会黑屏）。
 */
.seek-hint {
  position: absolute;
  left: 50%;
  bottom: 64px;
  transform: translateX(-50%);
  padding: 5px 12px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.68);
  color: #fff;
  font-size: var(--fs-sm);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.2px;
  white-space: nowrap;
  pointer-events: none;
  z-index: 6;
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

/* ==========================================================================
   P54 容器全屏：画面内「选集 / 下一集」
   --------------------------------------------------------------------------
   全屏元素是 .video-wrap 本身，不是 <video>：只有容器全屏才能把弹幕层、提示层
   与这套按钮一起带进全屏（元素全屏只渲染 video，兄弟节点全部消失）。

   布局：画面铺满整个全屏面，控制条 --pf-fs-bar 压在下沿之上（P57 起是半透明玻璃）。
   --------------------------------------------------------------------------
   P57 之前画面给控制条让出 72px，条子坐在一条纯黑带上；改成玻璃后那条黑带就是
   唯一的坏处 —— `backdrop-filter` 采样到的是 wrap 的纯黑，模糊等于没做。所以画面
   恢复满幅，条子压在画面上：玻璃后面必须有真画面，半透明与模糊才有意义。
   原生控制条在全屏期整体下线（见模板的 `:controls="!isFullscreen"`），不再需要
   「贴着视频底边让位」；mpv 是 Win32 子窗口，矩形按 wrap 矩形减 FS_BAR_H 算
   （syncMpvRect），天然停在条子上沿，不受这里影响。
   ========================================================================== */
.video-wrap:fullscreen {
  --pf-fs-bar: 72px; /* 与脚本里的 FS_BAR_H 保持一致 */
  width: 100vw;
  height: 100vh;
  aspect-ratio: auto;
  /* P38 红线：这里仍然不能出现 border-radius / overflow:hidden */
  border-radius: 0;
  overflow: visible;
}
.video-wrap:fullscreen::backdrop {
  background: #000;
}
/* object-fit: contain：极宽/极窄屏下画面按比例居中，两侧留黑而不是被拉变形 */
.video-wrap:fullscreen video {
  /* P57：满幅。控制条改成浮层后不再为它让高度 —— 让了它就只剩纯黑可采样 */
  height: 100%;
  object-fit: contain;
}
/* 收起时连指针一起藏：全屏观影时鼠标停在画面上很碍眼 */
.video-wrap:fullscreen.fs-idle {
  cursor: none;
}
/*
 * `fs-anim` = 「进全屏后 120ms，布局已经落定」。在那之前不许控制条动效：
 * 全屏刚建立时 wrap 会从窗口尺寸跳到全屏尺寸，任何 transform/opacity 过渡都
 * 会跟着这段跳变跑一遍，看起来像条子自己弹了一下。
 */
.video-wrap:fullscreen:not(.fs-anim) .fs-bar {
  transition: none;
}
@media (prefers-reduced-motion: reduce) {
  .fs-bar {
    transition: none;
  }
}
/*
 * 画面内的几层浮层。
 * P57 起画面满幅，控制条是压在画面上的玻璃 —— 所以：
 *   * 居中提示按**整个**画面居中（不再减 72px，减了会整体偏上）；
 *   * 弹幕与快进提示仍然让开底部这一条，否则最下面一两条轨道、提示文字
 *     会躲进玻璃后面（透过玻璃看不清，等于白排）。
 */
.video-wrap:fullscreen :deep(.danmaku-layer) {
  /* 弹幕层让开底部条：玻璃后面那 72px 弹幕既看不清也读不完 */
  bottom: var(--pf-fs-bar);
}
/* 控制条收起后画面铺满，弹幕也要跟着铺满，否则最下面 72px 永远没有弹幕。
   **这里不加过渡**：canvas 的 ResizeObserver 每帧都会重建画布与轨道布局，
   给 72px 的位移做 12 帧动画 = 12 次全画布重分配，弹幕会明显抽一下。 */
.video-wrap:fullscreen.fs-idle :deep(.danmaku-layer) {
  bottom: 0;
}
.video-wrap:fullscreen .seek-hint {
  /* 原生控制条已交给自研控制条（P55），提示只需要避开底部这一条 */
  bottom: calc(var(--pf-fs-bar) + 20px);
}
/* 居中浮层（.placeholder / .stall-hint / .video-error）不再需要全屏专用偏移：
   P57 画面恢复满幅后它们自带的 `inset:0` / `top:50%` 就是正确居中。
   旧版本这里有一条 `top: calc((100% - 72px) / 2)`，是给「画面让出 72px」补偿的。 */

/* 覆盖层：整层不吃事件，只有按钮自己吃（点画面照旧是播放/暂停） */
.fs-ui {
  position: absolute;
  inset: 0;
  z-index: 8; /* 高于弹幕(2/3)与提示(6)；原生控制条在 shadow 里，永远更靠上 */
  pointer-events: none;
}
.fs-ui > * {
  pointer-events: auto;
}

/* ==========================================================================
   P55 控制条：进度条与按钮的「一体」是怎么落地的
   --------------------------------------------------------------------------
   定位方式 = **紧贴轨道末端、同处一行**（不是嵌入轨道内部，也不是悬浮其上）：
     .fs-bar-row  一个 flex 行，align-items:center
       [播放] [时间] [.fs-track flex:1] [静音] [.fs-bar-acts 选集/下一集/退出全屏]
   * 轨道可视高度只有 5px，但它坐在 30px 高的命中区里垂直居中；
     按钮同样是 30px 高、同一个 align-items:center —— 所以「轨道中线 = 按钮中线」
     是布局算出来的，不靠 top/margin 硬凑，字号或文案变化都不会错位。
   * 按钮组与轨道之间只有一行 gap（12px），没有分隔线、没有第二个背景层，
     视觉上属于同一根控制条；hover 底色也来自同一套 token（--panel-3）。
   * 轨道用 flex:1 吃掉所有剩余宽度：窗口/全屏宽度变化时按钮不挪位置，
     只有轨道伸缩，时间文本用 tabular-nums + 固定宽度防止数字跳动推挤轨道。
   ========================================================================== */

/* ==========================================================================
   P57 控制条玻璃化：半透明的「配方」是怎么定的
   --------------------------------------------------------------------------
   条子压在全屏画面下沿（P54 起的 72px 槽位改成浮层，见 .video-wrap:fullscreen）。
   背后是**任意画面**，所以可读性不能靠「画面一般都很暗」，只能靠三层叠加：

     ① 背景模糊  blur(22px)     —— 抹掉画面细节。细节是文字可读性的头号杀手：
                                  没有它，一条电线/一行字幕正好穿过「00:12」就废了。
     ② 压暗      brightness(.55) —— 把背后的亮部整体压到中低亮度。白场画面下
                                  纯半透明底只剩 3.6:1，压暗后才够 WCAG AA。
     ③ 半透明底  上 30% → 下 55% —— 上沿透一点（画面透得上来，条子不切断构图），
                                  下沿实一点（控件与文字都坐在这一侧）。
   saturate(150%) 是给「玻璃」这一步补的饱和度：压暗会顺手把颜色洗灰，
   补回来才像有色玻璃而不是一层灰纱。

   注意：**不能改回不透明底**。玻璃一旦不透明，backdrop-filter 就是纯开销；
   而要真的看得见模糊，画面必须铺到条子底下 —— 这两件事是一组，改一个必须改另一个。
   ========================================================================== */
.fs-bar {
  /* 玻璃上的两级墨色。
     全局 --text-dim(#9aa5b8) 是为「恒暗面板」定的；压在任意画面上（且只压暗到
     brightness .55）时对比度会掉到 2.3:1，图标和秒数就看不清了，所以条内单独抬一档。
     shadow 是最后一道保险：遇到极端亮部（白场、雪景）时靠它把字形从背景里拉出来。 */
  --fs-ink: color-mix(in srgb, var(--text) 94%, transparent);
  --fs-ink-dim: color-mix(in srgb, var(--text) 80%, transparent);
  --fs-ink-faint: color-mix(in srgb, var(--text) 62%, transparent);
  --fs-ink-shadow: 0 1px 2px rgb(0 0 0 / 0.55);
  --fs-hover-wash: color-mix(in srgb, #fff 12%, transparent);
  --fs-line-soft: color-mix(in srgb, #fff 16%, transparent);
  /*
   * 强调色也要在条内改口。浅色主题的 --accent-ink 是深藏青（给白底用的），
   * 落在压暗后的玻璃上直接消失；这里统一换成「亮蓝字 + 更实一点的蓝洗底」，
   * 弹层里选中项（倍速/清晰度当前档）在两种主题下都能读。
   */
  --accent-soft: color-mix(in srgb, var(--accent) 24%, transparent);
  --accent-ink: color-mix(in srgb, #d3e0ff 94%, transparent);
  /*
   * 弹层 / 悬浮提示统一往上抬「控制行上沿 → 条子上沿 + 8px」这段距离。
   * 39 = 标题行 16 + 行距 4 + 垂直居中的上留白 11 + 8。小于这个数，弹层底边会
   * 切进条子、把标题行盖掉一半；提示则会压在标题文字上（看起来像错位）。
   * ≤900px 时标题行隐藏、控制行上移到 21，这个值跟着改 29。
   */
  --fs-pop-lift: 39px;
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  /* 高度锁死在 --pf-fs-bar：mpv 子窗口矩形按它扣减、弹幕层按它让位，内容再多也不许变高 */
  height: var(--pf-fs-bar, 72px);
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  padding: 0 var(--sp-5);
  /* 玻璃本体（底色 + backdrop-filter + 内高光）挂在 ::before 上，原因见下 */
  border-top: 1px solid color-mix(in srgb, #fff 14%, transparent);
  /* P56：收起时整条滑到视口下方 + 淡出。只动 transform/opacity，不触发重排，
     所以「滑出」不会带动画面抖动；画面本身不再跟着变高度（P57 满幅） */
  transition: transform 200ms var(--ease), opacity 160ms var(--ease);
  will-change: transform;
}
/*
 * P58：玻璃从 .fs-bar 本身挪到 ::before。
 *
 * 为什么非挪不可：带 `backdrop-filter` 的元素会为**后代**建立一个 backdrop root。
 * 玻璃挂在 .fs-bar 上时，条内的速度/清晰度弹层就成了它的后代 —— 弹层的
 * `backdrop-filter` 只能采样到「条的背景」，采不到画面，于是弹层退化成一块实色板
 * （截图里能直接看出来：条子透出画面颜色，弹层是死的）。
 * 挪到伪元素上：伪元素不是弹层的祖先，弹层的 backdrop root 回到文档根，
 * 于是它也真的能磨到背后的画面。条的观感、遮罩强度、收起动效都不变。
 */
.fs-bar::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, #070a10 30%, transparent) 0%,
    color-mix(in srgb, #070a10 55%, transparent) 100%
  );
  -webkit-backdrop-filter: blur(22px) saturate(150%) brightness(0.55);
  backdrop-filter: blur(22px) saturate(150%) brightness(0.55);
  /* 上沿内高光：玻璃的「厚度」。只有亮线会像贴了条白边 */
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 6%, transparent);
}
/* 兜底：不支持背景模糊时，半透明底撑不住可读性，退回接近实底 */
@supports not ((backdrop-filter: blur(4px)) or (-webkit-backdrop-filter: blur(4px))) {
  .fs-bar::before {
    background: rgb(9 12 18 / 0.94);
  }
}
.fs-ui.idle .fs-bar {
  transform: translateY(100%);
  opacity: 0;
  /* 藏起来就别再吃点击：否则画面底部的点击会被这条透明条吞掉 */
  pointer-events: none;
}
.fs-bar-head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  min-width: 0;
  /* 文字行比控制行矮，靠行高而不是 flex 撑开，避免控制行的中线被顶偏 */
  height: 16px;
  line-height: 16px;
}
.fs-bar-title {
  max-width: 34ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-xs);
  color: var(--fs-ink);
  text-shadow: var(--fs-ink-shadow);
}
.fs-bar-ep {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-2xs);
  color: var(--fs-ink-faint);
  font-variant-numeric: tabular-nums;
  text-shadow: var(--fs-ink-shadow);
}
.fs-bar-busy {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: var(--sp-2);
  font-size: var(--fs-2xs);
  color: var(--info);
}
.fs-bar-busy .spin {
  width: 11px;
  height: 11px;
  border-width: 2px;
}

/* ---- 控制行：轨道与按钮共享同一条中线 ---- */
.fs-bar-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-width: 0;
}
/*
 * P58 传输组：上一集 / 播放暂停 / 下一集。
 * 组内 2px（三个图标属于同一件事，挤在一起才读成一个整体），组外仍是一行 gap。
 * 三个键都是 30px 见方 —— 与轨道命中区、胶囊、.fs-act 同高，中线由
 * align-items:center 算出来，不靠任何 margin 硬凑。
 */
.fs-transport {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
}
.fs-transport .fs-icon {
  min-width: 28px;
  padding: 0 6px;
}
/* 行内图标按钮（播放 / 静音）：30px 见方，与轨道命中区、.fs-act 同高 */
.fs-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  height: 30px;
  /* 全局 button 有 min-height:34px，不显式清掉 height 就压不下来，
     轨道命中区 30px 与按钮 34px 虽然中线对齐，但上下沿会参差 */
  min-height: 0;
  min-width: 30px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--fs-ink-dim);
  font-family: inherit;
  font-size: var(--fs-xs);
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease),
    border-color var(--t-fast) var(--ease);
}
/* hover 用半透明白洗而不是 --panel-3：玻璃上的实心块会像贴了张纸 */
.fs-icon:hover:not(:disabled) {
  background: var(--fs-hover-wash);
  border-color: var(--fs-line-soft);
  color: var(--fs-ink);
}
.fs-icon.active {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.fs-icon:disabled {
  opacity: 0.4;
  cursor: default;
}
/* CSS 画的播放/暂停图标：不依赖字体，暗色下也锐利 */
.ico-play {
  width: 0;
  height: 0;
  border-left: 10px solid currentColor;
  border-top: 6px solid transparent;
  border-bottom: 6px solid transparent;
  /* 三角形视觉重心偏左，右移 1px 才和暂停两竖线居中对齐 */
  margin-left: 2px;
}
.ico-pause {
  width: 9px;
  height: 12px;
  border-left: 3px solid currentColor;
  border-right: 3px solid currentColor;
}
/* 上一集 / 下一集：三角 + 竖线（`|◀` / `▶|`），与播放三角同一套画法 */
.ico-skip {
  position: relative;
  display: block;
  width: 13px;
  height: 12px;
}
.ico-skip::before {
  content: '';
  position: absolute;
  top: 50%;
  width: 0;
  height: 0;
  border-top: 5px solid transparent;
  border-bottom: 5px solid transparent;
  translate: 0 -50%;
}
.ico-skip::after {
  content: '';
  position: absolute;
  top: 50%;
  width: 2px;
  height: 10px;
  border-radius: 1px;
  background: currentColor;
  translate: 0 -50%;
}
.ico-skip.prev::before {
  left: 2px;
  border-right: 7px solid currentColor;
}
.ico-skip.prev::after {
  left: 1px;
}
.ico-skip.next::before {
  right: 2px;
  border-left: 7px solid currentColor;
}
.ico-skip.next::after {
  right: 1px;
}
/* 时间：mono + tabular-nums 本身就是等宽数字，不额外定宽 —— 定宽会让
   文本在框内左对齐，右端空出一截，看起来像时间与轨道之间多了一个间距 */
.fs-time {
  flex: none;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: var(--fs-2xs);
  font-variant-numeric: tabular-nums;
  color: var(--fs-ink-dim);
  white-space: nowrap;
  text-shadow: var(--fs-ink-shadow);
}

/* ---- 轨道 ---- */
.fs-track {
  position: relative;
  flex: 1 1 auto;
  /* 命中区 30px，可视细条只有 5px —— 按细条算点击区域会「点不中」 */
  height: 30px;
  min-width: 64px;
  display: flex;
  align-items: center;
  cursor: pointer;
  touch-action: none;
}
.fs-track.idle {
  cursor: default;
  opacity: 0.5;
}
.fs-rail {
  position: relative;
  width: 100%;
  height: 5px;
  border-radius: var(--r-pill);
  /* 26% 而不是 22%：玻璃背后可能是亮画面，未播部分是「轨道本体」，
     太淡就直接消失在背景里，看不出这条能拖 */
  background: color-mix(in srgb, var(--text) 26%, transparent);
  transition: height var(--t-fast) var(--ease);
}
.fs-track:hover .fs-rail,
.fs-track.scrubbing .fs-rail {
  height: 7px;
}
/* 已缓冲：比轨道亮一档，比已播暗 —— 三层信息叠在同一条轨道上 */
.fs-rail-buf {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: inherit;
  background: color-mix(in srgb, var(--text) 34%, transparent);
}
.fs-rail-fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: inherit;
  background: var(--accent);
}
.fs-rail-knob {
  position: absolute;
  top: 50%;
  /* 垂直居中用独立的 translate（transform 已被 scale 占着，塞不进去）；
     缺这一句圆点的「顶边」会落在轨道中线上，整个点下移半个直径 */
  translate: 0 -50%;
  width: 12px;
  height: 12px;
  margin-left: -6px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 1px color-mix(in srgb, #000 35%, transparent);
  transform: scale(0.72);
  transition: transform var(--t-fast) var(--ease);
  pointer-events: none;
}
.fs-track:hover .fs-rail-knob,
.fs-track.scrubbing .fs-rail-knob {
  transform: scale(1);
}
/* 悬停/拖动气泡：贴在轨道正上方，不参与布局 */
.fs-track-tip {
  position: absolute;
  bottom: 26px;
  transform: translateX(-50%);
  padding: 2px 6px;
  border: 1px solid var(--line-2);
  border-radius: var(--r-sm);
  background: var(--panel-3);
  color: var(--text);
  font-size: var(--fs-2xs);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  pointer-events: none;
}

/* ---- P56 音量组：喇叭按钮 + 常显滑杆 ----
   常显而不是 hover 展开：触屏没有 hover，常显在鼠标/触控/手写笔上行为一致。
   填充用中性色（--text-dim）而不是强调色，强调色留给进度，一眼能分开两条轨道。 */
.fs-vol {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex: none;
}
.ico-vol {
  display: block;
}
.fs-vol-track {
  position: relative;
  flex: none;
  width: 72px;
  /* 与轨道、按钮同一个 30px 命中高度 → 中线由 align-items:center 对齐 */
  height: 30px;
  display: flex;
  align-items: center;
  cursor: pointer;
  touch-action: none;
}
.fs-vol-rail {
  position: relative;
  width: 100%;
  height: 5px;
  border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--text) 26%, transparent);
  transition: height var(--t-fast) var(--ease);
}
.fs-vol-track:hover .fs-vol-rail,
.fs-vol-track.scrubbing .fs-vol-rail {
  height: 7px;
}
.fs-vol-fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: inherit;
  background: var(--fs-ink-dim);
}
.fs-vol-track.muted .fs-vol-fill {
  background: var(--fs-ink-faint);
}
.fs-vol-knob {
  position: absolute;
  top: 50%;
  /* 同 .fs-rail-knob：不带 translate 就会比轨道低半个直径 */
  translate: 0 -50%;
  width: 10px;
  height: 10px;
  margin-left: -5px;
  border-radius: 50%;
  background: var(--text);
  box-shadow: 0 0 0 1px color-mix(in srgb, #000 35%, transparent);
  transform: scale(0.7);
  transition: transform var(--t-fast) var(--ease);
  pointer-events: none;
}
.fs-vol-track:hover .fs-vol-knob,
.fs-vol-track.scrubbing .fs-vol-knob {
  transform: scale(1);
}
/* 百分比气泡：常驻 DOM、只切 opacity —— 不参与布局，也不会因插入/移除让轨道抖一下 */
.fs-vol-tip {
  left: 50%;
  opacity: 0;
  transition: opacity var(--t-fast) var(--ease);
}
.fs-vol-track:hover .fs-vol-tip,
.fs-vol-track.scrubbing .fs-vol-tip {
  opacity: 1;
}

.fs-bar-acts {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex: none;
}

/* ==========================================================================
   P58 倍速 / 清晰度：值胶囊 + 玻璃弹层
   --------------------------------------------------------------------------
   用「胶囊 + 列表」而不是滑杆/下拉：档位是离散且互斥的，列表一眼看全所有选项，
   点一下就落；原生 <select> 在全屏 top-layer 里的下拉列表由系统绘制，
   配色与这条玻璃完全对不上，所以自绘。
   胶囊宽度由内容决定（tabular-nums 保证「1.25×」不会把右边挤走）。
   ========================================================================== */
.fs-menu-wrap {
  position: relative;
  display: flex;
  flex: none;
  /* 弹层停在**控制条上沿**而不是胶囊上沿 —— 具体留多少由 .fs-bar 的
     --fs-pop-lift 统一给（提示气泡用的是同一个值，两者才不会一高一低）。 */
}
.fs-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  height: 30px;
  min-height: 0;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--fs-ink-dim);
  font-family: inherit;
  font-size: var(--fs-2xs);
  line-height: 1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  text-shadow: var(--fs-ink-shadow);
  cursor: pointer;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease),
    border-color var(--t-fast) var(--ease);
}
.fs-chip b {
  font-weight: 500;
}
.fs-chip:hover,
.fs-chip.open {
  background: var(--fs-hover-wash);
  border-color: var(--fs-line-soft);
  color: var(--fs-ink);
}
.fs-chip.open {
  border-color: color-mix(in srgb, #fff 26%, transparent);
}
.ico-chip {
  display: block;
  opacity: 0.85;
}
/* 弹层：贴着胶囊上沿展开，与选集面板同一套玻璃（同圆角、同模糊、同阴影） */
.fs-menu {
  position: absolute;
  right: 0;
  bottom: calc(100% + var(--fs-pop-lift, 39px));
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 152px;
  max-width: 236px;
  max-height: min(46vh, 360px);
  overflow: auto;
  padding: 6px;
  border: 1px solid color-mix(in srgb, #fff 14%, transparent);
  border-radius: var(--r-lg);
  /* 弹层浮在画面上，磨的是**画面**（玻璃本体已挪到 .fs-bar::before，弹层不再被
     条的 backdrop root 框住）。透明度比条子略实：弹层里是密集小字，需要更稳的底；
     但也不许再往上加 —— 加到 80% 以上玻璃就变回一块实色板，和条子脱节。 */
  background: color-mix(in srgb, #090c13 64%, transparent);
  -webkit-backdrop-filter: blur(18px) saturate(150%) brightness(0.62);
  backdrop-filter: blur(18px) saturate(150%) brightness(0.62);
  box-shadow: var(--shadow-3);
}
.fs-menu-head {
  padding: 2px 8px 4px;
  font-size: var(--fs-2xs);
  color: var(--fs-ink-faint);
}
.fs-menu-foot {
  padding: 4px 8px 2px;
  font-size: var(--fs-2xs);
  line-height: 1.45;
  /* 脚注是「会用得上」的说明（不是装饰），比标题行再亮一档；
     faint 在深玻璃上只有 ~2.6:1，一行小字会读不出来 */
  color: var(--fs-ink-dim);
}
.fs-menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 28px;
  min-height: 0;
  padding: 0 8px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--fs-ink-dim);
  font-family: inherit;
  font-size: var(--fs-2xs);
  font-variant-numeric: tabular-nums;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.fs-menu-item:hover:not(:disabled) {
  background: color-mix(in srgb, #fff 10%, transparent);
  color: var(--fs-ink);
}
.fs-menu-item.active {
  background: var(--accent-soft);
  /* 选中项的文字用**白墨**而不是强调色：强调色和它的洗底同色相，压在一起时
     字形反而比旁边未选中的行更糊（实测在同一块玻璃上差一档亮度）。
     选中这件事由「底色」+ 右侧「当前」/✓ 两个信号表达，字要保白。 */
  color: var(--fs-ink);
}
.fs-menu-item:disabled {
  color: var(--fs-ink-faint);
  cursor: default;
}
/*
 * 「当前档且不可点」（源只有一档）是常态，不是异常态：整行被 :disabled 洗灰后
 * 会读成「这一项坏了」，而它恰恰是要被看清的那一行 —— 这里把墨色还回去，
 * 用 cursor: default + 无 hover 表达「点不动」。
 */
.fs-menu-item.active:disabled {
  color: var(--fs-ink);
}
.fs-menu-meta {
  color: var(--fs-ink-faint);
  font-size: var(--fs-2xs);
}
.fs-menu-item.active .fs-menu-meta {
  /* 「当前」/码率这串是**解释性**文字，只比正文低一档；用 faint 会掉到 2.6:1 */
  color: color-mix(in srgb, var(--fs-ink) 72%, transparent);
}

/* ---- 悬浮提示（P58） ----
   每个图标 / 胶囊都带 `data-tip`：图标省宽度，提示补语义。
   自绘而不是用原生 title：原生提示 1s 才出、样式由系统画，在一条玻璃上很出戏。
   位置默认居中，抬到**条子上沿之外**（--fs-pop-lift，与弹层同一条基准线）：
   只抬 8px 的话气泡会正压在标题行文字上，看着像布局错位；抬到条外则浮在画面上，
   与弹层同一层语义。靠右的元素加 `.tip-end` 改成右对齐，避免溢出视口。
*/
.fs-icon,
.fs-chip,
.fs-act {
  position: relative;
}
[data-tip]::after {
  content: attr(data-tip);
  position: absolute;
  left: 50%;
  bottom: calc(100% + var(--fs-pop-lift, 39px));
  z-index: 3;
  padding: 3px 7px;
  border: 1px solid color-mix(in srgb, #fff 12%, transparent);
  border-radius: 5px;
  background: color-mix(in srgb, #05070b 90%, transparent);
  color: var(--fs-ink);
  font-size: var(--fs-2xs);
  line-height: 1.35;
  white-space: nowrap;
  text-shadow: none;
  opacity: 0;
  translate: -50% 2px;
  pointer-events: none;
  transition: opacity 120ms var(--ease), translate 120ms var(--ease);
}
[data-tip]:hover::after,
[data-tip]:focus-visible::after {
  opacity: 1;
  translate: -50% 0;
}
[data-tip].tip-end::after {
  left: auto;
  right: 0;
  translate: 0 2px;
}
[data-tip].tip-end:hover::after,
[data-tip].tip-end:focus-visible::after {
  translate: 0 0;
}
/* 行首元素：窄屏（条内 padding 收到 12px）下居中的气泡会顶出视口左沿，
   改成左对齐——气泡左沿与图标左沿齐平，永远不会出界。 */
[data-tip].tip-start::after {
  left: 0;
  translate: 0 2px;
}
[data-tip].tip-start:hover::after,
[data-tip].tip-start:focus-visible::after {
  translate: 0 0;
}
/* 按钮与 .engine-btn 同源（同圆角、同描边），高度跟轨道命中区一致 = 30px。
   P57：底子从实色 --panel-3 换成半透明白洗 —— 玻璃条上放实色块，看起来像贴了张纸，
   一挪动条子就会「露馅」；白洗是让按钮浮在这层玻璃上。 */
.fs-act {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 30px;
  min-height: 0;
  padding: 0 12px;
  border: 1px solid var(--fs-line-soft);
  border-radius: var(--r-sm);
  background: color-mix(in srgb, #fff 8%, transparent);
  color: var(--fs-ink-dim);
  font-family: inherit;
  font-size: var(--fs-xs);
  line-height: 1.2;
  white-space: nowrap;
  text-shadow: var(--fs-ink-shadow);
  cursor: pointer;
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease),
    color var(--t-fast) var(--ease);
}
.fs-act:hover:not(:disabled) {
  background: color-mix(in srgb, #fff 16%, transparent);
  border-color: color-mix(in srgb, #fff 28%, transparent);
  color: var(--fs-ink);
}
.fs-act.active {
  background: var(--accent-soft);
  border-color: var(--accent-line);
  color: var(--accent-ink);
}
/* P58：按钮里的图标。窄屏 ≤1180px 时 `.fs-act-label` 收起，只剩图标 + 数字 */
.ico-act {
  display: block;
  opacity: 0.85;
}
.fs-act.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  font-weight: 500;
}
.fs-act.primary:hover:not(:disabled) {
  background: var(--accent-hi);
  border-color: var(--accent-hi);
}
.fs-act:disabled {
  opacity: 0.4;
  cursor: default;
}
.fs-act-num {
  font-size: var(--fs-2xs);
  font-variant-numeric: tabular-nums;
  opacity: 0.72;
}
.fs-act-hint {
  max-width: 132px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-2xs);
  opacity: 0.82;
}

/* ---- 全屏选集面板：浮在控制条上方，内部滚动（页面本身不滚） ---- */
.fs-panel {
  position: absolute;
  right: var(--sp-6);
  bottom: calc(var(--pf-fs-bar, 72px) + var(--sp-3));
  z-index: 9;
  display: flex;
  flex-direction: column;
  width: min(560px, calc(100vw - 48px));
  max-height: min(52vh, 460px);
  border: 1px solid var(--line-2);
  border-radius: var(--r-lg);
  background: color-mix(in srgb, var(--panel) 97%, transparent);
  box-shadow: var(--shadow-3);
  backdrop-filter: blur(12px);
  /* 纯浮层容器，不含 <video>，裁剪是安全的（P38 只约束视频区祖先） */
  overflow: hidden;
}
.fs-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  flex: none;
  padding: 10px var(--sp-3);
  border-bottom: 1px solid var(--line);
}
.fs-panel-head h4 {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text);
}
.fs-panel-count {
  margin-left: 6px;
  font-size: var(--fs-2xs);
  font-weight: 400;
  color: var(--text-faint);
}
.fs-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-dim);
  font-size: var(--fs-xs);
  cursor: pointer;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.fs-icon-btn:hover {
  background: var(--panel-3);
  color: var(--text);
}
.fs-panel-body {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(78px, 1fr));
  gap: 5px;
  padding: var(--sp-3);
  overflow-y: auto;
  overscroll-behavior: contain;
}
/* 面板里的集按钮直接复用侧栏的 .ep-btn：.video-wrap 带 force-dark，
   token 在这里本来就是暗色值，不需要再写一套色值。 */
.fs-panel-err {
  flex: none;
  padding: 0 var(--sp-3) 10px;
  font-size: var(--fs-2xs);
  color: var(--danger);
}

/* 面板出现/消失：轻微上浮，不做缩放（全屏里任何 scale 都会让字发虚） */
.pf-fs-pop-enter-active,
.pf-fs-pop-leave-active {
  transition: opacity var(--t-base) var(--ease), transform var(--t-base) var(--ease);
}
.pf-fs-pop-enter-from,
.pf-fs-pop-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
/* P58：淡出过程中不许再吃点击 —— 一个已经「关掉」的弹层还挡着画面，
   用户点上去不会有任何反应，看起来像卡死（尤其全屏里点画面本该是暂停）。
   隐藏窗口/最小化时过渡可能停在中途，这条同时是那种情况的兜底。 */
.pf-fs-pop-leave-active {
  pointer-events: none;
}
@media (prefers-reduced-motion: reduce) {
  .pf-fs-pop-enter-active,
  .pf-fs-pop-leave-active {
    transition: none;
  }
}

/* 窄屏全屏：只留控制行（标题让位），按钮收紧。
   高度必须仍是 --pf-fs-bar（mpv 矩形、弹幕让位都按它算），
   所以这里不换行、只减内容，宁可丢掉标题也不让控制条变高。 */
@media (max-width: 1180px) {
  /* P58 第一档：胶囊去图标只留数值、按钮去文字只留图标。
     此时固定宽度约 700px，1280 以下的窗口也不会挤在一起。 */
  .fs-chip {
    padding: 0 7px;
  }
  .fs-chip .ico-chip {
    display: none;
  }
  .fs-act {
    padding: 0 9px;
  }
  .fs-act-label {
    display: none;
  }
  .fs-bar-row {
    gap: var(--sp-2);
  }
  .fs-vol-track {
    width: 60px;
  }
}
@media (max-width: 900px) {
  .fs-bar {
    padding: 0 var(--sp-3);
    /* 标题行已隐藏，控制行上移到 (72-30)/2 = 21，弹层/提示的基准线跟着下移 10px */
    --fs-pop-lift: 29px;
  }
  .fs-bar-head {
    display: none;
  }
  .fs-bar-row {
    gap: 6px;
  }
  .fs-act {
    padding: 0 8px;
  }
  .fs-act-hint,
  .fs-act-num {
    display: none;
  }
  /* 窄屏不藏音量：只是把滑杆缩短，音量调节在任何宽度下都必须可用 */
  .fs-vol-track {
    width: 52px;
  }
  .fs-panel {
    right: var(--sp-3);
    left: var(--sp-3);
    width: auto;
  }
  /* 窄屏下「上一集 / 下一集」只留播放键的空间紧张时，图标间距再收一档 */
  .fs-transport .fs-icon {
    min-width: 26px;
    padding: 0 4px;
  }
}
</style>
