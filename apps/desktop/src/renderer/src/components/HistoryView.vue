<script setup lang="ts">
/**
 * P26 播放历史 / P33 卡片式改版
 *
 * 一屏「最近看过什么 + 看到哪」，点卡片即续播：
 * 有剧集快照的直接重建队列（不重新回源），没有的按记录 URL 重新起播。
 *
 * 视觉上是「时间线 + 卡片墙」：按天分组（今天 / 昨天 / 具体日期），
 * 每组一行卡片。缩略图按 16:9 而非海报的 2:3 —— 历史是视频语义（进度、集数、
 * 时刻），横版才能在同样高度里多放两排，也更接近"播放器"而非"片库"。
 */
import { computed, onMounted, ref } from 'vue'
import type { PlayHistoryItem } from '@polyframe/shared'
import { useCatalogStore } from '../stores/catalog'
import { historyDone, historyPct, useHistoryStore } from '../stores/history'
import { usePlayerStore } from '../stores/player'

const history = useHistoryStore()
const catalog = useCatalogStore()
const store = usePlayerStore()
const busyKey = ref('')

/** 续播最长等待：建任务卡住时按钮不能永远停在「起播中…」 */
const RESUME_TIMEOUT_MS = 20_000
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${label}超时（${Math.round(ms / 1000)}s 无响应）`)), ms)
    p.then(
      (v) => {
        window.clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        window.clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    )
  })
}

const countLabel = computed(() => (history.total ? `共 ${history.total} 部` : '暂无记录'))

/** 秒 → `12:34` / `1:02:03` */
function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const x = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(x)}` : `${m}:${pad(x)}`
}

/** 只用时分：日期已经由分组标题给出，卡片里再写「今天」是重复信息 */
function hhmm(ts: number): string {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

function dayLabel(ts: number): string {
  if (!ts) return '更早'
  const d = new Date(ts)
  const today = new Date()
  if (sameDay(d, today)) return '今天'
  if (sameDay(d, new Date(today.getTime() - 86_400_000))) return '昨天'
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

interface DayGroup {
  label: string
  items: PlayHistoryItem[]
}

/**
 * 按天分组。items 已按 playedAt 倒序，Map 保持插入顺序，因此组序天然正确；
 * 「加载更多」只会追加更早的记录，已有分组不会被打乱。
 */
const groups = computed<DayGroup[]>(() => {
  const map = new Map<string, PlayHistoryItem[]>()
  for (const it of history.items) {
    const k = dayLabel(it.playedAt)
    const arr = map.get(k)
    if (arr) arr.push(it)
    else map.set(k, [it])
  }
  return [...map.entries()].map(([label, items]) => ({ label, items }))
})

/** 无海报占位：色相由标题哈希决定，一卡一色（与媒体库下载卡同一手法） */
function hueOf(title: string): number {
  let h = 0
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) % 360
  return h
}
function hueStyle(title: string): Record<string, string> {
  return { '--h': String(hueOf(title)) }
}
function initialsOf(title: string): string {
  const t = (title || '').trim()
  if (!t) return '?'
  const head = t.slice(0, 2)
  return /^[\x20-\x7e]+$/.test(head) ? head.toUpperCase() : head
}

/** 进度文案：已看完只报总时长（状态已由标题行的「看完」徽章表达，不重复） */
function progressText(it: PlayHistoryItem): string {
  if (!it.durationSec) return '未记录计时'
  if (historyDone(it)) return `共 ${clock(it.durationSec)}`
  return `${clock(it.positionSec)} / ${clock(it.durationSec)}`
}

async function resume(it: PlayHistoryItem): Promise<void> {
  if (busyKey.value) return
  busyKey.value = it.key
  history.error = ''
  try {
    await withTimeout(history.resume(it), RESUME_TIMEOUT_MS, '续播')
  } catch (e) {
    history.error = `${it.title}：${(e as Error).message}`
  } finally {
    busyKey.value = ''
  }
}

async function onRemove(it: PlayHistoryItem): Promise<void> {
  await history.remove(it.key)
}

async function onClear(): Promise<void> {
  if (!history.items.length) return
  if (!window.confirm(`清空全部播放历史？\n共 ${history.total} 条记录，收藏与下载内容不受影响。`)) return
  await history.clearAll()
}

onMounted(() => {
  void history.refresh()
})
</script>

<template>
  <div class="history-view">
    <div class="page-head">
      <div class="page-head-text">
        <h2>最近观看</h2>
        <p>{{ countLabel }} · 同一影片只保留最近观看的一集，点卡片从上次的位置继续</p>
      </div>
      <div class="btn-group tight">
        <button class="btn ghost sm" :disabled="history.loading" @click="history.refresh()">刷新</button>
        <button class="btn danger sm" :disabled="!history.items.length" @click="onClear">清空历史</button>
      </div>
    </div>

    <div v-if="history.error" class="alert alert-row">
      <span class="alert-text">{{ history.error }}</span>
      <button class="btn ghost sm" @click="history.error = ''">关闭</button>
    </div>

    <!-- 首屏骨架：卡片墙形状，避免「正在查」时先闪一下「还没有播放记录」 -->
    <div v-if="history.loading && !history.items.length" class="grid">
      <div v-for="i in 8" :key="`sk-${i}`" class="card item sk-card">
        <div class="thumb skeleton"></div>
        <div class="body">
          <div class="skeleton sk-line w70"></div>
          <div class="skeleton sk-line w45"></div>
          <div class="skeleton sk-line w30"></div>
        </div>
      </div>
    </div>

    <div v-else-if="!history.items.length" class="card empty">
      <div class="empty-ico">🕘</div>
      <div class="empty-title">还没有播放记录</div>
      <div class="empty-sub">在首页、发现页或媒体库点开任意影片，看过之后就会出现在这里，下次直接从上次的位置继续。</div>
      <button class="btn primary sm" @click="store.go('discover')">去发现页看看</button>
    </div>

    <div v-else class="hist-groups">
      <section v-for="g in groups" :key="g.label" class="hist-group">
        <header class="group-head">
          <h3>{{ g.label }}</h3>
          <span class="group-count">{{ g.items.length }}</span>
          <span class="group-rule" aria-hidden="true"></span>
        </header>

        <div class="grid">
          <article
            v-for="it in g.items"
            :key="it.key"
            class="card item is-clickable"
            :class="{ busy: busyKey === it.key }"
            :title="`${it.title}${it.episodeName ? ' · ' + it.episodeName : ''}`"
            role="button"
            tabindex="0"
            @click="resume(it)"
            @keydown.enter.prevent="resume(it)"
            @keydown.space.prevent="resume(it)"
          >
            <div class="thumb">
              <img v-if="it.poster" :src="catalog.posterUrl(it.poster)" loading="lazy" alt="" />
              <div v-else class="poster-fallback" :style="hueStyle(it.title)">
                <span>{{ initialsOf(it.title) }}</span>
              </div>
              <span class="thumb-fade" aria-hidden="true"></span>
              <span v-if="it.episodeName" class="ep-tag">{{ it.episodeName }}</span>
              <button class="thumb-del" title="从历史中删除" @click.stop="onRemove(it)">×</button>
              <span class="play-btn" aria-hidden="true">▶</span>
              <span class="resume-hint" aria-hidden="true">继续播放</span>
              <div v-if="it.durationSec > 0" class="pbar">
                <i :class="{ done: historyDone(it) }" :style="{ width: historyPct(it) + '%' }"></i>
              </div>
              <div v-if="busyKey === it.key" class="busy-mask">
                <span class="spinner" aria-hidden="true"></span>
                <span>起播中…</span>
              </div>
            </div>

            <div class="body">
              <div class="title-row">
                <div class="title">{{ it.title }}</div>
                <span v-if="historyDone(it)" class="badge ok">看完</span>
              </div>
              <div class="sub">
                <span v-if="it.siteName" class="site">{{ it.siteName }}</span>
                <span v-if="it.siteName && it.episodeName" class="dot" aria-hidden="true"></span>
                <span v-if="it.episodeName" class="ep">{{ it.episodeName }}</span>
                <span v-if="!it.siteName && !it.episodeName" class="ep">来源未记录</span>
              </div>
              <div class="foot">
                <span class="time">{{ hhmm(it.playedAt) }}</span>
                <span class="pct" :class="{ done: historyDone(it) }">{{ progressText(it) }}</span>
              </div>
            </div>
          </article>
        </div>
      </section>
    </div>

    <div v-if="history.hasMore" class="more">
      <button class="btn ghost" :disabled="history.loading" @click="history.loadMore()">
        {{ history.loading ? '加载中…' : `加载更多（还有 ${history.total - history.items.length} 条）` }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.history-view {
  width: 100%;
}

/* ---- 按天分组 ---- */
.hist-groups {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
}
.hist-group {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.group-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-height: 18px;
}
.group-head h3 {
  margin: 0;
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text-dim);
  letter-spacing: 0.2px;
}
.group-count {
  min-width: 20px;
  height: 18px;
  padding: 0 6px;
  display: inline-grid;
  place-items: center;
  border-radius: var(--r-pill);
  background: var(--panel-3);
  color: var(--text-faint);
  font-size: var(--fs-2xs);
  font-variant-numeric: tabular-nums;
}
/* 分组分隔线：向右淡出，避免整页被一排等长横线切碎 */
.group-rule {
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, var(--line), transparent);
}

/* ---- 卡片墙 ---- */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(236px, 100%), 1fr));
  gap: var(--sp-4);
}
.item {
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
  border-radius: var(--r-lg);
  outline: none;
  transition: border-color var(--t-base) var(--ease), transform var(--t-base) var(--ease),
    box-shadow var(--t-base) var(--ease);
}
.item:hover {
  border-color: var(--line-hover);
  transform: translateY(-2px);
  box-shadow: var(--shadow-2);
}
.item:focus-visible {
  border-color: var(--accent-line);
  box-shadow: var(--ring);
}
.item.busy {
  cursor: progress;
  transform: none;
}

/* ---- 缩略图：16:9，视频语义 ---- */
.thumb {
  position: relative;
  aspect-ratio: 16 / 9;
  background: linear-gradient(135deg, var(--fallback-a), var(--fallback-b));
  border-bottom: 1px solid var(--line);
  overflow: hidden;
}
/*
 * 海报脱离 flex 流（inset:0 绝对定位）。媒体库踩过：作为 flex item 会以固有
 * 宽度撑开容器，把角标/播放键推出卡片外。
 * object-position 偏上：竖版海报取上半部，人才不会被裁掉。
 */
.thumb img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center 22%;
  transition: transform var(--t-slow) var(--ease);
}
.item:hover .thumb img {
  transform: scale(1.04);
}
.poster-fallback {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: linear-gradient(135deg, hsl(var(--h) var(--fb-s) var(--fb-l1)), hsl(calc(var(--h) + 42) var(--fb-s-2) var(--fb-l2)));
  font-size: 21px;
  font-weight: 700;
  letter-spacing: 2px;
  color: var(--fb-ink);
  user-select: none;
}
/* 底部渐隐：让集数标签与进度条在任何画面上都读得清 */
.thumb-fade {
  position: absolute;
  inset: 0;
  background: linear-gradient(to top, rgb(6 9 14 / 0.78), rgb(6 9 14 / 0.12) 44%, transparent 70%);
  pointer-events: none;
}
.ep-tag {
  position: absolute;
  top: 8px;
  left: 8px;
  max-width: calc(100% - 52px);
  padding: 1px 7px;
  border-radius: var(--r-sm);
  background: rgb(6 9 14 / 0.74);
  border: 1px solid rgb(255 255 255 / 0.1);
  backdrop-filter: blur(4px);
  font-size: 10px;
  font-weight: 500;
  line-height: 16px;
  color: #cdd7e8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 删除：hover 才出现，避免常驻一堆红叉抢走「继续播放」的注意力 */
.thumb-del {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 22px;
  height: 22px;
  min-height: 0;
  padding: 0;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 1px solid rgb(255 255 255 / 0.16);
  background: rgb(6 9 14 / 0.72);
  color: #e6ecf7;
  font-size: 14px;
  line-height: 1;
  opacity: 0;
  transition: opacity var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
}
.item:hover .thumb-del,
.thumb-del:focus-visible {
  opacity: 1;
}
.thumb-del:hover:not(:disabled) {
  background: var(--danger);
  border-color: transparent;
  transform: none;
}
/* 主操作：整卡可点，播放键只是视觉锚点，不占位、不可单独聚焦 */
.play-btn {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 40px;
  height: 40px;
  margin: -20px 0 0 -20px;
  display: grid;
  place-items: center;
  padding-left: 3px;
  border-radius: 50%;
  border: 1px solid rgb(255 255 255 / 0.22);
  background: rgb(76 125 255 / 0.88);
  color: #fff;
  font-size: 13px;
  backdrop-filter: blur(6px);
  opacity: 0;
  transform: scale(0.9);
  pointer-events: none;
  transition: opacity var(--t-fast) var(--ease), transform var(--t-fast) var(--ease);
}
.item:hover .play-btn,
.item:focus-visible .play-btn {
  opacity: 1;
  transform: scale(1);
}
.resume-hint {
  position: absolute;
  left: 10px;
  bottom: 9px;
  font-size: var(--fs-2xs);
  color: rgb(255 255 255 / 0.82);
  text-shadow: 0 1px 3px rgb(0 0 0 / 0.6);
  opacity: 0;
  transform: translateY(2px);
  transition: opacity var(--t-fast) var(--ease), transform var(--t-fast) var(--ease);
}
.item:hover .resume-hint,
.item:focus-visible .resume-hint {
  opacity: 1;
  transform: translateY(0);
}
/* 进度条贴底：不另占一行高度 */
.pbar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: rgb(0 0 0 / 0.55);
}
.pbar i {
  display: block;
  height: 100%;
  background: var(--accent);
  box-shadow: 0 0 8px rgb(76 125 255 / 0.6);
  transition: width var(--t-slow) var(--ease);
}
/* 已看完：进度条换成就绪色，视觉上和「还差一截」的蓝色区分开 */
.pbar i.done {
  background: var(--ok);
  box-shadow: 0 0 8px color-mix(in srgb, var(--ok) 55%, transparent);
}
.busy-mask {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: rgb(6 9 14 / 0.66);
  backdrop-filter: blur(2px);
  font-size: var(--fs-2xs);
  color: #dbe3f2;
}

/* ---- 卡片文字区 ---- */
.body {
  display: flex;
  flex-direction: column;
  gap: 5px;
  flex: 1;
  padding: 10px 12px 11px;
}
.title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.title {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 单行不换行：wrap 会让同排卡片标题基线错位、下半截高矮不齐 */
.sub {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: var(--fs-2xs);
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
}
.sub .site {
  flex: none;
  max-width: 55%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sub .ep {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sub .dot {
  flex: none;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--line-2);
}
.foot {
  margin-top: auto;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding-top: 2px;
  font-size: var(--fs-2xs);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.foot .pct {
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.foot .pct.done {
  color: var(--ok);
}

/* ---- 骨架卡 ---- */
.sk-card {
  cursor: default;
}
.sk-card:hover {
  border-color: var(--line);
  transform: none;
  box-shadow: none;
}
.sk-card .thumb {
  border-bottom-color: transparent;
}
.sk-line {
  height: 10px;
}
.w70 {
  width: 70%;
}
.w45 {
  width: 45%;
}
.w30 {
  width: 30%;
}

/* ---- 错误条与加载更多 ---- */
.alert-row {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  margin: 0 0 var(--sp-3);
}
.alert-row .alert-text {
  flex: 1 1 auto;
  min-width: 0;
  word-break: break-word;
}
.more {
  display: flex;
  justify-content: center;
  margin: var(--sp-5) 0 0;
}

/*
 * 平板 / 小窗（561–900px）：固定三列。
 * 236px 的 auto-fill 在这个宽度只会排出两列，每列近 350px 宽 —— 16:9 缩略图
 * 会大到一屏只看得见一排，卡片墙退化成大图列表。
 */
@media (min-width: 561px) and (max-width: 900px) {
  .grid {
    grid-template-columns: repeat(auto-fill, minmax(min(196px, 100%), 1fr));
    gap: var(--sp-3);
  }
}

/*
 * 手机：两列。单列全宽会让 16:9 缩略图铺满屏幕（一屏只能看两张），
 * 卡片墙的意义就没了。窄卡片里去掉了「来源 · 集名」一行 —— 集名已经在
 * 缩略图左上角的 ep-tag 上，来源在手机上优先级最低。
 */
@media (max-width: 560px) {
  .grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  .hist-groups {
    gap: var(--sp-4);
  }
  .body {
    gap: 4px;
    padding: 8px 9px 9px;
  }
  .title {
    font-size: var(--fs-xs);
  }
  .sub {
    display: none;
  }
  .foot {
    font-size: 10px;
    gap: 6px;
  }
  .title-row .badge {
    font-size: 9px;
    padding: 0 4px;
  }
  .ep-tag {
    top: 6px;
    left: 6px;
    max-width: calc(100% - 40px);
    padding: 0 5px;
    font-size: 9px;
    line-height: 15px;
  }
  .thumb-del {
    top: 5px;
    right: 5px;
    width: 20px;
    height: 20px;
    font-size: 13px;
  }
  .resume-hint {
    display: none;
  }
  /* 窄卡片里的首字水印要跟着缩小，否则两个字就撑满整块封面 */
  .poster-fallback {
    font-size: 15px;
    letter-spacing: 1px;
  }
}
</style>
