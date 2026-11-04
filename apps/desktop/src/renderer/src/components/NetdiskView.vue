<script setup lang="ts">
import { computed, onMounted } from 'vue'
import type { NetdiskItem } from '@polyframe/shared'
import { useNetdiskStore, fmtExpiry, fmtSize, fmtWhen } from '../stores/netdisk'
import { usePlayerStore } from '../stores/player'

const nd = useNetdiskStore()
const player = usePlayerStore()

onMounted(() => {
  void nd.loadAll()
})

/** 账号状态徽章文案 */
function accountBadge(status: string): { text: string; cls: string } {
  if (status === 'ok') return { text: '正常', cls: 'ok' }
  if (status === 'expired') return { text: '需重新授权', cls: 'warn' }
  return { text: '异常', cls: 'danger' }
}

/** 登录态剩余有效期（None = Cookie 模式，无固定期限） */
function tokenExpiry(ms?: number | null): string {
  if (!ms) return '长期'
  const left = ms - Date.now()
  if (left <= 0) return '已过期'
  return `${fmtExpiry(Math.floor(left / 1000))}后过期`
}

function itemIcon(it: NetdiskItem): string {
  if (it.isDir) return 'M3 6.5A1.5 1.5 0 0 1 4.5 5h3.2l1.6 2H20a1 1 0 0 1 1 1v8.5A1.5 1.5 0 0 1 19.5 18h-15A1.5 1.5 0 0 1 3 16.5z'
  if (it.kind === 'video') return 'M8 5.5v13l10.5-6.5L8 5.5z'
  if (it.kind === 'audio') return 'M9 18V7l8-2v10M9 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm8-2a2 2 0 1 1-4 0 2 2 0 0 1 4 0z'
  if (it.kind === 'image') return 'M4 5h16v14H4zM4 16l4.5-4.5 3 3L15 11l5 5'
  return 'M6 3h7l5 5v13H6z'
}

/** 该 provider 需要填哪种凭据（决定表单字段） */
const authModes = computed<string[]>(
  () => nd.providers.find((p) => p.kind === nd.form.provider)?.authModes ?? []
)

function providerHint(kind: string): string {
  return nd.providers.find((p) => p.kind === kind)?.hint ?? ''
}
</script>

<template>
  <div class="netdisk-view">
    <!-- ================= 左栏：账号 / 添加 / 分享 ================= -->
    <aside class="side">
      <section class="card">
        <h3>网盘账号</h3>
        <div v-if="!nd.accounts.length" class="empty-hint dim">
          还没有账号。请先在下方「添加账号」完成一次授权。
        </div>
        <ul v-else class="acc-list">
          <li v-for="a in nd.accounts" :key="a.id" class="acc">
            <div class="acc-main">
              <span class="acc-name">{{ a.name }}</span>
              <span class="badge">{{ a.providerName }}</span>
              <span class="badge" :class="accountBadge(a.status).cls">{{ accountBadge(a.status).text }}</span>
            </div>
            <div class="acc-meta dim small">
              登录态 {{ tokenExpiry(a.expiresAt) }} · 最近使用 {{ fmtWhen(a.lastUsedAt) }}
            </div>
            <div v-if="a.lastError" class="acc-err small">{{ a.lastError }}</div>
            <div class="acc-ops">
              <button class="btn xs" @click="nd.pickAccount(a)">浏览</button>
              <button class="btn xs ghost" @click="nd.refreshAccount(a.id)">续期</button>
              <button class="btn xs danger" @click="nd.removeAccount(a.id)">删除</button>
            </div>
          </li>
        </ul>
      </section>

      <section class="card">
        <h3>添加账号</h3>
        <div class="field">
          <label>网盘</label>
          <select v-model="nd.form.provider">
            <option v-for="p in nd.providers" :key="p.kind" :value="p.kind">
              {{ p.name }}{{ p.supportsShare ? '（支持分享）' : '' }}
            </option>
          </select>
        </div>
        <div class="field">
          <label>备注名</label>
          <input v-model="nd.form.name" placeholder="可空，默认用网盘账号名" />
        </div>

        <!-- 凭据字段按 authModes 渲染 -->
        <template v-if="authModes.includes('cookie')">
          <div class="field col">
            <label>浏览器 Cookie（需含 BDUSS=）</label>
            <textarea v-model="nd.form.cookie" rows="3" placeholder="BDUSS=xxxx; STOKEN=yyyy; …" />
          </div>
        </template>
        <template v-if="authModes.includes('token')">
          <div class="field col">
            <label>{{ nd.form.provider === 'http' ? '访问 Token' : 'refresh_token' }}</label>
            <textarea
              v-model="nd.form.refreshToken"
              rows="3"
              :placeholder="nd.form.provider === 'http' ? '网关访问 token（可空）' : '粘贴 refresh_token，自动换取 access_token'"
            />
          </div>
        </template>
        <template v-if="nd.form.provider === 'http'">
          <div class="field col">
            <label>网关地址</label>
            <input v-model="nd.form.baseUrl" placeholder="http://127.0.0.1:8080（HTTP 目录契约见文档）" />
          </div>
        </template>
        <template v-if="authModes.includes('deviceCode') && nd.form.provider === 'onedrive'">
          <div class="field col">
            <label>Azure 应用 client_id</label>
            <input v-model="nd.form.clientId" placeholder="公共客户端 App ID（Files.Read.All）" />
          </div>
        </template>

        <p class="url-hint">{{ providerHint(nd.form.provider) }}</p>

        <div class="btn-row">
          <button
            class="btn primary"
            :disabled="nd.submitting || (!nd.form.cookie && !nd.form.refreshToken && !authModes.includes('deviceCode'))"
            @click="nd.addAccount()"
          >
            {{ nd.submitting ? '校验中…' : '添加并校验' }}
          </button>
          <button
            v-if="authModes.includes('deviceCode')"
            class="btn ghost"
            :disabled="nd.devicePending"
            @click="nd.beginDevice()"
          >
            {{ nd.devicePending ? '等待授权…' : '开始设备码授权' }}
          </button>
        </div>

        <!-- 设备码面板 -->
        <div v-if="nd.device" class="device">
          <div class="dim small">在浏览器打开以下地址，输入代码完成授权：</div>
          <div class="mono device-uri">{{ nd.device.verificationUri }}</div>
          <div class="device-code mono">{{ nd.device.userCode }}</div>
          <div class="dim small">
            有效期 {{ Math.round(nd.device.expiresIn / 60) }} 分钟 · 每 {{ nd.device.intervalSecs }} 秒自动检查
          </div>
          <div class="btn-row">
            <button class="btn sm" :disabled="!nd.devicePending" @click="nd.pollDevice(true)">我已授权</button>
            <button class="btn sm ghost" @click="nd.cancelDevice()">取消</button>
          </div>
        </div>
      </section>

      <section class="card">
        <h3>分享链接</h3>
        <div class="field col">
          <input v-model="nd.shareInput" placeholder="粘贴百度 / 阿里云盘 / OneDrive 分享链接" />
        </div>
        <div class="field">
          <input v-model="nd.sharePwd" class="w-pwd" placeholder="提取码（可空）" />
          <button class="btn primary sm" :disabled="nd.submitting || !nd.shareInput.trim()" @click="nd.addShare()">
            打开
          </button>
        </div>
        <p class="url-hint">百度分享需先「转存到我的网盘」；阿里云盘 / OneDrive 可直接浏览播放。</p>
        <ul v-if="nd.shares.length" class="share-list">
          <li v-for="s in nd.shares" :key="s.id" class="share">
            <div class="share-main">
              <span class="share-title">{{ s.title || s.shareId }}</span>
              <span class="badge">{{ s.provider }}</span>
              <span v-if="s.pwd" class="badge">码 {{ s.pwd }}</span>
            </div>
            <div class="acc-ops">
              <button class="btn xs" @click="nd.openShare(s)">浏览</button>
              <button class="btn xs danger" @click="nd.removeShare(s.id)">删除</button>
            </div>
          </li>
        </ul>
      </section>
    </aside>

    <!-- ================= 右栏：目录浏览 ================= -->
    <section class="card browser">
      <div class="browser-head">
        <div class="crumb-row">
          <template v-if="nd.target">
            <template v-for="(c, i) in nd.pathList" :key="`${c.id}-${i}`">
              <span v-if="i > 0" class="crumb-sep">/</span>
              <button class="crumb" :class="{ cur: i === nd.pathList.length - 1 }" @click="nd.goPath(i)">
                {{ c.name }}
              </button>
            </template>
          </template>
          <span v-else class="dim">未选择来源</span>
        </div>
        <div class="btn-group tight">
          <button class="btn sm ghost" :disabled="!nd.crumbs.length" @click="nd.goPath(nd.pathList.length - 2)">
            上级
          </button>
          <button class="btn sm ghost" :disabled="!nd.target || nd.loading" @click="nd.reload()">刷新</button>
        </div>
      </div>

      <div v-if="nd.lastPlay" class="link-strip small">
        播放地址已就绪 · 直链 {{ fmtExpiry(nd.lastPlay.expiresInSecs) }} 后到期 · 注入
        {{ nd.lastPlay.headerCount }} 个请求头 · 到期由本地代理自动换链
        <span v-if="nd.lastPlay.host" class="mono dim">（{{ nd.lastPlay.host }}）</span>
      </div>
      <div v-if="nd.error" class="alert">{{ nd.error }}</div>
      <div v-else-if="nd.notice" class="notice">{{ nd.notice }}</div>

      <div v-if="nd.items.length" class="table-wrap">
        <table>
          <thead>
            <tr>
              <th class="col-name">名称</th>
              <th class="col-size">大小</th>
              <th class="col-time">修改时间</th>
              <th class="col-ops">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="it in nd.items" :key="it.id" :class="{ dir: it.isDir }">
              <td class="col-name">
                <span class="name-cell">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                    <path :d="itemIcon(it)" />
                  </svg>
                  <button v-if="it.isDir" class="link-name" @click="nd.enterDir(it)">{{ it.name }}</button>
                  <span v-else class="file-name" :title="it.name">{{ it.name }}</span>
                  <span v-if="!it.isDir && it.kind === 'video'" class="badge ok">视频</span>
                </span>
              </td>
              <td class="col-size dim">{{ it.isDir ? '—' : fmtSize(it.size) }}</td>
              <td class="col-time dim">{{ fmtWhen(it.modifiedAt) }}</td>
              <td class="col-ops">
                <div v-if="it.isDir" class="row-actions">
                  <button class="btn xs ghost" @click="nd.enterDir(it)">进入</button>
                  <button class="btn xs ghost" title="收藏为剧集：目录内视频自动成为剧集列表，支持连播/续播/追更" @click="nd.favorite(it)">收藏</button>
                </div>
                <div v-else-if="it.kind === 'video'" class="row-actions">
                  <button class="btn xs" @click="nd.playNow(it)">播放</button>
                  <button class="btn xs ghost" @click="nd.addAsTask(it)">加入任务</button>
                  <button class="btn xs ghost" title="收藏为电影，支持继续观看" @click="nd.favorite(it)">收藏</button>
                </div>
                <span v-else class="dim small">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-else class="empty browser-empty">
        <template v-if="nd.loading">
          <span class="spinner" aria-hidden="true"></span>
          <div class="empty-title">正在读取目录…</div>
        </template>
        <template v-else>
          <div class="empty-ico">{{ nd.target ? '📂' : '🗂' }}</div>
          <div class="empty-title">{{ nd.target ? '这个目录是空的' : '还没有选择来源' }}</div>
          <div class="empty-sub">
            {{
              nd.target
                ? '该目录没有可显示的文件；可以返回上级，或换一个账号 / 分享链接。'
                : '从左栏选择一个账号或分享开始浏览；网盘里的视频可以直接播放，也可以加入任务预缓存。'
            }}
          </div>
        </template>
      </div>

      <div v-if="nd.canLoadMore" class="more-row">
        <button class="btn sm ghost" :disabled="nd.loadingMore" @click="nd.loadMore()">
          {{ nd.loadingMore ? '加载中…' : `加载更多${nd.total ? `（共 ${nd.total} 项）` : ''}` }}
        </button>
      </div>

      <p class="url-hint">
        提示：「播放」直接用稳定 shim 地址起播（不落盘）；「加入任务」走既有分块/缓存管线，
        可预缓存、断点续存、按播放头水位调度。当前新任务缓存档：
        <span class="mono">{{ player.newTaskCacheMode }}</span>
      </p>
    </section>
  </div>
</template>

<style scoped>
/* 左栏固定 320，右栏吃掉剩余宽度；窄屏堆叠 */
.netdisk-view {
  width: 100%;
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  gap: var(--sp-4);
  align-items: start;
}
.side {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  min-width: 0;
}
.browser {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

/* ---- 账号 / 分享列表 ---- */
.acc-list,
.share-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.acc,
.share {
  padding: 9px 10px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--panel-2);
  transition: border-color var(--t-base) var(--ease);
}
.acc:hover,
.share:hover {
  border-color: var(--line-2);
}
.acc-main,
.share-main {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  margin-bottom: 3px;
}
.acc-name,
.share-title {
  font-size: var(--fs-sm);
  font-weight: 500;
  color: var(--text);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.acc-meta {
  font-size: var(--fs-2xs);
  color: var(--text-faint);
  line-height: 1.5;
}
.acc-err {
  margin-top: 3px;
  font-size: var(--fs-2xs);
  color: var(--danger);
  overflow-wrap: anywhere;
}
.acc-ops {
  display: flex;
  gap: 5px;
  margin-top: 7px;
}

/* ---- 表单 ---- */
.field {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-2);
}
.field.col {
  flex-direction: column;
  align-items: stretch;
  gap: 5px;
}
.field > label {
  flex: none;
  min-width: 58px;
  font-size: var(--fs-2xs);
  color: var(--text-dim);
}
.field.col > label {
  min-width: 0;
}
.field textarea {
  flex: 1;
  min-height: 62px;
  font-size: var(--fs-xs);
}
.w-pwd {
  flex: 0 1 130px;
}
/* 设备码授权面板：等宽大字 + 虚线框，扫一眼就能抄 */
.device {
  margin-top: var(--sp-3);
  padding: 10px;
  border: 1px dashed var(--line-2);
  border-radius: var(--r-md);
  background: var(--panel-2);
}
.device-uri {
  margin-top: 5px;
  color: var(--accent-ink);
  overflow-wrap: anywhere;
}
.device-code {
  margin: 6px 0;
  font-size: 22px;
  letter-spacing: 3px;
  color: var(--text);
}

/* ---- 面包屑 + 工具 ---- */
.browser-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  flex-wrap: wrap;
}
.crumb-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 3px;
  min-width: 0;
  font-size: var(--fs-sm);
}
.crumb {
  min-height: 24px;
  padding: 0 6px;
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-dim);
  font-size: var(--fs-sm);
  box-shadow: none;
}
.crumb:hover:not(:disabled) {
  background: var(--panel-3);
  border: none;
  color: var(--text);
  transform: none;
}
.crumb.cur {
  color: var(--text);
  font-weight: 600;
}
.crumb-sep {
  color: var(--text-faint);
}
/* 播放地址就绪提示：绿色系语义条 */
.link-strip {
  padding: 7px 11px;
  border: 1px solid var(--ok-line);
  border-radius: var(--r-md);
  background: var(--ok-bg);
  color: var(--ok);
  font-size: var(--fs-2xs);
  line-height: 1.6;
}

/* ---- 文件表 ---- */
.table-wrap table {
  min-width: 520px;
  table-layout: fixed;
}
.col-name {
  width: auto;
}
.col-size {
  width: 88px;
}
.col-time {
  width: 96px;
}
.col-ops {
  width: 176px;
  text-align: right;
}
/* 目录行：轻微提亮 + 名称用强调色，扫表时能一眼分出层级 */
tr.dir td {
  background: rgb(255 255 255 / 0.018);
}
tr.dir:hover td {
  background: rgb(255 255 255 / 0.04);
}
.name-cell {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.name-cell > svg {
  flex: none;
  color: var(--text-faint);
}
tr.dir .name-cell > svg {
  color: var(--accent);
}
.file-name,
.link-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.link-name {
  min-height: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: var(--fs-xs);
  box-shadow: none;
  text-align: left;
}
.link-name:hover:not(:disabled) {
  background: transparent;
  border: none;
  color: var(--accent-ink);
  text-decoration: underline;
  text-underline-offset: 2px;
  transform: none;
}
.badge.ok {
  background: var(--ok-bg);
  color: var(--ok);
}
.badge.warn {
  background: var(--warn-bg);
  color: var(--warn);
}
.badge.danger {
  background: var(--danger-bg);
  color: var(--danger);
}
.row-actions {
  display: flex;
  justify-content: flex-end;
  gap: 5px;
}
.more-row {
  display: flex;
  justify-content: center;
  padding: 2px 0;
}
/* 空目录 / 未选来源：放在表格位置，高度与表格首屏接近，切换时不跳 */
.browser-empty {
  min-height: 210px;
  border: 1px dashed var(--line-2);
  border-radius: var(--r-md);
  background: var(--panel-2);
}
/* 底部说明行宽收窄 */
.browser > .url-hint {
  max-width: 96ch;
  line-height: 1.7;
}

@media (max-width: 1000px) {
  .netdisk-view {
    grid-template-columns: minmax(0, 1fr);
  }
  .side {
    gap: var(--sp-3);
  }
}
@media (max-width: 640px) {
  .col-time {
    display: none;
  }
  .table-wrap table {
    min-width: 420px;
  }
  .col-ops {
    width: 140px;
  }
  .row-actions {
    gap: 4px;
  }
}
</style>
