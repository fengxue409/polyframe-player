<script setup lang="ts">
import { usePlayerStore } from '../stores/player'
import { useThemeStore } from '../stores/theme'
import { useUpdateStore } from '../stores/update'
import type { AppRoute } from '../stores/player'
import brandMark from '../assets/icon.png'

const store = usePlayerStore()
const theme = useThemeStore()
const upd = useUpdateStore()
upd.init()

interface NavItem {
  route: AppRoute
  label: string
  icon: string
}
/**
 * 导航三大块：「浏览（看片）→ 工具（搞片源）→ 管理（系统）」。
 * P52 重排：历史/媒体库归入浏览，任务归入工具，设置/配色归入底部常驻的「管理」块。
 */
const groups: { title: string; items: NavItem[] }[] = [
  {
    title: '浏览',
    items: [
      { route: 'home', label: '首页', icon: 'M3 10.6 12 3.4l9 7.2M5.4 9.4V20h4.7v-5.6h3.8V20h4.7V9.4' },
      { route: 'player', label: '播放', icon: 'M8.4 5.2v13.6L19 12 8.4 5.2z' },
      { route: 'history', label: '历史', icon: 'M12 3.6a8.4 8.4 0 1 1-8.1 10.6M12 7.4V12l3.2 1.9M3.6 5.2v4.2h4.2' },
      { route: 'library', label: '媒体库', icon: 'M4 5h6.4v5.6H4V5zm9.6 0H20v5.6h-6.4V5zM4 13.4h6.4V19H4v-5.6zm9.6 0H20V19h-6.4v-5.6z' }
    ]
  },
  {
    title: '工具',
    items: [
      { route: 'tasks', label: '任务', icon: 'M4.6 6.6h14.8M4.6 12h14.8M4.6 17.4h9.4' },
      {
        route: 'parse',
        label: '解析',
        icon: 'M10.4 13.6a3.5 3.5 0 0 0 4.9 0l3-3a3.5 3.5 0 0 0-4.9-4.9l-1 1M13.6 10.4a3.5 3.5 0 0 0-4.9 0l-3 3a3.5 3.5 0 0 0 4.9 4.9l1-1'
      },
      { route: 'netdisk', label: '网盘', icon: 'M7 18h10a3.4 3.4 0 0 0 .4-6.8 5 5 0 0 0-9.6-1.2A3.9 3.9 0 0 0 7 18z' },
      { route: 'magnet', label: '磁力', icon: 'M7 4v7a5 5 0 0 0 10 0V4h-2.6v7a2.4 2.4 0 0 1-4.8 0V4H7zM5 20h14' }
    ]
  }
]
</script>

<template>
  <nav class="nav" aria-label="主导航">
    <div class="brand">
      <!-- 品牌统一（P53）：直接用与 exe/安装包同源的 icon.png，替换旧的蓝紫渐变内嵌 SVG -->
      <img class="brand-mark" :src="brandMark" alt="PolyFrame Player" />
      <span class="brand-text">
        <b>PolyFrame</b>
        <i>Player</i>
      </span>
    </div>

    <div class="nav-scroll">
      <template v-for="g in groups" :key="g.title">
        <p class="group-label">{{ g.title }}</p>
        <button
          v-for="it in g.items"
          :key="it.route"
          class="nav-item"
          :class="{ active: store.route === it.route }"
          :title="it.label"
          :aria-current="store.route === it.route ? 'page' : undefined"
          @click="store.go(it.route)"
        >
          <span class="nav-bar" aria-hidden="true"></span>
          <svg
            viewBox="0 0 24 24"
            width="17"
            height="17"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path :d="it.icon" />
          </svg>
          <span class="nav-label">{{ it.label }}</span>
        </button>
      </template>
    </div>

    <div class="nav-foot">
      <!-- P52：管理块（配色 + 设置）常驻底部，与浏览/工具同款式，不随导航滚动 -->
      <p class="group-label">管理</p>
      <!-- 主题切换落在管理块：图标显示「当前」主题，点击切到另一套 -->
      <button
        class="nav-item"
        type="button"
        :title="theme.isDark ? '切换到亮色皮肤' : '切换到暗色皮肤'"
        :aria-label="theme.isDark ? '切换到亮色皮肤' : '切换到暗色皮肤'"
        @click="theme.toggle()"
      >
        <svg
          v-if="theme.isDark"
          viewBox="0 0 24 24"
          width="17"
          height="17"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M20.4 14.9A8 8 0 0 1 9.1 3.6a8 8 0 1 0 11.3 11.3Z" />
        </svg>
        <svg
          v-else
          viewBox="0 0 24 24"
          width="17"
          height="17"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2.4v2.2M12 19.4v2.2M2.4 12h2.2M19.4 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6" />
        </svg>
        <span class="nav-label">{{ theme.isDark ? '暗色' : '亮色' }}</span>
      </button>
      <button
        class="nav-item"
        :class="{ active: store.route === 'settings' }"
        title="设置"
        @click="store.go('settings')"
      >
        <span class="nav-bar" aria-hidden="true"></span>
        <!-- 设置用「滑块」而不是齿轮：图标轨里齿轮和主题月亮/太阳都太碎，分不清 -->
        <svg
          viewBox="0 0 24 24"
          width="17"
          height="17"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M4 7h6M15 7h5M4 12h2.5M11.5 12h8.5M4 17h9M18 17h2" />
          <circle cx="12.5" cy="7" r="2.2" />
          <circle cx="9" cy="12" r="2.2" />
          <circle cx="15.5" cy="17" r="2.2" />
        </svg>
        <span class="nav-label">设置</span>
        <!-- P50：有新版待处理时，设置入口挂一颗小圆点 -->
        <i v-if="upd.available" class="upd-dot" aria-label="有可用更新"></i>
      </button>
      <!-- 内核状态：P42 顶栏撤掉后，这里是唯一的状态位 -->
      <div class="nav-status" :class="{ ok: store.online }" :title="store.statusText">
        <span class="dot" aria-hidden="true"></span>
        <span class="nav-live">{{ store.online ? '内核在线' : '内核离线' }}</span>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.nav {
  width: 208px;
  flex: none;
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: var(--sp-3) 10px var(--sp-2);
  border-right: 1px solid var(--line);
  background: var(--bg-nav);
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 2px 10px 14px;
  flex: none;
}
.brand-mark {
  width: 26px;
  height: 26px;
  flex: none;
  border-radius: 7px;
  /* logo 本体已是红色胶片盘，投影改用中性暗色，不再跟随蓝紫强调色 */
  box-shadow: 0 4px 14px -4px rgba(0, 0, 0, 0.4);
}
.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.15;
  min-width: 0;
}
.brand-text b {
  font-size: 13.5px;
  font-weight: 650;
  letter-spacing: 0.2px;
  color: var(--text);
}
.brand-text i {
  font-size: 10px;
  font-style: normal;
  letter-spacing: 1.6px;
  text-transform: uppercase;
  color: var(--text-faint);
}
.nav-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: none;
}
.nav-scroll::-webkit-scrollbar {
  width: 0;
}
.group-label {
  padding: 0 10px;
  /* P52：大模块之间拉开间距，块与块的「呼吸感」靠这里 */
  margin: 16px 0 5px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 1.2px;
  color: var(--text-faint);
  opacity: 0.75;
}
.group-label:first-child {
  margin-top: 2px;
}
/* 导航项：左侧 2px 强调条 + 半透明底表达选中，不做整块高亮（避免抢内容区）。
   P52b：缩进收敛到 3px —— 只留一点对齐错位感，不再让左侧空出一大截。
   P52c：必须显式声明 justify-content —— 全局 button 规则带 center，
   不钉死的话图标+文字会在行内「居中漂浮」，与贴左的分组标题错位 */
.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 10px;
  width: calc(100% - 3px);
  margin-left: 3px;
  min-height: 34px;
  padding: 0 10px;
  margin-bottom: 1px;
  border: none;
  border-radius: var(--r-md);
  background: transparent;
  color: var(--text-dim);
  font-size: 13px;
  font-weight: 400;
  text-align: left;
  box-shadow: none;
}
.nav-item:hover:not(:disabled) {
  background: color-mix(in srgb, var(--text) 6%, transparent);
  border: none;
  color: var(--text);
  transform: none;
}
.nav-item:active:not(:disabled) {
  transform: none;
}
.nav-item.active {
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-weight: 600;
}
.nav-bar {
  position: absolute;
  left: 0;
  top: 50%;
  width: 2px;
  height: 0;
  border-radius: 2px;
  background: var(--accent);
  transform: translateY(-50%);
  transition: height var(--t-base) var(--ease);
}
.nav-item.active .nav-bar {
  height: 16px;
}
.nav-item svg {
  flex: none;
  opacity: 0.9;
}
.nav-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nav-foot {
  flex: none;
  padding-top: 4px;
  border-top: 1px solid var(--line);
  margin-top: 8px;
}
/* 管理块里的主题/设置按钮：与滚动区同款缩进，同样钉死左对齐 */
.nav-foot .nav-item {
  width: calc(100% - 3px);
  margin-left: 3px;
  justify-content: flex-start;
}
.nav-foot .group-label {
  margin-top: 2px;
}
.nav-status {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px 0;
  font-size: 11px;
  color: var(--text-faint);
}
/* P50：更新红点 —— 图标轨模式下也能看见 */
.upd-dot {
  position: absolute;
  top: 7px;
  right: 8px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--danger);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--danger) 22%, transparent);
  pointer-events: none;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-faint);
  flex: none;
}
.nav-status.ok {
  color: var(--text-dim);
}
.nav-status.ok .dot {
  background: var(--ok);
  box-shadow: 0 0 0 3px var(--ok-bg);
}

/* 窄窗口：收成图标轨，把 144px 横向空间还给内容 */
@media (max-width: 1000px) {
  .nav {
    width: 68px;
    padding: var(--sp-3) 8px var(--sp-2);
    align-items: center;
  }
  .brand {
    padding: 2px 0 12px;
    justify-content: center;
  }
  .brand-text {
    display: none;
  }
  .nav-scroll {
    width: 100%;
  }
  .group-label {
    /* 图标轨下分组标题改为一条短分隔线，仍保留节奏感 */
    height: 1px;
    margin: 8px 6px;
    padding: 0;
    overflow: hidden;
    color: transparent;
    background: var(--line);
    font-size: 0;
  }
  .nav-item {
    justify-content: center;
    gap: 0;
    /* 图标轨下取消缩进：居中展示 */
    width: 100%;
    margin-left: 0;
    min-height: 40px;
    padding: 0;
  }
  .nav-foot .nav-item {
    width: 100%;
    margin-left: 0;
  }
  .nav-label {
    display: none;
  }
  .nav-bar {
    left: -2px;
  }
  .nav-foot {
    width: 100%;
  }
  .nav-status {
    justify-content: center;
    padding: 8px 0 0;
  }
  .nav-live {
    display: none;
  }
}
@media (max-width: 640px) {
  .nav {
    width: 58px;
    padding: 10px 6px;
  }
  .nav-item {
    min-height: 38px;
  }
}
</style>
