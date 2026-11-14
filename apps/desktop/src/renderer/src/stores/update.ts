/**
 * P50：应用更新状态（主进程 updater 的渲染层镜像）。
 *
 * 主进程是唯一事实源：状态变化经 `pf:update-state` 推过来，这里只缓存 + 转发动作。
 * SideNav 用 `available` 标志画设置入口的小红点，SettingsView 消费全量状态。
 */
import { defineStore } from 'pinia'
import type { ChannelProbe, ReleaseInfo, UpdateConfig, UpdateState } from '../types'

const EMPTY: UpdateState = {
  phase: 'idle',
  form: 'dev',
  currentVersion: '',
  config: {
    enabled: true,
    autoDownload: true,
    intervalHours: 6,
    repo: '',
    extraChannels: [],
    disabledChannels: [],
    lastGoodChannel: ''
  },
  latest: null,
  history: [],
  progress: null,
  pkg: null,
  backupAvailable: false,
  channel: '',
  error: ''
}

let initialized = false

export const useUpdateStore = defineStore('update', {
  state: () => ({
    st: { ...EMPTY } as UpdateState,
    /** 通道探测结果（手动触发） */
    probes: [] as ChannelProbe[],
    probing: false,
    historyLoading: false
  }),
  getters: {
    /** 有新版可用 / 可安装（SideNav 红点） */
    available: (s) => s.st.phase === 'available' || s.st.phase === 'downloaded',
    downloading: (s) => s.st.phase === 'downloading',
    /** 下载进度 0-1（total 未知时返回 -1） */
    pct: (s): number => {
      const p = s.st.progress
      if (!p || !p.total) return -1
      return Math.min(1, p.received / p.total)
    },
    formLabel: (s): string =>
      s.st.form === 'portable' ? '便携版' : s.st.form === 'installer' ? '安装版' : '开发模式'
  },
  actions: {
    /** 在 SideNav/SettingsView 挂载时调用一次：拉快照 + 订阅推送 */
    init(): void {
      if (initialized) return
      initialized = true
      const api = window.polyframe
      if (!api) return
      void api.updateState?.().then((st) => {
        if (st) this.st = st
      })
      api.onUpdateState?.((st) => {
        this.st = st
      })
    },
    async check(): Promise<void> {
      const st = await window.polyframe?.updateCheck?.()
      if (st) this.st = st
    },
    async download(): Promise<void> {
      const st = await window.polyframe?.updateDownload?.()
      if (st) this.st = st
    },
    async install(): Promise<void> {
      const st = await window.polyframe?.updateInstall?.()
      if (st) this.st = st
    },
    async setConfig(patch: Partial<UpdateConfig>): Promise<void> {
      const st = await window.polyframe?.updateSetConfig?.(patch)
      if (st) this.st = st
    },
    async loadHistory(): Promise<void> {
      this.historyLoading = true
      try {
        const list = await window.polyframe?.updateHistory?.()
        if (list) this.st.history = list
      } finally {
        this.historyLoading = false
      }
    },
    async installVersion(tag: string): Promise<void> {
      const st = await window.polyframe?.updateInstallVersion?.(tag)
      if (st) this.st = st
    },
    async testChannels(): Promise<void> {
      this.probing = true
      try {
        this.probes = (await window.polyframe?.updateTestChannels?.()) ?? []
      } finally {
        this.probing = false
      }
    },
    async restoreBackup(): Promise<void> {
      const st = await window.polyframe?.updateRestoreBackup?.()
      if (st) this.st = st
    },
    openDir(): void {
      void window.polyframe?.updateOpenDir?.()
    },
    latestHistory(): ReleaseInfo[] {
      return this.st.history
    }
  }
})
