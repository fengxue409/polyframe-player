<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CacheMode, Task } from '@polyframe/shared'
import { usePlayerStore } from '../stores/player'
import CleanupDialog from './CleanupDialog.vue'
import CleanupMenu from './CleanupMenu.vue'
import {
  TASK_RULES,
  fmtBytes,
  previewNames,
  summarizeTasks,
  tasksByRule,
  type CleanupMenuItem,
  type TaskRuleKey
} from '../lib/cleanup'

import {
  TASK_GROUPS,
  canPauseTask,
  canStartTask,
  statusTextOf,
  taskGroupOf,
  type TaskGroupKey
} from '../lib/task-groups'

const store = usePlayerStore()
/** 新建在前 */
const sorted = computed(() => [...store.tasks].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)))
/** 行级操作中的任务 id，或批量清理时的哨兵值 'cleanup' */
const busy = ref('')

/**
 * 分组展示（P40）：分组决定徽章文案与可点动作，两者必须同源，
 * 否则会出现「徽章写就绪、实际在等手动启动」这种自相矛盾的行。
 */
const groups = computed(() => {
  const buckets: Record<TaskGroupKey, Task[]> = {
    playing: [],
    downloading: [],
    preparing: [],
    paused: [],
    done: [],
    failed: []
  }
  for (const t of sorted.value) buckets[taskGroupOf(t, store.playingTaskId)].push(t)
  return TASK_GROUPS.map((g) => ({ ...g, tasks: buckets[g.key] }))
})
/** 只渲染有内容的分组（空组不占版面，但顶部摘要仍然列出 0） */
const shownGroups = computed(() => groups.value.filter((g) => g.tasks.length > 0))
/**
 * 点图例筛分组（P44）：再点一次取消。
 * 过滤只影响「看什么」，不改调度 —— 暂停中的任务不会因为被筛掉就自动恢复。
 */
const groupFilter = ref<TaskGroupKey | ''>('')
/**
 * 换分组时顺手把「看不见的勾选」清掉。
 * 否则：勾了 5 个 → 筛到 1 个 → 点批量删除，会连带删掉屏幕外那 4 个，
 * 而界面上「已选」的数字又对不上看得见的行。
 */
function pruneSelection(): void {
  if (!selectMode.value) return
  const keep = new Set(visibleTasks.value.map((t) => t.id))
  const next: Record<string, boolean> = {}
  for (const id of Object.keys(selected.value)) if (keep.has(id)) next[id] = true
  selected.value = next
}
function pickGroup(key: TaskGroupKey): void {
  groupFilter.value = groupFilter.value === key ? '' : key
  pruneSelection()
}
function clearGroupFilter(): void {
  groupFilter.value = ''
}
/** 当前分组筛选下可见的任务（顺序仍按"新建在前"） */
const visibleTasks = computed(() =>
  groupFilter.value
    ? sorted.value.filter((t) => taskGroupOf(t, store.playingTaskId) === groupFilter.value)
    : sorted.value
)
/** 表体渲染用：筛选时只留被选中的那一组，即使它已经空到 0 条 */
const visibleGroups = computed(() =>
  groupFilter.value ? groups.value.filter((g) => g.key === groupFilter.value) : shownGroups.value
)
/** 任务被删到空、被改状态后筛选组消失 → 自动回到全部，别把人锁在一个空表里 */
watch(
  () => store.tasks.length,
  (n) => {
    if (!n) groupFilter.value = ''
  }
)
/** 表格列数：分组表头行要跨满（选择态多一列） */
const colCount = computed(() => (selectMode.value ? 8 : 7))

function groupOf(t: Task): TaskGroupKey {
  return taskGroupOf(t, store.playingTaskId)
}
function statusText(t: Task): string {
  return statusTextOf(t, groupOf(t))
}
/** 有别的任务在播 → 下载槽被占，不能再启动别的任务（否则两边都卡） */
function slotBusyFor(t: Task): string {
  const p = store.playingTaskId
  return p && p !== t.id ? (store.tasks.find((x) => x.id === p)?.title ?? '其他任务') : ''
}
/**
 * 「自动」标记：这次暂停不是用户按的，而是给别的任务让位。
 * 判据用**分组**而不是 `status === 'paused'`：内核把 job 收尾写成 ready 时
 * （ready + 分片没下完也归「已暂停」组），按 status 判会整片标记消失。
 */
function autoNote(t: Task): string {
  if (groupOf(t) !== 'paused' || !store.autoPausedIds[t.id]) return ''
  return '自动'
}

const cacheModeLabel: Record<CacheMode, string> = {
  online: '在线',
  stream: '边下边播',
  precache: '预缓存'
}
const cacheModeClass: Record<CacheMode, string> = {
  online: 'cm-online',
  stream: 'cm-stream',
  precache: 'cm-precache'
}
const cacheModeOptions: { value: CacheMode; label: string }[] = [
  { value: 'online', label: '在线（不落盘）' },
  { value: 'stream', label: '边下边播' },
  { value: 'precache', label: '预缓存' }
]

function titleOf(t: Task): string {
  return t.title || t.url
}
function pctOf(t: Task): number | null {
  if (!t.segTotal) return null
  return Math.min(100, Math.round(((t.segDone ?? 0) / t.segTotal) * 100))
}
function fmtSpeed(b?: number): string {
  if (!b) return '—'
  if (b >= 1048576) return `${(b / 1048576).toFixed(1)} MB/s`
  if (b >= 1024) return `${Math.round(b / 1024)} KB/s`
  return `${Math.round(b)} B/s`
}
function progressLabel(t: Task): string {
  if (t.segTotal === undefined || t.segTotal === 0) return '—'
  const mb = (t.bytesDone ?? 0) / 1048576
  const size = mb >= 1 ? `${mb.toFixed(1)}MB` : `${Math.round((t.bytesDone ?? 0) / 1024)}KB`
  return `${t.segDone ?? 0}/${t.segTotal} · ${size}`
}
function retainLabel(t: Task): string {
  if (!t.retainUntil) return '—'
  const ms = new Date(t.retainUntil).getTime() - Date.now()
  if (ms <= 0) return '待清理'
  const h = ms / 3600000
  if (h < 1) return `${Math.max(1, Math.round(ms / 60000))} 分钟`
  if (h < 48) return `${Math.round(h)} 小时`
  return `${Math.round(h / 24)} 天`
}

async function run(id: string, fn: () => Promise<void>): Promise<void> {
  busy.value = id
  try {
    await fn()
  } catch (e) {
    store.pushLog('error', (e as Error).message)
  } finally {
    busy.value = ''
  }
}
function onPlay(t: Task): void {
  store.playTask(t)
}
function onPause(t: Task): void {
  void run(t.id, () => store.pauseTask(t.id))
}
function onResume(t: Task): void {
  // 启动 = 占住下载槽（其他下载中的任务自动让位）
  void run(t.id, () => store.startTask(t.id))
}
function onDelete(t: Task): void {
  askDelete([t])
}
/**
 * 行内「清缓存」保持一键执行：它只删分片、保留任务，真正需要确认的是
 * 「删除任务」那种不可恢复的动作。批量清缓存才走确认框（一次动几十个）。
 */
function onPurge(t: Task): void {
  void run(t.id, async () => {
    const r = await store.purgeTasks([t.id])
    store.pushLog('info', `已清空任务缓存，释放 ${fmtBytes(r.freedBytes)}`)
  })
}
/** P6 合并导出：保存对话框 + 分片 concat（DASH 暂不支持，按钮不显示） */
function onExport(t: Task): void {
  void run(t.id, async () => {
    const r = await store.exportTask(t.id)
    if (r.canceled && !r.error) store.pushLog('info', '导出已取消')
  })
}
function onSetCacheMode(t: Task, ev: Event): void {
  const mode = (ev.target as HTMLSelectElement).value as CacheMode
  if (mode === t.cacheMode) return
  void run(t.id, () => store.setCacheMode(t.id, mode))
}
function onRefresh(): void {
  void run('refresh', () => store.refreshTasks())
}

// ---- P35 多选与规则清理 ----
//
// 任务页原来只能一行一行删。缓存攒到几十个任务后，最常见的诉求是
// 「把已经下完的都清掉」「把失败的全清了」，逐行点不现实。
// 这里补两层：勾选后批量处理，以及按规则一次选中（仍要过确认框）。

const selectMode = ref(false)
const selected = ref<Record<string, boolean>>({})

const selectedTasks = computed(() => sorted.value.filter((t) => selected.value[t.id]))
const selectedIds = computed(() => selectedTasks.value.map((t) => t.id))
const selectedStat = computed(() => summarizeTasks(selectedTasks.value))
const allSelected = computed(
  () => visibleTasks.value.length > 0 && selectedIds.value.length === visibleTasks.value.length
)

function toggleSelectMode(): void {
  selectMode.value = !selectMode.value
  if (!selectMode.value) selected.value = {}
}
function toggleOne(id: string): void {
  selected.value = { ...selected.value, [id]: !selected.value[id] }
}
function toggleAll(): void {
  if (allSelected.value) {
    selected.value = {}
    return
  }
  // 只选「筛完看得见的」：否则批量删除会连带删掉屏幕外的任务
  const next: Record<string, boolean> = {}
  for (const t of visibleTasks.value) next[t.id] = true
  selected.value = next
}

/** 规则项：计数与体积实时算，菜单上就能看到「这条规则会清掉多少」 */
const ruleItems = computed<CleanupMenuItem[]>(() =>
  TASK_RULES.map((r) => {
    const picked = tasksByRule(sorted.value, r.key)
    return {
      key: r.key,
      label: r.label,
      hint: r.hint,
      count: picked.length,
      bytes: summarizeTasks(picked).bytes,
      danger: r.danger
    }
  })
)

type PendingKind = 'delete' | 'purge'
interface PendingCleanup {
  kind: PendingKind
  ids: string[]
  titles: string[]
  segs: number
  bytes: number
  /** 触发方式：规则名或「选中」 */
  source: string
}
const pending = ref<PendingCleanup | null>(null)

function askDelete(tasks: Task[], source = '选中的任务'): void {
  if (!tasks.length) return
  const stat = summarizeTasks(tasks)
  pending.value = {
    kind: 'delete',
    ids: tasks.map((t) => t.id),
    titles: tasks.map(titleOf),
    segs: tasks.reduce((n, t) => n + (t.segDone ?? 0), 0),
    bytes: stat.bytes,
    source
  }
}
function askPurge(tasks: Task[], source = '选中的任务'): void {
  if (!tasks.length) return
  const stat = summarizeTasks(tasks)
  pending.value = {
    kind: 'purge',
    ids: tasks.map((t) => t.id),
    titles: tasks.map(titleOf),
    segs: tasks.reduce((n, t) => n + (t.segDone ?? 0), 0),
    bytes: stat.bytes,
    source
  }
}

function onRule(key: string): void {
  const rule = TASK_RULES.find((r) => r.key === key)
  if (!rule) return
  const picked = tasksByRule(sorted.value, key as TaskRuleKey)
  if (picked.length) void askDelete(picked, rule.label)
}

const dialogStats = computed(() => {
  const p = pending.value
  if (!p) return []
  return [
    { label: p.kind === 'delete' ? '任务' : '清缓存', value: `${p.ids.length} 个` },
    { label: '分片', value: `${p.segs} 个` },
    { label: p.kind === 'delete' ? '可释放' : '预计释放', value: fmtBytes(p.bytes) }
  ]
})
const dialogNames = computed(() => previewNames(pending.value?.titles ?? []))
const dialogTitle = computed(() => {
  const p = pending.value
  if (!p) return ''
  return p.kind === 'delete' ? `删除 ${p.ids.length} 个任务？` : `清空 ${p.ids.length} 个任务的缓存？`
})
const dialogSub = computed(() => {
  const p = pending.value
  if (!p) return ''
  return p.kind === 'delete'
    ? `${p.source}：任务记录与已下载分片会一并删除，无法恢复。`
    : `${p.source}：只删分片文件与索引，任务记录保留，下次播放会重新缓存。`
})

async function runPending(): Promise<void> {
  const p = pending.value
  if (!p || busy.value === 'cleanup') return
  busy.value = 'cleanup'
  try {
    if (p.kind === 'delete') {
      const r = await store.deleteTasks(p.ids)
      const done = r.deleted ?? p.ids.length
      store.pushLog(
        'info',
        `已清理 ${done} 个任务，释放 ${fmtBytes(r.freedBytes)}${
          r.failed?.length ? `（${r.failed.length} 个已不存在）` : ''
        }`
      )
    } else {
      const r = await store.purgeTasks(p.ids)
      store.pushLog('info', `已清空 ${r.purged ?? p.ids.length} 个任务的缓存，释放 ${fmtBytes(r.freedBytes)}`)
    }
    selected.value = {}
    pending.value = null
  } catch (e) {
    store.pushLog('error', `清理失败：${(e as Error).message}`)
  } finally {
    busy.value = ''
  }
}

/** 任务被外部清空（切缓存档/内核重连）时退出选择态，免得停在空表上 */
watch(
  () => sorted.value.length,
  (n) => {
    if (n === 0 && selectMode.value) toggleSelectMode()
  }
)
</script>

<template>
  <div class="tasks-view">
    <div class="page-head">
      <div class="page-head-text">
        <h2>任务（{{ store.tasks.length }}）</h2>
        <p>
          按状态分组，点顶部分组可只看那一组；同一时刻只有「播放中」或手动启动的那一个任务在下载。暂停后不会自动恢复，需点「启动」。
        </p>
      </div>
      <div class="head-actions">
        <CleanupMenu
          v-if="sorted.length"
          :items="ruleItems"
          :disabled="busy === 'cleanup'"
          @select="onRule"
        />
        <button
          v-if="sorted.length"
          class="btn ghost sm"
          :class="{ active: selectMode }"
          @click="toggleSelectMode"
        >
          {{ selectMode ? '退出选择' : '选择' }}
        </button>
        <button class="btn ghost sm" :disabled="busy === 'refresh' || !store.online" @click="onRefresh">
          刷新列表
        </button>
      </div>
    </div>

    <!-- 选择态工具条：勾选后才有意义，平时不占位置 -->
    <div v-if="selectMode" class="sel-bar">
      <label class="sel-all">
        <input type="checkbox" :checked="allSelected" @change="toggleAll" />
        全选
      </label>
      <span class="sel-info">
        已选 <b>{{ selectedIds.length }}</b> 个任务
        <template v-if="selectedIds.length"> · {{ fmtBytes(selectedStat.bytes) }}</template>
      </span>
      <div class="sel-actions">
        <button
          class="mini"
          :disabled="!selectedIds.length || busy === 'cleanup'"
          title="只删分片，任务记录保留"
          @click="askPurge(selectedTasks)"
        >
          清空缓存
        </button>
        <button
          class="mini danger"
          :disabled="!selectedIds.length || busy === 'cleanup'"
          title="任务记录与分片一起删除"
          @click="askDelete(selectedTasks)"
        >
          删除任务
        </button>
      </div>
    </div>

    <!-- 分组摘要：六个分组恒定列出（含 0），兼作「点一下只看这组」的筛选 -->
    <div v-if="sorted.length" class="group-legend">
      <button
        v-for="g in groups"
        :key="g.key"
        type="button"
        class="gl-item"
        :class="[`g-${g.key}`, { zero: !g.tasks.length, runnable: g.runnable, active: groupFilter === g.key }]"
        :title="g.tasks.length ? `只看「${g.label}」（再点取消）· ${g.rule}` : `「${g.label}」暂无任务`"
        :aria-pressed="groupFilter === g.key"
        :disabled="!g.tasks.length"
        @click="pickGroup(g.key)"
      >
        <span class="gl-dot"></span>
        {{ g.label }}
        <b>{{ g.tasks.length }}</b>
      </button>
      <button v-if="groupFilter" type="button" class="gl-clear" @click="clearGroupFilter">
        显示全部
      </button>
    </div>

    <section class="card">
      <div v-if="sorted.length" class="table-wrap">
        <table>
          <thead>
            <tr>
              <th v-if="selectMode" class="col-check"></th>
              <th class="col-task">任务</th>
              <th class="col-status">状态</th>
              <th class="col-progress">进度</th>
              <th class="col-speed">速度</th>
              <th class="col-mode">缓存</th>
              <th class="col-retain">保留至</th>
              <th class="col-ops">操作</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="g in visibleGroups" :key="g.key">
              <tr class="grp-row" :class="`g-${g.key}`">
                <td :colspan="colCount">
                  <span class="gl-dot"></span>
                  <b class="grp-name">{{ g.label }}</b>
                  <span class="grp-count">{{ g.tasks.length }}</span>
                  <span class="grp-rule">{{ g.rule }}</span>
                </td>
              </tr>
              <tr
                v-for="t in g.tasks"
                :key="t.id"
                :class="{ picked: selectMode && selected[t.id] }"
                @click="selectMode && toggleOne(t.id)"
              >
                <td v-if="selectMode" class="col-check" @click.stop>
                  <input
                    type="checkbox"
                    :checked="!!selected[t.id]"
                    :aria-label="`选择 ${titleOf(t)}`"
                    @change="toggleOne(t.id)"
                  />
                </td>
                <td class="col-task">
                  <div class="task-title" :title="t.url">{{ titleOf(t) }}</div>
                  <div class="task-id mono" :title="t.url">{{ t.id }}</div>
                </td>
                <td class="col-status">
                  <span class="badge" :class="`st-${g.key}`">{{ statusText(t) }}</span>
                  <span v-if="autoNote(t)" class="auto-tag" title="同一时刻只允许一个任务下载">自动</span>
                </td>
                <td class="col-progress">
                  <template v-if="pctOf(t) !== null">
                    <div class="progress"><div class="bar" :style="{ width: pctOf(t) + '%' }"></div></div>
                    <div class="mono dim prog-label">{{ progressLabel(t) }}（{{ pctOf(t) }}%）</div>
                  </template>
                  <span v-else class="dim">—</span>
                </td>
                <td class="mono col-speed">{{ fmtSpeed(t.speedBps) }}</td>
                <td class="col-mode">
                  <select
                    class="mode-select inline"
                    :class="cacheModeClass[t.cacheMode]"
                    :value="t.cacheMode"
                    title="切换缓存模式（切到有预取的档位＝立即启动下载）"
                    :disabled="busy === t.id"
                    @change="onSetCacheMode(t, $event)"
                  >
                    <option v-for="o in cacheModeOptions" :key="o.value" :value="o.value">
                      {{ cacheModeLabel[o.value] }}
                    </option>
                  </select>
                </td>
                <td class="dim col-retain">{{ retainLabel(t) }}</td>
                <td class="col-ops">
                  <div class="row-actions">
                    <button class="mini primary" title="到播放页播放该任务" @click="onPlay(t)">播放</button>
                    <button
                      v-if="canStartTask(t, g.key)"
                      class="mini"
                      :title="
                        slotBusyFor(t)
                          ? `正在播放「${slotBusyFor(t)}」，停播后才能启动其他下载`
                          : '启动下载（其余下载中的任务会让位）'
                      "
                      :disabled="busy === t.id || !!slotBusyFor(t)"
                      @click="onResume(t)"
                    >
                      启动
                    </button>
                    <button
                      v-if="canPauseTask(t)"
                      class="mini"
                      title="暂停下载（播放不受影响）"
                      :disabled="busy === t.id"
                      @click="onPause(t)"
                    >
                      暂停
                    </button>
                    <button
                      v-if="t.protocol !== 'dash' && (t.segDone ?? 0) > 0"
                      class="mini"
                      title="合并导出已缓存分片为单个媒体文件"
                      :disabled="busy === t.id"
                      @click="onExport(t)"
                    >
                      导出
                    </button>
                    <button
                      class="mini"
                      title="清空该任务已下载缓存（保留任务记录）"
                      :disabled="busy === t.id"
                      @click="onPurge(t)"
                    >
                      清缓存
                    </button>
                    <button
                      class="mini danger"
                      title="删除任务（缓存 + 记录一并移除）"
                      :disabled="busy === t.id"
                      @click="onDelete(t)"
                    >
                      删除
                    </button>
                  </div>
                </td>
              </tr>
              <!-- 筛选到的那一组刚好被删空：给一句话 + 回全部，别留个空表 -->
              <tr v-if="!g.tasks.length" class="grp-empty">
                <td :colspan="colCount">
                  「{{ g.label }}」分组暂无任务
                  <button type="button" class="mini" @click="clearGroupFilter">显示全部</button>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <div v-else class="empty">
        <div class="empty-ico">🗂</div>
        <div class="empty-title">暂无任务</div>
        <div class="empty-sub">到「播放」页输入链接创建任务；内核在线后任务会自动出现在这里。</div>
        <button class="btn ghost" @click="onRefresh">刷新列表</button>
      </div>
    </section>

    <CleanupDialog
      :open="!!pending"
      :title="dialogTitle"
      :subtitle="dialogSub"
      :stats="dialogStats"
      :names="dialogNames.shown"
      :rest="dialogNames.rest"
      note="清理只影响本地缓存与任务记录，收藏、播放历史、继续观看不受影响。"
      :confirm-text="pending?.kind === 'delete' ? '删除任务' : '清空缓存'"
      :busy="busy === 'cleanup'"
      :danger="pending?.kind === 'delete'"
      @cancel="pending = null"
      @confirm="runPending"
    />
  </div>
</template>

<style scoped>
.tasks-view {
  width: 100%;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
/* 选择态工具条：贴在表格上方，代替原先散落在行内的批量入口 */
.sel-bar {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-wrap: wrap;
  margin-bottom: var(--sp-3);
  padding: 8px 12px;
  border: 1px solid var(--accent-line);
  border-radius: var(--r-md);
  background: var(--accent-soft);
  font-size: var(--fs-xs);
  color: var(--text);
}
.sel-all {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  white-space: nowrap;
}
.sel-info {
  color: var(--text-dim);
}
.sel-info b {
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.sel-actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
}
/* 表格：列宽按内容分配，窄窗口整体横向滚动（不压缩按钮到换行） */
.table-wrap table {
  min-width: 820px;
  table-layout: fixed;
}
.col-check {
  width: 34px;
  text-align: center;
}
.col-task {
  width: 26%;
  min-width: 180px;
}
.task-title {
  font-size: var(--fs-sm);
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-id {
  margin-top: 1px;
  font-size: 10px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
tbody tr.picked {
  background: var(--accent-soft);
}
.col-status {
  width: 84px;
}
.col-progress {
  width: 20%;
  min-width: 148px;
}
.col-speed {
  width: 84px;
}
.col-mode {
  width: 100px;
}
.col-retain {
  width: 84px;
}
/* 进度条本体由全局 .progress 提供 */
.prog-label {
  margin-top: 4px;
  font-size: 10px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.col-ops {
  width: 306px;
  text-align: right;
}
.row-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 5px;
}
/* 分组徽章：色相跟分组走（ready 但没下完的行显示「未下完」，不再照抄 status） */
.badge.st-playing {
  background: var(--accent-soft);
  color: var(--accent);
}
.badge.st-downloading {
  background: var(--ok-bg);
  color: var(--ok);
}
.badge.st-preparing {
  background: rgb(255 255 255 / 0.06);
  color: var(--text-dim);
}
.badge.st-paused {
  background: var(--warn-bg);
  color: var(--warn);
}
.badge.st-done {
  background: var(--info-bg);
  color: var(--info);
}
.badge.st-failed {
  background: var(--danger-bg);
  color: var(--danger);
}

/* ---- P40 分组：摘要图例 + 表内分组行 ---- */
.group-legend {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: var(--sp-3);
}
.gl-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border: 1px solid var(--line);
  border-radius: 999px;
  font: inherit;
  font-size: var(--fs-xs);
  color: var(--text-dim);
  background: var(--panel);
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.gl-item:hover:not(:disabled) {
  background: var(--btn-hover);
  border-color: var(--line-hover);
}
/* 选中态：描边 + 底色都跟着分组色走，一眼看出「现在只看这组」 */
.gl-item.active {
  border-color: currentColor;
  background: color-mix(in srgb, currentColor 14%, var(--panel));
  font-weight: 600;
}
.gl-item.active .gl-dot {
  box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 28%, transparent);
}
.gl-item:disabled {
  cursor: default;
}
.gl-item b {
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
/* 「显示全部」：轻量文字按钮，不做成第七个胶囊 */
.gl-clear {
  padding: 3px 8px;
  border: 1px solid transparent;
  border-radius: 999px;
  font: inherit;
  font-size: var(--fs-xs);
  color: var(--accent);
  background: none;
  cursor: pointer;
}
.gl-clear:hover {
  border-color: var(--line-hover);
  background: var(--btn-hover);
}
.gl-item.zero {
  opacity: 0.45;
}
.gl-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-faint);
  flex: none;
}
/* 分组色：与徽章同一套语义 */
.gl-item.g-playing {
  color: var(--accent);
}
.gl-item.g-playing .gl-dot {
  background: var(--accent);
}
.gl-item.g-downloading {
  color: var(--ok);
}
.gl-item.g-downloading .gl-dot {
  background: var(--ok);
}
.gl-item.g-paused {
  color: var(--warn);
}
.gl-item.g-paused .gl-dot {
  background: var(--warn);
}
.gl-item.g-done {
  color: var(--info);
}
.gl-item.g-done .gl-dot {
  background: var(--info);
}
.gl-item.g-failed {
  color: var(--danger);
}
.gl-item.g-failed .gl-dot {
  background: var(--danger);
}
/* 表内分组行：横向铺满，右侧跟一行判定规则 */
.grp-row td {
  padding-top: 10px;
  padding-bottom: 6px;
  background: var(--panel-hover);
  border-top: 1px solid var(--line);
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
tbody tr.grp-row:hover td {
  background: var(--panel-hover);
}
/* 筛选组已空：一行说明 + 回到全部，不留空表 */
.grp-empty td {
  padding: 18px 12px;
  color: var(--text-dim);
  font-size: var(--fs-xs);
}
.grp-empty .mini {
  margin-left: 8px;
}
.grp-name {
  margin-left: 6px;
  color: var(--text);
  font-weight: 600;
}
.grp-count {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--btn-hover);
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.grp-rule {
  margin-left: 10px;
  color: var(--text-faint);
  font-size: 10px;
}
.grp-row.g-playing .gl-dot {
  background: var(--accent);
}
.grp-row.g-downloading .gl-dot {
  background: var(--ok);
}
.grp-row.g-paused .gl-dot {
  background: var(--warn);
}
.grp-row.g-done .gl-dot {
  background: var(--info);
}
.grp-row.g-failed .gl-dot {
  background: var(--danger);
}
/* 「自动」标记：这次暂停不是用户按的，而是给播放任务让位 */
.auto-tag {
  margin-left: 5px;
  padding: 0 4px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  font-size: 10px;
  color: var(--text-faint);
  vertical-align: 1px;
}

/* 窄窗口：按重要性依次收起「保留至 → 速度」，保住任务名与操作 */
@media (max-width: 1100px) {
  .table-wrap table {
    min-width: 660px;
  }
  .col-retain {
    display: none;
  }
  .col-ops {
    width: 280px;
  }
}
@media (max-width: 860px) {
  .col-speed {
    display: none;
  }
  .table-wrap table {
    min-width: 560px;
  }
  .col-ops {
    width: 250px;
  }
  .row-actions .mini {
    min-height: 24px;
    padding: 0 7px;
  }
}
</style>
