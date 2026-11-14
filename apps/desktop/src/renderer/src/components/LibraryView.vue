<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { CacheMode, Favorite, Task, WatchProgress } from '@polyframe/shared'
import { usePlayerStore } from '../stores/player'
import { useCatalogStore } from '../stores/catalog'
import { useHistoryStore } from '../stores/history'
import { buildVideoGroups, type VideoGroup } from '../lib/video-groups'
import { thumbLoader, type ThumbState } from '../lib/thumb-loader'
import CleanupDialog from './CleanupDialog.vue'
import CleanupMenu from './CleanupMenu.vue'
import {
  FAVORITE_RULES,
  TASK_RULES,
  favoritesByRule,
  fmtBytes,
  previewNames,
  summarizeTasks,
  tasksByRule,
  type CleanupMenuItem,
  type FavoriteRuleKey,
  type TaskRuleKey
} from '../lib/cleanup'

const store = usePlayerStore()
const catalog = useCatalogStore()
const history = useHistoryStore()

/** tab：下载 = 本地任务卡片墙；收藏 = 在线收藏（P7） */
const tab = ref<'downloads' | 'favorites'>('downloads')

onMounted(() => {
  // 下载 tab 也需要收藏：任务归到「哪个视频」靠收藏剧集 URL 精确匹配，
  // 封面也来自收藏各站海报。只在收藏 tab 拉会让聚合永远退化成「一任务一卡」。
  refreshVideoSources()
  // P9 继续观看
  catalog.refreshContinueWatching().catch(() => {})
  // P11 后台巡检状态（后台任务已落库，这里只读状态）
  catalog.loadAutoScan().catch(() => {})
})

/**
 * P33 拉聚合所需的旁路数据：收藏列表 → 各收藏的片源快照 → 播放历史（封面兜底）。
 * 收藏变了就把片源缓存作废重拉，否则新收藏的片永远归不到组里。
 */
function refreshVideoSources(force = false): void {
  void (async () => {
    try {
      if (!catalog.favorites.length) await catalog.refreshFavorites()
      await catalog.loadAllFavoriteSources(force)
    } catch {
      // 收藏拉不到不影响任务墙本身，只是归并率下降
    }
    if (!history.items.length) await history.refresh().catch(() => {})
  })()
}

/** P11 巡检状态文案 */
const autoscanLabel = computed(() => {
  const a = catalog.autoscan
  if (!a?.lastRunMs) return ''
  const t = new Date(a.lastRunMs)
  const hm = t.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
  const day = t.toLocaleDateString('zh-CN')
  const sameDay = new Date().toLocaleDateString('zh-CN') === day
  // 文案要和旁边的「巡检间隔」下拉区分开：一个是「上次结果」，一个是「下次频率」
  const base = a.lastAdded > 0 ? `上次 +${a.lastAdded} 集` : '上次无更新'
  return `${base} · ${sameDay ? hm : day}`
})

/** P13 巡检间隔 title 文案 */
const autoscanTitle = computed(() => {
  const h = catalog.autoscan?.intervalHours ?? 6
  return h === 0 ? '后台自动巡检已关闭，可在右侧重新开启' : `内核每 ${h} 小时自动巡检一次收藏更新`
})

/** P13 巡检间隔修改（0 = 关闭） */
const intervalSaving = ref(false)
async function onIntervalChange(e: Event) {
  const hours = Number((e.target as HTMLSelectElement).value)
  intervalSaving.value = true
  try {
    await catalog.setAutoScanInterval(hours)
  } finally {
    intervalSaving.value = false
  }
}

function switchTab(t: 'downloads' | 'favorites') {
  tab.value = t
  // 切 tab 就退出选择态：勾选是「这两个 tab 各自的事」，
  // 带着上一页的选中去另一页会让人以为选中的是这边的条目。
  selectMode.value = false
  picked.value = {}
  favSelectMode.value = false
  pickedFavs.value = {}
  if (t === 'favorites' && !catalog.favorites.length) catalog.refreshFavorites().catch(() => {})
  if (t === 'favorites') catalog.refreshContinueWatching().catch(() => {})
}

/** 新建在前 */
const items = computed(() => [...store.tasks].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)))
const favItems = computed(() => catalog.favorites)

/**
 * P33 视频维度聚合：同一部片的多条任务（多集 / 多线路）并到一张卡。
 *
 * 归属证据见 `lib/video-groups.ts`：收藏剧集 URL 精确命中 > 收藏名完全相同 >
 * 播放历史 > 集数目录 > 独立。缩略图由各片源封面归并去重而来。
 */
const groups = computed<VideoGroup[]>(() =>
  buildVideoGroups({
    tasks: store.tasks,
    favorites: catalog.favorites,
    sourcesByFav: catalog.sourcesByFav,
    history: history.items
  })
)

// ---- P32 检索与筛选 ----
//
// 原来的工具条只有「检查更新」，任务/收藏一多就只能滚动找。
// 这里补两个能力：按标题或 URL 搜索、按任务状态过滤（带计数）。
const downloadQuery = ref('')
const downloadFilter = ref<'all' | 'active' | 'done' | 'failed'>('all')
const favoriteQuery = ref('')

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '进行中' },
  { key: 'done', label: '已完成' },
  { key: 'failed', label: '失败' }
] as const

/**
 * 筛选与计数都改到「视频组」这一维。
 *
 * 按任务计数会自相矛盾：一部 6 集的剧算 6 个，但界面上只有 1 张卡，
 * 用户点「进行中 3」却只看到 1 张卡会以为筛选坏了。
 */
const counts = computed(() => {
  const c = { all: groups.value.length, active: 0, done: 0, failed: 0 }
  for (const g of groups.value) c[g.status] += 1
  return c
})

const filteredGroups = computed(() => {
  const q = downloadQuery.value.trim().toLowerCase()
  return groups.value.filter((g) => {
    if (downloadFilter.value !== 'all' && g.status !== downloadFilter.value) return false
    if (!q) return true
    if (g.title.toLowerCase().includes(q) || g.subtitle.toLowerCase().includes(q)) return true
    return g.tasks.some((t) => t.url.toLowerCase().includes(q))
  })
})

/** 兼容旧模板里的「有数据但被筛空」判断 */
const hasAnyTask = computed(() => groups.value.length > 0)

// ---- P33 缩略图：懒加载 + 归并展示 ----
//
// 缩略图是网络资源（走内核 /pic/ 代理），不能一屏几十张同时发请求：
// 用 IntersectionObserver 看到才加载，加载器内部还有并发闸门与去重。
const thumbVersion = ref(0)
let stopThumbSub: (() => void) | null = null

function thumbState(url: string): ThumbState {
  // 读一下 version 让模板对加载状态保持响应（loader 是普通 class，不是响应式对象）
  void thumbVersion.value
  return url ? thumbLoader.peek(url) : 'error'
}

function coverOf(g: VideoGroup): string {
  return g.thumbs[0]?.url ?? ''
}

/** 组内多图：点角标展开缩略图条，展开时把剩余几张一次性加载 */
const openStrips = ref<Record<string, boolean>>({})
function toggleStrip(g: VideoGroup): void {
  const next = !openStrips.value[g.key]
  openStrips.value = { ...openStrips.value, [g.key]: next }
  if (next) for (const t of g.thumbs) thumbLoader.load(t.url)
}

let observer: IntersectionObserver | null = null
/** 观察所有带 data-thumb 的卡片；列表变化后重绑（已加载过的会自动跳过） */
function bindThumbObserver(): void {
  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue
          const el = e.target as HTMLElement
          const url = el.dataset.thumb
          // 展开条时提前把组内其它图也排上队，避免点开才转圈
          const extra = el.dataset.thumbs
          if (url) thumbLoader.load(url)
          if (extra) for (const u of extra.split('\n')) thumbLoader.load(u)
          observer?.unobserve(el)
        }
      },
      // 提前 240px 触发：滚动到卡片时图基本已经就位
      { rootMargin: '240px 0px' }
    )
  }
  const root = document.querySelector('.library-view')
  if (!root) return
  root.querySelectorAll<HTMLElement>('.vg[data-thumb]').forEach((el) => observer?.observe(el))
}

/** 列表结构或封面变化后重绑（只比 key + 封面，避免进度 tick 也重绑） */
const thumbSignature = computed(() => filteredGroups.value.map((g) => `${g.key}|${coverOf(g)}`).join(';'))
watch(thumbSignature, () => void nextTick(bindThumbObserver), { flush: 'post' })
onMounted(() => {
  stopThumbSub = thumbLoader.subscribe(() => {
    thumbVersion.value += 1
  })
  void nextTick(bindThumbObserver)
})
onBeforeUnmount(() => {
  stopThumbSub?.()
  observer?.disconnect()
  observer = null
})

/** 组内状态文案：让「3 集里有 1 集在下载」这种信息在卡片上就能看见 */
function groupStatusText(g: VideoGroup): string {
  const n = g.tasks.length
  if (g.status === 'active') {
    const running = g.tasks.filter((t) => t.status !== 'ready' && t.status !== 'failed').length
    return running && running < n ? `进行中 ${running}/${n}` : '进行中'
  }
  if (g.status === 'failed') {
    const bad = g.tasks.filter((t) => t.status === 'failed').length
    return bad && bad < n ? `失败 ${bad}/${n}` : '失败'
  }
  return n > 1 ? '全部就绪' : '就绪'
}

function groupStatusClass(g: VideoGroup): string {
  return g.status === 'active' ? 'active' : g.status === 'failed' ? 'failed' : 'done'
}

/** 组内最新一条任务（播放按钮直接播它 —— 通常就是想继续的那集） */
function primaryTask(g: VideoGroup): Task | undefined {
  return g.tasks[0]
}

/** 组内「查看 N 集」展开状态 */
const openTasks = ref<Record<string, boolean>>({})

/** 卡片标题：直链任务没有片名，退化成「文件名」而不是整条 URL 糊在卡上 */
function displayTitle(g: VideoGroup): string {
  const t = g.title
  if (!/^https?:/i.test(t)) return t
  try {
    const u = new URL(t)
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '')
    return last || u.host
  } catch {
    return t
  }
}

function playGroup(g: VideoGroup): void {
  const t = primaryTask(g)
  if (t) store.playTask(t)
}

/** 组内总进度：用于多任务组显示一条汇总进度条 */
function groupProgress(g: VideoGroup): number | null {
  let done = 0
  let total = 0
  for (const t of g.tasks) {
    if (!t.segTotal) continue
    done += t.segDone ?? 0
    total += t.segTotal
  }
  if (!total) return null
  return Math.min(100, Math.round((done / total) * 100))
}

const filteredFavorites = computed(() => {
  const q = favoriteQuery.value.trim().toLowerCase()
  if (!q) return favItems.value
  return favItems.value.filter(
    (f) => f.name.toLowerCase().includes(q) || (f.remarks ?? '').toLowerCase().includes(q)
  )
})

/** 继续观看最多铺两行，剩下的交给收藏网格 */
const CONTINUE_MAX = 6
const continueShown = computed(() => catalog.continueItems.slice(0, CONTINUE_MAX))

/**
 * 缩略图配色：按标题哈希取色相。
 *
 * 下载任务没有海报，原来所有卡共用同一个蓝紫渐变 + 一个播放键，
 * 六张卡长得一模一样，只能靠读标题区分。改成「一卡一色」后可以靠色块定位。
 */
function thumbStyleFor(text: string): Record<string, string> {
  const s = text || ''
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360
  return {
    background: `linear-gradient(135deg, hsl(${h} 32% 20%), hsl(${(h + 44) % 360} 28% 13%))`
  }
}

/** 缩略图水印：标题前两个字符；纯英文标题转大写（免得出现 "de" 这种像手滑的写法）；直链退化成协议名 */
function initialsOfText(text: string, protocol = ''): string {
  const s = (text || '').trim()
  if (/^https?:/i.test(s)) return protocol ? protocol.toUpperCase() : 'LINK'
  const m = s.match(/[\u4e00-\u9fa5A-Za-z0-9]{1,2}/)
  if (!m) return s.slice(0, 2)
  const raw = m[0]
  return /^[A-Za-z0-9]+$/.test(raw) ? raw.toUpperCase() : raw
}

/** 相对时间：库里看的是「多久以前」，精确到秒没有意义 */
function relTime(input: string | number): string {
  const ts = typeof input === 'number' ? input : new Date(input).getTime()
  if (!Number.isFinite(ts)) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

function clearDownloadFilter(): void {
  downloadQuery.value = ''
  downloadFilter.value = 'all'
}


const statusLabel: Record<string, string> = {
  pending: '等待',
  probing: '解析中',
  ready: '就绪',
  downloading: '下载中',
  paused: '已暂停',
  failed: '失败'
}
const cacheModeLabel: Record<CacheMode, string> = {
  online: '在线',
  stream: '边下边播',
  precache: '预缓存'
}

function titleOf(t: Task): string {
  return t.title || t.url
}
function onPlay(t: Task): void {
  store.playTask(t)
}

/** 正在执行删除的任务 id（按钮转圈 / 禁用） */
const busyId = ref('')
/**
 * 从媒体库移除任务：删除后缓存分片与记录一并消失。
 *
 * 这是破坏性操作且没有撤销，所以照旧走 confirm；失败用 toast 而不是静默吞掉。
 */
async function onDeleteTask(t: Task): Promise<void> {
  if (!window.confirm(`从媒体库移除「${titleOf(t)}」？\n该任务的缓存分片与记录会一并删除。`)) return
  busyId.value = t.id
  try {
    await store.deleteTask(t.id)
    notify('已移除')
  } catch (e) {
    notify((e as Error).message)
  } finally {
    busyId.value = ''
  }
}

// ---- P35 清理：多选 + 规则 ----
//
// 媒体库的「删」有两个维度：按视频（一部剧的全部集）和按任务（某一集）。
// 卡片墙是按视频聚合的，所以多选以「部」为单位；规则清理仍以任务为单位 ——
// 否则一部剧里只要有一集失败，「清理已完成」就会把整部剧跳过，规则形同虚设。

const selectMode = ref(false)
const picked = ref<Record<string, boolean>>({})
const pickedGroups = computed(() => groups.value.filter((g) => picked.value[g.key]))
const pickedTasks = computed(() => pickedGroups.value.flatMap((g) => g.tasks))
const pickedStat = computed(() => summarizeTasks(pickedTasks.value))
const allPicked = computed(
  () => filteredGroups.value.length > 0 && filteredGroups.value.every((g) => picked.value[g.key])
)

function toggleSelectMode(): void {
  selectMode.value = !selectMode.value
  if (!selectMode.value) picked.value = {}
  if (selectMode.value) favSelectMode.value = false
}
function toggleGroup(g: VideoGroup): void {
  picked.value = { ...picked.value, [g.key]: !picked.value[g.key] }
}
function toggleAllGroups(): void {
  if (allPicked.value) {
    picked.value = {}
    return
  }
  const next: Record<string, boolean> = {}
  for (const g of filteredGroups.value) next[g.key] = true
  picked.value = next
}
// 换筛选就清空选中：否则「已选 3 部」里有 2 部看不见，点移除时心里没底
watch([downloadQuery, downloadFilter], () => {
  if (selectMode.value) picked.value = {}
})

const downloadRuleItems = computed<CleanupMenuItem[]>(() => {
  const tasks = groups.value.flatMap((g) => g.tasks)
  return TASK_RULES.map((r) => {
    const hit = tasksByRule(tasks, r.key)
    return {
      key: r.key,
      label: r.label,
      hint: r.hint,
      count: hit.length,
      bytes: summarizeTasks(hit).bytes,
      danger: r.danger
    }
  })
})

// 收藏：多选与规则（无片源 / 无剧集 / 同名重复）
const favSelectMode = ref(false)
const pickedFavs = ref<Record<string, boolean>>({})
const pickedFavList = computed(() => filteredFavorites.value.filter((f) => pickedFavs.value[f.id]))
const allFavPicked = computed(
  () =>
    filteredFavorites.value.length > 0 &&
    filteredFavorites.value.every((f) => pickedFavs.value[f.id])
)

function toggleFavSelectMode(): void {
  favSelectMode.value = !favSelectMode.value
  if (!favSelectMode.value) pickedFavs.value = {}
  if (favSelectMode.value) {
    selectMode.value = false
    picked.value = {}
  }
}
function toggleFav(f: Favorite): void {
  pickedFavs.value = { ...pickedFavs.value, [f.id]: !pickedFavs.value[f.id] }
}
function toggleAllFavs(): void {
  if (allFavPicked.value) {
    pickedFavs.value = {}
    return
  }
  const next: Record<string, boolean> = {}
  for (const f of filteredFavorites.value) next[f.id] = true
  pickedFavs.value = next
}
watch(favoriteQuery, () => {
  if (favSelectMode.value) pickedFavs.value = {}
})

const favRuleItems = computed<CleanupMenuItem[]>(() =>
  FAVORITE_RULES.map((r) => {
    const hit = favoritesByRule(catalog.favorites, catalog.sourcesByFav, r.key)
    return { key: r.key, label: r.label, hint: r.hint, count: hit.length }
  })
)

interface PendingCleanup {
  kind: 'tasks' | 'favorites'
  ids: string[]
  titles: string[]
  /** 涉及的视频部数（任务清理时用于文案） */
  groups: number
  segs: number
  bytes: number
  source: string
}
const pending = ref<PendingCleanup | null>(null)
const cleanupBusy = ref(false)

function askRemoveGroups(list: VideoGroup[]): void {
  if (!list.length) return
  const tasks = list.flatMap((g) => g.tasks)
  pending.value = {
    kind: 'tasks',
    ids: tasks.map((t) => t.id),
    titles: tasks.map(titleOf),
    groups: list.length,
    segs: tasks.reduce((n, t) => n + (t.segDone ?? 0), 0),
    bytes: summarizeTasks(tasks).bytes,
    source: '选中的视频'
  }
}

function askRemoveFavorites(list: Favorite[]): void {
  if (!list.length) return
  pending.value = {
    kind: 'favorites',
    ids: list.map((f) => f.id),
    titles: list.map((f) => f.name),
    groups: list.length,
    segs: 0,
    bytes: 0,
    source: '选中的收藏'
  }
}

function onDownloadRule(key: string): void {
  const rule = TASK_RULES.find((r) => r.key === key)
  if (!rule) return
  const tasks = groups.value.flatMap((g) => g.tasks)
  const hit = tasksByRule(tasks, key as TaskRuleKey)
  if (!hit.length) return
  const hitIds = new Set(hit.map((t) => t.id))
  const groupCount = groups.value.filter((g) => g.tasks.some((t) => hitIds.has(t.id))).length
  pending.value = {
    kind: 'tasks',
    ids: hit.map((t) => t.id),
    titles: hit.map(titleOf),
    groups: groupCount,
    segs: hit.reduce((n, t) => n + (t.segDone ?? 0), 0),
    bytes: summarizeTasks(hit).bytes,
    source: rule.label
  }
}

function onFavoriteRule(key: string): void {
  const rule = FAVORITE_RULES.find((r) => r.key === key)
  if (!rule) return
  const hit = favoritesByRule(catalog.favorites, catalog.sourcesByFav, key as FavoriteRuleKey)
  if (!hit.length) return
  askRemoveFavorites(hit)
  if (pending.value) pending.value.source = rule.label
}

const dialogStats = computed(() => {
  const p = pending.value
  if (!p) return []
  if (p.kind === 'favorites') return [{ label: '收藏', value: `${p.ids.length} 部` }]
  return [
    { label: '视频', value: `${p.groups} 部` },
    { label: '集数', value: `${p.ids.length} 集` },
    { label: '可释放', value: fmtBytes(p.bytes) }
  ]
})
const dialogNames = computed(() => previewNames(pending.value?.titles ?? []))
const dialogTitle = computed(() => {
  const p = pending.value
  if (!p) return ''
  if (p.kind === 'favorites') return `取消收藏 ${p.ids.length} 部？`
  return p.groups > 1 ? `移除 ${p.groups} 部视频（${p.ids.length} 集）？` : `移除这 ${p.ids.length} 集？`
})
const dialogSub = computed(() => {
  const p = pending.value
  if (!p) return ''
  return p.kind === 'favorites'
    ? `${p.source}：收藏条目、片源与剧集快照会一起删除，片源站上的内容不受影响。`
    : `${p.source}：任务记录与已下载分片一并删除，无法恢复。`
})

async function runPending(): Promise<void> {
  const p = pending.value
  if (!p || cleanupBusy.value) return
  cleanupBusy.value = true
  try {
    if (p.kind === 'favorites') {
      const r = await catalog.removeFavorites(p.ids)
      notify(`已取消收藏 ${r.removed} 部${r.failed?.length ? `，${r.failed.length} 部失败` : ''}`)
      catalog.refreshContinueWatching().catch(() => {})
    } else {
      const r = await store.deleteTasks(p.ids)
      notify(`已移除 ${r.deleted ?? p.ids.length} 集，释放 ${fmtBytes(r.freedBytes)}`)
      // 分组依赖收藏/历史/任务三方快照，删完立刻重算，避免残留空组
      catalog.refreshContinueWatching().catch(() => {})
    }
    picked.value = {}
    pickedFavs.value = {}
    pending.value = null
  } catch (e) {
    notify((e as Error).message)
  } finally {
    cleanupBusy.value = false
  }
}

// 列表被清空后自动退出选择态：否则「全选/取消选择」随工具条一起消失，
// 界面会卡在一个没有任何出口的空选择态里。
watch(
  () => groups.value.length,
  (n) => {
    if (n === 0 && selectMode.value) toggleSelectMode()
  }
)
watch(
  () => catalog.favorites.length,
  (n) => {
    if (n === 0 && favSelectMode.value) toggleFavSelectMode()
  }
)

/** 收藏卡：一键播放第一片源第一集（无片源则提示去补充） */const toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | null = null
function notify(msg: string) {
  toast.value = msg
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = ''), 2600)
}
async function playFavorite(favId: string) {
  try {
    await catalog.openFavorite(favId)
    const src = catalog.favoriteSources[0]
    const ep = src?.episodes?.[0]
    if (!ep || !src) {
      notify('该片源暂无剧集，请到发现页补充片源')
      return
    }
    const title = catalog.favorites.find((f) => f.id === favId)?.name ?? ''
    // P20/P22：把片源信息带给播放页侧栏，带 api 才能跨源换
    await catalog.playFavoriteEpisode(ep, title, src.episodes, {
      siteName: src.siteName,
      api: src.api,
      vodId: src.vodId,
      groups: [{ from: src.siteName || '片源', episodes: src.episodes }],
      groupIndex: 0
    })
  } catch (e) {
    notify((e as Error).message)
  }
}
async function onFavRemove(favId: string) {
  await catalog.removeFavorite(favId).catch((e) => notify((e as Error).message))
}
function playedLabel(ts?: number | null): string {
  if (!ts) return ''
  return new Date(ts).toLocaleDateString('zh-CN')
}

// ---- P9 追更 / 继续观看（吸收 GYING） ----

/** 检查收藏更新：回拉全部片源对比集数 */
async function checkUpdates() {
  try {
    const list = await catalog.refreshFavoriteUpdates()
    notify(list.length ? `${list.length} 部收藏有更新（共 +${list.reduce((n, u) => n + u.added, 0)} 集）` : '全部收藏暂无更新')
  } catch (e) {
    notify((e as Error).message)
  }
}

/** 追更徽章（打开片源弹层后清除） */
function badgeOf(favId: string): number {
  return catalog.favUpdates[favId] ?? 0
}

/** 进度百分比（封顶 99%，播完的不再出现在继续观看行） */
function pctOfWatch(w: WatchProgress): number {
  if (w.durationSec <= 0) return 0
  return Math.min(99, Math.round((w.positionSec / w.durationSec) * 100))
}

async function resume(w: WatchProgress) {
  try {
    await catalog.resumeProgress(w)
  } catch (e) {
    notify((e as Error).message)
  }
}
</script>

<template>
  <div class="library-view">
    <div class="lib-bar">
      <div class="segmented" role="tablist" aria-label="媒体库分类">
        <button
          role="tab"
          :aria-selected="tab === 'downloads'"
          :class="{ active: tab === 'downloads' }"
          @click="switchTab('downloads')"
        >
          下载内容（{{ groups.length }}）
        </button>
        <button
          role="tab"
          :aria-selected="tab === 'favorites'"
          :class="{ active: tab === 'favorites' }"
          @click="switchTab('favorites')"
        >
          收藏（{{ favItems.length }}）
        </button>
      </div>
      <div class="lib-tools">
        <!-- 下载：搜索 + 状态筛选（原来的工具条这里是空的，任务一多只能往下翻） -->
        <template v-if="tab === 'downloads' && items.length">
          <!-- 选择态收起搜索/筛选，把位置让给「已选 N 部」与移除按钮 -->
          <template v-if="!selectMode">
            <input
              v-model="downloadQuery"
              class="lib-search"
              type="search"
              spellcheck="false"
              placeholder="搜索任务标题 / 链接"
              aria-label="搜索任务"
            />
            <div class="chips" role="group" aria-label="按状态筛选">
              <button
                v-for="f in FILTERS"
                :key="f.key"
                class="chip"
                :class="{ active: downloadFilter === f.key }"
                :disabled="f.key !== 'all' && counts[f.key] === 0"
                @click="downloadFilter = f.key"
              >
                {{ f.label }}<span class="chip-n">{{ counts[f.key] }}</span>
              </button>
            </div>
          </template>
          <div v-else class="sel-bar">
            <label class="sel-all">
              <input type="checkbox" :checked="allPicked" @change="toggleAllGroups" />
              全选
            </label>
            <span class="sel-info">
              已选 <b>{{ pickedGroups.length }}</b> 部
              <template v-if="pickedTasks.length">
                · {{ pickedTasks.length }} 集 · {{ fmtBytes(pickedStat.bytes) }}
              </template>
            </span>
            <button
              class="mini danger"
              :disabled="!pickedTasks.length || cleanupBusy"
              title="移除选中视频的全部集与缓存"
              @click="askRemoveGroups(pickedGroups)"
            >
              移除
            </button>
          </div>
          <CleanupMenu
            v-if="!selectMode"
            :items="downloadRuleItems"
            :disabled="cleanupBusy"
            @select="onDownloadRule"
          />
          <button
            class="btn ghost sm"
            :class="{ active: selectMode }"
            :title="selectMode ? '退出多选' : '进入多选，按视频批量移除'"
            @click="toggleSelectMode"
          >
            {{ selectMode ? '取消选择' : '选择' }}
          </button>
        </template>
        <!-- 收藏：搜索 + 巡检间隔 + 检查更新（原来「自动巡检」出现两次，读起来像重复控件） -->
        <template v-if="tab === 'favorites' && favItems.length">
          <template v-if="!favSelectMode">
            <input
              v-model="favoriteQuery"
              class="lib-search"
              type="search"
              spellcheck="false"
              placeholder="搜索收藏"
              aria-label="搜索收藏"
            />
            <span v-if="catalog.autoscan" class="autoscan-note" :title="autoscanTitle">
              {{ autoscanLabel }}
            </span>
            <label class="autoscan-interval" title="后台自动追更巡检的运行间隔">
              巡检间隔
              <select
                class="interval-select"
                :value="catalog.autoscan?.intervalHours ?? 6"
                :disabled="intervalSaving"
                @change="onIntervalChange"
              >
                <option :value="0">关闭</option>
                <option :value="1">每 1 小时</option>
                <option :value="3">每 3 小时</option>
                <option :value="6">每 6 小时</option>
                <option :value="12">每 12 小时</option>
                <option :value="24">每天</option>
                <option :value="72">每 3 天</option>
              </select>
            </label>
            <button
              class="btn sm ghost"
              :disabled="catalog.refreshing"
              title="回拉各片源站详情，对比集数更新收藏快照"
              @click="checkUpdates"
            >
              {{ catalog.refreshing ? '检查中…' : '检查更新' }}
            </button>
          </template>
          <div v-else class="sel-bar">
            <label class="sel-all">
              <input type="checkbox" :checked="allFavPicked" @change="toggleAllFavs" />
              全选
            </label>
            <span class="sel-info">已选 <b>{{ pickedFavList.length }}</b> 部</span>
            <button
              class="mini danger"
              :disabled="!pickedFavList.length || cleanupBusy"
              @click="askRemoveFavorites(pickedFavList)"
            >
              取消收藏
            </button>
          </div>
          <CleanupMenu
            v-if="!favSelectMode"
            :items="favRuleItems"
            :disabled="cleanupBusy"
            @select="onFavoriteRule"
          />
          <button
            class="btn ghost sm"
            :class="{ active: favSelectMode }"
            :title="favSelectMode ? '退出多选' : '进入多选，批量取消收藏'"
            @click="toggleFavSelectMode"
          >
            {{ favSelectMode ? '取消选择' : '选择' }}
          </button>
        </template>
      </div>
    </div>

    <!-- 下载内容（P33：按视频聚合，同一部片的多集/多线路并成一张卡） -->
    <template v-if="tab === 'downloads'">
      <div class="grid video-grid" v-if="filteredGroups.length">
        <div
          v-for="g in filteredGroups"
          :key="g.key"
          class="card vg"
          :class="{ picked: selectMode && picked[g.key], picking: selectMode }"
          :data-thumb="coverOf(g)"
          :data-thumbs="g.thumbs.slice(1).map((t) => t.url).join('\n')"
          @click="selectMode && toggleGroup(g)"
        >
          <div
            class="vg-cover"
            :class="{ 'has-img': thumbState(coverOf(g)) === 'ready' }"
            :style="thumbState(coverOf(g)) === 'ready' ? undefined : thumbStyleFor(g.title)"
          >
            <!-- 选择态：勾选框盖在封面左上，角标顺次下移 -->
            <label v-if="selectMode" class="pick-box" @click.stop>
              <input
                type="checkbox"
                :checked="!!picked[g.key]"
                :aria-label="`选择 ${displayTitle(g)}`"
                @change="toggleGroup(g)"
              />
            </label>
            <img
              v-if="coverOf(g) && thumbState(coverOf(g)) === 'ready'"
              class="vg-img"
              :src="coverOf(g)"
              alt=""
              loading="lazy"
              decoding="async"
            />
            <span v-else class="vg-initials" aria-hidden="true">
              {{ initialsOfText(g.title, primaryTask(g)?.protocol) }}
            </span>

            <!-- 组内任务数：让人一眼看出这是「一部剧的 N 集」而不是 N 个视频 -->
            <span v-if="g.tasks.length > 1" class="vg-count">{{ g.tasks.length }} 集</span>

            <!-- 多张缩略图归并在这张卡上：角标点开看全部 -->
            <button
              v-if="!selectMode && g.thumbs.length > 1"
              class="vg-multi"
              :title="`该视频有 ${g.thumbs.length} 张封面`"
              @click.stop="toggleStrip(g)"
            >
              {{ openStrips[g.key] ? '收起' : `+${g.thumbs.length - 1}` }}
            </button>

            <!-- 单任务组：hover 才露出的移除（管理动作不堆在卡面上） -->
            <button
              v-if="!selectMode && g.tasks.length === 1 && primaryTask(g)"
              class="thumb-del"
              title="从媒体库移除"
              :disabled="busyId === primaryTask(g)!.id"
              @click.stop="onDeleteTask(primaryTask(g)!)"
            >
              ×
            </button>

            <button v-if="!selectMode" class="play-btn" title="播放" @click.stop="playGroup(g)">▶</button>
          </div>

          <div class="body">
            <div class="title" :title="g.title">{{ displayTitle(g) }}</div>
            <div class="meta">
              <span class="badge" :class="`st-${groupStatusClass(g)}`">{{ groupStatusText(g) }}</span>
              <span v-if="g.origin === 'favorite'" class="badge mode">收藏</span>
              <span v-if="g.subtitle" class="vg-sub ellipsis" :title="g.subtitle">{{ g.subtitle }}</span>
            </div>

            <div
              v-if="groupProgress(g) !== null && groupProgress(g)! > 0 && groupProgress(g)! < 100"
              class="progress-wrap"
            >
              <div class="progress"><div class="bar" :style="{ width: groupProgress(g) + '%' }"></div></div>
              <span class="mono dim small">{{ groupProgress(g) }}%</span>
            </div>

            <div class="dim small time">
              {{ relTime(g.updatedAt) }}
              <template v-if="g.tasks.length > 1"> · {{ g.tasks.length }} 个任务</template>
            </div>

            <!-- 同一视频的其余缩略图（去重后归并在这里，不再分散到别的卡） -->
            <div v-if="openStrips[g.key]" class="vg-strip">
              <figure v-for="t in g.thumbs" :key="t.key" class="vg-thumb" :title="t.source">
                <img v-if="thumbState(t.url) === 'ready'" :src="t.url" alt="" loading="lazy" />
                <span v-else class="vg-thumb-ph">
                  {{ thumbState(t.url) === 'error' ? '失败' : '…' }}
                </span>
                <figcaption>{{ t.source }}</figcaption>
              </figure>
            </div>

            <!-- 组内任务：多集/多线路时展开，播放与移除逐个操作 -->
            <div v-if="g.tasks.length > 1" class="vg-tasks">
              <button class="vg-task-toggle" @click.stop="openTasks[g.key] = !openTasks[g.key]">
                {{ openTasks[g.key] ? '收起集数' : `查看 ${g.tasks.length} 集` }}
              </button>
              <div v-if="openTasks[g.key]" class="vg-task-list">
                <div
                  v-for="t in g.tasks"
                  :key="t.id"
                  class="vg-task-row"
                  :title="`${titleOf(t)} · ${cacheModeLabel[t.cacheMode]} · 点击播放`"
                  @click="onPlay(t)"
                >
                  <span class="vt-dot" :class="`d-${t.status}`"></span>
                  <span class="vt-name">{{ titleOf(t) }}</span>
                  <span class="vt-state">{{ statusLabel[t.status] ?? t.status }}</span>
                  <button
                    class="vt-del"
                    title="移除"
                    :disabled="busyId === t.id"
                    @click.stop="onDeleteTask(t)"
                  >
                    ×
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 有数据但被筛选/搜索清空：跟「媒体库为空」是两回事 -->
      <div v-else-if="hasAnyTask" class="card empty empty-lite">
        <div class="empty-title">没有匹配的视频</div>
        <div class="empty-sub">
          {{ downloadQuery ? `没有标题或链接包含「${downloadQuery}」的视频` : '当前筛选下没有视频' }}
        </div>
        <button class="btn ghost" @click="clearDownloadFilter">清除筛选</button>
      </div>
      <div v-else class="card empty">
        <div class="empty-ico">📥</div>
        <div class="empty-title">媒体库为空</div>
        <div class="empty-sub">到「播放」页粘贴 HLS / MP4 链接即可添加，同一部片的多集会归并成一张卡。</div>
        <button class="btn primary" @click="store.go('player')">去播放页</button>
      </div>
    </template>

    <!-- 收藏 -->
    <template v-else>
      <!-- P9 继续观看行：最多两行，避免和下方收藏网格重复铺满首屏 -->
      <div v-if="continueShown.length" class="continue-row">
        <div class="row-head">
          <h3 class="row-title">继续观看</h3>
          <span v-if="catalog.continueItems.length > continueShown.length" class="row-more dim small">
            共 {{ catalog.continueItems.length }} 部
          </span>
        </div>
        <div class="continue-list">
          <div v-for="w in continueShown" :key="w.favoriteId" class="continue-card" @click="resume(w)">
            <div class="continue-poster">
              <img v-if="w.poster" :src="catalog.posterUrl(w.poster)" loading="lazy" alt="" />
              <div v-else class="poster-fallback">无海报</div>
              <div class="continue-bar"><div class="continue-fill" :style="{ width: pctOfWatch(w) + '%' }"></div></div>
            </div>
            <div class="continue-meta">
              <div class="continue-name" :title="w.favoriteName">{{ w.favoriteName }}</div>
              <div class="dim small">{{ w.episodeName }} · {{ pctOfWatch(w) }}%</div>
            </div>
            <button class="mini resume-btn" @click.stop="resume(w)">续播</button>
          </div>
        </div>
      </div>
      <div class="grid" v-if="filteredFavorites.length">
        <div
          v-for="f in filteredFavorites"
          :key="f.id"
          class="card item fav"
          :class="{ picked: favSelectMode && pickedFavs[f.id], picking: favSelectMode }"
          @click="favSelectMode && toggleFav(f)"
        >
          <div class="thumb poster">
            <img v-if="f.poster" :src="catalog.posterUrl(f.poster)" loading="lazy" alt="" />
            <div v-else class="poster-fallback">无海报</div>
            <label v-if="favSelectMode" class="pick-box" @click.stop>
              <input
                type="checkbox"
                :checked="!!pickedFavs[f.id]"
                :aria-label="`选择 ${f.name}`"
                @change="toggleFav(f)"
              />
            </label>
            <span class="proto-tag">▲ {{ f.sourceCount }} 片源</span>
            <button v-if="!favSelectMode" class="play-btn" title="播放" @click="playFavorite(f.id)">▶</button>
          </div>
          <div class="body">
            <!-- 追更徽章跟着标题走：它是最重要的动态信息，不能被 meta 行的省略号裁掉 -->
            <div class="title-row">
              <div class="title" :title="f.name">{{ f.name }}</div>
              <span v-if="badgeOf(f.id)" class="badge upd" title="追更发现的新集数，打开片源后清除">
                +{{ badgeOf(f.id) }} 集
              </span>
            </div>
            <div class="meta">
              <span v-if="f.year" class="badge mode">{{ f.year }}</span>
              <span v-if="f.typeName" class="badge mode">{{ f.typeName }}</span>
              <span v-if="f.remarks" class="badge mode ellipsis" :title="f.remarks">{{ f.remarks }}</span>
            </div>
            <div class="dim small time">
              {{ f.lastPlayedAt ? `最近播放 ${playedLabel(f.lastPlayedAt)}` : `收藏于 ${f.createdAt.slice(0, 10)}` }}
            </div>
            <div class="fav-actions">
              <button class="mini" @click="playFavorite(f.id)">播放</button>
              <button class="mini danger" @click="onFavRemove(f.id)">取消收藏</button>
            </div>
          </div>
        </div>
      </div>
      <div v-else-if="favItems.length" class="card empty empty-lite">
        <div class="empty-title">没有匹配的收藏</div>
        <div class="empty-sub">没有名称或备注包含「{{ favoriteQuery }}」的收藏</div>
        <button class="btn ghost" @click="favoriteQuery = ''">清除搜索</button>
      </div>
      <div v-else class="card empty">
        <div class="empty-ico">⭐</div>
        <div class="empty-title">还没有收藏</div>
        <div class="empty-sub">到「发现」页搜索影片，点卡片上的「收藏」即可把多站片源聚合成一个条目，支持连播、续播与追更。</div>
        <button class="btn primary" @click="store.goDiscover()">去发现页</button>
      </div>
    </template>
    <CleanupDialog
      :open="!!pending"
      :title="dialogTitle"
      :subtitle="dialogSub"
      :stats="dialogStats"
      :names="dialogNames.shown"
      :rest="dialogNames.rest"
      :note="
        pending?.kind === 'favorites'
          ? '取消收藏只影响本地收藏夹，片源站上的内容不受影响。'
          : '清理只影响本地缓存与任务记录，收藏与播放历史不受影响。'
      "
      :confirm-text="pending?.kind === 'favorites' ? '取消收藏' : '移除内容'"
      :busy="cleanupBusy"
      :danger="true"
      @cancel="pending = null"
      @confirm="runPending"
    />
    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>

<style scoped>
.library-view {
  width: 100%;
}
/* 顶部工具条：分段控件在左，追更工具在右，窄屏自动堆叠 */
.lib-bar {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-wrap: wrap;
  margin-bottom: var(--sp-4);
}
.lib-tools {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-wrap: wrap;
}
.autoscan-note {
  font-size: var(--fs-2xs);
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.autoscan-interval {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-2xs);
  color: var(--text-dim);
  white-space: nowrap;
}
.interval-select {
  width: auto;
  padding: 3px 24px 3px 7px;
  font-size: var(--fs-2xs);
  min-height: 0;
  border-radius: var(--r-sm);
}
.badge.upd {
  background: var(--warn-bg);
  color: var(--warn);
}

/* ---- P32 搜索与筛选 ---- */
.lib-search {
  width: 190px;
  min-height: 30px;
  padding: 0 10px;
  font-size: var(--fs-2xs);
  border-radius: var(--r-sm);
}
.chips {
  display: flex;
  gap: 4px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 0;
  padding: 3px 9px;
  border-radius: var(--r-pill);
  border: 1px solid var(--line);
  background: var(--panel-2);
  color: var(--text-dim);
  font-size: var(--fs-2xs);
  box-shadow: none;
}
.chip:hover:not(:disabled) {
  border-color: var(--line-2);
  background: var(--panel-3);
  color: var(--text);
  transform: none;
}
.chip.active {
  background: var(--accent-soft);
  border-color: transparent;
  color: var(--accent-ink);
  font-weight: 600;
}
.chip:disabled {
  opacity: 0.42;
}
.chip-n {
  font-variant-numeric: tabular-nums;
  opacity: 0.7;
}
/* 缓存档位：从 pill 降级为一行小字，把视觉权重让给状态徽章 */
.mode-text {
  align-self: center;
  font-size: var(--fs-2xs);
  color: var(--text-faint);
}

/* ---- 继续观看：一屏能放下的横向小卡 ---- */
.continue-row {
  margin-bottom: var(--sp-5);
}
.row-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-3);
  margin-bottom: var(--sp-2);
}
.row-title {
  margin: 0 0 var(--sp-2);
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text);
}
.row-head .row-title {
  margin-bottom: 0;
}
.row-more {
  font-size: var(--fs-2xs);
  color: var(--text-faint);
}
/*
 * 无匹配态：与「库为空」区分开。
 * 库为空是引导（大留白 + 图标 + 主按钮），无匹配只是「换个词」，占满整屏反而像出错了。
 */
.card.empty.empty-lite {
  max-width: 460px;
  margin: var(--sp-6) auto;
  padding: var(--sp-6) var(--sp-5);
  gap: 6px;
}
.card.empty.empty-lite .empty-title {
  font-size: var(--fs-sm);
}
.continue-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(248px, 100%), 1fr));
  gap: var(--sp-2);
}
.continue-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--panel);
  cursor: pointer;
  transition: border-color var(--t-base) var(--ease), background var(--t-base) var(--ease);
}
.continue-card:hover {
  border-color: var(--accent-line);
  background: var(--panel-hover);
}
.continue-poster {
  position: relative;
  width: 40px;
  aspect-ratio: 2 / 3;
  border-radius: var(--r-sm);
  overflow: hidden;
  background: var(--panel-2);
  flex: none;
}
.continue-poster img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.continue-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: rgb(0 0 0 / 0.5);
}
.continue-fill {
  height: 100%;
  background: var(--accent);
}
.continue-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.continue-name {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.continue-meta .dim {
  font-size: var(--fs-2xs);
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.resume-btn {
  flex: none;
}

/* ---- 卡片墙：下载与收藏共用同一骨骼 ---- */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(var(--pf-card-min), 100%), 1fr));
  gap: var(--sp-4);
}
.item {
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
  border-radius: var(--r-lg);
  transition: border-color var(--t-base) var(--ease), transform var(--t-base) var(--ease),
    box-shadow var(--t-base) var(--ease);
}
.item:hover {
  border-color: var(--line-hover);
  transform: translateY(-2px);
  box-shadow: var(--shadow-2);
}
.thumb {
  position: relative;
  aspect-ratio: 16 / 9;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, var(--fallback-a), var(--fallback-b));
  overflow: hidden;
}
.thumb.poster {
  aspect-ratio: 2 / 3;
}
/*
 * 海报必须脱离 flex 流。
 * 之前 img 是 flex item（width/height 100%），SVG/大图会以固有宽度 240px 撑开 .thumb
 * （实测卡片宽 145，内容宽 240），居中后播放键被推到卡片右边缘外面、被 overflow 裁掉半个。
 */
.thumb.poster img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform var(--t-slow) var(--ease);
}
.item:hover .thumb.poster img {
  transform: scale(1.03);
}
/* 无海报时的下载卡：标题首字做水印，一卡一色（色相由标题哈希决定） */
.thumb-initials {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding-bottom: 4px;
  font-size: 30px;
  font-weight: 700;
  letter-spacing: 2px;
  color: rgb(255 255 255 / 0.17);
  pointer-events: none;
  user-select: none;
}
/* 移除按钮：hover 才出现，避免常驻一堆红叉 */
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
  color: var(--ov-text);
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
.poster-fallback {
  color: var(--text-faint);
  font-size: var(--fs-2xs);
}
/* 协议标签：左上角，半透明深底 */
.proto-tag {
  position: absolute;
  top: 8px;
  left: 8px;
  padding: 1px 7px;
  border-radius: var(--r-sm);
  background: rgb(6 9 14 / 0.72);
  border: 1px solid rgb(255 255 255 / 0.1);
  backdrop-filter: blur(4px);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.6px;
  color: var(--ov-dim);
}
.play-btn {
  width: 46px;
  height: 46px;
  min-height: 0;
  padding: 0 0 0 3px;
  border-radius: 50%;
  border: 1px solid rgb(255 255 255 / 0.22);
  background: color-mix(in srgb, var(--accent) 86%, transparent);
  color: #fff;
  font-size: 14px;
  backdrop-filter: blur(6px);
  transition: transform var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
}
.play-btn:hover:not(:disabled) {
  background: var(--accent-hi);
  border-color: rgb(255 255 255 / 0.4);
  transform: scale(1.06);
}
/* 下载卡：播放键挪到右下角，中间整块留给标题水印 */
.thumb:not(.poster) .play-btn {
  position: absolute;
  right: 8px;
  bottom: 8px;
  width: 34px;
  height: 34px;
  padding-left: 2px;
  font-size: 12px;
}
/* 收藏卡：海报上只留一个「按需出现」的播放键 —— 卡片底部已经有「播放」按钮，常驻两个太吵 */
.thumb.poster .play-btn {
  opacity: 0;
  transform: scale(0.9);
}
.item:hover .thumb.poster .play-btn,
.thumb.poster .play-btn:focus-visible {
  opacity: 1;
  transform: scale(1);
}
.body {
  display: flex;
  flex-direction: column;
  gap: 7px;
  flex: 1;
  padding: 10px 12px 12px;
}
.title {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.title-row .title {
  flex: 1;
  min-width: 0;
}
/*
 * 元信息固定一行。
 * 原来是 flex-wrap，卡片一窄「年份 / 类型 / 备注」就折成两行，
 * 同一行卡片的标题基线错位、下半部分高度参差。
 */
.meta {
  display: flex;
  gap: 5px;
  flex-wrap: nowrap;
  overflow: hidden;
}
.meta .badge {
  flex: none;
  white-space: nowrap;
}
/* 备注最长，允许它被省略（完整内容在 title 里） */
.meta .badge.ellipsis {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.badge.mode {
  background: rgb(255 255 255 / 0.06);
  color: var(--text-dim);
}
/* 任务状态：用语义色三元组，不再逐个硬编码 */
.badge.st-downloading {
  background: var(--ok-bg);
  color: var(--ok);
}
.badge.st-paused {
  background: var(--warn-bg);
  color: var(--warn);
}
.badge.st-ready {
  background: var(--info-bg);
  color: var(--info);
}
.badge.st-failed {
  background: var(--danger-bg);
  color: var(--danger);
}
.progress-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}
.progress-wrap .progress {
  flex: 1;
}
.progress-wrap .dim {
  font-size: var(--fs-2xs);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.time {
  font-size: var(--fs-2xs);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.fav-actions {
  display: flex;
  gap: 6px;
  margin-top: auto;
}
.fav-actions .btn {
  flex: 1;
}

@media (max-width: 640px) {
  .lib-tools {
    width: 100%;
    margin-left: 0;
    justify-content: space-between;
  }
  .continue-list {
    grid-template-columns: 1fr;
  }
  .grid {
    gap: 10px;
  }
}

/* ---- P33 视频聚合卡：一张卡 = 一部片，缩略图归并在这里 ---- */
.video-grid {
  grid-template-columns: repeat(auto-fill, minmax(min(168px, 100%), 1fr));
  /*
   * 卡片按自身内容高度排列，不拉平。
   * 拉平（stretch）在「展开缩略图/集数」时会把同行其它卡撑出一大片空白，
   * 而不展开时各卡内容结构一致、高度本来就接近。
   */
  align-items: start;
}
.vg {
  display: flex;
  flex-direction: column;
  /*
   * min-width: 0 必须写。
   * grid 的 1fr 是 minmax(auto, 1fr)，auto 取内容最小宽度：
   * 卡片里只要有不可换行的东西（长集名/URL），列就会被撑宽，
   * 于是同一行卡片宽度、封面高度全部参差。
   */
  min-width: 0;
  padding: 0;
  overflow: hidden;
  border-radius: var(--r-lg);
  transition: border-color var(--t-base) var(--ease), transform var(--t-base) var(--ease),
    box-shadow var(--t-base) var(--ease);
}
.vg:hover {
  border-color: var(--line-hover);
  transform: translateY(-2px);
  box-shadow: var(--shadow-2);
}
.vg-cover {
  position: relative;
  /* 作为 flex 子项不许被压缩，否则展开内容一多，封面就被挤矮、行内高度不齐 */
  flex: none;
  aspect-ratio: 2 / 3;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: linear-gradient(135deg, var(--fallback-a), var(--fallback-b));
}
/*
 * 封面必须脱离 flex 流：.vg-cover 是 flex 容器，img 作为 flex item
 * 会被固有宽度撑开容器（P32 在海报卡上踩过，这里同样处理）。
 */
.vg-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform var(--t-slow) var(--ease);
}
.vg:hover .vg-img {
  transform: scale(1.04);
}
.vg-initials {
  font-size: 26px;
  font-weight: 700;
  letter-spacing: 2px;
  color: rgb(255 255 255 / 0.2);
  pointer-events: none;
  user-select: none;
}
.vg-count {
  position: absolute;
  top: 6px;
  left: 6px;
  padding: 1px 7px;
  border-radius: var(--r-sm);
  background: rgb(6 9 14 / 0.74);
  border: 1px solid rgb(255 255 255 / 0.12);
  backdrop-filter: blur(4px);
  font-size: 10px;
  color: var(--ov-dim);
}
/* 多图角标：点开看同一视频的全部封面 */
.vg-multi {
  position: absolute;
  left: 6px;
  bottom: 6px;
  height: 22px;
  min-height: 0;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid rgb(255 255 255 / 0.16);
  background: rgb(6 9 14 / 0.74);
  color: var(--ov-text);
  font-size: 10px;
  line-height: 1;
  backdrop-filter: blur(4px);
}
.vg-multi:hover:not(:disabled) {
  border-color: var(--accent);
  color: #fff;
}
/*
 * 聚合卡的播放键常驻（收藏卡才是 hover 才出现）。
 * 收藏卡底部本来就有一排操作按钮，再常驻一个播放键是重复；
 * 聚合卡上这是唯一的播放入口，藏起来等于让用户先猜。
 */
.vg .play-btn {
  position: absolute;
  right: 6px;
  bottom: 6px;
  width: 30px;
  height: 30px;
  padding-left: 2px;
  font-size: 11px;
  background: rgb(76 125 255 / 0.72);
}
.vg:hover .play-btn {
  background: var(--accent-hi);
}
.vg .thumb-del {
  opacity: 0;
}
.vg:hover .thumb-del,
.vg .thumb-del:focus-visible {
  opacity: 1;
}
.vg .body {
  gap: 6px;
  min-width: 0;
  padding: 9px 10px 10px;
}
.vg .title {
  min-width: 0;
  font-size: var(--fs-xs);
  line-height: 1.35;
}
.vg-sub {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-2xs);
  color: var(--text-faint);
}
/* 多张缩略图：同一视频的其它封面，横向排一行 */
.vg-strip {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  margin-top: 2px;
}
.vg-thumb {
  margin: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.vg-thumb img,
.vg-thumb-ph {
  width: 100%;
  aspect-ratio: 3 / 2;
  object-fit: cover;
  border-radius: var(--r-sm);
  background: var(--fallback-a);
}
.vg-thumb-ph {
  display: grid;
  place-items: center;
  color: var(--text-faint);
  font-size: 10px;
}
.vg-thumb figcaption {
  font-size: 9px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 组内任务：多集/多线路展开 */
.vg-tasks {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.vg-task-toggle {
  align-self: flex-start;
  height: 22px;
  min-height: 0;
  padding: 0 8px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line);
  background: transparent;
  color: var(--text-dim);
  font-size: var(--fs-2xs);
}
.vg-task-toggle:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--text);
}
.vg-task-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.vg-task-row {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  padding: 3px 4px;
  border-radius: var(--r-sm);
  font-size: var(--fs-2xs);
  cursor: pointer;
}
.vg-task-row:hover {
  background: rgb(255 255 255 / 0.05);
}
/* 中文默认可以在任意字符间断行：不写 nowrap 就会被压成一列竖排字 */
.vt-name {
  flex: 1 1 40px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-dim);
}
.vt-dot {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--text-faint);
}
.vt-dot.d-ready {
  background: var(--info);
}
.vt-dot.d-failed {
  background: var(--danger);
}
.vt-dot.d-downloading,
.vt-dot.d-probing {
  background: var(--ok);
}
.vt-dot.d-paused,
.vt-dot.d-pending {
  background: var(--warn);
}
.vt-state {
  flex: none;
  max-width: 46px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-faint);
}
.vt-del {
  flex: none;
  width: 16px;
  height: 16px;
  min-height: 0;
  padding: 0;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1;
}
.vt-del:hover:not(:disabled) {
  border-color: var(--danger);
  color: var(--danger);
}
/* 组状态徽章 */
.badge.st-active {
  background: var(--warn-bg);
  color: var(--warn);
}
.badge.st-done {
  background: var(--info-bg);
  color: var(--info);
}

/* ---- P35 清理：选择态 ---- */
/* 工具条里的选择态条：只占一行，不把搜索框挤成两段 */
.sel-bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 4px 10px;
  border: 1px solid var(--accent-line);
  border-radius: var(--r-pill);
  background: var(--accent-soft);
  font-size: var(--fs-2xs);
  color: var(--text);
}
.sel-all {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
  white-space: nowrap;
}
.sel-info {
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sel-info b {
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
/* 封面上的勾选框：半透明深底 + 白色描边，浅色海报上也看得清 */
.pick-box {
  position: absolute;
  top: 6px;
  left: 6px;
  z-index: 2;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: rgb(6 9 14 / 0.78);
  border: 1px solid rgb(255 255 255 / 0.22);
  backdrop-filter: blur(4px);
  cursor: pointer;
}
.pick-box input {
  width: 13px;
  height: 13px;
  margin: 0;
  accent-color: var(--accent);
  cursor: pointer;
}
/* 选择态：集数角标给勾选框让位 */
.vg.picking .vg-count {
  top: 34px;
}
/* 收藏卡的「N 片源」标签同样下移 */
.item.picking .proto-tag {
  top: 34px;
}
.vg.picked,
.item.picked {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent) inset;
}
.vg.picking,
.item.picking {
  cursor: pointer;
}
</style>
