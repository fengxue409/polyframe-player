/**
 * 弹幕时钟：把「hls 内核」和「libmpv 内核」两套时间源抹平成同一接口。
 *
 * 为什么必须统一：
 *  - hls 内核可直接读 `HTMLVideoElement.currentTime`，每帧精确；
 *  - libmpv 内核的时间来自**事件推送**（`mpv.state`，250ms 一次），
 *    直接拿它当帧时钟会让弹幕一跳一跳，看起来像掉帧。
 *
 * 所以 mpv 侧用「事件锚点 + 墙钟插值」：收到状态时记下
 * `(媒体时间, performance.now())`，帧内按墙钟线性外推。
 * 同时必须检测 **seek**（媒体时间跳变）与 **pause**，否则插值会跑飞。
 */

export interface DanmakuClock {
  /** 当前媒体时间（秒） */
  now(): number
  /** 是否在播放（暂停时不推进调度） */
  isPlaying(): boolean
}

/** hls / 原生 `<video>`：直读，无插值误差 */
export class MediaElementClock implements DanmakuClock {
  constructor(private readonly el: HTMLVideoElement) {}

  now(): number {
    const t = this.el.currentTime
    return Number.isFinite(t) ? t : 0
  }

  isPlaying(): boolean {
    return !this.el.paused && !this.el.ended && this.el.readyState >= 2
  }
}

export interface MpvClockState {
  timePos?: number | null
  duration?: number | null
  pause?: boolean
  eof?: boolean
}

/** 单次外推上限：事件长时间不来时避免时间无限跑飞（如窗口被挂起） */
const MAX_EXTRAPOLATE_SECS = 1.2

/**
 * libmpv 内核：事件锚点 + 墙钟插值
 *
 * `seekTo` 必须在调用 mpv.seek 后立刻调用，把本地锚点先掰过去 ——
 * 否则从发起 seek 到下一个 state 事件之间（最多 250ms），
 * 弹幕会按旧时间轴继续跑，视觉上出现「弹幕倒退」。
 */
export class MpvInterpolatedClock implements DanmakuClock {
  private anchorMedia = 0
  private anchorWall = 0
  private playing = false
  private paused = true
  private duration: number | null = null

  /** 每收到一次 mpv.state 调用 */
  update(state: MpvClockState): void {
    const media = Number.isFinite(state.timePos as number) ? (state.timePos as number) : 0
    const now = performance.now()

    // 每次事件都以 mpv 报的 timePos 为准重锚：mpv 的时间是权威值，
    // 插值只负责补两次事件之间的帧。若事件本身发生跳变（seek/换片），
    // 因为已经重锚，下一次 now() 会直接落在新时间轴上，不会拖影。
    this.anchorMedia = media
    this.anchorWall = now
    this.duration = state.duration ?? this.duration
    this.paused = !!state.pause || !!state.eof
    this.playing = !this.paused
  }

  /** 主动 seek：立即把锚点掰到目标时间，避免 250ms 的状态空窗期 */
  seekTo(seconds: number): void {
    this.anchorMedia = Math.max(0, seconds)
    this.anchorWall = performance.now()
  }

  /** 换片：彻底清空状态 */
  reset(): void {
    this.anchorMedia = 0
    this.anchorWall = performance.now()
    this.playing = false
    this.paused = true
    this.duration = null
  }

  private predict(): number {
    if (!this.playing || this.paused) return this.anchorMedia
    const elapsed = (performance.now() - this.anchorWall) / 1000
    return this.anchorMedia + Math.min(Math.max(elapsed, 0), MAX_EXTRAPOLATE_SECS)
  }

  now(): number {
    const t = this.predict()
    if (this.duration != null && this.duration > 0) {
      return Math.min(t, this.duration)
    }
    return t
  }

  isPlaying(): boolean {
    return this.playing && !this.paused
  }

  getDuration(): number | null {
    return this.duration
  }

  /** 诊断：当前锚点与原始值（调试面板展示） */
  debug(): { anchor: number; predicted: number; playing: boolean } {
    return { anchor: this.anchorMedia, predicted: this.predict(), playing: this.playing }
  }
}

/**
 * 视频被替换 / seek 时通知引擎「时间轴不连续」。
 *
 * 引擎据此丢弃在屏弹幕并重建 —— 不做这一步的话，
 * seek 之后在屏弹幕会保持旧速度继续飞出屏幕，与新媒体时间完全脱节。
 */
export function isDiscontinuity(prev: number, next: number): boolean {
  if (!Number.isFinite(prev) || !Number.isFinite(next)) return true
  if (next < prev - 0.35) return true // 倒退
  if (next - prev > 1.5) return true // 大幅前进（seek / 长时间卡顿后恢复）
  return false
}
