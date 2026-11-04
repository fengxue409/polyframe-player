/**
 * P7 影视发现与片源聚合（Pinia）
 *
 * 职责：CMS 源站管理、聚合搜索、详情拉取、收藏合并与手动补充片源；
 * 播放复用 player store（task.create → playTask 跨页起播）。
 * 海报统一走 core /pic 透传（防盗链 Referer + 浏览器 UA）。
 */
import { defineStore } from 'pinia'
import {
  RpcMethod,
  type CatalogCard,
  type CatalogDetail,
  type CatalogEpisode,
  type CatalogEpisodeGroup,
  type CatalogSource,
  type CatalogSourcePreset,
  type CacheSummary,
  type Favorite,
  type FavoriteAutoscanStatus,
  type FavoriteRefreshItem,
  type FavoriteSource,
  type SeriesPrefetchStatus,
  type TmdbInfo,
  type WatchProgress
} from '@polyframe/shared'
import { usePlayerStore } from './player'

/** 单次 RPC 导入/测速的批大小（服务端并发 12，单批一轮探测 ≤ 4s，避免 RPC 超时） */
const PROBE_BATCH = 12

/**
 * 翻页追加去重（P43）。内核每页现算聚合表，跨页没有记忆：站内更新流抖动、
 * 或干脆忽略 `pg` 的站，都会把同一条再给一遍。按 `key`（片名|年份）合并，
 * 已有的保留先到的那条（封面/评分更可能已就绪）。
 */
export function mergeCards(base: CatalogCard[], extra: CatalogCard[]): CatalogCard[] {
  if (!extra.length) return base
  const seen = new Set(base.map((c) => c.key))
  const out = base.slice()
  for (const c of extra) {
    if (seen.has(c.key)) continue
    seen.add(c.key)
    out.push(c)
  }
  return out
}

// ---- P27 起播预算：宁可早点告诉用户「这个源不行」，也别让转圈转一分钟 ----

/** 单站详情（拉剧集列表）最长等待 */
const BOOT_DETAIL_MS = 9_000
/** 建任务 + 起播最长等待 */
const BOOT_TASK_MS = 12_000
/** 一次点击的总预算（超过就带着已收集的原因报错，用户可以重试/换片） */
const BOOT_BUDGET_MS = 26_000

/** 起播阶段（首页覆盖层按它显示人话） */
export interface BootState {
  /** 卡片 key（首页据此给对应卡片盖覆盖层） */
  key: string
  title: string
  phase: 'detail' | 'task' | 'start'
  /** 当前尝试第几个片源（1-based） */
  attempt: number
  attempts: number
  startedAt: number
}

/** 用户主动取消（与「失败」区分：取消不该弹错误提示） */
export class BootCancelled extends Error {
  constructor() {
    super('已取消起播')
    this.name = 'BootCancelled'
  }
}

/**
 * 给 Promise 套一个硬超时。
 * 内核的 fetch_text 单次可以挂 30s 以上（多站聚合 × 重试），
 * 不设上限时 UI 只能无限等待；这里到点就放弃这次尝试，换下一个片源。
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const budget = Math.max(600, ms)
    const timer = window.setTimeout(() => {
      reject(new Error(`${label}超时（${Math.round(budget / 1000)}s 无响应）`))
    }, budget)
    p.then(
      (v) => {
        window.clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        window.clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    )
  })
}

/** P9 分类浏览大类（与服务端 category_matches 关键词一致） */
export const CATEGORIES = ['电影', '剧集', '动漫', '综艺'] as const

/**
 * P20 播放上下文：起播方（详情弹层 / 收藏 / 继续观看）带过来的影片信息，
 * 播放页侧栏据此展示标题、简介、剧集与来源。
 *
 * 为什么不让播放页自己回源查：采集站详情要按 api+vodId 重新拉一遍（P19 虽有缓存，
 * 但收藏/网盘/直链场景根本没有 api），起播方手里现成有，传一次最省事也最可靠。
 */
export interface PlayContext {
  title: string
  /** 当前集名（随选集更新） */
  subtitle?: string
  poster?: string
  content?: string
  year?: string
  typeName?: string
  remarks?: string
  area?: string
  actor?: string
  director?: string
  /** 来源站名 / 收藏来源描述 */
  siteName?: string
  /** 采集站 api + vodId（有则侧栏可回源换线路；收藏/直链为空） */
  api?: string
  vodId?: string
  /** 全部线路分组（侧栏「线路」切换用；无则空数组） */
  groups: CatalogEpisodeGroup[]
  /** 当前队列所属分组下标 */
  groupIndex: number
  /** P22 同一部片的其它站条目（侧栏「片源」下拉跨站换源用） */
  sources: PlaySourceRef[]
  /** 当前片源在 sources 中的下标 */
  sourceIndex: number
  favoriteId?: string
  /** 起播时刻（列表排序/调试用） */
  startedAt: number
}

/** P22 播放页可切换的片源（聚合卡片里的单站条目） */
export interface PlaySourceRef {
  siteName: string
  api: string
  vodId: string
  sourceId?: string
}

/** P11 地区筛选项（value 为多候选关键词，用 | 连接，与服务端 area_matches 一致） */
export const AREAS: ReadonlyArray<{ label: string; value: string }> = [
  { label: '大陆', value: '大陆|内地' },
  { label: '香港', value: '香港|港' },
  { label: '台湾', value: '台湾|台' },
  { label: '美国', value: '美国|美' },
  { label: '韩国', value: '韩国|韩' },
  { label: '日本', value: '日本|日' },
  { label: '英国', value: '英国|英' },
  { label: '泰国', value: '泰国' }
]

export const useCatalogStore = defineStore('catalog', {
  state: () => ({
    sources: [] as CatalogSource[],
    sourcesLoading: false,
    // ---- 预设库 / 批量导入 ----
    presetsLoading: false,
    presetVersion: 0,
    presetTotal: 0,
    presetInstalled: 0,
    /** 本机缺失的预设行（`名称$URL`，供同步时按批提交） */
    presetMissing: [] as string[],
    /** 最近一次导入的人类可读摘要 */
    lastImportSummary: '',
    // ---- 搜索 ----
    query: '',
    lastQuery: '',
    searching: false,
    cards: [] as CatalogCard[],
    /** 搜索失败/无结果的站名列表（源站健康提示） */
    searchFailures: [] as string[],
    /** P19 上次搜索的缓存摘要（来自缓存/回退旧数据的源站数） */
    searchCache: null as CacheSummary | null,
    // ---- 详情弹层 ----
    detail: null as CatalogDetail | null,
    detailLoading: false,
    /** 换源软加载：详情头部（海报/简介）保持不动，仅下方片源/剧集区刷新 */
    detailSwitching: false,
    detailError: '',
    /** 聚合卡片快照（详情弹层里做「换源」用；离开弹层清空） */
    detailCard: null as CatalogCard | null,
    /** 正在播放的集（防重复点击） */
    playingKey: '',
    /**
     * 起播序号：用户连点多个视频时，只有最后一次点击的结果有效。
     * task.create 在源站慢时要几秒到几十秒，期间每次点击都会建一个任务并启动预取，
     * 十几个并发任务会把 CDN 打满 → 后面几次创建反而超时（表现为「点几个就播不了」）。
     */
    playSeq: 0,
    /**
     * P27 起播进度（首页卡片覆盖层用）：有值 = 正在为这次点击找线路/建任务。
     * phase 分档是为了让用户知道「卡在哪一步」，而不是一个转圈转 40 秒。
     */
    boot: null as BootState | null,
    /** 取消序号：用户点「取消」后自增，正在跑的起播循环看到它就不再往下试 */
    bootSeq: 0,
    // ---- 收藏 ----
    favorites: [] as Favorite[],
    /** 弹层中的收藏片源列表 */
    favoriteSources: [] as FavoriteSource[],
    activeFavoriteId: '',
    sourcesLoadingFor: '' as string,
    /**
     * P33 全部收藏的片源快照（favoriteId → sources）。
     * 媒体库要把任务归到「视频」，必须知道每个收藏的剧集 URL 与各站封面。
     */
    sourcesByFav: {} as Record<string, FavoriteSource[]>,
    sourcesLoadingAll: false,
    manualUrls: '',
    // ---- P9 分类浏览 / 更新流（吸收 GYING） ----
    catCards: [] as CatalogCard[],
    catFailures: [] as string[],
    /** P19 上次分类/更新流的缓存摘要 */
    catCache: null as CacheSummary | null,
    catCategory: '' as '' | (typeof CATEGORIES)[number],
    catYear: '',
    /** P11 地区筛选（服务端 vod_area 包含匹配；空 = 全部） */
    catArea: '',
    /** P11 排序：time = 更新时间降序（默认）；hot = 收录站数降序（热门榜） */
    catSort: 'time' as 'time' | 'hot',
    /** >0 = 最近 N 小时更新流（苹果CMS h 参数）；0 = 全量翻页 */
    catHours: 0,
    catPage: 0,
    catHasMore: false,
    catLoading: false,
    /** P43 请求序号：并发时只认最后一次，避免慢回来的旧请求覆盖新条件 */
    catSeq: 0,
    // ---- P9 剧集连播队列 ----
    queue: [] as CatalogEpisode[],
    queueIndex: -1,
    queueTitle: '',
    /** 队列来源收藏 id（非空 = 进度随集推进） */
    queueFavoriteId: '',
    /** P20 播放页侧栏的影片上下文（手动直链播放时为 null） */
    playCtx: null as PlayContext | null,
    /** P46 当前剧集的预缓存窗口状态（起播后由内核回传，侧栏展示 + 5s 刷新） */
    prefetch: null as SeriesPrefetchStatus | null,
    // ---- P9 观看进度 / 继续观看 ----
    nowPlaying: null as { favoriteId: string; episodeName: string; episodeUrl: string } | null,
    continueWatching: [] as WatchProgress[],
    /** 续播定位（秒；0 = 不 seek），PlayerView 在 canplay 后消费 */
    pendingSeek: 0,
    // ---- P9 追更 ----
    refreshing: false,
    /** 每收藏新增集数徽章（打开片源弹层时清除） */
    favUpdates: {} as Record<string, number>,
    // ---- P11 追更后台巡检状态 ----
    autoscan: null as FavoriteAutoscanStatus | null,
    // ---- P15 源站健康巡检 ----
    /** 最近一次全量测速发现的失效站（启用中的）id；一键停用后清空 */
    deadIds: [] as string[],
    deadNames: [] as string[],
    disablingDead: false,
    // ---- P11 TMDB 评分增强 ----
    tmdbKey: '',
    /** 详情弹层评分缓存（name|year → info），避免重复请求 */
    tmdbCache: {} as Record<string, TmdbInfo>
  }),

  getters: {
    enabledCount: (s) => s.sources.filter((x) => x.enabled).length,
    /** 连播：下一集（无则空串） */
    nextEpisode: (s) => (s.queueIndex >= 0 ? (s.queue[s.queueIndex + 1] ?? null) : null),
    /** 当前集（无则 null） */
    currentEpisode: (s) => (s.queueIndex >= 0 ? (s.queue[s.queueIndex] ?? null) : null),
    /** P20 侧栏线路分组（空数组 = 单线路/无剧集信息） */
    playGroups: (s) => s.playCtx?.groups ?? [],
    /** 继续观看：已看过一段（>15s）且未接近片尾（<30s）才提示续播定位 */
    continueItems: (s) =>
      s.continueWatching.filter((w) => w.durationSec > 0 && w.positionSec > 15)
  },

  actions: {
    rpc(method: string, params?: unknown): Promise<unknown> {
      return usePlayerStore().rpc(method, params)
    },

    /** 海报经 core /pic 透传（token 未就绪时回退直连） */
    posterUrl(u?: string | null): string {
      if (!u) return ''
      const p = usePlayerStore()
      if (p.proxyPort && p.proxyToken) {
        return `http://127.0.0.1:${p.proxyPort}/pic/${p.proxyToken}?u=${encodeURIComponent(u)}`
      }
      return u
    },

    // ---------- P9 分类浏览 / 更新流（吸收 GYING） ----------

    /** 拉分类/更新流（reset=true 第一页，否则加载下一页追加） */
    async loadCategory(reset = true) {
      // P43：改成「最后一次请求生效」，不再「加载中就直接丢弃」。
      // 旧写法 `if (catLoading) return` 会把「加载过程中改筛选条件」的那次请求静默吞掉，
      // 界面停在上一条件的结果上 —— 用户看到的就是「这个条件只有这么点片子」。
      const seq = ++this.catSeq
      const pg = reset ? 1 : this.catPage + 1
      this.catLoading = true
      try {
        const r = (await this.rpc(RpcMethod.CatalogCategory, {
          pg,
          hours: this.catHours > 0 ? this.catHours : undefined,
          category: this.catCategory || undefined,
          year: this.catYear || undefined,
          area: this.catArea || undefined,
          sort: this.catSort
        })) as { cards: CatalogCard[]; failures: string[]; page: number; hasMore: boolean; cache?: CacheSummary }
        if (seq !== this.catSeq) return
        this.catPage = r.page
        this.catHasMore = r.hasMore
        this.catFailures = r.failures
        this.catCache = r.cache ?? null
        // P43：追加时按聚合键去重 —— 翻页重叠（站内排序抖动、忽略 pg 的站）会让同一条重复出现
        this.catCards = reset ? r.cards : mergeCards(this.catCards, r.cards)
      } finally {
        if (seq === this.catSeq) this.catLoading = false
      }
    },

    /** 改筛选条件（大类/年份/地区/排序/更新流）并回到第一页 */
    setCategoryFilter(patch: { category?: string; year?: string; area?: string; sort?: 'time' | 'hot'; hours?: number }) {
      if (patch.category !== undefined) this.catCategory = patch.category as typeof this.catCategory
      if (patch.year !== undefined) this.catYear = patch.year
      if (patch.area !== undefined) this.catArea = patch.area
      if (patch.sort !== undefined) this.catSort = patch.sort
      if (patch.hours !== undefined) this.catHours = patch.hours
      return this.loadCategory(true)
    },

    // ---------- P9 剧集连播队列 ----------

    /**
     * 入队起播：同组剧集整组进队，PlayerView 的 ended 事件驱动自动连播。
     * favoriteId 非空时进度随集推进（来自收藏片源弹层）。
     * ctx 为 P20 播放页侧栏信息（详情/海报/简介/线路），缺省时侧栏仅显示标题与队列。
     */
    async playFromQueue(
      episodes: CatalogEpisode[],
      index: number,
      title: string,
      favoriteId = '',
      ctx?: Partial<PlayContext>
    ) {
      const ep = episodes[index]
      if (!ep) return
      this.queue = episodes.map((e) => ({ name: e.name, url: e.url }))
      this.queueIndex = index
      this.queueTitle = title
      this.queueFavoriteId = favoriteId
      this.playCtx = {
        groups: [],
        groupIndex: 0,
        sources: [],
        sourceIndex: 0,
        startedAt: Date.now(),
        ...ctx,
        title: ctx?.title || title,
        // 当前集名以实际起播的集为准（ctx 里的 subtitle 是上一个入口的残留）
        subtitle: ep.name
      }
      this.nowPlaying = favoriteId
        ? { favoriteId, episodeName: ep.name, episodeUrl: ep.url }
        : null
      await this.playEpisode(ep.url, `${title} · ${ep.name}`)
      if (favoriteId) {
        await this.rpc(RpcMethod.CatalogFavoriteTouch, { id: favoriteId }).catch(() => {})
        await this.refreshFavorites().catch(() => {})
      }
    },

    /**
     * 切到队列第 index 集并起播（侧栏/详情弹层选集入口）。
     * 同集且正在播放时直接返回 —— 避免重复建任务导致播放中断。
     */
    async playAt(index: number, force = false): Promise<boolean> {
      const ep = this.queue[index]
      if (!ep) return false
      if (!force && index === this.queueIndex && usePlayerStore().playing) return false
      const prev = this.queueIndex
      this.queueIndex = index
      if (this.playCtx) this.playCtx.subtitle = ep.name
      if (this.queueFavoriteId) {
        this.nowPlaying = {
          favoriteId: this.queueFavoriteId,
          episodeName: ep.name,
          episodeUrl: ep.url
        }
      }
      try {
        await this.playEpisode(ep.url, `${this.queueTitle} · ${ep.name}`)
      } catch (e) {
        this.queueIndex = prev
        throw e
      }
      if (this.queueFavoriteId) {
        await this.rpc(RpcMethod.CatalogFavoriteTouch, { id: this.queueFavoriteId }).catch(() => {})
      }
      return true
    },

    /** 播下一集（ended 事件 / 「下一集」按钮）；返回是否还有下一集 */
    async playNext(): Promise<boolean> {
      if (this.queueIndex + 1 >= this.queue.length) return false
      return this.playAt(this.queueIndex + 1, true)
    },

    /**
     * 侧栏切线路（同一部片的另一个播放源分组）。
     * 按集名对齐：换线路尽量停在同集，找不到同名集再回到第一集。
     */
    async switchPlayGroup(gi: number): Promise<boolean> {
      const g = this.playCtx?.groups[gi]
      if (!g?.episodes.length) return false
      const curName = this.queue[this.queueIndex]?.name
      const idx = curName ? g.episodes.findIndex((e) => e.name === curName) : -1
      this.queue = g.episodes.map((e) => ({ name: e.name, url: e.url }))
      if (this.playCtx) this.playCtx.groupIndex = gi
      this.queueIndex = -1
      return this.playAt(idx >= 0 ? idx : 0, true)
    },

    /**
     * 从采集站详情构造播放上下文（详情弹层起播用；群组需与 groups 下标一致）。
     * sources 缺省时取聚合卡片快照（详情弹层场景），用于播放页跨站换源下拉。
     */
    contextFromDetail(
      detail: CatalogDetail,
      groupIndex = 0,
      sources?: PlaySourceRef[]
    ): Partial<PlayContext> {
      const groups = detail.groups
        .filter((g) => g.episodes.length)
        .map((g) => ({
          from: g.from,
          episodes: g.episodes.map((e) => ({ name: e.name, url: e.url }))
        }))
      const list: PlaySourceRef[] =
        sources ??
        (this.detailCard?.entries ?? []).map((e) => ({
          siteName: e.siteName,
          api: e.api,
          vodId: e.vodId,
          sourceId: e.sourceId
        }))
      const si = list.findIndex((s) => sameApi(s.api, detail.api) && s.vodId === detail.vodId)
      return {
        title: detail.name,
        poster: detail.poster,
        content: detail.content,
        year: detail.year,
        typeName: detail.typeName,
        remarks: detail.remarks,
        actor: detail.actor,
        director: detail.director,
        // 源站名以聚合条目为准：内核反查不到源站时会退回 host:port，界面上很难看
        siteName: (si >= 0 ? list[si]?.siteName : '') || detail.siteName,
        api: detail.api,
        vodId: detail.vodId,
        groups,
        groupIndex: Math.max(0, Math.min(groupIndex, groups.length - 1)),
        sources: list,
        sourceIndex: si >= 0 ? si : 0
      }
    },

    /** 从收藏构造播放上下文（收藏列表只存影片级信息，线路由片源决定） */
    favoriteContext(favoriteId: string, siteName = '', groups: CatalogEpisodeGroup[] = []): Partial<PlayContext> {
      const fav = this.favorites.find((f) => f.id === favoriteId)
      return {
        title: fav?.name ?? '',
        poster: fav?.poster,
        content: fav?.content,
        year: fav?.year,
        typeName: fav?.typeName,
        remarks: fav?.remarks,
        siteName: siteName || (fav ? '收藏' : ''),
        groups,
        groupIndex: 0,
        favoriteId
      }
    },

    /** 清空队列与侧栏上下文（手动直链播放时调用） */
    clearQueue() {
      this.queue = []
      this.queueIndex = -1
      this.queueTitle = ''
      this.queueFavoriteId = ''
      this.nowPlaying = null
      this.playCtx = null
      this.pendingSeek = 0
      this.prefetch = null
    },

    /**
     * 直链/解析起播：只带一个标题，不假装有剧集信息。
     * 与「从未播放」的空态区分开 —— 正在放东西时侧栏不该提示「去发现页选集」。
     */
    setLooseContext(title: string, siteName = '直链播放') {
      const t = title.trim() || '直链播放'
      this.queue = []
      this.queueIndex = -1
      this.prefetch = null
      this.queueTitle = t
      this.queueFavoriteId = ''
      this.nowPlaying = null
      this.playCtx = {
        title: t,
        groups: [],
        groupIndex: 0,
        sources: [],
        sourceIndex: 0,
        startedAt: Date.now(),
        siteName
      }
    },

    // ---------- P9 观看进度 / 继续观看 ----------

    /** 播放进度上报（PlayerView timeupdate 节流调用；无收藏上下文时忽略） */
    async reportProgress(position: number, duration: number) {
      const ctx = this.nowPlaying
      if (!ctx || !Number.isFinite(duration) || duration <= 0) return
      await this.rpc(RpcMethod.CatalogFavoriteProgressSet, {
        favoriteId: ctx.favoriteId,
        episodeName: ctx.episodeName,
        episodeUrl: ctx.episodeUrl,
        position: Math.floor(position),
        duration: Math.floor(duration)
      }).catch(() => {})
    },

    async refreshContinueWatching() {
      const r = (await this.rpc(RpcMethod.CatalogProgressList, { limit: 20 })) as {
        items: WatchProgress[]
      }
      this.continueWatching = r.items
    },

    /** 续播：重建队列到记录的那一集并 seek 到记录位置 */
    async resumeProgress(item: WatchProgress) {
      // 续播定位：看过 >15s 且距片尾 >30s 才跳，否则从头播
      const nearEnd = item.durationSec > 0 && item.positionSec > item.durationSec - 30
      this.pendingSeek = item.positionSec > 15 && !nearEnd ? item.positionSec : 0
      const fav = this.favorites.find((f) => f.id === item.favoriteId)
      await this.playFromQueue(
        [{ name: item.episodeName, url: item.episodeUrl }],
        0,
        item.favoriteName,
        item.favoriteId,
        {
          title: item.favoriteName,
          poster: item.poster ?? fav?.poster,
          content: fav?.content,
          year: item.year ?? fav?.year,
          typeName: fav?.typeName,
          remarks: fav?.remarks,
          siteName: fav ? '收藏' : '',
          groups: [],
          groupIndex: 0,
          favoriteId: item.favoriteId
        }
      )
      await this.refreshContinueWatching().catch(() => {})
    },

    // ---------- P9 追更 ----------

    /** 检查收藏更新：回拉片源详情对比集数；id 缺省 = 全部收藏 */
    async refreshFavoriteUpdates(id?: string): Promise<FavoriteRefreshItem[]> {
      this.refreshing = true
      try {
        const r = (await this.rpc(RpcMethod.CatalogFavoriteRefresh, id ? { id } : {})) as {
          checked: number
          updated: FavoriteRefreshItem[]
        }
        for (const u of r.updated) {
          this.favUpdates[u.favoriteId] = (this.favUpdates[u.favoriteId] ?? 0) + u.added
        }
        if (!id) await this.refreshFavorites()
        return r.updated
      } finally {
        this.refreshing = false
      }
    },

    // ---------- P11 追更后台巡检 ----------

    /** 拉取后台巡检状态（run=true 时同步触发一轮） */
    async loadAutoScan(run = false) {
      const r = (await this.rpc(RpcMethod.CatalogFavoriteAutoscan, run ? { run: true } : {})) as FavoriteAutoscanStatus
      this.autoscan = r
      return r
    },

    /** 修改后台巡检间隔（小时；0 = 关闭，1–72） */
    async setAutoScanInterval(hours: number) {
      const r = (await this.rpc(RpcMethod.CatalogFavoriteAutoscan, { intervalHours: hours })) as FavoriteAutoscanStatus
      this.autoscan = r
      return r
    },

    // ---------- P11 TMDB 评分增强 ----------

    async loadTmdbKey() {
      const r = (await this.rpc(RpcMethod.CatalogTmdbGet)) as { key: string }
      this.tmdbKey = r.key
      return r.key
    },

    async saveTmdbKey(key: string) {
      const r = (await this.rpc(RpcMethod.CatalogTmdbSet, { key: key.trim() })) as { key: string }
      this.tmdbKey = r.key
    },

    /** 详情评分查询（带缓存；无 Key / 失败静默返回 null） */
    async lookupTmdb(name: string, year?: string): Promise<TmdbInfo | null> {
      const cacheKey = `${name}|${year ?? ''}`
      const hit = this.tmdbCache[cacheKey]
      if (hit) return hit.found ? hit : null
      try {
        const r = (await this.rpc(RpcMethod.CatalogTmdbLookup, { name, year: year || undefined })) as TmdbInfo
        this.tmdbCache[cacheKey] = r
        return r.found ? r : null
      } catch {
        return null
      }
    },

    // ---------- 源站管理 ----------

    async refreshSources() {
      this.sourcesLoading = true
      try {
        const r = (await this.rpc(RpcMethod.CatalogSourceList)) as { sources: CatalogSource[] }
        this.sources = r.sources
      } finally {
        this.sourcesLoading = false
      }
    },

    async addSource(name: string, api: string) {
      await this.rpc(RpcMethod.CatalogSourceAdd, { name, api })
      await this.refreshSources()
    },

    async updateSource(id: string, patch: { name?: string; enabled?: boolean }) {
      const r = (await this.rpc(RpcMethod.CatalogSourceUpdate, { id, ...patch })) as {
        source: CatalogSource
      }
      const i = this.sources.findIndex((s) => s.id === id)
      if (i >= 0) this.sources.splice(i, 1, r.source)
    },

    async removeSource(id: string) {
      await this.rpc(RpcMethod.CatalogSourceRemove, { id })
      this.sources = this.sources.filter((s) => s.id !== id)
    },

    /** 测速：返回延迟（失败抛错，调用方 toast） */
    async testSource(id: string): Promise<number> {
      const r = (await this.rpc(RpcMethod.CatalogSourceTest, { id })) as {
        probe: { ok: boolean; latencyMs?: number | null; error?: string }
      }
      if (!r.probe.ok) throw new Error(r.probe.error ?? '探测失败')
      await this.refreshSources()
      return r.probe.latencyMs ?? 0
    },

    // ---------- P8 预设库 / 批量导入 / 全量测速 ----------

    async loadPresetStat() {
      this.presetsLoading = true
      try {
        const r = (await this.rpc(RpcMethod.CatalogSourcePresets)) as {
          version: number
          total: number
          installed: number
          presets: CatalogSourcePreset[]
        }
        this.presetVersion = r.version
        this.presetTotal = r.total
        this.presetInstalled = r.installed
        this.presetMissing = r.presets.filter((p) => !p.installed).map((p) => `${p.name}$${p.api}`)
      } finally {
        this.presetsLoading = false
      }
    },

    /** 同步预设库：只补本机缺失项（按批探测入库，已存在的同 API 自动跳过） */
    async syncPresets(): Promise<{ added: number; failed: number }> {
      await this.loadPresetStat()
      const lines = this.presetMissing
      if (!lines.length) return { added: 0, failed: 0 }
      let added = 0
      let failed = 0
      for (let i = 0; i < lines.length; i += PROBE_BATCH) {
        const text = lines.slice(i, i + PROBE_BATCH).join('\n')
        const r = (await this.rpc(RpcMethod.CatalogSourceImport, {
          text,
          probe: true,
          builtin: true,
          enabled: true
        })) as { importedCount: number; failedCount: number }
        added += r.importedCount
        failed += r.failedCount
      }
      await Promise.all([this.refreshSources(), this.loadPresetStat()])
      return { added, failed }
    },

    /**
     * 批量导入：粘贴文本或订阅 URL。
     * 文本先按行切批（大清单不会被单次 RPC 拖超时），服务端逐条探测后入库。
     */
    async importSources(input: { text?: string; url?: string }): Promise<{
      importedCount: number
      skipped: number
      failedCount: number
      adultDropped: number
      failed: string[]
    }> {
      const sum = { importedCount: 0, skipped: 0, failedCount: 0, adultDropped: 0, failed: [] as string[] }
      if (input.url?.trim()) {
        const r = (await this.rpc(RpcMethod.CatalogSourceImport, {
          text: input.text ?? '',
          url: input.url.trim(),
          probe: true
        })) as {
          importedCount: number
          skipped: number
          failedCount: number
          adultDropped: number
          failed: Array<{ name: string; error: string }>
        }
        sum.importedCount += r.importedCount
        sum.skipped += r.skipped
        sum.failedCount += r.failedCount
        sum.adultDropped += r.adultDropped
        sum.failed.push(...r.failed.map((f) => `${f.name}（${f.error}）`))
      } else {
        const lines = (input.text ?? '')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#') && !l.startsWith('//'))
        if (!lines.length) return sum
        // 纯 JSON / Base58 订阅内容不切行，直接整段交给服务端解析
        const isJson = /^[[{]/.test(lines.join('').slice(0, 1))
        const batches = isJson ? [lines.join('\n')] : chunkLines(lines, PROBE_BATCH)
        for (const text of batches) {
          const r = (await this.rpc(RpcMethod.CatalogSourceImport, { text, probe: true })) as {
            importedCount: number
            skipped: number
            failedCount: number
            adultDropped: number
            failed: Array<{ name: string; error: string }>
          }
          sum.importedCount += r.importedCount
          sum.skipped += r.skipped
          sum.failedCount += r.failedCount
          sum.adultDropped += r.adultDropped
          sum.failed.push(...r.failed.map((f) => `${f.name}（${f.error}）`))
        }
      }
      await this.refreshSources()
      return sum
    },

    /** 全量测速：按批调用（每批 12 个并发），回写延迟后刷新列表。
     *  同时记录失效站（P15 一键停用入口）：deadIds 只含「当前启用中」的失效站。 */
    async probeAllSources(): Promise<{ ok: number; fail: number; dead: string[] }> {
      const ids = this.sources.map((s) => s.id)
      const enabledIds = new Set(this.sources.filter((s) => s.enabled).map((s) => s.id))
      const out = { ok: 0, fail: 0, dead: [] as string[] }
      const deadIds: string[] = []
      for (let i = 0; i < ids.length; i += PROBE_BATCH) {
        const r = (await this.rpc(RpcMethod.CatalogSourceProbeAll, {
          ids: ids.slice(i, i + PROBE_BATCH)
        })) as {
          ok: number
          fail: number
          results: Array<{ id: string; name: string; ok: boolean; error?: string | null }>
        }
        out.ok += r.ok
        out.fail += r.fail
        for (const x of r.results.filter((y) => !y.ok)) {
          out.dead.push(x.name)
          if (enabledIds.has(x.id)) deadIds.push(x.id)
        }
      }
      this.deadIds = deadIds
      this.deadNames = [...out.dead]
      await this.refreshSources()
      return out
    },

    /** P15 一键停用失效站（吸收 GYING 域名容灾原则：失效站留着只会拖慢聚合搜索）。
     *  只停用不删除，便于后续复查恢复。返回停用数量。 */
    async disableDeadSources(): Promise<number> {
      if (!this.deadIds.length) return 0
      this.disablingDead = true
      let n = 0
      try {
        for (const id of this.deadIds) {
          try {
            await this.updateSource(id, { enabled: false })
            n++
          } catch {
            /* 单个失败不阻断其余 */
          }
        }
        this.deadIds = []
        await this.refreshSources()
        return n
      } finally {
        this.disablingDead = false
      }
    },

    /** 忽略本次巡检结果（不停用） */
    dismissDead() {
      this.deadIds = []
      this.deadNames = []
    },

    // ---------- 搜索 / 详情 ----------

    async search(q?: string) {
      const kw = (q ?? this.query).trim()
      if (!kw) return
      this.searching = true
      this.lastQuery = kw
      try {
        const r = (await this.rpc(RpcMethod.CatalogSearch, { q: kw })) as {
          cards: CatalogCard[]
          failures: string[]
          cache?: CacheSummary
        }
        this.cards = r.cards
        this.searchFailures = r.failures
        this.searchCache = r.cache ?? null
      } finally {
        this.searching = false
      }
    },

    /**
     * 拉单站详情（弹层；sourceId 用于回显站名；配置了 TMDB Key 时附带评分）。
     * soft=true（换源）：不整体重载——已有详情保持展示，只刷新片源/剧集区。
     */
    async loadDetail(api: string, vodId: string, sourceId?: string, soft = false) {
      if (soft) {
        this.detailSwitching = true
      } else {
        this.detailLoading = true
      }
      this.detailError = ''
      try {
        const r = (await this.rpc(RpcMethod.CatalogDetail, { api, vodId, sourceId })) as {
          detail: CatalogDetail
        }
        this.detail = r.detail
        // P11 TMDB 评分增强：拿到详情后异步补评分（不阻塞弹层）
        if (r.detail.name) {
          void this.lookupTmdb(r.detail.name, r.detail.year).then((info) => {
            if (info && this.detail && this.detail.name === r.detail.name) {
              this.detail = { ...this.detail, tmdb: info }
            }
          })
        }
      } catch (e) {
        this.detailError = (e as Error).message
      } finally {
        this.detailLoading = false
        this.detailSwitching = false
      }
    },

    /**
     * 打开聚合卡片详情：记住卡片（用于换源 chips），默认拉第一个站。
     * 对照 LibreTV「跨源同名聚合：展开即可比较和选择各来源」。
     */
    async openCardDetail(card: CatalogCard) {
      // Vue reactive Proxy 过不了 IPC，先深拷贝
      this.detailCard = JSON.parse(JSON.stringify(card)) as CatalogCard
      const e = this.detailCard?.entries?.[0]
      if (!e) return
      await this.loadDetail(e.api, e.vodId, e.sourceId)
    },

    /** 换源：同一部片切到另一站的详情（软加载，剧集/清晰度随之变化） */
    async switchDetailSource(entry: { api: string; vodId: string; sourceId?: string }) {
      if (!entry?.api || !entry.vodId) return
      await this.loadDetail(entry.api, entry.vodId, entry.sourceId, true)
    },

    closeDetail() {
      this.detail = null
      this.detailError = ''
      this.detailCard = null
      this.detailSwitching = false
    },

    // ---------- 播放 ----------

    /**
     * 静默拉详情（不写 detail / 不弹层）：点卡片直接起播、播放页换源都要用。
     * 走 catalog.detail RPC，P19 已给该接口做 30min 缓存，重复点击不会再打源站。
     */
    async fetchDetail(api: string, vodId: string, sourceId?: string): Promise<CatalogDetail> {
      const r = (await this.rpc(RpcMethod.CatalogDetail, { api, vodId, sourceId })) as {
        detail: CatalogDetail
      }
      if (!r?.detail) throw new Error('详情为空')
      return r.detail
    },

    /**
     * P22 点卡片直接起播：按聚合条目顺序试站，第一个能拉到剧集的就用它起播并跳播放页。
     * 失败自动顺延到下一个站（源站单点故障不该让用户点了没反应）。
     */
    async playCard(card: CatalogCard, uiKey?: string): Promise<void> {
      if (this.boot) return
      const sources: PlaySourceRef[] = (card.entries ?? []).map((e) => ({
        siteName: e.siteName,
        api: e.api,
        vodId: e.vodId,
        sourceId: e.sourceId
      }))
      if (!sources.length) throw new Error('该片没有可用片源')
      // 起播最多试 4 个站（够覆盖绝大多数失效场景，又不至于把等待时间拖太长）；
      // 侧栏下拉里保留全部站，用户可以自己换。
      const attempts = Math.min(sources.length, 4)
      const seq = ++this.bootSeq
      const reasons: string[] = []
      const deadline = Date.now() + BOOT_BUDGET_MS
      this.playingKey = card.key
      this.boot = {
        // key 用于界面回链到「哪张卡片在起播」：调用方传视图自己的 key
        // （首页 HomeCard.key 是 `r-` 前缀，和聚合 key 不同，用 card.key 会永远对不上）
        key: uiKey || card.key,
        title: card.name,
        phase: 'detail',
        attempt: 1,
        attempts,
        startedAt: Date.now()
      }
      try {
        for (let i = 0; i < attempts; i++) {
          if (seq !== this.bootSeq) throw new BootCancelled()
          const left = deadline - Date.now()
          if (left < 2_000) {
            reasons.push(`总等待超过 ${Math.round(BOOT_BUDGET_MS / 1000)}s，已放弃剩余 ${attempts - i} 个片源`)
            break
          }
          const s = sources[i]
          this.patchBoot({ phase: 'detail', attempt: i + 1 })
          try {
            const d = await withTimeout(
              this.fetchDetail(s.api, s.vodId, s.sourceId),
              Math.min(BOOT_DETAIL_MS, left),
              `${s.siteName}：详情`
            )
            const groups = d.groups.filter((g) => g.episodes.length)
            if (!groups.length) {
              reasons.push(`${s.siteName}：没有可播放剧集`)
              continue
            }
            const ctx = this.contextFromDetail(d, 0, sources)
            ctx.sourceIndex = i
            this.patchBoot({ phase: 'task' })
            // 起播本身也有硬上限：task.create 卡住时页面不能一直挂「正在起播」
            await withTimeout(
              this.playFromQueue(groups[0].episodes, 0, d.name || card.name, '', ctx),
              Math.min(BOOT_TASK_MS, Math.max(2_000, deadline - Date.now())),
              '创建播放任务'
            )
            this.patchBoot({ phase: 'start' })
            return
          } catch (e) {
            if (e instanceof BootCancelled) throw e
            // 超时/失败后让在飞的那次 playEpisode 作废：
            // 否则十几秒后任务创建完成，页面会「先报错、再突然跳进播放页」。
            this.playSeq += 1
            reasons.push(`${s.siteName}：${(e as Error).message}`)
          }
        }
        throw new Error(
          reasons.length ? `起播失败（试了 ${reasons.length} 个片源）：${reasons[0]}` : '所有片源都不可用'
        )
      } finally {
        // 期间用户又点了别的片（bootSeq 已变）：新的一次起播自己管状态，别在这里清
        if (seq === this.bootSeq) {
          this.boot = null
          this.playingKey = ''
        }
      }
    },

    /** 起播阶段推进（只改自己那一份状态，避免覆盖新一次起播） */
    patchBoot(patch: Partial<BootState>): void {
      if (this.boot) this.boot = { ...this.boot, ...patch }
    },

    /** 用户主动取消：后续片源不再尝试，正在飞的那次请求结果丢弃 */
    cancelBoot(): void {
      if (!this.boot) return
      this.bootSeq += 1
      // 同时作废在飞的 task.create 结果：取消之后不该再偷偷跳进播放页
      this.playSeq += 1
      this.boot = null
      this.playingKey = ''
    },

    /**
     * P22 播放页跨站换源：拉目标站详情 → 重建线路与队列 → 按集名对齐后续播。
     * 找不到同名集就落到第 1 集（不同站集数常不一致，这是唯一不会"点了没反应"的选择）。
     */
    async switchPlaySource(index: number): Promise<boolean> {
      const ctx = this.playCtx
      const src = ctx?.sources[index]
      if (!ctx || !src) return false
      if (index === ctx.sourceIndex) return false
      const curName = this.queue[this.queueIndex]?.name
      const d = await this.fetchDetail(src.api, src.vodId, src.sourceId)
      const next = this.contextFromDetail(d, 0, ctx.sources)
      const groups = (next.groups ?? []).filter((g) => g.episodes.length)
      if (!groups.length) throw new Error(`${src.siteName} 没有可播放剧集`)
      // 优先落在「含同集名」的线路，避免换源后线路也跳走
      const hitGi = groups.findIndex((g) => g.episodes.some((e) => e.name === curName))
      const gi = hitGi >= 0 ? hitGi : 0
      const g = groups[gi]
      const idx = curName ? g.episodes.findIndex((e) => e.name === curName) : -1
      this.playCtx = {
        ...ctx,
        ...next,
        groups,
        groupIndex: gi,
        sources: ctx.sources,
        sourceIndex: index,
        title: d.name || ctx.title,
        siteName: src.siteName || d.siteName,
        startedAt: Date.now()
      }
      this.queueTitle = d.name || this.queueTitle
      this.queue = g.episodes.map((e) => ({ name: e.name, url: e.url }))
      this.queueIndex = -1
      return this.playAt(idx >= 0 ? idx : 0, true)
    },

    /** 选集起播：task.create（在线模式直达）→ playTask 跨页起播 */
    async playEpisode(url: string, title: string) {
      const player = usePlayerStore()
      if (player.mode !== 'electron') throw new Error('浏览器调试模式不支持')
      const seq = ++this.playSeq
      // 内核按 URL 复用任务：这条 URL 已经有任务时，本次拿回的可能就是别人的任务，
      // 过期分支绝不能删它（曾经把用户正在播的那条删掉，表现为「点了变黑」）。
      const reused = player.tasks.some((x) => x.url === url)
      let r: { task?: { id?: string } }
      try {
        r = (await withTimeout(
          this.rpc(RpcMethod.TaskCreate, {
            url,
            title,
            cacheMode: player.newTaskCacheMode
          }),
          BOOT_TASK_MS + 6_000,
          '创建播放任务'
        )) as { task?: { id?: string } }
      } catch (e) {
        throw new Error(`创建播放任务失败：${(e as Error).message}`)
      }
      // 等待期间用户又点了别的片：本次结果作废。
      // 只有「本次新建」的任务才顺手删掉（否则后台会堆积没人看的下载任务）；
      // 复用的任务属于既有播放，不能动。
      if (seq !== this.playSeq) {
        const staleId = r?.task?.id
        if (staleId && !reused) void this.rpc(RpcMethod.TaskDelete, { taskId: staleId }).catch(() => {})
        return
      }
      await player.refreshTasks()
      const t = player.tasks.find((x) => x.url === url) ?? player.tasks.find((x) => x.id === r?.task?.id)
      if (!t) throw new Error('任务创建失败')
      player.playTask(t)
      // P46：起播成功 → 把整组剧集同步给内核，窗口预缓存立刻开跑（失败不影响播放）
      void this.syncSeriesPrefetch(String(t.id))
    },

    /**
     * P46 剧集预缓存：起播/换集成功后把整组剧集与当前集序同步给内核。
     *
     * 触发时机：只在这里（playEpisode 成功之后）调用 —— 用户真正开始看了才预取，
     * 首页悬停/详情页浏览都不算。换集、换线路会再调一次（集序与 URL 一起刷新）。
     */
    async syncSeriesPrefetch(taskId: string): Promise<void> {
      if (!taskId || this.queue.length < 2) {
        this.prefetch = null
        return
      }
      const ctx = this.playCtx
      const src = ctx?.sources?.[ctx?.sourceIndex ?? 0]
      // 剧集身份：同一部片在不同站是不同任务，必须带片源维度
      const sid = src ? `${src.sourceId || src.api}:${src.vodId}` : ''
      if (!sid || sid.endsWith(':') || !src?.vodId) {
        this.prefetch = null
        return
      }
      try {
        const st = (await this.rpc(RpcMethod.SeriesAttach, {
          seriesId: sid,
          title: ctx?.title || this.queueTitle,
          taskId,
          index: this.queueIndex,
          episodes: this.queue.map((e, i) => ({ index: i, name: e.name, url: e.url }))
        })) as SeriesPrefetchStatus
        // 期间用户可能又换了集：只认最后那次的窗口
        if (this.queueIndex >= 0) this.prefetch = st
      } catch {
        // 预缓存是增强能力，失败不打扰用户（P36：fire-and-forget 失败无声）
        this.prefetch = null
      }
    },

    /** P46 侧栏 5s 刷新窗口进度（只读，不触发调度） */
    async refreshPrefetchStatus(taskId: string): Promise<void> {
      if (!taskId || !this.prefetch) return
      try {
        this.prefetch = (await this.rpc(RpcMethod.SeriesPrefetchStatus, {
          taskId
        })) as SeriesPrefetchStatus
      } catch {
        /* 内核忙/未挂接时忽略 */
      }
    },

    // ---------- 收藏 ----------

    async refreshFavorites() {
      const r = (await this.rpc(RpcMethod.CatalogFavoriteList)) as { favorites: Favorite[] }
      this.favorites = r.favorites
    },

    /** 收藏：传搜索卡片（自动聚合 ≤3 站详情）或单站详情 */
    async addFavorite(payload: { card?: CatalogCard; detail?: CatalogDetail }) {
      // Vue reactive Proxy 不能过 Electron 结构化克隆，先深拷贝为普通对象
      const plain = JSON.parse(JSON.stringify(payload)) as { card?: CatalogCard; detail?: CatalogDetail }
      const r = (await this.rpc(RpcMethod.CatalogFavoriteAdd, plain)) as { favorite: Favorite }
      await this.refreshFavorites()
      return r.favorite
    },

    async removeFavorite(id: string) {
      await this.rpc(RpcMethod.CatalogFavoriteRemove, { id })
      this.favorites = this.favorites.filter((f) => f.id !== id)
      if (this.activeFavoriteId === id) {
        this.activeFavoriteId = ''
        this.favoriteSources = []
      }
    },

    /**
     * P35 批量取消收藏（媒体库多选 / 规则清理）。
     *
     * 一次 RPC 删一批，本地只做一次过滤，避免逐条删时列表反复重排、
     * 勾选的卡片在动画中途换位。
     */
    async removeFavorites(ids: string[]): Promise<{ removed: number; failed: unknown[] }> {
      const list = ids.filter(Boolean)
      if (!list.length) return { removed: 0, failed: [] }
      const r = (await this.rpc(RpcMethod.CatalogFavoriteRemoveMany, { ids: list })) as {
        removed: number
        failed: { id: string; error: string }[]
      }
      const gone = new Set(list)
      this.favorites = this.favorites.filter((f) => !gone.has(f.id))
      if (this.activeFavoriteId && gone.has(this.activeFavoriteId)) {
        this.activeFavoriteId = ''
        this.favoriteSources = []
      }
      // 只清被删那几条的片源快照。
      // 不能调 invalidateFavoriteSources() 清空整张表 —— 媒体库的「按视频聚合」
      // 与封面都靠这份快照，一次取消收藏会让整个下载墙退回「一任务一卡」。
      const nextSources = { ...this.sourcesByFav }
      for (const fid of gone) delete nextSources[fid]
      this.sourcesByFav = nextSources
      const nextUpdates = { ...this.favUpdates }
      for (const fid of gone) delete nextUpdates[fid]
      this.favUpdates = nextUpdates
      return { removed: r.removed ?? list.length, failed: r.failed ?? [] }
    },

    /** 打开收藏片源弹层 */
    async openFavorite(id: string) {
      this.activeFavoriteId = id
      this.manualUrls = ''
      // 追更徽章已阅
      if (this.favUpdates[id]) {
        const rest = { ...this.favUpdates }
        delete rest[id]
        this.favUpdates = rest
      }
      await this.loadFavoriteSources(id)
    },

    async loadFavoriteSources(id: string) {
      this.sourcesLoadingFor = id
      try {
        const r = (await this.rpc(RpcMethod.CatalogFavoriteSources, { id })) as {
          sources: FavoriteSource[]
        }
        this.favoriteSources = r.sources
      } finally {
        this.sourcesLoadingFor = ''
      }
    },

    /**
     * P33 批量拉全部收藏的片源（媒体库按视频聚合用）。
     *
     * 聚合要靠「任务 URL 命中收藏剧集」来确认归属，单靠标题猜是不可靠的（P32 教训）。
     * 这些都是本地 SQLite 查询，但收藏上百时仍不宜一次性并发打爆 IPC，
     * 所以按 4 路分批；失败单个收藏只跳过它，不拖垮整轮。
     *
     * 结果缓存到 `sourcesByFav`，`force` 时重拉（收藏增删/追更后）。
     */
    async loadAllFavoriteSources(force = false): Promise<void> {
      const ids = this.favorites.map((f) => f.id)
      const missing = force ? ids : ids.filter((id) => !(id in this.sourcesByFav))
      if (!missing.length) return
      this.sourcesLoadingAll = true
      const BATCH = 4
      try {
        for (let i = 0; i < missing.length; i += BATCH) {
          const chunk = missing.slice(i, i + BATCH)
          const rows = await Promise.all(
            chunk.map(async (id) => {
              try {
                const r = (await this.rpc(RpcMethod.CatalogFavoriteSources, { id })) as {
                  sources: FavoriteSource[]
                }
                return [id, r.sources ?? []] as const
              } catch {
                // 单个收藏拉失败（已被删除/内核忙）就当没有片源，下一轮还会补
                return null
              }
            })
          )
          const next = { ...this.sourcesByFav }
          for (const row of rows) if (row) next[row[0]] = row[1]
          this.sourcesByFav = next
        }
      } finally {
        this.sourcesLoadingAll = false
      }
    },

    /** 收藏变更后让片源缓存失效（增删片源/删除收藏/追更都会影响聚合结果） */
    invalidateFavoriteSources(id?: string): void {
      if (!id) {
        this.sourcesByFav = {}
        return
      }
      if (id in this.sourcesByFav) {
        const next = { ...this.sourcesByFav }
        delete next[id]
        this.sourcesByFav = next
      }
    },

    /** 手动补充片源（名称$URL#名称$URL 或每行一个链接） */
    async addManualSource(favoriteId: string, urls: string, label?: string) {
      if (!urls.trim()) throw new Error('请粘贴片源链接')
      await this.rpc(RpcMethod.CatalogFavoriteSourceAdd, { favoriteId, urls, label })
      this.manualUrls = ''
      await Promise.all([this.loadFavoriteSources(favoriteId), this.refreshFavorites()])
    },

    async removeFavoriteSource(sourceId: string, favoriteId: string) {
      await this.rpc(RpcMethod.CatalogFavoriteSourceRemove, { sourceId })
      await Promise.all([this.loadFavoriteSources(favoriteId), this.refreshFavorites()])
    },

    /**
     * 收藏内选集起播：整组入队连播 + 进度上下文 + 最近播放记账。
     * 单集（不知整组时）也走队列（长度 1），保证播放页侧栏与连播语义一致。
     */
    async playFavoriteEpisode(
      ep: { name: string; url: string },
      title: string,
      episodes?: CatalogEpisode[],
      ctx?: Partial<PlayContext>
    ) {
      const favId = this.activeFavoriteId || ctx?.favoriteId || ''
      const base = favId ? this.favoriteContext(favId, ctx?.siteName ?? '', ctx?.groups ?? []) : {}
      const merged: Partial<PlayContext> = { ...base, ...ctx, favoriteId: favId }
      // P22 收藏里通常有多个片源（每站一条）：全部带进播放页，侧栏可跨源换
      if (!merged.sources?.length) {
        const auto = this.favoriteSources
          .filter((x) => x.api && x.vodId)
          .map((x) => ({ siteName: x.siteName, api: x.api as string, vodId: x.vodId as string }))
        if (auto.length) {
          merged.sources = auto
          const si = auto.findIndex((x) => sameApi(x.api, merged.api) && x.vodId === merged.vodId)
          merged.sourceIndex = si >= 0 ? si : 0
        }
      }
      const list = episodes?.length ? episodes : [{ name: ep.name, url: ep.url }]
      const idx = list.findIndex((e) => e.url === ep.url)
      await this.playFromQueue(
        list,
        Math.max(0, idx),
        title || merged.title || ep.name,
        favId,
        merged
      )
    }
  }
})

/** api 比较：内核会 normalize（去尾斜杠/小写），前端比对必须同样宽松 */
function sameApi(a?: string, b?: string): boolean {
  if (!a || !b) return false
  const n = (s: string) => s.trim().toLowerCase().replace(/\/+$/, '')
  return n(a) === n(b)
}

/** 按批切分文本行（避免单次 RPC 提交过多源站导致超时） */
function chunkLines(lines: string[], size: number): string[] {
  const out: string[] = []
  for (let i = 0; i < lines.length; i += size) out.push(lines.slice(i, i + size).join('\n'))
  return out
}
