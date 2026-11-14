<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import { useMagnetStore } from '../stores/magnet'
import { usePlayerStore } from '../stores/player'
import type { MagnetTask } from '@polyframe/shared'

const ms = useMagnetStore()
const player = usePlayerStore()

/** 字节 → 人类可读（BT 片源动辄几十 GB，必须带单位） */
function fmtBytes(n: number): string {
  if (!n || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

function pct(t: MagnetTask): number {
  if (t.status === 'done') return 100
  if (!t.totalBytes) return 0
  return Math.min(100, Math.round((t.doneBytes / t.totalBytes) * 100))
}

function statusText(t: MagnetTask): string {
  switch (t.status) {
    case 'adding':
      return '获取元数据…'
    case 'downloading':
      return `下载中 ${pct(t)}%`
    case 'paused':
      return `已暂停 ${pct(t)}%`
    case 'done':
      return '已完成'
    default:
      return '失败'
  }
}

/** 任务状态 → 全局徽章语义色（与任务管理 / 媒体库保持同一套） */
function badgeOf(t: MagnetTask): string {
  switch (t.status) {
    case 'adding':
      return 'info'
    case 'downloading':
      return 'accent'
    case 'paused':
      return 'warn'
    case 'done':
      return 'ok'
    default:
      return 'danger'
  }
}

const videoFiles = computed(() => (t: MagnetTask) => t.files.filter((f) => f.isVideo))

/** 内核就绪后再拉列表（内核比界面晚就绪是常态，不能只判一次） */
watch(
  () => player.online,
  (on) => {
    if (!on) return
    void ms.refresh().then(() => ms.startPolling())
  },
  { immediate: true }
)

onBeforeUnmount(() => ms.stopPolling())

function onAdd(): void {
  void ms.add()
}

function toggleExpand(t: MagnetTask): void {
  ms.expanded = ms.expanded === t.id ? '' : t.id
}
</script>

<template>
  <div class="magnet-view">
    <!-- 新建任务 -->
    <section class="card add-card">
      <form class="add-row" @submit.prevent="onAdd">
        <span class="add-ico" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 4v7a7 7 0 0 0 14 0V4" />
            <path d="M5 9h4M15 9h4" />
          </svg>
        </span>
        <input
          v-model="ms.input"
          class="add-input"
          placeholder="粘贴磁力链接、40 位 info hash 或 .torrent 地址"
          spellcheck="false"
          aria-label="磁力链接"
        />
        <button class="btn primary" type="submit" :disabled="ms.adding || !ms.input.trim()">
          {{ ms.adding ? '添加中…' : '添加任务' }}
        </button>
      </form>

      <ul class="tips">
        <li>先在后台获取种子元数据，死种会停在这一步并给出原因</li>
        <li>拿到文件列表后自动挑最大的视频文件下载，多集种子可手动选集</li>
        <li><strong>下载完成后</strong>才能播放 —— MP4 索引常在文件末尾，边下边播会 seek 失败</li>
      </ul>

      <div v-if="ms.error" class="alert">{{ ms.error }}</div>
    </section>

    <!-- 任务列表 -->
    <section class="card list-card">
      <header class="list-head">
        <div class="list-title">
          <h2>任务（{{ ms.tasks.length }}）</h2>
          <span v-if="ms.hasActive" class="badge accent">进度每 1.5s 刷新</span>
        </div>
        <p class="list-stat">
          <span>已完成 {{ ms.doneCount }}</span>
          <span>下载目录在内核数据目录的 <code>magnet/</code></span>
        </p>
      </header>

      <div v-if="!ms.tasks.length" class="empty">
        <div class="empty-ico">🧲</div>
        <div class="empty-title">还没有磁力任务</div>
        <div class="empty-sub">在上方粘贴磁力链接或 info hash 即可开始。添加后自动选片，下载完成即可播放。</div>
      </div>

      <ul v-else class="task-list">
        <li v-for="t in ms.tasks" :key="t.id" class="task">
          <div class="task-main">
            <div class="task-head">
              <!-- 元数据未到手时别把裸 infohash 顶到标题位（像乱码）：待元数据态给友好占位 -->
            <span
              class="task-name"
              :class="{ pending: !t.name }"
              :title="t.name || t.infoHash"
            >{{ t.name || (t.status === 'adding' ? '正在解析元数据…' : t.infoHash || '（未命名）') }}</span>
              <span class="badge" :class="badgeOf(t)">{{ statusText(t) }}</span>
            </div>
            <div class="task-bar">
              <div class="progress" :class="{ indet: t.status === 'adding' }">
                <i v-if="t.status !== 'adding'" :class="`f-${t.status}`" :style="{ width: pct(t) + '%' }"></i>
              </div>
              <span class="task-size">
                {{ fmtBytes(t.doneBytes) }}<span class="slash">/</span>{{ fmtBytes(t.totalBytes) }}
              </span>
            </div>
            <p v-if="t.error" class="task-err">{{ t.error }}</p>
            <p v-else-if="t.fileName" class="task-sub" :title="t.filePath ?? ''">
              <span class="task-sub-k">正片</span>{{ t.fileName }}
              <span v-if="t.files.length > 1" class="task-sub-extra">种子内 {{ t.files.length }} 个文件</span>
            </p>
          </div>

          <div class="task-ops">
            <button v-if="t.status === 'done'" class="btn sm primary" :disabled="ms.busyId === t.id" @click="ms.play(t)">
              播放
            </button>
            <button
              v-if="t.status === 'downloading' || t.status === 'adding'"
              class="btn sm"
              :disabled="ms.busyId === t.id"
              @click="ms.pause(t)"
            >
              暂停
            </button>
            <button v-if="t.status === 'paused' || t.status === 'error'" class="btn sm" :disabled="ms.busyId === t.id" @click="ms.resume(t)">
              继续
            </button>
            <button
              v-if="videoFiles(t).length > 1"
              class="btn sm ghost"
              :aria-expanded="ms.expanded === t.id"
              @click="toggleExpand(t)"
            >
              {{ ms.expanded === t.id ? '收起' : `选集 ${videoFiles(t).length}` }}
            </button>
            <button class="btn sm ghost danger" :disabled="ms.busyId === t.id" @click="ms.remove(t, true)">删除</button>
          </div>

          <!-- 选集：多集种子只下选中的一集 -->
          <div v-if="ms.expanded === t.id" class="files">
            <button
              v-for="f in videoFiles(t)"
              :key="f.index"
              class="file-item"
              :class="{ on: t.fileIndex === f.index }"
              :title="f.name"
              @click="ms.select(t, f.index)"
            >
              <span class="file-name">{{ f.name }}</span>
              <span class="file-size">{{ fmtBytes(f.len) }}</span>
            </button>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.magnet-view {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  padding-bottom: var(--sp-2);
}

/* ---- 新建任务 ---- */
.add-card {
  padding: var(--sp-4);
}
.add-row {
  display: flex;
  align-items: stretch;
  gap: var(--sp-2);
  padding: 5px 5px 5px var(--sp-3);
  border: 1px solid var(--line-2);
  border-radius: var(--r-md);
  background: var(--panel-2);
  transition: border-color var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
}
.add-row:focus-within {
  border-color: var(--accent-line);
  box-shadow: var(--ring);
}
.add-ico {
  display: inline-flex;
  align-self: center;
  color: var(--text-faint);
  flex: none;
}
.add-row:focus-within .add-ico {
  color: var(--accent);
}
/* 输入框嵌进工具条里：去掉自带边框与背景，焦点高亮交给整条容器 */
.add-input {
  flex: 1;
  min-width: 180px;
  border: none;
  background: transparent;
  padding: 0;
  font-size: var(--fs-sm);
}
.add-input:focus {
  border: none;
  box-shadow: none;
}
.add-row .btn {
  flex: none;
  min-height: 32px;
  margin: 0;
}
.tips {
  margin: var(--sp-3) 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.tips li {
  position: relative;
  padding-left: 13px;
  font-size: var(--fs-2xs);
  line-height: 1.7;
  color: var(--text-faint);
}
.tips li::before {
  content: '';
  position: absolute;
  left: 2px;
  top: 0.72em;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--line-2);
}
.tips strong {
  color: var(--text-dim);
  font-weight: 600;
}

/* ---- 任务列表 ---- */
.list-card {
  padding: var(--sp-4) var(--sp-4) var(--sp-1);
}
.list-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-3);
  flex-wrap: wrap;
  padding-bottom: var(--sp-3);
}
.list-title {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}
.list-title h2 {
  font-size: var(--fs-md);
  font-weight: 600;
}
.list-stat {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  font-size: var(--fs-2xs);
  color: var(--text-faint);
  flex-wrap: wrap;
}
.list-stat > span + span::before {
  content: '·';
  margin-right: var(--sp-2);
  color: var(--line-2);
}

.task-list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.task {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--sp-2) var(--sp-4);
  padding: var(--sp-3) 0;
  border-top: 1px solid var(--line);
}
.task-main {
  min-width: 0;
}
.task-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: 7px;
}
.task-name {
  min-width: 0;
  flex: 0 1 auto;
  font-size: var(--fs-sm);
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 元数据未到手：占位文案降一档，别和真标题抢注意力 */
.task-name.pending {
  color: var(--text-faint);
}
.task-bar {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.task-bar .progress {
  flex: 1;
  min-width: 60px;
}
/* 元数据阶段没有总量，用流动光条表示「在动但不可测」 */
.progress.indet::after {
  content: '';
  display: block;
  height: 100%;
  width: 34%;
  border-radius: inherit;
  background: linear-gradient(90deg, transparent, var(--accent), transparent);
  animation: pf-indet 1.25s ease-in-out infinite;
}
@keyframes pf-indet {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(300%);
  }
}
.progress > i.f-done {
  background: var(--ok);
}
.progress > i.f-error {
  background: var(--danger);
}
.progress > i.f-paused {
  background: var(--warn);
}
.task-size {
  flex: none;
  font-size: var(--fs-2xs);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.slash {
  margin: 0 3px;
  color: var(--line-2);
}
.task-sub,
.task-err {
  margin: 7px 0 0;
  font-size: var(--fs-2xs);
  line-height: 1.6;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-sub {
  color: var(--text-faint);
}
.task-sub-k {
  margin-right: 5px;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--panel-3);
  color: var(--text-dim);
}
.task-sub-extra {
  margin-left: var(--sp-2);
  color: var(--text-faint);
}
.task-err {
  color: var(--danger);
  white-space: normal;
  word-break: break-word;
}
.task-ops {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

/* 选集：宽屏双列，避免长种子把页面拉得很长 */
.files {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 4px;
  margin-top: 2px;
  padding: var(--sp-2);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--panel-2);
}
.file-item {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-3);
  min-height: 0;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-dim);
  font-size: var(--fs-2xs);
  text-align: left;
  cursor: pointer;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease),
    border-color var(--t-fast) var(--ease);
}
.file-item:hover:not(:disabled) {
  background: var(--panel-3);
  border-color: transparent;
  color: var(--text);
  transform: none;
}
.file-item.on {
  background: var(--accent-soft);
  border-color: var(--accent-line);
  color: var(--accent-ink);
  font-weight: 500;
}
.file-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-size {
  flex: none;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.file-item.on .file-size {
  color: var(--accent-ink);
  opacity: 0.75;
}

/* ---- 响应式 ---- */
@media (max-width: 720px) {
  .task {
    grid-template-columns: minmax(0, 1fr);
  }
  .task-ops {
    justify-content: flex-start;
    margin-top: 2px;
  }
  .add-input {
    min-width: 0;
  }
  .list-card,
  .add-card {
    padding: var(--sp-3);
  }
}
@media (max-width: 520px) {
  /* 手机宽度：容器边框让位给输入框自身（否则输入 + 按钮上下叠在一个框里很怪） */
  .add-row {
    flex-wrap: wrap;
    padding: 0;
    border: none;
    background: transparent;
    gap: var(--sp-2);
  }
  .add-row:focus-within {
    box-shadow: none;
  }
  .add-ico {
    display: none;
  }
  .add-input {
    flex: 1 1 100%;
    padding: 9px 12px;
    border: 1px solid var(--line-2);
    border-radius: var(--r-md);
    background: var(--panel-2);
  }
  .add-input:focus {
    border-color: var(--accent-line);
    box-shadow: var(--ring);
  }
  .add-row .btn {
    width: 100%;
    min-height: 34px;
  }
}
</style>
