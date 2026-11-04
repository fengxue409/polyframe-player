/**
 * P17 弹幕特效：纯函数工具（颜色变换 / 图片弹幕识别）。
 *
 * 与 engine.ts 分离的原因：这里不含任何 DOM/Canvas 依赖，
 * 逻辑可独立验证；engine 只消费结果。
 */

export type DanmakuFx = 'glow' | 'gradient' | null

export interface Rgb {
  r: number
  g: number
  b: number
}

/** `#RRGGBB` → RGB；非法输入返回白色（与内核 normalize_color 的兜底语义一致） */
export function parseHexColor(raw: string): Rgb {
  const m = /^#([0-9a-fA-F]{6})$/.exec(raw.trim())
  if (!m) return { r: 255, g: 255, b: 255 }
  const n = parseInt(m[1], 16)
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff }
}

const clamp255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)))

export function toCss({ r, g, b }: Rgb): string {
  return `rgb(${clamp255(r)},${clamp255(g)},${clamp255(b)})`
}

/**
 * 提亮：向白色靠拢。`t=0` 原色，`t=1` 纯白。
 * 渐变弹幕用它生成同色系亮端，保证与用户选的主色协调。
 */
export function lighten(c: Rgb, t: number): Rgb {
  const k = Math.max(0, Math.min(1, t))
  return {
    r: c.r + (255 - c.r) * k,
    g: c.g + (255 - c.g) * k,
    b: c.b + (255 - c.b) * k
  }
}

/**
 * 渐变弹幕的暗端：向黑靠拢一点再压一点饱和感（数值经验值）。
 * 只做「亮→主色→暗」三停渐变里的暗端，视觉上比纯黑白渐变柔和。
 */
export function darken(c: Rgb, t: number): Rgb {
  const k = Math.max(0, Math.min(1, t))
  return { r: c.r * (1 - k), g: c.g * (1 - k), b: c.b * (1 - k) }
}

/** 图片弹幕识别：text 本身是图片地址时按图片渲染（不发请求的 data: 也支持） */
export function isImageUrl(text: string): boolean {
  const s = text.trim()
  if (/^data:image\/(png|jpe?g|gif|webp|bmp|apng);base64,[a-z0-9+/=]+$/i.test(s)) return true
  // http(s)：扩展名白名单，避免把普通链接弹幕误渲染成裂图
  return /^https?:\/\/\S+\.(png|jpe?g|gif|webp|bmp|apng)(\?\S*)?$/i.test(s)
}

/**
 * 特效白名单校验（与 Rust normalize_fx 同构）。
 * 内核已过滤一次，这里兜底防 IPC 直传脏值。
 */
export function normalizeFx(raw: unknown): DanmakuFx {
  if (raw === 'glow' || raw === 'gradient') return raw
  return null
}
