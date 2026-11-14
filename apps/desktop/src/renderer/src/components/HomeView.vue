<script setup lang="ts">
/**
 * P8 首页（真实数据版）/ P39 重排为「多维筛选的影视库」。
 *
 * 数据源 = catalog.category 聚合全部启用 CMS 源站（类型/地区/年份/热度在服务端过滤，
 * 评分与播放量由内核聚合回传）。内核离线时回落 homeData 演示库并明示模式。
 *
 * 布局：页头（片库/收藏 + 模式徽章）+ 搜索 + 筛选面板（4 维）+ 轮播（仅无筛选时）
 * + 结果栏（标题 / 数量 / 排序）+ 卡片流。
 * 组合语义见 lib/catalog-filters.ts 顶部注释，UI 底部同样写明，两边不许不一致。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { RpcMethod, type CatalogCard, type CatalogStats, type Favorite } from '@polyframe/shared'
import { usePlayerStore } from '../stores/player'
import { mergeCards, useCatalogStore } from '../stores/catalog'
import { historyDone, historyPct, useHistoryStore } from '../stores/history'
import { BANNERS, REAL_VIDEOS, COVER_GRADS, formatViews, type VideoItem } from '../homeData'
import {
  AREA_OPTIONS,
  DEFAULT_FILTERS,
  HEAT_OPTIONS,
  SORT_OPTIONS,
  TYPE_OPTIONS,
  activeChips,
  buildCategoryParams,
  clearFilter,
  describeFilters,
  filterDemo,
  hasFilters,
  matchesFilters,
  scoreHint,
  sortCards,
  yearOptions,
  type FilterKey,
  type HomeFilters,
  type Option,
  type SortKey
} from '../lib/catalog-filters'

const player = usePlayerStore()
const catalog = useCatalogStore()
const history = useHistoryStore()

// ---------- toast（与发现页同款轻反馈） ----------
const toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | null = null
function notify(msg: string) {
  toast.value = msg
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = ''), 2600)
}

// ---------- 视图 / 筛选状态 ----------
/** 片库 = 服务端聚合结果；收藏 = 本地收藏（只有类型/年份可筛） */
const view = ref<'library' | 'favorites'>('library')
const filters = reactive<HomeFilters>({ ...DEFAULT_FILTERS })
/** 高级筛选默认收起：首屏要让位给海报，而不是四行 chip */
const panelOpen = ref(false)
const stats = ref<CatalogStats | null>(null)
/** 年份选项一次生成（跨年由组件重挂载兜底，不每分钟重算） */
const yearOpts = yearOptions()

interface Row {
  key: FilterKey
  label: string
  options: readonly Option[]
  value: string
}

/**
 * 筛选面板行 = 除「类型」外的维度（类型常驻快捷条，见工具栏）。
 * 重复出现两次会让用户以为「这两处是不同条件」。
 */
const rows = computed<Row[]>(() => {
  const all: Row[] = [
    { key: 'area', label: '地区', options: AREA_OPTIONS, value: filters.area },
    { key: 'year', label: '年份', options: yearOpts, value: filters.year },
    { key: 'heat', label: '热度', options: HEAT_OPTIONS, value: filters.heat }
  ]
  // 收藏条目没有地区与评分字段：留着这两行只会「点了必然 0 条」
  if (view.value === 'favorites') return all.filter((r) => r.key === 'year')
  return all
})

/** 单选维度：再点一次已选项 = 取消（回到该维度第一项） */
function pick(key: FilterKey, value: string) {
  const cur = key === 'heat' ? filters.heat : filters[key]
  const fallback = key === 'heat' ? 'all' : ''
  const next = cur === value ? fallback : value
  if (key === 'heat') filters.heat = next as HomeFilters['heat']
  else if (key === 'type') filters.type = next
  else if (key === 'area') filters.area = next
  else filters.year = next
  // 搜索态：结果是已聚合的一页，改条件只在这一页里重筛，不必再扇出一次全站请求
  if (!searchCards.value) void load()
}

function dropChip(key: FilterKey) {
  Object.assign(filters, clearFilter(filters, key))
  if (!searchCards.value) void load()
}

function clearAll() {
  Object.assign(filters, { ...DEFAULT_FILTERS, sort: filters.sort })
  query.value = ''
  searchCards.value = null
  void load()
}

function pickSort(s: SortKey) {
  filters.sort = s
  // 排序要回源：内核是在**排序后**才截断到 60 条，客户端只重排这 60 条会让
  // 「按评分排」拿到的是「按热门挑出来的 60 条」，与用户预期不是一回事。
  // 搜索态没有服务端排序可发（结果是已聚合的一页），本地重排即可。
  if (!searchCards.value) void load()
}

function switchView(v: 'library' | 'favorites') {
  player.homeTab = 'reco'
  if (view.value === v) return
  view.value = v
  query.value = ''
  searchCards.value = null
  stats.value = null
  // 收藏没有地区/评分字段，带着这两个条件切过去会必然空列表
  filters.area = ''
  filters.heat = 'all'
  void load()
}

const chips = computed(() => activeChips(filters))
/** 面板按钮上的角标：只数面板内的维度（类型在快捷条上自己会亮） */
const panelCount = computed(() => chips.value.filter((c) => c.key !== 'type').length)
const filtered = computed(() => hasFilters(filters))
/** 只数启用的源站：停用的站不参与聚合，算进去会虚高 */
const enabledSources = computed(() => catalog.sources.filter((s) => s.enabled).length || '—')

// ---------- 统一卡片视图模型 ----------
interface HomeCard {
  key: string
  title: string
  poster: string
  /** 封面角标：remarks / 时长 / LIVE */
  tag: string
  isLive?: boolean
  cat: string
  heat: string
  time: string
  channel: string
  chIcon: string
  grad: [string, string]
  /** 豆瓣评分（无则空，不能当 0 分展示） */
  score?: number
  /** 真实卡片：交给起播链路 */
  raw?: CatalogCard
  /** 收藏卡片：跳媒体库 */
  favId?: string
  /** demo 卡片：直连起播 */
  demo?: VideoItem
}

function mapReal(c: CatalogCard): HomeCard {
  return {
    key: 'r-' + c.key,
    title: c.name,
    poster: catalog.posterUrl(c.poster),
    tag: c.remarks ?? '',
    cat: c.typeName ?? '聚合片源',
    heat: `▲ ${c.sourceCount} 站收录`,
    time: (c.updateTime ?? '').slice(0, 10),
    channel: [c.typeName, c.area, c.year].filter(Boolean).join(' · ') || '多站聚合',
    chIcon: (c.area ?? c.typeName ?? '聚')[0],
    grad: COVER_GRADS[c.key.length % COVER_GRADS.length],
    score: c.score,
    raw: c
  }
}

function mapFav(f: Favorite): HomeCard {
  return {
    key: 'f-' + f.id,
    title: f.name,
    poster: catalog.posterUrl(f.poster),
    tag: f.remarks ?? '',
    cat: f.typeName ?? '收藏',
    heat: '⭐ 已收藏',
    time: (f.createdAt ?? '').slice(0, 10),
    channel: `${f.sourceCount} 个片源`,
    chIcon: (f.typeName ?? '藏')[0],
    grad: COVER_GRADS[f.id.length % COVER_GRADS.length],
    favId: f.id
  }
}

/** 仅用于封面占位图（真实卡片的 typeName 基本命中不到，回落 🎞） */
const CAT_ICONS: Record<string, string> = { 电影: '🎬', 剧集: '📺', 动漫: '🐼', 综艺: '🎤' }

function mapDemo(v: VideoItem): HomeCard {
  return {
    key: 'd-' + v.id,
    title: v.title,
    poster: v.poster,
    tag: v.duration,
    isLive: v.isLive,
    cat: v.cat,
    heat: `▶ ${formatViews(v.views)}`,
    time: v.date,
    channel: v.channel,
    chIcon: v.channel[0],
    grad: v.grad,
    demo: v
  }
}

// ---------- 数据状态 ----------
const query = ref('')
const loading = ref(false)
const dataMode = ref<'real' | 'demo'>('demo')
const realCards = ref<CatalogCard[]>([])
const realFavs = ref<Favorite[]>([])
const searchCards = ref<CatalogCard[] | null>(null)
const failures = ref<string[]>([])
/** 轮播专用：首次「无筛选」的结果（之后筛选不打断轮播） */
const bannerCards = ref<CatalogCard[]>([])
// ---------- P43 分页 ----------
// 旧版首页只发一次 pg=1 就结束，内核再截断 60 条 —— 一个 50 万条的片库只能看到首屏那 60 部。
const page = ref(1)
const hasMore = ref(false)
const moreLoading = ref(false)
/** 请求代次：换条件/换视图后，慢回来的「加载更多」不能覆盖新列表 */
let loadToken = 0

/** 拉取当前视图 + 当前筛选条件的真实数据（始终回到第 1 页） */
async function load() {
  const token = ++loadToken
  loading.value = true
  searchCards.value = null
  failures.value = []
  if (player.mode !== 'electron') {
    dataMode.value = 'demo'
    hasMore.value = false
    loading.value = false
    return
  }
  try {
    if (view.value === 'favorites') {
      await catalog.refreshFavorites()
      if (token !== loadToken) return
      realFavs.value = [...catalog.favorites]
      realCards.value = []
      page.value = 1
      hasMore.value = false
      dataMode.value = 'real'
      return
    }
    const r = (await catalog.rpc(
      RpcMethod.CatalogCategory,
      buildCategoryParams(filters, 1)
    )) as { cards: CatalogCard[]; failures: string[]; stats?: CatalogStats; hasMore?: boolean; page?: number }
    if (token !== loadToken) return
    realCards.value = r.cards
    realFavs.value = []
    failures.value = r.failures
    stats.value = r.stats ?? null
    page.value = r.page ?? 1
    hasMore.value = !!r.hasMore
    // 首次无筛选的那一批就是热门榜，留给轮播（筛选后再拉也不覆盖）
    if (!bannerCards.value.length && !hasFilters(filters)) bannerCards.value = r.cards
    dataMode.value = 'real'
  } catch (e) {
    if (token !== loadToken) return
    dataMode.value = 'demo'
    hasMore.value = false
    notify(`真实片库加载失败（${(e as Error).message}），已回落演示数据`)
  } finally {
    if (token === loadToken) loading.value = false
  }
}

/** 追加下一页（浏览态走 category、搜索态走 search；演示数据没有下一页） */
async function loadMore() {
  if (moreLoading.value || loading.value || !hasMore.value) return
  if (player.mode !== 'electron' || dataMode.value !== 'real') return
  moreLoading.value = true
  const token = loadToken
  const nextPg = page.value + 1
  try {
    if (searchCards.value) {
      const r = (await catalog.rpc(RpcMethod.CatalogSearch, {
        q: query.value,
        pg: nextPg
      })) as { cards: CatalogCard[]; failures: string[]; hasMore?: boolean; page?: number }
      if (token !== loadToken) return
      searchCards.value = mergeCards(searchCards.value, r.cards)
      page.value = r.page ?? nextPg
      hasMore.value = !!r.hasMore
    } else {
      const r = (await catalog.rpc(
        RpcMethod.CatalogCategory,
        buildCategoryParams(filters, nextPg)
      )) as { cards: CatalogCard[]; failures: string[]; hasMore?: boolean; page?: number }
      if (token !== loadToken) return
      realCards.value = mergeCards(realCards.value, r.cards)
      // 内核一次可能消费多页（窄条件填页循环），页码以它回显的为准，别自增
      page.value = r.page ?? nextPg
      hasMore.value = !!r.hasMore
    }
  } catch (e) {
    notify(`加载更多失败：${(e as Error).message}`)
  } finally {
    moreLoading.value = false
  }
}

async function doSearch() {
  const q = query.value.trim()
  if (!q) {
    searchCards.value = null
    notify('已回到浏览模式')
    return
  }
  query.value = q
  if (view.value === 'favorites') return // 收藏走本地匹配，列表 computed 直接生效
  const token = ++loadToken
  loading.value = true
  if (player.mode === 'electron') {
    try {
      const r = (await catalog.rpc(RpcMethod.CatalogSearch, { q, pg: 1 })) as {
        cards: CatalogCard[]
        failures: string[]
        hasMore?: boolean
        page?: number
      }
      if (token !== loadToken) return
      searchCards.value = r.cards
      failures.value = r.failures
      realCards.value = []
      realFavs.value = []
      stats.value = null
      page.value = r.page ?? 1
      hasMore.value = !!r.hasMore
      dataMode.value = 'real'
      loading.value = false
      if (!r.cards.length) {
        notify(`「${q}」无结果${r.failures.length ? `（${r.failures.length} 个源站失败）` : ''}`)
      }
      return
    } catch (e) {
      if (token !== loadToken) return
      notify(`聚合搜索失败（${(e as Error).message}），回落演示数据`)
    }
  }
  dataMode.value = 'demo'
  hasMore.value = false
  loading.value = false
}

// ---------- 列表 / 标题 / 空态 ----------
const demoResult = computed(() => filterDemo(REAL_VIDEOS, filters, query.value))

const list = computed<HomeCard[]>(() => {
  if (dataMode.value === 'real') {
    if (view.value === 'favorites') {
      // 收藏保持「收藏时间倒序」，不参与排序维度
      const hit = query.value
        ? realFavs.value.filter((f) => f.name.toLowerCase().includes(query.value.trim().toLowerCase()))
        : realFavs.value
      return hit.filter((f) => matchesFilters(f, filters)).map(mapFav)
    }
    // 搜索结果是已聚合一页，客户端再过一遍同样的维度（与服务端语义一致）；
    // 浏览态服务端已过滤，这里只负责排序（≤60 条，开销可忽略）
    const src = searchCards.value ?? realCards.value
    const hit = searchCards.value ? src.filter((c) => matchesFilters(c, filters)) : src
    return sortCards(hit, filters.sort).map(mapReal)
  }
  if (view.value === 'favorites') return []
  return demoResult.value.items.map(mapDemo)
})

const secTitle = computed(() => {
  if (query.value) return `「${query.value}」的搜索结果`
  if (view.value === 'favorites') return '我的收藏'
  return describeFilters(filters)
})

/**
 * 覆盖率统计：浏览态用内核返回的 stats；搜索态内核不返回（搜索结果不报覆盖率），
 * 就在这一页结果里现算 —— 否则搜索后选「豆瓣 8+」筛出 0 条时无法解释原因。
 */
const effectiveStats = computed<CatalogStats | null>(() => {
  if (stats.value) return stats.value
  const src = searchCards.value
  if (!src) return null
  return {
    total: src.length,
    doubanScored: src.filter((c) => c.score != null).length,
    siteScored: src.filter((c) => c.siteScore != null).length,
    matched: 0,
    filtered: true
  }
})

const hint = computed(() => scoreHint(effectiveStats.value, filters))

const emptyTitle = computed(() => {
  // 收藏为空是「还没收藏」，不是「条件太窄」：两种空态的下一步动作不一样
  if (view.value === 'favorites' && !realFavs.value.length) return '还没有收藏'
  if (filtered.value || query.value) return '这些条件下没有内容'
  return '这里空空如也'
})

const emptyText = computed(() => {
  if (view.value === 'favorites') {
    if (!realFavs.value.length) return '去片库找一部收藏，收藏会在这里按时间倒序排'
    if (filtered.value || query.value) return '收藏里没有符合这些条件的影片（收藏不含地区与评分，这两个维度已隐藏）'
    return '还没有收藏影片，去片库找一部收藏吧'
  }
  if (dataMode.value === 'demo') {
    const un = demoResult.value.unsupported
    if (un.length) {
      const names = un.map((k) => (k === 'area' ? '地区' : '热度')).join('、')
      return `演示数据没有「${names}」字段，无法按它筛选；配置源站后可切回真实片库`
    }
    return query.value ? `没有找到与「${query.value}」相关的视频` : '演示库暂无该分类，换个条件看看'
  }
  if (searchCards.value) {
    // 搜索 + 筛选是叠加的：空结果要说清是「搜不到」还是「条件太窄」
    return filtered.value
      ? `「${query.value}」的结果里没有符合当前筛选的影片，放宽条件或清空筛选再试`
      : `「${query.value}」没有找到结果${failures.value.length ? `（${failures.value.length} 个源站失败）` : ''}`
  }
  if (query.value) {
    return `「${query.value}」没有找到结果${failures.value.length ? `（${failures.value.length} 个源站失败）` : ''}`
  }
  if (hint.value) return hint.value
  if (failures.value.length) {
    return `启用的源站暂未返回数据（${failures.value.length} 个源站失败），可在发现页同步预设库后重试`
  }
  return '这些条件下没有内容，试试放宽条件'
})

/**
 * 首屏高度不够时先不放推荐位：720p 下「页头+搜索+筛选面板」已占掉大半，
 * 轮播再压进来会让片库一张卡都看不到 —— 内容优先于装饰。
 */
const tallEnough = ref(true)
/** 窄屏（与 CSS 的 720 断点对齐）：用于「推荐位 vs 继续观看」二选一 */
const narrow = ref(false)
function syncViewportHeight() {
  tallEnough.value = window.innerHeight >= 820
  narrow.value = window.innerWidth <= 720
}

/** 轮播只在「片库 + 无筛选 + 无搜索 + 首屏够高」时出现：筛选中它只会挤走结果 */
const showCarousel = computed(
  () =>
    view.value === 'library' &&
    !filtered.value &&
    !query.value &&
    tallEnough.value &&
    banners.value.length > 0 &&
    // 窄屏一屏放不下两段：用户自己的进度优先于编辑推荐
    !(narrow.value && continueItems.value.length > 0)
)

// ---------- 继续观看 ----------
//
// 数据来自 `play_history`（按片去重，一条记录同时是「最近看的」和「看到哪」）。
// 只在片库默认态出现：搜索/筛选中它只会把结果往下推，用户此刻要的是结果不是导航。
const continueItems = computed(() => {
  if (view.value !== 'library' || filtered.value || query.value) return []
  return history.items
    .filter((it) => it.positionSec > 15 && !historyDone(it))
    .slice(0, 12)
})
/** 继续观看是用户自己的进度，属于内容而非装饰：不再按屏高砍掉（矮窗口/手机上更要能续播） */
const showContinue = computed(() => continueItems.value.length > 0)

function posterOf(p?: string): string {
  return catalog.posterUrl(p)
}
function leftText(it: { positionSec: number; durationSec: number }): string {
  const left = Math.max(0, it.durationSec - it.positionSec)
  const m = Math.round(left / 60)
  return m >= 60 ? `剩 ${Math.floor(m / 60)} 小时` : `剩 ${Math.max(1, m)} 分钟`
}
async function resumeItem(it: (typeof history.items)[number]): Promise<void> {
  try {
    await history.resume(it)
  } catch (e) {
    notify(`续播失败：${(e as Error).message}`)
  }
}

/**
 * 历史刷新：起播/播完都会改记录，但首页是保活页（onMounted 只跑一次）。
 * 用 1.2s 合并窗口跟随 `playSeq`，别把每集切换都变成一次 RPC。
 */
let histTimer: ReturnType<typeof window.setTimeout> | null = null
function refreshHistorySoon(): void {
  if (player.mode !== 'electron' || histTimer !== null) return
  histTimer = window.setTimeout(() => {
    histTimer = null
    void history.refresh().catch(() => {})
  }, 1200)
}
watch(() => player.playSeq, refreshHistorySoon)

// ---------- 卡片交互 ----------
/** 演示卡片（直链）自管的起播锁；真实影片的起播状态统一放 catalog.boot */
const playingKey = ref('')
const bootKey = computed(() => catalog.boot?.key ?? '')
const busyKey = computed(() => bootKey.value || playingKey.value)
const bootElapsed = ref(0)
let bootTicker: ReturnType<typeof window.setInterval> | null = null
watch(
  () => catalog.boot,
  (b) => {
    if (b) {
      bootElapsed.value = 0
      if (bootTicker === null) {
        bootTicker = window.setInterval(() => {
          const cur = catalog.boot
          if (!cur) return
          bootElapsed.value = Math.max(0, Math.round((Date.now() - cur.startedAt) / 1000))
        }, 400)
      }
    } else if (bootTicker !== null) {
      window.clearInterval(bootTicker)
      bootTicker = null
      bootElapsed.value = 0
    }
  }
)
onBeforeUnmount(() => {
  if (bootTicker !== null) window.clearInterval(bootTicker)
})
const bootText = computed(() => {
  const b = catalog.boot
  if (!b) return ''
  if (b.phase === 'detail') {
    return b.attempts > 1 ? `正在获取片源（${b.attempt}/${b.attempts}）…` : '正在获取片源…'
  }
  if (b.phase === 'task') return '正在创建播放任务…'
  return '正在起播…'
})
const bootHint = computed(() => {
  const b = catalog.boot
  if (!b) return ''
  if (b.phase === 'detail' && bootElapsed.value >= 6) return '源站响应较慢，稍后会自动换下一个片源'
  if (b.phase === 'task' && bootElapsed.value >= 6) return '源站较慢，任务仍在创建中'
  return bootElapsed.value >= 3 ? '正在准备播放…' : ''
})
const bootError = ref('')
const lastBootCard = ref<HomeCard | null>(null)

async function openCard(card: HomeCard) {
  if (card.raw) {
    if (busyKey.value) return
    lastBootCard.value = card
    bootError.value = ''
    try {
      await catalog.playCard(card.raw, card.key)
    } catch (e) {
      if ((e as Error).name === 'BootCancelled') {
        notify('已取消起播')
        return
      }
      bootError.value = (e as Error).message
      notify(`起播失败：${(e as Error).message}`)
    }
    return
  }
  if (card.favId) {
    player.go('library')
    notify('到媒体库选择片源播放')
    return
  }
  if (card.demo && !playingKey.value) {
    playingKey.value = card.key
    try {
      catalog.setLooseContext(card.demo.title, '演示片源')
      await Promise.race([
        player.playDirect(card.demo.src, card.demo.title),
        new Promise((_, reject) =>
          window.setTimeout(() => reject(new Error('起播超时（15s 无响应）')), 15_000)
        )
      ])
      notify(`已切换到播放页：${card.demo.title}`)
    } catch (e) {
      notify(`起播失败：${(e as Error).message}`)
    } finally {
      playingKey.value = ''
    }
  }
}

function retryBoot() {
  if (!lastBootCard.value) return
  void openCard(lastBootCard.value)
}
function cancelBoot() {
  catalog.cancelBoot()
}

function onPosterErr(e: Event) {
  ;(e.target as HTMLImageElement).style.display = 'none'
}

// ---------- 轮播 ----------
interface Banner {
  key: string
  title: string
  meta: string
  gradBg: string
  img: string
  blur: boolean
  card: HomeCard
}
const banners = computed<Banner[]>(() => {
  if (dataMode.value === 'real') {
    const src = bannerCards.value.length ? bannerCards.value : realCards.value
    return src.slice(0, 4).map((c) => {
      const card = mapReal(c)
      return {
        key: card.key,
        title: c.name,
        meta: [c.typeName, c.area, c.year].filter(Boolean).join(' · ') || '聚合片源',
        gradBg: `linear-gradient(120deg, ${card.grad[0]}, ${card.grad[1]})`,
        img: card.poster,
        blur: true,
        card
      }
    })
  }
  return BANNERS.map((v) => ({
    key: v.id,
    title: v.title,
    meta: `${formatViews(v.views)} 次播放 · ${v.duration} · ${v.channel}`,
    gradBg: `linear-gradient(120deg, ${v.grad[0]}, ${v.grad[1]})`,
    img: v.poster,
    blur: false,
    card: mapDemo(v)
  }))
})

function onBannerImgErr(e: Event) {
  ;(e.target as HTMLImageElement).style.display = 'none'
}

const slideIdx = ref(0)
let slideTimer: ReturnType<typeof setInterval> | null = null

function goSlide(i: number) {
  const n = banners.value.length
  if (!n) return
  slideIdx.value = (i + n) % n
  restartSlideTimer()
}
/** hover 暂停：用户正在看/正要点「立即播放」时别自动翻走 */
let slidePaused = false
function pauseSlide() {
  slidePaused = true
  if (slideTimer) clearInterval(slideTimer)
  slideTimer = null
}
function resumeSlide() {
  slidePaused = false
  restartSlideTimer()
}
function restartSlideTimer() {
  if (slideTimer) clearInterval(slideTimer)
  // prefers-reduced-motion：不自动翻页（翻页动画对前庭敏感用户是干扰）
  if (slidePaused || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  slideTimer = setInterval(() => {
    const n = banners.value.length
    if (n) slideIdx.value = (slideIdx.value + 1) % n
  }, 5000)
}
watch(
  () => banners.value.length,
  (n) => {
    if (slideIdx.value >= n) slideIdx.value = 0
  }
)

let touchX = 0
function onTouchStart(e: TouchEvent) {
  touchX = e.touches[0].clientX
}
function onTouchEnd(e: TouchEvent) {
  const dx = e.changedTouches[0].clientX - touchX
  if (Math.abs(dx) > 40) goSlide(slideIdx.value + (dx < 0 ? 1 : -1))
}

onMounted(() => {
  restartSlideTimer()
  syncViewportHeight()
  window.addEventListener('resize', syncViewportHeight)
  // 页头要显示「N 个源站」，发现页没进过也得有数
  if (!catalog.sources.length) catalog.refreshSources().catch(() => {})
  // 继续观看：首页保活，进过一次就要有数据；之后靠 playSeq 增量刷新
  if (player.mode === 'electron') void history.refresh().catch(() => {})
  void load()
})
onBeforeUnmount(() => {
  if (slideTimer) clearInterval(slideTimer)
  if (histTimer !== null) window.clearTimeout(histTimer)
  window.removeEventListener('resize', syncViewportHeight)
})
</script>

<template>
  <section class="home-view">
    <!-- 工具条：搜索（核心动作）+ 类型快捷筛选 + 高级筛选，宽屏一行、窄屏自动折行 -->
    <div class="toolbar">
      <div class="search-bar">
        <span class="search-ico" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
            <circle cx="10.8" cy="10.8" r="6.4" />
            <path d="m15.6 15.6 4.4 4.4" />
          </svg>
        </span>
        <input
          v-model="query"
          class="search-input"
          type="text"
          :placeholder="view === 'favorites' ? '在收藏里搜片名' : '搜索影片名，聚合全部启用的源站，回车确认'"
          @keyup.enter="doSearch"
        />
        <button v-if="query" class="search-clear" title="清空搜索" aria-label="清空搜索" @click="clearAll">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
        <button
          class="btn ghost search-go"
          :disabled="loading"
          aria-label="搜索"
          @click="doSearch"
        >
          搜索
        </button>
      </div>

      <!-- 快捷分类条：类型常驻（最高频的一维），高级筛选收进按钮 -->
      <div class="qb-types" role="group" aria-label="类型">
        <button
          v-for="o in TYPE_OPTIONS"
          :key="o.key || 'all'"
          class="type-chip"
          :class="{ active: filters.type === o.key }"
          :title="o.hint ?? ''"
          @click="pick('type', o.key)"
        >
          {{ o.label }}
        </button>
      </div>

      <!-- P53：片库/收藏/发现 三段；发现已并入首页（DiscoverView 由 App 按 homeTab 切换） -->
      <div class="segmented view-seg" role="tablist" aria-label="视图">
        <button
          role="tab"
          :aria-selected="player.homeTab === 'reco' && view === 'library'"
          :class="{ active: player.homeTab === 'reco' && view === 'library' }"
          @click="switchView('library')"
        >
          片库
        </button>
        <button
          role="tab"
          :aria-selected="player.homeTab === 'reco' && view === 'favorites'"
          :class="{ active: player.homeTab === 'reco' && view === 'favorites' }"
          @click="switchView('favorites')"
        >
          收藏
        </button>
        <button
          role="tab"
          :aria-selected="player.homeTab === 'discover'"
          :class="{ active: player.homeTab === 'discover' }"
          @click="player.homeTab = 'discover'"
        >
          发现
        </button>
      </div>
      <button
        class="icon-btn"
        :disabled="loading"
        title="按当前条件重新拉取"
        aria-label="刷新片库"
        @click="load"
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
          <path d="M20 11a8 8 0 1 0-2.6 6.3" />
          <path d="M20 5v6h-6" />
        </svg>
      </button>
      <button
        class="filter-btn"
        :class="{ on: panelOpen, armed: panelCount > 0 }"
        :aria-expanded="panelOpen"
        @click="panelOpen = !panelOpen"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
          <path d="M4 6h16M7 12h10M10 18h4" />
        </svg>
        筛选
        <span v-if="panelCount" class="fb-count">{{ panelCount }}</span>
      </button>
    </div>

    <!-- 高级筛选：默认收起，展开后每个维度一行（行内单选，行间「与」） -->
    <div v-if="panelOpen" class="filter-panel">
      <div v-for="row in rows" :key="row.key" class="fp-row">
        <span class="fp-label">{{ row.label }}</span>
        <div class="fp-chips" role="group" :aria-label="row.label">
          <button
            v-for="o in row.options"
            :key="o.key || 'all'"
            class="chip"
            :class="{ active: row.value === o.key }"
            :title="o.hint ?? ''"
            @click="pick(row.key, o.key)"
          >
            {{ o.label }}
          </button>
        </div>
      </div>
      <div class="fp-foot">
        <p class="fp-note">条件按<b>「与」</b>组合，行内单选（再点取消）；地区已含站方别名</p>
        <button v-if="chips.length" class="fp-clear" @click="clearAll">清空条件</button>
      </div>
    </div>

    <!-- 已选条件回显：随时能看出「现在到底筛了什么」 -->
    <div v-if="chips.length" class="active-filters">
      <span class="af-label">已选</span>
      <button v-for="c in chips" :key="c.key" class="af-chip" :title="`移除 ${c.label}`" @click="dropChip(c.key)">
        {{ c.label }}<span class="af-x" aria-hidden="true">×</span>
      </button>
      <button class="af-clear" @click="clearAll">清空全部</button>
    </div>

    <!-- 推荐位：只在「片库 · 无筛选 · 无搜索 · 首屏够高」时出现 -->
    <div
      v-if="showCarousel"
      class="hero"
      role="region"
      aria-label="推荐"
      @mouseenter="pauseSlide"
      @mouseleave="resumeSlide"
      @focusin="pauseSlide"
      @focusout="resumeSlide"
      @touchstart.passive="onTouchStart"
      @touchend.passive="onTouchEnd"
    >
      <div class="slides" :style="{ transform: `translateX(-${slideIdx * 100}%)` }">
        <div v-for="(b, i) in banners" :key="b.key" class="slide">
          <div class="slide-bg" :style="{ background: b.gradBg }"></div>
          <img v-if="b.img" :src="b.img" class="slide-img" alt="" @error="onBannerImgErr" />
          <div class="slide-shade"></div>
          <div class="slide-info">
            <span class="slide-tag">{{ dataMode === 'real' ? '今日热门' : '编辑推荐' }}</span>
            <h2>{{ b.title }}</h2>
            <p class="slide-meta">{{ b.meta }}</p>
            <div class="slide-ops">
              <button class="btn primary slide-play" :disabled="!!busyKey" @click="openCard(b.card)">
                <span class="play-tri" aria-hidden="true"></span>
                {{ bootKey === b.card.key || playingKey === b.card.key ? `起播中 ${bootElapsed || 0}s` : '立即播放' }}
              </button>
              <span class="slide-idx mono">{{ i + 1 }} / {{ banners.length }}</span>
            </div>
          </div>
          <img v-if="b.img" :src="b.img" class="slide-poster" alt="" @error="onBannerImgErr" />
          <div v-if="i === slideIdx" class="slide-live" aria-hidden="true"></div>
        </div>
      </div>
      <button class="car-btn prev" aria-label="上一张" @click="goSlide(slideIdx - 1)">‹</button>
      <button class="car-btn next" aria-label="下一张" @click="goSlide(slideIdx + 1)">›</button>
      <div class="dots">
        <button
          v-for="(b, i) in banners"
          :key="b.key"
          class="dot"
          :class="{ on: i === slideIdx }"
          :aria-label="`第 ${i + 1} 张`"
          @click="goSlide(i)"
        ></button>
      </div>
    </div>

    <!-- 继续观看：接着上次的地方看，不用先找片 -->
    <section v-if="showContinue" class="row-block" aria-label="继续观看">
      <div class="row-head">
        <h3>继续观看</h3>
        <span class="row-sub">上次看到的位置</span>
      </div>
      <div class="row-track">
        <article
          v-for="it in continueItems"
          :key="it.key"
          class="c-card"
          role="button"
          tabindex="0"
          :aria-label="`继续观看 ${it.title}`"
          @click="resumeItem(it)"
          @keydown.enter.prevent="resumeItem(it)"
          @keydown.space.prevent="resumeItem(it)"
        >
          <div class="c-poster">
            <img v-if="it.poster" :src="posterOf(it.poster)" class="c-img" loading="lazy" alt="" @error="onPosterErr" />
            <span v-else class="c-ph" aria-hidden="true">▶</span>
            <span class="c-resume" aria-hidden="true">
              <span class="play-tri"></span>
            </span>
            <span class="c-bar"><i :style="{ width: historyPct(it) + '%' }"></i></span>
          </div>
          <div class="c-meta">
            <div class="c-title" :title="it.title">{{ it.title }}</div>
            <div class="c-sub">
              <span class="c-ep">{{ it.episodeName || '上次进度' }}</span>
              <span class="c-left">{{ leftText(it) }}</span>
            </div>
          </div>
        </article>
      </div>
    </section>

    <!-- 结果栏：标题说清当前条件，排序放右侧 -->
    <div class="sec-head">
      <h3>{{ secTitle }}</h3>
      <span class="sec-count">{{ list.length }} 部</span>
      <!-- 只在演示数据时挂提示：真实数据下这枚徽章是纯噪音 -->
      <span
        v-if="dataMode !== 'real'"
        class="sec-badge"
        :title="`演示数据 · ${enabledSources} 个源站聚合（未连接真实源站）`"
      >
        演示数据
      </span>
      <div v-if="view === 'library'" class="sort-seg segmented" role="group" aria-label="排序">
        <button
          v-for="s in SORT_OPTIONS"
          :key="s.key"
          :class="{ active: filters.sort === s.key }"
          :title="s.hint ?? ''"
          @click="pickSort(s.key as SortKey)"
        >
          {{ s.label }}
        </button>
      </div>
    </div>

    <!-- 评分覆盖率提示：筛选命中少时先解释「是源站没给分」 -->
    <div v-if="hint" class="filter-hint">{{ hint }}</div>

    <!-- 起播失败：完整原因 + 原地重试 -->
    <div v-if="bootError" class="boot-alert">
      <div class="ba-text">
        <strong>起播没成功</strong>
        <span class="dim">{{ bootError }}</span>
      </div>
      <div class="ba-ops">
        <button class="btn sm primary" :disabled="!!busyKey" @click="retryBoot">重试</button>
        <button class="btn sm ghost" @click="bootError = ''">知道了</button>
      </div>
    </div>

    <!-- 骨架屏 -->
    <div v-if="loading" class="poster-grid">
      <div v-for="i in 12" :key="i" class="p-card sk">
        <div class="sk-poster"></div>
        <div class="sk-line w80"></div>
        <div class="sk-line w50"></div>
      </div>
    </div>

    <!-- 海报网格 -->
    <div v-else-if="list.length" class="poster-grid">
      <article
        v-for="v in list"
        :key="v.key"
        class="p-card"
        :class="{ playing: busyKey === v.key }"
        role="button"
        tabindex="0"
        :aria-label="`播放 ${v.title}`"
        :title="v.channel"
        @click="openCard(v)"
        @keydown.enter.prevent="openCard(v)"
        @keydown.space.prevent="openCard(v)"
      >
        <div class="p-poster">
          <span
            class="p-fallback"
            aria-hidden="true"
            :style="{ background: `linear-gradient(150deg, ${v.grad[0]}, ${v.grad[1]})` }"
          ></span>
          <img v-if="v.poster" :src="v.poster" class="p-img" loading="lazy" alt="" @error="onPosterErr" />
          <span v-else class="p-ph">{{ CAT_ICONS[v.cat] ?? '🎞' }}</span>
          <span v-if="v.score" class="p-score" :title="`豆瓣评分 ${v.score.toFixed(1)}`">★ {{ v.score.toFixed(1) }}</span>
          <span v-if="v.tag" class="p-tag" :class="{ live: v.isLive }">{{ v.isLive ? '● LIVE' : v.tag }}</span>
          <span v-if="v.heat" class="p-st">{{ v.heat }}</span>
          <span class="p-hover" aria-hidden="true"><span class="p-play"><span class="play-tri"></span></span></span>
          <div v-if="busyKey === v.key" class="p-loading">
            <span class="tl-spin" aria-hidden="true"></span>
            <span class="tl-main">{{ bootKey === v.key ? bootText : '正在起播…' }}</span>
            <span v-if="bootKey === v.key && bootHint" class="tl-hint">{{ bootHint }}</span>
            <span class="tl-time mono">{{ bootElapsed }}s</span>
            <button v-if="bootKey === v.key" class="tl-cancel" @click.stop="cancelBoot">取消</button>
          </div>
        </div>
        <div class="p-meta">
          <div class="p-title">{{ v.title }}</div>
          <div class="p-sub">{{ v.channel }}</div>
        </div>
      </article>
    </div>

    <!-- 空态 -->
    <div v-else class="empty">
      <div class="empty-ico">📭</div>
      <div class="empty-title">{{ emptyTitle }}</div>
      <div class="empty-sub">{{ emptyText }}</div>
      <button v-if="filtered || query" class="btn primary" @click="clearAll">清空筛选条件</button>
      <button v-else class="btn primary" @click="load">重新加载</button>
    </div>

    <!-- P43 翻页：一页只装得下 60 部，想看更多得能往后要 -->
    <div v-if="!loading && list.length && hasMore" class="more-row">
      <button class="btn ghost" :disabled="moreLoading" @click="loadMore">
        <span v-if="moreLoading" class="mr-spin" aria-hidden="true"></span>
        {{ moreLoading ? '加载中…' : '加载更多' }}
      </button>
      <span class="more-hint">已显示 {{ list.length }} 部 · 源站还有更多</span>
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </section>
</template>

<style scoped>
/*
 * 影视库首页（P41 视觉重构）
 *
 * 层级：页头 → 搜索 → 快捷分类 → 高级筛选（收起） → 推荐位 → 继续观看 → 结果栏 → 海报流。
 * 三条硬约束，改样式时别破：
 * 1) 只吃 App.vue 的全局 token（颜色/圆角/间距/字号/动效），组件里不许出现写死的底色，
 *    否则亮色皮肤下必然冒出深色残留（P34 教训）。
 * 2) 海报是 2:3 竖版：源站给的 cover 就是竖版，硬塞 16:9 会把人物裁成一条缝。
 * 3) 首屏优先给内容：筛选面板默认收起、推荐位只在够高时出现（≤820px 高度直接不出）。
 */
.home-view {
  --poster-min: 152px;
  min-width: 0;
}

.icon-btn {
  width: 30px;
  height: 30px;
  padding: 0;
  display: grid;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--panel);
  color: var(--text-dim);
  box-shadow: none;
}
.icon-btn:hover:not(:disabled) {
  border-color: var(--line-hover);
  background: var(--btn-hover);
  color: var(--text);
  transform: none;
}

/* ---- 搜索（pill 形态，页面第一动作） ---- */
.search-bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex: 1 1 300px;
  min-width: 220px;
  max-width: 520px;
  padding: 5px 5px 5px 14px;
  border: 1px solid var(--line);
  border-radius: var(--r-pill);
  background: var(--panel);
  transition: border-color var(--t-base) var(--ease), box-shadow var(--t-base) var(--ease);
}
.search-bar:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.search-ico {
  display: grid;
  place-items: center;
  flex: none;
  color: var(--text-faint);
  transition: color var(--t-base) var(--ease);
}
.search-bar:focus-within .search-ico {
  color: var(--accent);
}
.search-input {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 2px;
  border: none;
  background: transparent;
  font-size: var(--fs-sm);
  color: var(--text);
}
.search-input:hover:not(:disabled),
.search-input:focus {
  border: none;
  background: transparent;
  box-shadow: none;
}
.search-input::placeholder {
  color: var(--text-faint);
}
.search-clear {
  width: 24px;
  height: 24px;
  padding: 0;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 50%;
  background: var(--btn-hover);
  color: var(--text-dim);
  box-shadow: none;
  flex: none;
}
.search-clear:hover:not(:disabled) {
  background: var(--btn-active);
  color: var(--text);
  transform: none;
}
.search-go {
  flex: none;
  min-height: 32px;
  padding: 0 20px;
  border-radius: var(--r-pill);
}

/* ---- 工具条：搜索 + 类型 + 筛选 ---- */
.toolbar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
  flex-wrap: wrap;
}
.qb-types {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  min-width: 0;
  flex: 0 1 auto;
  /* 搜索按钮与「全部」都是强调色实心，中间必须留出比 gap 更大的呼吸位，否则会被读成一个蓝块 */
  margin-left: 6px;
  border: 1px solid var(--line);
  border-radius: var(--r-pill);
  background: var(--panel-2);
  overflow-x: auto;
  scrollbar-width: none;
}
.qb-types::-webkit-scrollbar {
  height: 0;
}
.type-chip {
  flex: none;
  height: 28px;
  padding: 0 15px;
  border: none;
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--text-dim);
  font-size: var(--fs-sm);
  font-weight: 500;
  box-shadow: none;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.type-chip:hover:not(:disabled) {
  background: var(--panel-hover);
  border: none;
  color: var(--text);
  transform: none;
}
.type-chip.active {
  background: var(--accent);
  color: #fff;
  font-weight: 650;
  box-shadow: 0 6px 16px -10px var(--accent);
}
.type-chip.active:hover:not(:disabled) {
  background: var(--accent-hi);
  color: #fff;
}
.view-seg {
  margin-left: auto;
  flex: none;
}
.view-seg button {
  min-height: 28px;
  padding: 0 12px;
  font-size: var(--fs-xs);
}
.filter-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-pill);
  background: var(--panel);
  color: var(--text-dim);
  font-size: var(--fs-xs);
  box-shadow: none;
  flex: none;
}
.filter-btn:hover:not(:disabled) {
  border-color: var(--line-hover);
  background: var(--btn-hover);
  color: var(--text);
  transform: none;
}
.filter-btn.on {
  border-color: var(--accent-line);
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.fb-count {
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  display: grid;
  place-items: center;
  border-radius: var(--r-pill);
  background: var(--accent);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

/* ---- 高级筛选面板 ---- */
.filter-panel {
  margin-bottom: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  background: var(--panel);
}
.fp-row {
  display: grid;
  grid-template-columns: 40px 1fr;
  align-items: center;
  gap: var(--sp-2);
  min-height: 30px;
}
.fp-label {
  font-size: var(--fs-2xs);
  color: var(--text-faint);
}
.fp-chips {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow-x: auto;
  padding: 2px 0;
  scrollbar-width: none;
}
.fp-chips::-webkit-scrollbar {
  height: 0;
}
.fp-chips .chip {
  flex: none;
  min-height: 26px;
  height: 26px;
  padding: 0 11px;
  font-size: var(--fs-2xs);
  line-height: 1.5;
}
.fp-foot {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin-top: var(--sp-2);
  padding-top: var(--sp-2);
  border-top: 1px dashed var(--line);
}
.fp-note {
  margin: 0;
  font-size: var(--fs-2xs);
  line-height: 1.5;
  color: var(--text-faint);
  flex: 1;
  min-width: 0;
}
.fp-note b {
  color: var(--text-dim);
  font-weight: 600;
}
.fp-clear {
  flex: none;
  min-height: 0;
  padding: 3px 8px;
  border: none;
  background: transparent;
  color: var(--text-faint);
  font-size: var(--fs-2xs);
  text-decoration: underline;
  box-shadow: none;
}
.fp-clear:hover:not(:disabled) {
  border: none;
  color: var(--text);
  transform: none;
}

/* ---- 已选条件 ---- */
.active-filters {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: var(--sp-3);
}
.af-label {
  font-size: var(--fs-2xs);
  color: var(--text-faint);
}
.af-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 0;
  padding: 3px 8px 3px 10px;
  border: 1px solid var(--accent-line);
  border-radius: var(--r-pill);
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: var(--fs-2xs);
  box-shadow: none;
}
.af-chip:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--accent-soft);
  transform: none;
}
.af-x {
  font-size: 11px;
  line-height: 1;
  opacity: 0.75;
}
.af-clear {
  min-height: 0;
  padding: 3px 6px;
  border: none;
  background: transparent;
  color: var(--text-faint);
  font-size: var(--fs-2xs);
  text-decoration: underline;
  box-shadow: none;
}
.af-clear:hover:not(:disabled) {
  border: none;
  color: var(--text);
  transform: none;
}

/* ---- 推荐位 ---- */
.hero {
  position: relative;
  height: clamp(180px, 23vh, 296px);
  margin-bottom: var(--sp-4);
  border: 1px solid var(--line);
  border-radius: var(--r-xl);
  background: var(--panel-2);
  overflow: hidden;
}
.slides {
  display: flex;
  height: 100%;
  transition: transform 0.55s var(--ease);
}
.slide {
  position: relative;
  min-width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  padding: 0 clamp(20px, 4%, 44px);
}
.slide-bg {
  position: absolute;
  inset: 0;
  background-color: var(--panel-2);
}
.slide-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  filter: blur(26px) saturate(1.15) brightness(0.52);
  transform: scale(1.22);
}
.slide-shade {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    rgb(6 9 14 / 0.9) 0%,
    rgb(6 9 14 / 0.66) 44%,
    rgb(6 9 14 / 0.1) 74%
  );
}
.slide-info {
  position: relative;
  z-index: 2;
  max-width: min(54%, 560px);
  min-width: 0;
}
.slide-tag {
  display: inline-flex;
  align-items: center;
  padding: 2px 9px;
  margin-bottom: var(--sp-2);
  border: 1px solid rgb(255 255 255 / 0.22);
  border-radius: var(--r-pill);
  background: rgb(255 255 255 / 0.12);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.3px;
  backdrop-filter: blur(6px);
}
.slide-info h2 {
  margin: 0 0 6px;
  color: #fff;
  font-size: var(--fs-2xl);
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: -0.3px;
  text-shadow: 0 2px 14px rgb(0 0 0 / 0.5);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.slide-meta {
  margin: 0;
  color: rgb(255 255 255 / 0.76);
  font-size: var(--fs-xs);
  line-height: 1.5;
  text-shadow: 0 1px 6px rgb(0 0 0 / 0.5);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.slide-ops {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin-top: var(--sp-4);
}
.slide-play {
  min-height: 36px;
  padding: 0 20px;
  border-radius: var(--r-pill);
  display: inline-flex;
  align-items: center;
  gap: 7px;
  box-shadow: 0 10px 24px -12px var(--accent);
}
.slide-idx {
  color: rgb(255 255 255 / 0.55);
  font-size: var(--fs-2xs);
  font-variant-numeric: tabular-nums;
}
/* 右海报：竖版，让「这是什么片」一眼可辨 */
.slide-poster {
  position: absolute;
  right: clamp(20px, 4%, 44px);
  top: 50%;
  transform: translateY(-50%);
  height: 80%;
  aspect-ratio: 2 / 3;
  object-fit: cover;
  border-radius: var(--r-lg);
  box-shadow: 0 24px 48px -20px rgb(0 0 0 / 0.85), 0 0 0 1px rgb(255 255 255 / 0.1);
  z-index: 2;
}
.play-tri {
  width: 0;
  height: 0;
  border-left: 9px solid currentColor;
  border-top: 6px solid transparent;
  border-bottom: 6px solid transparent;
  margin-left: 2px;
}
.slide-live {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  background: var(--accent);
  transform-origin: left;
  animation: slide-progress 5s linear forwards;
  z-index: 4;
}
@keyframes slide-progress {
  from {
    transform: scaleX(0);
  }
  to {
    transform: scaleX(1);
  }
}
.car-btn {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 32px;
  height: 32px;
  padding: 0;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 1px solid rgb(255 255 255 / 0.16);
  background: rgb(8 11 17 / 0.42);
  color: #fff;
  font-size: 17px;
  line-height: 1;
  z-index: 5;
  backdrop-filter: blur(8px);
  opacity: 0;
  transition: opacity var(--t-base) var(--ease), background var(--t-fast) var(--ease);
}
.hero:hover .car-btn,
.car-btn:focus-visible {
  opacity: 1;
}
.car-btn:hover:not(:disabled) {
  background: var(--accent);
  border-color: var(--accent);
  transform: translateY(-50%);
}
.car-btn.prev {
  left: 10px;
}
.car-btn.next {
  right: 10px;
}
.dots {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 6px;
  z-index: 5;
}
.dot {
  width: 6px;
  height: 6px;
  min-height: 0;
  padding: 0;
  border-radius: var(--r-pill);
  border: none;
  background: rgb(255 255 255 / 0.4);
  box-shadow: none;
  transition: width var(--t-slow) var(--ease), background var(--t-fast) var(--ease);
}
.dot:hover:not(:disabled) {
  background: rgb(255 255 255 / 0.8);
  border: none;
  transform: none;
}
.dot.on {
  width: 18px;
  background: #fff;
}

/* ---- 继续观看（横向行） ---- */
.row-block {
  margin-bottom: var(--sp-6);
}
.row-head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
}
.row-head h3 {
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: 650;
  color: var(--text);
}
.row-sub {
  font-size: var(--fs-2xs);
  color: var(--text-faint);
}
.row-track {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 132px;
  gap: var(--sp-3);
  overflow-x: auto;
  scroll-snap-type: x proximity;
  /* 卡片被右边缘切一半就是「还能横滑」的提示，别让系统滚动条压在文字上 */
  scrollbar-width: none;
  padding-bottom: 2px;
}
.row-track::-webkit-scrollbar {
  height: 0;
}
.c-card {
  scroll-snap-align: start;
  min-width: 0;
  cursor: pointer;
}
.c-poster {
  position: relative;
  aspect-ratio: 2 / 3;
  border-radius: var(--r-md);
  overflow: hidden;
  background: linear-gradient(150deg, var(--fallback-a), var(--fallback-b));
  border: 1px solid var(--line);
}
.c-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform var(--t-slow) var(--ease);
}
.c-card:hover .c-img {
  transform: scale(1.04);
}
.c-ph {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 26px;
  color: rgb(255 255 255 / 0.5);
}
.c-resume {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: #fff;
  background: rgb(6 9 14 / 0.42);
  opacity: 0;
  transition: opacity var(--t-base) var(--ease);
}
.c-resume .play-tri {
  border-left-width: 10px;
  border-top-width: 7px;
  border-bottom-width: 7px;
}
.c-card:hover .c-resume,
.c-card:focus-visible .c-resume {
  opacity: 1;
}
.c-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: rgb(255 255 255 / 0.22);
}
.c-bar i {
  display: block;
  height: 100%;
  background: var(--accent);
  border-radius: 0 2px 2px 0;
}
.c-meta {
  padding-top: 7px;
  min-width: 0;
}
.c-title {
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--text);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.c-sub {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
  font-size: 10px;
  color: var(--text-faint);
  min-width: 0;
}
.c-ep {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.c-left {
  flex: none;
  color: var(--accent);
}

/* ---- 结果栏 ---- */
.sec-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 var(--sp-3);
  flex-wrap: wrap;
}
.sec-head h3 {
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: 650;
  color: var(--text);
}
.sec-count {
  font-size: var(--fs-2xs);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
/* 演示数据提示：页头撤掉后唯一还需要「告警」的信息 */
.sec-badge {
  padding: 1px 8px;
  border: 1px solid var(--warn-line);
  border-radius: var(--r-pill);
  background: var(--warn-bg);
  color: var(--warn);
  font-size: var(--fs-2xs);
  white-space: nowrap;
}
.sort-seg {
  margin-left: auto;
}
.sort-seg button {
  padding: 0 10px;
  min-height: 26px;
  font-size: var(--fs-2xs);
}

/* ---- 覆盖率提示 / 起播失败 ---- */
.filter-hint {
  margin: 0 0 var(--sp-3);
  padding: 7px 10px;
  border: 1px solid var(--warn-line);
  border-radius: var(--r-md);
  background: var(--warn-bg);
  color: var(--warn);
  font-size: var(--fs-2xs);
  line-height: 1.55;
}
.boot-alert {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  margin: 0 0 var(--sp-3);
  padding: 10px 12px;
  border: 1px solid var(--danger-line);
  border-radius: var(--r-md);
  background: var(--danger-bg);
}
.boot-alert .ba-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--fs-xs);
  line-height: 1.55;
  color: var(--text);
  word-break: break-word;
}
.boot-alert .ba-ops {
  display: flex;
  gap: 6px;
  flex: none;
}

/* ---- 海报网格 ---- */
.poster-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(var(--poster-min), 100%), 1fr));
  gap: var(--sp-4) var(--sp-3);
}

/* P43 翻页：按钮居中 + 一行灰字说明「为什么还有」。不用无限滚动 ——
   全应用唯一的滚动容器是 .content，挂观察器容易和视图切换抢生命周期。 */
.more-row {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-5) 0 var(--sp-3);
}
.more-row .btn {
  min-width: 160px;
  gap: 8px;
}
.more-hint {
  font-size: var(--fs-2xs);
  color: var(--text-faint);
}
.mr-spin {
  display: inline-block;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-top-color: transparent;
  opacity: 0.65;
  animation: tl-rot 0.9s linear infinite;
}
.p-card {
  min-width: 0;
  padding: 0;
  border: none;
  background: transparent;
  box-shadow: none;
  cursor: pointer;
  text-align: left;
}
.p-card:hover,
.p-card:focus-visible {
  border: none;
  background: transparent;
  box-shadow: none;
  transform: none;
}
.p-poster {
  position: relative;
  aspect-ratio: 2 / 3;
  border-radius: var(--r-lg);
  overflow: hidden;
  background: var(--fallback-a);
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.35);
  transition: box-shadow var(--t-base) var(--ease), transform var(--t-base) var(--ease);
}
.p-card:hover .p-poster {
  transform: translateY(-2px);
  box-shadow: 0 16px 30px -16px rgb(0 0 0 / 0.85);
}
.p-fallback {
  position: absolute;
  inset: 0;
}
.p-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform var(--t-slow) var(--ease);
}
.p-card:hover .p-img {
  transform: scale(1.05);
}
.p-ph {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 30px;
}
/* 海报上的角标：恒用深色底 + 白字（压在海报上，与页面皮肤无关） */
.p-score {
  position: absolute;
  left: 6px;
  top: 6px;
  padding: 1px 6px;
  border-radius: var(--r-sm);
  background: rgb(6 9 14 / 0.72);
  color: var(--gold);
  font-size: 11px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  backdrop-filter: blur(4px);
}
.p-tag {
  position: absolute;
  right: 6px;
  top: 6px;
  max-width: calc(100% - 60px);
  padding: 1px 6px;
  border-radius: var(--r-sm);
  background: rgb(6 9 14 / 0.72);
  color: #fff;
  font-size: 10px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  backdrop-filter: blur(4px);
}
.p-tag.live {
  background: rgb(204 32 44 / 0.9);
  letter-spacing: 0.4px;
}
.p-st {
  position: absolute;
  left: 6px;
  bottom: 6px;
  padding: 1px 6px;
  border-radius: var(--r-sm);
  background: rgb(6 9 14 / 0.6);
  color: rgb(255 255 255 / 0.86);
  font-size: 10px;
  backdrop-filter: blur(4px);
}
.p-hover {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: linear-gradient(180deg, rgb(6 9 14 / 0.02) 30%, rgb(6 9 14 / 0.66));
  opacity: 0;
  transition: opacity var(--t-base) var(--ease);
}
.p-card:hover .p-hover,
.p-card:focus-visible .p-hover {
  opacity: 1;
}
.p-play {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: rgb(255 255 255 / 0.94);
  color: #0b0e14;
  box-shadow: 0 10px 24px -10px rgb(0 0 0 / 0.9);
}
.p-card.playing {
  pointer-events: none;
}
.p-loading {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 10px;
  background: rgb(6 9 14 / 0.76);
  color: #fff;
  text-align: center;
  backdrop-filter: blur(2px);
}
.tl-spin {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid rgb(255 255 255 / 0.24);
  border-top-color: #fff;
  animation: tl-rot 0.9s linear infinite;
}
@keyframes tl-rot {
  to {
    transform: rotate(360deg);
  }
}
.tl-main {
  font-size: var(--fs-2xs);
  font-weight: 600;
  line-height: 1.35;
}
.tl-hint {
  font-size: 10px;
  line-height: 1.35;
  color: rgb(255 255 255 / 0.7);
}
.tl-time {
  font-size: 10px;
  color: rgb(255 255 255 / 0.55);
}
.tl-cancel {
  pointer-events: auto;
  min-height: 0;
  margin-top: 2px;
  padding: 3px 12px;
  border-radius: var(--r-pill);
  border: 1px solid rgb(255 255 255 / 0.3);
  background: rgb(255 255 255 / 0.14);
  color: #fff;
  font-size: 10px;
}
.tl-cancel:hover:not(:disabled) {
  background: rgb(255 255 255 / 0.24);
  border-color: rgb(255 255 255 / 0.42);
}
.p-meta {
  padding-top: 8px;
  min-width: 0;
}
.p-title {
  font-size: var(--fs-xs);
  font-weight: 600;
  line-height: 1.42;
  color: var(--text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 2.84em;
}
.p-sub {
  margin-top: 2px;
  font-size: 10px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- 骨架屏 ---- */
.p-card.sk {
  cursor: default;
}
.sk-poster {
  aspect-ratio: 2 / 3;
  border-radius: var(--r-lg);
  background: var(--skeleton);
  animation: sk-pulse 1.4s var(--ease) infinite;
}
.sk-line {
  height: 10px;
  margin-top: 9px;
  border-radius: var(--r-sm);
  background: var(--skeleton);
  animation: sk-pulse 1.4s var(--ease) infinite;
}
.sk-line.w80 {
  width: 80%;
}
.sk-line.w50 {
  width: 50%;
  margin-top: 6px;
}
@keyframes sk-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}

/* ---- 响应式 ---- */
/* 窄窗口：海报缩到 128px，一行仍能放 4-5 张，避免只剩两张巨型卡 */
@media (max-width: 1180px) {
  .home-view {
    --poster-min: 140px;
  }
  /* 宽度不够时搜索独占一行，类型条与筛选排下一行，别把输入框挤成一条缝 */
  .search-bar {
    flex-basis: 100%;
    max-width: none;
    order: -1;
  }
  .slide-info h2 {
    font-size: var(--fs-xl);
  }
}
@media (max-width: 900px) {
  .home-view {
    --poster-min: 124px;
  }
  /* 类型条按内容宽度收（不收满）：撑满会把胶囊右半边留成空白，比「筛选」单独一行更难看 */
  .hero {
    height: clamp(180px, 26vh, 240px);
  }
  .slide-info {
    max-width: 62%;
  }
  .slide-poster {
    height: 70%;
  }
  .row-track {
    grid-auto-columns: 112px;
  }
  .fp-row {
    grid-template-columns: 1fr;
    gap: 2px;
    align-items: start;
    padding: 3px 0;
  }
}
@media (max-width: 720px) {
  .home-view {
    --poster-min: 96px;
  }
  .row-track {
    grid-auto-columns: 104px;
  }
  /* 结果栏挤成一行：排序收到最窄，省下的 34px 给海报 */
  .sec-head {
    gap: 8px;
  }
  .sort-seg button {
    padding: 0 8px;
  }
  .hh-title {
    font-size: var(--fs-lg);
  }
  .slide-poster {
    display: none;
  }
  .slide-info {
    max-width: 100%;
  }
  .slide-info h2 {
    font-size: var(--fs-lg);
  }
  .slide-idx {
    display: none;
  }
  .poster-grid {
    gap: var(--sp-3) var(--sp-2);
  }
  .p-title {
    font-size: var(--fs-2xs);
  }
}

</style>
