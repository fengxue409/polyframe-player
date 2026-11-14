<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CacheMode, DanmakuSettings, SrcCachePolicy, SrcCacheStats } from '@polyframe/shared'
import { usePlayerStore } from '../stores/player'
import { useCatalogStore } from '../stores/catalog'
import { useDanmakuStore } from '../stores/danmaku'
import { useThemeStore } from '../stores/theme'
import { useUpdateStore } from '../stores/update'
import type { UpdatePhase } from '../types'

const store = usePlayerStore()
const catalog = useCatalogStore()
const dm = useDanmakuStore()
const theme = useThemeStore()
const upd = useUpdateStore()
upd.init()

// ---- P50 软件更新 ----
const repoDraft = ref('')
const extraDraft = ref('')
const historyOpen = ref(false)

watch(
  () => upd.st.config.repo,
  (v) => {
    if (repoDraft.value !== v) repoDraft.value = v
  },
  { immediate: true }
)
watch(
  () => upd.st.config.extraChannels,
  (list) => {
    const text = (list ?? []).join('\n')
    if (extraDraft.value !== text) extraDraft.value = text
  },
  { immediate: true }
)

function onSaveUpdateSource(): void {
  const repo = repoDraft.value.trim()
  const extraChannels = extraDraft.value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  void upd
    .setConfig({ repo, extraChannels })
    .then(() => notify('更新源已保存'))
    .catch((e) => notify((e as Error).message))
}

function onUpdBool(key: 'enabled' | 'autoDownload', ev: Event): void {
  const v = (ev.target as HTMLInputElement).checked
  void upd.setConfig({ [key]: v })
}

function onUpdInterval(ev: Event): void {
  const v = Number((ev.target as HTMLSelectElement).value)
  if (Number.isFinite(v)) void upd.setConfig({ intervalHours: v })
}

const PHASE_TEXT: Record<UpdatePhase, string> = {
  idle: '尚未检查',
  checking: '正在检查…',
  uptodate: '已是最新版本',
  available: '发现新版本',
  downloading: '正在下载升级包…',
  downloaded: '升级包已就绪',
  applying: '正在应用升级，应用即将重启…',
  error: '更新出错'
}

function fmtSpeed(b: number): string {
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB/s`
  return `${Math.max(1, Math.round(b / 1024))} KB/s`
}

function fmtDate(iso: string): string {
  return iso ? iso.slice(0, 10) : '—'
}

async function onOpenHistory(): Promise<void> {
  historyOpen.value = !historyOpen.value
  if (historyOpen.value && !upd.st.history.length) {
    try {
      await upd.loadHistory()
    } catch (e) {
      notify((e as Error).message)
    }
  }
}

async function onTestChannels(): Promise<void> {
  try {
    await upd.testChannels()
  } catch (e) {
    notify((e as Error).message)
  }
}

// ---- P11 弹幕设置 ----
const dmAppId = ref('')
const dmSecret = ref('')
const dmBusy = ref(false)
const dmTestMsg = ref('')
const dmTestOk = ref<boolean | null>(null)

/** 数值滑块：只在 change（松手）时落库，避免拖动过程中几十次 RPC */
function onDmNum(key: keyof DanmakuSettings, ev: Event): void {
  const v = Number((ev.target as HTMLInputElement).value)
  if (Number.isFinite(v)) void dm.saveSettings({ [key]: v } as Partial<DanmakuSettings>)
}

function onDmBool(key: keyof DanmakuSettings, ev: Event): void {
  const v = (ev.target as HTMLInputElement).checked
  void dm.saveSettings({ [key]: v } as Partial<DanmakuSettings>)
}

function onDmProvider(ev: Event): void {
  const v = (ev.target as HTMLSelectElement).value as DanmakuSettings['provider']
  void dm.saveSettings({ provider: v })
}

// ---- P15 屏蔽词 ----
const dmBlockedDraft = ref('')

/** settings 加载/变化后同步到草稿（只在用户没在编辑时覆盖） */
watch(
  () => dm.settings.blockedWords,
  (words) => {
    const draft = dmBlockedDraft.value.split('\n').map((s) => s.trim()).filter(Boolean)
    if (JSON.stringify(draft) !== JSON.stringify(words ?? [])) {
      dmBlockedDraft.value = (words ?? []).join('\n')
    }
  },
  { immediate: true }
)

const dmBlockedCount = computed(() => dm.settings.blockedWords?.length ?? 0)

function onSaveBlockedWords(): void {
  const words = dmBlockedDraft.value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  void dm.saveSettings({ blockedWords: words })
}

async function onSaveCredentials(): Promise<void> {
  if (!dmAppId.value.trim() || !dmSecret.value.trim()) {
    dmTestMsg.value = 'AppId 与 AppSecret 都要填写'
    dmTestOk.value = false
    return
  }
  dmBusy.value = true
  try {
    const r = await dm.setCredentials(dmAppId.value.trim(), dmSecret.value.trim())
    dmTestMsg.value = r.message
    dmTestOk.value = r.ok
    if (r.ok) {
      dmAppId.value = ''
      dmSecret.value = ''
      // 保存后立刻自检，把「填对了没有」当场反馈，而不是等用户去播放页踩坑
      await onTestCredentials()
    }
  } finally {
    dmBusy.value = false
  }
}

async function onTestCredentials(): Promise<void> {
  dmBusy.value = true
  try {
    const r = await dm.testCredentials()
    dmTestMsg.value = r.message
    dmTestOk.value = r.ok
  } finally {
    dmBusy.value = false
  }
}

async function onClearCredentials(): Promise<void> {
  dmBusy.value = true
  try {
    await dm.clearCredentials()
    dmTestMsg.value = '凭据已清除，第三方弹幕源将不可用'
    dmTestOk.value = null
  } finally {
    dmBusy.value = false
  }
}

// ---- P15 ASS 临时文件治理 ----
const dmAssBusy = ref(false)
const dmAssMsg = ref('')
const dmAssOk = ref(false)

const assCacheSize = computed(() => {
  const b = dm.assCache.bytes
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(b > 0 ? 1 : 0, Math.round(b / 1024))} KB`
})

async function onCleanAssCache(): Promise<void> {
  if (dmAssBusy.value) return
  dmAssBusy.value = true
  try {
    const r = await dm.cleanAssCache(0)
    dmAssMsg.value = r.message
    dmAssOk.value = r.removed > 0
  } finally {
    dmAssBusy.value = false
  }
}

watch(
  () => store.online,
  (on) => {
    if (on) {
      void dm.loadChannels()
      void dm.loadAssCache()
    }
  },
  { immediate: true }
)

// ---- 缓存策略（P3 迁移） ----
const policy = ref<{ retainDays: number; unfinishedDays: number; capacityGb: number } | null>(null)
const policyLoaded = ref(false)
async function loadPolicy(): Promise<void> {
  if (policyLoaded.value || !store.online) return
  try {
    policy.value = (await store.rpc('config.get_cache_policy')) as typeof policy.value
    policyLoaded.value = true
  } catch {
    /* 内核未就绪时静默 */
  }
}
watch(
  () => store.online,
  (on) => {
    if (on) void loadPolicy()
  },
  { immediate: true }
)
async function onSavePolicy(): Promise<void> {
  if (!policy.value) return
  try {
    policy.value = (await store.rpc('config.set_cache_policy', {
      retainDays: policy.value.retainDays,
      unfinishedDays: policy.value.unfinishedDays,
      capacityGb: policy.value.capacityGb
    })) as typeof policy.value
    store.pushLog('info', '缓存策略已保存（下一次清理循环生效）')
  } catch (e) {
    store.pushLog('error', `保存策略失败：${(e as Error).message}`)
  }
}
function retainDayLabel(v: number): string {
  if (v < 0) return '永久'
  if (v === 0) return '播完即删'
  return `${v} 天`
}

// ---- P46 剧集预缓存策略（后续 3 集 / 全部剩余 / 自定义 N） ----
type PrefetchChoice = 'off' | 'three' | 'all' | 'custom'
const prefetchChoice = ref<PrefetchChoice>('three')
const prefetchCount = ref(3)
const prefetchLoaded = ref(false)
const prefetchSaving = ref(false)

function applyPrefetch(cfg: { mode: string; count: number }): void {
  prefetchCount.value = cfg.count || 3
  if (cfg.mode === 'off') prefetchChoice.value = 'off'
  else if (cfg.mode === 'all') prefetchChoice.value = 'all'
  else prefetchChoice.value = cfg.count === 3 ? 'three' : 'custom'
}

async function loadPrefetch(): Promise<void> {
  if (prefetchLoaded.value || !store.online) return
  try {
    applyPrefetch((await store.rpc('config.get_series_prefetch')) as { mode: string; count: number })
    prefetchLoaded.value = true
  } catch {
    /* 内核未就绪时静默 */
  }
}
watch(
  () => store.online,
  (on) => {
    if (on) void loadPrefetch()
  },
  { immediate: true }
)

async function onSavePrefetch(): Promise<void> {
  const mode = prefetchChoice.value === 'all' ? 'all' : prefetchChoice.value === 'off' ? 'off' : 'ahead'
  const count =
    prefetchChoice.value === 'three'
      ? 3
      : prefetchChoice.value === 'custom'
        ? Math.min(50, Math.max(1, Math.round(prefetchCount.value || 1)))
        : undefined
  prefetchSaving.value = true
  try {
    const r = (await store.rpc('config.set_series_prefetch', {
      mode,
      ...(count ? { count } : {})
    })) as { mode: string; count: number }
    applyPrefetch(r)
    store.pushLog('info', '剧集预缓存策略已保存（下一次起播/换集生效）')
  } catch (e) {
    store.pushLog('error', `保存预缓存策略失败：${(e as Error).message}`)
  } finally {
    prefetchSaving.value = false
  }
}

const prefetchHint = computed(() => {
  if (prefetchChoice.value === 'off') return '已关闭：只在当前集播到 95% 后才顺延缓存下一集。'
  if (prefetchChoice.value === 'all') return '播放任意一集后，剩余全部剧集按顺序排队缓存（受容量上限与清理规则约束）。'
  if (prefetchChoice.value === 'three') return '播放任意一集后，自动缓存其后的 3 集；没看过的集不会提前缓存。'
  return `播放任意一集后，自动缓存其后的 ${prefetchCount.value || 1} 集（超过剩余集数时按实际剩余缓存）。`
})

// ---- P19 片源内容缓存（元数据 / 海报 / 直链） ----
const srcStats = ref<SrcCacheStats | null>(null)
const srcPolicy = ref<SrcCachePolicy | null>(null)
const srcLoading = ref(false)
const srcSaving = ref(false)
const srcClearing = ref('')

/** 缓存类别中文名（与后端 kind 一一对应） */
const SRC_KIND_LABELS: Record<string, string> = {
  search: '搜索结果',
  category: '分类/更新流',
  detail: '片源详情',
  tmdb: 'TMDB 评分',
  poster: '海报图片',
  parselink: '解析直链'
}

function fmtBytes(b: number): string {
  if (b >= 1024 * 1024 * 1024) return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  if (b >= 1024) return `${Math.round(b / 1024)} KB`
  return `${b} B`
}

/** 命中率：命中 /（命中 + 未命中）；无请求时显示 — */
const srcHitRate = computed(() => {
  const s = srcStats.value
  if (!s) return '—'
  const total = s.hits + s.misses
  if (!total) return '—'
  return `${Math.round((s.hits / total) * 100)}%`
})

async function loadSrcCache(): Promise<void> {
  if (!store.online) return
  srcLoading.value = true
  try {
    const r = (await store.rpc('cache.src_stats')) as { stats: SrcCacheStats; policy: SrcCachePolicy }
    srcStats.value = r.stats
    srcPolicy.value = r.policy
  } catch {
    /* 内核未就绪时静默 */
  } finally {
    srcLoading.value = false
  }
}

async function onSaveSrcPolicy(): Promise<void> {
  if (!srcPolicy.value || srcSaving.value) return
  srcSaving.value = true
  try {
    const r = (await store.rpc('config.set_src_cache_policy', { ...srcPolicy.value })) as {
      policy: SrcCachePolicy
    }
    srcPolicy.value = r.policy
    store.pushLog('info', '片源缓存策略已保存（下一次请求生效）')
    await loadSrcCache()
  } catch (e) {
    store.pushLog('error', `保存片源缓存策略失败：${(e as Error).message}`)
  } finally {
    srcSaving.value = false
  }
}

async function onClearSrcCache(kind?: string): Promise<void> {
  if (srcClearing.value) return
  srcClearing.value = kind ?? 'all'
  try {
    const r = (await store.rpc('cache.src_clear', kind ? { kind } : {})) as {
      removed: number
      freedBytes: number
    }
    store.pushLog(
      'info',
      `已清理${kind ? SRC_KIND_LABELS[kind] ?? kind : '全部'}缓存：${r.removed} 条 / ${fmtBytes(r.freedBytes)}`
    )
    await loadSrcCache()
  } catch (e) {
    store.pushLog('error', `清理片源缓存失败：${(e as Error).message}`)
  } finally {
    srcClearing.value = ''
  }
}

watch(
  () => store.online,
  (on) => {
    if (on) void loadSrcCache()
  },
  { immediate: true }
)

// ---- 播放默认档（P29：默认 = 预缓存） ----
const cacheModeOptions: { value: CacheMode; label: string }[] = [
  { value: 'online', label: '在线（不落盘）' },
  { value: 'stream', label: '边下边播' },
  { value: 'precache', label: '预缓存（默认）' }
]

// ---- 内核状态 ----
async function onPing(): Promise<void> {
  try {
    await store.ping()
  } catch (e) {
    store.pushLog('error', (e as Error).message)
  }
}
async function onRefresh(): Promise<void> {
  try {
    await store.refreshTasks()
    store.pushLog('info', `任务列表已刷新（${store.tasks.length} 个任务）`)
  } catch (e) {
    store.pushLog('error', (e as Error).message)
  }
}

// ---- P37 诊断日志 ----
// 「黑屏但没有任何提示」这类问题，现场只存在于内存里会直接丢失；
// 现在内核 stderr + 界面 warn/error 都写同一个文件，出问题直接把这个文件发出来即可。
const diagPath = ref('')
async function openLogDir(): Promise<void> {
  const ok = await window.polyframe?.openLog?.()
  if (!ok) notify('日志尚未生成（内核未启动过）')
}
void window.polyframe?.diagPath?.().then((p) => (diagPath.value = p || ''))

// ---- 发现源站（P7） ----
const newSource = ref({ name: '', api: '' })
const settingToast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | null = null
function notify(msg: string) {
  settingToast.value = msg
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (settingToast.value = ''), 2600)
}
async function loadSources(): Promise<void> {
  if (!store.online) return
  await Promise.all([catalog.refreshSources().catch(() => {}), catalog.loadPresetStat().catch(() => {})])
}
watch(
  () => store.online,
  (on) => {
    if (on) void loadSources()
  },
  { immediate: true }
)
async function onAddSource(): Promise<void> {
  const { name, api } = newSource.value
  if (!name.trim() || !api.trim()) {
    notify('请填写名称与 API 地址')
    return
  }
  try {
    await catalog.addSource(name.trim(), api.trim())
    newSource.value = { name: '', api: '' }
    notify('源站已添加')
  } catch (e) {
    notify((e as Error).message)
  }
}
async function onToggleSource(id: string, enabled: boolean): Promise<void> {
  await catalog.updateSource(id, { enabled }).catch((e) => notify((e as Error).message))
}
async function onTestSource(id: string): Promise<void> {
  try {
    const ms = await catalog.testSource(id)
    notify(`测速 ${ms}ms`)
  } catch (e) {
    notify((e as Error).message)
  }
}
async function onRemoveSource(id: string): Promise<void> {
  await catalog.removeSource(id).catch((e) => notify((e as Error).message))
}

// ---- P8 预设库同步 / 全量测速 ----
const syncBusy = ref(false)
const probeBusy = ref(false)
async function onSyncPresets(): Promise<void> {
  syncBusy.value = true
  try {
    const r = await catalog.syncPresets()
    notify(r.added ? `已补入 ${r.added} 个预设源站` : '预设库已全部就位')
  } catch (e) {
    notify((e as Error).message)
  } finally {
    syncBusy.value = false
  }
}
async function onProbeAll(): Promise<void> {
  probeBusy.value = true
  try {
    const r = await catalog.probeAllSources()
    notify(`测速完成：可用 ${r.ok} 个，失败 ${r.fail} 个`)
  } catch (e) {
    notify((e as Error).message)
  } finally {
    probeBusy.value = false
  }
}
</script>

<template>
  <div class="settings-view">
    <p class="group-title">外观</p>
    <!-- 皮肤是一条横条而不是卡片：只有两个选项，做成卡片会留下大半张空白 -->
    <section class="card appearance">
      <span class="ap-title">皮肤</span>
      <div class="segmented" role="group" aria-label="皮肤">
        <button :class="{ active: theme.isDark }" @click="theme.set('dark')">暗色</button>
        <button :class="{ active: !theme.isDark }" @click="theme.set('light')">亮色</button>
      </div>
      <span class="ap-note">立即生效并记住选择；左下角「暗色 / 亮色」按钮与之等价。</span>
    </section>

    <p class="group-title">运行时与存储</p>
    <div class="cols">
      <!-- 内核状态 -->
      <section class="card">
        <h3>内核状态</h3>
        <div class="kv">
          <span class="k">状态</span>
          <span :class="store.online ? 'ok' : ''">{{ store.statusText }}</span>
        </div>
        <div class="kv"><span class="k">内核版本</span><span>{{ store.coreInfo?.version ?? '—' }}</span></div>
        <div class="kv"><span class="k">RPC 端口</span><span class="mono">{{ store.rpcPort ?? '—' }}</span></div>
        <div class="kv"><span class="k">代理端口</span><span class="mono">{{ store.proxyPort ?? '—' }}</span></div>
        <div class="kv">
          <span class="k">Ping</span>
          <span class="mono">{{ store.pingMs !== null ? `${store.pingMs} ms` : '—' }}</span>
        </div>
        <div class="kv">
          <span class="k">libmpv</span>
          <span :class="store.mpvAvailable ? 'ok' : ''">{{ store.mpvDllPath || (store.mpvAvailable === false ? '不可用' : '未探测') }}</span>
        </div>
        <div v-if="store.statusError" class="alert">{{ store.statusError }}</div>
        <div class="btn-row">
          <button :disabled="!store.online" @click="onPing">Ping</button>
          <button :disabled="!store.online" @click="onRefresh">刷新任务列表</button>
        </div>
      </section>

      <!-- 播放与缓存 -->
      <section class="card">
        <h3>播放与缓存</h3>
        <div class="kv">
          <span class="k">新建任务默认模式</span>
          <select
            v-model="store.newTaskCacheMode"
            class="mode-select"
            @change="store.saveCacheModePref()"
          >
            <option v-for="o in cacheModeOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </div>
        <p class="note">
          影响所有“新建任务”的起播策略：启动新片、换集、换线路、从历史/收藏重新起播都按它建任务。
          预缓存会在播放的同时低优把整片拉完（带宽与磁盘占用高于边下边播，受下方容量上限与播完
          TTL 约束）；直播任务自动退化为边下边播。已在任务页单独改过档位的任务不受此设置影响。
        </p>

        <template v-if="policy">
          <div class="kv">
            <span class="k">播完 TTL</span>
            <select v-model.number="policy.retainDays" class="mode-select">
              <option :value="-1">永久</option>
              <option :value="0">播完即删</option>
              <option :value="1">1 天</option>
              <option :value="7">7 天</option>
              <option :value="30">30 天</option>
            </select>
          </div>
          <div class="kv">
            <span class="k">未播完 LRU</span>
            <select v-model.number="policy.unfinishedDays" class="mode-select">
              <option :value="7">7 天</option>
              <option :value="14">14 天</option>
              <option :value="30">30 天</option>
            </select>
          </div>
          <div class="kv">
            <span class="k">容量上限 (GB)</span>
            <input v-model.number="policy.capacityGb" type="number" min="1" max="500" class="cap-input" />
          </div>
          <div class="btn-row">
            <button class="primary" @click="onSavePolicy">保存策略</button>
          </div>
          <p class="note foot">
            当前：播完保留 {{ retainDayLabel(policy.retainDays) }} · 未播完
            {{ policy.unfinishedDays }} 天 · 上限 {{ policy.capacityGb }} GB（每 60s 清理一轮）
          </p>
        </template>
        <p v-else class="dim empty-hint">内核在线后载入清理策略</p>

        <!-- P46 剧集预缓存（与上面的清理策略分组：各有各的保存按钮） -->
        <h4 class="sub-title">剧集预缓存</h4>
        <div class="kv">
          <span class="k">缓存范围</span>
          <select v-model="prefetchChoice" class="mode-select" :disabled="!store.online">
            <option value="off">关闭（只顺延下一集）</option>
            <option value="three">后续 3 集</option>
            <option value="all">剩余全部</option>
            <option value="custom">自定义集数</option>
          </select>
        </div>
        <div v-if="prefetchChoice === 'custom'" class="kv">
          <span class="k">预缓存集数</span>
          <input
            v-model.number="prefetchCount"
            class="cap-input"
            type="number"
            min="1"
            max="50"
            step="1"
          />
        </div>
        <div class="btn-row">
          <button class="primary" :disabled="!store.online || prefetchSaving" @click="onSavePrefetch">
            {{ prefetchSaving ? '保存中…' : '保存预缓存策略' }}
          </button>
        </div>
        <p class="note foot">{{ prefetchHint }}</p>
      </section>

      <!-- P19 片源内容缓存 -->
      <section class="card">
        <h3>片源内容缓存</h3>
        <p class="note">
          采集站搜索/分类/详情、TMDB 评分、海报图片与解析直链都会落盘复用：TTL 内重看同一个词、翻回同一页不再回源；
          源站临时不可用时回退到上次获取的内容（「发现」页会标注缓存时间）。
        </p>
        <div class="kv">
          <span class="k">占用 / 条目</span>
          <span class="mono">
            {{ srcStats ? `${fmtBytes(srcStats.bytes)} · ${srcStats.entries} 条` : '—' }}
            <span v-if="srcPolicy" class="dim small">（上限 {{ srcPolicy.capacityMb }} MB）</span>
          </span>
        </div>
        <div class="kv">
          <span class="k">命中率</span>
          <span class="mono">
            {{ srcHitRate }}
            <span v-if="srcStats" class="dim small">
              （命中 {{ srcStats.hits }} / 未命中 {{ srcStats.misses }}，降级复用 {{ srcStats.staleServed }} 次）
            </span>
          </span>
        </div>
        <div class="btn-row">
          <button class="mini" :disabled="srcLoading" @click="loadSrcCache">
            {{ srcLoading ? '刷新中…' : '刷新统计' }}
          </button>
          <button class="mini" :disabled="!!srcClearing" @click="onClearSrcCache()">
            {{ srcClearing === 'all' ? '清理中…' : '清空全部' }}
          </button>
        </div>

        <div v-if="srcStats && srcStats.kinds.length" class="table-wrap mt-3">
          <table>
            <thead>
              <tr>
                <th>类别</th>
                <th>条目</th>
                <th>占用</th>
                <th>命中</th>
                <th>未命中</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="k in srcStats.kinds" :key="k.kind">
                <td>{{ SRC_KIND_LABELS[k.kind] ?? k.kind }}</td>
                <td class="mono">{{ k.entries }}</td>
                <td class="mono">{{ fmtBytes(k.bytes) }}</td>
                <td class="mono">{{ k.hits }}</td>
                <td class="mono">{{ k.misses }}</td>
                <td>
                  <button class="mini" :disabled="!!srcClearing" @click="onClearSrcCache(k.kind)">
                    {{ srcClearing === k.kind ? '清理中…' : '清理' }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <template v-if="srcPolicy">
          <div class="kv">
            <span class="k">搜索 TTL（分钟）</span>
            <input v-model.number="srcPolicy.ttlSearchMin" type="number" min="2" max="1440" class="cap-input" />
          </div>
          <div class="kv">
            <span class="k">分类 TTL（分钟）</span>
            <input v-model.number="srcPolicy.ttlCategoryMin" type="number" min="1" max="1440" class="cap-input" />
          </div>
          <div class="kv">
            <span class="k">详情 TTL（分钟）</span>
            <input v-model.number="srcPolicy.ttlDetailMin" type="number" min="2" max="10080" class="cap-input" />
          </div>
          <div class="kv">
            <span class="k">解析直链 TTL（分钟）</span>
            <input v-model.number="srcPolicy.ttlParseMin" type="number" min="1" max="1440" class="cap-input" />
          </div>
          <div class="kv">
            <span class="k">TMDB TTL（小时）</span>
            <input v-model.number="srcPolicy.ttlTmdbHours" type="number" min="1" max="720" class="cap-input" />
          </div>
          <div class="kv">
            <span class="k">海报 TTL（天）</span>
            <input v-model.number="srcPolicy.ttlPosterDays" type="number" min="1" max="3650" class="cap-input" />
          </div>
          <div class="kv">
            <span class="k">容量上限 (MB)</span>
            <input v-model.number="srcPolicy.capacityMb" type="number" min="8" max="4096" class="cap-input" />
          </div>
          <div class="kv">
            <span class="k">源站不可用时回退旧数据</span>
            <input v-model="srcPolicy.offlineFallback" type="checkbox" />
          </div>
          <div class="btn-row">
            <button class="primary" :disabled="srcSaving" @click="onSaveSrcPolicy">
              {{ srcSaving ? '保存中…' : '保存片源缓存策略' }}
            </button>
          </div>
          <p class="note foot">
            容量超出后按最久未用淘汰（命中即续命）；过期数据保留 7 天供回退，之后自动清除。
          </p>
        </template>
        <p v-else class="dim empty-hint">内核在线后载入片源缓存统计</p>
      </section>
    </div>

    <!-- P50 软件更新 -->
    <p class="group-title">软件更新</p>
    <section class="card upd">
      <h3>版本与升级</h3>
      <div class="upd-row">
        <span class="k">当前版本</span>
        <span class="mono">v{{ upd.st.currentVersion || '—' }}</span>
        <span class="badge form-badge">{{ upd.formLabel }}</span>
        <span v-if="upd.st.latest" class="dim small">最新 v{{ upd.st.latest.tag }} · {{ fmtDate(upd.st.latest.publishedAt) }}</span>
        <span v-if="upd.st.channel" class="dim small">通道 {{ upd.st.channel }}</span>
      </div>

      <div class="upd-status" :class="{ bad: upd.st.phase === 'error' }">
        <span class="phase">{{ PHASE_TEXT[upd.st.phase] }}</span>
        <span v-if="upd.st.error" class="err">{{ upd.st.error }}</span>
      </div>

      <!-- 下载进度条 -->
      <div v-if="upd.st.phase === 'downloading' && upd.st.progress" class="upd-progress">
        <div class="bar"><div class="fill" :style="{ width: upd.pct >= 0 ? `${(upd.pct * 100).toFixed(1)}%` : '50%' }"></div></div>
        <span class="mono small">
          {{ upd.pct >= 0 ? `${(upd.pct * 100).toFixed(0)}%` : '' }}
          {{ (upd.st.progress.received / 1048576).toFixed(1) }}/{{ upd.st.progress.total ? (upd.st.progress.total / 1048576).toFixed(1) + ' MB' : '—' }}
          · {{ fmtSpeed(upd.st.progress.speed) }}
        </span>
      </div>

      <details v-if="upd.st.latest && (upd.st.phase === 'available' || upd.st.phase === 'downloaded') && upd.st.latest.notes" class="upd-notes">
        <summary>查看更新说明</summary>
        <pre class="notes-body">{{ upd.st.latest.notes }}</pre>
      </details>

      <div class="btn-row">
        <button class="mini" :disabled="upd.st.phase === 'checking' || upd.downloading" @click="upd.check()">
          {{ upd.st.phase === 'checking' ? '检查中…' : '检查更新' }}
        </button>
        <button v-if="upd.st.phase === 'available'" class="mini" @click="upd.download()">下载升级包</button>
        <button
          v-if="upd.st.phase === 'downloaded'"
          class="mini primary"
          @click="upd.install()"
        >
          一键升级到 v{{ upd.st.pkg?.tag }}
        </button>
        <button v-if="upd.st.phase === 'error'" class="mini" @click="upd.st.error.includes('下载') ? upd.download() : upd.check()">
          重试
        </button>
        <button v-if="upd.st.pkg" class="mini" @click="upd.openDir()">打开缓存目录</button>
        <button v-if="upd.st.backupAvailable" class="mini danger" @click="upd.restoreBackup()">还原上一版</button>
      </div>
      <p v-if="upd.st.pkg" class="note foot">
        就绪包：{{ upd.st.pkg.name }}<span v-if="upd.st.pkg.shaVerified">（SHA256 已校验）</span>
      </p>
      <p v-else class="note foot">
        {{ upd.formLabel === '便携版'
          ? '便携版升级 = 替换 exe 本体并自动重启，旧版保留为 *.pfold 可一键还原；配置与缓存在 %LOCALAPPDATA%/PolyFrame，升级不丢。'
          : '安装版升级 = 静默重装（沿用原安装目录）后自动拉起新版；用户数据在 %LOCALAPPDATA%/PolyFrame，升级不丢。' }}
      </p>

      <h4 class="sub-title">自动检查</h4>
      <div class="upd-grid">
        <label class="dm-switch">
          <input type="checkbox" :checked="upd.st.config.enabled" @change="onUpdBool('enabled', $event)" />
          <span>启动与定期自动检查</span>
        </label>
        <label class="dm-switch">
          <input type="checkbox" :checked="upd.st.config.autoDownload" @change="onUpdBool('autoDownload', $event)" />
          <span>发现新版后自动下载升级包</span>
        </label>
        <div class="kv">
          <span class="k">检查间隔</span>
          <select class="mode-select" :value="upd.st.config.intervalHours" @change="onUpdInterval">
            <option :value="1">每小时</option>
            <option :value="3">每 3 小时</option>
            <option :value="6">每 6 小时</option>
            <option :value="12">每 12 小时</option>
            <option :value="24">每天</option>
            <option :value="72">每 3 天</option>
          </select>
        </div>
      </div>

      <h4 class="sub-title">更新源与代理通道</h4>
      <p class="note">
        更新源为 GitHub Releases；直连不通时按下方通道逐个降级（镜像前缀 + 完整 GitHub URL），
        成功的通道会被记住、下次优先使用。
      </p>
      <div class="upd-src">
        <input v-model="repoDraft" class="w-repo mono" placeholder="owner/repo（GitHub 仓库）" spellcheck="false" />
        <button class="mini" @click="onSaveUpdateSource">保存更新源</button>
        <button class="mini" :disabled="upd.probing" @click="onTestChannels">
          {{ upd.probing ? '探测中…' : '测试通道' }}
        </button>
      </div>
      <textarea
        v-model="extraDraft"
        class="w-desc upd-extra"
        rows="2"
        spellcheck="false"
        placeholder="自定义镜像前缀，每行一个，如 https://my-mirror.example/（留空只用内置通道）"
        @blur="onSaveUpdateSource"
      ></textarea>
      <div v-if="upd.probes.length" class="table-wrap mt-3">
        <table>
          <thead>
            <tr>
              <th>通道</th>
              <th>前缀</th>
              <th>延迟</th>
              <th>结果</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in upd.probes" :key="p.id">
              <td class="mono">{{ p.id }}</td>
              <td class="mono dim small">{{ p.prefix || '（直连）' }}</td>
              <td class="mono">{{ p.ok ? `${p.ms}ms` : '—' }}</td>
              <td :class="p.ok ? 'good-text' : 'bad-text'">{{ p.ok ? '可用' : p.error ?? '不可用' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h4 class="sub-title">历史版本（回退）</h4>
      <div class="btn-row tight-top">
        <button class="mini" :disabled="upd.historyLoading" @click="onOpenHistory">
          {{ upd.historyLoading ? '加载中…' : historyOpen ? '收起' : '展开历史版本' }}
        </button>
      </div>
      <div v-if="historyOpen" class="table-wrap mt-3">
        <table>
          <thead>
            <tr>
              <th>版本</th>
              <th>发布时间</th>
              <th class="col-ops">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in upd.st.history" :key="r.tag">
              <td class="mono">{{ r.tag }}<span v-if="r.tag === `v${upd.st.currentVersion}`" class="badge builtin-tag">当前</span></td>
              <td class="mono">{{ fmtDate(r.publishedAt) }}</td>
              <td class="col-ops">
                <button class="mini danger" @click="upd.installVersion(r.tag)">下载并安装</button>
              </td>
            </tr>
            <tr v-if="!upd.st.history.length">
              <td colspan="3" class="dim small">没有可回退的版本（或加载失败）</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="note foot">
        回退会把所选历史版本的{{ upd.formLabel === '便携版' ? '便携包替换当前程序' : '安装包静默重装' }}，用户数据不受影响。
      </p>
    </section>

    <!-- 发现源站（P7） -->
    <p class="group-title">内容源</p>
    <section class="card">
      <h3>发现源站（CMS 采集站）</h3>
      <p class="note">
        「发现」页的在线搜索走这些采集站（苹果CMS V10 API）；停用后不参与聚合搜索，删除内置源后重新添加 API 即可恢复。
        预设库内置 {{ catalog.presetInstalled }}/{{ catalog.presetTotal }} 个实测可用源站，批量导入（粘贴清单 / 订阅地址）在「发现 → 源站」里。
      </p>
      <div class="btn-row tight-top">
        <button class="mini" :disabled="syncBusy || catalog.presetsLoading" @click="onSyncPresets">
          {{ syncBusy ? '同步中…' : '同步预设库' }}
        </button>
        <button class="mini" :disabled="probeBusy || !catalog.sources.length" @click="onProbeAll">
          {{ probeBusy ? '测速中…' : '全部测速' }}
        </button>
      </div>
      <div v-if="catalog.sources.length" class="table-wrap">
        <table>
          <thead>
            <tr>
              <th class="col-name">名称</th>
              <th>API</th>
              <th class="col-lat">延迟</th>
              <th class="col-en">启用</th>
              <th class="col-ops">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in catalog.sources" :key="s.id">
              <td :title="s.name">{{ s.name }}<span v-if="s.builtin" class="badge builtin-tag">内置</span></td>
              <td class="mono" :title="s.api">{{ s.api }}</td>
              <td class="mono">{{ s.latencyMs != null ? `${s.latencyMs}ms` : '—' }}</td>
              <td>
                <input type="checkbox" :checked="s.enabled" @change="onToggleSource(s.id, !s.enabled)" />
              </td>
              <td class="col-ops">
                <div class="row-actions">
                  <button class="mini" @click="onTestSource(s.id)">测速</button>
                  <button class="mini danger" @click="onRemoveSource(s.id)">删除</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="dim empty-hint">暂无源站（内核在线后载入）</p>
      <div class="btn-row add-source">
        <input v-model="newSource.name" class="w-name" placeholder="源站名称" />
        <input v-model="newSource.api" class="w-api" placeholder="https://…/api.php/provide/vod" />
        <button class="primary" @click="onAddSource">添加（自动探测）</button>
      </div>
    </section>

    <!-- P11 弹幕 -->
    <p class="group-title">弹幕</p>
    <section class="card dm-settings">
      <h3>弹幕</h3>
      <p class="note">
        弹幕源为弹弹play 弹幕库（需在开放平台免费申请 AppId / AppSecret）。未配置时仍可发送本地弹幕，只是看不到别人的。
        libmpv 内核下弹幕由 mpv 以 ASS 字幕渲染 —— 视频是 Win32 子窗口，DOM 图层无法叠加在其上。
      </p>

      <div class="dm-grid">
        <label class="dm-switch">
          <input type="checkbox" :checked="dm.settings.enabled" @change="onDmBool('enabled', $event)" />
          <span>启用弹幕</span>
        </label>
        <label class="dm-switch">
          <input type="checkbox" :checked="dm.settings.showSendBar" @change="onDmBool('showSendBar', $event)" />
          <span>显示发送栏</span>
        </label>
        <label class="dm-switch">
          <input type="checkbox" :checked="dm.settings.autoScale" @change="onDmBool('autoScale', $event)" />
          <span>时间轴自动贴合（换片源时按比例缩放）</span>
        </label>
        <label class="dm-switch">
          <input type="checkbox" :checked="dm.settings.fxOverlay" @change="onDmBool('fxOverlay', $event)" />
          <span>mpv 高级特效弹幕（透明覆盖层窗口）</span>
        </label>
      </div>
      <p class="note">
        高级特效支持「发光 / 渐变 / 图片弹幕」（发送栏样式下拉可选；text 为图片地址的弹幕按图片渲染）。
        仅影响 libmpv 内核 —— 开启后 mpv 弹幕改由独立透明窗口渲染，关闭则回到 ASS 字幕；hls 内核恒支持特效。
      </p>

      <div class="dm-sliders">
        <div class="dm-slider">
          <span class="k">不透明度</span>
          <input type="range" min="0.1" max="1" step="0.05" :value="dm.settings.opacity" @change="onDmNum('opacity', $event)" />
          <span class="v mono">{{ Math.round(dm.settings.opacity * 100) }}%</span>
        </div>
        <div class="dm-slider">
          <span class="k">字号</span>
          <input type="range" min="0.6" max="1.8" step="0.05" :value="dm.settings.fontScale" @change="onDmNum('fontScale', $event)" />
          <span class="v mono">{{ dm.settings.fontScale.toFixed(2) }}×</span>
        </div>
        <div class="dm-slider">
          <span class="k">滚动时长</span>
          <input type="range" min="0.5" max="1.5" step="0.05" :value="dm.settings.speed" @change="onDmNum('speed', $event)" />
          <span class="v mono">{{ (8 * dm.settings.speed).toFixed(1) }}s</span>
        </div>
        <div class="dm-slider">
          <span class="k">同屏密度</span>
          <input type="range" min="0.1" max="1" step="0.05" :value="dm.settings.density" @change="onDmNum('density', $event)" />
          <span class="v mono">{{ Math.round(dm.settings.density * 100) }}%</span>
        </div>
      </div>

      <div class="dm-row">
        <span class="k">屏蔽类型</span>
        <label class="dm-switch sm">
          <input type="checkbox" :checked="dm.settings.blockScroll" @change="onDmBool('blockScroll', $event)" />
          <span>滚动</span>
        </label>
        <label class="dm-switch sm">
          <input type="checkbox" :checked="dm.settings.blockTop" @change="onDmBool('blockTop', $event)" />
          <span>顶部</span>
        </label>
        <label class="dm-switch sm">
          <input type="checkbox" :checked="dm.settings.blockBottom" @change="onDmBool('blockBottom', $event)" />
          <span>底部</span>
        </label>
      </div>

      <div class="dm-row">
        <span class="k">弹幕来源</span>
        <select class="mode-select" :value="dm.settings.provider" @change="onDmProvider">
          <option value="dandanplay">弹弹play（在线弹幕库）</option>
          <option value="local">仅本地弹幕</option>
          <option value="off">关闭弹幕</option>
        </select>
        <span class="dm-state" :class="dm.hasCredentials ? 'ok' : 'off'">
          {{ dm.hasCredentials ? `已配置 ${dm.appIdMasked}` : '未配置凭据' }}
        </span>
      </div>

      <div class="dm-cred">
        <input v-model="dmAppId" class="w-name" placeholder="AppId" spellcheck="false" autocomplete="off" />
        <input
          v-model="dmSecret"
          class="w-api"
          type="password"
          placeholder="AppSecret"
          spellcheck="false"
          autocomplete="off"
        />
        <button class="primary" :disabled="dmBusy" @click="onSaveCredentials">保存并测试</button>
        <button class="mini" :disabled="dmBusy" @click="onTestCredentials">仅测试</button>
        <button class="mini danger" :disabled="dmBusy" @click="onClearCredentials">清除</button>
      </div>
      <p v-if="dmTestMsg" class="dm-test" :class="dmTestOk === false ? 'bad' : dmTestOk ? 'good' : ''">
        {{ dmTestMsg }}
      </p>

      <!-- P15 屏蔽词 -->
      <div class="dm-row top">
        <span class="k">屏蔽词</span>
        <div class="grow">
          <textarea
            v-model="dmBlockedDraft"
            class="w-desc dm-blocked"
            rows="3"
            spellcheck="false"
            placeholder="每行一个关键词，命中（大小写不敏感）的弹幕将不显示"
            @blur="onSaveBlockedWords"
          ></textarea>
          <p class="note foot">
            {{ dmBlockedCount }} 个生效；改动失焦后保存，当前播放的频道会立即重新过滤。
          </p>
        </div>
      </div>

      <p class="note foot">
        申请地址：弹弹play 开放平台（<code>doc.dandanplay.com</code>）。免费额度按天计，超限时会在播放页角标提示。
      </p>

      <template v-if="dm.channels.length">
        <h4 class="sub-title">已缓存弹幕（{{ dm.channels.length }} 个频道）</h4>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th class="col-name">剧集</th>
                <th>来源</th>
                <th class="col-lat">条数</th>
                <th class="col-ops">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in dm.channels" :key="c.id">
                <td :title="`${c.title} ${c.episode ?? ''}`">{{ c.title }} {{ c.episode ?? '' }}</td>
                <td class="mono">{{ c.provider }}</td>
                <td class="mono">{{ c.itemCount }}</td>
                <td class="col-ops">
                  <div class="row-actions">
                    <button class="mini danger" @click="dm.removeChannel(c.id)">删除</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
      <p v-else class="dim empty-hint">还没有缓存的弹幕；播放剧集后会自动匹配并缓存。</p>

      <!-- P15 临时文件治理 -->
      <div class="dm-ass">
        <div class="dm-ass-info">
          <span class="k">libmpv 弹幕字幕临时文件</span>
          <span class="v mono">
            {{ dm.assCache.files }} 个 · {{ assCacheSize }}
          </span>
        </div>
        <button class="mini" :disabled="dmAssBusy || dm.assCache.files === 0" @click="onCleanAssCache">
          {{ dmAssBusy ? '清理中…' : '立即清理' }}
        </button>
      </div>
      <p class="note foot">
        每次用 libmpv 播一集会生成一个 .ass 字幕文件。已按「保留最新 60 个 + 7 天」自动清理，这里可以立刻释放空间。
      </p>
      <p v-if="dmAssMsg" class="dm-test" :class="dmAssOk ? 'good' : 'bad'">{{ dmAssMsg }}</p>
    </section>

    <!-- 关于 -->
    <section class="card about">
      <h3>关于</h3>
      <p class="dim small">
        PolyFrame Player v{{ upd.st.currentVersion || '0.1' }} · Windows 桌面端多源视频播放器 —— 多镜像带宽聚合（P2SP）+ 分片级缓存与预取 + 双播放内核（hls.js / libmpv）。
        本地 HTTP 代理是下载与播放的唯一边界（Stremio 模式），播放器只见 127.0.0.1 地址。
      </p>
      <div class="about-row">
        <div class="about-text">
          <p class="about-label">诊断日志</p>
          <p class="dim small">
            播放失败的现场（内核 stderr + 界面报错）会写在同一份日志里。画面出不来时，
            先点这里的目录，把当天那份 <code>app-*.log</code> 发出来就能定位。
          </p>
          <p v-if="diagPath" class="about-path mono">{{ diagPath }}</p>
        </div>
        <button class="about-btn" @click="openLogDir">打开日志目录</button>
      </div>
    </section>
    <div v-if="settingToast" class="toast">{{ settingToast }}</div>
  </div>
</template>

<style scoped>
.settings-view {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
/* 分组标题：把 4 类卡片切成 3 段，避免一整屏平铺无从下眼 */
.group-title {
  margin: var(--sp-2) 0 calc(var(--sp-2) * -1);
  font-size: var(--fs-2xs);
  font-weight: 600;
  letter-spacing: 1px;
  color: var(--text-faint);
}
.group-title:first-child {
  margin-top: 0;
}
.cols {
  display: grid;
  /* 卡片按可用宽度自动分栏：窄屏 1 列、常规 2 列、超宽 3 列 */
  grid-template-columns: repeat(auto-fit, minmax(min(330px, 100%), 1fr));
  gap: var(--sp-4);
  align-items: start;
}
/* 外观条：一行放完，窄屏自动换行 */
.appearance {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-wrap: wrap;
  padding: 10px var(--sp-4);
}
.ap-title {
  font-size: var(--fs-sm);
  font-weight: 600;
}
.ap-note {
  font-size: var(--fs-2xs);
  line-height: 1.6;
  color: var(--text-faint);
}
.card h3 {
  font-size: var(--fs-md);
}
/* 说明文字：卡片内的次级段落，行距放宽到 1.7 便于连读 */
.note {
  margin: 0 0 var(--sp-3);
  font-size: var(--fs-2xs);
  line-height: 1.7;
  color: var(--text-faint);
}
.note.foot {
  margin: var(--sp-3) 0 0;
}
.mt-3 {
  margin-top: var(--sp-3);
}
.tight-top {
  margin-top: 0;
  margin-bottom: var(--sp-3);
}
.grow {
  flex: 1;
  min-width: 0;
}
.sub-title {
  margin-top: var(--sp-4);
  margin-bottom: var(--sp-2);
  font-size: var(--fs-sm);
  color: var(--text);
  font-weight: 600;
}
.builtin-tag {
  margin-left: 6px;
}
/* 数值输入：右对齐 + 等宽数字，一排看下来是齐的 */
.cap-input {
  flex: none;
  width: 92px;
  padding: 5px 8px;
  font-size: var(--fs-xs);
}
/* 设置行里的下拉：统一窄宽度，不随内容跳动 */
.kv .mode-select {
  max-width: 190px;
}
.about p {
  margin: 0;
  font-size: var(--fs-xs);
  line-height: 1.75;
  color: var(--text-dim);
}
/* P37：诊断日志行 —— 左边说明 + 右边按钮，窄屏自动竖排 */
.about-row {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  margin-top: var(--sp-2);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--line-2);
}
.about-text {
  flex: 1;
  min-width: 0;
}
.about-label {
  font-weight: 600;
  color: var(--text);
}
.about-path {
  margin-top: 4px;
  font-size: var(--fs-2xs);
  color: var(--text-faint);
  overflow-wrap: anywhere;
}
.about-btn {
  flex: none;
  min-height: 28px;
  padding: 0 12px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line-2);
  background: var(--btn-bg);
  color: var(--text-dim);
  font-size: var(--fs-2xs);
  cursor: pointer;
}
.about-btn:hover {
  border-color: var(--line-hover);
  background: var(--btn-hover);
  color: var(--text);
}
@media (max-width: 640px) {
  .about-row {
    flex-wrap: wrap;
  }
}
/* ---- P50 软件更新 ---- */
.upd-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px var(--sp-4);
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.upd-row .k {
  color: var(--text-faint);
}
.form-badge {
  padding: 1px 8px;
  border-radius: var(--r-pill);
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: var(--fs-2xs);
}
.upd-status {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: var(--sp-2);
  font-size: var(--fs-xs);
}
.upd-status .phase {
  font-weight: 600;
  color: var(--text);
}
.upd-status.bad .phase {
  color: var(--danger);
}
.upd-status .err {
  font-size: var(--fs-2xs);
  color: var(--danger);
  word-break: break-word;
}
.upd-progress {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin-top: var(--sp-2);
}
.upd-progress .bar {
  flex: 1;
  min-width: 120px;
  height: 6px;
  border-radius: 3px;
  background: var(--panel-2);
  overflow: hidden;
}
.upd-progress .fill {
  height: 100%;
  border-radius: 3px;
  background: var(--accent);
  transition: width 0.4s var(--ease);
}
.upd-notes {
  margin-top: var(--sp-2);
  font-size: var(--fs-2xs);
  color: var(--text-dim);
}
.upd-notes summary {
  cursor: pointer;
  user-select: none;
}
.notes-body {
  margin: var(--sp-2) 0 0;
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--panel-2);
  font-family: inherit;
  font-size: var(--fs-2xs);
  line-height: 1.7;
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 220px;
  overflow-y: auto;
}
.upd-grid {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 20px;
}
.upd-src {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
  align-items: center;
}
.upd-src .w-repo {
  flex: 1 1 220px;
  min-width: 0;
}
.upd-extra {
  width: 100%;
  margin-top: var(--sp-2);
  min-height: 52px;
  font-size: var(--fs-xs);
  font-family: var(--mono, monospace);
}
.good-text {
  color: var(--ok);
}
.bad-text {
  color: var(--danger);
  word-break: break-word;
}

/* 源站表：固定列宽的可滚动区，窄屏横向滚动而不撑破页面 */
.table-wrap table {
  min-width: 520px;
  table-layout: fixed;
}
.col-name {
  width: 130px;
}
.col-lat {
  width: 70px;
}
.col-en {
  width: 70px;
}
.col-ops {
  width: 120px;
  text-align: right;
}
.row-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}
/* 添加源站：名称定宽、API 撑满、按钮不压缩 */
.add-source {
  align-items: center;
  flex-wrap: wrap;
}
.add-source .w-name {
  flex: 0 1 150px;
  min-width: 110px;
}
.add-source .w-api {
  flex: 1 1 260px;
  min-width: 0;
}
.add-source .primary {
  flex: none;
}

/* ---- 弹幕设置 ---- */
.dm-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 20px;
  margin-bottom: var(--sp-3);
}
.dm-switch {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: var(--fs-xs);
  color: var(--text-dim);
  cursor: pointer;
  user-select: none;
}
.dm-switch:hover {
  color: var(--text);
}
.dm-switch.sm {
  font-size: var(--fs-2xs);
}
/* 滑块：标签/控件/数值三列对齐，拖动时数值不跳行 */
.dm-sliders {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr));
  gap: 8px var(--sp-5);
  margin-bottom: var(--sp-3);
}
.dm-slider {
  display: grid;
  grid-template-columns: 62px 1fr 52px;
  align-items: center;
  gap: 10px;
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.dm-slider input[type='range'] {
  width: 100%;
}
.dm-slider .v {
  text-align: right;
  font-size: var(--fs-2xs);
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.dm-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px var(--sp-4);
  margin-bottom: var(--sp-2);
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.dm-row.top {
  align-items: flex-start;
  margin-top: var(--sp-3);
}
.dm-row .k {
  min-width: 62px;
  color: var(--text-faint);
}
.dm-row.top .k {
  padding-top: 7px;
}
.dm-state {
  padding: 1px 8px;
  border-radius: var(--r-pill);
  background: rgb(255 255 255 / 0.06);
  font-size: var(--fs-2xs);
  color: var(--text-dim);
}
.dm-state.ok {
  background: var(--ok-bg);
  color: var(--ok);
}
.dm-state.off {
  background: var(--warn-bg);
  color: var(--warn);
}
.dm-cred {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
  align-items: center;
}
.dm-cred .w-name {
  flex: 0 1 190px;
}
.dm-cred .w-api {
  flex: 1 1 240px;
  min-width: 0;
}
.dm-test {
  margin: var(--sp-2) 0 0;
  font-size: var(--fs-xs);
  color: var(--text-dim);
  word-break: break-word;
}
.dm-test.good {
  color: var(--ok);
}
.dm-test.bad {
  color: var(--danger);
}
/* ASS 临时文件治理：一行式摘要条 */
.dm-ass {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  margin-top: var(--sp-3);
  padding: 9px 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--panel-2);
}
.dm-ass-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.dm-ass-info .k {
  font-size: var(--fs-2xs);
  color: var(--text-dim);
}
.dm-ass-info .v {
  font-size: var(--fs-xs);
  color: var(--text);
}
.dm-blocked {
  width: 100%;
  min-height: 68px;
  font-size: var(--fs-xs);
  line-height: 1.6;
}

@media (max-width: 640px) {
  .add-source .w-name,
  .add-source .w-api {
    flex: 1 1 100%;
  }
  .add-source .primary {
    width: 100%;
  }
  .dm-slider {
    grid-template-columns: 54px 1fr 44px;
  }
  .kv .mode-select {
    max-width: 150px;
  }
}
</style>
