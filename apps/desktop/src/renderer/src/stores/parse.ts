import { defineStore } from 'pinia'
import {
  RpcMethod,
  type ParseProbe,
  type ParseResolveResult,
  type ParseService,
  type ParseServicePreset
} from '@polyframe/shared'
import { useCatalogStore } from './catalog'
import { usePlayerStore } from './player'

/** 最近解析记录（localStorage 持久化，只留 8 条） */
export interface ParseHistoryItem {
  url: string
  /** 接口名或「直连嗅探」 */
  service: string
  /** 最终落地方式 */
  via: 'direct' | 'sniff' | 'page'
  ts: number
}

const HISTORY_KEY = 'pf.parse.history'
const CURRENT_KEY = 'pf.parse.currentId'

/** 去掉 Electron IPC 的包装前缀：`Error invoking remote method 'pf:rpc': Error: xxx` → `xxx` */
function cleanIpcError(msg: string): string {
  return msg
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(Error|TypeError):\s*/, '')
}

/** 解析的三段式阶段（供界面展示进度） */
export type ParseStage = 'idle' | 'resolving' | 'sniffing' | 'embedding' | 'done' | 'error'

export const useParseStore = defineStore('parse', {
  state: () => ({
    services: [] as ParseService[],
    presets: [] as ParseServicePreset[],
    /** 当前选中的接口 id（空 = 直连嗅探） */
    currentId: localStorage.getItem(CURRENT_KEY) ?? '',
    /** 输入的视频页面地址 */
    url: '',
    loading: false,
    stage: 'idle' as ParseStage,
    /** 阶段说明（"正在请求接口…" / "正在嗅探播放页…"） */
    statusText: '',
    /** 最近一次解析结果 */
    result: null as ParseResolveResult | null,
    error: '',
    /** 正在测活的接口 id（'all' = 全量） */
    probing: '',
    /** 内嵌播放地址（kind=page 且允许 iframe 时） */
    embedUrl: '',
    /** 嗅探到的直链（与 result.playUrl 区分：这是主进程抓的） */
    sniffedUrl: '',
    history: [] as ParseHistoryItem[]
  }),

  getters: {
    current: (s) => s.services.find((x) => x.id === s.currentId) ?? null,
    enabled: (s) => s.services.filter((x) => x.enabled),
    directMode: (s) => {
      const c = s.services.find((x) => x.id === s.currentId)
      return !s.currentId || c?.api === 'direct://'
    },
    /** 当前接口的可用状态：null = 未测 */
    currentStatus: (s): boolean | null => {
      const c = s.services.find((x) => x.id === s.currentId)
      if (!c) return null
      if (c.api === 'direct://') return true
      return c.lastOkAt ? true : c.latencyMs === null ? null : false
    }
  },

  actions: {
    async refresh() {
      this.loading = true
      try {
        const r = (await this.rpc(RpcMethod.ParseServiceList)) as {
          services: ParseService[]
          presetsVersion: number
          directApi: string
        }
        this.services = r.services ?? []
        // 选中项失效（被删/被禁用）→ 回落到第一个启用项
        const cur = this.services.find((x) => x.id === this.currentId && x.enabled)
        if (!cur) {
          this.currentId = this.services.find((x) => x.enabled)?.id ?? ''
          this.saveCurrent()
        }
      } finally {
        this.loading = false
      }
    },

    async loadPresets() {
      const r = (await this.rpc(RpcMethod.ParseServicePresets)) as {
        presets: ParseServicePreset[]
        version: number
      }
      this.presets = r.presets ?? []
    },

    async syncPresets(): Promise<number> {
      const r = (await this.rpc(RpcMethod.ParseServiceSyncPresets)) as { added: number }
      await this.refresh()
      return r.added ?? 0
    },

    select(id: string) {
      this.currentId = id
      this.saveCurrent()
    },

    saveCurrent() {
      localStorage.setItem(CURRENT_KEY, this.currentId)
    },

    async add(name: string, api: string): Promise<ParseProbe> {
      const r = (await this.rpc(RpcMethod.ParseServiceAdd, { name, api })) as {
        service: ParseService | null
        probe: ParseProbe
      }
      await this.refresh()
      if (r.service) this.select(r.service.id)
      return r.probe
    },

    async update(id: string, patch: { name?: string; api?: string; enabled?: boolean }) {
      await this.rpc(RpcMethod.ParseServiceUpdate, { id, ...patch })
      await this.refresh()
    },

    async remove(id: string) {
      await this.rpc(RpcMethod.ParseServiceRemove, { id })
      await this.refresh()
    },

    /** 测活单个或全部（返回成功数） */
    async probe(id?: string): Promise<{ ok: number; fail: number }> {
      this.probing = id ?? 'all'
      try {
        const targets = id ? [id] : this.services.filter((x) => x.api !== 'direct://').map((x) => x.id)
        let ok = 0
        let fail = 0
        // 串行：接口大多是同一批 CDN，并发容易被风控
        for (const sid of targets) {
          try {
            const r = (await this.rpc(RpcMethod.ParseServiceProbe, { id: sid })) as {
              probe: ParseProbe
            }
            if (r.probe.ok) ok++
            else fail++
          } catch {
            fail++
          }
        }
        await this.refresh()
        return { ok, fail }
      } finally {
        this.probing = ''
      }
    },

    /** 解析：direct 由视图直接起播；page 由视图决定嗅探还是内嵌 */
    async resolve(url?: string): Promise<ParseResolveResult> {
      const target = (url ?? this.url).trim()
      if (!target) throw new Error('请输入视频页面地址')
      this.error = ''
      this.embedUrl = ''
      this.sniffedUrl = ''
      this.result = null
      this.stage = 'resolving'
      const cur = this.current
      this.statusText = cur ? `正在请求「${cur.name}」…` : '正在解析…'
      try {
        const r = (await this.rpc(RpcMethod.ParseResolve, {
          url: target,
          serviceId: this.currentId || undefined
        })) as ParseResolveResult
        this.result = r
        this.url = r.pageUrl
        if (r.kind === 'direct' && r.playUrl) {
          this.stage = 'done'
          // P19：命中直链缓存时明确说明，避免用户误以为是刚解析出来的新链
          this.statusText = r.cached
            ? '命中直链缓存（未回源解析接口）'
            : `已拿到直链（${r.via === 'json' ? '接口 JSON' : r.via === 'input' ? '输入即直链' : '页面内嵌'}）`
        } else {
          this.statusText = r.note ?? '接口未直接给出直链'
        }
        return r
      } catch (e) {
        this.stage = 'error'
        this.error = (e as Error).message
        this.statusText = ''
        throw e
      }
    },

    /** 主进程嗅探播放页（隐藏窗口实跑 JS，从网络请求截 m3u8） */
    async sniff(pageUrl: string, timeoutMs = 15_000): Promise<string> {
      const api = window.polyframe
      if (!api?.sniffMedia) throw new Error('当前环境不支持嗅探（需桌面端运行）')
      this.stage = 'sniffing'
      this.statusText = '正在嗅探播放页里的媒体地址（约 10～15 秒）…'
      const r = await api.sniffMedia(pageUrl, timeoutMs)
      if (r.ok && r.playUrl) {
        this.sniffedUrl = r.playUrl
        if (this.result) this.result.candidates = r.candidates
        this.stage = 'done'
        this.statusText = `嗅探成功（${(r.ms / 1000).toFixed(1)}s）`
        return r.playUrl
      }
      this.statusText = ''
      throw new Error(r.error ?? '嗅探失败')
    },

    openWindow(url: string) {
      const api = window.polyframe
      if (api?.openParseWindow) void api.openParseWindow(url)
      else window.open(url, '_blank', 'noopener')
    },

    /** 交给播放页起播（建任务走代理；失败退回直连） */
    async play(url: string, title?: string) {
      const player = usePlayerStore()
      // P20：解析出来的是直链，播放页侧栏只带标题（不冒充剧集信息）
      useCatalogStore().setLooseContext(title || '解析播放', '解析直链')
      try {
        await player.playDirect(url, title || '解析播放')
      } catch {
        player.url = url
        player.pendingPlay = true
        player.route = 'player'
      }
      this.pushHistory(url, title)
    },

    pushHistory(_playUrl: string, _title?: string) {
      const r = this.result
      if (!r) return
      const item: ParseHistoryItem = {
        url: r.pageUrl,
        service: r.serviceName ?? '直连嗅探',
        via: r.kind === 'direct' ? 'direct' : this.sniffedUrl ? 'sniff' : 'page',
        ts: Date.now()
      }
      this.history = [item, ...this.history.filter((h) => h.url !== item.url)].slice(0, 8)
      localStorage.setItem(HISTORY_KEY, JSON.stringify(this.history))
    },

    loadHistory() {
      try {
        const raw = localStorage.getItem(HISTORY_KEY)
        this.history = raw ? (JSON.parse(raw) as ParseHistoryItem[]) : []
      } catch {
        this.history = []
      }
    },

    clearHistory() {
      this.history = []
      localStorage.removeItem(HISTORY_KEY)
    },

    reset() {
      this.stage = 'idle'
      this.statusText = ''
      this.result = null
      this.error = ''
      this.embedUrl = ''
      this.sniffedUrl = ''
    },

    async rpc(method: string, params?: unknown): Promise<unknown> {
      const api = window.polyframe
      if (!api) {
        throw new Error('浏览器调试模式无内核 RPC（用 pnpm dev 启动桌面端）')
      }
      try {
        return await api.rpc(method, params)
      } catch (e) {
        // 内核错误经 IPC 会带一大串前缀，界面只要最后那句人话
        throw new Error(cleanIpcError((e as Error).message))
      }
    }
  }
})
