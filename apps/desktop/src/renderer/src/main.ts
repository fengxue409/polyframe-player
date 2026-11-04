import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { useCatalogStore } from './stores/catalog'
import { useHistoryStore } from './stores/history'
import { useMagnetStore } from './stores/magnet'
import { usePlayerStore } from './stores/player'

const pinia = createPinia()
createApp(App).use(pinia).mount('#app')

// 仅用于 UI 快照脚本（ui-snapshot.mjs + PF_UITEST=1）：详情弹层、磁力任务行、调试抽屉、
// 播放历史都依赖内核数据，浏览器调试模式下列表永远是空的，只能把 store 暴露出去喂假数据。
// 桌面端加载的是 file://.../index.html，不带 ?uitest，这段不会执行。
if (location.search.includes('uitest')) {
  const w = window as unknown as Record<string, unknown>
  w.__pfCatalog = useCatalogStore(pinia)
  w.__pfMagnet = useMagnetStore(pinia)
  w.__pfPlayer = usePlayerStore(pinia)
  w.__pfHistory = useHistoryStore(pinia)
}

// ---- P37 诊断：把渲染层的异常与环境一次性落盘 ----
// 「黑屏但一切正常」的现场以前完全不可复盘：调试抽屉只存在内存里，关掉窗口就没了。
const diag = (tag: string, msg: string): void => window.polyframe?.diag?.(tag, msg)
// ResizeObserver 的这条是 Chrome 已知良性告警（回调里改了尺寸触发下一轮），
// 本应用大量用 RO 实测布局，每帧都可能刷一条 —— 不滤掉会把真错误淹了
const NOISE = /ResizeObserver loop/i
window.addEventListener('error', (e) => {
  if (NOISE.test(e.message)) return
  diag('ui-error', `${e.message} @${e.filename}:${e.lineno}:${e.colno}`)
})
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason as { message?: string } | string | undefined
  const text = String(typeof r === 'object' ? (r?.message ?? JSON.stringify(r)) : r)
  if (NOISE.test(text)) return
  diag('ui-reject', text)
})

// 环境快照：分辨率/DPR/皮肤/内核/代理能力，排查渲染类黑屏时第一眼要看的就是这些
requestAnimationFrame(() => {
  const p = usePlayerStore(pinia)
  const gpu = (() => {
    try {
      const c = document.createElement('canvas')
      const gl = c.getContext('webgl2') ?? c.getContext('webgl')
      if (!gl) return 'no-webgl'
      const ext = gl.getExtension('WEBGL_debug_renderer_info')
      return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'masked'
    } catch {
      return 'webgl-error'
    }
  })()
  diag(
    'ui-env',
    `viewport=${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio} ` +
      `theme=${document.documentElement.dataset.theme ?? '-'} engine=${p.engine} ` +
      `cacheMode=${p.newTaskCacheMode} gpu="${gpu}" ua="${navigator.userAgent.slice(0, 120)}"`
  )
})
