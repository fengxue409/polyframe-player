/**
 * 弹幕渲染引擎（Canvas 2D）
 *
 * 为什么用 Canvas 而不是 DOM：
 *  - 5000 条量级下 DOM 节点的样式计算 + 布局 + 合成会把主线程打满，
 *    Canvas 只需一次 `fillText`，实测同屏 80 条时单帧 < 2ms；
 *  - 滚动位置逐帧计算，DOM 需要 `transform` + 合成层，反而更容易掉帧；
 *  - 不会与播放器的 `pointer-events` 逻辑打架（弹幕层可整体穿透）。
 *
 * 性能要点（针对「超高并发弹幕」）：
 *  1. **游标 + 区间消费**：只在 `[上一帧, 当前帧]` 内取新弹幕，从不遍历全量；
 *  2. **同屏上限**：超出直接丢弃，不排队（排队会导致时间轴错位）；
 *  3. **measureText 缓存**：同文本只量一次；
 *  4. **帧耗时监测**：连续超预算时自动降低同屏上限，恢复后回升；
 *  5. 页面不可见 / 引擎停止时立刻取消 rAF。
 */

import type { DanmakuItem } from '@polyframe/shared'
import { isDiscontinuity, type DanmakuClock } from './clock'
import { TrackAllocator } from './track'
import { darken, isImageUrl, lighten, normalizeFx, parseHexColor, toCss, type DanmakuFx } from './fx'

/** 滚动弹幕穿屏基准时长（秒），再乘 speed 倍率 */
const BASE_SCROLL_SECS = 8
/** 顶部/底部弹幕停留时长（秒） */
const STATIC_SECS = 5
/** 单帧渲染耗时预算（ms）；持续超过则降级同屏上限 */
const FRAME_BUDGET_MS = 9
/** 文本宽度缓存上限（防长视频累积膨胀） */
const MEASURE_CACHE_MAX = 2000
/** 图片弹幕显示高度（em，相对字号） */
const IMAGE_H_EM = 1.5
/** 图片缓存上限（防恶意弹幕刷爆内存） */
const IMAGE_CACHE_MAX = 120

export interface EngineOptions {
  opacity: number
  fontScale: number
  /** 滚动时长倍率，越大越慢 */
  speed: number
  /** 同屏密度倍率 0.1 ~ 1.0 */
  density: number
  blockScroll: boolean
  blockTop: boolean
  blockBottom: boolean
}

interface ActiveItem {
  text: string
  color: string
  fontSize: number
  width: number
  /** px/s；0 = 静止弹幕 */
  speed: number
  /** 入场媒体时间（秒） */
  start: number
  /** 存活时长（秒） */
  duration: number
  /** 纵坐标（文字顶部） */
  y: number
  /** P17 渲染特效（图片弹幕时忽略 fx） */
  fx: DanmakuFx
  /** 图片弹幕：已解码的图（未就绪/加载失败为 null，按文本兜底渲染） */
  img: HTMLImageElement | null
  /** 图片弹幕的 URL（渲染帧里查缓存，解码完成后热替换占位） */
  imgUrl: string | null
  /** 图片宽高比（w/h）；占位阶段为 1 */
  aspect: number
}

export interface EngineStats {
  /** 全量弹幕条数 */
  total: number
  /** 当前在屏 */
  onScreen: number
  /** 因屏满/超限丢弃的累计条数 */
  dropped: number
  /** 平滑帧耗时（ms） */
  frameMs: number
  /** 实测帧率 */
  fps: number
  /** 当前生效的同屏上限（会随负载自适应） */
  cap: number
  /** 轨道数（随播放区高度与字号变化） */
  tracks: number
  /** 时间轴缩放倍率（1 = 未缩放） */
  scale: number
  /** 是否已量到有效尺寸（false = rect 为 0，画布会停在默认 300×150） */
  sized: boolean
  /** 诊断：CSS 尺寸 / 位图尺寸 */
  size: { w: number; h: number; bitmapW: number; bitmapH: number }
  /** 渲染循环是否在跑 */
  running: boolean
  /** 累计渲染帧数（0 = 循环从未推进，rAF 未投递） */
  frames: number
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export class DanmakuEngine {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private clock: DanmakuClock
  private allocator = new TrackAllocator()

  /** 已按时间排序（且已应用缩放）的弹幕 */
  private items: DanmakuItem[] = []
  /** 已消费到的位置（严格单调，seek 时二分回退） */
  private cursor = 0
  private active: ActiveItem[] = []

  private opts: EngineOptions = {
    opacity: 0.9,
    fontScale: 1,
    speed: 1,
    density: 1,
    blockScroll: false,
    blockTop: false,
    blockBottom: false
  }

  /** 弹幕源片长（秒）；与当前片长不同时做线性缩放 */
  private sourceDuration: number | null = null
  /** 当前片源片长（秒） */
  private targetDuration: number | null = null
  /** 实际生效的缩放倍率 */
  private scale = 1

  private cssW = 0
  private cssH = 0
  /** 与 allocator 同步的字号，用于判断"尺寸没变但字号变了" */
  private layoutFont = 0
  /** 上一次 resize 拿到的是无效尺寸（元素尚未布局 / display:none） */
  private sizePending = true

  private raf = 0
  private running = false
  private lastMedia = 0
  private lastWall = 0
  private disposed = false

  /** 文本宽度缓存：`${fontSize}|${text}` → px */
  private measureCache = new Map<string, number>()
  /**
   * 图片弹幕缓存：url → { img, aspect, broken }。
   * `broken` 的条目按原文本（URL）兜底绘制 —— 裂图比静默消失可诊断。
   */
  private imageCache = new Map<string, { img: HTMLImageElement | null; aspect: number; broken: boolean }>()
  /** 上一帧设置的字体串，相同则跳过（设置 font 会触发样式解析） */
  private lastFont = ''

  private frameEma = 0
  private fps = 0
  private fpsFrames = 0
  private fpsWall = 0
  private dropped = 0
  /** 累计渲染帧数（诊断：判断渲染循环是否真的在推进） */
  private frames = 0
  /** 自适应上限：从基准值出发，按负载上下浮动 */
  private adaptiveCap = 80
  private readonly baseCap: number

  private ro: ResizeObserver | null = null
  private onVisibility = (): void => {
    if (document.hidden) {
      this.pauseLoop()
    } else if (this.running) {
      this.resumeLoop()
    }
  }

  constructor(canvas: HTMLCanvasElement, clock: DanmakuClock, baseCap = 80) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true })
    if (!ctx) throw new Error('Canvas 2D 上下文不可用')
    this.ctx = ctx
    this.clock = clock
    this.baseCap = baseCap
    this.adaptiveCap = baseCap

    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(canvas)
    this.resize()

    document.addEventListener('visibilitychange', this.onVisibility)
  }

  // ---------------------------------------------------------------- 生命周期

  start(): void {
    if (this.disposed || this.running) return
    this.running = true
    // 起播前补一次尺寸同步：挂载时 rect 可能还是 0
    this.syncSize()
    this.lastMedia = this.clock.now()
    this.lastWall = performance.now()
    this.fpsWall = this.lastWall
    this.hydrate(this.lastMedia)
    this.resumeLoop()
  }

  stop(): void {
    this.running = false
    this.pauseLoop()
  }

  destroy(): void {
    this.disposed = true
    this.stop()
    this.ro?.disconnect()
    this.ro = null
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.measureCache.clear()
    this.items = []
    this.active = []
    this.imageCache.clear()
  }

  private pauseLoop(): void {
    if (this.raf) {
      cancelAnimationFrame(this.raf)
      this.raf = 0
    }
  }

  private resumeLoop(): void {
    if (this.raf || this.disposed) return
    this.lastWall = performance.now()
    this.raf = requestAnimationFrame(this.tick)
  }

  // ---------------------------------------------------------------- 数据

  /**
   * 装载弹幕。
   *
   * `sourceDuration` 是弹幕源自己的片长估计；与 `targetDuration` 差异 > 2% 时
   * 按比例缩放时间轴 —— 换片源不重拉弹幕，同一份数据服务不同剪辑版本。
   */
  setItems(items: DanmakuItem[], sourceDuration?: number | null): void {
    this.sourceDuration = sourceDuration ?? null
    this.rebuildScaled(items)
  }

  /** 播放器时长就绪/变化时调用（触发重算缩放并重建时间轴） */
  setDuration(seconds: number | null): void {
    const next = seconds && seconds > 0 ? seconds : null
    if (next === this.targetDuration) return
    this.targetDuration = next
    // 还没有弹幕时只记下目标时长，等 setItems 时一并算缩放（避免空重建）
    if (this.items.length === 0) return
    this.rebuildScaled(this.items)
  }

  private rebuildScaled(items: DanmakuItem[]): void {
    const src = this.sourceDuration
    const dst = this.targetDuration
    let scale = 1
    if (src && dst && src > 0 && dst > 0) {
      // 偏差 < 2% 视为同一版本，不做缩放（避免无意义抖动）
      if (Math.abs(src - dst) / src >= 0.02) scale = dst / src
    }
    this.scale = scale
    const list =
      scale === 1
        ? items.slice()
        : items.map((it) => ({ ...it, time: Math.max(0, it.time * scale) }))
    list.sort((a, b) => a.time - b.time)
    this.items = list
    // 时间轴变了，在屏内容和游标全部失效
    this.softReset(this.clock.now())
  }

  /** 本地刚发送的弹幕：即时上屏 + 插入时间轴供回看 */
  send(item: DanmakuItem): void {
    const t = this.scale === 1 ? item.time : item.time * this.scale
    const scaled: DanmakuItem = { ...item, time: t }
    const idx = this.upperBound(t)
    this.items.splice(idx, 0, scaled)
    // 插入位置在游标之前**或正好等于游标**时，都要让游标越过它：
    // 等于游标意味着它落在"下一个待消费"的位置，而它已经在这里即时上屏了，
    // 不跳过的话下一帧 spawnRange 会把它再放一次（屏幕上出现两条一样的弹幕）。
    if (idx <= this.cursor) this.cursor++
    this.trySpawn(scaled, t)
  }

  /** 通知时间轴跳变（seek / 换集 / 换源） */
  seek(seconds: number): void {
    this.softReset(seconds)
  }

  setOptions(partial: Partial<EngineOptions>): void {
    const before = this.opts.fontScale
    this.opts = { ...this.opts, ...partial }
    this.opts.opacity = clamp(this.opts.opacity, 0.1, 1)
    this.opts.fontScale = clamp(this.opts.fontScale, 0.6, 1.8)
    this.opts.speed = clamp(this.opts.speed, 0.5, 1.5)
    this.opts.density = clamp(this.opts.density, 0.1, 1)
    if (this.opts.fontScale !== before) {
      // 字号变了 → 行高/轨道数/宽度全部失效
      this.resize()
      this.softReset(this.clock.now())
    }
    // 密度/字号变化都意味着"基准上限"变了，自适应值一并作废
    this.recomputeCap(true)
  }

  getOptions(): EngineOptions {
    return { ...this.opts }
  }

  // ---------------------------------------------------------------- 布局

  resize(force = false): void {
    const rect = this.canvas.getBoundingClientRect()
    const w = Math.round(rect.width)
    const h = Math.round(rect.height)
    // 元素刚挂载（父容器还没布局）或处于 display:none 时 rect 为 0。
    // 此时若照写会把画布压成 1×1，而 CSS 尺寸（width:100%）之后再没有
    // 「变化」，ResizeObserver 就不会再回调 —— 结果是弹幕层看起来挂载正常、
    // 轨道数恒为 1、一个像素都不显示。所以这里直接跳过并标记待同步。
    if (w < 2 || h < 2) {
      this.sizePending = true
      return
    }
    const font = this.fontFor(h, this.opts.fontScale)
    const dpr = clamp(window.devicePixelRatio || 1, 1, 3)
    const bw = Math.round(w * dpr)
    const bh = Math.round(h * dpr)
    const unchanged =
      this.cssW === w &&
      this.cssH === h &&
      this.canvas.width === bw &&
      this.canvas.height === bh &&
      Math.abs(this.layoutFont - font) < 0.01
    if (!force && unchanged) return

    this.sizePending = false
    this.cssW = w
    this.cssH = h
    this.layoutFont = font
    this.canvas.width = bw
    this.canvas.height = bh
    // 逻辑坐标统一用 CSS px，DPR 交给变换矩阵
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.allocator.resize(w, h, font)
    this.recomputeCap(true)
    // 尺寸/字号变化后旧的位置信息与文本宽度全部失效
    this.active = []
    this.lastFont = ''
    this.measureCache.clear()
    if (this.running) this.hydrate(this.clock.now())
  }

  /**
   * 尺寸自愈：挂载早于布局时 rect 为 0，靠这一句在后续帧补上；
   * 同时兜住「ResizeObserver 没触发」的边角情况（例如元素从 display:none
   * 切回可见，但父容器尺寸恰好没变）。
   */
  private syncSize(): void {
    if (this.sizePending || this.cssW < 2 || this.cssH < 2) this.resize()
  }

  private fontFor(h: number, scale: number): number {
    // 基准：1080p 高 1080 → 35.6px；窄屏按比例缩，但不小于 14px
    return clamp(h * 0.033 * scale, 14, h * 0.09)
  }

  private fontSize(): number {
    return this.fontFor(this.cssH, this.opts.fontScale)
  }

  private scrollSecs(): number {
    return BASE_SCROLL_SECS * this.opts.speed
  }

  /**
   * 重算同屏上限基准。
   *
   * `reset = true`（布局 / 字号 / 密度变化时）：直接把自适应值拉回基准。
   * 这些变化本身会清空在屏内容，负载自适应状态就该作废。
   *
   * 曾经的写法只有夹取（`clamp(adaptiveCap, 8, base)`），一旦挂载早期
   * 因画布还没量到尺寸把 adaptiveCap 压到 8，后续即使轨道数正常回到 19
   * 也**永远停在 8**（回升只发生在 tick 里，而暂停时 tick 不跑）——
   * 表现为"同屏最多 8 条、密度滑块形同虚设"。
   */
  private recomputeCap(reset = false): void {
    const tracks = this.allocator.trackCount || 1
    const base = clamp(Math.round(tracks * 3 * this.opts.density), 8, this.baseCap)
    this.adaptiveCap = reset ? base : clamp(this.adaptiveCap, 8, base)
  }

  private cap(): number {
    return this.adaptiveCap
  }

  // ---------------------------------------------------------------- 调度

  /** 清空在屏 + 回退游标 + 按 `[t - 滚动时长, t]` 重建屏上状态 */
  private softReset(t: number): void {
    this.active = []
    this.allocator.reset()
    this.lastMedia = t
    this.hydrate(t)
  }

  /**
   * 重建「seek 之后本应在屏上」的弹幕。
   *
   * 不做这一步的话，seek 到任意位置都会出现「空白 → 突然涌入」的跳变，
   * 而真实播放时那个时间点屏幕上本来就有弹幕在滚动。
   */
  private hydrate(t: number): void {
    const from = t - this.scrollSecs() - 1
    let i = this.lowerBound(from)
    const batch: DanmakuItem[] = []
    while (i < this.items.length && this.items[i].time <= t) {
      batch.push(this.items[i++])
    }
    // 高密度区 seek 过来时可能瞬间几百条，只取最近的一段
    const limit = Math.max(1, Math.round(this.cap() * 0.6))
    const slice = batch.length > limit ? batch.slice(batch.length - limit) : batch
    for (const it of slice) this.trySpawn(it, it.time)
    this.cursor = i
  }

  /** 消费 `[from, to]` 区间内新出现的弹幕 */
  private spawnRange(from: number, to: number): void {
    // 首次 tick 或极端卡顿后，区间可能极大：限制回溯深度避免一帧涌入几百条
    const lo = Math.max(from, to - this.scrollSecs() - 1)
    while (this.cursor < this.items.length && this.items[this.cursor].time <= to) {
      const it = this.items[this.cursor]
      this.cursor++
      if (it.time >= lo - 0.02) this.trySpawn(it, it.time)
    }
  }

  private trySpawn(it: DanmakuItem, at: number): void {
    if (it.mode === 'scroll' && this.opts.blockScroll) return
    if (it.mode === 'top' && this.opts.blockTop) return
    if (it.mode === 'bottom' && this.opts.blockBottom) return
    if (this.active.length >= this.cap()) {
      this.dropped++
      return
    }

    const fontSize = this.fontSize()
    // P17：图片弹幕 —— text 是图片 URL 时按图片渲染（fx 忽略）。
    // 未加载完成前用 1:1 占位宽度分配轨道，加载完成后按真实宽高比绘制；
    // 加载失败按原文本兜底（URL 本身可读，比静默消失可诊断）。
    const isImg = isImageUrl(it.text)
    const fx = isImg ? null : normalizeFx(it.fx)
    let width: number
    let img: HTMLImageElement | null = null
    let aspect = 1
    let imgUrl: string | null = null
    if (isImg) {
      const entry = this.getImage(it.text)
      imgUrl = it.text
      if (entry.broken) {
        width = this.measure(it.text, fontSize)
      } else {
        if (entry.img) img = entry.img
        aspect = entry.aspect
        width = fontSize * IMAGE_H_EM * aspect
      }
    } else {
      width = this.measure(it.text, fontSize)
    }
    const duration = it.mode === 'scroll' ? this.scrollSecs() : STATIC_SECS
    const speed = it.mode === 'scroll' ? (this.cssW + width) / duration : 0
    const track = this.allocator.allocate(it.mode, at, width, speed)
    if (track === null) {
      this.dropped++
      return
    }
    const y = this.allocator.trackY(track, it.mode)
    if (it.mode !== 'scroll') this.allocator.occupy(it.mode, track, at + duration)
    this.active.push({
      text: it.text,
      color: it.color,
      fontSize,
      width,
      speed,
      start: at,
      duration,
      y,
      fx,
      img,
      imgUrl,
      aspect
    })
  }

  /** 图片弹幕缓存读取 + 惰性解码（解码完成后新弹幕直接用真实宽高比） */
  private getImage(url: string): { img: HTMLImageElement | null; aspect: number; broken: boolean } {
    const hit = this.imageCache.get(url)
    if (hit) return hit
    if (this.imageCache.size >= IMAGE_CACHE_MAX) this.imageCache.clear()
    const entry = { img: null as HTMLImageElement | null, aspect: 1, broken: false }
    this.imageCache.set(url, entry)
    const im = new Image()
    im.onload = () => {
      entry.img = im
      if (im.naturalWidth > 0 && im.naturalHeight > 0) entry.aspect = im.naturalWidth / im.naturalHeight
    }
    im.onerror = () => {
      entry.broken = true
    }
    im.src = url
    return entry
  }

  private measure(text: string, fontSize: number): number {
    const key = `${fontSize}|${text}`
    const hit = this.measureCache.get(key)
    if (hit !== undefined) return hit
    if (this.lastFont !== this.fontOf(fontSize)) {
      this.ctx.font = this.fontOf(fontSize)
      this.lastFont = this.fontOf(fontSize)
    }
    const w = this.ctx.measureText(text).width
    if (this.measureCache.size >= MEASURE_CACHE_MAX) {
      // 简单淘汰：清一半（弹幕文本重复率高，全清代价也不大）
      this.measureCache.clear()
    }
    this.measureCache.set(key, w)
    return w
  }

  private fontOf(fontSize: number): string {
    return `600 ${fontSize}px "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif`
  }

  private lowerBound(t: number): number {
    let lo = 0
    let hi = this.items.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.items[mid].time < t) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  private upperBound(t: number): number {
    let lo = 0
    let hi = this.items.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.items[mid].time <= t) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  // ---------------------------------------------------------------- 主循环

  private tick = (): void => {
    this.raf = 0
    if (this.disposed) return
    this.frame()
    this.raf = requestAnimationFrame(this.tick)
  }

  /**
   * 同步推进一帧。
   *
   * 从 `tick` 里抽出来的原因：窗口被遮挡 / 无头运行时 Chromium 会停掉帧生产，
   * `requestAnimationFrame` 不再回调，`ResizeObserver`（回调跟着帧走）也不投递。
   * 那种环境下「画布量不到尺寸 + 渲染循环完全不跑」，看起来像功能坏了，
   * 实际只是没有帧。测试与诊断需要一个不依赖 rAF 的入口。
   */
  step(times = 1): void {
    if (this.disposed) return
    for (let i = 0; i < times; i++) this.frame()
  }

  private frame(): void {
    const t0 = performance.now()
    this.syncSize()
    const media = this.clock.now()

    if (isDiscontinuity(this.lastMedia, media)) {
      // seek / 换片：重置时间轴与在屏状态
      this.softReset(media)
    } else if (this.clock.isPlaying()) {
      this.spawnRange(this.lastMedia, media)
    }
    this.lastMedia = media

    this.render(media)

    // 帧耗时 + 帧率（指数平滑，避免单帧抖动就降级）
    const cost = performance.now() - t0
    this.frameEma = this.frameEma === 0 ? cost : this.frameEma * 0.9 + cost * 0.1
    this.fpsFrames++
    this.frames++
    if (t0 - this.fpsWall >= 500) {
      this.fps = Math.round((this.fpsFrames * 1000) / (t0 - this.fpsWall))
      this.fpsFrames = 0
      this.fpsWall = t0
      // 低频兜底：ResizeObserver 漏报时（元素从 display:none 恢复、父容器
      // 尺寸恰好没变等）也能跟上窗口尺寸；尺寸没变时内部会提前返回。
      this.resize()
      // 自适应：超预算就压上限，充裕就回补
      if (this.frameEma > FRAME_BUDGET_MS && this.adaptiveCap > 12) {
        this.adaptiveCap = Math.max(12, this.adaptiveCap - 6)
      } else if (this.frameEma < FRAME_BUDGET_MS * 0.5 && this.adaptiveCap < this.baseCap) {
        this.adaptiveCap = Math.min(this.baseCap, this.adaptiveCap + 2)
      }
    }
  }

  private render(media: number): void {
    const ctx = this.ctx
    ctx.clearRect(0, 0, this.cssW, this.cssH)
    const alpha = this.opts.opacity
    ctx.globalAlpha = alpha
    ctx.textBaseline = 'top'
    ctx.lineJoin = 'round'

    // 倒序遍历：splice 淘汰时索引不会被打乱
    for (let i = this.active.length - 1; i >= 0; i--) {
      const a = this.active[i]
      const elapsed = media - a.start
      if (elapsed < 0) continue
      if (elapsed > a.duration) {
        this.active.splice(i, 1)
        continue
      }
      const x = a.speed > 0 ? this.cssW - a.speed * elapsed : (this.cssW - a.width) / 2
      // 完全移出左边界 → 提前淘汰，少画一帧
      if (a.speed > 0 && x + a.width < 0) {
        this.active.splice(i, 1)
        continue
      }
      // 图片异步解码完成后热替换：spawn 时图还没好，这里从缓存取回真实位图
      // 并按真实宽高比重算宽度（静止弹幕的居中 x 也随之修正）
      if (a.imgUrl && a.img === null) {
        const e = this.imageCache.get(a.imgUrl)
        if (e && e.img) {
          a.img = e.img
          a.aspect = e.aspect
          a.width = a.fontSize * IMAGE_H_EM * e.aspect
        }
      }
      this.drawText(a, x)
    }
    ctx.globalAlpha = 1
  }

  private drawText(a: ActiveItem, x: number): void {
    const ctx = this.ctx
    const font = this.fontOf(a.fontSize)
    if (this.lastFont !== font) {
      ctx.font = font
      this.lastFont = font
    }
    // ---- P17 图片弹幕 ----
    if (a.img) {
      const h = a.fontSize * IMAGE_H_EM
      const w = h * a.aspect
      // 底部微阴影保证在亮画面上可读（图片没有描边可用）
      ctx.save()
      ctx.shadowColor = 'rgba(0,0,0,0.55)'
      ctx.shadowBlur = Math.max(2, a.fontSize * 0.12)
      ctx.drawImage(a.img, x, a.y, w, h)
      ctx.restore()
      return
    }
    // 图片加载失败 → 按原文本（URL）兜底，走普通描边路径
    if (a.fx === 'glow') {
      this.drawGlow(a, x)
      return
    }
    if (a.fx === 'gradient') {
      this.drawGradient(a, x)
      return
    }
    // 描边保证在亮画面/白字幕上依然可读（弹幕可读性的下限保障）
    ctx.lineWidth = Math.max(1.5, a.fontSize * 0.09)
    ctx.strokeStyle = 'rgba(0,0,0,0.82)'
    ctx.strokeText(a.text, x, a.y)
    ctx.fillStyle = a.color
    ctx.fillText(a.text, x, a.y)
  }

  /**
   * 发光：用 shadowBlur 在文字四周投同色光晕。
   * 画两遍是为了加强光晕密度（shadow 叠加比单次调大 blur 更接近 ACGN 风格的"辉光"）。
   * glow 模式描边会压暗光晕内缘，故改用半透明深色细描边保持可读性。
   */
  private drawGlow(a: ActiveItem, x: number): void {
    const ctx = this.ctx
    ctx.save()
    ctx.shadowColor = a.color
    ctx.shadowBlur = a.fontSize * 0.45
    ctx.fillStyle = a.color
    ctx.fillText(a.text, x, a.y)
    ctx.fillText(a.text, x, a.y)
    ctx.restore()
    ctx.lineWidth = Math.max(1, a.fontSize * 0.06)
    ctx.strokeStyle = 'rgba(0,0,0,0.55)'
    ctx.strokeText(a.text, x, a.y)
    ctx.fillStyle = a.color
    ctx.fillText(a.text, x, a.y)
  }

  /**
   * 渐变：横向三停渐变（亮 → 主色 → 暗），随文字宽度铺满。
   * gradient 对象每帧新建 —— createLinearGradient 是轻量操作，
   * 而缓存键要带上 x/y/width/颜色，命中率低不值得。
   */
  private drawGradient(a: ActiveItem, x: number): void {
    const ctx = this.ctx
    const base = parseHexColor(a.color)
    const g = ctx.createLinearGradient(x, a.y, x + a.width, a.y)
    g.addColorStop(0, toCss(lighten(base, 0.55)))
    g.addColorStop(0.5, a.color)
    g.addColorStop(1, toCss(darken(base, 0.25)))
    ctx.save()
    // 渐变模式下阴影会糊掉色彩过渡，只留极轻的投影
    ctx.shadowColor = 'rgba(0,0,0,0.35)'
    ctx.shadowBlur = a.fontSize * 0.1
    ctx.fillStyle = g
    ctx.fillText(a.text, x, a.y)
    ctx.restore()
    ctx.lineWidth = Math.max(1, a.fontSize * 0.05)
    ctx.strokeStyle = 'rgba(0,0,0,0.45)'
    ctx.strokeText(a.text, x, a.y)
  }

  // ---------------------------------------------------------------- 诊断

  stats(): EngineStats {
    return {
      total: this.items.length,
      onScreen: this.active.length,
      dropped: this.dropped,
      frameMs: Math.round(this.frameEma * 100) / 100,
      fps: this.fps,
      cap: this.cap(),
      tracks: this.allocator.trackCount,
      scale: Math.round(this.scale * 1000) / 1000,
      sized: !this.sizePending,
      size: {
        w: this.cssW,
        h: this.cssH,
        bitmapW: this.canvas.width,
        bitmapH: this.canvas.height
      },
      running: this.running,
      frames: this.frames
    }
  }

  /**
   * 测试用：注入一批弹幕并立刻推进一帧（不依赖真实播放）。
   *
   * `renderAt` 单独给的原因：滚动弹幕在**入场那一帧**正好贴在画面右边缘
   * （`x = cssW`），此时一个像素都还没进来 —— 这是正确行为，但会让
   * 「注入了就必须看见像素」的断言误判。测试传一个稍晚的时间点即可。
   */
  debugInject(
    items: DanmakuItem[],
    at: number,
    renderAt = at
  ): { placed: number; dropped: number } {
    this.syncSize()
    const before = this.active.length
    const droppedBefore = this.dropped
    for (const it of items) this.trySpawn(it, at)
    this.render(renderAt)
    return { placed: this.active.length - before, dropped: this.dropped - droppedBefore }
  }
}
