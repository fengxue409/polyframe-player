<script setup lang="ts">
/**
 * 弹幕渲染层：Canvas 覆盖在视频区上方。
 *
 * 内核差异（这是本组件最容易被误解的地方）：
 *  - **hls 内核**：video 元素在 renderer 里，Canvas 叠在上面即可；
 *  - **libmpv 内核**：视频是 Rust 创建的 Win32 子窗口（`WS_CHILD`），
 *    恒定绘制在父窗口客户区之上，**会盖住 renderer 的任何 DOM/Canvas**。
 *    因此 mpv 模式下本层主动隐藏，弹幕改由 `danmaku.ass` 生成 ASS 文件
 *    交给 mpv 用 libass 渲染 —— 详见 PlayerView 里的 attach 逻辑。
 *
 * 这一条不是"性能取舍"，是 Win32 窗口模型的硬约束。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { DanmakuItem } from '@polyframe/shared'
import { useDanmakuStore } from '../stores/danmaku'
import { usePlayerStore } from '../stores/player'
import { DanmakuEngine } from '../danmaku/engine'
import { selfTest as trackSelfTest } from '../danmaku/track'
import { MediaElementClock, MpvInterpolatedClock, type DanmakuClock } from '../danmaku/clock'
import {
  overlayAvailable,
  overlayEnabled,
  overlayEnsure,
  overlayHide,
  overlayPush,
  overlayReset,
  overlaySeek,
  overlaySetDuration,
  overlaySetItems,
  overlaySetOpts,
  overlayShow,
  overlayOnReady
} from '../danmaku/overlay'

const props = defineProps<{
  /** hls 内核下的 video 元素（mpv 模式不需要） */
  video?: HTMLVideoElement | null
  /** 当前 media 时长（秒） */
  duration?: number
}>()

const dm = useDanmakuStore()
const player = usePlayerStore()

const canvasEl = ref<HTMLCanvasElement | null>(null)
const rootEl = ref<HTMLDivElement | null>(null)

let engine: DanmakuEngine | null = null
let mediaClock: MediaElementClock | null = null
let mpvClock: MpvInterpolatedClock | null = null
let clock: DanmakuClock | null = null
/** P17：覆盖层就绪回调的取消订阅 */
let overlayUnsubReady: (() => void) | null = null

/** mpv 模式下 DOM 层必然被视频子窗口遮住 → 不渲染，省 CPU */
const domVisible = computed(
  () => player.engine === 'hls' && dm.settings.enabled && !!(canvasEl.value ?? rootEl.value)
)

/**
 * P17：高级特效覆盖层（libmpv 专用）。
 * mpv 模式 + fxOverlay 开启时，弹幕改由透明覆盖层窗口渲染 ——
 * 主窗口 DOM 层依旧隐藏，本地引擎只作数据中转。
 */
const overlayOn = computed(
  () => overlayAvailable() && player.engine === 'mpv' && dm.settings.enabled && dm.settings.fxOverlay
)

/** 全量推送覆盖层状态（幂等；覆盖层刚就绪 / 任何数据变更后都走这里） */
function syncOverlay(): void {
  if (!overlayOn.value) return
  overlayEnsure()
  overlaySetOpts({
    opacity: dm.settings.opacity,
    fontScale: dm.settings.fontScale,
    speed: dm.settings.speed,
    density: dm.settings.density,
    blockScroll: dm.settings.blockScroll,
    blockTop: dm.settings.blockTop,
    blockBottom: dm.settings.blockBottom
  })
  overlaySetDuration(props.duration ?? null)
  overlaySetItems(dm.getItems(), dm.channelDuration)
  overlayEnabled(true)
  overlayShow()
}

// ---- P15：候选匹配面板 ----
const showPicker = ref(false)
const pickerLoading = ref(false)
/** 面板里的搜索词：默认取片名，但**必须可改** */
const pickerQuery = ref('')
const pickerHint = ref('')

async function openPicker(): Promise<void> {
  showPicker.value = true
  pickerQuery.value = dm.title
  pickerHint.value = ''
  // 已经有候选（比如上次搜过）就直接展示，不重复打接口
  if (dm.candidates.length === 0) await runPickerSearch()
}

/**
 * 按面板里的关键词重新搜索。
 *
 * 「手动指定」的价值全在这个输入框上：自动匹配失败最常见的原因就是片名不对
 * （带「【字幕组】」前缀、带了季数后缀、用的是别名），不能改词就等于没法救。
 */
async function runPickerSearch(): Promise<void> {
  pickerLoading.value = true
  pickerHint.value = ''
  try {
    await dm.searchCandidates(pickerQuery.value.trim() || undefined)
    if (dm.candidates.length === 0) {
      pickerHint.value = dm.error || '没有搜到条目，试试番剧原名'
    }
  } finally {
    pickerLoading.value = false
  }
}

async function pickCandidate(episodeId: number): Promise<void> {
  showPicker.value = false
  await dm.switchEpisode(episodeId)
}

/** 放弃第三方源，只用本地 / 导入的弹幕 */
async function useLocalOnly(): Promise<void> {
  showPicker.value = false
  await dm.saveSettings({ provider: 'local' })
  await dm.reloadList()
  dm.sendFeedback = '已切换为「仅本地弹幕」'
}

function teardownEngine(): void {
  engine?.destroy()
  engine = null
  clock = null
  mediaClock = null
  mpvClock = null
}

/** 建引擎；返回实例（供调用方直接 start），失败返回 null */
function buildEngine(): DanmakuEngine | null {
  const el = canvasEl.value
  if (!el) return null
  teardownEngine()

  if (player.engine === 'mpv') {
    mpvClock = new MpvInterpolatedClock()
    if (player.mpvState) {
      mpvClock.update({
        timePos: player.mpvState.timePos,
        duration: player.mpvState.duration,
        pause: player.mpvState.pause,
        eof: player.mpvState.eof
      })
    }
    clock = mpvClock
  } else {
    const v = props.video
    if (!v) return null
    mediaClock = new MediaElementClock(v)
    clock = mediaClock
  }

  engine = new DanmakuEngine(el, clock)
  engine.setOptions({
    opacity: dm.settings.opacity,
    fontScale: dm.settings.fontScale,
    speed: dm.settings.speed,
    density: dm.settings.density,
    blockScroll: dm.settings.blockScroll,
    blockTop: dm.settings.blockTop,
    blockBottom: dm.settings.blockBottom
  })
  if (props.duration) engine.setDuration(props.duration)
  if (dm.itemCount > 0) engine.setItems(dm.getItems(), dm.channelDuration)
  if (domVisible.value) engine.start()
  // 构造时父容器可能还没完成布局（rect = 0）→ 下一帧补一次尺寸同步。
  // 不做这一步的话画布会停在 1×1，而 CSS 尺寸随后没变化、ResizeObserver
  // 也就不再回调，表现为「层已挂载但一个像素都不显示」。
  syncSize(engine)

  // 暴露调试句柄（E2E / 控制台诊断用）
  ;(window as unknown as Record<string, unknown>).__pfDanmaku = {
    engine,
    /** 弹幕 store（测试用：验证「设置变更 → 引擎」这条真实链路） */
    store: dm,
    stats: () => engine?.stats(),
    inject: (items: DanmakuItem[], at: number, renderAt?: number) =>
      engine?.debugInject(items, at, renderAt),
    resize: () => engine?.resize(true),
    /** 同步推进 N 帧（无头 / 窗口被遮挡时 rAF 不投递，靠这个确定性出帧） */
    step: (n = 1) => engine?.step(n),
    clockDebug: () => (mpvClock ? mpvClock.debug() : { mode: 'media' }),
    /** 轨道分配算法自检（E2E 断言用；不依赖测试框架） */
    selfTest: trackSelfTest
  }
  return engine
}

/** 先同步量一次（getBoundingClientRect 会强制布局，不依赖帧），再补下一帧重试 */
function syncSize(target: DanmakuEngine): void {
  target.resize()
  requestAnimationFrame(() => {
    if (engine !== target) return
    target.resize()
    requestAnimationFrame(() => {
      if (engine === target) target.resize()
    })
  })
}

onMounted(() => {
  const eng = buildEngine()
  // 挂载当拍父容器可能还没拿到尺寸，微任务里再量一次（不依赖帧）
  if (eng) void nextTick(() => engine === eng && eng.resize())
  // P17：覆盖层加载完成 → 重发全量状态（首次 ensure 后覆盖层是空数据）
  overlayUnsubReady = overlayOnReady(() => syncOverlay())
  if (overlayOn.value) {
    syncOverlay()
    // 竞态兜底：覆盖层窗口可能晚于本组件挂载完成，它的 ready 通知会错过订阅。
    // 全量推送是幂等的，1.5s 后补一发即可对齐（代价可忽略）。
    window.setTimeout(() => {
      if (overlayOn.value) syncOverlay()
    }, 1500)
  }
})

onBeforeUnmount(() => {
  teardownEngine()
  overlayUnsubReady?.()
  overlayUnsubReady = null
  if (overlayOn.value) {
    overlayEnabled(false)
    overlayHide()
  }
  delete (window as unknown as Record<string, unknown>).__pfDanmaku
})

// 内核切换 → 时钟类型变了，必须重建引擎
watch(
  () => player.engine,
  () => {
    const eng = buildEngine()
    if (eng && dm.settings.enabled) eng.start()
  }
)

// P17：覆盖层开关（engine / fxOverlay / enabled 任一变化都会走到这）
watch(overlayOn, (on) => {
  if (on) syncOverlay()
  else {
    overlayEnabled(false)
    overlayHide()
  }
})

/**
 * 切页：覆盖层是 owner 挂主窗口的独立顶层窗口，同样不吃 DOM 的 display:none。
 * 离开播放页必须一起收起，否则弹幕会继续飞在媒体库/设置页上面；
 * 回来时全量重推一次（syncOverlay 幂等，顺带 show）。
 */
watch(
  () => player.route,
  (r) => {
    if (!overlayOn.value) return
    if (r === 'player') syncOverlay()
    else {
      overlayEnabled(false)
      overlayHide()
    }
  }
)

// 全局开关
watch(
  () => dm.settings.enabled,
  (on) => {
    if (!engine) {
      if (on) buildEngine()?.start()
      return
    }
    if (on) engine.start()
    else engine.stop()
  }
)

// 未在播放时不跑渲染循环（省电，也避免静止画面被逐帧重绘）
watch(
  () => player.playing,
  (playing) => {
    if (!engine) return
    if (playing && dm.settings.enabled && player.engine === 'hls') engine.start()
    else engine.stop()
  }
)

// 设置变化（字号会影响轨道数，引擎内部会自行 resize）
watch(
  () => dm.settings,
  (s) => {
    const opts = {
      opacity: s.opacity,
      fontScale: s.fontScale,
      speed: s.speed,
      density: s.density,
      blockScroll: s.blockScroll,
      blockTop: s.blockTop,
      blockBottom: s.blockBottom
    }
    engine?.setOptions(opts)
    if (overlayOn.value) overlaySetOpts(opts)
  },
  { deep: true }
)

// 弹幕数据变更（拉取完成 / 换集）
watch(
  () => dm.itemsVersion,
  () => {
    // 子组件 mounted 早于父组件的模板 ref 赋值，可能还没引擎；这里补建
    if (!engine) buildEngine()
    const eng = engine
    if (!eng) return
    eng.setDuration(props.duration ?? null)
    eng.setItems(dm.getItems(), dm.channelDuration)
    if (dm.settings.enabled && dm.itemCount > 0) eng.start()
    if (overlayOn.value) overlaySetItems(dm.getItems(), dm.channelDuration)
  }
)

// 父组件的 video 元素晚到（首帧 ref 尚未赋值）时补建引擎
watch(
  () => props.video,
  (v) => {
    if (v && !engine) {
      const eng = buildEngine()
      if (eng && dm.settings.enabled) eng.start()
    }
  }
)

// 从隐藏变可见：display:none 期间 rect 恒为 0，恢复可见后必须重新量一次
watch(domVisible, async (vis) => {
  if (!vis) return
  const eng = engine ?? buildEngine()
  if (!eng) return
  await nextTick()
  syncSize(eng)
})

// 片长就绪/变化 → 重算时间轴缩放
watch(
  () => props.duration,
  (d) => {
    engine?.setDuration(d ?? null)
    if (overlayOn.value) overlaySetDuration(d ?? null)
  }
)

// mpv 状态推送 → 事件锚点 + 墙钟插值
watch(
  () => player.mpvState,
  (s) => {
    if (!s) return
    mpvClock?.update({ timePos: s.timePos, duration: s.duration, pause: s.pause, eof: s.eof })
  },
  { deep: false }
)

/** 本地发送的弹幕即时上屏（不走整体重建，避免闪屏） */
function push(item: DanmakuItem): void {
  if (!engine) buildEngine()
  engine?.send(item)
  if (overlayOn.value) overlayPush(item)
}

/** seek / 换源后通知引擎时间轴跳变 */
function seek(seconds: number): void {
  if (player.engine === 'mpv') mpvClock?.seekTo(seconds)
  engine?.seek(seconds)
  if (overlayOn.value) overlaySeek(seconds)
}

/** 换片：清空时钟与在屏状态 */
function reset(): void {
  mpvClock?.reset()
  engine?.seek(0)
  if (overlayOn.value) overlayReset()
}

defineExpose({
  push,
  seek,
  reset,
  stats: () => engine?.stats(),
  /** 供播放页的「弹幕源」按钮直接打开候选面板（不必等自动匹配失败） */
  openPicker
})
</script>

<template>
  <!--
    pointer-events:none：绝不阻挡 video 原生控制条与自定义控件。
    P31：视频画面上只画弹幕本身 —— 加载中 / 暂无弹幕 / 未配置凭据 / 未匹配
    这类「配置与状态提示」全部交给播放页的视频下方状态行（PlayerView 的
    .dm-status）。画面里挂角标会一直压在片头字幕上，看着像 bug 而不像提示。
    候选匹配面板仍是用户主动打开的浮层，留在原处。
  -->
  <div ref="rootEl" class="danmaku-layer" :class="{ hidden: !domVisible }">
    <canvas ref="canvasEl" class="danmaku-canvas"></canvas>

    <!-- P15：候选匹配面板（no_match 时手动指定弹幕库剧集） -->
    <div v-if="showPicker" class="dm-picker">
      <div class="dm-picker-head">
        <span>选择弹幕库剧集</span>
        <button class="dm-picker-close" title="关闭" @click="showPicker = false">×</button>
      </div>
      <div class="dm-picker-search">
        <input
          v-model="pickerQuery"
          class="dm-picker-input"
          spellcheck="false"
          placeholder="番剧名 / 关键词"
          @keyup.enter="runPickerSearch"
        />
        <button class="dm-picker-go" :disabled="pickerLoading" @click="runPickerSearch">搜</button>
      </div>
      <div v-if="pickerLoading" class="dm-picker-empty">搜索中…</div>
      <div v-else-if="dm.candidates.length === 0" class="dm-picker-empty">
        {{ pickerHint || '没有找到候选（检查弹弹play 凭据或换个关键词）' }}
      </div>
      <div v-else class="dm-picker-list">
        <button
          v-for="c in dm.candidates"
          :key="c.episodeId"
          class="dm-picker-item"
          @click="pickCandidate(c.episodeId)"
        >
          <span class="an">{{ c.animeTitle }}</span>
          <span class="ep">{{ c.episodeTitle }}</span>
        </button>
      </div>
      <div class="dm-picker-foot">
        <button class="dm-picker-local" title="不连弹弹play，只显示已缓存与导入的弹幕" @click="useLocalOnly">
          仅本地弹幕
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.danmaku-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
  z-index: 2;
}
/* mpv 模式下子窗口必然盖住这一层，直接不绘制 */
.danmaku-layer.hidden {
  display: none;
}
.danmaku-canvas {
  width: 100%;
  height: 100%;
  display: block;
}
/* ---- P15：候选匹配面板 ---- */
.dm-picker {
  position: absolute;
  left: 10px;
  top: 10px;
  width: min(360px, 80%);
  max-height: 60%;
  display: flex;
  flex-direction: column;
  background: rgba(11, 14, 20, 0.92);
  backdrop-filter: blur(8px);
  border: 1px solid #263049;
  border-radius: 10px;
  pointer-events: auto;
  z-index: 3;
}
.dm-picker-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  font-size: 12px;
  color: #c8d2e4;
  border-bottom: 1px solid #1c2536;
}
.dm-picker-close {
  background: none;
  border: none;
  color: #8f9cb4;
  font-size: 16px;
  cursor: pointer;
  padding: 0 4px;
}
.dm-picker-close:hover {
  color: #fff;
}
.dm-picker-empty {
  padding: 14px 12px;
  font-size: 12px;
  color: #8f9cb4;
}
.dm-picker-search {
  display: flex;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid #1c2536;
}
.dm-picker-input {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  font-size: 12px;
  border-radius: 6px;
  border: 1px solid #263049;
  background: rgba(6, 9, 14, 0.9);
  color: #d7dce6;
}
.dm-picker-input:focus {
  outline: none;
  border-color: var(--accent);
}
.dm-picker-go {
  flex: none;
  padding: 5px 10px;
  font-size: 12px;
  border-radius: 6px;
  border: 1px solid #263049;
  background: rgba(61, 106, 224, 0.18);
  color: #c8d2e4;
  cursor: pointer;
}
.dm-picker-go:disabled {
  opacity: 0.5;
  cursor: default;
}
.dm-picker-foot {
  padding: 6px 10px;
  border-top: 1px solid #1c2536;
}
.dm-picker-local {
  background: none;
  border: none;
  padding: 2px 0;
  font-size: 11.5px;
  color: #7aa7ff;
  cursor: pointer;
  text-decoration: underline;
}
.dm-picker-list {
  overflow-y: auto;
  padding: 4px;
}
.dm-picker-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  padding: 7px 9px;
  background: none;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
}
.dm-picker-item:hover {
  background: rgba(122, 167, 255, 0.12);
}
.dm-picker-item .an {
  font-size: 12px;
  color: #dfe6f2;
}
.dm-picker-item .ep {
  font-size: 11px;
  color: #8f9cb4;
}
</style>
