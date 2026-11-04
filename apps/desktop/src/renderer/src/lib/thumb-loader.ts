/**
 * P33 视频缩略图加载器
 *
 * 缩略图的真实来源是片源站的封面 URL，统一走内核 `/pic/{token}?u=` 代理：
 * 代理侧已有 `src_cache(poster)` + `Cache-Control: max-age=86400`，
 * 所以这里**不再自己存盘**，只解决浏览器这一层的问题：
 *
 * 1. 懒加载 —— 由调用方（IntersectionObserver）决定何时 `load()`，进视口才发请求；
 * 2. 并发闸门 —— 一页几十张封面同时打代理会拖慢首屏，限制同时在飞的请求数；
 * 3. in-flight 去重 —— 同一张图被多张卡复用（聚合后很常见）时只发一次；
 * 4. 内存记录 —— 记住成功/失败，避免滚来滚去反复请求；
 * 5. 失败退避 —— 图床挂掉时不重试风暴，冷却期内直接判失败。
 *
 * 刻意不做「重试换 URL」：封面是签名/防盗链资源，换参大概率还是失败，
 * 重试一次同 URL 足够覆盖偶发抖动。
 */

export type ThumbState = 'idle' | 'loading' | 'ready' | 'error'

/** 同时进行的请求数上限（代理单张封面几百 KB，6 路已能吃满本地回环） */
const MAX_CONCURRENT = 6
/** 失败冷却期：期间同一 URL 直接返回 error，不再发请求 */
const FAIL_COOLDOWN_MS = 10 * 60_000
/** 内存记录上限，超出按插入顺序淘汰最旧的 */
const RECORD_LIMIT = 400

interface Record {
  state: ThumbState
  url: string
  /** 失败时间戳（冷却判断用） */
  failedAt: number
  /** 已重试次数 */
  retries: number
}

/**
 * 图片去重键。
 *
 * 同一张海报在源站常见多种写法，直接按 URL 字符串比会被当成多张：
 * - `https://img/a.jpg` / `https://img/a.jpg#poster`
 * - `https://img/a.jpg@720w.jpg`（又拍云缩略）
 * - `https://img/a.jpg?x-oss-process=image/resize,w_300`（OSS 缩略）
 *
 * 带签名/鉴权的 query 不能丢（丢了取不到图），所以只剥掉纯「尺寸类」参数。
 */
const SIGN_QS = /(^|&)(sign|signature|auth|token|expires?|e|key)=/i
const SIZE_QS = /^(x-oss-process|imageview2|imageview|thumbnail|resize|w|h|width|height|quality|q|format|fm)$/i

export function thumbKey(url: string): string {
  const raw = (url || '').trim()
  if (!raw) return ''
  const hashAt = raw.indexOf('#')
  const noHash = hashAt >= 0 ? raw.slice(0, hashAt) : raw
  const qAt = noHash.indexOf('?')
  let base = qAt >= 0 ? noHash.slice(0, qAt) : noHash
  const qs = qAt >= 0 ? noHash.slice(qAt + 1) : ''
  // 又拍云/微博风格的 `@720w`、`!w200` 后缀
  base = base.replace(/[@!][0-9a-z_]+(\.(jpg|jpeg|png|webp))?$/i, '')
  if (!qs || SIGN_QS.test(qs)) return base + (qs ? `?${qs}` : '')
  const kept = qs
    .split('&')
    .filter((kv) => {
      const k = kv.split('=')[0]
      return k && !SIZE_QS.test(k)
    })
    .join('&')
  return kept ? `${base}?${kept}` : base
}

type Listener = () => void

export class ThumbLoader {
  private records = new Map<string, Record>()
  private queue: { key: string; url: string }[] = []
  private running = 0
  private listeners = new Set<Listener>()

  /** 状态快照（读）；组件里配合响应式包装使用 */
  peek(url: string): ThumbState {
    const k = thumbKey(url)
    return k ? (this.records.get(k)?.state ?? 'idle') : 'error'
  }

  /** 订阅状态变化（返回取消函数） */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }

  private touch(key: string, url: string): Record {
    const hit = this.records.get(key)
    if (hit) {
      // 刷新插入顺序（Map 保序，实现 LRU 淘汰）
      this.records.delete(key)
      this.records.set(key, hit)
      return hit
    }
    const rec: Record = { state: 'idle', url, failedAt: 0, retries: 0 }
    this.records.set(key, rec)
    if (this.records.size > RECORD_LIMIT) {
      const oldest = this.records.keys().next().value
      if (oldest && this.records.get(oldest)?.state !== 'loading') this.records.delete(oldest)
    }
    return rec
  }

  /**
   * 请求一张缩略图。幂等：重复调用只会排队一次。
   * 返回当前状态，便于调用方立即渲染。
   */
  load(url: string): ThumbState {
    if (!url) return 'error'
    const key = thumbKey(url)
    if (!key) return 'error'
    const rec = this.touch(key, url)
    if (rec.state === 'ready') return 'ready'
    if (rec.state === 'loading') return 'loading'
    if (rec.state === 'error') {
      // 冷却期内不再打；过冷却期允许重新排队
      if (Date.now() - rec.failedAt < FAIL_COOLDOWN_MS) return 'error'
      rec.state = 'idle'
    }
    if (this.running < MAX_CONCURRENT) this.start(key, rec)
    else this.queue.push({ key, url })
    return rec.state
  }

  /** 批量预取（可选；一般由 IntersectionObserver 逐张触发） */
  prefetch(urls: string[]): void {
    for (const u of urls) this.load(u)
  }

  private start(key: string, rec: Record): void {
    rec.state = 'loading'
    this.running += 1
    this.emit()
    const img = new Image()
    // 封面可能来自需要 Referer 的图床；代理侧已补 Referer，这里不再带
    img.referrerPolicy = 'no-referrer'
    img.decoding = 'async'
    const finish = (ok: boolean): void => {
      this.running -= 1
      if (ok) {
        rec.state = 'ready'
        rec.failedAt = 0
      } else if (rec.retries < 1) {
        // 偶发失败给一次机会；仍失败则进入冷却
        rec.retries += 1
        rec.state = 'idle'
        this.queue.unshift({ key, url: rec.url })
      } else {
        rec.state = 'error'
        rec.failedAt = Date.now()
      }
      this.pump()
      this.emit()
    }
    img.onload = () => finish(true)
    img.onerror = () => finish(false)
    img.src = rec.url
  }

  private pump(): void {
    while (this.running < MAX_CONCURRENT && this.queue.length) {
      const job = this.queue.shift()
      if (!job) break
      const rec = this.records.get(job.key)
      if (!rec || rec.state === 'ready' || rec.state === 'loading') continue
      this.start(job.key, rec)
    }
  }

  /** 统计（验收与调试用） */
  stats(): { total: number; ready: number; error: number; loading: number } {
    let ready = 0
    let error = 0
    let loading = 0
    for (const r of this.records.values()) {
      if (r.state === 'ready') ready += 1
      else if (r.state === 'error') error += 1
      else if (r.state === 'loading') loading += 1
    }
    return { total: this.records.size, ready, error, loading }
  }

  /** 清空（切库/退出时用；正常使用不需要） */
  reset(): void {
    this.records.clear()
    this.queue = []
    this.emit()
  }
}

/** 全局单例：缩略图缓存天然是进程级的，组件销毁不该丢 */
export const thumbLoader = new ThumbLoader()
