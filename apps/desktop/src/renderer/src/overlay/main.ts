/**
 * P17 弹幕高级特效：透明覆盖层渲染页（libmpv 内核专用）。
 *
 * 职责单一：在透明窗口里用与 hls 路径**同一套** DanmakuEngine 画弹幕。
 *
 * 数据流（全部经 IPC，本页不联网、不跑 Vue）：
 *  - 主窗口 renderer → main → `pf:overlay-apply`：items/opts/duration/seek/
 *    reset/push/rect/enabled 八种命令；
 *  - 内核事件 → main → `pf:event`：只消费 mpv.state 喂 MpvInterpolatedClock
 *    （与主窗口 DanmakuLayer 同一套插值逻辑，误差 < 1 帧）。
 *
 * 时钟选型说明：不用「renderer 推 currentTime」方案 —— 60fps 推流既费 IPC
 * 又要自己做插值；直接复用 mpv.state 事件锚点（250ms 一次 + 墙钟外推），
 * 两边时钟天然同源，最多差一个事件周期。
 */

import type { DanmakuItem } from '@polyframe/shared'
import { DanmakuEngine } from '../danmaku/engine'
import { MpvInterpolatedClock } from '../danmaku/clock'

interface OverlayRect {
  left: number
  top: number
  width: number
  height: number
}

interface ApplyPayload {
  type: 'items' | 'opts' | 'duration' | 'seek' | 'reset' | 'push' | 'rect' | 'enabled'
  items?: DanmakuItem[]
  sourceDuration?: number | null
  opts?: Partial<Parameters<DanmakuEngine['setOptions']>[0]>
  seconds?: number
  duration?: number | null
  item?: DanmakuItem
  rect?: OverlayRect
  on?: boolean
}

interface PolyframeOverlayApi {
  onOverlayApply(cb: (payload: ApplyPayload) => void): () => void
  onOverlayReady(cb: () => void): () => void
  overlayCmd(payload: unknown): void
  onEvent(cb: (ev: { method?: string; params?: unknown }) => void): () => void
}

const api = (window as unknown as { polyframe?: PolyframeOverlayApi }).polyframe

const canvas = document.getElementById('dm-canvas') as HTMLCanvasElement | null
const rectEl = document.getElementById('dm-rect') as HTMLDivElement | null

if (!api || !canvas || !rectEl) {
  // 浏览器直接打开 / 环境异常：静默不渲染（覆盖层缺了弹幕不算致命故障）
  console.warn('[overlay] polyframe API 不可用，弹幕覆盖层停用')
} else {
  const clock = new MpvInterpolatedClock()
  const engine = new DanmakuEngine(canvas, clock)
  let enabled = false
  let hasItems = false

  function startIfReady(): void {
    // 播放中才跑渲染循环（与主窗口 DanmakuLayer 的启停语义一致）
    if (enabled && hasItems && clock.isPlaying()) engine.start()
    else engine.stop()
  }

  api.onOverlayApply((p) => {
    switch (p.type) {
      case 'items': {
        engine.setItems(p.items ?? [], p.sourceDuration ?? null)
        hasItems = (p.items?.length ?? 0) > 0
        startIfReady()
        break
      }
      case 'opts':
        engine.setOptions(p.opts ?? {})
        break
      case 'duration':
        engine.setDuration(p.duration ?? null)
        break
      case 'seek':
        if (typeof p.seconds === 'number') {
          clock.seekTo(p.seconds)
          engine.seek(p.seconds)
          startIfReady()
        }
        break
      case 'reset':
        clock.reset()
        engine.seek(0)
        engine.stop()
        break
      case 'push':
        if (p.item) {
          engine.send(p.item)
          hasItems = true
          startIfReady()
        }
        break
      case 'rect': {
        const r = p.rect
        if (!r) break
        rectEl.style.left = `${r.left}px`
        rectEl.style.top = `${r.top}px`
        rectEl.style.width = `${r.width}px`
        rectEl.style.height = `${r.height}px`
        // 尺寸变化必须主动触发一次重排（ResizeObserver 在 mpv 模式同样可能漏报）
        engine.resize(true)
        break
      }
      case 'enabled':
        enabled = !!p.on
        if (enabled) startIfReady()
        else {
          engine.stop()
        }
        break
    }
  })

  // 内核事件：只吃 mpv.state（时间锚点 + 播放状态），其余忽略
  api.onEvent((ev) => {
    if (ev.method !== 'mpv.state') return
    const s = (ev.params ?? {}) as {
      timePos?: number | null
      duration?: number | null
      pause?: boolean
      eof?: boolean
    }
    clock.update({ timePos: s.timePos, duration: s.duration, pause: s.pause, eof: s.eof })
    startIfReady()
  })

  // 主窗口 renderer 收到 ready 后会重发全量状态；这里再主动要一次，防通知早于订阅
  api.onOverlayReady(() => {})

  // 挂调试句柄（E2E 诊断用）
  ;(window as unknown as Record<string, unknown>).__pfOverlay = {
    engine,
    stats: () => engine.stats()
  }

  // 页面就绪：通知主进程（转发给主窗口 renderer 重发状态）
  api.overlayCmd({ type: 'ready' })
}
