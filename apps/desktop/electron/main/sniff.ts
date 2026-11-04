//! P10 解析嗅探：用隐藏窗口实跑第三方播放页，从网络请求里截媒体直链
//!
//! 为什么不是纯 HTTP 抓页面：解析页的直链是页面 JS 在运行时向自己的后端换来的，
//! curl 拿到的那份 HTML 里根本没有 m3u8。所以这里起一个不可见 BrowserWindow
//! （独立内存分区 + 静音 + 后台不节流），监听 `onBeforeRequest`：
//!  - HLS / MP4 / FLV / MPD 的请求 URL 直接命中
//!  - 顺带轮询 `video.currentSrc`（直嵌 mp4 的页面不发 XHR，也能覆盖）
//!  - 自动尝试点击播放按钮 / 调 video.play()（部分页面等用户手势才拉流）
//!
//! 抓到的 URL 交回渲染层 → 走本地代理播放（缓存 / libmpv / 断点续传全部复用）。

import { BrowserWindow, session, shell, type Session } from 'electron'

/** 媒体请求特征（片段 .ts/.m4s 不进候选，避免几百条噪声） */
const MEDIA_RE = /\.(m3u8|mp4|flv|mpd)(\?|#|$)/i

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36'

export interface SniffResult {
  ok: boolean
  /** 选中的直链（m3u8 优先） */
  playUrl?: string
  /** 全部候选（按发现顺序） */
  candidates: string[]
  ms: number
  error?: string
}

/** 打开过的独立窗口（防止被 GC 掉；关闭时移除） */
const parseWindows = new Set<BrowserWindow>()

/** m3u8 优先，其次 mp4/flv/mpd */
function pick(candidates: string[]): string | undefined {
  return (
    candidates.find((u) => /\.m3u8(\?|#|$)/i.test(u)) ??
    candidates.find((u) => /\.(mp4|flv|mpd)(\?|#|$)/i.test(u))
  )
}

/**
 * 嗅探页面里的媒体直链。
 * @param pageUrl 已经拼好接口参数的播放页地址
 * @param timeoutMs 最长等待（默认 15s；接口慢时由调用方放大）
 */
export async function sniffMediaUrl(pageUrl: string, timeoutMs = 15_000): Promise<SniffResult> {
  const t0 = Date.now()
  if (!/^https?:\/\//i.test(pageUrl)) {
    return { ok: false, candidates: [], ms: 0, error: '页面地址无效' }
  }

  // 独立内存分区：cookie/缓存与主窗口隔离，窗口销毁即回收
  const partition = `pf-sniff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const ses: Session = session.fromPartition(partition, { cache: false })

  const candidates: string[] = []
  let settle: ((u: string | null) => void) | null = null

  const hit = (raw: string): void => {
    if (!raw || !/^https?:\/\//i.test(raw)) return
    const u = raw.split('#')[0]
    if (!MEDIA_RE.test(u) || candidates.includes(u)) return
    candidates.push(u)
    // 拿到 m3u8 就立刻收工；只有 mp4 时再等一等（后面可能还有 HLS 正片）
    if (/\.m3u8(\?|$)/i.test(u) && settle) {
      settle(u)
      settle = null
    }
  }

  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    hit(details.url)
    callback({})
  })

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 760,
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      // 无用户手势也要允许自动播放，否则播放器不拉流
      autoplayPolicy: 'no-user-gesture-required'
    }
  })
  win.webContents.setAudioMuted(true)
  win.webContents.setUserAgent(BROWSER_UA)
  // 页面自己弹的窗口（部分播放器广告/跳转）直接放行到系统浏览器，不在应用内开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) hit(url)
    return { action: 'deny' }
  })

  // 只销毁窗口：分区是内存态且无其它引用，随之回收（不放监听器引用自然失效）
  const cleanup = (): void => {
    if (!win.isDestroyed()) win.destroy()
  }

  const waitForHit = new Promise<string | null>((resolve) => {
    settle = resolve
  })

  // 轮询 DOM：直嵌 <video src> 的页面不发 XHR，也要能抓到
  const poll = setInterval(() => {
    if (win.isDestroyed()) return
    void win.webContents
      .executeJavaScript(
        `(() => {
           const v = document.querySelector('video')
           if (!v) return ''
           return v.currentSrc || v.src || ''
         })()`,
        true
      )
      .then((src) => {
        if (typeof src === 'string' && src) {
          // blob: 是 MSE 的内存句柄，没用；只要 http(s)
          hit(src)
        }
      })
      .catch(() => {})
  }, 700)

  // 自动点播放：部分页面必须点一下才请求 manifest
  const clicker = setInterval(() => {
    if (win.isDestroyed()) return
    void win.webContents
      .executeJavaScript(
        `(() => {
           const sel = ['.vjs-big-play-button', '.dplayer-play-icon', '.artplayer-plugin-play',
                        '[class*="play-btn"]', '[class*="playBtn"]', 'video']
           for (const s of sel) {
             const el = document.querySelector(s)
             if (el) { try { el.click() } catch {} }
           }
           const v = document.querySelector('video')
           if (v && v.paused) { try { v.play() } catch {} }
           return true
         })()`,
        true
      )
      .catch(() => {})
  }, 1800)

  let loadError = ''
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    // 子资源失败很常见，只记主框架的失败
    if (code <= -100 && code >= -199) loadError = `${desc} (${code})`
  })

  try {
    await win.loadURL(pageUrl).catch(() => {})
  } catch {
    // loadURL 失败交给下面统一判定
  }

  // 等：命中 m3u8 立即返回；否则等超时后取已有候选（可能只有 mp4）
  const hitUrl = await Promise.race([
    waitForHit,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))
  ])
  clearInterval(poll)
  clearInterval(clicker)

  const best = hitUrl ?? pick(candidates)
  const result: SniffResult = best
    ? { ok: true, playUrl: best, candidates: [...candidates], ms: Date.now() - t0 }
    : {
        ok: false,
        candidates: [...candidates],
        ms: Date.now() - t0,
        error: loadError
          ? `页面加载失败：${loadError}`
          : '未捕获到媒体地址（页面可能需要登录、点播或人机验证）'
      }

  cleanup()
  return result
}

/**
 * 用独立窗口打开播放页（嗅探失败时的人工兜底：能看、能登录、能点播）。
 * 与主窗口共享 `persist:parse` 分区，登录态可复用。
 */
export function openParseWindow(url: string): { ok: boolean } {
  if (!/^https?:\/\//i.test(url)) return { ok: false }
  const win = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    title: 'PolyFrame 解析播放',
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'persist:parse',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.webContents.setAudioMuted(false)
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) void shell.openExternal(target)
    return { action: 'deny' }
  })
  void win.loadURL(url).catch(() => {})
  parseWindows.add(win)
  win.on('closed', () => parseWindows.delete(win))
  return { ok: true }
}

/** 应用退出前关掉所有解析窗口（避免窗口句柄拖住 quit） */
export function closeParseWindows(): void {
  for (const w of parseWindows) {
    if (!w.isDestroyed()) w.destroy()
  }
  parseWindows.clear()
}
