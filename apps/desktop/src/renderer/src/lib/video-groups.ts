/**
 * P33 视频维度聚合
 *
 * 媒体库「下载内容」原来是一条任务一张卡：同一部剧看了 6 集就有 6 张卡，
 * 各自一张封面，既重复又看不出「这是同一部片」。这里把任务归并到「视频」这一维。
 *
 * ## 聚合键只有四级证据，不做无证据的猜测
 *
 * 1. `fav:<favoriteId>` —— 任务的 URL 精确命中某条收藏剧集（最强）；
 * 2. `fav:<favoriteId>` —— 标题归一后与某个收藏名完全相同（次强，靠名称而非猜测）；
 * 3. `hist:<hkey>` —— URL 命中播放历史（同一集）；
 * 4. `dir:<host><dir>` —— URL 的**集数目录**相同（`/S01/E02/`、`/第03集/`），
 *    这是纯结构证据，只对「目录末段确实是集数标记」的地址启用；
 * 5. 以上都不成立 → `url:<归一化 URL>`，一个任务独立成组。
 *
 * 刻意不做「模糊标题聚类」：P32 的教训是靠标题猜剧名会把《流浪地球》和
 * 《流浪地球2》并成一部，错并比不并更难发现。宁可留成两张卡。
 */

import type { Favorite, FavoriteSource, PlayHistoryItem, Task } from '@polyframe/shared'
import { thumbKey } from './thumb-loader'

export interface VideoThumb {
  /** 原始封面 URL（带签名，不可用去重键代替） */
  url: string
  /** 去重键（归一化后的 URL） */
  key: string
  /** 这张图来自哪里，用于缩略图条的角标提示 */
  source: string
}

export type GroupOrigin = 'favorite' | 'history' | 'series-dir' | 'single'

export interface VideoGroup {
  key: string
  origin: GroupOrigin
  title: string
  /** 副标题：来源站 / 集数说明 */
  subtitle: string
  /** 去重后的缩略图，[0] 是封面 */
  thumbs: VideoThumb[]
  /** 组内任务，新的在前 */
  tasks: Task[]
  favoriteId?: string
  /** 组状态汇总：有进行中 = active；否则有失败 = failed；全就绪 = done */
  status: 'active' | 'done' | 'failed'
  updatedAt: number
}

export interface BuildGroupsInput {
  tasks: Task[]
  favorites: Favorite[]
  /** 按收藏 id 分组的片源（含各自 poster / episodes） */
  sourcesByFav: Record<string, FavoriteSource[]>
  history: PlayHistoryItem[]
}

/** 媒体地址归一：去 query/hash、去尾斜杠、host 小写。用于 URL → 归属的精确匹配 */
export function mediaKey(url: string): string {
  const raw = (url || '').trim()
  if (!raw) return ''
  try {
    const u = new URL(raw)
    const path = u.pathname.replace(/\/+$/, '')
    return `${u.protocol}//${u.host.toLowerCase()}${path}`
  } catch {
    const hashAt = raw.indexOf('#')
    const noHash = hashAt >= 0 ? raw.slice(0, hashAt) : raw
    const qAt = noHash.indexOf('?')
    return (qAt >= 0 ? noHash.slice(0, qAt) : noHash).replace(/\/+$/, '').toLowerCase()
  }
}

/** 集数标记：`01`、`ep03`、`E12`、`第5集`、`S01E02`、`第 3 期` */
const EPISODE_SEG = /^(?:ep?|e|第)?\s*\d{1,4}\s*(?:集|话|期|回)?$/i
const SEASON_EP = /^s\d{1,2}e\d{1,3}$/i

/**
 * 剧集目录键：把 `/S01/E02/index.m3u8` 归到 `/S01`，把 `/剧名/第03集/index.m3u8` 归到 `/剧名`。
 *
 * 只有在「去掉的末段确实是集数标记」时才返回 key —— 否则同目录下的
 * 一堆不相关视频（比如 `/uploads/` 里几百个 mp4）会被错误并成一部片。
 */
export function seriesDirKey(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  // pathname 是百分号编码的（中文目录会被编成 %E5%89%A7），
  // 不还原的话同一条路径的两种写法会算出两个不同的键，聚合直接失效。
  let decoded = u.pathname
  try {
    decoded = decodeURIComponent(u.pathname)
  } catch {
    // 非法转义（少的站点会发）就按原样用，别抛
  }
  const segs = decoded.split('/').filter(Boolean)
  // 至少要「目录 + 文件」，纯域名或根目录文件不聚类
  if (segs.length < 2) return null
  const dir = segs.slice(0, -1) // 去掉文件名
  if (!dir.length) return null
  const last = dir[dir.length - 1]
  if (!EPISODE_SEG.test(last) && !SEASON_EP.test(last)) return null
  const parent = dir.slice(0, -1)
  if (!parent.length) return null
  return `${u.host.toLowerCase()}/${parent.join('/')}`
}

/** 标题归一：去集数/清晰度/方括号广告位，用于「与收藏名完全相同」这一级判定 */
export function normalizeTitle(s: string): string {
  return (s || '')
    .replace(/【[^】]*】|\[[^\]]*\]|\([^)]*\)|（[^）]*）/g, ' ')
    .replace(/第\s*\d{1,4}\s*[集话期回]/g, ' ')
    .replace(/\b(?:ep?|e)\d{1,4}\b/gi, ' ')
    .replace(/\b(?:s\d{1,2}e\d{1,3})\b/gi, ' ')
    .replace(/\b(?:hd|fhd|uhd|4k|8k|2160p|1080p|720p|480p|hdr|bluray|web-?dl|hdtv)\b/gi, ' ')
    .replace(/[·・,，.。:：;；\-_/\\|]+/g, ' ')
    .replace(/\s+/g, '')
    .toLowerCase()
}

function pushThumb(list: VideoThumb[], url: string | undefined, source: string): void {
  const raw = (url || '').trim()
  if (!raw) return
  const key = thumbKey(raw)
  if (!key) return
  if (list.some((t) => t.key === key)) return
  list.push({ url: raw, key, source })
}

/**
 * 组状态：有任务还在跑就是 active（最需要用户看）；
 * 否则只要有一个失败就报 failed（不能因为别的任务成功了就把失败藏起来）；
 * 全部就绪才是 done。
 */
function mergeStatus(tasks: Task[]): VideoGroup['status'] {
  let failed = 0
  for (const t of tasks) {
    if (t.status === 'ready') continue
    if (t.status === 'failed') {
      failed += 1
      continue
    }
    return 'active'
  }
  return failed > 0 ? 'failed' : 'done'
}

/**
 * 去掉标题尾部的集数/清晰度标记。
 *
 * 组标题如果照抄第一条任务的「某剧 第 3 集」，卡片上写着「3 集」却只显示「第 3 集」，
 * 看起来像这一集单独成卡。多集组的标题应该是剧名。
 */
function stripEpisodeTag(s: string): string {
  return s
    .replace(/\s*(?:第\s*\d{1,4}\s*[集话期回]|\bep?\s*\d{1,4}\b|\bs\d{1,2}\s*e\d{1,3}\b)\s*$/i, '')
    .replace(/\s*(?:hd|fhd|uhd|4k|1080p|720p|480p)\s*$/i, '')
    .replace(/\s+$/, '')
}

function pickTitle(tasks: Task[], fallback: string): string {
  const raw = tasks.map((t) => (t.title || '').trim()).filter((s) => s && !/^https?:/i.test(s))
  if (!raw.length) return (tasks[0]?.title || fallback || '').trim()
  const first = raw[0]
  // 仅当组内所有任务的标题去掉集数后完全一致，才认为它们共享一个片名
  if (raw.length > 1) {
    const base = stripEpisodeTag(first)
    if (base && raw.every((s) => stripEpisodeTag(s) === base)) return base
  }
  return first
}

export function buildVideoGroups(input: BuildGroupsInput): VideoGroup[] {
  const { tasks, favorites, sourcesByFav, history } = input

  // ---------- 索引 1：收藏剧集 URL → 收藏 ----------
  const urlToFav = new Map<string, { fav: Favorite; source: FavoriteSource }>()
  for (const fav of favorites) {
    for (const src of sourcesByFav[fav.id] ?? []) {
      for (const ep of src.episodes ?? []) {
        const k = mediaKey(ep.url)
        if (k && !urlToFav.has(k)) urlToFav.set(k, { fav, source: src })
      }
    }
  }

  // ---------- 索引 2：播放历史（URL → 条目；影片键 → 最新条目） ----------
  const urlToHist = new Map<string, PlayHistoryItem>()
  const keyToHist = new Map<string, PlayHistoryItem>()
  for (const it of history) {
    const k = mediaKey(it.episodeUrl)
    if (k) urlToHist.set(k, it)
    const prev = keyToHist.get(it.key)
    if (!prev || prev.playedAt < it.playedAt) keyToHist.set(it.key, it)
  }

  // ---------- 索引 3：收藏名（归一）→ 收藏 ----------
  const nameToFav = new Map<string, Favorite>()
  for (const fav of favorites) {
    const n = normalizeTitle(fav.name)
    if (n && !nameToFav.has(n)) nameToFav.set(n, fav)
  }

  const groups = new Map<string, VideoGroup>()
  const groupOf = (key: string, origin: GroupOrigin, title: string): VideoGroup => {
    let g = groups.get(key)
    if (!g) {
      g = {
        key,
        origin,
        title,
        subtitle: '',
        thumbs: [],
        tasks: [],
        status: 'done',
        updatedAt: 0
      }
      groups.set(key, g)
    }
    return g
  }

  for (const t of tasks) {
    const url = mediaKey(t.url)
    const hitFav = urlToFav.get(url)
    let group: VideoGroup
    let favoriteId: string | undefined

    if (hitFav) {
      favoriteId = hitFav.fav.id
      group = groupOf(`fav:${hitFav.fav.id}`, 'favorite', hitFav.fav.name)
    } else {
      const byName = nameToFav.get(normalizeTitle(t.title || ''))
      if (byName) {
        favoriteId = byName.id
        group = groupOf(`fav:${byName.id}`, 'favorite', byName.name)
      } else {
        const hist = urlToHist.get(url)
        if (hist) {
          // 历史里带 api/vodId 的片（来自采集站）用影片键；直链类用归一化 URL 兜底
          const histKey = hist.vodId ? `hist:${hist.key}` : `hist:${mediaKey(hist.episodeUrl)}`
          group = groupOf(histKey, 'history', hist.title)
        } else {
          const dirKey = seriesDirKey(t.url)
          if (dirKey) group = groupOf(`dir:${dirKey}`, 'series-dir', pickTitle([t], t.url))
          else group = groupOf(`url:${url}`, 'single', pickTitle([t], t.url))
        }
      }
    }

    group.tasks.push(t)
    if (favoriteId && !group.favoriteId) group.favoriteId = favoriteId
    const ts = new Date(t.createdAt).getTime()
    if (Number.isFinite(ts) && ts > group.updatedAt) group.updatedAt = ts
  }

  // ---------- 缩略图归并与去重 ----------
  for (const g of groups.values()) {
    g.tasks.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    // 收藏组用收藏名（跨站统一）；其余组在任务收齐后重算一次 ——
    // 第一轮建组时只知道一条任务，标题必然是「某剧 第 1 集」，多集组要退回片名。
    if (!g.favoriteId) g.title = pickTitle(g.tasks, g.title)

    const thumbs: VideoThumb[] = []
    if (g.favoriteId) {
      const fav = favorites.find((f) => f.id === g.favoriteId)
      // 聚合卡封面优先（它是各站里挑出的最好那张）
      pushThumb(thumbs, fav?.poster, '收藏封面')
      for (const src of sourcesByFav[g.favoriteId] ?? []) {
        pushThumb(thumbs, src.poster, src.siteName || '片源')
      }
      // 该片的历史封面也算一张（有些片收藏时无封面，靠播放时补上）
      for (const it of keyToHist.values()) {
        if (normalizeTitle(it.title) === normalizeTitle(fav?.name ?? '')) {
          pushThumb(thumbs, it.poster, it.siteName || '播放记录')
        }
      }
    } else {
      for (const t of g.tasks) {
        const hist = urlToHist.get(mediaKey(t.url))
        if (hist) pushThumb(thumbs, hist.poster, hist.siteName || '播放记录')
      }
      if (!thumbs.length) {
        // 同组其它集的历史也可能带封面
        for (const t of g.tasks) {
          const hist = urlToHist.get(mediaKey(t.url))
          if (hist?.poster) pushThumb(thumbs, hist.poster, '播放记录')
        }
      }
    }
    g.thumbs = thumbs

    const sites = new Set<string>()
    if (g.favoriteId) {
      for (const src of sourcesByFav[g.favoriteId] ?? []) if (src.siteName) sites.add(src.siteName)
    }
    for (const t of g.tasks) {
      const hist = urlToHist.get(mediaKey(t.url))
      if (hist?.siteName) sites.add(hist.siteName)
    }
    g.subtitle = sites.size ? [...sites].slice(0, 3).join(' · ') : g.tasks.length > 1 ? `${g.tasks.length} 个任务` : ''
    g.status = mergeStatus(g.tasks)
  }

  // 新任务在前；同时间按标题稳定排序，避免每次渲染顺序抖动
  return [...groups.values()].sort((a, b) => {
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
    return a.title.localeCompare(b.title, 'zh-CN')
  })
}
