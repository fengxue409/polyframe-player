/**
 * 弹幕状态（Pinia）
 *
 * ## 为什么 items 不放进 state
 *
 * 一集弹幕动辄 3000~8000 条，放进 Pinia state 会被深度 reactive 代理 ——
 * 每条都要建 Proxy、每次读取都走 trap，仅初始化就要几十毫秒，
 * 后续渲染每帧读 `time`/`text` 还会持续踩代理。所以：
 *  - 原始数组放在模块级（`rawItems`），零代理；
 *  - state 里只放 `itemsVersion`（变更计数）+ `itemCount`（展示用）；
 *  - 组件 `watch(() => store.itemsVersion)` 后通过 `getItems()` 拿裸数组。
 *
 * ## 发送为什么不用 itemsVersion
 *
 * 本地发送如果 bump version，渲染层会走 `setItems` → 整体重建（softReset），
 * 屏幕瞬间清空再补回来，视觉上闪一下。所以发送走 `appendLocal`（只插数组）
 * + 渲染层 `push()`（即时上屏）两条独立路径。
 */

import { defineStore } from 'pinia'
import {
  RpcMethod,
  type DanmakuChannel,
  type DanmakuEpisodeCandidate,
  type DanmakuItem,
  type DanmakuSettings
} from '@polyframe/shared'
import { usePlayerStore } from './player'

export const DEFAULT_DANMAKU_SETTINGS: DanmakuSettings = {
  enabled: true,
  opacity: 0.9,
  fontScale: 1,
  speed: 1,
  density: 1,
  blockScroll: false,
  blockTop: false,
  blockBottom: false,
  provider: 'dandanplay',
  autoScale: true,
  showSendBar: true,
  blockedWords: [],
  fxOverlay: false
}

const LS_KEY = 'pf.danmaku.settings'

/** 模块级：裸数组，不进响应式系统 */
let rawItems: DanmakuItem[] = []

function readLocalSettings(): DanmakuSettings {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return { ...DEFAULT_DANMAKU_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<DanmakuSettings>
    return { ...DEFAULT_DANMAKU_SETTINGS, ...parsed }
  } catch {
    return { ...DEFAULT_DANMAKU_SETTINGS }
  }
}

export interface DanmakuFetchMeta {
  /** 弹幕源片长估计（秒） */
  channelDuration: number | null
  cached: boolean
  added: number
}

export const useDanmakuStore = defineStore('danmaku', {
  state: () => ({
    settings: readLocalSettings(),
    hasCredentials: false,
    appIdMasked: '' as string,

    /** 当前频道（一部剧的一集 × 一个弹幕源） */
    channelId: '',
    provider: 'dandanplay' as string,
    title: '',
    episode: '',

    /** 变更计数（watch 它来触发渲染层重载） */
    itemsVersion: 0,
    /** 条数（展示用；真实数据在 rawItems） */
    itemCount: 0,
    /** 弹幕源片长（秒），与播放器片长不同时渲染层做线性缩放 */
    channelDuration: null as number | null,

    loading: false,
    /** 人类可读错误（展示在弹幕层角标） */
    error: '',
    /** 机器可读错误类型：no_credentials / no_match / auth / network / timeout / parse / quota */
    errorKind: '',
    matched: null as {
      episodeId?: string
      animeTitle?: string
      episodeTitle?: string
      candidates?: number
    } | null,

    /** 最近一次发送的反馈文案（成功/失败都写，UI 淡出） */
    sendFeedback: '' as string,
    /** 可选的匹配候选（手动换源用） */
    candidates: [] as DanmakuEpisodeCandidate[],

    /** 历史频道（设置页展示缓存占用） */
    channels: [] as DanmakuChannel[],

    /** ASS 临时文件占用（每集一个；按数量 + 时间双限自动清理） */
    assCache: { files: 0, bytes: 0 }
  }),

  getters: {
    /** 渲染层拿裸数组（零代理） */
    items: (): DanmakuItem[] => rawItems,
    /** 是否应当显示弹幕层 */
    active: (s) => s.settings.enabled && s.itemCount > 0,
    /** 是否已绑定第三方源（决定是否显示「匹配」按钮） */
    isRemote: (s) => s.provider === 'dandanplay'
  },

  actions: {
    getItems(): DanmakuItem[] {
      return rawItems
    },

    async init(): Promise<void> {
      // 先落一份本地设置，避免内核就绪前 UI 用默认值闪一下
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(this.settings))
      } catch {
        /* 隐私模式等场景忽略 */
      }
      const player = usePlayerStore()
      if (!player.online) return
      try {
        const r = (await player.rpc(RpcMethod.DanmakuSettingsGet)) as {
          settings: DanmakuSettings
          hasCredentials: boolean
          appIdMasked: string | null
        }
        this.settings = { ...DEFAULT_DANMAKU_SETTINGS, ...r.settings }
        this.hasCredentials = r.hasCredentials
        this.appIdMasked = r.appIdMasked ?? ''
      } catch (e) {
        // 内核未就绪不算致命：沿用 localStorage 的设置继续可用
        this.error = `读取弹幕设置失败：${(e as Error).message}`
      }
    },

    /** 局部更新设置：本地立即生效 + 落 Rust（失败只记日志，不回滚 UI） */
    async saveSettings(partial: Partial<DanmakuSettings>): Promise<void> {
      const blocklistChanged =
        partial.blockedWords !== undefined &&
        JSON.stringify(partial.blockedWords) !== JSON.stringify(this.settings.blockedWords)
      this.settings = { ...this.settings, ...partial }
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(this.settings))
      } catch {
        /* ignore */
      }
      const player = usePlayerStore()
      if (!player.online) return
      try {
        const r = (await player.rpc(RpcMethod.DanmakuSettingsSet, { settings: partial })) as {
          settings: DanmakuSettings
        }
        // 以后端夹过区间的值为准（例如 opacity 越界会被夹住）
        this.settings = { ...DEFAULT_DANMAKU_SETTINGS, ...r.settings }
        localStorage.setItem(LS_KEY, JSON.stringify(this.settings))
        // P15：屏蔽词变了要重读当前频道（过滤在内核出参侧做）。
        //
        // 这里 **await** 而不是 `void`：屏蔽词是低频操作，等一次读库没有代价，
        // 但能让「条数」与「改完设置」在同一拍内保持一致。用 void 的话 UI 会先
        // 显示旧条数、过一拍再跳变，用户会以为设置没生效。
        if (blocklistChanged && this.channelId) await this.reloadList()
      } catch (e) {
        player.pushLog('warn', `保存弹幕设置失败：${(e as Error).message}`)
      }
    },

    async setCredentials(appId: string, appSecret: string): Promise<{ ok: boolean; message: string }> {
      const player = usePlayerStore()
      try {
        const r = (await player.rpc(RpcMethod.DanmakuCredentialsSet, { appId, appSecret })) as {
          saved: boolean
          appIdMasked: string
        }
        this.appIdMasked = r.appIdMasked
        this.hasCredentials = true
        return { ok: true, message: '凭据已保存' }
      } catch (e) {
        return { ok: false, message: (e as Error).message }
      }
    },

    async testCredentials(): Promise<{ ok: boolean; message: string }> {
      const player = usePlayerStore()
      try {
        const r = (await player.rpc(RpcMethod.DanmakuCredentialsTest)) as {
          ok: boolean
          message: string
          kind?: string
        }
        return { ok: r.ok, message: r.message }
      } catch (e) {
        return { ok: false, message: (e as Error).message }
      }
    },

    async clearCredentials(): Promise<void> {
      const player = usePlayerStore()
      await player.rpc(RpcMethod.DanmakuCredentialsClear).catch(() => {})
      this.hasCredentials = false
      this.appIdMasked = ''
    },

    /**
     * 绑定频道（纯本地，不联网）。
     * 每次起播新一集都要调一次 —— 频道变了，弹幕内容也就全变了。
     */
    async openChannel(title: string, episode?: string): Promise<void> {
      const player = usePlayerStore()
      if (!player.online) return
      const t = title.trim()
      if (!t) return
      if (this.title === t && this.episode === (episode ?? '') && this.channelId) return
      try {
        const r = (await player.rpc(RpcMethod.DanmakuOpen, {
          title: t,
          episode: episode ?? undefined
        })) as {
          channelId: string
          provider: string
          count: number
          channelDuration: number | null
          settings: DanmakuSettings
        }
        this.channelId = r.channelId
        this.provider = r.provider
        this.title = t
        this.episode = episode ?? ''
        this.itemCount = r.count
        this.channelDuration = r.channelDuration ?? null
        this.settings = { ...DEFAULT_DANMAKU_SETTINGS, ...r.settings }
        rawItems = []
        this.itemsVersion++
        this.error = ''
        this.errorKind = ''
        this.matched = null
        this.candidates = []
      } catch (e) {
        this.error = `打开弹幕频道失败：${(e as Error).message}`
        this.errorKind = 'network'
      }
    },

    /**
     * 拉取弹幕（缓存优先）。
     *
     * 失败是**正常返回值**不是异常：后端会降级返回已缓存的弹幕，
     * 前端据此展示角标而不是把播放打断。
     */
    async fetch(duration?: number | null, opts?: { force?: boolean; episodeId?: number }): Promise<void> {
      if (!this.channelId) return
      const player = usePlayerStore()
      if (!player.online) return
      this.loading = true
      this.error = ''
      this.errorKind = ''
      try {
        const r = (await player.rpc(RpcMethod.DanmakuFetch, {
          title: this.title,
          episode: this.episode || undefined,
          duration: duration ?? undefined,
          provider: this.provider,
          episodeId: opts?.episodeId,
          force: opts?.force
        })) as {
          channelId: string
          provider: string
          items: DanmakuItem[]
          count: number
          added: number
          cached: boolean
          channelDuration: number | null
          error: { kind: string; message: string } | null
          matched: {
            episodeId?: string
            animeTitle?: string
            episodeTitle?: string
            candidates?: number
          } | null
        }
        rawItems = r.items ?? []
        this.itemCount = r.count
        this.channelDuration = r.channelDuration ?? null
        this.itemsVersion++
        this.matched = r.matched ?? null
        if (r.error) {
          this.error = r.error.message
          this.errorKind = r.error.kind
        } else {
          this.error = ''
          this.errorKind = ''
          if (r.items.length > 0) {
            player.pushLog(
              'info',
              `弹幕已加载 ${r.count} 条${r.cached ? '（缓存）' : `（新增 ${r.added}）`}`
            )
          }
        }
      } catch (e) {
        this.error = `拉取弹幕失败：${(e as Error).message}`
        this.errorKind = 'network'
        // 保留已有弹幕，不清屏 —— 网络抖动不该打断观看
      } finally {
        this.loading = false
      }
    },

    /**
     * 搜索候选（手动指定弹幕源用）。
     * @param query 用户手输的关键词；不传则按片名归一化搜索
     */
    async searchCandidates(query?: string): Promise<void> {
      const player = usePlayerStore()
      const q = query?.trim() ?? ''
      if (!player.online) return
      if (!this.title && !q) return
      this.error = ''
      this.errorKind = ''
      try {
        const r = (await player.rpc(RpcMethod.DanmakuMatch, {
          title: this.title || q,
          episode: this.episode || undefined,
          query: q || undefined
        })) as {
          ok: boolean
          query?: string
          candidates: DanmakuEpisodeCandidate[]
          message?: string
          kind?: string
        }
        this.candidates = r.candidates ?? []
        if (!r.ok) {
          this.error = r.message ?? '搜索弹幕源失败'
          this.errorKind = r.kind ?? 'match'
        }
      } catch (e) {
        this.error = `搜索弹幕源失败：${(e as Error).message}`
        this.errorKind = 'network'
        this.candidates = []
      }
    },

    /** 手动指定弹幕库剧集后重拉 */
    async switchEpisode(episodeId: number): Promise<void> {
      await this.fetch(undefined, { force: true, episodeId })
      this.candidates = []
    },

    /**
     * P15：本地导入弹幕文件（B 站 XML / 弹弹play JSON）。
     * 导入目标 = 当前播放频道（与在线弹幕并存显示）。
     */
    async importLocal(content: string): Promise<{ ok: boolean; imported: number; message: string }> {
      const player = usePlayerStore()
      if (!player.online) return { ok: false, imported: 0, message: '内核未就绪' }
      if (!this.channelId) return { ok: false, imported: 0, message: '尚未播放剧集，无导入目标' }
      try {
        const r = (await player.rpc(RpcMethod.DanmakuImport, {
          channelId: this.channelId,
          title: this.title || undefined,
          episode: this.episode || undefined,
          content
        })) as {
          ok: boolean
          channelId: string
          format: string
          imported: number
          total: number
          reason?: string
        }
        if (!r.ok) {
          return { ok: false, imported: 0, message: '文件里没有可显示的弹幕（全部被屏蔽词过滤）' }
        }
        await this.reloadList()
        return { ok: true, imported: r.imported, message: `导入成功：${r.imported} 条（${r.format}）` }
      } catch (e) {
        return { ok: false, imported: 0, message: `导入失败：${(e as Error).message}` }
      }
    },

    /** P15：从内核重读当前频道（导入后 / 屏蔽词变更后走这里，不触发在线拉取） */
    async reloadList(): Promise<void> {
      if (!this.channelId) return
      const player = usePlayerStore()
      if (!player.online) return
      try {
        const r = (await player.rpc(RpcMethod.DanmakuList, { channelId: this.channelId })) as {
          items: DanmakuItem[]
          count: number
          channelDuration?: number | null
        }
        rawItems = r.items ?? []
        this.itemCount = r.count
        if (r.channelDuration != null) this.channelDuration = r.channelDuration
        this.itemsVersion++
        this.error = ''
        this.errorKind = ''
      } catch (e) {
        player.pushLog('warn', `重读弹幕失败：${(e as Error).message}`)
      }
    },

    /**
     * 本地发送。
     * @returns 成功时返回入库的弹幕（供渲染层即时上屏）；失败返回 null 并写 feedback
     */
    async send(
      text: string,
      time: number,
      mode: 'scroll' | 'top' | 'bottom' = 'scroll',
      color = '#FFFFFF',
      fx: 'glow' | 'gradient' | null = null
    ): Promise<DanmakuItem | null> {
      const trimmed = text.trim()
      if (!trimmed) {
        this.sendFeedback = '弹幕内容不能为空'
        return null
      }
      if (this.provider === 'off') {
        this.sendFeedback = '弹幕已关闭，无法发送'
        return null
      }
      const player = usePlayerStore()
      if (!player.online) {
        this.sendFeedback = '内核未就绪，无法发送'
        return null
      }
      // 未绑定频道时按当前标题补绑（用户可能在详情页没走 openChannel）
      if (!this.channelId) {
        this.sendFeedback = '尚未绑定剧集，无法发送弹幕'
        return null
      }
      try {
        const r = (await player.rpc(RpcMethod.DanmakuSend, {
          channelId: this.channelId,
          time: Math.max(0, time),
          text: trimmed,
          mode,
          color,
          fx: fx ?? undefined
        })) as
          | { ok: true; item: DanmakuItem; persisted: boolean }
          | { ok: false; kind: string; message: string }
        if (!r.ok) {
          this.sendFeedback = r.message
          return null
        }
        this.appendLocal(r.item)
        this.sendFeedback = r.persisted ? '已发送' : '已发送（重复内容未重复入库）'
        return r.item
      } catch (e) {
        this.sendFeedback = `发送失败：${(e as Error).message}`
        return null
      }
    },

    /**
     * 把本地发送的弹幕并入时间轴（**不 bump itemsVersion**）。
     * bump 会让渲染层走整体重建，屏幕闪一下；这条已经由 `push()` 即时上屏了。
     */
    appendLocal(item: DanmakuItem): void {
      const idx = rawItems.findIndex((x) => x.time > item.time)
      if (idx < 0) rawItems.push(item)
      else rawItems.splice(idx, 0, item)
      this.itemCount = rawItems.length
    },

    /** 换集/停止播放时清空 */
    reset(): void {
      rawItems = []
      this.itemsVersion++
      this.itemCount = 0
      this.channelId = ''
      this.title = ''
      this.episode = ''
      this.channelDuration = null
      this.error = ''
      this.errorKind = ''
      this.matched = null
      this.candidates = []
      this.sendFeedback = ''
    },

    async loadChannels(): Promise<void> {
      const player = usePlayerStore()
      if (!player.online) return
      try {
        const r = (await player.rpc(RpcMethod.DanmakuChannels)) as { channels: DanmakuChannel[] }
        this.channels = r.channels
      } catch {
        this.channels = []
      }
    },

    async removeChannel(id: string): Promise<void> {
      const player = usePlayerStore()
      await player.rpc(RpcMethod.DanmakuChannelRemove, { channelId: id }).catch(() => {})
      if (id === this.channelId) this.reset()
      await this.loadChannels()
    },

    /** 读 ASS 临时文件占用（设置页展示） */
    async loadAssCache(): Promise<void> {
      const player = usePlayerStore()
      if (!player.online) return
      try {
        const r = (await player.rpc(RpcMethod.DanmakuStats, {})) as {
          assCache?: { files: number; bytes: number }
        }
        this.assCache = r.assCache ?? { files: 0, bytes: 0 }
      } catch {
        /* 诊断信息读不到不算错误 */
      }
    },

    /**
     * 清理 ASS 临时文件。`keep = 0` 即全清。
     *
     * 为什么需要手动入口：自动清理按「保留最新 60 个 + 7 天」兜底，但用户可能
     * 想立刻释放空间（或者怀疑 mpv 读到了旧的弹幕字幕）。
     */
    async cleanAssCache(keep = 0): Promise<{ removed: number; message: string }> {
      const player = usePlayerStore()
      if (!player.online) return { removed: 0, message: '内核未就绪' }
      try {
        const r = (await player.rpc(RpcMethod.DanmakuCacheClean, { keep })) as {
          removed: number
          freed: number
          files: number
          bytes: number
        }
        this.assCache = { files: r.files, bytes: r.bytes }
        if (r.removed === 0) return { removed: 0, message: '没有可清理的临时文件' }
        const mb = r.freed / 1024 / 1024
        const size = mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(r.freed / 1024))} KB`
        return { removed: r.removed, message: `已清理 ${r.removed} 个文件，释放 ${size}` }
      } catch (e) {
        return { removed: 0, message: `清理失败：${(e as Error).message}` }
      }
    }
  }
})
