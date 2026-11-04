/**
 * P26 历史播放记录（Pinia）
 *
 * 数据落内核 `play_history` 表：按「片」去重，一条记录同时承担
 * 「最近播放」与「进度」两件事。
 * - 起播/换集：`record()`（PlayerView 监听当前任务变化时调用）
 * - 进度：`updateProgress()`（与收藏进度同一 5s 节流）
 * - 续播：`resume()`，用记录里的剧集快照重建队列，不重新回源
 */
import { defineStore } from 'pinia'
import { RpcMethod, type CatalogEpisodeGroup, type PlayHistoryItem } from '@polyframe/shared'
import { usePlayerStore } from './player'
import { useCatalogStore } from './catalog'

/** 单页条数（列表「加载更多」按此翻页） */
const PAGE = 60

/** 正在进行的补写（模块级：不放进 state，避免被当成响应式数据） */
let draining = false

/** 打点载荷规整：Proxy → 纯对象、空串 → undefined（内核按缺失处理） */
function normalizePayload(p: HistoryRecordPayload): HistoryRecordPayload {
  return {
    title: p.title.trim() || '未命名',
    episodeName: p.episodeName ?? '',
    episodeUrl: p.episodeUrl,
    siteName: p.siteName || undefined,
    api: p.api || undefined,
    vodId: p.vodId || undefined,
    poster: p.poster || undefined,
    // 剧集快照可能是几万字符，只在真有内容时带
    groups: p.groups?.length ? (JSON.parse(JSON.stringify(p.groups)) as CatalogEpisodeGroup[]) : undefined,
    groupIndex: p.groupIndex ?? 0
  }
}

/** 起播时能拿到的全部元数据（缺省字段由内核按片去重时补齐/保留） */
export interface HistoryRecordPayload {
  title: string
  episodeName?: string
  episodeUrl: string
  siteName?: string
  api?: string
  vodId?: string
  poster?: string
  groups?: CatalogEpisodeGroup[]
  groupIndex?: number
}

/** 已看完：剩不到 10 秒（片尾字幕），或进度 ≥99% */
export function historyDone(it: PlayHistoryItem): boolean {
  if (!it.durationSec || it.durationSec <= 0) return false
  return it.positionSec >= it.durationSec - 10
}

/** 进度百分比（看完的记 100%，其余封顶 99%：不再显示成「还差一点」） */
export function historyPct(it: PlayHistoryItem): number {
  if (!it.durationSec || it.durationSec <= 0) return 0
  if (historyDone(it)) return 100
  return Math.min(99, Math.max(0, Math.round((it.positionSec / it.durationSec) * 100)))
}

/** 剧集快照解析：坏 JSON 就当没有（续播退化成单集，不影响可用性） */
export function parseHistoryGroups(raw: string): CatalogEpisodeGroup[] {
  try {
    const arr = JSON.parse(raw || '[]') as unknown
    if (!Array.isArray(arr)) return []
    return arr.filter(
      (g): g is CatalogEpisodeGroup =>
        !!g && Array.isArray((g as CatalogEpisodeGroup).episodes) && (g as CatalogEpisodeGroup).episodes.length > 0
    )
  } catch {
    return []
  }
}

export const useHistoryStore = defineStore('history', {
  state: () => ({
    items: [] as PlayHistoryItem[],
    total: 0,
    loading: false,
    error: '',
    /** 最近一次 record 落下的 key（进度上报靠它定位行） */
    activeKey: '',
    /**
     * 待写队列：record 失败（内核重启/忙/参数被拒）时先存本地，
     * 下次打点或内核恢复上线时按顺序重放 —— 起播打点不能「一次失败就永久丢」。
     * 用队列而不是单个槽位：连播时两次失败不应该互相覆盖（那是两部不同的片）。
     */
    pendingQueue: [] as HistoryRecordPayload[],
    /** 最近一次进度（activeKey 还没落地时暂存，落地后立刻补写） */
    pendingProgress: null as null | { position: number; duration: number },
    /** 打点序号：连点换片时只认最后一次的结果 */
    recordSeq: 0
  }),

  getters: {
    hasMore: (s) => s.items.length < s.total
  },

  actions: {
    rpc(method: string, params?: unknown): Promise<unknown> {
      return usePlayerStore().rpc(method, params)
    },

    /**
     * 起播打点入口：写一条，失败进队列；成功后顺手把积压的补写掉。
     *
     * 三个必须做的事：
     * 1) `groups` 深拷贝成纯对象 —— 它来自 Pinia state（reactive Proxy），
     *    Electron IPC 结构化克隆会抛 `An object could not be cloned`，
     *    而这个调用是 fire-and-forget，失败完全无声（历史页永远是空的）。
     * 2) 序号护栏 —— 连点换片时只认最后一次，避免旧响应把新记录顶掉。
     * 3) 失败留痕 —— 进队列等重放，别指望下一次起播能「顺便」补上一条不同的片。
     */
    async record(p: HistoryRecordPayload): Promise<void> {
      if (!p.title || !p.episodeUrl) return
      const payload = normalizePayload(p)
      const ok = await this.writeOnce(payload, false)
      if (!ok) this.enqueue(payload)
      else void this.drainQueue()
    },

    /** 真正写一次；失败返回 false（调用方决定是否入队），成功返回 true */
    async writeOnce(payload: HistoryRecordPayload, replay: boolean): Promise<boolean> {
      const seq = ++this.recordSeq
      // 换片/换集后进度必须写到新行上；在打点落地前先把旧 key 摘掉，
      // 期间来的进度会进 pendingProgress，落地后由 writeOnce 补写。
      if (!replay) this.activeKey = ''
      try {
        const r = (await this.rpc(RpcMethod.CatalogHistoryRecord, payload)) as { item?: PlayHistoryItem }
        const item = r?.item
        if (!item?.key) throw new Error('内核未返回历史记录')
        // 期间又起播了别的片：这次结果作废（行已经写进去了，不影响正确性）
        if (!replay && seq !== this.recordSeq) return true
        this.error = ''
        // 「当前进度归属」只给真正在播的那条：补写的旧记录不能抢走 activeKey，
        // 但补写的若正好是当前这条（离线期间播的），就要接上，否则进度白记。
        const isCurrent = !replay || payload.episodeUrl === usePlayerStore().lastPlay?.url
        if (isCurrent) {
          this.activeKey = item.key
          if (this.pendingProgress) {
            const { position, duration } = this.pendingProgress
            this.pendingProgress = null
            void this.updateProgress(position, duration)
          }
        }
        // 列表：当前这条插到最前；补写的旧记录原位替换（找不到才插最前）
        const i = this.items.findIndex((x) => x.key === item.key)
        if (i >= 0) this.items.splice(i, 1)
        if (isCurrent || i < 0) {
          this.items.unshift(item)
          if (i < 0) this.total += 1
        } else {
          this.items.splice(i, 0, item)
        }
        return true
      } catch (e) {
        this.error = (e as Error).message
        return false
      }
    },

    /** 入队（同片同集只留最新一条，上限 10 条，防止长时间离线撑爆内存） */
    enqueue(payload: HistoryRecordPayload): void {
      const i = this.pendingQueue.findIndex(
        (x) => x.episodeUrl === payload.episodeUrl && (x.episodeName ?? '') === (payload.episodeName ?? '')
      )
      if (i >= 0) this.pendingQueue.splice(i, 1)
      this.pendingQueue.push(payload)
      if (this.pendingQueue.length > 10) this.pendingQueue.splice(0, this.pendingQueue.length - 10)
    },

    /** 重放积压（内核恢复上线 / 下次起播后调用；串行、失败了就停下等下次） */
    async flushPending(): Promise<void> {
      await this.drainQueue()
    },

    async drainQueue(): Promise<void> {
      if (draining) return
      if (!this.pendingQueue.length) return
      draining = true
      try {
        // 用 while + 队首而不是 forEach：中途失败要立刻停，留着下次再试
        while (this.pendingQueue.length) {
          const next = this.pendingQueue[0]
          const ok = await this.writeOnce(next, true)
          if (!ok) break
          this.pendingQueue.shift()
        }
      } finally {
        draining = false
      }
    },

    /**
     * 进度上报：只刷已存在的那一条（用户删掉后就静默失效）。
     * activeKey 尚未落地时先缓存 —— 否则「点开就关」的播放进度会整段丢掉。
     */
    async updateProgress(position: number, duration: number): Promise<void> {
      if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return
      const pos = Math.floor(position)
      const dur = Math.floor(duration)
      if (!this.activeKey) {
        this.pendingProgress = { position: pos, duration: dur }
        if (this.pendingQueue.length) void this.drainQueue()
        return
      }
      try {
        const r = (await this.rpc(RpcMethod.CatalogHistoryProgress, {
          key: this.activeKey,
          position: pos,
          duration: dur
        })) as { saved?: boolean }
        if (r?.saved === false) {
          // 行已被删除：别再往这个 key 上写，等下一次起播重新打点
          this.activeKey = ''
          this.pendingProgress = null
          return
        }
        this.pendingProgress = null
        const it = this.items.find((x) => x.key === this.activeKey)
        if (it) {
          it.positionSec = pos
          it.durationSec = dur
          it.playedAt = Date.now()
        }
      } catch {
        // 进度写失败不该影响播放，留到下次（activeKey 还在，下一拍会再写）
        this.pendingProgress = { position: pos, duration: dur }
      }
    },

    async refresh(): Promise<void> {
      this.loading = true
      this.error = ''
      try {
        const r = (await this.rpc(RpcMethod.CatalogHistoryList, { limit: PAGE, offset: 0 })) as {
          items: PlayHistoryItem[]
          total: number
        }
        this.items = r.items
        this.total = r.total
      } catch (e) {
        this.error = (e as Error).message
      } finally {
        this.loading = false
      }
    },

    async loadMore(): Promise<void> {
      if (this.loading || this.items.length >= this.total) return
      this.loading = true
      try {
        const r = (await this.rpc(RpcMethod.CatalogHistoryList, {
          limit: PAGE,
          offset: this.items.length
        })) as { items: PlayHistoryItem[]; total: number }
        // 分页期间可能有新纪录插到第一页，按 key 去重再拼
        const seen = new Set(this.items.map((x) => x.key))
        this.items = [...this.items, ...r.items.filter((x) => !seen.has(x.key))]
        this.total = r.total
      } catch (e) {
        this.error = (e as Error).message
      } finally {
        this.loading = false
      }
    },

    async remove(key: string): Promise<void> {
      try {
        await this.rpc(RpcMethod.CatalogHistoryDelete, { key })
      } catch (e) {
        this.error = (e as Error).message
        return
      }
      const before = this.items.length
      this.items = this.items.filter((x) => x.key !== key)
      if (this.items.length < before) this.total = Math.max(0, this.total - 1)
      if (this.activeKey === key) this.activeKey = ''
    },

    async clearAll(): Promise<void> {
      try {
        await this.rpc(RpcMethod.CatalogHistoryClear)
      } catch (e) {
        this.error = (e as Error).message
        return
      }
      this.items = []
      this.total = 0
      this.activeKey = ''
    },

    /**
     * 续播：优先用记录里的剧集快照原地重建队列（不重新回源），
     * 没有快照（直链/网盘/磁力）就按记录的 URL 重新起播。
     */
    async resume(item: PlayHistoryItem): Promise<void> {
      const catalog = useCatalogStore()
      const groups = parseHistoryGroups(item.groups)
      // 续播定位：看过 >15s 且距片尾 >30s 才跳，否则从头（与「继续观看」同口径）
      const nearEnd = item.durationSec > 0 && item.positionSec > item.durationSec - 30
      catalog.pendingSeek = item.positionSec > 15 && !nearEnd ? item.positionSec : 0

      if (groups.length) {
        const gi = Math.max(0, Math.min(item.groupIndex, groups.length - 1))
        const eps = groups[gi].episodes
        const idx = Math.max(0, eps.findIndex((e) => e.name === item.episodeName))
        await catalog.playFromQueue(eps, idx, item.title, '', {
          title: item.title,
          poster: item.poster,
          siteName: item.siteName ?? '历史记录',
          api: item.api,
          vodId: item.vodId,
          groups,
          groupIndex: gi
        })
        return
      }
      catalog.setLooseContext(item.title, item.siteName || '历史记录')
      await catalog.playEpisode(item.episodeUrl, item.title)
    }
  }
})
