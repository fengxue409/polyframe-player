/**
 * P17 弹幕高级特效：覆盖层桥接（主窗口 renderer 侧）。
 *
 * 把「主窗口 → 主进程 → 覆盖层」的命令封装成函数；浏览器调试模式
 * （无 polyframe API）下全部静默空操作，调用方无需判环境。
 */

import type { DanmakuItem } from '@polyframe/shared'
import type { EngineOptions } from './engine'

export interface OverlayRect {
  left: number
  top: number
  width: number
  height: number
}

interface Api {
  overlayCmd(payload: unknown): void
  onOverlayReady(cb: () => void): () => void
}

function api(): Api | null {
  const w = window as unknown as { polyframe?: Partial<Api> }
  return w.polyframe && typeof w.polyframe.overlayCmd === 'function' ? (w.polyframe as Api) : null
}

export function overlayAvailable(): boolean {
  return api() !== null
}

export function overlayEnsure(): void {
  api()?.overlayCmd({ type: 'ensure' })
}

export function overlayShow(): void {
  api()?.overlayCmd({ type: 'show' })
}

export function overlayHide(): void {
  api()?.overlayCmd({ type: 'hide' })
}

export function overlayEnabled(on: boolean): void {
  api()?.overlayCmd({ type: 'enabled', on })
}

export function overlaySetItems(items: DanmakuItem[], sourceDuration: number | null): void {
  api()?.overlayCmd({ type: 'items', items, sourceDuration })
}

export function overlaySetOpts(opts: EngineOptions): void {
  api()?.overlayCmd({ type: 'opts', opts })
}

export function overlaySetDuration(duration: number | null): void {
  api()?.overlayCmd({ type: 'duration', duration })
}

export function overlaySeek(seconds: number): void {
  api()?.overlayCmd({ type: 'seek', seconds })
}

export function overlayReset(): void {
  api()?.overlayCmd({ type: 'reset' })
}

export function overlayPush(item: DanmakuItem): void {
  api()?.overlayCmd({ type: 'push', item })
}

/** 视频区矩形（主窗口视口坐标）——覆盖层据此定位弹幕画布 */
export function overlayRect(rect: OverlayRect): void {
  api()?.overlayCmd({ type: 'rect', rect })
}

/** 覆盖层加载完成（重发全量状态的时机） */
export function overlayOnReady(cb: () => void): () => void {
  return api()?.onOverlayReady(cb) ?? (() => {})
}
