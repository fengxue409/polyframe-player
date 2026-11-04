/**
 * P39 首页「多维筛选」规则（纯函数，不依赖 Vue / pinia，便于 node 回归）。
 *
 * 组合语义（写进 UI，也写在这里，两边必须一致）：
 *   · **维度之间「与」**：类型 ∧ 地区 ∧ 年份 ∧ 热度，全部满足才命中。
 *   · **维度内部单选**：再点一次已选项 = 取消该维度（回到「全部」）。
 *   · **仅地区维度内部是 OR**：一个地区选项自带多个站方别名（「大陆|内地」），
 *     站方写「中国大陆」还是「内地」都能命中——这是数据兼容，不是多选。
 *   · **排序不是筛选**：排序只改变顺序，不改变命中集合，所以单独放在结果栏右侧。
 */
import type { CatalogStats } from '@polyframe/shared'

export type FilterKey = 'type' | 'area' | 'year' | 'heat'
export type SortKey = 'hot' | 'score' | 'hits' | 'time'
export type HeatKey = 'all' | 'd9' | 'd8' | 'd7' | 's8' | 'm3'

export interface HomeFilters {
  /** 类型：'' = 全部（服务端按 type_name 关键词匹配） */
  type: string
  /** 地区：'' = 全部；值为服务端关键词（`|` 分隔别名） */
  area: string
  /** 年份：'' = 全部；四位年份；'older' = 更早（早于 OLDER_BOUNDARY） */
  year: string
  heat: HeatKey
  sort: SortKey
}

export const DEFAULT_FILTERS: HomeFilters = {
  type: '',
  area: '',
  year: '',
  heat: 'all',
  sort: 'hot'
}

export interface Option {
  key: string
  label: string
  /** 悬停说明：写清这个选项到底筛什么，避免「3 站以上」这种自造词被误解 */
  hint?: string
}

/** 类型：与服务端 cms::category_matches 的关键词一一对应 */
export const TYPE_OPTIONS: readonly Option[] = [
  { key: '', label: '全部' },
  { key: '电影', label: '电影', hint: '只留 xxx片（含纪录片）' },
  { key: '剧集', label: '剧集', hint: '只留 xxx剧（国产剧 / 韩剧 / 美剧…）' },
  { key: '动漫', label: '动漫', hint: '只留动漫、动画类' },
  { key: '综艺', label: '综艺', hint: '只留综艺、真人秀类' }
]

/**
 * 地区：value 是**服务端匹配用的关键词**，`|` 分隔别名。
 * 站方命名极不统一（中国大陆 / 内地 / 大陆；美剧 / 美国），所以一个选项要带多个别名。
 */
export const AREA_OPTIONS: readonly Option[] = [
  { key: '', label: '全部' },
  { key: '大陆|内地', label: '大陆' },
  { key: '香港', label: '香港' },
  { key: '台湾', label: '台湾' },
  { key: '美国|美剧', label: '美国' },
  { key: '韩国|韩剧', label: '韩国' },
  { key: '日本|日剧', label: '日本' },
  { key: '英国|英剧', label: '英国' },
  { key: '泰国|泰剧', label: '泰国' }
]

/** 年份列表：当前年往回 5 年 + 「更早」；跨年自动顺延，不写死 2026 */
export function yearOptions(now = new Date()): Option[] {
  const thisYear = now.getFullYear()
  const opts: Option[] = [{ key: '', label: '全部' }]
  for (let i = 0; i < 6; i += 1) {
    const y = String(thisYear - i)
    opts.push({ key: y, label: y })
  }
  opts.push({ key: 'older', label: '更早', hint: `${thisYear - 5} 年以前（含无年份之外的旧片）` })
  return opts
}

/** 「更早」的年限边界：早于这一年（不含）算更早 */
export function olderBoundary(now = new Date()): number {
  return now.getFullYear() - 5
}

export interface HeatOption extends Option {
  minScore?: number
  scoreSource?: 'douban' | 'site'
  minSources?: number
}

/**
 * 热度：三种可选口径。
 * 豆瓣评分覆盖极不全（实测单页 20 条里只有 1–3 条有），所以**默认口径是收录站数**，
 * 豆瓣评分是加分项而不是唯一标准；覆盖率由服务端 stats 回传，UI 据此提示。
 */
export const HEAT_OPTIONS: readonly HeatOption[] = [
  { key: 'all', label: '不限' },
  { key: 'd9', label: '豆瓣 9+', minScore: 9, scoreSource: 'douban', hint: '豆瓣评分 9 分以上（无评分的不算命中）' },
  { key: 'd8', label: '豆瓣 8+', minScore: 8, scoreSource: 'douban', hint: '豆瓣评分 8 分以上（无评分的不算命中）' },
  { key: 'd7', label: '豆瓣 7+', minScore: 7, scoreSource: 'douban', hint: '豆瓣评分 7 分以上（无评分的不算命中）' },
  { key: 's8', label: '站内 8+', minScore: 8, scoreSource: 'site', hint: '采集站自己的用户评分 8 分以上' },
  { key: 'm3', label: '3 站以上', minSources: 3, hint: '被 3 个及以上源站同时收录（跨站热门度，永远有数据）' }
]

export const SORT_OPTIONS: readonly Option[] = [
  { key: 'hot', label: '热门', hint: '按收录站数排序（跨站热门度）' },
  { key: 'score', label: '豆瓣评分', hint: '按豆瓣评分降序，无评分的排最后' },
  { key: 'hits', label: '播放量', hint: '按各站播放量合计排序（量级差异大，仅作参考）' },
  { key: 'time', label: '最新更新', hint: '按源站更新时间降序' }
]

export function findHeat(key: HeatKey): HeatOption {
  return HEAT_OPTIONS.find((h) => h.key === key) ?? HEAT_OPTIONS[0]
}

/** 筛选条件 → catalog.category 的 RPC 参数（空维度不传，避免服务端把 '' 当条件） */
export function buildCategoryParams(f: HomeFilters, pg = 1, now = new Date()): Record<string, unknown> {
  const p: Record<string, unknown> = { pg, sort: f.sort }
  if (f.type) p.category = f.type
  if (f.area) p.area = f.area
  if (f.year === 'older') p.yearBefore = olderBoundary(now)
  else if (f.year) p.year = f.year
  const heat = findHeat(f.heat)
  if (heat.minScore) {
    p.minScore = heat.minScore
    p.scoreSource = heat.scoreSource ?? 'douban'
  }
  if (heat.minSources) p.minSources = heat.minSources
  return p
}

/** 是否有任何筛选条件（排序不算） */
export function hasFilters(f: HomeFilters): boolean {
  return !!(f.type || f.area || f.year) || f.heat !== 'all'
}

/** 已选条件回显（排序不进这里，它不是筛选条件） */
export function activeChips(f: HomeFilters): Array<{ key: FilterKey; label: string }> {
  const chips: Array<{ key: FilterKey; label: string }> = []
  const opt = (list: readonly Option[], key: string) => list.find((o) => o.key === key)?.label ?? key
  if (f.type) chips.push({ key: 'type', label: `类型：${f.type}` })
  if (f.area) chips.push({ key: 'area', label: `地区：${opt(AREA_OPTIONS, f.area)}` })
  if (f.year) chips.push({ key: 'year', label: `年份：${f.year === 'older' ? '更早' : f.year}` })
  if (f.heat !== 'all') chips.push({ key: 'heat', label: `热度：${findHeat(f.heat).label}` })
  return chips
}

/** 清掉一个维度（回到「全部」） */
export function clearFilter(f: HomeFilters, key: FilterKey): HomeFilters {
  if (key === 'heat') return { ...f, heat: 'all' }
  if (key === 'type') return { ...f, type: '' }
  if (key === 'area') return { ...f, area: '' }
  return { ...f, year: '' }
}

/** 结果标题：把生效条件拼成一句话（清空所有条件时只说明「这是全部」） */
export function describeFilters(f: HomeFilters): string {
  const parts: string[] = []
  // 顺序与「已选」chips 一致：类型 → 地区 → 年份 → 热度，两处不要各说各的
  if (f.type) parts.push(f.type)
  if (f.area) parts.push(AREA_OPTIONS.find((o) => o.key === f.area)?.label ?? '')
  if (f.year) parts.push(f.year === 'older' ? '更早年份' : `${f.year} 年`)
  if (f.heat !== 'all') parts.push(findHeat(f.heat).label)
  // 不要回「影视库」：页头标题已经是它了，重复一遍只是噪音
  return parts.filter(Boolean).join(' · ') || '全部影片'
}

/**
 * 豆瓣评分覆盖率文案。返回 '' 表示不需要提示。
 * 命中 0 条且覆盖率也 0 时，说明是「源站没给评分」而不是「真的没有高分片」——
 * 这两种情况必须给出不同提示，否则用户会以为功能坏了。
 */
export function scoreHint(stats: CatalogStats | null, f: HomeFilters): string {
  if (!stats || !stats.total) return ''
  const heat = findHeat(f.heat)
  if (heat.scoreSource === 'douban') {
    if (stats.doubanScored === 0) return '本批源站都没提供豆瓣评分，换「3 站以上」或「不限」看看'
    if (stats.doubanScored < stats.total) {
      return `豆瓣评分只覆盖本批 ${stats.total} 部中的 ${stats.doubanScored} 部，筛选结果会偏少`
    }
    return ''
  }
  if (heat.scoreSource === 'site' && stats.siteScored === 0) {
    return '本批源站都没提供站内评分，换「3 站以上」或「不限」看看'
  }
  if (heat.scoreSource === 'site' && stats.siteScored < stats.total) {
    return `站内评分只覆盖本批 ${stats.total} 部中的 ${stats.siteScored} 部，筛选结果会偏少`
  }
  return ''
}

// ---------- 客户端筛选（搜索结果 / 收藏 / 演示数据）----------

/** 可被客户端筛选的最小字段集（CatalogCard 与 Favorite 都能满足其中一部分） */
export interface FilterableCard {
  name: string
  year?: string
  typeName?: string
  area?: string
  score?: number
  siteScore?: number
  sourceCount?: number
  updateTime?: string
  hits?: number
}

/** 类型匹配：与服务端 cms::category_matches 同一套关键词规则 */
function typeMatches(typeName: string | undefined, type: string): boolean {
  const t = (typeName ?? '').trim()
  if (!t) return false
  if (type === '动漫') return t.includes('动漫')
  if (type === '综艺') return t.includes('综艺')
  if (type === '剧集') return t.includes('剧')
  if (type === '电影') return t.includes('片')
  return t === type
}

/** 地区匹配：卡片的 area 已是归一值（大陆/美国…），关键词里任一被包含即命中 */
function areaMatches(area: string | undefined, keywords: string): boolean {
  const a = (area ?? '').trim()
  if (!a) return false
  return keywords.split('|').some((k) => k.trim() && a.includes(k.trim()))
}

/**
 * 单张卡片是否满足全部维度（维度间「与」）。
 * 缺字段（收藏没有地区/评分）时该维度**不通过**——与「不限」区分开，避免把
 * 「收藏没有地区信息」误当成「地区不限」而全量放行。
 */
export function matchesFilters(c: FilterableCard, f: HomeFilters, now = new Date()): boolean {
  if (f.type && !typeMatches(c.typeName, f.type)) return false
  if (f.area && !areaMatches(c.area, f.area)) return false
  if (f.year === 'older') {
    const y = Number(c.year)
    if (!Number.isFinite(y) || y >= olderBoundary(now)) return false
  } else if (f.year && c.year !== f.year) {
    return false
  }
  const heat = findHeat(f.heat)
  if (heat.minScore) {
    const v = heat.scoreSource === 'site' ? c.siteScore : c.score
    if (v == null || v + 1e-9 < heat.minScore) return false
  }
  if (heat.minSources && (c.sourceCount ?? 0) < heat.minSources) return false
  return true
}

/** 客户端排序：与内核 sort 语义一致（无评分的沉底） */
export function sortCards<T extends FilterableCard>(cards: readonly T[], sort: SortKey): T[] {
  const out = [...cards]
  if (sort === 'score') {
    out.sort((a, b) => {
      const d = (b.score ?? -1) - (a.score ?? -1)
      return d !== 0 ? d : (b.sourceCount ?? 0) - (a.sourceCount ?? 0)
    })
  } else if (sort === 'hits') {
    out.sort((a, b) => (b.hits ?? 0) - (a.hits ?? 0) || (b.sourceCount ?? 0) - (a.sourceCount ?? 0))
  } else if (sort === 'time') {
    out.sort((a, b) => (b.updateTime ?? '').localeCompare(a.updateTime ?? ''))
  } else {
    out.sort((a, b) => (b.sourceCount ?? 0) - (a.sourceCount ?? 0))
  }
  return out
}

// ---------- 演示数据（无内核时的兜底）----------

/** 演示条目最小形状（homeData.VideoItem 的超集，便于回归直接用假数据） */
export interface DemoItem {
  title: string
  cat: string
  date: string
  views: number
}

export interface DemoFilterResult<T> {
  items: T[]
  /** 演示数据没有对应字段、无法执行的维度（UI 要明说，不能静默返回空） */
  unsupported: FilterKey[]
}

/**
 * 演示数据只能按「类型 / 年份」筛，按「播放量」排。
 * 地区与评分在 homeData 里根本不存在，所以宁可报 unsupported 也不假装筛过。
 */
export function filterDemo<T extends DemoItem>(
  items: readonly T[],
  f: HomeFilters,
  query = '',
  now = new Date()
): DemoFilterResult<T> {
  const unsupported: FilterKey[] = []
  if (f.area) unsupported.push('area')
  if (f.heat !== 'all') unsupported.push('heat')
  const q = query.trim().toLowerCase()
  const boundary = olderBoundary(now)
  let out = items.filter((it) => {
    if (f.type && it.cat !== f.type) return false
    if (f.year === 'older') {
      const y = Number(it.date.slice(0, 4))
      if (!Number.isFinite(y) || y >= boundary) return false
    } else if (f.year && !it.date.startsWith(f.year)) {
      return false
    }
    if (q && !it.title.toLowerCase().includes(q) && !it.cat.toLowerCase().includes(q)) return false
    return true
  })
  out = sortDemo(out, f.sort)
  return { items: out, unsupported }
}

/** 演示排序：评分口径没有数据，回落按播放量（调用方结合 unsupported 提示） */
export function sortDemo<T extends DemoItem>(items: readonly T[], sort: SortKey): T[] {
  const out = [...items]
  if (sort === 'time') out.sort((a, b) => b.date.localeCompare(a.date))
  else out.sort((a, b) => b.views - a.views)
  return out
}
