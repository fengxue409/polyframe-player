import { defineStore } from 'pinia'
import { RpcMethod, type MagnetTask } from '@polyframe/shared'
import { useCatalogStore } from './catalog'
import { usePlayerStore } from './player'

/** 去掉 Electron IPC 的包装前缀：`Error invoking remote method 'pf:rpc': Error: xxx` → `xxx` */
function cleanIpcError(msg: string): string {
  return msg
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(Error|TypeError):\s*/, '')
}

/** 进度轮询间隔：内核每秒写一次库，前端 1.5s 拉一次足够，也不至于把 UI 刷花 */
const POLL_MS = 1500

export const useMagnetStore = defineStore('magnet', {
  state: () => ({
    tasks: [] as MagnetTask[],
    /** 输入框：磁力链接 / info hash / .torrent 地址 */
    input: '',
    /** 正在提交（避免重复点击） */
    adding: false,
    /** 正在操作的任务 id（暂停/删除按钮的 loading 态） */
    busyId: '',
    error: '',
    /** 展开选集的任务 id */
    expanded: '',
    timer: 0 as number | 0
  }),

  getters: {
    /** 有任务在跑 → 需要持续轮询 */
    hasActive: (s) =>
      s.tasks.some((t) => t.status === 'adding' || t.status === 'downloading'),
    doneCount: (s) => s.tasks.filter((t) => t.status === 'done').length
  },

  actions: {
    rpc(method: string, params?: unknown): Promise<unknown> {
      const api = window.polyframe
      if (!api) {
        return Promise.reject(new Error('浏览器调试模式无内核 RPC（用 pnpm dev 启动桌面端）'))
      }
      return api.rpc(method, params)
    },

    async refresh(): Promise<void> {
      if (!window.polyframe) return
      try {
        const r = (await this.rpc(RpcMethod.MagnetList)) as { tasks: MagnetTask[] }
        this.tasks = r.tasks ?? []
      } catch (e) {
        this.error = cleanIpcError((e as Error).message)
      }
    },

    /** 新建任务：内核立即返回（元数据在后台等），进度靠轮询 */
    async add(): Promise<void> {
      const url = this.input.trim()
      if (!url) {
        this.error = '先粘贴磁力链接、info hash 或 .torrent 地址'
        return
      }
      this.adding = true
      this.error = ''
      try {
        await this.rpc(RpcMethod.MagnetAdd, { url })
        this.input = ''
        await this.refresh()
        this.startPolling()
      } catch (e) {
        this.error = cleanIpcError((e as Error).message)
      } finally {
        this.adding = false
      }
    },

    async pause(t: MagnetTask): Promise<void> {
      await this.act(t.id, () => this.rpc(RpcMethod.MagnetPause, { id: t.id }))
      this.startPolling()
    },

    async resume(t: MagnetTask): Promise<void> {
      await this.act(t.id, () => this.rpc(RpcMethod.MagnetResume, { id: t.id }))
      this.startPolling()
    },

    async remove(t: MagnetTask, deleteFiles: boolean): Promise<void> {
      await this.act(t.id, () =>
        this.rpc(RpcMethod.MagnetRemove, { id: t.id, deleteFiles })
      )
      if (this.expanded === t.id) this.expanded = ''
    },

    /** 换集：多集种子只下选中的那一集 */
    async select(t: MagnetTask, fileIndex: number): Promise<void> {
      await this.act(t.id, () => this.rpc(RpcMethod.MagnetSelect, { id: t.id, fileIndex }))
      this.startPolling()
    },

    async act(id: string, fn: () => Promise<unknown>): Promise<void> {
      this.busyId = id
      this.error = ''
      try {
        await fn()
        await this.refresh()
      } catch (e) {
        this.error = cleanIpcError((e as Error).message)
      } finally {
        this.busyId = ''
      }
    },

    /** 播放：只允许已下完；内核返回 /bt 本地代理地址（支持 Range，seek 正常） */
    async play(t: MagnetTask): Promise<void> {
      this.error = ''
      try {
        const r = (await this.rpc(RpcMethod.MagnetPlay, { id: t.id })) as {
          playUrl: string
          name: string
        }
        const player = usePlayerStore()
        // P20：磁力播放是单文件直链，播放页侧栏只带文件名
        useCatalogStore().setLooseContext(r.name || t.name, '磁力')
        player.url = r.playUrl
        // 磁力任务不是下载任务，没有 taskId；置空避免播放页去关联进度
        player.sourceTaskId = ''
        player.pendingPlay = true
        player.route = 'player'
      } catch (e) {
        this.error = cleanIpcError((e as Error).message)
      }
    },

    /**
     * 页面挂载期间持续轮询。
     *
     * 不在「没有活动任务」时停掉：任务也可能从别处（另一个窗口/内核重启后恢复）产生，
     * 界面自己停轮询就会一直显示旧数据。一次 list 只是一条 SQLite 查询，代价可忽略。
     */
    startPolling(): void {
      if (this.timer) return
      this.timer = window.setInterval(() => {
        void this.refresh()
      }, POLL_MS)
    },

    stopPolling(): void {
      if (this.timer) {
        window.clearInterval(this.timer)
        this.timer = 0
      }
    }
  }
})
