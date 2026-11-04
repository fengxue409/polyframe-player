/**
 * 弹幕轨道分配：决定「这一条放第几行」，保证同轨道既不重叠也不追尾。
 *
 * 算法与 Rust 侧 `pf-danmaku/src/ass.rs` 的 `TrackAllocator` **保持同一套语义**：
 *  - 滚动弹幕按固定时长穿屏 → 速度 `v = (width + textWidth) / duration`
 *  - 同轨道可复用的充要条件（两条都成立）：
 *      1. 前一条尾部已完全进入屏幕：`v_prev * (t - t_prev) >= w_prev + gap`
 *      2. 前一条已远到新弹幕追不上：`v_prev * (t - t_prev) >= w_new + gap`
 *    条件 2 强于条件 1，但两条一起校验可以兜住「前一条特别短」的边界。
 *  - 顶部/底部固定弹幕走独立轨道池，按占用到期时间排队
 *
 * 为什么不排队等空轨道：等待会让弹幕延迟出现，越积越多，最终整屏弹幕
 * 全是「几秒前的」。宁可丢弃，也不要时间轴错位 —— 这是弹幕产品的通行取舍。
 */

export type DanmakuMode = 'scroll' | 'top' | 'bottom'

export interface TrackState {
  /** 最近一条的入场时间（媒体秒） */
  lastT: number
  /** 最近一条的宽度（px） */
  lastW: number
  /** 最近一条的速度（px/s），0 = 该轨道被固定弹幕占用 */
  lastV: number
  /** 固定弹幕占用到期时间 */
  busyUntil: number
}

const emptyTrack = (): TrackState => ({ lastT: -1e9, lastW: 0, lastV: 0, busyUntil: -1e9 })

export interface AllocatorOptions {
  /** 轨道数上限（防止超小窗口算出荒谬的行数） */
  maxTracks?: number
}

export class TrackAllocator {
  /** 可用宽度（px） */
  width = 0
  /** 可用高度（px） */
  height = 0
  /** 字号（px） */
  fontSize = 20
  /** 行高 = 字号 * 1.45 */
  lineHeight = 29
  /** 轨道数 */
  trackCount = 0
  /** 上下安全边距（px） */
  private padY = 0

  /** 滚动轨道池 */
  private scroll: TrackState[] = []
  /** 顶部固定轨道池 */
  private topPool: TrackState[] = []
  /** 底部固定轨道池 */
  private bottomPool: TrackState[] = []

  constructor(opts?: AllocatorOptions) {
    this.maxTracks = opts?.maxTracks ?? 24
  }

  private maxTracks: number

  /**
   * 重建轨道（窗口尺寸 / 字号变化时调用）。
   * 会清空所有状态 —— 尺寸变了，旧的像素级轨道信息已经没有意义。
   */
  resize(width: number, height: number, fontSize: number): void {
    this.width = Math.max(1, width)
    this.height = Math.max(1, height)
    this.fontSize = Math.max(8, fontSize)
    this.lineHeight = this.fontSize * 1.45
    this.padY = Math.round(this.height * 0.03)
    const usable = this.height - this.padY * 2
    this.trackCount = Math.max(1, Math.min(this.maxTracks, Math.floor(usable / this.lineHeight)))
    this.reset()
  }

  reset(): void {
    this.scroll = Array.from({ length: this.trackCount }, emptyTrack)
    this.topPool = Array.from({ length: this.trackCount }, emptyTrack)
    this.bottomPool = Array.from({ length: this.trackCount }, emptyTrack)
  }

  /** 同轨道前后两条的最小水平间隙 */
  private gap(): number {
    return this.fontSize * 0.8
  }

  /**
   * 分配一条弹幕的轨道。
   * @returns 轨道索引；`null` = 此刻屏满，调用方应丢弃（不排队）
   */
  allocate(mode: DanmakuMode, t: number, textWidth: number, speed: number): number | null {
    if (this.trackCount <= 0) return null
    if (mode === 'scroll') {
      for (let i = 0; i < this.trackCount; i++) {
        if (this.scrollTrackOk(this.scroll[i], t, textWidth)) {
          this.scroll[i] = { lastT: t, lastW: textWidth, lastV: speed, busyUntil: -1e9 }
          return i
        }
      }
      return null
    }
    const pool = mode === 'top' ? this.topPool : this.bottomPool
    for (let i = 0; i < this.trackCount; i++) {
      if (pool[i].busyUntil <= t) {
        pool[i] = { lastT: t, lastW: textWidth, lastV: 0, busyUntil: t }
        return i
      }
    }
    return null
  }

  /** 固定弹幕占位：单独调用，因为它的结束时间要靠渲染层回填 */
  occupy(mode: 'top' | 'bottom', track: number, until: number): void {
    const pool = mode === 'top' ? this.topPool : this.bottomPool
    if (track >= 0 && track < pool.length) pool[track].busyUntil = until
  }

  private scrollTrackOk(st: TrackState, t: number, w: number): boolean {
    if (st.lastV <= 0) return true // 空轨道
    const elapsed = t - st.lastT
    if (elapsed < 0) return false // 时间倒退（乱序输入）→ 保守拒绝
    const travelled = st.lastV * elapsed
    const okEnter = travelled >= st.lastW + this.gap()
    const okFollow = travelled >= w + this.gap()
    return okEnter && okFollow
  }

  /** 轨道纵坐标（文字左上角） */
  trackY(track: number, mode: DanmakuMode = 'scroll'): number {
    if (mode === 'bottom') {
      return this.height - this.padY - (track + 1) * this.lineHeight + (this.lineHeight - this.fontSize) / 2
    }
    return this.padY + track * this.lineHeight + (this.lineHeight - this.fontSize) / 2
  }

  /** 诊断快照（E2E / 调试面板用） */
  snapshot(): { trackCount: number; scroll: TrackState[] } {
    return { trackCount: this.trackCount, scroll: this.scroll.map((s) => ({ ...s })) }
  }
}

/**
 * 轨道算法自检：不依赖测试框架，由 E2E 脚本调用。
 * 覆盖「同刻不重叠 / 隔久了能复用 / 屏满丢弃 / 时间倒退保守拒绝」四类关键行为。
 */
export function selfTest(): { pass: boolean; failures: string[] } {
  const failures: string[] = []
  const check = (cond: boolean, msg: string): void => {
    if (!cond) failures.push(msg)
  }

  // 1) 同一时刻连发：必须落在不同轨道
  {
    const a = new TrackAllocator()
    a.resize(1920, 1080, 36)
    const t1 = a.allocate('scroll', 10, 200, 300)
    const t2 = a.allocate('scroll', 10, 200, 300)
    check(t1 !== null && t2 !== null, '同刻两条应都能分配')
    check(t1 !== t2, '同刻两条不应落在同一轨道')
  }

  // 2) 隔足够久：同轨道可复用（宽度相同才能保证是同一轨道）
  {
    const a = new TrackAllocator()
    a.resize(1920, 1080, 36)
    const t1 = a.allocate('scroll', 0, 200, 300)
    // 速度 300px/s，跑了 30s = 9000px，远超 200+gap → 一定可复用
    const t2 = a.allocate('scroll', 30, 200, 300)
    check(t1 === t2, `同轨道应可复用（t1=${t1} t2=${t2}）`)
  }

  // 3) 屏满必须返回 null（而不是回落到 0 号轨道造成重叠）
  {
    const a = new TrackAllocator({ maxTracks: 3 })
    a.resize(640, 120, 30) // 120px 高，lineHeight 43.5 → 2 条轨道
    const n = a.trackCount
    let ok = 0
    for (let i = 0; i < n; i++) {
      if (a.allocate('scroll', 1, 100, 200) !== null) ok++
    }
    check(a.allocate('scroll', 1, 100, 200) === null, `屏满应丢弃（实际轨道数 ${n}, 成功 ${ok}）`)
  }

  // 4) 时间倒退：同轨道拒绝，但其他轨道仍可用
  {
    const a = new TrackAllocator()
    a.resize(1920, 1080, 36)
    const t1 = a.allocate('scroll', 10, 200, 300)
    const t2 = a.allocate('scroll', 9, 200, 300)
    check(t1 === 0, '首条应落 0 号轨道')
    check(t2 === 1, '时间倒退时 0 号轨道应拒绝，改落 1 号')
  }

  // 5) 顶部 / 底部互不干扰
  {
    const a = new TrackAllocator()
    a.resize(1920, 1080, 36)
    const top = a.allocate('top', 5, 100, 0)
    const bottom = a.allocate('bottom', 5, 100, 0)
    check(top !== null && bottom !== null, '顶/底应各自可分配')
    // 顶部占位后同轨道应被拒绝
    a.occupy('top', top!, 5 + 5)
    check(a.allocate('top', 6, 100, 0) !== top, '顶部占位期内不应复用同轨道')
  }

  // 6) 追尾保护：宽度极大者不能紧贴前一条
  {
    const a = new TrackAllocator()
    a.resize(1920, 1080, 36)
    a.allocate('scroll', 0, 50, 300) // 很窄
    // 前一条只跑了 0.1s（30px），远不够容纳 1500px 的新弹幕
    const t2 = a.allocate('scroll', 0.1, 1500, 200)
    check(t2 !== 0, '超宽弹幕不应紧贴在同轨道的窄弹幕后面（会遮挡）')
  }

  // 7) 纵坐标：顶部在上、底部在下，且不越界
  {
    const a = new TrackAllocator()
    a.resize(1920, 1080, 36)
    const yTop = a.trackY(0, 'scroll')
    const yBottom = a.trackY(0, 'bottom')
    check(yTop >= 0 && yTop < 100, `顶部 y 应在安全区（实际 ${yTop}）`)
    check(yBottom > 900 && yBottom <= 1080, `底部 y 应贴近下边界（实际 ${yBottom}）`)
  }

  return { pass: failures.length === 0, failures }
}
