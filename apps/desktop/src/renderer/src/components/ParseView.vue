<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { usePlayerStore } from '../stores/player'
import { useParseStore } from '../stores/parse'

const ps = useParseStore()
const player = usePlayerStore()

const busy = ref(false)
const showManage = ref(false)
const manageBusy = ref(false)
/** 轻提示（成功/失败都走这里，不阻塞操作） */
const toast = ref('')
const toastTimer: { v: number | null } = { v: null }
/** 嗅探失败原因（用于内嵌兜底时给出准确提示） */
const sniffError = ref('')
/** 新增接口表单 */
const newName = ref('')
const newApi = ref('')
/** 批量导入文本 */
const importText = ref('')
const showImport = ref(false)

const services = computed(() => ps.services.filter((s) => s.enabled))
const candidates = computed(() => ps.result?.candidates ?? [])
const canEmbed = computed(() => ps.embedUrl !== '')

function notify(msg: string): void {
  toast.value = msg
  if (toastTimer.v) window.clearTimeout(toastTimer.v)
  toastTimer.v = window.setTimeout(() => (toast.value = ''), 3200)
}

function hostOf(u: string): string {
  try {
    return new URL(u).host.replace(/^www\./, '')
  } catch {
    return '解析'
  }
}

/** 接口状态点：ok=可用 / fail=失效 / null=未测 */
function statusOf(s: { api: string; lastOkAt: number | null; latencyMs: number | null }): 'ok' | 'fail' | 'none' {
  if (s.api === 'direct://') return 'ok'
  if (s.lastOkAt) return 'ok'
  return s.latencyMs === null ? 'none' : 'fail'
}

onMounted(() => {
  ps.loadHistory()
})

// 内核比界面晚就绪是常态：上线后再拉接口列表（否则首屏下拉为空）
watch(
  () => player.online,
  (on) => {
    if (on) void ps.refresh().catch(() => {})
  },
  { immediate: true }
)

/** 交给播放页起播（建任务走代理，失败退回直连） */
async function startPlay(url: string): Promise<void> {
  const page = ps.result?.pageUrl ?? ps.url
  await ps.play(url, `解析 · ${hostOf(page)}`)
  notify('已切到播放页起播')
}

/**
 * 解析播放（三段式）：
 * 直链 → 主进程嗅探 → 内嵌 iframe → 新窗口兜底
 */
async function onResolve(): Promise<void> {
  if (busy.value) return
  busy.value = true
  ps.reset()
  sniffError.value = ''
  try {
    const r = await ps.resolve()
    if (r.kind === 'direct' && r.playUrl) {
      // 页面内嵌型接口常把广告/预告当第一个候选，这里优先 m3u8
      const best = r.candidates.find((u) => /\.m3u8(\?|$)/i.test(u)) ?? r.playUrl
      await startPlay(best)
      return
    }
    const target = r.parseUrl ?? r.pageUrl
    try {
      const u = await ps.sniff(target)
      await startPlay(u)
      return
    } catch (e) {
      sniffError.value = (e as Error).message
    }
    if (r.frameable) {
      ps.embedUrl = target
      ps.stage = 'embedding'
      ps.statusText = '已切换到内嵌播放（嗅探未拿到直链）'
    } else {
      ps.stage = 'error'
      ps.error = `站点禁止 iframe 内嵌，且嗅探未拿到直链：${sniffError.value}`
    }
  } catch (e) {
    ps.error = (e as Error).message
  } finally {
    busy.value = false
  }
}

/** 只内嵌不嗅探（接口页本来就是播放器时最快） */
async function onEmbed(): Promise<void> {
  if (busy.value) return
  busy.value = true
  ps.reset()
  try {
    const r = await ps.resolve()
    if (r.kind === 'direct' && r.playUrl) {
      await startPlay(r.playUrl)
      return
    }
    ps.embedUrl = r.parseUrl ?? r.pageUrl
    ps.stage = 'embedding'
    ps.statusText = '已内嵌播放页'
    if (!r.frameable) notify('该站点声明禁止内嵌，可能显示空白，可改用「新窗口」')
  } catch (e) {
    ps.error = (e as Error).message
  } finally {
    busy.value = false
  }
}

/** 重新嗅探当前播放页 */
async function onResniff(): Promise<void> {
  const target = ps.result?.parseUrl ?? ps.result?.pageUrl ?? ps.url
  if (!target) return
  busy.value = true
  try {
    const u = await ps.sniff(target)
    await startPlay(u)
  } catch (e) {
    sniffError.value = (e as Error).message
    notify(`嗅探失败：${(e as Error).message}`)
  } finally {
    busy.value = false
  }
}

function onOpenWindow(): void {
  const target = ps.embedUrl || ps.result?.parseUrl || ps.result?.pageUrl || ps.url
  if (!target) return
  ps.openWindow(target)
}

async function onAdd(): Promise<void> {
  if (!newName.value.trim() || !newApi.value.trim()) {
    notify('名称与接口地址都要填')
    return
  }
  manageBusy.value = true
  try {
    const probe = await ps.add(newName.value.trim(), newApi.value.trim())
    notify(probe.ok ? `已添加并测活通过（${probe.latencyMs ?? 0}ms）` : `已添加，但测活失败：${probe.error ?? ''}`)
    newName.value = ''
    newApi.value = ''
  } catch (e) {
    notify((e as Error).message)
  } finally {
    manageBusy.value = false
  }
}

/** 批量导入：每行 `名称,接口地址` 或 `名称 接口地址` 或裸地址 */
async function onImport(): Promise<void> {
  const lines = importText.value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('//'))
  if (!lines.length) {
    notify('没有可导入的行')
    return
  }
  manageBusy.value = true
  let ok = 0
  let fail = 0
  try {
    for (const line of lines) {
      const parts = line.split(/[\s,，|]+/).filter(Boolean)
      const api = parts.find((p) => /^https?:\/\//i.test(p)) ?? ''
      if (!api) {
        fail++
        continue
      }
      const name = parts.find((p) => p !== api && !/^https?:\/\//i.test(p)) ?? hostOf(api)
      try {
        await ps.add(name, api)
        ok++
      } catch {
        fail++
      }
    }
    notify(`导入完成：成功 ${ok} / 失败 ${fail}`)
    if (ok) importText.value = ''
  } finally {
    manageBusy.value = false
  }
}

async function onProbeAll(): Promise<void> {
  manageBusy.value = true
  try {
    const r = await ps.probe()
    notify(`测活完成：可用 ${r.ok} / 失效 ${r.fail}`)
  } finally {
    manageBusy.value = false
  }
}

async function onSyncPresets(): Promise<void> {
  manageBusy.value = true
  try {
    const n = await ps.syncPresets()
    notify(n ? `已补充 ${n} 个预设接口` : '预设接口都已存在')
    await ps.loadPresets().catch(() => {})
  } finally {
    manageBusy.value = false
  }
}

async function onToggle(sid: string, enabled: boolean): Promise<void> {
  await ps.update(sid, { enabled }).catch((e) => notify((e as Error).message))
}

async function onRemove(sid: string): Promise<void> {
  await ps.remove(sid).catch((e) => notify((e as Error).message))
}

async function onProbeOne(sid: string): Promise<void> {
  const r = await ps.probe(sid)
  notify(r.ok ? '接口可用' : '接口不可用（详见状态）')
}

function onPickHistory(u: string): void {
  ps.url = u
  void onResolve()
}
</script>

<template>
  <div class="parse-view">
    <!-- 工具条：接口 + 地址 + 动作 -->
    <div class="card bar">
      <div class="bar-row">
        <div class="sel-wrap">
          <select :value="ps.currentId" class="sel" @change="ps.select(($event.target as HTMLSelectElement).value)">
            <option value="">直连嗅探（不用接口）</option>
            <option v-for="s in services" :key="s.id" :value="s.id">
              {{ statusOf(s) === 'ok' ? '● ' : statusOf(s) === 'fail' ? '○ ' : '· ' }}{{ s.name }}
            </option>
          </select>
          <span
            class="dot"
            :class="ps.currentStatus === true ? 'ok' : ps.currentStatus === false ? 'bad' : 'none'"
            :title="ps.currentStatus === true ? '最近测活可用' : ps.currentStatus === false ? '最近测活失效' : '未测活'"
          ></span>
        </div>
        <input
          v-model="ps.url"
          class="url"
          placeholder="粘贴视频播放页地址，如 https://v.qq.com/x/cover/xxxx.html"
          spellcheck="false"
          @keyup.enter="onResolve"
        />
        <button class="btn primary" :disabled="busy || !ps.url.trim()" @click="onResolve">
          {{ busy ? '解析中…' : '解析播放' }}
        </button>
        <button class="btn" :disabled="busy || !ps.url.trim()" @click="onEmbed">内嵌播放</button>
        <button class="btn ghost" :disabled="!ps.url.trim()" @click="onOpenWindow">新窗口</button>
        <button class="btn ghost" :class="{ active: showManage }" @click="showManage = !showManage">
          接口管理
        </button>
      </div>
      <div class="hint">
        接口只负责把页面地址换成直链；拿不到直链时会自动嗅探播放页，再不行才内嵌。
        支持站点取决于接口能力（爱奇艺 / 腾讯 / 优酷 / 芒果TV / 乐视 / 搜狐 / B站 / AcFun 等），
        直链与嗅探对任意站点通用。
      </div>
    </div>

    <!-- 播放区 -->
    <div class="card stage">
      <div class="stage-head">
        <h3>解析结果</h3>
        <div class="badges">
          <span v-if="ps.result" class="badge" :class="ps.result.kind">
            {{ ps.result.kind === 'direct' ? '直链' : '播放页' }}
          </span>
          <span v-if="ps.result?.via" class="badge ghost">{{ ps.result.via }}</span>
          <span v-if="ps.result?.serviceName" class="badge ghost">{{ ps.result.serviceName }}</span>
          <span v-if="ps.result" class="badge ghost">{{ ps.result.latencyMs }}ms</span>
        </div>
      </div>

      <div class="screen force-dark" :class="{ live: canEmbed }">
        <iframe
          v-if="canEmbed"
          :src="ps.embedUrl"
          class="frame"
          allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
          referrerpolicy="no-referrer"
        ></iframe>
        <div v-else-if="busy" class="ph">
          <div class="spinner"></div>
          <div class="ph-title">{{ ps.statusText || '正在解析…' }}</div>
          <div class="ph-sub">解析过程：接口直链 → 页面嗅探 → 内嵌兜底</div>
        </div>
        <div v-else-if="ps.error" class="ph err">
          <div class="ph-title">解析失败</div>
          <div class="ph-sub">{{ ps.error }}</div>
          <div class="ph-actions">
            <button class="btn sm" @click="onResniff">重试嗅探</button>
            <button class="btn sm ghost" @click="onOpenWindow">新窗口打开</button>
            <button class="btn sm ghost" @click="showManage = true">换个接口</button>
          </div>
        </div>
        <div v-else class="ph">
          <div class="ph-ico" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10.4 13.6a3.5 3.5 0 0 0 4.9 0l3-3a3.5 3.5 0 0 0-4.9-4.9l-1 1M13.6 10.4a3.5 3.5 0 0 0-4.9 0l-3 3a3.5 3.5 0 0 0 4.9 4.9l1-1" />
            </svg>
          </div>
          <div class="ph-title">把播放页地址粘进来，点「解析播放」</div>
          <div class="ph-sub">
            优先走接口直链（可缓存、可选 mpv 内核）；接口不给直链时自动嗅探；站点禁止内嵌时用「新窗口」。
          </div>
          <div class="site-list">
            <span v-for="s in ['爱奇艺', '腾讯视频', '优酷', '芒果TV', '乐视', '搜狐', 'B站', 'AcFun']" :key="s">
              {{ s }}
            </span>
          </div>
        </div>
      </div>

      <!-- 结果细节 -->
      <div v-if="ps.result" class="detail">
        <div class="kv">
          <span class="k">页面</span>
          <span class="v mono">{{ ps.result.pageUrl }}</span>
        </div>
        <div v-if="ps.result.parseUrl" class="kv">
          <span class="k">接口地址</span>
          <span class="v mono">{{ ps.result.parseUrl }}</span>
        </div>
        <div v-if="ps.result.note" class="kv">
          <span class="k">说明</span>
          <span class="v">{{ ps.result.note }}</span>
        </div>
        <div v-if="ps.stage === 'embedding' || ps.sniffedUrl" class="actions">
          <button class="btn sm" @click="onResniff">重新嗅探</button>
          <button class="btn sm ghost" @click="onOpenWindow">新窗口</button>
        </div>
        <div v-if="candidates.length > 1" class="cands">
          <div class="cands-title">候选直链（{{ candidates.length }}）</div>
          <div v-for="(u, i) in candidates" :key="u" class="cand">
            <span class="idx">{{ i + 1 }}</span>
            <span class="mono">{{ u }}</span>
            <button class="btn xs" @click="startPlay(u)">播放</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 最近解析 -->
    <div v-if="ps.history.length" class="card">
      <div class="row-head">
        <h3>最近解析</h3>
        <button class="btn xs ghost" @click="ps.clearHistory()">清空</button>
      </div>
      <div class="hist">
        <button
          v-for="h in ps.history"
          :key="h.url + h.ts"
          class="hist-item"
          :title="h.url"
          @click="onPickHistory(h.url)"
        >
          <span class="hist-site">{{ hostOf(h.url) }}</span>
          <span class="hist-meta">
            {{ h.service }} · {{ h.via === 'direct' ? '直链' : h.via === 'sniff' ? '嗅探' : '内嵌' }}
          </span>
        </button>
      </div>
    </div>

    <!-- 接口管理 -->
    <div v-if="showManage" class="card">
      <div class="row-head">
        <h3>解析接口管理</h3>
        <div class="row-actions">
          <button class="btn xs" :disabled="manageBusy || !!ps.probing" @click="onProbeAll">
            {{ ps.probing === 'all' ? '测活中…' : '全部测活' }}
          </button>
          <button class="btn xs ghost" :disabled="manageBusy" @click="onSyncPresets">恢复预设</button>
        </div>
      </div>
      <p class="dim small tip">
        免费解析接口生存期很短（域名被替换成关停页是常态），所以这里支持自建/导入：
        接口模板支持 <code>https://host/?url=</code> 与 <code>https://host/jx.php?url={url}</code> 两种写法。
      </p>

      <table class="table">
        <thead>
          <tr>
            <th class="c-name">名称</th>
            <th>接口地址</th>
            <th class="c-st">状态</th>
            <th class="c-ops"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in ps.services" :key="s.id">
            <td>
              <span class="name">{{ s.name }}</span>
              <span v-if="s.builtin" class="tag">预设</span>
            </td>
            <td class="mono api">{{ s.api }}</td>
            <td>
              <span class="st" :class="statusOf(s)">
                {{
                  s.api === 'direct://'
                    ? '内置'
                    : statusOf(s) === 'ok'
                      ? `可用 ${s.latencyMs ?? 0}ms`
                      : statusOf(s) === 'fail'
                        ? '失效'
                        : '未测'
                }}
              </span>
            </td>
            <td class="ops">
              <button class="btn xs ghost" :disabled="s.api === 'direct://' || !!ps.probing" @click="onProbeOne(s.id)">
                测活
              </button>
              <button class="btn xs ghost" @click="onToggle(s.id, !s.enabled)">
                {{ s.enabled ? '停用' : '启用' }}
              </button>
              <button class="btn xs ghost danger" @click="onRemove(s.id)">删除</button>
            </td>
          </tr>
          <tr v-if="!ps.services.length">
            <td colspan="4" class="empty">还没有接口，点下面「添加」或「恢复预设」</td>
          </tr>
        </tbody>
      </table>

      <div class="add-row">
        <input v-model="newName" placeholder="名称（如 我的接口）" class="w-name" />
        <input v-model="newApi" placeholder="接口地址 https://host/?url=" class="w-api" spellcheck="false" />
        <button class="btn sm primary" :disabled="manageBusy" @click="onAdd">添加并测活</button>
        <button class="btn sm ghost" @click="showImport = !showImport">批量导入</button>
      </div>
      <div v-if="showImport" class="import">
        <textarea
          v-model="importText"
          rows="5"
          placeholder="每行一个：名称,接口地址&#10;例：冰豆解析,https://jx.xmflv.com/?url="
        ></textarea>
        <div class="import-actions">
          <button class="btn sm" :disabled="manageBusy" @click="onImport">导入</button>
          <span class="dim small">会逐条测活，失效的也会入库并标红，方便你后面替换</span>
        </div>
      </div>

      <div v-if="ps.presets.length" class="presets">
        <div class="cands-title">预设库</div>
        <div class="preset-list">
          <button
            v-for="p in ps.presets"
            :key="p.api"
            class="preset"
            :disabled="p.installed || manageBusy"
            :title="p.installed ? '已添加' : '点击添加'"
            @click="
              p.installed
                ? null
                : ps
                    .add(p.name, p.api)
                    .then((r) => notify(r.ok ? `已添加 ${p.name}` : `已添加 ${p.name}（测活失败）`))
                    .catch((e) => notify((e as Error).message))
            "
          >
            {{ p.name }}
            <span class="tag" :class="{ on: !p.installed }">{{ p.installed ? '已添加' : '添加' }}</span>
          </button>
        </div>
      </div>
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </div>
</template>

<style scoped>
.parse-view {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding-bottom: var(--sp-2);
}

/* ---- 顶部工具条：接口 + 地址 + 动作 ---- */
.bar {
  padding: var(--sp-3) var(--sp-4);
}
.bar-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
}
.sel-wrap {
  position: relative;
  display: flex;
  align-items: center;
  flex: none;
}
/* 接口下拉：带状态点，右侧留出圆点位置 */
.sel {
  appearance: none;
  width: auto;
  min-width: 176px;
  max-width: 220px;
  padding: 7px 30px 7px 11px;
  font-size: var(--fs-sm);
}
.sel-wrap .dot {
  position: absolute;
  right: 12px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  pointer-events: none;
}
.dot.ok {
  background: var(--ok);
  box-shadow: 0 0 0 3px var(--ok-bg);
}
.dot.bad {
  background: var(--danger);
}
.dot.none {
  background: var(--text-faint);
}
.url {
  flex: 1 1 240px;
  min-width: 0;
}
/* 说明文案行宽收窄：一行 100+ 字读起来很累 */
.hint {
  max-width: 92ch;
  margin-top: var(--sp-2);
  font-size: var(--fs-2xs);
  line-height: 1.75;
  color: var(--text-faint);
}

/* ---- 播放区 ---- */
.stage {
  padding: var(--sp-3) var(--sp-4) var(--sp-4);
}
.stage-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
}
.stage-head h3 {
  margin: 0;
}
.badges {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
}
.badge {
  padding: 1px 8px;
  border-radius: var(--r-pill);
  background: var(--accent-soft);
  color: var(--accent-ink);
  border: 1px solid var(--accent-line);
}
.badge.direct {
  background: var(--ok-bg);
  color: var(--ok);
  border-color: var(--ok-line);
}
.badge.ghost {
  background: transparent;
  color: var(--text-faint);
  border-color: var(--line);
}
/*
 * 舞台：宽度由「高度预算」反推，保证 16:9 且不会把页面撑出屏幕。
 * 之前 width:100% + aspect-ratio 会让这块黑区在 1440 宽的窗口里接近全屏高，
 * 首屏看不到「最近解析」和接口管理，滚动成本很高。
 */
.screen {
  position: relative;
  width: min(100%, calc(58vh * 16 / 9));
  margin-inline: auto;
  aspect-ratio: 16 / 9;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  overflow: hidden;
  /* 未播放时是一块「舞台」而不是黑洞：只有真正内嵌 iframe 才铺纯黑 */
  background: radial-gradient(120% 120% at 50% 0%, #131a26 0%, #0c1017 70%);
}
.screen.live {
  background: #000;
  border-color: var(--line-2);
}
.frame {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border: 0;
  background: #000;
}
.ph {
  max-width: 56ch;
  padding: var(--sp-5);
  text-align: center;
}
.ph-ico {
  display: grid;
  place-items: center;
  width: 46px;
  height: 46px;
  margin: 0 auto var(--sp-3);
  border-radius: 50%;
  background: var(--panel-3);
  border: 1px solid var(--line-2);
  color: var(--text-dim);
}
.ph-title {
  margin-bottom: 7px;
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text);
}
.ph-sub {
  font-size: var(--fs-xs);
  line-height: 1.75;
  color: var(--text-faint);
}
.ph.err .ph-title {
  color: var(--danger);
}
.ph-actions {
  display: flex;
  gap: var(--sp-2);
  justify-content: center;
  flex-wrap: wrap;
  margin-top: var(--sp-4);
}
.site-list {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
  margin-top: var(--sp-4);
}
.site-list span {
  padding: 2px 9px;
  border: 1px solid var(--line);
  border-radius: var(--r-pill);
  background: var(--panel-2);
  font-size: var(--fs-2xs);
  color: var(--text-faint);
}

/* ---- 结果细节 ---- */
.detail {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: var(--sp-3);
}
.kv {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  padding: 3px 0;
  font-size: var(--fs-xs);
  border-bottom: none;
}
.k {
  flex: none;
  width: 62px;
  color: var(--text-faint);
}
.v {
  min-width: 0;
  color: var(--text);
  overflow-wrap: anywhere;
}
.actions {
  display: flex;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
}
.cands {
  margin-top: var(--sp-3);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--line);
}
.cands-title {
  margin-bottom: var(--sp-2);
  font-size: var(--fs-2xs);
  font-weight: 600;
  letter-spacing: 0.4px;
  color: var(--text-dim);
}
.cand {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 4px 0;
  font-size: var(--fs-2xs);
  color: var(--text-dim);
}
.cand .mono {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cand .idx {
  flex: none;
  width: 16px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

/* ---- 分区标题行 ---- */
.row-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
}
.row-head h3 {
  margin: 0;
}
.row-actions {
  display: flex;
  gap: 6px;
}

/* ---- 最近解析：胶囊条目 ---- */
.hist {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.hist-item {
  display: flex;
  flex-direction: column;
  gap: 1px;
  align-items: flex-start;
  min-height: 0;
  padding: 6px 11px;
  border-radius: var(--r-md);
  background: var(--panel-2);
  border: 1px solid var(--line);
  text-align: left;
}
.hist-item:hover:not(:disabled) {
  border-color: var(--accent-line);
  background: var(--panel-3);
}
.hist-site {
  font-size: var(--fs-xs);
  color: var(--text);
}
.hist-meta {
  font-size: var(--fs-2xs);
  color: var(--text-faint);
}

/* ---- 接口管理 ---- */
.tip {
  margin: 0 0 var(--sp-3);
  max-width: 96ch;
  font-size: var(--fs-2xs);
  line-height: 1.7;
  color: var(--text-faint);
}
.tip code {
  padding: 1px 5px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--panel-2);
}
.table-wrap table {
  min-width: 560px;
  table-layout: fixed;
}
.c-name {
  width: 150px;
}
.c-st {
  width: 92px;
}
.c-ops {
  width: 172px;
  text-align: right;
}
.name {
  color: var(--text);
}
.tag {
  margin-left: 6px;
  padding: 0 4px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  font-size: 10px;
  color: var(--text-faint);
}
.tag.on {
  border-color: var(--accent-line);
  color: var(--accent-ink);
}
.api {
  color: var(--text-faint);
  word-break: break-all;
}
.st {
  font-size: var(--fs-2xs);
}
.st.ok {
  color: var(--ok);
}
.st.fail {
  color: var(--danger);
}
.st.none {
  color: var(--text-faint);
}
.ops {
  display: flex;
  gap: 5px;
  justify-content: flex-end;
}
.add-row {
  display: flex;
  gap: var(--sp-2);
  margin-top: var(--sp-3);
  flex-wrap: wrap;
}
.w-name {
  flex: none;
  width: 180px;
}
.w-api {
  flex: 1 1 240px;
  min-width: 0;
}
.import {
  margin-top: var(--sp-2);
}
.import textarea {
  width: 100%;
  min-height: 84px;
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: var(--fs-xs);
}
.import-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin-top: var(--sp-2);
}
.presets {
  margin-top: var(--sp-4);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--line);
}
.preset-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.preset {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 0 10px;
  font-size: var(--fs-xs);
}

@media (max-width: 860px) {
  .sel {
    min-width: 0;
    width: 100%;
    max-width: none;
  }
  .sel-wrap {
    flex: 1 1 100%;
  }
  .url {
    flex: 1 1 100%;
  }
  .bar-row > .btn {
    flex: 1 1 auto;
  }
  .screen {
    width: 100%;
  }
  .w-name {
    width: 100%;
  }
}
</style>
