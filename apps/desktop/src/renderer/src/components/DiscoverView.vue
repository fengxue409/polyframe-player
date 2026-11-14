<script setup lang="ts">
/**
 * P7 发现页：在线搜索（CMS 采集站聚合）+ 详情弹层（多站片源选集起播）
 * + 收藏管理（手动补充片源弹层复用详情弹层）。
 * P9 吸收 GYING：分类浏览 / 更新流 tab + 剧集连播队列。
 */
import { computed, onMounted, ref } from 'vue'
import { CATEGORIES, AREAS, useCatalogStore } from '../stores/catalog'
import { usePlayerStore } from '../stores/player'
import type { CacheSummary, CatalogCard, CatalogEpisode, FavoriteSource } from '@polyframe/shared'

const store = useCatalogStore()
const player = usePlayerStore()
const toast = ref('')
const showSources = ref(false)
const favSourcesTitle = ref('')

/** P19 缓存提示：命中缓存的站数 / 回退旧数据的站数，并说明缓存有多旧 */
function cacheAgo(ms?: number): string {
  if (!ms) return '较早'
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000))
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

function cacheHint(s: CacheSummary | null): string {
  if (!s || !s.total) return ''
  const ago = cacheAgo(s.oldestMs)
  if (s.stale > 0) {
    return `⚠ ${s.stale} 个源站暂不可达，正在显示${ago}缓存的内容`
  }
  if (s.fromCache > 0) {
    return `${s.fromCache}/${s.total} 个源站命中本地缓存（${ago}）`
  }
  return ''
}

function cacheStale(s: CacheSummary | null): boolean {
  return !!s && s.stale > 0
}

/** P9 页面模式：搜索（默认）/ 分类浏览 */
const mode = ref<'search' | 'category'>('search')
/** 分类页年份筛选项（近年 + 更新流开关由 hours 表达） */
const years = ['2026', '2025', '2024', '2023', '2022', '2021', '2020']

let toastTimer: ReturnType<typeof setTimeout> | null = null
function notify(msg: string) {
  toast.value = msg
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = ''), 2600)
}

onMounted(() => {
  if (!store.sources.length) store.refreshSources().catch(() => {})
  store.loadPresetStat().catch(() => {})
  // P11：TMDB Key 预载（评分徽章 + 配置回显）
  store.loadTmdbKey().then((k) => (tmdbKeyInput.value = k)).catch(() => {})
})

// ---------- P8 预设库 / 批量导入 / 全量测速 ----------
const showImport = ref(false)
const importText = ref('')
const importUrl = ref('')
const importing = ref(false)
const syncing = ref(false)
const probing = ref(false)

/** 首次展开面板时补拉预设库统计（发现页可能晚于内核就绪挂载） */
function toggleSources() {
  showSources.value = !showSources.value
  if (showSources.value && !store.presetTotal) store.loadPresetStat().catch(() => {})
}

// ---------- P11 TMDB 评分增强 ----------
const tmdbKeyInput = ref('')
const tmdbSaving = ref(false)

async function saveTmdbKey() {
  tmdbSaving.value = true
  try {
    await store.saveTmdbKey(tmdbKeyInput.value)
    notify(store.tmdbKey ? 'TMDB Key 已保存，详情页将展示评分' : 'TMDB Key 已清除')
  } catch (e) {
    notify((e as Error).message)
  } finally {
    tmdbSaving.value = false
  }
}

async function doSyncPresets() {
  syncing.value = true
  try {
    const r = await store.syncPresets()
    notify(r.added ? `已补入 ${r.added} 个预设源站${r.failed ? `（${r.failed} 个探测失败）` : ''}` : '预设库已全部就位')
  } catch (e) {
    notify((e as Error).message)
  } finally {
    syncing.value = false
  }
}

async function doImport() {
  if (!importText.value.trim() && !importUrl.value.trim()) {
    notify('请粘贴源清单或填写订阅地址')
    return
  }
  importing.value = true
  store.lastImportSummary = ''
  try {
    const r = await store.importSources({ text: importText.value, url: importUrl.value })
    store.lastImportSummary =
      `新增 ${r.importedCount} 个 · 跳过已存在 ${r.skipped} 个 · 探测失败 ${r.failedCount} 个` +
      (r.adultDropped ? ` · 忽略成人向 ${r.adultDropped} 个` : '') +
      (r.failed.length ? ` · ${r.failed.slice(0, 3).join('；')}` : '')
    notify(`已导入 ${r.importedCount} 个源站`)
    if (r.importedCount) {
      importText.value = ''
      importUrl.value = ''
    }
    await store.loadPresetStat().catch(() => {})
  } catch (e) {
    notify((e as Error).message)
  } finally {
    importing.value = false
  }
}

async function doProbeAll() {
  probing.value = true
  try {
    const r = await store.probeAllSources()
    notify(
      `测速完成：可用 ${r.ok} 个，失败 ${r.fail} 个${r.dead.length ? `（${r.dead.slice(0, 3).join('、')}…）` : ''}`
    )
  } catch (e) {
    notify((e as Error).message)
  } finally {
    probing.value = false
  }
}

/** P15 一键停用上次巡检发现的失效站 */
async function disableDead() {
  try {
    const n = await store.disableDeadSources()
    notify(n > 0 ? `已停用 ${n} 个失效源站（可在列表中重新启用）` : '没有需要停用的源站')
  } catch (e) {
    notify((e as Error).message)
  }
}

function doSearch() {
  const kw = store.query.trim()
  if (!kw) return
  store
    .search()
    .then(() => {
      if (!store.cards.length) notify(`「${kw}」无结果${store.searchFailures.length ? `（${store.searchFailures.length} 个源站失败）` : ''}`)
    })
    .catch((e) => notify(e.message))
}

// ---------- P9 分类浏览 / 更新流 ----------

/** 切到分类 tab 时懒加载 */
function switchMode(m: 'search' | 'category') {
  mode.value = m
  if (m === 'category' && !store.catCards.length && !store.catLoading) {
    store.loadCategory(true).catch((e) => notify(e.message))
  }
}

function pickCategory(cat: string) {
  store.setCategoryFilter({ category: cat }).catch((e) => notify(e.message))
}
function pickYear(y: string) {
  store.setCategoryFilter({ year: y }).catch((e) => notify(e.message))
}
function pickArea(a: string) {
  store.setCategoryFilter({ area: a }).catch((e) => notify(e.message))
}
function pickSort(sort: 'time' | 'hot') {
  store.setCategoryFilter({ sort }).catch((e) => notify(e.message))
}
function pickHours(hours: number) {
  store.setCategoryFilter({ hours }).catch((e) => notify(e.message))
}
function loadMore() {
  store.loadCategory(false).catch((e) => notify(e.message))
}

/** 打开详情弹层：记住聚合卡片（换源用），默认拉第一个站 */
function openCard(card: CatalogCard) {
  store.openCardDetail(card).catch((e) => notify(e.message))
}

/**
 * P22 点卡片直接起播：拉详情 → 第一集入队 → 跳播放页（源站按序自动降级）。
 * 想先看简介/换片源再播的走「详情」按钮。
 */
async function playCard(card: CatalogCard) {
  if (store.boot) return
  try {
    await store.playCard(card)
  } catch (e) {
    if ((e as Error).name === 'BootCancelled') {
      notify('已取消起播')
      return
    }
    notify(`起播失败：${(e as Error).message}`)
  }
}

/** 起播阶段的短文案（海报角标 + 按钮共用），说清卡在哪一步 */
const bootLabel = computed(() => {
  const b = store.boot
  if (!b) return ''
  if (b.phase === 'detail') return b.attempts > 1 ? `获取片源 ${b.attempt}/${b.attempts}` : '获取片源'
  if (b.phase === 'task') return '创建任务'
  return '起播中'
})

/** 收藏（卡片 → 核心聚合 ≤3 站详情） */
async function favCard(card: CatalogCard) {
  try {
    await store.addFavorite({ card })
    notify(`已收藏「${card.name}」`)
  } catch (e) {
    notify((e as Error).message)
  }
}

/** 打开收藏片源弹层（供收藏库跳转复用） */
async function openFavById(favId: string) {
  const fav = store.favorites.find((f) => f.id === favId)
  favSourcesTitle.value = fav?.name ?? ''
  await store.openFavorite(favId).catch((e) => notify(e.message))
}
defineExpose({ openFavById })

async function removeFavSource(sourceId: string, favoriteId: string) {
  try {
    await store.removeFavoriteSource(sourceId, favoriteId)
  } catch (e) {
    notify((e as Error).message)
  }
}

async function addManual() {
  if (!store.activeFavoriteId) return
  try {
    await store.addManualSource(store.activeFavoriteId, store.manualUrls)
    notify('片源已补充')
  } catch (e) {
    notify((e as Error).message)
  }
}

/** 播放收藏片源剧集：整组入队连播 + 进度/追更记账 */
async function playFavEp(ep: CatalogEpisode, fs: FavoriteSource) {
  try {
    // P20/P22：播放页侧栏信息（线路 = 该片源整组剧集；api 用于跨源换）
    await store.playFavoriteEpisode(ep, favSourcesTitle.value, fs.episodes, {
      siteName: fs.siteName,
      api: fs.api,
      vodId: fs.vodId,
      groups: [{ from: fs.siteName || '片源', episodes: fs.episodes }],
      groupIndex: 0
    })
  } catch (e) {
    notify((e as Error).message)
  }
}

async function toggleSource(id: string, enabled: boolean) {
  try {
    await store.updateSource(id, { enabled })
  } catch (e) {
    notify((e as Error).message)
  }
}

async function testOne(id: string) {
  try {
    const ms = await store.testSource(id)
    notify(`测速完成：${ms}ms`)
  } catch (e) {
    notify((e as Error).message)
  }
}

async function deleteOne(id: string) {
  try {
    await store.removeSource(id)
  } catch (e) {
    notify((e as Error).message)
  }
}

const newSource = ref({ name: '', api: '' })
async function addOne() {
  const { name, api } = newSource.value
  if (!name.trim() || !api.trim()) {
    notify('请填写源站名称与 API 地址')
    return
  }
  try {
    await store.addSource(name.trim(), api.trim())
    newSource.value = { name: '', api: '' }
    notify('源站已添加')
  } catch (e) {
    notify((e as Error).message)
  }
}

const playingEpisodeUrl = computed(() => player.url)
</script>

<template>
  <section class="discover-view">
    <!-- 搜索栏 + 模式切换 -->
    <div class="card search-bar">
      <div class="segmented mode-tabs" role="tablist" aria-label="页面模式">
        <button
          class="mode-tab"
          role="tab"
          :aria-selected="mode === 'search'"
          :class="{ active: mode === 'search' }"
          @click="switchMode('search')"
        >
          搜索
        </button>
        <button
          class="mode-tab"
          role="tab"
          :aria-selected="mode === 'category'"
          :class="{ active: mode === 'category' }"
          @click="switchMode('category')"
        >
          分类
        </button>
      </div>
      <div class="search-field">
        <span class="search-ico" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
            <circle cx="10.8" cy="10.8" r="6.4" />
            <path d="m15.6 15.6 4.4 4.4" />
          </svg>
        </span>
        <input
          v-model="store.query"
          class="input search-input"
          type="text"
          placeholder="搜索片名，回车在全部启用的源站中聚合搜索"
          @keyup.enter="doSearch"
        />
      </div>
      <div class="search-actions">
        <button class="btn primary" :disabled="store.searching" @click="doSearch">
          {{ store.searching ? '搜索中…' : '搜索' }}
        </button>
        <button
          class="btn ghost"
          :class="{ active: showSources }"
          title="源站管理"
          @click="toggleSources"
        >
          源站<span class="src-count">{{ store.enabledCount }}/{{ store.sources.length }}</span>
        </button>
      </div>
    </div>

    <!-- 源站管理 -->
    <div v-if="showSources" class="card sources-card">
      <div class="sources-head">
        <div>
          <h3>源站管理</h3>
          <span class="muted">
            苹果CMS V10 采集站 API；搜索只走启用中的源站 · 预设库 {{ store.presetInstalled }}/{{ store.presetTotal }}
          </span>
        </div>
        <div class="sources-tools">
          <button
            class="btn sm"
            :disabled="syncing || store.presetsLoading"
            title="把内置实测可用的源站补齐到本机（已存在的同 API 自动跳过）"
            @click="doSyncPresets"
          >
            {{ syncing ? '同步中…' : '同步预设库' }}
          </button>
          <button class="btn sm" :class="{ active: showImport }" @click="showImport = !showImport">
            批量导入
          </button>
          <button class="btn sm" :disabled="probing || !store.sources.length" @click="doProbeAll">
            {{ probing ? '测速中…' : '全部测速' }}
          </button>
        </div>
      </div>

      <!-- P15 巡检结果：一键停用失效站（GYING 域名容灾原则） -->
      <div v-if="store.deadIds.length" class="dead-bar">
        <span class="dead-text" :title="store.deadNames.join('、')">
          巡检发现 {{ store.deadIds.length }} 个失效源站（{{ store.deadNames.slice(0, 4).join('、') }}{{ store.deadNames.length > 4 ? '…' : '' }}），留着会拖慢聚合搜索
        </span>
        <button class="btn sm danger" :disabled="store.disablingDead" @click="disableDead">
          {{ store.disablingDead ? '停用中…' : '一键停用' }}
        </button>
        <button class="btn sm ghost" @click="store.dismissDead()">忽略</button>
      </div>

      <!-- 批量导入：粘贴清单 / 订阅 URL -->
      <div v-if="showImport" class="import-panel">
        <textarea
          v-model="importText"
          class="input import-text"
          rows="4"
          placeholder="每行一个：名称$https://…/api.php/provide/vod&#10;也可整段粘贴 LibreTV / MoonTV 订阅 JSON，或 Base58 订阅文本"
        ></textarea>
        <div class="add-source-row">
          <input
            v-model="importUrl"
            class="input grow"
            placeholder="或填订阅地址（拉取后解析，如 Gist / 静态 JSON 的公开 URL）"
          />
          <button class="btn primary" :disabled="importing" @click="doImport">
            {{ importing ? '解析中…' : '解析并导入' }}
          </button>
        </div>
        <p class="muted sm-line">
          导入会先探测：只收能返回数据的站；同 API 已在列表中的自动跳过；清单标注成人向（isAdult）的条目不导入。
        </p>
        <p v-if="store.lastImportSummary" class="muted sm-line">{{ store.lastImportSummary }}</p>
      </div>

      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th class="name-col">名称</th>
              <th class="api-col">API</th>
              <th class="lat-col">延迟</th>
              <th class="state-col">状态</th>
              <th class="ops-col">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in store.sources" :key="s.id">
              <td class="name-col">{{ s.name }}<span v-if="s.builtin" class="badge builtin">内置</span></td>
              <td class="mono api-cell api-col" :title="s.api">{{ s.api }}</td>
              <td class="lat-col">{{ s.latencyMs != null ? s.latencyMs + 'ms' : '—' }}</td>
              <td class="state-col">
                <label class="switch">
                  <input type="checkbox" :checked="s.enabled" @change="toggleSource(s.id, !s.enabled)" />
                  <span>{{ s.enabled ? '启用' : '停用' }}</span>
                </label>
              </td>
              <td class="ops-col">
                <div class="row-actions">
                  <button class="btn sm" @click="testOne(s.id)">测速</button>
                  <button class="btn sm danger" @click="deleteOne(s.id)">删除</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="add-source-row">
        <input v-model="newSource.name" class="input" placeholder="源站名称" />
        <input v-model="newSource.api" class="input grow" placeholder="https://…/api.php/provide/vod" />
        <button class="btn primary" @click="addOne">添加（自动探测）</button>
      </div>

      <!-- P11 TMDB 评分增强：可选 Key，未配置时详情页无评分（静默降级） -->
      <div class="add-source-row tmdb-row">
        <input
          v-model="tmdbKeyInput"
          class="input grow"
          placeholder="TMDB API Key（可选，用于详情页评分增强，themoviedb.org 免费申请）"
          autocomplete="off"
        />
        <button class="btn" :disabled="tmdbSaving" @click="saveTmdbKey">
          {{ tmdbSaving ? '保存中…' : '保存 Key' }}
        </button>
      </div>
    </div>

    <!-- 搜索结果（仅搜索模式） -->
    <template v-if="mode === 'search'">
      <div
        v-if="!store.searching && store.cards.length && cacheHint(store.searchCache)"
        class="cache-hint"
        :class="{ warn: cacheStale(store.searchCache) }"
      >
        {{ cacheHint(store.searchCache) }}
      </div>
      <!-- 首屏用骨架卡片占位：比一行「正在聚合搜索…」更能表达「马上有结果」 -->
      <div v-if="store.searching" class="grid">
        <div v-for="i in 6" :key="`ssk-${i}`" class="card ssk">
          <div class="skeleton ssk-poster"></div>
          <div class="skeleton ssk-line w70"></div>
          <div class="skeleton ssk-line w40"></div>
        </div>
      </div>
      <div v-else-if="store.cards.length" class="grid">
        <article v-for="c in store.cards" :key="c.key" class="card movie-card">
          <div
            class="poster-box is-clickable"
            :class="{ loading: store.playingKey === c.key }"
            title="点击直接播放"
            role="button"
            tabindex="0"
            :aria-label="`播放 ${c.name}`"
            @click="playCard(c)"
            @keydown.enter.prevent="playCard(c)"
            @keydown.space.prevent="playCard(c)"
          >
            <img v-if="c.poster" :src="store.posterUrl(c.poster)" loading="lazy" alt="" />
            <div v-else class="poster-empty">无海报</div>
            <span class="badge heat" :title="`收录站数 ${c.sourceCount}`">▲ {{ c.sourceCount }} 站</span>
            <!-- 起播阶段反馈：拉详情可能十几秒，光转圈看不出进度也取消不了 -->
            <div v-if="store.boot && store.boot.key === c.key" class="poster-boot">
              <span>{{ bootLabel }}</span>
              <button @click.stop="store.cancelBoot()">取消</button>
            </div>
          </div>
          <div class="movie-meta">
            <div class="movie-name" :title="`${c.name}（点击看简介与全部片源）`" @click="openCard(c)">{{ c.name }}</div>
            <div class="movie-sub">
              <span v-if="c.year">{{ c.year }}</span>
              <span v-if="c.typeName">{{ c.typeName }}</span>
              <span v-if="c.remarks" class="movie-remarks" :title="c.remarks">{{ c.remarks }}</span>
            </div>
            <div class="movie-actions">
              <button
                class="btn sm primary"
                :disabled="!!store.boot"
                title="直接起播第一集并进入播放页"
                @click="playCard(c)"
              >
                {{ store.boot && store.boot.key === c.key ? bootLabel : '▶ 播放' }}
              </button>
              <button class="btn sm ghost detail-btn" title="查看简介与全部片源" @click="openCard(c)">详情</button>
              <button class="btn sm ghost fav-btn" title="收藏到媒体库" @click="favCard(c)">☆</button>
            </div>
          </div>
        </article>
      </div>
      <div v-else-if="store.lastQuery" class="empty">
        <div class="empty-ico">🔍</div>
        <div class="empty-title">「{{ store.lastQuery }}」没有结果</div>
        <div class="empty-sub">
          {{
            store.searchFailures.length
              ? `有 ${store.searchFailures.length} 个源站没响应：${store.searchFailures.join('、')}`
              : '换一个片名试试，或到「源站」里补充更多采集站'
          }}
        </div>
      </div>
      <div v-else class="empty">
        <div class="empty-ico">🎬</div>
        <div class="empty-title">输入片名开始搜索</div>
        <div class="empty-sub">
          卡片上的「▲N 站」表示这部片被多少个采集站收录，收录越多越稳（换源空间大）。点封面直接起播，点标题看简介与全部片源。
        </div>
      </div>
    </template>

    <!-- P9 分类浏览 / 更新流 -->
    <template v-else>
      <div class="card cat-bar">
        <div class="cat-row">
          <button class="chip" :class="{ active: store.catSort === 'hot' }" title="按收录站数排序（热门参考）" @click="pickSort('hot')">
            热门
          </button>
          <button
            class="chip"
            :class="{ active: store.catSort === 'time' }"
            title="按站内更新时间排序"
            @click="pickSort('time')"
          >
            最新
          </button>
          <span class="chip-sep" aria-hidden="true"></span>
          <button
            class="chip"
            :class="{ active: store.catHours > 0 }"
            title="只看最近 24 小时有更新的内容（苹果CMS h 参数）"
            @click="pickHours(store.catHours > 0 ? 0 : 24)"
          >
            今日更新
          </button>
          <span class="chip-sep" aria-hidden="true"></span>
          <button class="chip" :class="{ active: !store.catCategory }" @click="pickCategory('')">全部</button>
          <button
            v-for="c in CATEGORIES"
            :key="c"
            class="chip"
            :class="{ active: store.catCategory === c }"
            @click="pickCategory(c)"
          >
            {{ c }}
          </button>
        </div>
        <div class="cat-row">
          <button class="chip" :class="{ active: !store.catYear }" @click="pickYear('')">年份</button>
          <button
            v-for="y in years"
            :key="y"
            class="chip"
            :class="{ active: store.catYear === y }"
            @click="pickYear(y)"
          >
            {{ y }}
          </button>
          <span class="chip-sep" aria-hidden="true"></span>
          <button class="chip" :class="{ active: !store.catArea }" @click="pickArea('')">地区</button>
          <button
            v-for="a in AREAS"
            :key="a.value"
            class="chip"
            :class="{ active: store.catArea === a.value }"
            @click="pickArea(a.value)"
          >
            {{ a.label }}
          </button>
        </div>
        <div v-if="store.catFailures.length" class="muted sm-line">
          失败源站：{{ store.catFailures.join('、') }}
        </div>
      </div>
      <div
        v-if="!store.catLoading && store.catCards.length && cacheHint(store.catCache)"
        class="cache-hint"
        :class="{ warn: cacheStale(store.catCache) }"
      >
        {{ cacheHint(store.catCache) }}
      </div>
      <div v-if="store.catLoading && !store.catCards.length" class="grid">
        <div v-for="i in 8" :key="`csk-${i}`" class="card ssk">
          <div class="skeleton ssk-poster"></div>
          <div class="skeleton ssk-line w70"></div>
          <div class="skeleton ssk-line w40"></div>
        </div>
      </div>
      <div v-else-if="store.catCards.length" class="grid">
        <article v-for="c in store.catCards" :key="c.key" class="card movie-card">
          <div
            class="poster-box is-clickable"
            :class="{ loading: store.playingKey === c.key }"
            title="点击直接播放"
            role="button"
            tabindex="0"
            :aria-label="`播放 ${c.name}`"
            @click="playCard(c)"
            @keydown.enter.prevent="playCard(c)"
            @keydown.space.prevent="playCard(c)"
          >
            <img v-if="c.poster" :src="store.posterUrl(c.poster)" loading="lazy" alt="" />
            <div v-else class="poster-empty">无海报</div>
            <span
              v-if="store.catSort === 'hot' && c.tmdb?.rating"
              class="badge heat rating-badge"
              :title="`TMDB 评分 · 人气 ${c.tmdb.popularity?.toFixed(0) ?? '—'}`"
            >
              ★ {{ c.tmdb.rating.toFixed(1) }}
            </span>
            <span v-else-if="c.updateTime" class="badge heat" :title="`更新于 ${c.updateTime}`">
              {{ c.updateTime.slice(5, 10) }}
            </span>
          </div>
          <div class="movie-meta">
            <div class="movie-name" :title="`${c.name}（点击看简介与全部片源）`" @click="openCard(c)">{{ c.name }}</div>
            <div class="movie-sub">
              <span v-if="c.year">{{ c.year }}</span>
              <span v-if="c.typeName">{{ c.typeName }}</span>
              <span v-if="c.remarks" class="movie-remarks" :title="c.remarks">{{ c.remarks }}</span>
            </div>
            <div class="movie-actions">
              <button
                class="btn sm primary"
                :disabled="!!store.boot"
                title="直接起播第一集并进入播放页"
                @click="playCard(c)"
              >
                {{ store.boot && store.boot.key === c.key ? bootLabel : '▶ 播放' }}
              </button>
              <button class="btn sm ghost detail-btn" title="查看简介与全部片源" @click="openCard(c)">详情</button>
              <button class="btn sm ghost fav-btn" title="收藏到媒体库" @click="favCard(c)">☆</button>
            </div>
          </div>
        </article>
      </div>
      <div v-else class="empty">
        <div class="empty-ico">🗂</div>
        <div class="empty-title">这个筛选条件下没有内容</div>
        <div class="empty-sub">换一个分类、年份或地区试试；也可以清掉「今日更新」看全部。</div>
      </div>
      <div v-if="store.catCards.length" class="load-more">
        <button class="btn ghost" :disabled="store.catLoading || !store.catHasMore" @click="loadMore">
          {{ store.catLoading ? '加载中…' : store.catHasMore ? '加载更多' : '没有更多了' }}
        </button>
      </div>
    </template>

    <!-- 详情弹层已全局化：App 壳层 CatalogDetailModal（首页/发现页共用） -->

    <!-- 收藏片源弹层 -->
    <div v-if="store.activeFavoriteId" class="modal-mask" @click.self="store.activeFavoriteId = ''">
      <div class="modal fav-modal">
        <div class="sources-head">
          <h3>片源<template v-if="favSourcesTitle"> · {{ favSourcesTitle }}</template></h3>
          <button class="btn sm close-btn" @click="store.activeFavoriteId = ''">×</button>
        </div>
        <div v-if="store.sourcesLoadingFor" class="muted center pad">加载片源…</div>
        <template v-else>
          <div v-if="!store.favoriteSources.length" class="muted center pad">
            暂无片源，可在下方粘贴链接手动补充
          </div>
          <div v-for="fs in store.favoriteSources" :key="fs.id" class="fav-source-block">
            <div class="fav-source-head">
              <b>{{ fs.siteName }}</b>
              <span v-if="fs.remarks" class="badge">{{ fs.remarks }}</span>
              <span class="badge" :class="fs.origin">{{ fs.origin === 'manual' ? '手动' : '搜索' }}</span>
              <span class="muted">{{ fs.episodes?.length ?? 0 }} 集</span>
              <button class="btn sm danger" @click="removeFavSource(fs.id, fs.favoriteId)">移除</button>
            </div>
            <div class="ep-grid">
              <button
                v-for="ep in fs.episodes"
                :key="ep.url"
                class="btn sm ep-btn"
                :class="{ active: ep.url === playingEpisodeUrl }"
                @click="playFavEp(ep, fs)"
              >
                {{ ep.name }}
              </button>
            </div>
          </div>
        </template>
        <div class="manual-row">
          <textarea
            v-model="store.manualUrls"
            class="input"
            rows="2"
            placeholder="手动补充：名称$URL#名称$URL，或每行一个 m3u8/直链"
          ></textarea>
          <button class="btn primary" @click="addManual">补充片源</button>
        </div>
      </div>
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </section>
</template>

<style scoped>
/* ---- 顶部工具条：模式分段 + 搜索框 + 动作，三者同一行，窄屏整行折行 ---- */
.search-bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 8px;
  flex-wrap: wrap;
}
.mode-tabs {
  /* 外观由全局 .segmented 决定 */
  margin-right: 2px;
}
.search-field {
  flex: 1 1 260px;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 4px 0 10px;
  border: 1px solid var(--line-2);
  border-radius: var(--r-md);
  background: var(--panel-2);
  transition: border-color var(--t-base) var(--ease), box-shadow var(--t-base) var(--ease);
}
.search-field:focus-within {
  border-color: var(--accent);
  box-shadow: var(--ring);
}
.search-ico {
  display: grid;
  place-items: center;
  flex: none;
  color: var(--text-faint);
}
.search-field:focus-within .search-ico {
  color: var(--accent);
}
.search-field .search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  padding: 7px 0;
}
.search-field .search-input:hover:not(:disabled),
.search-field .search-input:focus {
  border: none;
  background: transparent;
  box-shadow: none;
}
.search-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
/* 源站计数胶囊：和按钮文字拉开距离，避免读成「源站12/18」 */
.src-count {
  display: inline-flex;
  align-items: center;
  padding: 0 6px;
  margin-left: 2px;
  border-radius: var(--r-pill);
  background: rgb(255 255 255 / 0.08);
  font-size: var(--fs-2xs);
  font-variant-numeric: tabular-nums;
}
.search-actions .btn.ghost.active .src-count {
  background: var(--accent-soft);
}

/* ---- 片源缓存提示（P19） ---- */
.cache-hint {
  margin: var(--sp-3) 0 0;
  padding: 6px 11px;
  border-radius: var(--r-md);
  border: 1px solid var(--info-line);
  background: var(--info-bg);
  color: var(--info);
  font-size: var(--fs-2xs);
  line-height: 1.55;
}
.cache-hint.warn {
  border-color: var(--warn-line);
  background: var(--warn-bg);
  color: var(--warn);
}

/* ---- 源站管理面板 ---- */
.sources-card {
  margin-top: var(--sp-3);
}
.sources-head {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 6px var(--sp-3);
  margin-bottom: var(--sp-3);
}
.sources-head h3 {
  margin: 0 0 2px;
}
.sources-head .muted {
  font-size: var(--fs-2xs);
  line-height: 1.55;
}
.sources-tools {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.sources-tools .btn.active {
  background: var(--accent-soft);
  border-color: var(--accent-line);
  color: var(--accent-ink);
}
.import-panel {
  padding: var(--sp-3);
  margin-bottom: var(--sp-3);
  border: 1px solid var(--line-2);
  border-radius: var(--r-md);
  background: var(--panel-2);
}
.import-text {
  width: 100%;
  min-height: 74px;
  margin-bottom: var(--sp-2);
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: var(--fs-xs);
  line-height: 1.55;
}
.import-panel .sm-line {
  margin-top: 6px;
  font-size: var(--fs-2xs);
}
/* 巡检结果条：警示色的容器，动作右对齐 */
.dead-bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
  padding: 8px 11px;
  border: 1px solid var(--warn-line);
  border-radius: var(--r-md);
  background: var(--warn-bg);
}
.dead-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-xs);
  color: var(--warn);
}
/* 源站表：固定列宽 + 横向滚动容器，窄窗口不撑破卡片 */
.table-wrap table {
  min-width: 520px;
  table-layout: fixed;
}
.name-col {
  width: 26%;
  min-width: 120px;
}
.api-cell {
  max-width: 380px;
}
.lat-col {
  width: 76px;
}
.state-col {
  width: 96px;
}
.ops-col {
  width: 168px;
  text-align: right;
}
.row-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}
.switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-xs);
  color: var(--text-dim);
  cursor: pointer;
}
.add-source-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
  margin-top: var(--sp-3);
}
.add-source-row .input {
  flex: 1 1 160px;
  min-width: 0;
}
.add-source-row .grow {
  flex: 2 1 240px;
}
.add-source-row .btn {
  margin-left: auto;
}
.tmdb-row {
  padding-top: var(--sp-3);
  border-top: 1px solid var(--line);
}

/* ---- 分类筛选条 ---- */
.cat-bar {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  margin-top: var(--sp-3);
  padding: var(--sp-3);
}
.cat-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.chip-sep {
  width: 1px;
  height: 14px;
  margin: 0 4px;
  background: var(--line-2);
}
.load-more {
  display: flex;
  justify-content: center;
  padding: var(--sp-4) 0 0;
}

/* ---- 卡片网格：与首页同一密度基准 ---- */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(var(--pf-card-min), 100%), 1fr));
  gap: var(--sp-4);
  margin-top: var(--sp-4);
}
.movie-card {
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
  border-radius: var(--r-lg);
  transition: border-color var(--t-base) var(--ease), transform var(--t-base) var(--ease),
    box-shadow var(--t-base) var(--ease);
}
.movie-card:hover {
  border-color: var(--line-hover);
  transform: translateY(-2px);
  box-shadow: var(--shadow-2);
}
.poster-box {
  position: relative;
  aspect-ratio: 2 / 3;
  background: var(--panel-2);
  overflow: hidden;
}
.poster-box img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform var(--t-slow) var(--ease);
}
.movie-card:hover .poster-box img {
  transform: scale(1.03);
}
/* 悬停播放提示：点海报即起播，给一个明确的视觉承诺 */
.poster-box::after {
  content: '▶';
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  color: #fff;
  text-shadow: 0 2px 12px rgb(0 0 0 / 0.5);
  background: rgb(6 9 14 / 0.34);
  opacity: 0;
  transition: opacity var(--t-base) var(--ease);
  pointer-events: none;
}
.poster-box:hover::after,
.poster-box:focus-visible::after {
  opacity: 1;
}
/* 起播中：海报压暗 + 转圈（点下去立刻有反馈，拉详情要 1-3s） */
.poster-box.loading::after {
  content: '';
  opacity: 1;
  background: rgb(6 9 14 / 0.6);
}
.poster-box.loading::before {
  content: '';
  position: absolute;
  inset: 0;
  margin: auto;
  z-index: 2;
  width: 26px;
  height: 26px;
  border: 3px solid rgb(255 255 255 / 0.22);
  border-top-color: #fff;
  border-radius: 50%;
  animation: pf-card-spin 0.8s linear infinite;
}
@keyframes pf-card-spin {
  to {
    transform: rotate(360deg);
  }
}
.poster-boot {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 5px 7px;
  background: rgb(6 9 14 / 0.7);
  backdrop-filter: blur(4px);
  color: #fff;
  font-size: var(--fs-2xs);
}
.poster-boot span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.poster-boot button {
  flex: none;
  min-height: 0;
  padding: 1px 8px;
  border-radius: var(--r-pill);
  border: 1px solid rgb(255 255 255 / 0.3);
  background: rgb(255 255 255 / 0.14);
  color: #fff;
  font-size: 10px;
}
.poster-boot button:hover:not(:disabled) {
  background: rgb(255 255 255 / 0.26);
}
.poster-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
  font-size: var(--fs-2xs);
}
/* 角标：浮在海报上的标签统一深底 + 轻微模糊 */
.badge.heat {
  position: absolute;
  top: 6px;
  left: 6px;
  background: rgb(6 9 14 / 0.72);
  color: var(--gold);
  border: 1px solid rgb(255 255 255 / 0.1);
  backdrop-filter: blur(4px);
}
.badge.heat.rating-badge {
  color: var(--gold);
}
.badge.builtin {
  margin-left: 6px;
}
.movie-meta {
  display: flex;
  flex-direction: column;
  gap: 5px;
  flex: 1;
  padding: 9px 10px 10px;
}
.movie-name {
  font-size: var(--fs-sm);
  font-weight: 600;
  line-height: 1.4;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  transition: color var(--t-fast) var(--ease);
}
.movie-name:hover {
  color: var(--accent-ink);
}
/* 年份/分类/状态压成一行，超出省略：不再占三行高度 */
.movie-sub {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: var(--fs-2xs);
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
}
.movie-sub > span + span::before {
  content: '·';
  margin-right: 6px;
  opacity: 0.55;
}
.movie-remarks {
  overflow: hidden;
  text-overflow: ellipsis;
}
.movie-actions {
  margin-top: auto;
  padding-top: 8px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 6px;
}
.movie-actions .btn {
  width: 100%;
  min-width: 0;
}
.movie-actions .fav-btn {
  padding: 0 9px;
  font-size: var(--fs-sm);
}

/* ---- 卡片骨架 ---- */
.ssk {
  padding: 0;
  overflow: hidden;
}
.ssk-poster {
  aspect-ratio: 2 / 3;
  border-radius: 0;
}
.ssk-line {
  height: 10px;
  margin: 9px 10px 0;
}
.ssk-line.w70 {
  width: calc(70% - 20px);
}
.ssk-line.w40 {
  width: calc(40% - 20px);
  margin-bottom: 12px;
}

/* ---- 收藏片源弹层（外层 .modal 由全局提供） ---- */
.fav-modal {
  width: min(760px, 94vw);
  overflow: auto;
}
.close-btn {
  position: absolute;
  top: 10px;
  right: 10px;
  width: 28px;
  height: 28px;
  min-height: 0;
  padding: 0;
  font-size: 15px;
  line-height: 1;
  color: var(--text-dim);
  background: transparent;
  border-color: transparent;
}
.close-btn:hover:not(:disabled) {
  background: var(--panel-3);
  color: var(--text);
}
.fav-source-block {
  padding: var(--sp-3) 0;
  border-top: 1px solid var(--line);
}
.fav-source-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 10px;
  margin-bottom: var(--sp-2);
}
.fav-source-head b {
  font-size: var(--fs-sm);
  font-weight: 600;
}
.fav-source-head .btn {
  margin-left: auto;
}
.ep-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ep-grid .ep-btn {
  min-width: 58px;
  justify-content: center;
  padding: 0 10px;
}
.ep-btn.active {
  background: var(--accent-soft);
  border-color: var(--accent-line);
  color: var(--accent-ink);
  font-weight: 600;
}
.badge.manual {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.badge.search {
  background: var(--ok-bg);
  color: var(--ok);
}
.manual-row {
  display: flex;
  gap: var(--sp-2);
  align-items: stretch;
  margin-top: var(--sp-3);
}
.manual-row textarea {
  flex: 1;
  min-width: 0;
  min-height: 62px;
}
.manual-row .btn {
  align-self: flex-end;
}

/* ---- 窄窗口：动作区整行铺开，触控目标放大 ---- */
@media (max-width: 1000px) {
  .search-field {
    flex: 1 1 100%;
    order: 3;
  }
  .search-actions {
    margin-left: auto;
  }
  .sources-tools {
    margin-left: 0;
    width: 100%;
  }
  .sources-tools .btn {
    flex: 1 1 auto;
  }
  .add-source-row .input,
  .add-source-row .grow {
    flex: 1 1 100%;
  }
  .add-source-row .btn {
    width: 100%;
    margin-left: 0;
  }
  .row-actions {
    justify-content: flex-start;
  }
  .ops-col {
    text-align: left;
    width: 140px;
  }
  /* 窄屏优先保住名称与操作，API 列收进 title */
  .api-col {
    display: none;
  }
}

@media (max-width: 640px) {
  .segmented {
    width: 100%;
  }
  .segmented button {
    flex: 1;
  }
  .grid {
    gap: 10px;
    margin-top: var(--sp-3);
  }
  /* 窄卡片放不下「详情」文字按钮：标题点击同样能开详情 */
  .movie-actions .detail-btn {
    display: none;
  }
  .movie-actions {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .cat-bar {
    padding: 10px;
  }
  .manual-row {
    flex-direction: column;
  }
  .manual-row .btn {
    align-self: stretch;
  }
}
</style>
