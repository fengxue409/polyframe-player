<script setup lang="ts">
/**
 * 影视详情弹层（全局单例，由 catalog store 驱动）：
 * 挂在 App 壳层，首页/发现页点卡片都就地弹出，不切页面。
 * 换源为软加载：海报/简介保持展示，仅下方片源剧集区刷新。
 */
import { computed, ref, watch } from 'vue'
import type { CatalogEpisode, CatalogEpisodeGroup } from '@polyframe/shared'
import { useCatalogStore } from '../stores/catalog'
import { usePlayerStore } from '../stores/player'

const store = useCatalogStore()
const player = usePlayerStore()
const emit = defineEmits<{ toast: [msg: string] }>()

const detailGroups = computed(() => store.detail?.groups.filter((g) => g.episodes.length) ?? [])
/** 换源 chips：聚合卡片里的各站条目 */
const detailEntries = computed(() => store.detailCard?.entries ?? [])
const playingEpisodeUrl = computed(() => player.url)

/** 简介清洗：采集站 vod_content 常带 HTML（<p>、&nbsp; 等），剥标签 + 还原实体 + 压缩空白 */
const detailContent = computed(() => {
  const raw = store.detail?.content ?? ''
  if (!raw) return ''
  const text = raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#0?39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, '&')
  return text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
})

/** 简介过长时折叠成 5 行（弹层内不再开第二个滚动条） */
const contentOpen = ref(false)
const contentLong = computed(() => detailContent.value.length > 150)
watch(
  () => store.detail?.content,
  () => (contentOpen.value = false)
)

/** 换源：切到同片另一个站（软加载，头部不闪） */
function switchSource(entry: { api: string; vodId: string; sourceId?: string }) {
  store.switchDetailSource(entry).catch((e) => emit('toast', (e as Error).message))
}

/** 详情弹层内收藏 */
async function favDetail() {
  if (!store.detail) return
  try {
    await store.addFavorite({ detail: store.detail })
    emit('toast', `已收藏「${store.detail.name}」`)
  } catch (e) {
    emit('toast', (e as Error).message)
  }
}

/** 播放剧集：整组入队（连播），非收藏上下文不记进度 */
async function playDetailEpisode(group: CatalogEpisodeGroup, ep: CatalogEpisode) {
  if (!store.detail) return
  const key = `${store.detail.vodId}:${ep.url}`
  if (store.playingKey === key) return
  store.playingKey = key
  try {
    const idx = group.episodes.findIndex((e) => e.url === ep.url)
    // P20：把详情（简介/海报/线路）一并带给播放页，侧栏不必回源
    const gi = detailGroups.value.findIndex((g) => g.from === group.from)
    await store.playFromQueue(
      group.episodes,
      Math.max(0, idx),
      store.detail.name,
      '',
      store.contextFromDetail(store.detail, gi)
    )
    // 起播成功即收起弹层：弹层是全局单例，不关会盖在播放页上（首页场景尤明显）
    store.closeDetail()
  } catch (e) {
    emit('toast', (e as Error).message)
  } finally {
    store.playingKey = ''
  }
}

/** 「N 集」整组连播：从第一集起播并跳播放页（侧栏可继续选集） */
function playGroupAll(group: CatalogEpisodeGroup): void {
  const first = group.episodes[0]
  if (first) void playDetailEpisode(group, first)
}
</script>

<template>
  <div v-if="store.detail || store.detailLoading" class="modal-mask" @click.self="store.closeDetail()">
    <div class="modal detail-modal" role="dialog" aria-modal="true" aria-label="影片详情">
      <button class="icon-btn close-btn" aria-label="关闭" title="关闭（Esc）" @click="store.closeDetail()">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>

      <!-- 首屏骨架：结构与真实内容同构，避免「加载详情…」一行字把弹层撑成一条 -->
      <div v-if="store.detailLoading" class="sk-head">
        <div class="skeleton sk-poster"></div>
        <div class="sk-lines">
          <div class="skeleton sk-line" style="width: 46%; height: 18px"></div>
          <div class="skeleton sk-line" style="width: 72%"></div>
          <div class="skeleton sk-line" style="width: 88%"></div>
          <div class="skeleton sk-line" style="width: 64%"></div>
        </div>
      </div>

      <template v-else-if="store.detail">
        <header class="detail-head">
          <div class="detail-poster">
            <img v-if="store.detail.poster" :src="store.posterUrl(store.detail.poster)" alt="" />
            <div v-else class="poster-empty">无海报</div>
          </div>

          <div class="detail-info">
            <div class="title-row">
              <h2>{{ store.detail.name }}</h2>
              <span
                v-if="store.detail.tmdb?.rating"
                class="badge star"
                :title="`TMDB 评分 · ${store.detail.tmdb.votes ?? 0} 人评分`"
              >★ {{ store.detail.tmdb.rating.toFixed(1) }}</span>
            </div>

            <div class="meta-row">
              <span v-if="store.detail.year">{{ store.detail.year }}</span>
              <span v-if="store.detail.typeName">{{ store.detail.typeName }}</span>
              <span v-if="store.detail.remarks" class="meta-state">{{ store.detail.remarks }}</span>
              <span v-if="store.detail.updateTime">{{ store.detail.updateTime }}</span>
            </div>

            <dl v-if="store.detail.director || store.detail.actor" class="credits">
              <div v-if="store.detail.director">
                <dt>导演</dt>
                <dd>{{ store.detail.director }}</dd>
              </div>
              <div v-if="store.detail.actor">
                <dt>主演</dt>
                <dd>{{ store.detail.actor }}</dd>
              </div>
            </dl>

            <div v-if="detailContent" class="content-block">
              <p class="detail-content" :class="{ clamp: contentLong && !contentOpen }">{{ detailContent }}</p>
              <button v-if="contentLong" class="link-btn" @click="contentOpen = !contentOpen">
                {{ contentOpen ? '收起' : '展开全文' }}
              </button>
            </div>

            <!-- 换源：同片多站聚合后可直接比较并切换；软加载只刷新下方剧集区 -->
            <div v-if="detailEntries.length > 1" class="src-switch">
              <span class="src-switch-label">片源 {{ detailEntries.length }}</span>
              <div class="src-chips">
                <button
                  v-for="e in detailEntries"
                  :key="`${e.api}|${e.vodId}`"
                  class="chip"
                  :class="{ active: e.api === store.detail.api && e.vodId === store.detail.vodId }"
                  :disabled="store.detailSwitching"
                  :title="`${e.siteName}${e.remarks ? ' · ' + e.remarks : ''}`"
                  @click="switchSource(e)"
                >
                  {{ e.siteName }}<span v-if="e.remarks" class="chip-remark"> · {{ e.remarks }}</span>
                </button>
              </div>
            </div>

            <div class="detail-actions">
              <button class="btn primary sm" @click="favDetail">收藏此片</button>
              <span class="src-note">来源 {{ store.detail.siteName }}</span>
            </div>
          </div>
        </header>

        <!-- 片源/剧集区：换源软加载只刷新这里；旧剧集原地保留，spinner 覆盖其上，高度不变 -->
        <section class="ep-area" :class="{ switching: store.detailSwitching }">
          <div v-if="detailGroups.length" class="ep-groups">
            <div v-for="g in detailGroups" :key="g.from" class="ep-group">
              <div class="ep-group-head">
                <h3>{{ g.from }}</h3>
                <span class="badge">{{ g.episodes.length }} 集</span>
                <button class="btn xs ghost play-all" :title="`从第一集起播，跳转播放页并连播 ${g.episodes.length} 集`" @click="playGroupAll(g)">
                  从第 1 集连播
                </button>
              </div>
              <div class="ep-grid">
                <button
                  v-for="ep in g.episodes"
                  :key="ep.url"
                  class="ep-btn"
                  :class="{ active: ep.url === playingEpisodeUrl }"
                  @click="playDetailEpisode(g, ep)"
                >
                  {{ ep.name }}
                </button>
              </div>
            </div>
          </div>

          <div v-else-if="store.detailError" class="alert">{{ store.detailError }}</div>

          <div v-else class="empty">
            <div class="empty-ico">📺</div>
            <div class="empty-title">该站暂无可播放剧集</div>
            <div class="empty-sub">{{ detailEntries.length > 1 ? '上方可以切换到其他片源试试' : '稍后再试，或换一个采集站搜索' }}</div>
          </div>

          <!-- 覆盖层：换源期间盖住旧剧集区（旧数据保留不塌陷），完成后自动消失 -->
          <div v-if="store.detailSwitching" class="ep-overlay">
            <span class="spinner" aria-hidden="true"></span>
            <span>正在加载该片源…</span>
          </div>
        </section>
      </template>

      <div v-else class="empty">
        <div class="empty-ico">⚠️</div>
        <div class="empty-title">详情加载失败</div>
        <div class="empty-sub">{{ store.detailError || '该片源没有返回数据，换个站再试' }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 遮罩与弹窗底座用 App.vue 的全局 .modal-mask / .modal（层级、模糊、入场动画都在那），这里只定尺寸 */
.detail-modal {
  width: min(880px, 94vw);
  max-height: 84vh;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 0;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-faint);
  box-shadow: none;
  cursor: pointer;
}
.icon-btn:hover:not(:disabled) {
  background: var(--panel-3);
  border-color: var(--line-2);
  color: var(--text);
  transform: none;
}
.close-btn {
  position: absolute;
  top: 10px;
  right: 10px;
  /* 32px 热区：26px 时手指/鼠标都容易点空（WCAG 触控目标下限） */
  width: 32px;
  height: 32px;
  z-index: 2;
}

/* ---- 加载骨架 ---- */
.sk-head {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-4);
  /* 撑到接近真实内容高度，弹层不会在数据到位瞬间跳高 */
  min-height: 260px;
}
.sk-poster {
  width: 132px;
  flex: none;
  aspect-ratio: 2 / 3;
  background: var(--skeleton);
}
.sk-lines {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 4px;
}
.sk-line {
  height: 13px;
  background: var(--skeleton);
}

/* ---- 头部 ---- */
.detail-head {
  display: grid;
  grid-template-columns: 132px minmax(0, 1fr);
  gap: var(--sp-4);
}
.detail-poster {
  position: relative;
  aspect-ratio: 2 / 3;
  border-radius: var(--r-md);
  background: var(--panel-2);
  border: 1px solid var(--line);
  overflow: hidden;
}
.detail-poster img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
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
.detail-info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.title-row {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  flex-wrap: wrap;
  padding-right: 30px;
}
.title-row h2 {
  font-size: var(--fs-xl);
  font-weight: 650;
  line-height: 1.3;
  letter-spacing: 0.2px;
}
.badge.star {
  background: color-mix(in srgb, var(--warn) 16%, transparent);
  color: var(--warn);
  align-self: center;
}

/* 元信息一行到底，用中点分隔；状态单独提亮，扫一眼就能看到更新到第几集 */
.meta-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 0;
  font-size: var(--fs-xs);
  color: var(--text-dim);
}
.meta-row > span {
  display: inline-flex;
  align-items: center;
}
.meta-row > span + span::before {
  content: '·';
  margin: 0 8px;
  color: var(--line-2);
}
.meta-state {
  color: var(--info);
}

.credits {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: var(--fs-xs);
}
.credits > div {
  display: flex;
  gap: var(--sp-2);
  min-width: 0;
}
.credits dt {
  flex: none;
  color: var(--text-faint);
}
.credits dd {
  margin: 0;
  min-width: 0;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.content-block {
  min-width: 0;
}
.detail-content {
  margin: 0;
  font-size: var(--fs-xs);
  line-height: 1.75;
  color: var(--text-dim);
  white-space: pre-line;
  /* 折叠用行钳制，弹层里不再出现第二个滚动条 */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.detail-content.clamp {
  -webkit-line-clamp: 5;
}
.link-btn {
  margin-top: 4px;
  min-height: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--accent-ink);
  font-size: var(--fs-2xs);
  box-shadow: none;
  cursor: pointer;
}
.link-btn:hover:not(:disabled) {
  color: var(--accent);
  text-decoration: underline;
  transform: none;
}

/* 换源 chips */
.src-switch {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  flex-wrap: wrap;
  padding-top: 2px;
}
.src-switch-label {
  flex: none;
  font-size: var(--fs-2xs);
  color: var(--text-faint);
  line-height: 26px;
}
.src-chips {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip-remark {
  opacity: 0.7;
  font-size: var(--fs-2xs);
}

.detail-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-wrap: wrap;
  margin-top: auto;
  padding-top: 2px;
}
.src-note {
  font-size: var(--fs-2xs);
  color: var(--text-faint);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---- 剧集区 ---- */
.ep-area {
  position: relative;
  min-height: 72px;
  margin-top: var(--sp-4);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--line);
}
.ep-group + .ep-group {
  margin-top: var(--sp-4);
}
.ep-group-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-2);
}
.ep-group-head h3 {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text);
}
.play-all {
  margin-left: auto;
}
/* 剧集网格：等距等宽，长集名也不互相挤压 */
.ep-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(66px, 1fr));
  gap: 6px;
}
.ep-btn {
  min-height: 30px;
  min-width: 0;
  padding: 0 8px;
  border: 1px solid var(--line-2);
  border-radius: var(--r-sm);
  background: var(--panel-2);
  color: var(--text-dim);
  font-size: var(--fs-2xs);
  font-variant-numeric: tabular-nums;
  box-shadow: none;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease),
    color var(--t-fast) var(--ease);
}
.ep-btn:hover:not(:disabled) {
  background: var(--panel-3);
  border-color: var(--line-hover);
  color: var(--text);
  transform: none;
}
.ep-btn.active {
  background: var(--accent-soft);
  border-color: var(--accent-line);
  color: var(--accent-ink);
  font-weight: 600;
}

/* 换源软加载：旧剧集原地保留，覆盖层置灰提示，容器高度全程不变不闪 */
.ep-overlay {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  border-radius: var(--r-md);
  background: color-mix(in srgb, var(--panel) 84%, transparent);
  backdrop-filter: blur(1px);
  color: var(--text-dim);
  font-size: var(--fs-xs);
}
.ep-overlay .spinner {
  width: 16px;
  height: 16px;
  border-width: 2px;
}

/* ---- 响应式 ---- */
@media (max-width: 720px) {
  .detail-head,
  .sk-head {
    grid-template-columns: 104px minmax(0, 1fr);
    gap: var(--sp-3);
  }
  .detail-poster,
  .sk-poster {
    width: 104px;
  }
  .title-row h2 {
    font-size: var(--fs-lg);
  }
  .credits dd {
    white-space: normal;
  }
}
@media (max-width: 560px) {
  .detail-head,
  .sk-head {
    grid-template-columns: minmax(0, 1fr);
  }
  .detail-poster {
    width: 112px;
  }
  .detail-actions .btn {
    flex: 1 1 100%;
  }
  .ep-grid {
    grid-template-columns: repeat(auto-fill, minmax(58px, 1fr));
  }
  .close-btn {
    top: 8px;
    right: 8px;
  }
}
</style>
