/**
 * P50：应用内版本检查 + 自动升级。
 *
 * 设计要点：
 * - 不用 electron-updater：它对 portable 形态支持差，也没法按「多代理通道」逐个降级。
 * - 更新源 = GitHub Releases。国内直连 github 经常不通，所以所有请求（元数据 + 安装包）
 *   都走「通道列表」：直连优先，失败后逐个尝试 gh-proxy 系镜像前缀（prefix + 完整 URL），
 *   成功的通道记进配置，下次优先用。
 * - 下载用 HTTP Range 断点续传：.part 半成品留在本地，失败重试不从头拉。
 * - SHA256 校验：Release 里若存在 `<安装包名>.sha256` 资产则强校验，不匹配删包报错。
 * - 双形态（`win.target: nsis + portable`）分开处理：
 *   · 安装版：下载 Setup.exe → 「等待本进程退出 → /S 静默安装 → 拉起新版」的 cmd 脚本接管；
 *     NSIS 记忆注册表里的安装目录，用户数据在 %LOCALAPPDATA%/PolyFrame 与安装目录分离，升级不丢。
 *   · 便携版：利用 Windows「运行中的 exe 仍可重命名」的特性自替换：
 *     当前 exe → .pfold，新 exe 挪到原位 → 拉起新版。保留一代 .pfold 供还原/回退。
 * - 版本回退：历史 Release 列表里挑旧版下载安装（同一套流程）；便携版另有「还原上一版」。
 */

import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { app, type BrowserWindow } from 'electron'
import { write as diag } from './diag'

// ---------- 类型 ----------

export type UpdateForm = 'installer' | 'portable' | 'dev'
export type UpdatePhase =
  | 'idle' // 未检查
  | 'checking' // 检查中
  | 'uptodate' // 已是最新
  | 'available' // 有新版
  | 'downloading' // 下载中
  | 'downloaded' // 包就绪，可一键升级
  | 'applying' // 应用中（即将退出）
  | 'error' // 出错（error 字段有原因）

export interface UpdateConfig {
  /** 是否自动检查（启动时 + 定期） */
  enabled: boolean
  /** 发现新版后自动下载升级包 */
  autoDownload: boolean
  /** 定期检查间隔（小时） */
  intervalHours: number
  /** GitHub 仓库，owner/name */
  repo: string
  /** 用户自定义代理通道前缀（以 / 结尾） */
  extraChannels: string[]
  /** 被禁用的内置通道 id */
  disabledChannels: string[]
  /** 最近一次成功的通道 id（记忆，避免每次都把坏通道试一遍） */
  lastGoodChannel: string
}

export interface UpdateProgress {
  received: number
  total: number
  /** 字节/秒 */
  speed: number
}

export interface ReleaseInfo {
  tag: string
  name: string
  notes: string
  publishedAt: string
  url: string
}

export interface UpdateState {
  phase: UpdatePhase
  form: UpdateForm
  currentVersion: string
  config: UpdateConfig
  /** 检查到的最新版本（含已是最新时也带回，供 UI 展示） */
  latest: ReleaseInfo | null
  /** 历史版本（回退用，最近一次「查看历史版本」的结果缓存） */
  history: ReleaseInfo[]
  progress: UpdateProgress | null
  /** 已就绪的升级包信息 */
  pkg: { path: string; tag: string; name: string; shaVerified: boolean } | null
  /** 便携版 .pfold 备份是否可还原 */
  backupAvailable: boolean
  /** 本次会话实际使用的通道 */
  channel: string
  error: string
}

interface ReleaseAsset {
  name: string
  size: number
  browser_download_url: string
}

interface GithubRelease {
  tag_name?: string
  name?: string
  body?: string
  published_at?: string
  html_url?: string
  prerelease?: boolean
  draft?: boolean
  assets?: ReleaseAsset[]
}

// ---------- 常量 ----------

/** 更新包缓存目录：放在内核数据根下，两种形态都指向同一处，且升级/换形态都不丢 */
export function updatesDir(): string {
  const root = process.env.LOCALAPPDATA || app.getPath('userData')
  return path.join(root, 'PolyFrame', 'updates')
}

/** 便携版自替换产生的上一代备份后缀 */
const OLD_SUFFIX = '.pfold'
const STAGE_SUFFIX = '.pfnew'
/** 更新源配置（userData 下，UI 偏好域） */
const CONFIG_FILE = 'update-config.json'
/** 便携版升级成功标记 */
const APPLIED_FILE = 'applied-version.json'

const DEFAULT_PROXIES: { id: string; prefix: string }[] = [
  { id: 'gh-proxy.com', prefix: 'https://gh-proxy.com/' },
  { id: 'ghfast.top', prefix: 'https://ghfast.top/' },
  { id: 'ghproxy.net', prefix: 'https://ghproxy.net/' },
  { id: 'gh.llkk.cc', prefix: 'https://gh.llkk.cc/' }
]

/** 未显式配置仓库时的缺省值；已指向真实发布仓库（P53 发布批） */
const DEFAULT_REPO = 'fengxue409/polyframe-player'

const DEFAULT_CONFIG: UpdateConfig = {
  enabled: true,
  autoDownload: true,
  intervalHours: 6,
  repo: process.env.PF_UPDATE_REPO || DEFAULT_REPO,
  extraChannels: [],
  disabledChannels: [],
  lastGoodChannel: ''
}

const METADATA_TIMEOUT_MS = 15_000
const SHA_TIMEOUT_MS = 15_000
/** 下载空闲超时：45s 没有任何字节进来就断（断点续传可重试） */
const DOWNLOAD_IDLE_TIMEOUT_MS = 45_000

// ---------- 工具 ----------

export function detectForm(): UpdateForm {
  if (process.env.PORTABLE_EXECUTABLE_FILE) return 'portable'
  if (app.isPackaged) return 'installer'
  return 'dev'
}

/** 宽松 semver 比较：返回 >0 表示 a 更新。支持 v 前缀与 -prerelease */
export function compareVersion(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: string } => {
    const s = String(v ?? '').trim().replace(/^v/i, '')
    const m = s.match(/^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?/)
    if (!m) return { nums: [0, 0, 0], pre: '' }
    const nums = m[1].split('.').map((n) => Number.parseInt(n, 10) || 0)
    while (nums.length < 3) nums.push(0)
    return { nums, pre: m[2] ?? '' }
  }
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i]
  }
  // 无预发布号 > 有预发布号
  if (pa.pre && pb.pre) return pa.pre < pb.pre ? -1 : pa.pre > pb.pre ? 1 : 0
  if (pa.pre) return -1
  if (pb.pre) return 1
  return 0
}

function sanitizeTag(tag: string): string {
  return String(tag ?? '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 64) || 'latest'
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = fs.createReadStream(file)
    stream.on('data', (d) => hash.update(d))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

// ---------- Updater ----------

export class Updater {
  private config: UpdateConfig = { ...DEFAULT_CONFIG }
  private state: UpdateState = {
    phase: 'idle',
    form: 'dev',
    currentVersion: app.getVersion(),
    config: { ...DEFAULT_CONFIG },
    latest: null,
    history: [],
    progress: null,
    pkg: null,
    backupAvailable: false,
    channel: '',
    error: ''
  }
  private broadcast: ((st: UpdateState) => void) | null = null
  private checkTimer: NodeJS.Timeout | null = null
  private checking = false
  private downloading = false
  private applyRequested = false

  bindBroadcast(fn: (st: UpdateState) => void): void {
    this.broadcast = fn
  }

  /** app ready 后调用：载配置、清理便携版备份、调度自动检查 */
  init(): void {
    this.state.form = detectForm()
    this.config = this.loadConfig()
    this.state.config = { ...this.config }
    this.cleanupPortableAfterUpgrade()
    this.state.backupAvailable = this.hasPortableBackup()
    this.scheduleAutoCheck()
    diag('update', `init form=${this.state.form} v${this.state.currentVersion} repo=${this.config.repo}`)
  }

  dispose(): void {
    if (this.checkTimer) clearTimeout(this.checkTimer)
    this.checkTimer = null
  }

  getState(): UpdateState {
    return this.state
  }

  // ----- 配置 -----

  private configPath(): string {
    return path.join(app.getPath('userData'), CONFIG_FILE)
  }

  private loadConfig(): UpdateConfig {
    try {
      const raw = JSON.parse(readFileSync(this.configPath(), 'utf8')) as Partial<UpdateConfig>
      return {
        ...DEFAULT_CONFIG,
        ...raw,
        intervalHours: Math.min(72, Math.max(1, Number(raw.intervalHours) || DEFAULT_CONFIG.intervalHours)),
        extraChannels: Array.isArray(raw.extraChannels) ? raw.extraChannels.filter((s) => typeof s === 'string') : [],
        disabledChannels: Array.isArray(raw.disabledChannels) ? raw.disabledChannels.filter((s) => typeof s === 'string') : []
      }
    } catch {
      return { ...DEFAULT_CONFIG }
    }
  }

  private saveConfig(): void {
    try {
      mkdirSync(path.dirname(this.configPath()), { recursive: true })
      writeFileSync(this.configPath(), JSON.stringify(this.config, null, 2), 'utf8')
    } catch (err) {
      diag('update', `saveConfig failed: ${(err as Error).message}`)
    }
  }

  async setConfig(patch: Partial<UpdateConfig>): Promise<UpdateState> {
    const prevInterval = this.config.intervalHours
    this.config = {
      ...this.config,
      ...patch,
      intervalHours: Math.min(72, Math.max(1, Number(patch.intervalHours ?? this.config.intervalHours) || 6)),
      extraChannels: Array.isArray(patch.extraChannels)
        ? patch.extraChannels.filter((s) => typeof s === 'string')
        : this.config.extraChannels,
      disabledChannels: Array.isArray(patch.disabledChannels)
        ? patch.disabledChannels.filter((s) => typeof s === 'string')
        : this.config.disabledChannels
    }
    this.state.config = { ...this.config }
    this.saveConfig()
    if (patch.intervalHours !== undefined && patch.intervalHours !== prevInterval) this.scheduleAutoCheck()
    if (patch.enabled === true) void this.check('config-enabled')
    this.emit()
    return this.state
  }

  // ----- 通道 -----

  /** 本次会话的通道列表：记忆的优先，其后直连、内置镜像、自定义 */
  private channels(): { id: string; prefix: string }[] {
    const list = [{ id: 'direct', prefix: '' }, ...DEFAULT_PROXIES]
    const extra = this.config.extraChannels
      .map((s) => s.trim())
      .filter(Boolean)
      .map((prefix, i) => ({ id: `custom-${i + 1}`, prefix: prefix.endsWith('/') ? prefix : `${prefix}/` }))
    const all = [...list, ...extra]
    const good = all.find((c) => c.id === this.config.lastGoodChannel)
    const rest = all.filter((c) => c.id !== this.config.lastGoodChannel && !this.config.disabledChannels.includes(c.id))
    return good ? [good, ...rest] : rest
  }

  /** 通道可用性探测（UI 手动触发）：逐个 GET 元数据 URL 计时 */
  async testChannels(): Promise<{ id: string; prefix: string; ok: boolean; ms: number; error?: string }[]> {
    const url = `https://api.github.com/repos/${this.config.repo}/releases/latest`
    const out: { id: string; prefix: string; ok: boolean; ms: number; error?: string }[] = []
    for (const c of this.channels()) {
      const t0 = Date.now()
      try {
        const res = await fetch(c.prefix + url, {
          signal: AbortSignal.timeout(8_000),
          headers: { 'User-Agent': 'PolyFrame-Player', Accept: 'application/vnd.github+json' }
        })
        out.push({ id: c.id, prefix: c.prefix, ok: res.ok, ms: Date.now() - t0, error: res.ok ? undefined : `HTTP ${res.status}` })
      } catch (err) {
        out.push({ id: c.id, prefix: c.prefix, ok: false, ms: Date.now() - t0, error: (err as Error).message })
      }
    }
    return out
  }

  /**
   * 逐通道请求，成功的通道 id 记忆进配置。全部失败抛最后一个错误。
   */
  private async fetchViaChannels(
    url: string,
    timeoutMs: number,
    headers: Record<string, string> = {},
    /** 外部信号（下载用空闲超时控制）；给了它就不内部设 timeout */
    externalSignal?: AbortSignal
  ): Promise<{ res: Response; channelId: string }> {
    let lastErr: Error | null = null
    for (const c of this.channels()) {
      try {
        const res = await fetch(c.prefix + url, {
          signal: externalSignal ?? AbortSignal.timeout(timeoutMs),
          headers: { 'User-Agent': 'PolyFrame-Player', ...headers }
        })
        if (!res.ok) {
          lastErr = new Error(`HTTP ${res.status} via ${c.id}`)
          diag('update', `fetch ${url} -> ${res.status} via ${c.id}`)
          continue
        }
        if (c.id !== this.config.lastGoodChannel) {
          this.config.lastGoodChannel = c.id
          this.state.config = { ...this.config }
          this.saveConfig()
        }
        return { res, channelId: c.id }
      } catch (err) {
        lastErr = err as Error
        diag('update', `fetch ${url} failed via ${c.id}: ${(err as Error).message}`)
      }
    }
    throw lastErr ?? new Error('所有更新通道均不可用')
  }

  // ----- 检查 -----

  /** 拉最新 Release 元数据；返回 null 表示网络全挂但不想报错打扰的场合暂不区分 */
  private async fetchLatest(): Promise<{ release: GithubRelease; channelId: string }> {
    const url = `https://api.github.com/repos/${this.config.repo}/releases/latest`
    const { res, channelId } = await this.fetchViaChannels(url, METADATA_TIMEOUT_MS, {
      Accept: 'application/vnd.github+json'
    })
    const release = (await res.json()) as GithubRelease
    if (!release.tag_name) throw new Error('元数据缺少 tag_name')
    return { release, channelId }
  }

  private pickAsset(release: GithubRelease): { asset: ReleaseAsset; sha: ReleaseAsset | null } | null {
    const assets = (release.assets ?? []).filter((a) => a && a.name && !a.name.endsWith('.blockmap'))
    const exe = assets.filter((a) => a.name.toLowerCase().endsWith('.exe'))
    const target =
      this.state.form === 'portable'
        ? exe.find((a) => !/setup/i.test(a.name))
        : exe.find((a) => /setup/i.test(a.name)) ?? exe[0]
    if (!target) return null
    const sha = assets.find((a) => a.name === `${target.name}.sha256`) ?? null
    return { asset: target, sha }
  }

  private toReleaseInfo(r: GithubRelease): ReleaseInfo {
    return {
      tag: r.tag_name ?? '',
      name: r.name ?? r.tag_name ?? '',
      notes: (r.body ?? '').slice(0, 4000),
      publishedAt: r.published_at ?? '',
      url: r.html_url ?? ''
    }
  }

  async check(reason = 'manual'): Promise<UpdateState> {
    if (this.checking || this.downloading || this.applyRequested) return this.state
    if (!this.config.repo.includes('/')) {
      this.setPhase('error', '更新源未配置（需要 owner/repo）')
      return this.state
    }
    this.checking = true
    this.setPhase('checking')
    diag('update', `check (${reason}) repo=${this.config.repo}`)
    try {
      const { release, channelId } = await this.fetchLatest()
      this.state.channel = channelId
      const info = this.toReleaseInfo(release)
      this.state.latest = info
      if (compareVersion(info.tag, this.state.currentVersion) <= 0) {
        this.state.error = ''
        this.setPhase('uptodate')
        diag('update', `uptodate (latest ${info.tag})`)
      } else {
        const picked = this.pickAsset(release)
        if (!picked) {
          this.setPhase('error', `Release ${info.tag} 未提供${this.state.form === 'portable' ? '便携版' : '安装版'}安装包`)
        } else {
          this.setPhase('available')
          diag('update', `new version ${info.tag} asset=${picked.asset.name} (${Math.round(picked.asset.size / 1048576)}MB)`)
          // 已缓存过同版本包则直接标记就绪
          const cached = this.findCachedPkg(info.tag, picked.asset)
          if (cached) {
            this.state.pkg = { path: cached, tag: info.tag, name: picked.asset.name, shaVerified: false }
            this.setPhase('downloaded')
          } else if (this.config.autoDownload) {
            this.checking = false
            void this.download('auto')
            return this.state
          }
        }
      }
    } catch (err) {
      this.setPhase('error', `检查更新失败：${(err as Error).message}`)
    } finally {
      this.checking = false
    }
    return this.state
  }

  /** 之前下载完成的同版本包是否还在缓存目录 */
  private findCachedPkg(tag: string, asset: ReleaseAsset): string | null {
    const file = path.join(updatesDir(), `${sanitizeTag(tag)}-${asset.name}`)
    try {
      return existsSync(file) && statSync(file).size === asset.size ? file : null
    } catch {
      return null
    }
  }

  // ----- 下载（断点续传） -----

  async download(reason = 'manual'): Promise<UpdateState> {
    if (this.downloading) return this.state
    const latest = this.state.latest
    if (!latest) {
      // 没检查过就点下载：先查再下
      const st = await this.check('download-prefetch')
      if (st.phase !== 'available' && st.phase !== 'downloading') return this.state
      return this.download(reason)
    }
    this.downloading = true
    this.setPhase('downloading')
    this.state.progress = { received: 0, total: 0, speed: 0 }
    try {
      const { release } = await this.fetchLatest()
      const picked = this.pickAsset(release)
      if (!picked) throw new Error('Release 资产里找不到对应安装包')
      const { asset, sha } = picked
      const file = path.join(updatesDir(), `${sanitizeTag(latest.tag)}-${asset.name}`)
      this.state.progress.total = asset.size
      await this.downloadWithResume(asset.browser_download_url, file, asset.size)
      // 校验
      let shaVerified = false
      if (sha) {
        try {
          const { res } = await this.fetchViaChannels(sha.browser_download_url, SHA_TIMEOUT_MS)
          const text = await res.text()
          const expect = text.match(/[0-9a-fA-F]{64}/)?.[0]?.toLowerCase()
          if (expect) {
            const actual = await sha256File(file)
            if (actual !== expect) {
              try { unlinkSync(file) } catch { /* 清理失败不影响报错 */ }
              throw new Error(`SHA256 校验不匹配（期望 ${expect.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`)
            }
            shaVerified = true
          }
        } catch (err) {
          if ((err as Error).message.includes('SHA256')) throw err
          diag('update', `sha256 资产拉取失败（跳过校验）：${(err as Error).message}`)
        }
      }
      this.state.pkg = { path: file, tag: latest.tag, name: asset.name, shaVerified }
      this.state.progress = null
      this.state.error = ''
      this.setPhase('downloaded')
      diag('update', `downloaded ${file} shaVerified=${shaVerified}`)
    } catch (err) {
      this.state.progress = null
      this.setPhase('error', `下载失败：${(err as Error).message}（保留断点，可重试）`)
    } finally {
      this.downloading = false
    }
    return this.state
  }

  /**
   * Range 断点续传下载。206 从断点追加；200 说明服务器不支持续传，从头来。
   * 45s 无字节即断，保留 .part 下次继续。
   */
  private async downloadWithResume(url: string, file: string, totalSize: number): Promise<void> {
    mkdirSync(path.dirname(file), { recursive: true })
    let received = 0
    try {
      received = statSync(`${file}.part`).size
      if (received > totalSize && totalSize > 0) received = 0 // 上游换包了，断点作废
    } catch {
      received = 0
    }
    for (let attempt = 1; attempt <= 5; attempt++) {
      const headers: Record<string, string> = {}
      if (received > 0) headers.Range = `bytes=${received}-`
      // 空闲超时：45s 没有任何字节就 abort（区别于总时长超时，大包慢网也能下完）
      const ac = new AbortController()
      let idleTimer: NodeJS.Timeout | null = setTimeout(() => ac.abort(new Error('下载超时（45s 无数据）')), DOWNLOAD_IDLE_TIMEOUT_MS)
      let res: Response
      try {
        const r = await this.fetchViaChannels(url, 0, headers, ac.signal)
        res = r.res
      } catch (err) {
        if (idleTimer) clearTimeout(idleTimer)
        throw new Error(`连接失败（第 ${attempt} 次）：${(err as Error).message}`)
      }
      if (res.status === 200) received = 0 // 不支持续传，重头下
      if (res.status !== 200 && res.status !== 206) {
        if (idleTimer) clearTimeout(idleTimer)
        throw new Error(`HTTP ${res.status}`)
      }
      if (res.body === null) {
        if (idleTimer) clearTimeout(idleTimer)
        throw new Error('响应无内容')
      }

      const fd = openSync(`${file}.part`, received > 0 ? 'a' : 'w')
      let lastEmit = 0
      let lastBytes = received
      let lastTime = Date.now()
      try {
        const reader = res.body.getReader()
        await new Promise<void>((resolve, reject) => {
          const armIdle = (): void => {
            if (idleTimer) clearTimeout(idleTimer)
            idleTimer = setTimeout(() => {
              void reader.cancel().catch(() => {})
              reject(new Error('下载超时（45s 无数据）'))
            }, DOWNLOAD_IDLE_TIMEOUT_MS)
          }
          armIdle()
          const pump = (): void => {
            reader
              .read()
              .then(({ done, value }) => {
                if (done) {
                  resolve()
                  return
                }
                const buf = Buffer.from(value)
                try {
                  fs.writeSync(fd, buf)
                } catch (err) {
                  reject(err as Error)
                  return
                }
                received += buf.length
                const now = Date.now()
                if (now - lastEmit > 400) {
                  const dt = (now - lastTime) / 1000
                  this.state.progress = {
                    received,
                    total: totalSize || received,
                    speed: dt > 0.2 ? Math.round((received - lastBytes) / dt) : this.state.progress?.speed ?? 0
                  }
                  lastEmit = now
                  lastBytes = received
                  lastTime = now
                  this.emit()
                }
                armIdle()
                pump()
              })
              .catch(reject)
          }
          pump()
        })
      } catch (err) {
        // 空闲超时/IO 错误：关句柄保住 .part，外层重试继续断点
        throw err
      } finally {
        if (idleTimer) clearTimeout(idleTimer)
        try { closeSync(fd) } catch { /* 已关 */ }
      }
      // 校验大小：对齐或超出预期（totalSize 未知时以服务器 Content-Range 头为准，这里只做下限保护）
      const have = statSync(`${file}.part`).size
      if (totalSize > 0 && have >= totalSize) {
        if (have > totalSize) {
          fs.truncateSync(`${file}.part`, totalSize)
        }
        rmSync(file, { force: true })
        fs.renameSync(`${file}.part`, file)
        return
      }
      received = have
      diag('update', `download attempt ${attempt} incomplete: ${have}/${totalSize}，继续断点重试`)
    }
    throw new Error('多次重试后仍未下载完整（断点已保留）')
  }

  // ----- 应用升级 -----

  /** 一键升级：两种形态分别处理 */
  async install(): Promise<UpdateState> {
    const pkg = this.state.pkg
    if (!pkg || !existsSync(pkg.path)) {
      this.setPhase('error', '升级包不存在，请重新下载')
      return this.state
    }
    if (this.state.form === 'dev') {
      this.setPhase('error', '开发模式下不支持升级')
      return this.state
    }
    this.applyRequested = true
    this.setPhase('applying')
    diag('update', `install form=${this.state.form} pkg=${pkg.path}`)
    try {
      if (this.state.form === 'portable') {
        await this.applyPortable(pkg.path, pkg.tag)
      } else {
        this.applyInstaller(pkg.path)
      }
    } catch (err) {
      this.applyRequested = false
      this.setPhase('error', `升级失败：${(err as Error).message}`)
    }
    return this.state
  }

  /** 安装版：写 cmd 脚本（等退出 → 静默安装 → 拉新版），分离进程接管后续 */
  private applyInstaller(setupPath: string): void {
    const pid = process.pid
    const script = path.join(updatesDir(), 'apply-update.cmd')
    const installDir = path.dirname(process.execPath)
    const appExe = path.basename(process.execPath)
    const body = [
      '@echo off',
      'chcp 65001 >nul',
      `set PID=${pid}`,
      `set SETUP=${setupPath}`,
      `set APPDIR=${installDir}`,
      `set APPNAME=${appExe}`,
      'rem 等主程序退出（最多 90s）',
      'set /A N=0',
      ':wait',
      'tasklist /FI "PID eq %PID%" 2>nul | find "%PID%" >nul',
      'if errorlevel 1 goto run',
      'set /A N+=1',
      'if %N% GEQ 90 goto run',
      'timeout /t 1 /nobreak >nul',
      'goto wait',
      ':run',
      'rem NSIS 静默安装（安装目录沿用注册表记忆）',
      '"%SETUP%" /S',
      'rem 装完拉起新版',
      'start "" "%APPDIR%\\%APPNAME%"',
      ''
    ].join('\r\n')
    mkdirSync(path.dirname(script), { recursive: true })
    writeFileSync(script, body, 'utf8')
    const child = spawn('cmd.exe', ['/d', '/c', script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.unref()
    diag('update', `applyInstaller: script=${script}`)
    app.quit()
  }

  /**
   * 便携版：自替换。当前 exe 即使在运行也可以 rename（Windows 特性），
   * 失败任一步都会把名字改回去。
   */
  private async applyPortable(newPkgPath: string, tag: string): Promise<void> {
    const target = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
    const staged = `${target}${STAGE_SUFFIX}`
    const backup = `${target}${OLD_SUFFIX}`
    // 1. 把新包复制到 exe 同目录（同卷才能 rename），失败说明目录不可写，就地报错不退出
    try {
      fs.copyFileSync(newPkgPath, staged)
    } catch (err) {
      try { rmSync(staged, { force: true }) } catch { /* 无所谓 */ }
      throw new Error(`无法写入程序目录（${(err as Error).message}）；请确认便携目录未被占用/只读`)
    }
    // 2. 换名：old ← 当前，当前 ← 新
    try {
      fs.renameSync(target, backup)
    } catch (err) {
      try { rmSync(staged, { force: true }) } catch { /* 无所谓 */ }
      throw new Error(`备份旧版失败：${(err as Error).message}`)
    }
    try {
      fs.renameSync(staged, target)
    } catch (err) {
      // 回滚：旧版改回原名
      try { fs.renameSync(backup, target) } catch { /* 尽力而为 */ }
      try { rmSync(staged, { force: true }) } catch { /* 无所谓 */ }
      throw new Error(`替换新版失败：${(err as Error).message}（旧版已还原）`)
    }
    // 3. 记录升级标记（下次启动新版时清掉 .pfold）
    try {
      mkdirSync(updatesDir(), { recursive: true })
      writeFileSync(
        path.join(updatesDir(), APPLIED_FILE),
        JSON.stringify({ version: tag, appliedAt: Date.now() }),
        'utf8'
      )
    } catch { /* 标记失败只影响自动清理 */ }
    // 4. 拉起新版后退出
    const child = spawn(target, [], { detached: true, stdio: 'ignore', cwd: path.dirname(target) })
    child.unref()
    diag('update', `applyPortable: replaced, relaunch ${target}`)
    app.exit(0)
  }

  /** 便携版「还原上一版」：用 .pfold 换回当前并重启 */
  async restoreBackup(): Promise<UpdateState> {
    if (this.state.form !== 'portable' || !this.hasPortableBackup()) {
      this.setPhase('error', '没有可还原的备份')
      return this.state
    }
    const target = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
    const backup = `${target}${OLD_SUFFIX}`
    const hold = `${target}${STAGE_SUFFIX}`
    try {
      fs.renameSync(target, hold)
    } catch (err) {
      this.setPhase('error', `还原失败：${(err as Error).message}`)
      return this.state
    }
    try {
      fs.renameSync(backup, target)
    } catch (err) {
      try { fs.renameSync(hold, target) } catch { /* 尽力而为 */ }
      this.setPhase('error', `还原失败：${(err as Error).message}（当前版本未受影响）`)
      return this.state
    }
    const child = spawn(target, [], { detached: true, stdio: 'ignore', cwd: path.dirname(target) })
    child.unref()
    this.setPhase('applying')
    app.exit(0)
    return this.state
  }

  private hasPortableBackup(): boolean {
    if (this.state.form !== 'portable') return false
    const target = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
    return existsSync(`${target}${OLD_SUFFIX}`)
  }

  /** 新版启动后清掉上一代备份与升级标记 */
  private cleanupPortableAfterUpgrade(): void {
    if (this.state.form !== 'portable') return
    const target = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
    const backup = `${target}${OLD_SUFFIX}`
    const marker = path.join(updatesDir(), APPLIED_FILE)
    if (!existsSync(backup) || !existsSync(marker)) return
    try {
      const applied = JSON.parse(readFileSync(marker, 'utf8')) as { version?: string }
      if (compareVersion(applied.version ?? '', this.state.currentVersion) === 0) {
        rmSync(backup, { force: true })
        rmSync(marker, { force: true })
        diag('update', '升级成功存活一整个会话，已清理 .pfold 备份')
      }
    } catch {
      // 标记损坏就清掉，备份保留
      try { rmSync(marker, { force: true }) } catch { /* 无所谓 */ }
    }
    // 清理可能残留的半成品
    try { rmSync(`${target}${STAGE_SUFFIX}`, { force: true }) } catch { /* 无所谓 */ }
  }

  // ----- 历史版本（回退） -----

  async listHistory(): Promise<ReleaseInfo[]> {
    const url = `https://api.github.com/repos/${this.config.repo}/releases?per_page=15`
    const { res } = await this.fetchViaChannels(url, METADATA_TIMEOUT_MS, {
      Accept: 'application/vnd.github+json'
    })
    const list = (await res.json()) as GithubRelease[]
    this.state.history = list
      .filter((r) => !r.draft && Array.isArray(r.assets) && r.assets.some((a) => a.name.toLowerCase().endsWith('.exe')))
      .map((r) => this.toReleaseInfo(r))
      .slice(0, 10)
    this.emit()
    return this.state.history
  }

  /** 回退：下载并安装指定历史版本（同一套下载/校验/安装流程） */
  async installVersion(tag: string): Promise<UpdateState> {
    if (this.downloading || this.applyRequested) return this.state
    try {
      const url = `https://api.github.com/repos/${this.config.repo}/releases/tags/${encodeURIComponent(tag)}`
      const { res } = await this.fetchViaChannels(url, METADATA_TIMEOUT_MS, {
        Accept: 'application/vnd.github+json'
      })
      const release = (await res.json()) as GithubRelease
      const picked = this.pickAsset(release)
      if (!picked) throw new Error(`${tag} 未提供对应形态的安装包`)
      this.downloading = true
      this.setPhase('downloading')
      this.state.progress = { received: 0, total: picked.asset.size, speed: 0 }
      const file = path.join(updatesDir(), `${sanitizeTag(tag)}-${picked.asset.name}`)
      await this.downloadWithResume(picked.asset.browser_download_url, file, picked.asset.size)
      this.state.pkg = { path: file, tag, name: picked.asset.name, shaVerified: false }
      this.state.progress = null
      this.downloading = false
      return await this.install()
    } catch (err) {
      this.downloading = false
      this.state.progress = null
      this.setPhase('error', `回退到 ${tag} 失败：${(err as Error).message}`)
      return this.state
    }
  }

  /** 打开升级包缓存目录（排障用） */
  openUpdatesDir(): void {
    spawn('explorer.exe', [updatesDir()], { detached: true, stdio: 'ignore' }).unref()
  }

  // ----- 调度与状态 -----

  private scheduleAutoCheck(): void {
    if (this.checkTimer) clearTimeout(this.checkTimer)
    if (!this.config.enabled) return
    // 开发模式不自动检查（默认仓库多半没配置，避免每次 dev 启动都报错）
    if (this.state.form === 'dev') return
    // 启动 10s 后首查，此后按配置间隔定期查
    this.checkTimer = setTimeout(
      () => {
        void this.check('startup')
        this.checkTimer = setInterval(() => void this.check('interval'), this.config.intervalHours * 3600_000) as unknown as NodeJS.Timeout
      },
      10_000
    )
  }

  private setPhase(phase: UpdatePhase, error = ''): void {
    this.state.phase = phase
    if (error) this.state.error = error
    else if (phase !== 'error') this.state.error = ''
    this.emit()
  }

  private emit(): void {
    this.state.config = { ...this.config }
    if (this.broadcast) this.broadcast(this.state)
  }

  /** 测试用：覆盖广播目标 */
  setBroadcastForTest(fn: ((st: UpdateState) => void) | null): void {
    this.broadcast = fn
  }
}

export const updater = new Updater()

/** 主窗口广播（index.ts 里接上 mainWindow） */
export function bindUpdaterBroadcast(getWindows: () => BrowserWindow[]): void {
  updater.bindBroadcast((st) => {
    for (const w of getWindows()) {
      if (!w.isDestroyed()) w.webContents.send('pf:update-state', st)
    }
  })
}
