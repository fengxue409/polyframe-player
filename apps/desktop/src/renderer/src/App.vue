<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { usePlayerStore } from './stores/player'
import { useDanmakuStore } from './stores/danmaku'
import SideNav from './components/SideNav.vue'
import PlayerView from './components/PlayerView.vue'
import ParseView from './components/ParseView.vue'
import NetdiskView from './components/NetdiskView.vue'
import MagnetView from './components/MagnetView.vue'
import DiscoverView from './components/DiscoverView.vue'
import HomeView from './components/HomeView.vue'
import CatalogDetailModal from './components/CatalogDetailModal.vue'
import TasksView from './components/TasksView.vue'
import LibraryView from './components/LibraryView.vue'
import HistoryView from './components/HistoryView.vue'
import SettingsView from './components/SettingsView.vue'

const store = usePlayerStore()
const dm = useDanmakuStore()

/** 播放页弹幕角标点击 → 跳到设置页弹幕区块（避免 DanmakuLayer 直接耦合路由） */
function onOpenDanmakuSettings(): void {
  store.go('settings')
}

onMounted(() => {
  void store.init()
  void dm.init()
  window.addEventListener('pf:open-danmaku-settings', onOpenDanmakuSettings)
})

onBeforeUnmount(() => {
  window.removeEventListener('pf:open-danmaku-settings', onOpenDanmakuSettings)
})

// 详情弹层（全局单例）的轻提示
const detailToast = ref('')
let detailToastTimer: ReturnType<typeof setTimeout> | null = null
function onDetailToast(msg: string) {
  detailToast.value = msg
  if (detailToastTimer) clearTimeout(detailToastTimer)
  detailToastTimer = setTimeout(() => (detailToast.value = ''), 2600)
}
</script>

<template>
  <div class="app">
    <SideNav />
    <div class="main">
      <main class="content">
        <!-- P53：首页/发现同属 route 'home'，按 homeTab 互斥；v-show 保活（轮播进度、搜索结果、弹层状态） -->
        <HomeView v-show="store.route === 'home' && store.homeTab === 'reco'" />
        <!-- 播放页 v-show 保活：切页不打断播放 / video 元素常驻 -->
        <PlayerView v-show="store.route === 'player'" />
        <!-- 解析页 v-show 保活：保留内嵌播放页与解析结果（切走再回来不重载） -->
        <ParseView v-show="store.route === 'parse'" />
        <!-- 网盘页 v-show 保活：保留目录位置/分页游标与账号表单 -->
        <NetdiskView v-show="store.route === 'netdisk'" />
        <!-- 磁力页 v-show 保活：保留输入与轮询状态 -->
        <MagnetView v-show="store.route === 'magnet'" />
        <!-- P53 发现页并入首页：侧栏不再有独立入口，由首页工具条「发现」标签进入 -->
        <DiscoverView v-show="store.route === 'home' && store.homeTab === 'discover'" />
        <TasksView v-if="store.route === 'tasks'" />
        <LibraryView v-if="store.route === 'library'" />
        <!-- 历史页 v-if：每次进来都重查，避免看到上一轮的旧列表 -->
        <HistoryView v-if="store.route === 'history'" />
        <SettingsView v-if="store.route === 'settings'" />
      </main>
    </div>

    <!-- 影视详情弹层（全局单例）：首页/发现页点卡片就地弹出，不切页面 -->
    <CatalogDetailModal @toast="onDetailToast" />
    <Transition name="pf-toast">
      <div v-if="detailToast" class="toast" role="status">{{ detailToast }}</div>
    </Transition>
  </div>
</template>

<style>
/* ==========================================================================
   PolyFrame Player —— 全局设计系统（P28 界面重设计）
   --------------------------------------------------------------------------
   分五层：① token ② 基础元素 ③ 材质/排版 ④ 组件原语 ⑤ 工具类与响应式。
   所有视图只允许消费这里定义的 token 与组件类，不再各自硬编码色值/圆角。
   ========================================================================== */

/* ---- ① Design tokens ------------------------------------------------ */
:root {
  color-scheme: dark;

  /* 背景层级：越靠上越亮，用亮度差代替边框来表达层次 */
  --bg: #0b0e14; /* 应用画布（= 主进程 backgroundColor，改动需同步） */
  --bg-nav: #090c12; /* 侧栏：比画布更暗，形成「凹陷」的导航面 */
  --panel: #121722; /* 卡片面 */
  --panel-2: #0d1119; /* 下沉面：输入框 / 表格换行 / 代码块 */
  --panel-3: #1a2130; /* 抬升面：次级按钮 / 选中态 */

  /* 描边：1px 硬边只表达分组，不表达层级 */
  --line: #1e2534;
  --line-2: #2a3346;

  /* 文字：三级即可，全部满足 WCAG AA（panel 上 15.0 / 7.1 / 4.9） */
  --text: #e2e7f0;
  --text-dim: #9aa5b8;
  --text-faint: #7b879b;

  /* 品牌色：单一强调色 + 派生半透明，避免出现第二种蓝 */
  --accent: #4c7dff;
  --accent-hi: #6b93ff;
  --accent-soft: color-mix(in srgb, var(--accent) 16%, transparent);
  --accent-line: color-mix(in srgb, var(--accent) 42%, transparent);
  --accent-ink: #b9cbff; /* 强调色底上的文字，比纯白柔和 */

  /* 语义色：-bg / -line / 本体 三元组，保证任何组合都可读 */
  --ok: #3ecf8e;
  --ok-bg: color-mix(in srgb, var(--ok) 14%, transparent);
  --ok-line: color-mix(in srgb, var(--ok) 34%, transparent);
  --warn: #e8c05a;
  --warn-bg: color-mix(in srgb, var(--warn) 14%, transparent);
  --warn-line: color-mix(in srgb, var(--warn) 34%, transparent);
  --danger: #ff8290;
  --danger-bg: color-mix(in srgb, var(--danger) 14%, transparent);
  --danger-line: color-mix(in srgb, var(--danger) 34%, transparent);
  --info: #58a6ff;
  --info-bg: color-mix(in srgb, var(--info) 14%, transparent);
  --info-line: color-mix(in srgb, var(--info) 34%, transparent);

  /*
   * 评分/热度金：只允许出现在海报深遮罩、视频舞台这类「恒暗」表面上
   *（遮罩与主题无关，所以这支金也是恒定值，不做亮色变体）。
   * 若将来要放在主题化表面上，必须另配亮色加深版，不能直接复用。
   */
  --gold: #ffd166;

  /* 海报深遮罩上的恒亮文字：遮罩恒为深色（rgb(6 9 14 / …)），文字也恒定。
   * 此前 History/Library 各自硬编码了 4 个近似白（cdd7e8/e6ecf7/dbe3f2/dbe4f2），
   * 现收敛为两级，与主题文字的三级层次对齐。 */
  --ov-text: #e6ecf7; /* 遮罩上的主文字 */
  --ov-dim: #cdd7e8; /* 遮罩上的次级文字 */

  /* 圆角：4 档，按「元素尺寸越小圆角越小」分配 */
  --r-sm: 6px;
  --r-md: 8px;
  --r-lg: 12px;
  --r-xl: 16px;
  --r-pill: 999px;

  /* 间距：4 的倍数，杜绝 5/7/9/11px 这类随手值 */
  --sp-1: 4px;
  --sp-2: 8px;
  --sp-3: 12px;
  --sp-4: 16px;
  --sp-5: 20px;
  --sp-6: 24px;
  --sp-8: 32px;
  --sp-10: 40px;

  /* 字号：7 档，UI 正文 13px，长文 13px/1.65 */
  --fs-2xs: 11px;
  --fs-xs: 12px;
  --fs-sm: 13px;
  --fs-md: 14px;
  --fs-lg: 16px;
  --fs-xl: 20px;
  --fs-2xl: 26px;

  /* 阴影：只用于浮层与 hover 抬升，静态卡片一律靠底色分层 */
  --shadow-1: 0 1px 2px rgb(0 0 0 / 0.4);
  --shadow-2: 0 10px 28px -12px rgb(0 0 0 / 0.7);
  --shadow-3: 0 28px 72px -20px rgb(0 0 0 / 0.8);
  --shadow-color: rgb(0 0 0 / 0.7); /* 单向阴影（如底部抽屉）的投影色 */
  --ring: 0 0 0 3px var(--accent-soft);

  /* 动效：三个时长 + 一条曲线，全局只用这些 */
  --t-fast: 120ms;
  --t-base: 180ms;
  --t-slow: 320ms;
  --ease: cubic-bezier(0.22, 0.7, 0.28, 1);

  /* 层级 */
  --z-sticky: 20;
  --z-mask: 60;
  --z-toast: 90;

  /* 共享尺寸：卡片最小宽度（首页/发现/媒体库同一密度） */
  --pf-card-min: 190px;

  /*
   * 材质色（P34 新增）：这些值过去散落在组件里写死，导致亮色皮肤下到处都是
   * 深色残留。凡是「随底色变化」的表面、描边、扫光、遮罩都必须从这里取。
   */
  --panel-hover: #151b27; /* 卡片 hover 抬升 */
  --line-hover: #36415a; /* 描边 hover / 输入框描边 hover */
  --btn-hover: #212a3b; /* 次级按钮 hover 面 */
  --btn-active: #1a2130; /* 次级按钮按下 */
  --input-focus-bg: #0f141d; /* 输入框聚焦时的面 */
  --track: #1a2130; /* 进度条轨道 */
  --row-hover: rgb(255 255 255 / 0.022); /* 表格行 hover */
  --card-highlight: inset 0 1px 0 rgb(255 255 255 / 0.028); /* 卡片顶部高光 */
  --scroll-thumb: #242c3b;
  --scroll-thumb-hi: #354057;
  --skeleton: #161d29;
  --skeleton-glow: rgb(255 255 255 / 0.055);
  --toast-bg: rgb(24 30 41 / 0.96);
  --modal-bg: #131926;
  --mask: rgb(4 6 10 / 0.66);
  --fallback-a: #131a2a; /* 无海报占位的渐变两端（固定色） */
  --fallback-b: #1a1626;
  /* 无海报占位的渐变（按标题色相派生）：暗色压深、亮色提亮，水印色随之反转 */
  --fb-s: 42%;
  --fb-s-2: 38%;
  --fb-l1: 19%;
  --fb-l2: 12%;
  --fb-ink: rgb(255 255 255 / 0.15);
}

/*
 * ---- ② 亮色皮肤 ------------------------------------------------------
 * 只覆盖「颜色」，圆角/间距/字号/动效与暗色完全共用，所以两套皮肤的结构
 * 永远一致，不会出现「改了一边忘了另一边」。
 *
 * 两处刻意不跟随主题：
 * - 视频舞台（`.video-wrap` / 解析页 `.screen`）恒为深色：亮底会让画面
 *   失去边界感，且 mpv 原生子窗口在亮底上边缘更难对齐。
 * - 图片/封面上的叠加层（`rgb(6 9 14 / …)` 这类）恒为深色：它们压在海报上，
 *   与页面底色无关。
 */
:root[data-theme='light'] {
  color-scheme: light;

  --bg: #f2f4f9;
  --bg-nav: #ffffff;
  --panel: #ffffff;
  --panel-2: #f4f6fb;
  --panel-3: #e7ebf4;

  --line: #e0e5ee;
  --line-2: #cbd3e1;

  /* 亮底下深色文字对比：text 14.9 / dim 6.6 / faint 4.7（全过 AA） */
  --text: #17202e;
  --text-dim: #4d5972;
  --text-faint: #6c7893;

  /* 强调色必须整体加深：同一支 #4c7dff 在近白底上对比只有 3.1，白字压上去不可读 */
  --accent: #2b58d4;
  --accent-hi: #1e46b4;
  --accent-ink: #1a3a94;

  --ok: #0b7f4f;
  --warn: #8f5c00;
  --danger: #c62839;
  --info: #14608f;

  /* 亮色阴影要更淡、扩散更大，否则白卡片会像贴了一层黑边 */
  --shadow-1: 0 1px 2px rgb(16 24 40 / 0.06);
  --shadow-2: 0 10px 28px -14px rgb(16 24 40 / 0.18);
  --shadow-3: 0 24px 64px -22px rgb(16 24 40 / 0.28);
  --shadow-color: rgb(16 24 40 / 0.24);
  --ring: 0 0 0 3px color-mix(in srgb, var(--accent) 20%, transparent);

  --panel-hover: #f7f9fd;
  --line-hover: #b6bfd2;
  --btn-hover: #e3e7f1;
  --btn-active: #dbe0ec;
  --input-focus-bg: #ffffff;
  --track: #e6eaf2;
  --row-hover: rgb(16 24 40 / 0.028);
  /* 白卡片上再加白色高光毫无意义，直接去掉 */
  --card-highlight: none;
  --scroll-thumb: #c6cedd;
  --scroll-thumb-hi: #a9b4c8;
  --skeleton: #e8ecf4;
  --skeleton-glow: rgb(255 255 255 / 0.9);
  --toast-bg: rgb(255 255 255 / 0.97);
  --modal-bg: #ffffff;
  --mask: rgb(20 27 42 / 0.38);
  --fallback-a: #dde3f1;
  --fallback-b: #e6e1f2;
  --fb-s: 52%;
  --fb-s-2: 46%;
  --fb-l1: 88%;
  --fb-l2: 82%;
  --fb-ink: rgb(23 32 46 / 0.26);
}

/* ---- ② 基础元素 ----------------------------------------------------- */
* {
  box-sizing: border-box;
  margin: 0;
}
html,
body {
  height: 100%;
}
body {
  background: var(--bg);
  color: var(--text);
  font-family: 'Segoe UI', 'Microsoft YaHei UI', 'Microsoft YaHei', system-ui, sans-serif;
  font-size: var(--fs-sm);
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
#app {
  height: 100%;
}
::selection {
  background: color-mix(in srgb, var(--accent) 34%, transparent);
  color: var(--text);
}

/* 滚动条：全局统一窄条，避免 Chromium 默认亮灰条破坏暗色连续性 */
::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: var(--scroll-thumb);
  border: 3px solid transparent;
  background-clip: padding-box;
  border-radius: var(--r-pill);
}
::-webkit-scrollbar-thumb:hover {
  background: var(--scroll-thumb-hi);
  background-clip: padding-box;
}
::-webkit-scrollbar-corner {
  background: transparent;
}

/* ---- ③ 材质与排版 --------------------------------------------------- */
.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  padding: var(--sp-4);
  /* 顶部 1px 高光：让卡片在纯色背景上有「微微凸起」的实体感 */
  box-shadow: var(--card-highlight);
}
/* 可点击卡片：hover 只提层级，不放大（避免网格抖动） */
.card.interactive {
  transition: border-color var(--t-base) var(--ease), background var(--t-base) var(--ease),
    box-shadow var(--t-base) var(--ease), transform var(--t-base) var(--ease);
}
.card.interactive:hover {
  border-color: var(--line-2);
  background: var(--panel-hover);
}

/* 卡片内的小节标题：中文不用 uppercase / 字间距，靠字重与颜色分层 */
h3 {
  font-size: var(--fs-sm);
  color: var(--text);
  font-weight: 600;
  letter-spacing: 0;
  margin-bottom: var(--sp-3);
}
h4 {
  font-size: var(--fs-xs);
  color: var(--text-dim);
  font-weight: 600;
  letter-spacing: 0.2px;
}
/* 页面级工具条：标题 + 说明 + 右侧动作，替代各页面重复的 H1 */
.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--sp-4);
  flex-wrap: wrap;
  margin-bottom: var(--sp-4);
}
.page-head-text {
  min-width: 0;
}
.page-head h2 {
  font-size: var(--fs-lg);
  font-weight: 600;
  line-height: 1.3;
}
.page-head p {
  margin-top: 2px;
  font-size: var(--fs-xs);
  color: var(--text-dim);
}

/* ---- ④ 组件原语 ----------------------------------------------------- */

/* 按钮：button 与 .btn 共用同一套底座，尺寸/语义只做叠加 */
button,
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex: none;
  min-height: 34px;
  padding: 0 14px;
  border: 1px solid var(--line-2);
  border-radius: var(--r-md);
  background: var(--panel-3);
  color: var(--text);
  font-size: var(--fs-sm);
  font-family: inherit;
  line-height: 1.2;
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease),
    color var(--t-fast) var(--ease), transform var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
}
button:hover:not(:disabled),
.btn:hover:not(:disabled) {
  background: var(--btn-hover);
  border-color: var(--line-hover);
}
button:active:not(:disabled),
.btn:active:not(:disabled) {
  /* 按下时轻微下沉 + 变暗：比只改背景更像「真的按到了」 */
  transform: translateY(1px);
  background: var(--btn-active);
}
button:disabled,
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
/* 焦点环：只在键盘导航时出现，鼠标点击不闪 */
button:focus-visible,
.btn:focus-visible,
a:focus-visible,
summary:focus-visible,
[tabindex]:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* 主按钮：全应用唯一的实心强调色 */
button.primary,
.btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  font-weight: 500;
  box-shadow: 0 1px 0 rgb(255 255 255 / 0.12) inset;
}
button.primary:hover:not(:disabled),
.btn.primary:hover:not(:disabled) {
  background: var(--accent-hi);
  border-color: var(--accent-hi);
}
button.primary:active:not(:disabled),
.btn.primary:active:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 88%, #000);
}
/* 次要动作：无底色，只有细边，视觉权重低于主按钮 */
.btn.ghost,
button.ghost {
  background: transparent;
  border-color: var(--line-2);
  color: var(--text-dim);
}
.btn.ghost:hover:not(:disabled),
button.ghost:hover:not(:disabled) {
  background: var(--panel-3);
  border-color: var(--line-hover);
  color: var(--text);
}
.btn.ghost.active,
button.ghost.active {
  background: var(--accent-soft);
  border-color: var(--accent-line);
  color: var(--accent-ink);
}
/* 破坏性动作：只在 hover 时才让红意变浓 */
.btn.danger,
button.danger {
  background: transparent;
  border-color: color-mix(in srgb, var(--danger) 28%, transparent);
  color: var(--danger);
}
.btn.danger:hover:not(:disabled),
button.danger:hover:not(:disabled) {
  background: var(--danger-bg);
  border-color: var(--danger-line);
}

/* 尺寸：sm 用于表格行内与卡片动作，xs 用于信息密集处 */
.btn.sm,
button.sm {
  min-height: 30px;
  padding: 0 11px;
  font-size: var(--fs-xs);
  border-radius: var(--r-sm);
}
.btn.xs,
button.xs,
button.mini {
  min-height: 26px;
  padding: 0 9px;
  font-size: var(--fs-2xs);
  border-radius: var(--r-sm);
  gap: 4px;
}
.btn.block {
  width: 100%;
}
button.mini.danger {
  background: transparent;
  border-color: color-mix(in srgb, var(--danger) 28%, transparent);
  color: var(--danger);
}
button.mini.danger:hover:not(:disabled) {
  background: var(--danger-bg);
  border-color: var(--danger-line);
}
/* 动作组：统一间距，窄容器自动换行，不再靠各自 margin 硬挤 */
.btn-row,
.btn-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  margin-top: var(--sp-3);
}
.btn-group.tight {
  gap: 6px;
  margin-top: 0;
}

/* 表单：输入框/下拉/文本域同一套边框与焦点环 */
input,
textarea,
select {
  flex: 1;
  min-width: 0;
  background: var(--panel-2);
  border: 1px solid var(--line-2);
  color: var(--text);
  padding: 7px 10px;
  border-radius: var(--r-md);
  font-size: var(--fs-sm);
  font-family: inherit;
  line-height: 1.45;
  outline: none;
  transition: border-color var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease),
    background var(--t-fast) var(--ease);
}
input::placeholder,
textarea::placeholder {
  color: var(--text-faint);
}
input:hover:not(:disabled),
textarea:hover:not(:disabled),
select:hover:not(:disabled) {
  border-color: var(--line-hover);
}
/* 焦点用「边框 + 柔和外环」，比单纯换边框色更容易看见 */
input:focus,
textarea:focus,
select:focus {
  border-color: var(--accent);
  box-shadow: var(--ring);
  background: var(--input-focus-bg);
}
textarea {
  padding: 8px 10px;
  line-height: 1.6;
  resize: vertical;
}
select {
  cursor: pointer;
  padding-right: 26px;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%237b879b' stroke-width='1.6' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 9px center;
}
/*
 * 亮色皮肤的下拉箭头：色值写在 data URI 里，没法用变量插值，
 * 只能整条重写。不改的话浅底上是一条几乎看不见的浅灰箭头。
 */
:root[data-theme='light'] select {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%234d5972' stroke-width='1.6' stroke-linecap='round'/%3E%3C/svg%3E");
}
/* 勾选框/单选框是控件而非输入框：剥掉文本框的尺寸与底色 */
input[type='checkbox'],
input[type='radio'] {
  flex: none;
  width: 15px;
  height: 15px;
  padding: 0;
  margin: 0;
  accent-color: var(--accent);
  cursor: pointer;
  box-shadow: none;
}
input[type='range'] {
  flex: 1;
  min-width: 0;
  padding: 0;
  border: none;
  background: transparent;
  accent-color: var(--accent);
  height: 18px;
  cursor: pointer;
}
input[type='color'] {
  padding: 2px;
  cursor: pointer;
}
input[type='number'] {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

/* 下拉（带语义底色：任务缓存模式用） */
.mode-select {
  flex: none;
  width: auto;
  background-color: var(--panel-3);
  border-color: var(--line-2);
  color: var(--text);
  font-size: var(--fs-xs);
  padding: 6px 26px 6px 9px;
  border-radius: var(--r-sm);
}
.mode-select.inline {
  padding: 2px 22px 2px 6px;
  font-size: var(--fs-2xs);
  border-radius: var(--r-sm);
  background-position: right 7px center;
}
select.cm-online {
  background-color: var(--warn-bg);
  color: var(--warn);
  border-color: var(--warn-line);
}
select.cm-stream {
  background-color: var(--ok-bg);
  color: var(--ok);
  border-color: var(--ok-line);
}
select.cm-precache {
  background-color: var(--info-bg);
  color: var(--info);
  border-color: var(--info-line);
}

/* 徽章：默认中性，语义变体统一从 token 派生 */
.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  border-radius: var(--r-sm);
  background: var(--panel-3);
  color: var(--text-dim);
  font-size: var(--fs-2xs);
  font-weight: 500;
  line-height: 1.55;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.badge.ok {
  background: var(--ok-bg);
  color: var(--ok);
}
.badge.warn {
  background: var(--warn-bg);
  color: var(--warn);
}
.badge.danger {
  background: var(--danger-bg);
  color: var(--danger);
}
.badge.info {
  background: var(--info-bg);
  color: var(--info);
}
.badge.accent {
  background: var(--accent-soft);
  color: var(--accent-ink);
}

/* 胶囊筛选片：分类/年份/地区/模式切换共用 */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  padding: 4px 12px;
  border: 1px solid var(--line-2);
  border-radius: var(--r-pill);
  background: var(--panel-2);
  color: var(--text-dim);
  font-size: var(--fs-xs);
  line-height: 1.6;
  cursor: pointer;
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease),
    color var(--t-fast) var(--ease);
}
.chip:hover:not(:disabled) {
  background: var(--panel-3);
  border-color: var(--line-hover);
  color: var(--text);
}
.chip.active {
  background: var(--accent-soft);
  border-color: var(--accent-line);
  color: var(--accent-ink);
  font-weight: 500;
}
.chip:disabled {
  opacity: 0.5;
  cursor: default;
}

/* 分段控件（搜索/分类、下载/收藏这种「互斥视图」切换） */
.segmented {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--panel-2);
  flex: none;
}
.segmented button {
  min-height: 28px;
  padding: 0 14px;
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-dim);
  font-size: var(--fs-xs);
  box-shadow: none;
}
.segmented button:hover:not(:disabled) {
  background: var(--panel-3);
  border: none;
  color: var(--text);
  transform: none;
}
.segmented button.active {
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-weight: 600;
}

/* 键值行：左标签右值，长值可换行不撑破卡片 */
.kv {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--sp-3);
  padding: 6px 0;
  font-size: var(--fs-xs);
  border-bottom: 1px solid color-mix(in srgb, var(--line) 60%, transparent);
}
.kv:last-of-type {
  border-bottom: none;
}
.k {
  color: var(--text-dim);
  flex: none;
}
.kv > :last-child {
  min-width: 0;
  text-align: right;
  overflow-wrap: anywhere;
}

/* 提示条：错误 / 提醒 / 成功三态 */
.alert,
.notice {
  margin-top: var(--sp-3);
  padding: 8px 12px;
  border-radius: var(--r-md);
  font-size: var(--fs-xs);
  line-height: 1.6;
  word-break: break-word;
}
.alert {
  background: var(--danger-bg);
  border: 1px solid var(--danger-line);
  color: var(--danger);
}
.notice {
  background: var(--warn-bg);
  border: 1px solid var(--warn-line);
  color: var(--warn);
}
.url-hint {
  margin: 8px 0 0;
  font-size: var(--fs-2xs);
  line-height: 1.6;
  color: var(--text-faint);
}
.url-hint code,
code {
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 0.94em;
  color: var(--text-dim);
}

/* 表格：表头吸顶 + 行 hover，宽表在外层 .table-wrap 横向滚动 */
table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-xs);
}
th {
  position: sticky;
  top: 0;
  z-index: 1;
  text-align: left;
  color: var(--text-dim);
  font-weight: 500;
  font-size: var(--fs-2xs);
  letter-spacing: 0.3px;
  padding: 7px 8px;
  background: var(--panel);
  border-bottom: 1px solid var(--line-2);
  white-space: nowrap;
}
td {
  padding: 8px;
  border-bottom: 1px solid var(--line);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}
tbody tr:last-child td {
  border-bottom: none;
}
tbody tr:hover td {
  background: var(--row-hover);
}
.table-wrap {
  width: 100%;
  overflow-x: auto;
}

/* 进度条：轨道下沉、填充用强调色，细到 4px 也不糊 */
.progress {
  height: 5px;
  border-radius: var(--r-pill);
  background: var(--track);
  overflow: hidden;
}
.progress > i,
.progress > .bar {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 55%, #9a7bff));
  transition: width var(--t-slow) var(--ease);
}

/* 加载指示器 */
.spin,
.spinner {
  flex: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid var(--line-2);
  border-top-color: var(--accent);
  animation: pf-spin 0.8s linear infinite;
}
.spinner {
  width: 26px;
  height: 26px;
  border-width: 3px;
}
@keyframes pf-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 骨架屏：统一一道斜向扫光 */
.skeleton,
.sk {
  position: relative;
  overflow: hidden;
  background: var(--skeleton);
  border-radius: var(--r-sm);
}
.skeleton::after,
.sk::after {
  content: '';
  position: absolute;
  inset: 0;
  background: var(--skeleton-glow);
  animation: pf-shimmer 1.5s var(--ease) infinite;
}
@keyframes pf-shimmer {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(100%);
  }
}

/* 空状态：图标 + 标题 + 说明 + 动作，四处统一 */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-10) var(--sp-5);
  text-align: center;
  color: var(--text-dim);
}
.empty-ico {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  margin-bottom: var(--sp-1);
  border-radius: 50%;
  background: var(--panel-3);
  /* 品牌化：一圈强调色细边 + 内侧柔光，与侧栏 logo 呼应，空态不再「灰沉」 */
  border: 1px solid var(--accent-line);
  box-shadow: inset 0 0 0 3px var(--accent-soft);
  font-size: 22px;
  line-height: 1;
  opacity: 0.9;
}
.empty-title {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text);
}
.empty-sub {
  max-width: 46ch;
  font-size: var(--fs-xs);
  line-height: 1.65;
  color: var(--text-faint);
}
.empty .btn {
  margin-top: var(--sp-2);
}
.empty-hint {
  padding: var(--sp-5) 0;
  text-align: center;
  font-size: var(--fs-xs);
  color: var(--text-faint);
}

/*
 * 恒暗区（P34）：视频舞台在亮色皮肤下依然是黑的，里面的文字、边框若继续吃
 * 亮色 token 就会变成「深灰压黑底」——实测播放页的占位文字与卡顿提示都读不清。
 * 这里把颜色 token 就地还原成暗色一套，子元素无需逐个适配；
 * 以后新增颜色 token 记得同步这个块。
 */
:root[data-theme='light'] .force-dark {
  color-scheme: dark;
  --text: #e2e7f0;
  --text-dim: #9aa5b8;
  --text-faint: #7b879b;
  --line: #1e2534;
  --line-2: #2a3346;
  --line-hover: #36415a;
  --panel: #121722;
  --panel-2: #0d1119;
  --panel-3: #1a2130;
  --panel-hover: #151b27;
  --accent: #4c7dff;
  --accent-hi: #6b93ff;
  --accent-ink: #b9cbff;
  --ok: #3ecf8e;
  --warn: #e8c05a;
  --danger: #ff8290;
  --info: #58a6ff;
}

/* 轻提示：全局唯一定义，各视图不再自带一份 */
.toast {
  position: fixed;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%);
  z-index: var(--z-toast);
  max-width: min(560px, calc(100vw - 48px));
  padding: 9px 16px;
  border-radius: var(--r-pill);
  background: var(--toast-bg);
  border: 1px solid var(--line-2);
  box-shadow: var(--shadow-2);
  backdrop-filter: blur(10px);
  color: var(--text);
  font-size: var(--fs-xs);
  line-height: 1.5;
  text-align: center;
  pointer-events: none;
}
.pf-toast-enter-active,
.pf-toast-leave-active {
  transition: opacity var(--t-base) var(--ease), transform var(--t-base) var(--ease);
}
.pf-toast-enter-from,
.pf-toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 8px);
}

/* 弹层：遮罩 + 面板，Discover 的收藏弹层与详情弹层共用 */
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: var(--z-mask);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-5);
  background: var(--mask);
  backdrop-filter: blur(3px);
  animation: pf-fade var(--t-base) var(--ease);
}
.modal {
  position: relative;
  max-height: 84vh;
  padding: var(--sp-5);
  border: 1px solid var(--line-2);
  border-radius: var(--r-xl);
  background: var(--modal-bg);
  box-shadow: var(--shadow-3);
  animation: pf-pop var(--t-slow) var(--ease);
}
@keyframes pf-fade {
  from {
    opacity: 0;
  }
}
@keyframes pf-pop {
  from {
    opacity: 0;
    transform: translateY(10px) scale(0.985);
  }
}

/* ---- ⑤ 工具类 ------------------------------------------------------- */
.ok {
  color: var(--ok);
}
.dim,
.muted {
  color: var(--text-dim);
}
.small {
  font-size: var(--fs-xs);
}
.mono {
  font-family: 'Cascadia Code', 'Cascadia Mono', Consolas, monospace;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
.center {
  text-align: center;
}
.pad {
  padding: var(--sp-6) 0;
}
.flex-sp {
  flex: 1;
}
/* 可点击容器（卡片/行）统一键盘可达的焦点样式 */
.is-clickable {
  cursor: pointer;
}
.is-clickable:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* ---- 响应式：窄窗口收紧留白，字号不缩小（字号缩小反而更难读） ---- */
@media (max-width: 900px) {
  :root {
    --pf-card-min: 152px;
  }
}
@media (max-width: 640px) {
  .page-head {
    align-items: flex-start;
  }
  .modal {
    padding: var(--sp-4);
    border-radius: var(--r-lg);
  }
  .modal-mask {
    padding: var(--sp-3);
  }
}

/* 尊重系统「减少动态效果」：只留必要的状态反馈 */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
  .spin,
  .spinner {
    border-top-color: var(--accent);
  }
}
</style>

<style scoped>
.app {
  height: 100vh;
  display: flex;
  overflow: hidden;
  background: var(--bg);
}
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-faint);
  flex: none;
  transition: background var(--t-base) var(--ease), box-shadow var(--t-base) var(--ease);
}
/* 全应用唯一的纵向滚动容器：任何视图内部都不再各自开滚动条 */
.content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* 有无滚动条时都不抖宽度（切页不再横向跳动） */
  scrollbar-gutter: stable;
  overscroll-behavior: contain;
  padding: var(--sp-4) var(--sp-5) var(--sp-5);
}

/* 窄屏 / 移动端：收紧留白，给按钮和内容更多横向空间 */
@media (max-width: 1000px) {
  .content {
    padding: var(--sp-3) var(--sp-3) var(--sp-5);
  }
}
@media (max-width: 640px) {
  .content {
    padding: var(--sp-3) 10px var(--sp-6);
  }
}
</style>
