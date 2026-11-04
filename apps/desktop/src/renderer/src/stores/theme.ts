/**
 * P34 皮肤（亮 / 暗）
 *
 * 全站配色都是 `App.vue` 里的 CSS 变量，切换主题只做一件事：
 * 把 `data-theme` 写到 `<html>` 上，让 `[data-theme='light']` 那层覆盖生效。
 * 所以这里不需要给任何组件传参，也不需要重建视图 —— 切换是纯 CSS 的，零重渲染。
 *
 * 三处需要同步，缺一处就会出现「闪一下」或「局部还是旧色」：
 * 1. `index.html` 的内联脚本 —— 首帧之前就把属性写好，否则先渲染一帧深色再跳白；
 * 2. 本文件 `apply()` —— 切换时写属性 + 落 localStorage；
 * 3. 主进程 `setBackgroundColor` —— 窗口拖拽/缩放时 Chromium 用它填新露出的区域。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

export type ThemeMode = 'dark' | 'light'

/** localStorage 键：index.html 的内联首帧脚本读的是同一个字符串，改名要同步 */
export const THEME_KEY = 'pf.theme'
const DEFAULT_MODE: ThemeMode = 'dark'

/** 与 App.vue 的 `--bg` 一致：主进程拿它填窗口空白区 */
const SHELL_BG: Record<ThemeMode, string> = {
  dark: '#0b0e14',
  light: '#f2f4f9'
}

function readStored(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v === 'light' || v === 'dark' ? v : DEFAULT_MODE
  } catch {
    // 隐私模式 / 存储被禁用：退回默认，不影响使用
    return DEFAULT_MODE
  }
}

function notifyMain(mode: ThemeMode): void {
  // 浏览器调试模式下没有 preload，静默跳过
  const w = window as unknown as { polyframe?: { setAppearance?: (t: string, bg: string) => void } }
  try {
    w.polyframe?.setAppearance?.(mode, SHELL_BG[mode])
  } catch {
    /* 主进程未就绪不应影响 UI 切换 */
  }
}

export const useThemeStore = defineStore('theme', () => {
  const mode = ref<ThemeMode>(readStored())
  const isDark = computed(() => mode.value === 'dark')

  function apply(next: ThemeMode): void {
    document.documentElement.dataset['theme'] = next
    notifyMain(next)
  }

  function set(next: ThemeMode): void {
    if (next === mode.value) return
    mode.value = next
    apply(next)
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch {
      /* 存储不可写只影响下次启动，当前会话照常生效 */
    }
  }

  function toggle(): void {
    set(mode.value === 'dark' ? 'light' : 'dark')
  }

  // 首次取用时对齐一次：index.html 已经设过属性，这里补上主进程底色
  apply(mode.value)

  return { mode, isDark, set, toggle }
})
