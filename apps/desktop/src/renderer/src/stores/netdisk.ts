import { defineStore } from 'pinia'
import {
  RpcMethod,
  type Favorite,
  type NetdiskAccount,
  type NetdiskDeviceCode,
  type NetdiskItem,
  type NetdiskPlayInfo,
  type NetdiskProviderInfo,
  type NetdiskProviderKind,
  type NetdiskShare,
  type Task
} from '@polyframe/shared'
import { useCatalogStore } from './catalog'
import { usePlayerStore } from './player'

/** 面包屑（不含根；根由 target 自身表示） */
interface Crumb {
  id: string
  name: string
}

/** 当前浏览目标：账号根目录 或 分享根目录 */
interface Target {
  type: 'account' | 'share'
  id: string
  name: string
  provider: NetdiskProviderKind
}

/** 授权表单（按 provider 取用不同字段） */
interface AuthForm {
  /** provider kind（string 便于 <select> 双向绑定；下发给 RPC 时由 Rust 侧校验） */
  provider: string
  name: string
  cookie: string
  refreshToken: string
  baseUrl: string
  clientId: string
}

/** 设备码轮询定时器（非响应式） */
let deviceTimer: ReturnType<typeof setInterval> | null = null

function stopDeviceTimer(): void {
  if (deviceTimer) {
    clearInterval(deviceTimer)
    deviceTimer = null
  }
}

export const useNetdiskStore = defineStore('netdisk', {
  state: () => ({
    providers: [] as NetdiskProviderInfo[],
    accounts: [] as NetdiskAccount[],
    shares: [] as NetdiskShare[],

    // ---- 浏览状态 ----
    target: null as Target | null,
    crumbs: [] as Crumb[],
    items: [] as NetdiskItem[],
    nextCursor: null as string | null,
    total: null as number | null,
    loading: false,
    loadingMore: false,
    error: '',

    // ---- 授权 ----
    form: {
      provider: 'aliyun' as string,
      name: '',
      cookie: '',
      refreshToken: '',
      baseUrl: '',
      clientId: ''
    } as AuthForm,
    device: null as NetdiskDeviceCode | null,
    devicePending: false,
    submitting: false,

    // ---- 分享 ----
    shareInput: '',
    sharePwd: '',

    // ---- 播放链接信息（有效期展示） ----
    lastPlay: null as NetdiskPlayInfo | null,
    /** RPC 结果日志（UI 底部一行提示） */
    notice: ''
  }),

  getters: {
    /** 当前 provider 的能力描述 */
    currentProvider: (s): NetdiskProviderInfo | undefined =>
      s.providers.find((p) => p.kind === s.form.provider),
    /** 可播放（视频文件）条目 */
    videoItems: (s): NetdiskItem[] => s.items.filter((i) => !i.isDir && i.kind === 'video'),
    canLoadMore: (s): boolean => !!s.nextCursor,
    /** 面包屑完整路径（根 + 各级目录） */
    pathList: (s): Crumb[] => {
      const root: Crumb[] = s.target ? [{ id: '', name: s.target.name }] : []
      return root.concat(s.crumbs)
    },
    currentDirId: (s): string => (s.crumbs.length ? s.crumbs[s.crumbs.length - 1].id : ''),
    hasAccount: (s): boolean => s.accounts.length > 0
  },

  actions: {
    rpc<T>(method: string, params?: unknown): Promise<T> {
      return usePlayerStore().rpc(method, params) as Promise<T>
    },

    async loadAll() {
      try {
        const [prov, acc, sh] = await Promise.all([
          this.rpc<{ providers: NetdiskProviderInfo[] }>(RpcMethod.NetdiskProviders),
          this.rpc<{ accounts: NetdiskAccount[] }>(RpcMethod.NetdiskAccountList),
          this.rpc<{ shares: NetdiskShare[] }>(RpcMethod.NetdiskShareList)
        ])
        this.providers = prov.providers
        this.accounts = acc.accounts
        this.shares = sh.shares
        // 默认表单 provider 选第一个“可直接粘凭据”的（百度/阿里云盘）
        if (this.providers.length && !this.providers.some((p) => p.kind === this.form.provider)) {
          this.form.provider = this.providers[0].kind
        }
      } catch (e) {
        this.error = (e as Error).message
      }
    },

    // ---------- 账号 ----------

    async addAccount() {
      const f = this.form
      this.submitting = true
      this.error = ''
      try {
        const params: Record<string, unknown> = {
          provider: f.provider,
          name: f.name.trim() || undefined
        }
        if (f.cookie.trim()) params.cookie = f.cookie.trim()
        if (f.refreshToken.trim()) params.refreshToken = f.refreshToken.trim()
        if (f.baseUrl.trim()) params.baseUrl = f.baseUrl.trim()
        if (f.clientId.trim()) params.clientId = f.clientId.trim()
        if (f.provider === 'http' && f.refreshToken.trim()) {
          // HTTP 网关：token 兼作 access_token（后端亦兜底）
          params.accessToken = f.refreshToken.trim()
        }
        const r = await this.rpc<{ account: NetdiskAccount; probe: { latencyMs?: number | null } }>(
          RpcMethod.NetdiskAccountAdd,
          params
        )
        this.accounts.unshift(r.account)
        this.notice = `已添加「${r.account.name}」（${r.probe.latencyMs ?? '?'} ms）`
        f.cookie = ''
        f.refreshToken = ''
        f.name = ''
        await this.pickAccount(r.account)
      } catch (e) {
        this.error = (e as Error).message
      } finally {
        this.submitting = false
      }
    },

    async refreshAccount(id: string) {
      try {
        const r = await this.rpc<{ account: NetdiskAccount }>(RpcMethod.NetdiskAccountRefresh, { id })
        this.replaceAccount(r.account)
        this.notice = `「${r.account.name}」登录态已续期`
      } catch (e) {
        this.error = (e as Error).message
        await this.loadAll()
      }
    },

    async removeAccount(id: string) {
      try {
        await this.rpc(RpcMethod.NetdiskAccountRemove, { id })
        this.accounts = this.accounts.filter((a) => a.id !== id)
        if (this.target?.type === 'account' && this.target.id === id) this.target = null
        this.notice = '账号已删除（分享保留，可重新绑定）'
      } catch (e) {
        this.error = (e as Error).message
      }
    },

    replaceAccount(acc: NetdiskAccount) {
      const i = this.accounts.findIndex((a) => a.id === acc.id)
      if (i >= 0) this.accounts.splice(i, 1, acc)
      else this.accounts.unshift(acc)
    },

    // ---------- 设备码授权（OneDrive / HTTP 网关） ----------

    async beginDevice() {
      this.error = ''
      stopDeviceTimer()
      try {
        const dev = await this.rpc<NetdiskDeviceCode>(RpcMethod.NetdiskAuthBegin, {
          provider: this.form.provider,
          clientId: this.form.clientId.trim() || undefined
        })
        this.device = dev
        this.devicePending = true
        this.notice = dev.message ?? `打开 ${dev.verificationUri} 并输入代码 ${dev.userCode}`
        // 自动轮询（间隔按服务端建议）
        deviceTimer = setInterval(() => void this.pollDevice(), Math.max(3, dev.intervalSecs) * 1000)
      } catch (e) {
        this.error = (e as Error).message
        this.device = null
        this.devicePending = false
      }
    },

    async pollDevice(manual = false) {
      if (!this.device || !this.devicePending) return
      try {
        const r = await this.rpc<{
          pending: boolean
          message?: string | null
          account?: NetdiskAccount
        }>(RpcMethod.NetdiskAuthPoll, {
          provider: this.form.provider,
          deviceCode: this.device.deviceCode,
          clientId: this.form.clientId.trim() || undefined,
          name: this.form.name.trim() || undefined
        })
        if (r.pending) {
          if (manual) this.notice = r.message ?? '尚未完成授权，请稍候…'
          return
        }
        if (r.account) {
          stopDeviceTimer()
          this.devicePending = false
          this.device = null
          this.replaceAccount(r.account)
          this.notice = `授权完成：${r.account.name}`
          await this.pickAccount(r.account)
          return
        }
      } catch (e) {
        stopDeviceTimer()
        this.devicePending = false
        this.error = (e as Error).message
      }
    },

    cancelDevice() {
      stopDeviceTimer()
      this.device = null
      this.devicePending = false
    },

    // ---------- 目录浏览 ----------

    async pickAccount(acc: NetdiskAccount) {
      this.target = {
        type: 'account',
        id: acc.id,
        name: acc.name,
        provider: acc.provider
      }
      this.crumbs = []
      await this.loadDir('')
    },

    async openShare(sh: NetdiskShare) {
      this.target = {
        type: 'share',
        id: sh.id,
        name: sh.title || `分享 ${sh.shareId.slice(0, 8)}`,
        provider: sh.provider
      }
      this.crumbs = []
      await this.loadDir('')
    },

    /** 加载目录：cursor 为空 = 首屏（覆盖），非空 = 加载更多（追加） */
    async loadDir(dirId: string, cursor?: string) {
      if (!this.target) return
      const appending = !!cursor
      if (appending) this.loadingMore = true
      else this.loading = true
      this.error = ''
      try {
        const r = await this.rpc<{
          items: NetdiskItem[]
          nextCursor?: string | null
          total?: number | null
        }>(RpcMethod.NetdiskList, {
          accountId: this.target.type === 'account' ? this.target.id : undefined,
          shareId: this.target.type === 'share' ? this.target.id : undefined,
          dirId: dirId || undefined,
          cursor: cursor || undefined
        })
        this.items = appending ? this.items.concat(r.items) : r.items
        this.nextCursor = r.nextCursor ?? null
        this.total = r.total ?? null
      } catch (e) {
        this.error = (e as Error).message
        if (!appending) {
          this.items = []
          this.nextCursor = null
        }
      } finally {
        this.loading = false
        this.loadingMore = false
      }
    },

    async loadMore() {
      if (!this.nextCursor || this.loadingMore) return
      await this.loadDir(this.currentDirId, this.nextCursor)
    },

    /** 刷新当前目录（保持面包屑） */
    async reload() {
      await this.loadDir(this.currentDirId)
    },

    /** 进入子目录 */
    async enterDir(item: NetdiskItem) {
      if (!item.isDir) return
      this.crumbs.push({ id: item.id, name: item.name })
      await this.loadDir(item.id)
    },

    /** 面包屑跳转（index = pathList 下标，0 = 根） */
    async goPath(index: number) {
      const list = this.pathList
      const clamped = Math.max(0, Math.min(index, list.length - 1))
      this.crumbs = this.crumbs.slice(0, Math.max(0, clamped))
      await this.loadDir(this.currentDirId)
    },

    async goRoot() {
      this.crumbs = []
      await this.loadDir('')
    },

    // ---------- 播放 ----------

    /** 在线播放：直接用 shim URL 起播（不建任务、不落盘） */
    async playNow(item: NetdiskItem) {
      if (!this.target) return
      try {
        const info = await this.rpc<NetdiskPlayInfo>(RpcMethod.NetdiskResolve, {
          accountId: this.target.type === 'account' ? this.target.id : undefined,
          shareId: this.target.type === 'share' ? this.target.id : undefined,
          fileId: item.id
        })
        this.lastPlay = info
        const player = usePlayerStore()
        // P20：直链播放，播放页侧栏只带文件名（不冒充剧集信息）
        useCatalogStore().setLooseContext(item.name, '网盘')
        player.url = info.url
        player.sourceTaskId = ''
        player.pendingPlay = true
        player.route = 'player'
        this.notice = `播放链接已就绪（直链 ${fmtExpiry(info.expiresInSecs)}，到期自动续期）`
      } catch (e) {
        this.error = (e as Error).message
      }
    },

    /** 加入任务：走引擎分块管线（可缓存/预取/断点续存） */
    async addAsTask(item: NetdiskItem) {
      if (!this.target) return
      try {
        const r = await this.rpc<{ task: Task }>(RpcMethod.NetdiskPlay, {
          accountId: this.target.type === 'account' ? this.target.id : undefined,
          shareId: this.target.type === 'share' ? this.target.id : undefined,
          fileId: item.id,
          name: item.name,
          cacheMode: usePlayerStore().newTaskCacheMode
        })
        const player = usePlayerStore()
        await player.refreshTasks()
        player.playTask(r.task)
        this.notice = `已加入任务：${item.name}`
      } catch (e) {
        this.error = (e as Error).message
      }
    },

    /** P16 收藏进媒体库：目录=剧集（自动收集视频为集）/ 文件=电影；同名自动归并既有收藏 */
    async favorite(item: NetdiskItem) {
      if (!this.target) return
      this.error = ''
      try {
        const r = await this.rpc<{ favorite: Favorite }>(RpcMethod.NetdiskFavorite, {
          accountId: this.target.type === 'account' ? this.target.id : undefined,
          shareId: this.target.type === 'share' ? this.target.id : undefined,
          fileId: item.isDir ? undefined : item.id,
          dirId: item.isDir ? item.id : undefined,
          name: item.name
        })
        this.notice = `已收藏「${r.favorite.name}」，媒体库/继续观看可见`
      } catch (e) {
        this.error = (e as Error).message
      }
    },

    // ---------- 分享 ----------

    async addShare() {
      const url = this.shareInput.trim()
      if (!url) return
      this.submitting = true
      this.error = ''
      try {
        const r = await this.rpc<{ share: NetdiskShare; items: NetdiskItem[] }>(
          RpcMethod.NetdiskShareAdd,
          { url, pwd: this.sharePwd.trim() || undefined }
        )
        if (!this.shares.some((s) => s.id === r.share.id)) this.shares.unshift(r.share)
        this.shareInput = ''
        this.sharePwd = ''
        this.notice = `分享已打开（${r.items.length} 项）`
        await this.openShare(r.share)
      } catch (e) {
        this.error = (e as Error).message
      } finally {
        this.submitting = false
      }
    },

    async removeShare(id: string) {
      try {
        await this.rpc(RpcMethod.NetdiskShareRemove, { id })
        this.shares = this.shares.filter((s) => s.id !== id)
        if (this.target?.type === 'share' && this.target.id === id) this.target = null
      } catch (e) {
        this.error = (e as Error).message
      }
    }
  }
})

/** 直链剩余有效期文案 */
export function fmtExpiry(secs?: number | null): string {
  if (secs == null) return '无固定期限'
  if (secs <= 0) return '即将过期'
  const m = Math.floor(secs / 60)
  const s = secs % 60
  if (m >= 60) return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`
}

/** 字节数 → 人类可读 */
export function fmtSize(n?: number | null): string {
  const b = n ?? 0
  if (b <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = b
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`
}

/** epoch ms → 相对时间 */
export function fmtWhen(ms?: number | null): string {
  if (!ms) return '—'
  const diff = Date.now() - ms
  if (diff < 0) {
    const mins = Math.round(-diff / 60000)
    return mins < 1 ? '即将' : `${mins} 分钟后`
  }
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}
