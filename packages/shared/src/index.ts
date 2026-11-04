/**
 * PolyFrame 共享协议与领域模型（TS 侧权威定义）
 *
 * P0 传输层：NDJSON over 127.0.0.1 TCP（JSON-RPC 2.0 语义）
 *  - 请求：{"jsonrpc":"2.0","id":1,"method":"core.ping","params":{}}
 *  - 响应：{"jsonrpc":"2.0","id":1,"result":{...}} / {"error":{"code":...,"message":"..."}}
 *  - 通知（core → client）：{"jsonrpc":"2.0","method":"task.updated","params":{...}}
 *
 * Rust 侧（apps/core）保持同构字段（serde camelCase），修改此处需同步。
 */

/** 协议版本（破坏性变更时 +1） */
export const PROTOCOL_VERSION = 1

// ---------- JSON-RPC 2.0 基础类型 ----------

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: P
}

export interface JsonRpcNotification<P = unknown> {
  jsonrpc: '2.0'
  method: string
  params: P
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: '2.0'
  id: number | string
  result: R
}

export interface JsonRpcFailure {
  jsonrpc: '2.0'
  id: number | string | null
  error: JsonRpcError
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccess<R> | JsonRpcFailure

// ---------- 领域模型 ----------

/** 视频协议类型 */
export type Protocol = 'hls' | 'dash' | 'mp4' | 'unknown'

/** 任务状态（P0：创建即 ready；P1 起经历 probing；P5 起 paused = 用户暂停下载） */
export type TaskStatus = 'pending' | 'probing' | 'ready' | 'downloading' | 'paused' | 'failed'

/**
 * 缓存三档模式（P2.5，DESIGN §4.6；与 Rust pf_engine::CacheMode 同构）
 * - online：纯在线不落盘，proxy 纯实时回源，退出即弃
 * - stream：边下边播，播放头窗口优先，不预取窗口外内容
 * - precache：预缓存（默认，P29），播放头窗口之外低优持续预取全部剩余分片
 */
export type CacheMode = 'online' | 'stream' | 'precache'

/**
 * 默认缓存档（P29）。三处必须一致：这里、pf-engine 的 `CacheMode::default()`、
 * 内核 `task.create` 的缺省值。改这里等于改「没设置过的用户用什么策略播放」。
 */
export const DEFAULT_CACHE_MODE: CacheMode = 'precache'

/** P29 之前的默认档：localStorage 里等于它的值可能只是旧默认自动落盘，不代表用户选择 */
export const LEGACY_DEFAULT_CACHE_MODE: CacheMode = 'stream'

/** 播放任务（与 Rust pf_engine::Task 同构） */
export interface Task {
  id: string
  url: string
  protocol: Protocol
  title?: string
  status: TaskStatus
  /** ISO8601 时间戳 */
  createdAt: string
  /** 本地代理播放地址（P1 起提供；P0 直连播放） */
  playUrl?: string
  /** master playlist 重写地址（P3：libmpv 轨道选择用，含全部 variant + 音轨/字幕 rendition；仅 HLS） */
  masterUrl?: string
  /** 缓存三档模式（P2.5） */
  cacheMode: CacheMode
  /** 缓存保留截止（播完 TTL 起算后提供；ISO8601） */
  retainUntil?: string
  /** 下载进度：已完成分片数（segments 表实时聚合） */
  segDone?: number
  /** 下载进度：总分片数 */
  segTotal?: number
  /** 下载进度：已完成字节数 */
  bytesDone?: number
  /** 引擎心跳估算速度（B/s），仅下载中有值 */
  speedBps?: number
  /** 播放头所在分片（proxy /seg 请求驱动，P2 水位调度锚点） */
  playheadSeq?: number
}

/** 源健康度快照（与 Rust pf_engine::SourceStat 同构，P2 调试面板） */
export interface SourceStat {
  /** 源索引（0 = 主源，1.. = 镜像） */
  idx: number
  /** playlist/master URL */
  url: string
  /** 调度分（吞吐/时延/成功率/错误率加权） */
  score: number
  /** active 正常 · half_open 半开试探 · circuit_open 熔断中 */
  state: 'active' | 'half_open' | 'circuit_open'
  /** 吞吐 EWMA（B/s） */
  throughputEwma: number
  /** 时延 EWMA（秒） */
  latencyEwma: number
  /** 成功率 EWMA（0..1） */
  successRate: number
  /** 请求分片总次数 */
  requests: number
  /** 失败总次数 */
  failures: number
  /** 熔断剩余秒数（仅 circuit_open） */
  circuitRemainingSecs?: number
}

/** 代理实时统计（与 Rust pf_engine::ProxyStat 同构，P2 调试面板） */
export interface ProxyStat {
  /** 缓存命中次数（读文件直回） */
  cacheHits: number
  /** 回源次数（未命中走多源择优） */
  originFetches: number
  /** 代理累计出流量（B） */
  bytesServed: number
}

/** core.hello 返回的内核信息 */
export interface CoreInfo {
  name: string
  version: string
  protocolVersion: number
  /** 本地 HTTP 代理端口（pf-proxy） */
  proxyPort?: number
  /** 代理路径 token（P7：/pic 海报透传拼 URL 用） */
  proxyToken?: string
}

// ---------- P3 libmpv 播放内核（与 Rust pf_mpv::MpvState / MpvTrack 同构） ----------

/** mpv 播放状态快照（mpv.state 通知，~4Hz 变化驱动） */
export interface MpvState {
  /** 已加载媒体且解码推进中 */
  playing: boolean
  pause: boolean
  timePos?: number
  duration?: number
  mediaTitle?: string
  eof: boolean
  /** mpv 实例存活（SHUTDOWN 后 false） */
  alive: boolean
  lastError?: string
}

/** mpv 轨道（track-list 归并） */
export interface MpvTrack {
  id: number
  /** 'audio' | 'video' | 'sub' */
  kind: string
  title?: string
  lang?: string
  default?: boolean
  selected: boolean
}

/** 缓存清理策略（与 Rust pf_engine::CachePolicy 同构；retainDays 负数 = 永久） */
export interface CachePolicy {
  retainDays: number
  unfinishedDays: number
  capacityGb: number
}

// ---------- P46 剧集预缓存（与 Rust pf_engine::PrefetchStatus 同构） ----------

/** off = 只保留「播完顺延」；ahead = 后续 N 集；all = 剩余全部 */
export type SeriesPrefetchMode = 'off' | 'ahead' | 'all'

export interface SeriesPrefetchConfig {
  mode: SeriesPrefetchMode
  /** 仅 ahead 生效：1..=50 */
  count: number
}

export interface SeriesPrefetchItem {
  index: number
  name?: string
  taskId?: string
  /** queued 未建任务 / caching 解析或下载中 / ready 已缓存 / paused 用户暂停 / failed 放弃重试 */
  state: 'queued' | 'caching' | 'ready' | 'paused' | 'failed'
  attempts: number
  error?: string
}

export interface SeriesPrefetchStatus {
  seriesId: string
  mode: SeriesPrefetchMode
  count: number
  /** 当前播放集序（0 起） */
  current: number
  /** 该剧已知总集数 */
  total: number
  /** 当前集之后的剩余集数 */
  remaining: number
  /** 剩余集数少于策略要求（数量不足时如实标记） */
  truncated: boolean
  items: SeriesPrefetchItem[]
}

// ---------- P19 片源内容缓存（与 Rust pf_engine::SrcCachePolicy / SrcCacheStats 同构） ----------

/**
 * 片源内容缓存策略：采集站元数据 / TMDB / 海报 / 解析直链各一档 TTL。
 * `offlineFallback` 关闭后，回源失败直接报错（不再拿旧数据顶上）。
 */
export interface SrcCachePolicy {
  /** 搜索结果 TTL（分钟） */
  ttlSearchMin: number
  /** 分类/更新流 TTL（分钟） */
  ttlCategoryMin: number
  /** 详情 TTL（分钟） */
  ttlDetailMin: number
  /** TMDB TTL（小时） */
  ttlTmdbHours: number
  /** 海报 TTL（天） */
  ttlPosterDays: number
  /** 解析直链 TTL（分钟） */
  ttlParseMin: number
  /** 总容量上限（MB） */
  capacityMb: number
  /** 回源失败时是否回退旧值 */
  offlineFallback: boolean
}

/** 按类统计（kind：search / category / detail / tmdb / poster / parselink） */
export interface SrcCacheKindStat {
  kind: string
  entries: number
  bytes: number
  hits: number
  misses: number
  staleServed: number
}

/** 片源内容缓存占用与命中情况 */
export interface SrcCacheStats {
  entries: number
  bytes: number
  hits: number
  misses: number
  /** 降级返回旧值的次数 */
  staleServed: number
  /** 已过 TTL 的条目数（仍可回退，不计为失效） */
  expired: number
  kinds: SrcCacheKindStat[]
}

/**
 * 一次聚合扇出的缓存摘要：`total` 是参与的源站数，
 * `fromCache` + `stale` + `failed` 之外的是本次真实回源的源站数。
 */
export interface CacheSummary {
  fromCache: number
  stale: number
  total: number
  failed: number
  /** 最旧的那份缓存写入时刻（毫秒） */
  oldestMs?: number
}

// ---------- P6 合并导出（与 Rust pf_engine::ExportInfo / ExportResult 同构） ----------

/** 导出探测：格式扩展名 + 缓存完成度（桌面端据此弹保存对话框） */
export interface ExportInfo {
  /** 建议扩展名（ts / mp4） */
  ext: string
  /** 已缓存分片数 */
  done: number
  /** 分片总数 */
  total: number
}

/** 合并导出结果 */
export interface ExportResult {
  path: string
  bytes: number
  segments: number
}

// ---------- P7 影视发现与片源聚合（与 Rust pf_core::catalog 同构） ----------

/** CMS 采集站（苹果CMS V10 API）配置（catalog_sources 行） */
export interface CatalogSource {
  id: string
  /** 显示名 */
  name: string
  /** API base，如 https://site/api.php/provide/vod */
  api: string
  enabled: boolean
  /** 出厂预置源（可禁用/删除/恢复默认） */
  builtin: boolean
  /** 最近一次成功请求的延迟（ms，source.test / 搜索时更新；null = 未知） */
  latencyMs?: number | null
  /** 最近成功时刻（epoch ms；null = 从未成功） */
  lastOkAt?: number | null
  createdAt: string
}

/** 源站探测/测速结果 */
export interface CatalogProbe {
  ok: boolean
  /** 往返延迟（ms；失败时 null） */
  latencyMs?: number | null
  /** 响应样本条数（ac=list 返回 list 长度） */
  samples?: number
  error?: string
}

/** 内置预设源站（出厂实测可用清单中的一条） */
export interface CatalogSourcePreset {
  name: string
  api: string
  /** 本机 catalog_sources 中是否已存在同 API 源站 */
  installed: boolean
}

/** 批量导入中单条失败原因（探测不过 / 写入失败） */
export interface CatalogSourceImportFailure {
  name: string
  api: string
  error: string
}

/** 全量测速单条结果 */
export interface CatalogProbeAllItem {
  id: string
  name: string
  api: string
  ok: boolean
  latencyMs?: number | null
  samples?: number
  error?: string | null
}

/** 搜索聚合卡片：同一影片（normalize(name)+year 去重后）跨站聚合 */
export interface CatalogCard {
  /** 聚合 key（normalize(name)|year） */
  key: string
  name: string
  year?: string
  /** 分类，如「科幻片」 */
  typeName?: string
  /** 清晰度/备注，如「HD中字」「更新至08集」 */
  remarks?: string
  poster?: string
  /** 站内最近更新时间（category 更新流排序用；搜索结果为空） */
  updateTime?: string
  /** 热门榜人气（category sort=hot 且配置 TMDB Key 时命中才带；参与加权排序） */
  tmdb?: TmdbPop
  /** 归一后的地区（「中国大陆 / 内地」→ 大陆）；源站没填则为空 */
  area?: string
  /** 豆瓣评分（同片多站取最高）；全程无评分为空，不等于 0 分 */
  score?: number
  /** 站内评分（同片多站取最高） */
  siteScore?: number
  /** 跨站播放量合计（各站 vod_hits 之和，只作热度参考） */
  hits?: number
  /** 热度聚合：收录站数 */
  sourceCount: number
  /** 各站条目（点详情时按站拉取剧集） */
  entries: CatalogEntryRef[]
}

/** catalog.category 返回的覆盖率统计（评分/收录站数过滤前）——用于提示「评分数据不全」 */
export interface CatalogStats {
  /** 候选数：已含类型/地区/年份过滤（这三个维度在聚合期生效） */
  total: number
  /** 有豆瓣评分的卡片数 */
  doubanScored: number
  /** 有站内评分的卡片数 */
  siteScored: number
  /** 筛选后命中的卡片数 */
  matched: number
  /** 本次请求是否带了任何筛选条件 */
  filtered: boolean
}

/** 热门榜 TMDB 人气条目（popularity 参与 score = sourceCount + min(pop/10, 20) 加权） */
export interface TmdbPop {
  rating?: number
  popularity?: number
}

/** 卡片内单站条目引用 */
export interface CatalogEntryRef {
  /** 源站 id（catalog_sources.id；手动源无站点时为空） */
  sourceId?: string
  /** 源站显示名 */
  siteName: string
  /** 站内 vod id */
  vodId: string
  api: string
  remarks?: string
}

/** CMS 详情（单站）：元数据 + 分组剧集（对应 vod_play_from 组） */
export interface CatalogDetail {
  api: string
  siteName: string
  vodId: string
  name: string
  year?: string
  typeName?: string
  remarks?: string
  poster?: string
  actor?: string
  director?: string
  content?: string
  /** 站内更新时间（vod_time） */
  updateTime?: string
  /** 剧集分组（每组对应一个 vod_play_from 播放源名，如 m3u8 / wjm3u8） */
  groups: CatalogEpisodeGroup[]
  /** P11 TMDB 评分补充（配置 Key 后由前端异步并入；非服务端出参） */
  tmdb?: TmdbInfo
}

/** 剧集分组 */
export interface CatalogEpisodeGroup {
  /** 播放源名（vod_play_from 组名，如 m3u8） */
  from: string
  episodes: CatalogEpisode[]
}

/** 单集 */
export interface CatalogEpisode {
  name: string
  url: string
}

/** 收藏（favorites 行）：按影片维度聚合多站片源 */
export interface Favorite {
  id: string
  name: string
  year?: string
  typeName?: string
  remarks?: string
  poster?: string
  content?: string
  /** 收录片源数（= favorite_sources 行数） */
  sourceCount: number
  createdAt: string
  lastPlayedAt?: number | null
}

/** 收藏下的单站片源（favorite_sources 行） */
export interface FavoriteSource {
  id: string
  favoriteId: string
  siteName: string
  /** 来源站 api（回源刷新用；手动补充为空） */
  api?: string
  vodId?: string
  /** 剧集快照 JSON：CatalogEpisode[] */
  episodes: CatalogEpisode[]
  remarks?: string
  /**
   * 该片源站的封面（P33）。
   * 同一部影片在不同站的海报往往不同 —— 前端按视频聚合后，这里就是「多张缩略图」的来源。
   */
  poster?: string
  /** search = 搜索收藏带入；manual = 手动补充 */
  origin: 'search' | 'manual'
  addedAt: string
}

/** P9 观看进度（继续观看行，watch_progress JOIN favorites） */
export interface WatchProgress {
  favoriteId: string
  favoriteName: string
  year?: string
  poster?: string
  episodeName: string
  episodeUrl: string
  positionSec: number
  durationSec: number
  updatedAt: number
}

/**
 * P26 历史播放记录（play_history）
 *
 * 按「片」去重：有来源站时同一影片（api+vodId）只留最近一集；
 * 无来源站（直链/网盘/磁力/解析）按归一化后的 URL 去重。
 */
export interface PlayHistoryItem {
  /** 去重键：`vod|api|vodId` 或 `url|scheme://host/path` */
  key: string
  title: string
  episodeName: string
  episodeUrl: string
  siteName?: string
  api?: string
  vodId?: string
  poster?: string
  /** 剧集快照 JSON：CatalogEpisodeGroup[]（续播不用重新回源） */
  groups: string
  groupIndex: number
  positionSec: number
  durationSec: number
  /** 最近播放时间（Unix ms） */
  playedAt: number
}

/** P9 追更结果条目（catalog.favorite.refresh） */export interface FavoriteRefreshItem {
  favoriteId: string
  name: string
  siteName: string
  oldCount: number
  newCount: number
  added: number
}

/** P11 追更后台巡检状态（catalog.favorite.autoscan） */
export interface FavoriteAutoscanStatus {
  /** 最近一轮巡检完成时间（Unix ms；null = 尚未巡检） */
  lastRunMs: number | null
  /** 最近一轮累计新增集数 */
  lastAdded: number
  /** 后台巡检间隔（小时；0 = 关闭，可通过同 RPC intervalHours 修改） */
  intervalHours: number
}

/** P11 TMDB 评分信息（catalog.tmdb.lookup；found=false 时仅 reason） */
export interface TmdbInfo {
  found: boolean
  /** no-key = 未配置 Key；empty = 无结果；其余 = 请求错误摘要 */
  reason?: string
  rating?: number
  votes?: number
  title?: string
  year?: string
  poster?: string
  overview?: string
}

// ---------- P10 视频云解析（与 Rust pf_core::parse 同构） ----------

/** 解析接口（parse_services 行） */
export interface ParseService {
  id: string
  name: string
  /**
   * 接口模板：
   * - `https://host/?url=`（约定以 `=`/`?` 结尾，直接拼页面地址）
   * - `https://host/jx.php?url={url}`（占位符形态，`{url_raw}` 为不编码）
   * - `direct://` 内置哨兵：不调第三方，直接嗅探页面
   */
  api: string
  enabled: boolean
  builtin: boolean
  /** 最近一次测活延迟（ms） */
  latencyMs: number | null
  /** 最近一次测活成功时间（epoch ms） */
  lastOkAt: number | null
  createdAt: string
}

/** 预设解析接口（parse.service.presets） */
export interface ParseServicePreset {
  name: string
  api: string
  installed: boolean
  /** 是否为内置直连嗅探哨兵 */
  direct: boolean
}

/** 解析接口测活结果 */
export interface ParseProbe {
  ok: boolean
  latencyMs: number | null
  error?: string
  /** 附带提示（如「服务在线但首页 404」） */
  note?: string
}

// ---------- P9 网盘视频源（与 Rust pf_netdisk / pf_engine::netdisk 同构） ----------

/** 网盘种类 */
export type NetdiskProviderKind = 'baidu' | 'aliyun' | 'onedrive' | 'http'

/** 授权方式：Cookie（百度）/ 粘贴 token（阿里云盘）/ 设备码（OneDrive） */
export type NetdiskAuthMode = 'cookie' | 'token' | 'deviceCode'

/** 适配器能力描述（UI 渲染授权表单） */
export interface NetdiskProviderInfo {
  kind: NetdiskProviderKind
  name: string
  authModes: NetdiskAuthMode[]
  /** 是否支持分享链接直接浏览/播放（百度为 false：需先转存） */
  supportsShare: boolean
  /** 凭据录入提示 */
  hint: string
}

/** 已授权账号（凭据不下发，仅状态与过期时刻） */
export interface NetdiskAccount {
  id: string
  provider: NetdiskProviderKind
  providerName: string
  name: string
  status: 'ok' | 'expired' | 'error'
  lastError?: string | null
  /** 登录态过期时刻（epoch ms） */
  expiresAt?: number | null
  createdAt: number
  lastUsedAt?: number | null
  /** status=expired：需重新授权 */
  needReauth: boolean
}

/** 目录条目 */
export interface NetdiskItem {
  id: string
  name: string
  isDir: boolean
  /** 字节数（目录为 0） */
  size: number
  /** dir | video | audio | image | other */
  kind: string
  ext?: string | null
  /** 修改时刻（epoch ms） */
  modifiedAt?: number | null
}

/** 分页结果（游标式：nextCursor 为 undefined 表示到底） */
export interface NetdiskPage {
  items: NetdiskItem[]
  nextCursor?: string | null
  total?: number | null
  dirId: string
}

/** 已保存的分享链接 */
export interface NetdiskShare {
  id: string
  provider: NetdiskProviderKind
  /** 解析所用账号（浏览/播放需要同网盘登录态） */
  accountId?: string | null
  shareUrl: string
  shareId: string
  pwd?: string | null
  title?: string | null
  createdAt: number
}

/** 账号探测结果（添加账号时回显延迟） */
export interface NetdiskProbe {
  ok: boolean
  latencyMs?: number | null
  error?: string | null
}

/** 设备码授权挑战（OneDrive / HTTP 网关） */
export interface NetdiskDeviceCode {
  deviceCode: string
  userCode: string
  verificationUri: string
  intervalSecs: number
  expiresIn: number
  message?: string | null
}

/**
 * 播放地址信息：`url` 是稳定的本地 shim 地址（`/nd/.../v.mp4`），
 * 网盘直链的短命特性由代理内部续期，UI 只需展示 `expiresInSecs` 倒计时。
 */
export interface NetdiskPlayInfo {
  url: string
  /** 当前直链过期时刻（epoch ms） */
  expiresAt?: number | null
  /** 距过期秒数 */
  expiresInSecs?: number | null
  /** 注入的请求头数量（Cookie/Referer/UA 等） */
  headerCount: number
  ext?: string | null
  /** 直链主机（诊断展示） */
  host?: string | null
}


// ---------- P11 弹幕 ----------

/**
 * 弹幕显示模式（与 Rust `pf_danmaku::DanmakuMode` 同构，小写序列化）
 * - scroll：右→左滚动
 * - top / bottom：固定位置
 */
export type DanmakuMode = 'scroll' | 'top' | 'bottom'

/** 一条弹幕（与 Rust `pf_danmaku::DanmakuItem` 同构） */
export interface DanmakuItem {
  /** 稳定 ID：`{source}:{channel}:{hash}` */
  id: string
  /** **原始时间轴**（相对视频起点的秒数，按弹幕源自己的版本计） */
  time: number
  text: string
  mode: DanmakuMode
  /** `#RRGGBB` */
  color: string
  /** local | dandanplay | import */
  source: string
  /** 发送时间戳（epoch ms，第三方源可能缺省） */
  ctime?: number | null
  /**
   * P17 渲染特效：'glow' 发光 / 'gradient' 渐变；缺省 = 普通样式。
   * 只对本地发送的弹幕有意义；text 是图片 URL 时按图片渲染（fx 忽略）。
   */
  fx?: 'glow' | 'gradient' | null
}

/** 弹幕设置（与 Rust `px-core::danmaku::DanmakuSettings` 同构） */
export interface DanmakuSettings {
  enabled: boolean
  /** 0.1 ~ 1.0 */
  opacity: number
  /** 0.6 ~ 1.8 */
  fontScale: number
  /** 0.5 ~ 1.5（越大越慢） */
  speed: number
  /** 0.1 ~ 1.0 同屏密度上限倍率 */
  density: number
  blockScroll: boolean
  blockTop: boolean
  blockBottom: boolean
  /** dandanplay | local | off */
  provider: 'dandanplay' | 'local' | 'off'
  autoScale: boolean
  showSendBar: boolean
  /** P15 屏蔽词：任一命中（大小写不敏感）的弹幕不显示 */
  blockedWords: string[]
  /**
   * P17 mpv 高级特效弹幕：用透明覆盖层窗口渲染（支持发光/渐变/图片）。
   * 关闭时 mpv 内核仍走 ASS 字幕；hls 内核不受影响（DOM 层恒支持特效）。
   */
  fxOverlay: boolean
}

/** 弹幕源匹配候选 */
export interface DanmakuEpisodeCandidate {
  episodeId: number
  animeTitle: string
  episodeTitle: string
  animeType: string
}

/** 已缓存的弹幕频道 */
export interface DanmakuChannel {
  id: string
  title: string
  episode?: string | null
  provider: string
  providerEpId?: string | null
  /** 弹幕源片长估计（秒），前端用它做时间轴缩放基准 */
  duration?: number | null
  itemCount: number
  matchedAt?: number | null
  lastFetchAt?: number | null
  lastError?: string | null
}

/** 拉取结果（失败也是 ok 的返回，用 error.kind 区分原因） */
export interface DanmakuFetchResult {
  channelId: string
  provider: string
  items: DanmakuItem[]
  count: number
  /** 本次新入库条数（缓存命中为 0） */
  added: number
  cached: boolean
  channelDuration?: number | null
  error?: { kind: string; message: string } | null
  matched?: {
    episodeId?: string
    animeTitle?: string
    episodeTitle?: string
    candidates?: number
  } | null
}

/** 本地发送结果（限流/重复/空内容是业务结果，不走 JSON-RPC error） */
export type DanmakuSendResult =
  | { ok: true; item: DanmakuItem; persisted: boolean }
  | { ok: false; kind: 'duplicate' | 'too_fast' | 'empty' | 'too_long' | 'bad_chars'; message: string }

/**
 * 弹幕时间轴缩放：把弹幕源时间轴贴合到当前片源。
 *
 * 与 Rust `pf_danmaku::model::scale_time` 同构 —— **换源只换基准，不重拉弹幕**。
 * 偏差 < 2% 视为同一版本直接返回（避免无意义抖动）；时长缺失时原样返回。
 */
export function scaleDanmakuTime(
  time: number,
  sourceDuration?: number | null,
  targetDuration?: number | null
): number {
  if (!sourceDuration || !targetDuration) return time
  if (sourceDuration <= 0 || targetDuration <= 0) return time
  if (Math.abs(sourceDuration - targetDuration) / sourceDuration < 0.02) return time
  return Math.max(0, (time * targetDuration) / sourceDuration)
}


/**
 * 解析结果：
 * - `direct`：已拿到媒体直链，可直接进本地代理播放（playUrl 有值）
 * - `page`：只有播放页，需要嗅探或内嵌（parseUrl/pageUrl）
 */
export interface ParseResolveResult {
  kind: 'direct' | 'page'
  /** 用户输入的页面地址（已归一） */
  pageUrl: string
  /** 拼接后的接口地址 */
  parseUrl?: string
  /** kind=direct 时的可播直链 */
  playUrl?: string
  /** 响应里挖到的全部直链候选（m3u8 优先） */
  candidates: string[]
  serviceId?: string
  serviceName?: string
  latencyMs: number
  /** 直链来源：input（输入即直链）/ json / html / page / cache（命中直链缓存） */
  via: 'input' | 'json' | 'html' | 'page' | 'cache'
  /** 播放页能否被 iframe 内嵌（X-Frame-Options / CSP） */
  frameable: boolean
  /** 响应里有播放器痕迹 */
  playerLike: boolean
  /** P19：直链来自缓存（未回源解析接口） */
  cached: boolean
  /** P19：缓存写入时刻（毫秒） */
  cachedAtMs?: number
  note?: string
}

// ---------- 方法与事件名 ----------

export const RpcMethod = {
  CoreHello: 'core.hello',
  CorePing: 'core.ping',
  TaskCreate: 'task.create',
  TaskList: 'task.list',
  TaskSetCacheMode: 'task.set_cache_mode',
  TaskAttachSeries: 'task.attach_series',
  TaskPurgeCache: 'task.purge_cache',
  // ---------- P5 任务管理（暂停/恢复/删除） ----------
  TaskPause: 'task.pause',
  TaskResume: 'task.resume',
  TaskDelete: 'task.delete',
  // ---------- P35 批量清理（媒体库 / 任务页） ----------
  TaskDeleteMany: 'task.delete_many',
  TaskPurgeCacheMany: 'task.purge_cache_many',
  // ---------- P6 合并导出 ----------
  TaskExportInfo: 'task.exportInfo',
  TaskExport: 'task.export',
  ConfigGetCachePolicy: 'config.get_cache_policy',
  ConfigSetCachePolicy: 'config.set_cache_policy',
  // ---------- P46 剧集预缓存 ----------
  SeriesAttach: 'series.attach',
  SeriesPrefetchStatus: 'series.prefetch_status',
  ConfigGetSeriesPrefetch: 'config.get_series_prefetch',
  ConfigSetSeriesPrefetch: 'config.set_series_prefetch',
  // P19 片源内容缓存
  CacheSrcStats: 'cache.src_stats',
  CacheSrcClear: 'cache.src_clear',
  ConfigGetSrcCachePolicy: 'config.get_src_cache_policy',
  ConfigSetSrcCachePolicy: 'config.set_src_cache_policy',
  MpvProbe: 'mpv.probe',
  MpvAttach: 'mpv.attach',
  MpvDetach: 'mpv.detach',
  MpvLoad: 'mpv.load',
  MpvStop: 'mpv.stop',
  MpvSeek: 'mpv.seek',
  MpvMove: 'mpv.move',
  /** 视频表面显隐（切页隐藏画面但保持播放） */
  MpvVisible: 'mpv.visible',
  MpvSet: 'mpv.set',
  MpvGet: 'mpv.get',
  MpvTracklist: 'mpv.tracklist',
  /** P11：执行 mpv 命令（`sub-add` 等无法用属性表达的操作用） */
  MpvCommand: 'mpv.command',
  // ---------- P7 影视发现与片源聚合 ----------
  CatalogSourceList: 'catalog.source.list',
  CatalogSourceAdd: 'catalog.source.add',
  CatalogSourceUpdate: 'catalog.source.update',
  CatalogSourceRemove: 'catalog.source.remove',
  CatalogSourceTest: 'catalog.source.test',
  CatalogSourcePresets: 'catalog.source.presets',
  CatalogSourceImport: 'catalog.source.import',
  CatalogSourceProbeAll: 'catalog.source.probe_all',
  CatalogSearch: 'catalog.search',
  CatalogDetail: 'catalog.detail',
  CatalogFavoriteList: 'catalog.favorite.list',
  CatalogFavoriteAdd: 'catalog.favorite.add',
  CatalogFavoriteRemove: 'catalog.favorite.remove',
  // P35 收藏清理：批量取消收藏
  CatalogFavoriteRemoveMany: 'catalog.favorite.remove_many',
  CatalogFavoriteSources: 'catalog.favorite.sources',
  CatalogFavoriteSourceAdd: 'catalog.favorite.source.add',
  CatalogFavoriteSourceRemove: 'catalog.favorite.source.remove',
  CatalogFavoriteTouch: 'catalog.favorite.touch',
  // ---------- P9 吸收 GYING：分类浏览 / 追更 / 继续观看 ----------
  CatalogCategory: 'catalog.category',
  CatalogFavoriteRefresh: 'catalog.favorite.refresh',
  CatalogFavoriteProgressSet: 'catalog.favorite.progress.set',
  CatalogProgressList: 'catalog.progress.list',
  // ---------- P26 历史播放记录 ----------
  CatalogHistoryRecord: 'catalog.history.record',
  CatalogHistoryProgress: 'catalog.history.progress',
  CatalogHistoryList: 'catalog.history.list',
  CatalogHistoryDelete: 'catalog.history.delete',
  CatalogHistoryClear: 'catalog.history.clear',
  CatalogFavoriteAutoscan: 'catalog.favorite.autoscan',
  CatalogTmdbGet: 'catalog.tmdb.get',
  CatalogTmdbSet: 'catalog.tmdb.set',
  CatalogTmdbLookup: 'catalog.tmdb.lookup',
  // ---------- P10 视频云解析 ----------
  ParseServiceList: 'parse.service.list',
  ParseServiceAdd: 'parse.service.add',
  ParseServiceUpdate: 'parse.service.update',
  ParseServiceRemove: 'parse.service.remove',
  ParseServiceProbe: 'parse.service.probe',
  ParseServicePresets: 'parse.service.presets',
  ParseServiceSyncPresets: 'parse.service.sync_presets',
  ParseResolve: 'parse.resolve',
  // ---------- P9 网盘视频源 ----------
  NetdiskProviders: 'netdisk.providers',
  NetdiskAccountList: 'netdisk.account.list',
  NetdiskAccountAdd: 'netdisk.account.add',
  NetdiskAccountRefresh: 'netdisk.account.refresh',
  NetdiskAccountRemove: 'netdisk.account.remove',
  NetdiskAuthBegin: 'netdisk.auth.begin',
  NetdiskAuthPoll: 'netdisk.auth.poll',
  NetdiskList: 'netdisk.list',
  NetdiskResolve: 'netdisk.resolve',
  NetdiskPlayUrl: 'netdisk.playUrl',
  NetdiskPlay: 'netdisk.play',
  NetdiskFavorite: 'netdisk.favorite.add', // P16 网盘收藏（目录=剧集 / 文件=电影，并入 favorites 体系）
  NetdiskShareList: 'netdisk.share.list',
  NetdiskShareAdd: 'netdisk.share.add',
  NetdiskShareParse: 'netdisk.share.parse',
  NetdiskShareRemove: 'netdisk.share.remove',
  // ---------- P11 弹幕 ----------
  DanmakuSettingsGet: 'danmaku.settings.get',
  DanmakuSettingsSet: 'danmaku.settings.set',
  DanmakuCredentialsSet: 'danmaku.credentials.set',
  DanmakuCredentialsClear: 'danmaku.credentials.clear',
  DanmakuCredentialsTest: 'danmaku.credentials.test',
  DanmakuOpen: 'danmaku.open',
  DanmakuMatch: 'danmaku.match',
  DanmakuFetch: 'danmaku.fetch',
  DanmakuList: 'danmaku.list',
  DanmakuSend: 'danmaku.send',
  DanmakuChannels: 'danmaku.channels',
  DanmakuChannelClear: 'danmaku.channel.clear',
  DanmakuChannelRemove: 'danmaku.channel.remove',
  DanmakuImport: 'danmaku.import',
  DanmakuAss: 'danmaku.ass',
  DanmakuStats: 'danmaku.stats',
  DanmakuCacheClean: 'danmaku.cache.clean',
  // ---------- P12 磁力/BT 片源 ----------
  MagnetAdd: 'magnet.add',
  MagnetList: 'magnet.list',
  MagnetFiles: 'magnet.files',
  MagnetSelect: 'magnet.select',
  MagnetPause: 'magnet.pause',
  MagnetResume: 'magnet.resume',
  MagnetRemove: 'magnet.remove',
  MagnetPlay: 'magnet.play'
} as const

export type RpcMethodName = (typeof RpcMethod)[keyof typeof RpcMethod]

export const RpcEvent = {
  TaskUpdated: 'task.updated',
  CoreLog: 'core.log',
  SourcesUpdated: 'sources.updated',
  ProxyStats: 'proxy.stats',
  MpvState: 'mpv.state'
} as const

export type RpcEventName = (typeof RpcEvent)[keyof typeof RpcEvent]


// ---------- P12 磁力/BT 片源 ----------

/** 种子内的一个文件 */
export interface MagnetFile {
  /** 种子内下标（选集时回传给 magnet.select） */
  index: number
  name: string
  len: number
  /** 是否被判为正片（体积最大且非样片/字幕） */
  isVideo: boolean
}

/** 磁力任务状态：adding 等元数据 / downloading / paused / done / error */
export type MagnetStatus = 'adding' | 'downloading' | 'paused' | 'done' | 'error'

export interface MagnetTask {
  id: string
  /** 规范化后的 magnet URI */
  url: string
  infoHash: string
  name: string
  saveDir: string
  status: MagnetStatus
  /** 失败/提醒文案（死种、无元数据等） */
  error?: string | null
  totalBytes: number
  doneBytes: number
  /** 当前选中文件下标 */
  fileIndex?: number | null
  fileName?: string | null
  fileLen?: number | null
  /** 正片绝对路径（本地播放/导出用） */
  filePath?: string | null
  files: MagnetFile[]
  createdAt: string
  updatedAt: number
}

/** 磁力任务可播放地址 */
export interface MagnetPlayInfo {
  playUrl: string
  name: string
}

// ---------- 方法参数 / 返回值映射 ----------

export interface RpcMethodMap {
  'core.hello': { params: undefined; result: CoreInfo }
  'core.ping': { params: undefined; result: { pong: true; ts: number } }
  'task.create': {
    params: {
      url: string
      title?: string
      /** 镜像 URL 列表（P2 多源聚合，url 为主源） */
      sources?: string[]
      /** 缓存三档模式（P2.5，缺省 stream） */
      cacheMode?: CacheMode
    }
    result: { task: Task }
  }
  'task.list': { params: undefined; result: { tasks: Task[] } }
  /** P2.5：切换缓存模式（→ online 停预取清缓存；→ stream/precache 恢复调度） */
  'task.set_cache_mode': {
    params: { taskId: string; cacheMode: CacheMode }
    result: { task: Task }
  }
  // ---------- P3 series 剧集预缓存队列 ----------
  /** 任务挂到剧集（episodeIndex 集序从 0 起；cache_mode 由任务自身字段继承/覆盖） */
  'task.attach_series': {
    params: { taskId: string; seriesId: string; episodeIndex: number }
    result: { attached: boolean; seriesId: string; episodeIndex: number }
  }
  // ---------- P3 缓存策略 / 手动清理 ----------
  'task.purge_cache': { params: { taskId: string }; result: { freedBytes: number } }
  // ---------- P5 任务管理 ----------
  /** 暂停任务下载（播放不受影响，proxy 未命中仍实时回源；重启后保持暂停） */
  'task.pause': { params: { taskId: string }; result: { task: Task } }
  /** 恢复任务下载（online 模式无预取可恢复，返回错误） */
  'task.resume': { params: { taskId: string }; result: { task: Task } }
  /** 删除任务：清缓存（文件+分片索引）+ 级联删库行 + 移除内存态，返回释放字节 */
  'task.delete': { params: { taskId: string }; result: { freedBytes: number } }
  // ---------- P6 合并导出 ----------
  /** 导出探测：ext（ts/mp4）+ 缓存完成度（done/total 分片） */
  'task.exportInfo': { params: { taskId: string }; result: ExportInfo }
  /** 合并导出：分片二进制 concat（TS 直拼；fMP4 init 前置；MP4 块回拼） */
  'task.export': { params: { taskId: string; outPath: string }; result: ExportResult }
  /** 缓存清理策略（retainDays 负数 = 永久） */
  'config.get_cache_policy': {
    params: undefined
    result: CachePolicy
  }
  'config.set_cache_policy': {
    params: { retainDays?: number; unfinishedDays?: number; capacityGb?: number }
    result: CachePolicy
  }
  // ---------- P19 片源内容缓存 ----------
  'cache.src_stats': { params: undefined; result: { stats: SrcCacheStats; policy: SrcCachePolicy } }
  /** 清空片源缓存（kind 缺省 = 全清）；返回删除条数与释放字节 */
  'cache.src_clear': {
    params: { kind?: 'search' | 'category' | 'detail' | 'tmdb' | 'poster' | 'parselink' }
    result: { removed: number; freedBytes: number; kind?: string }
  }
  'config.get_src_cache_policy': { params: undefined; result: { policy: SrcCachePolicy } }
  'config.set_src_cache_policy': {
    params: Partial<SrcCachePolicy>
    result: { policy: SrcCachePolicy }
  }
  // ---------- P3 libmpv 播放内核 ----------
  'mpv.probe': { params: undefined; result: { available: boolean; path?: string } }
  /** hwnd=主窗口 HWND（10 进制），0 = headless（vo=null，冒烟用） */
  'mpv.attach': { params: { hwnd: number }; result: { attached: boolean; reused?: boolean; headless?: boolean } }
  'mpv.detach': { params: undefined; result: { detached: boolean } }
  'mpv.load': { params: { url: string; paused?: boolean }; result: { loaded: boolean } }
  'mpv.stop': { params: undefined; result: { stopped: boolean } }
  'mpv.seek': { params: { seconds: number; absolute?: boolean }; result: { seeked: boolean } }
  /** 子窗口移动（父窗口客户区物理像素，renderer 侧完成 DPI 换算） */
  'mpv.move': { params: { x: number; y: number; w: number; h: number }; result: { moved: boolean } }
  /** 视频表面显隐：false = 藏画面（切到别的页面），播放继续；attached=false 表示 mpv 尚未挂接 */
  'mpv.visible': { params: { visible: boolean }; result: { visible: boolean; attached: boolean } }
  'mpv.set': { params: { name: string; value: string }; result: { set: boolean } }
  'mpv.get': { params: { name: string }; result: { value: string | null } }
  'mpv.tracklist': { params: undefined; result: { tracks: MpvTrack[] } }
  /** P11：执行 mpv 命令（弹幕 ASS 用 `secondary-sub-add` / `sub-add` 加载） */
  'mpv.command': { params: { args: string[] }; result: { ok: boolean } }
  // ---------- P7 影视发现与片源聚合 ----------
  'catalog.source.list': { params: undefined; result: { sources: CatalogSource[] } }
  /** 新增源站：立即探测（ac=list 小请求），失败返回错误但不入库失败态 */
  'catalog.source.add': {
    params: { name: string; api: string }
    result: { source: CatalogSource; probe: CatalogProbe }
  }
  'catalog.source.update': {
    params: { id: string; name?: string; api?: string; enabled?: boolean }
    result: { source: CatalogSource }
  }
  'catalog.source.remove': { params: { id: string }; result: { removed: boolean } }
  /** 测速：ac=list&pg=1 小请求计时（api 优先于 id） */
  'catalog.source.test': {
    params: { id?: string; api?: string }
    result: { probe: CatalogProbe }
  }
  // ---------- P8 视频源预设库 / 批量导入 ----------
  /** 内置预设库：返回全量预设及是否已存在于本机（供「同步预设库」判断缺口） */
  'catalog.source.presets': {
    params: undefined
    result: {
      /** 预设库版本（表内容变化递增） */
      version: number
      total: number
      installed: number
      presets: CatalogSourcePreset[]
    }
  }
  /**
   * 批量导入源站：粘贴文本（每行「名称$URL」）或订阅 URL。
   * 支持 JSON（LibreTV-SourceList / MoonTV api_site / 根数组）与 Base58 订阅；成人向 isAdult 条目自动丢弃。
   */
  'catalog.source.import': {
    params: {
      /** 直接粘贴的清单文本 */
      text?: string
      /** 订阅地址（拉取后与 text 合并解析） */
      url?: string
      /** 是否探测后再入库（默认 true；false 则不过滤失效站） */
      probe?: boolean
      /** 入库后是否启用（默认 true） */
      enabled?: boolean
      /** 是否标记为出厂预置（同步预设库时用，默认 false） */
      builtin?: boolean
    }
    result: {
      imported: CatalogSource[]
      importedCount: number
      /** 已存在的同 API 源站数（未重复入库） */
      skipped: number
      failed: CatalogSourceImportFailure[]
      failedCount: number
      /** 清单中标记为成人向、被丢弃的条目数 */
      adultDropped: number
    }
  }
  /** 全量测速：并发探测（默认全部，可传 ids 子集），成功即回写延迟 */
  'catalog.source.probe_all': {
    params: { ids?: string[] }
    result: { ok: number; fail: number; results: CatalogProbeAllItem[] }
  }
  /** 聚合搜索：并发扇出全部启用源站（单源 4.5s 超时），normalize(name)+year 去重聚合 */
  'catalog.search': {
    params: { q: string }
    result: { cards: CatalogCard[]; failures: string[]; cache?: CacheSummary }
  }
  /** 单站详情：ac=detail&ids= 拉取完整元数据与分组剧集 */
  'catalog.detail': {
    params: { api: string; vodId: string; sourceId?: string }
    result: { detail: CatalogDetail; cache?: CacheSummary }
  }
  'catalog.favorite.list': { params: undefined; result: { favorites: Favorite[] } }
  /** 收藏：聚合卡片（含 entries）或单站详情，自动合并到同名收藏 */
  'catalog.favorite.add': {
    params: { card?: CatalogCard; detail?: CatalogDetail }
    result: { favorite: Favorite }
  }
  'catalog.favorite.remove': { params: { id: string }; result: { removed: boolean } }
  'catalog.favorite.sources': {
    params: { id: string }
    result: { sources: FavoriteSource[] }
  }
  /** 手动补充片源：urls 支持「名称$URL#名称$URL」或每行/每#一个裸 URL */
  'catalog.favorite.source.add': {
    params: { favoriteId: string; urls: string; label?: string }
    result: { source: FavoriteSource }
  }
  'catalog.favorite.source.remove': { params: { sourceId: string }; result: { removed: boolean } }
  /** 记录播放（最近播放排序 + 热度展示） */
  'catalog.favorite.touch': { params: { id: string }; result: { touched: boolean } }
  // ---------- P9 吸收 GYING：分类浏览 / 追更 / 继续观看 ----------
  /**
   * 分类浏览 / 更新流：ac=detail&pg=N 翻页扇出全部启用源站。
   * category 按 type_name 关键词过滤（电影/剧集/动漫/综艺）；year 精确匹配；
   * hours=Some(h) 走「最近 h 小时更新」流（苹果CMS h 参数）。
   */
  'catalog.category': {
    params: {
      pg?: number
      hours?: number
      category?: string
      year?: string
      /** 地区筛选（服务端按 vod_area 包含匹配，如「大陆」命中「中国大陆/内地」） */
      area?: string
      /** time = 更新时间降序（默认）；hot = 收录站数降序（热门榜） */
      sort?: 'time' | 'hot'
    }
    result: { cards: CatalogCard[]; failures: string[]; page: number; hasMore: boolean; cache?: CacheSummary }
  }
  /** 追更：回拉收藏片源（含 api/vodId 的站）详情对比集数，快照变多即更新 */
  'catalog.favorite.refresh': {
    params: { id?: string }
    result: { checked: number; updated: FavoriteRefreshItem[]; failed: Array<{ favoriteId: string; siteName: string; error: string }> }
  }
  /** 追更后台巡检状态（run=true 时同步触发一轮并记录） */
  /** 后台巡检：intervalHours 可配置间隔（0 = 关闭，1–72 小时）；run=true 同步触发一轮 */
  'catalog.favorite.autoscan': {
    params: { run?: boolean; intervalHours?: number }
    result: FavoriteAutoscanStatus
  }
  /** TMDB Key 读取（空串 = 未配置） */
  'catalog.tmdb.get': { params: undefined; result: { key: string } }
  /** TMDB Key 保存（传空串清除） */
  'catalog.tmdb.set': { params: { key: string }; result: { saved: boolean; key: string } }
  /** TMDB 评分查询：name+year 搜 multi（电影+剧集），失败/无 Key 静默降级 found:false */
  'catalog.tmdb.lookup': {
    params: { name: string; year?: string }
    result: TmdbInfo
  }
  /** 记录观看进度（每收藏一条，覆盖写；同时刷新 last_played_at） */
  'catalog.favorite.progress.set': {
    params: { favoriteId: string; episodeName: string; episodeUrl: string; position: number; duration: number }
    result: { saved: boolean }
  }
  /** 继续观看列表：最近更新的收藏进度（按 updated_at 降序） */
  'catalog.progress.list': { params: { limit?: number }; result: { items: WatchProgress[] } }

  // ---------- P26 历史播放记录 ----------
  /** 起播/换集：按片去重 upsert（换集进度归零，同集重播保留旧进度） */
  'catalog.history.record': {
    params: {
      title: string
      episodeName?: string
      episodeUrl: string
      siteName?: string
      api?: string
      vodId?: string
      poster?: string
      groups?: CatalogEpisodeGroup[]
      groupIndex?: number
    }
    result: { item: PlayHistoryItem }
  }
  /** 进度上报（5s 节流）：只刷位置与 playedAt；行已被删则 saved=false */
  'catalog.history.progress': {
    params: { key: string; position: number; duration: number }
    result: { saved: boolean }
  }
  /** 历史列表（playedAt 倒序，分页） */
  'catalog.history.list': {
    params: { limit?: number; offset?: number }
    result: { items: PlayHistoryItem[]; total: number }
  }
  'catalog.history.delete': { params: { key: string }; result: { removed: boolean } }
  'catalog.history.clear': { params: undefined; result: { cleared: number } }

  // ---------- P10 视频云解析 ----------
  'parse.service.list': {
    params: undefined
    result: { services: ParseService[]; presetsVersion: number; directApi: string }
  }
  /** 新增接口：入库即测活（失败不拒绝，返回 probe 让用户自己判断） */
  'parse.service.add': {
    params: { name: string; api: string }
    result: { service: ParseService | null; probe: ParseProbe }
  }
  'parse.service.update': {
    params: { id: string; name?: string; api?: string; enabled?: boolean }
    result: { service: ParseService }
  }
  'parse.service.remove': { params: { id: string }; result: { removed: boolean } }
  /** 测活：id 优先，其次直接给 api（未入库地址也能先测再存） */
  'parse.service.probe': {
    params: { id?: string; api?: string }
    result: { probe: ParseProbe }
  }
  'parse.service.presets': {
    params: undefined
    result: { presets: ParseServicePreset[]; version: number }
  }
  /** 同步预设：只补缺失项（同 API 不重复） */
  'parse.service.sync_presets': { params: undefined; result: { added: number; version: number } }
  /** 解析：页面地址 → 直链 / 播放页（serviceId 缺省 = 直连嗅探） */
  'parse.resolve': {
    params: { url: string; serviceId?: string; api?: string }
    result: ParseResolveResult
  }
  // ---------- P9 网盘视频源 ----------
  /** 适配器能力表（授权方式 / 是否支持分享） */
  'netdisk.providers': { params: undefined; result: { providers: NetdiskProviderInfo[] } }
  'netdisk.account.list': { params: undefined; result: { accounts: NetdiskAccount[] } }
  /**
   * 添加账号：立即做一次轻量校验（列首页），失败不入库。
   * - 百度：传 `cookie`（含 BDUSS=）
   * - 阿里云盘：传 `refreshToken`（自动换 access_token）
   * - OneDrive：`auth.begin/poll` 完成授权后自动入库
   * - HTTP 网关：传 `baseUrl` + `accessToken`
   */
  'netdisk.account.add': {
    params: {
      provider: NetdiskProviderKind
      name?: string
      cookie?: string
      accessToken?: string
      refreshToken?: string
      baseUrl?: string
      clientId?: string
    }
    result: { account: NetdiskAccount; probe: NetdiskProbe }
  }
  /** 强制续期登录态（用户点「刷新」，或 token 过期后的补救） */
  'netdisk.account.refresh': { params: { id: string }; result: { account: NetdiskAccount } }
  'netdisk.account.remove': { params: { id: string }; result: { removed: boolean } }
  /** 设备码授权开始：返回 userCode + 验证地址 */
  'netdisk.auth.begin': {
    params: { provider: NetdiskProviderKind; clientId?: string }
    result: NetdiskDeviceCode
  }
  /** 设备码轮询：pending=true 继续等；false 时已完成授权并入库 */
  'netdisk.auth.poll': {
    params: { provider: NetdiskProviderKind; deviceCode: string; clientId?: string; name?: string }
    result: { pending: boolean; message?: string | null; account?: NetdiskAccount }
  }
  /** 目录分页：accountId / shareId 二选一；cursor 为上一页返回的 nextCursor */
  'netdisk.list': {
    params: {
      accountId?: string
      shareId?: string
      dirId?: string
      cursor?: string
      pageSize?: number
    }
    result: NetdiskPage
  }
  /** 解析播放地址（返回稳定 shim URL + 直链剩余有效期，UI 可展示倒计时） */
  'netdisk.resolve': {
    params: { accountId?: string; shareId?: string; fileId: string }
    result: NetdiskPlayInfo
  }
  /** 仅取播放地址（与 resolve 同构，语义更直白） */
  'netdisk.playUrl': {
    params: { accountId?: string; shareId?: string; fileId: string }
    result: NetdiskPlayInfo
  }
  /** 加入任务：经 shim URL 走引擎分块/缓存管线（可预缓存 / 断点续存） */
  'netdisk.play': {
    params: {
      accountId?: string
      shareId?: string
      fileId: string
      name?: string
      cacheMode?: CacheMode
    }
    result: { task: Task }
  }
  /** P16 收藏：dirId（目录=剧集，收集视频为集）或 fileId（文件=电影）二选一 */
  'netdisk.favorite.add': {
    params: {
      accountId?: string
      shareId?: string
      fileId?: string
      dirId?: string
      name: string
    }
    result: { favorite: Favorite }
  }
  'netdisk.share.list': { params: undefined; result: { shares: NetdiskShare[] } }
  /** 添加分享：支持百度/阿里云盘/OneDrive；返回首屏目录 */
  'netdisk.share.add': {
    params: { url: string; pwd?: string; accountId?: string }
    result: { share: NetdiskShare; items: NetdiskItem[]; nextCursor?: string | null }
  }
  /** 只解析分享链接（不入库）：判断 provider / 提取码 / 是否可直接浏览 */
  'netdisk.share.parse': {
    params: { url: string }
    result: {
      provider: NetdiskProviderKind
      providerName: string
      shareId: string
      pwd?: string | null
      canBrowse: boolean
    }
  }
  'netdisk.share.remove': { params: { id: string }; result: { removed: boolean } }

  // ---------- P11 弹幕 ----------
  'danmaku.settings.get': {
    params: undefined
    result: {
      settings: DanmakuSettings
      hasCredentials: boolean
      /** 脱敏后的 AppId（只用来确认"填过没有"，不回传密文） */
      appIdMasked: string | null
    }
  }
  /** 局部更新：只改传入的字段，其余保持原值 */
  'danmaku.settings.set': {
    params: Partial<DanmakuSettings> & { settings?: Partial<DanmakuSettings> }
    result: { settings: DanmakuSettings }
  }
  'danmaku.credentials.set': {
    params: { appId: string; appSecret: string }
    result: { saved: boolean; appIdMasked: string }
  }
  'danmaku.credentials.clear': { params: undefined; result: { cleared: boolean } }
  /** 连通性自检（真打一次搜索接口，验证签名与额度） */
  'danmaku.credentials.test': {
    params: undefined
    result: { ok: boolean; message: string; kind?: string }
  }
  /** 打开频道（纯本地，不联网）：拿到 channelId 后再决定拉库还是拉网 */
  'danmaku.open': {
    params: { title: string; episode?: string; provider?: string }
    result: {
      channelId: string
      provider: string
      count: number
      channelDuration?: number | null
      settings: DanmakuSettings
    }
  }
  'danmaku.match': {
    params: {
      title: string
      episode?: string
      /**
       * 手动搜索关键词：原样送搜索（不做片名归一化）。
       * 「手动指定弹幕源」里用户改过的词必须按原样搜，否则精确输入会被改坏。
       */
      query?: string
      /** 显式指定集数（覆盖从 episode 推断的结果） */
      episodeNo?: number
    }
    result: {
      ok: boolean
      query?: string
      episodeNo?: number | null
      candidates: DanmakuEpisodeCandidate[]
      kind?: string
      message?: string
    }
  }
  /** 拉取弹幕：库里有且未过期直接返回缓存；失败时降级返回已有数据 + error */
  'danmaku.fetch': {
    params: {
      title: string
      episode?: string
      /** 当前片源时长（秒），用于估计弹幕源片长 */
      duration?: number
      provider?: string
      /** 手动指定弹幕库剧集 id */
      episodeId?: number
      /** 忽略缓存强制重拉 */
      force?: boolean
    }
    result: DanmakuFetchResult
  }
  'danmaku.list': {
    params: { channelId: string }
    result: { items: DanmakuItem[]; count: number; channelDuration?: number | null }
  }
  /** P15 本地弹幕文件导入（B 站 XML / 弹弹play JSON，按内容自动探测） */
  'danmaku.import': {
    params: {
      /** 弹幕文件全文（frontend 读入后传字符串，内核侧解析） */
      content: string
      /** 有 channelId 直接用（推荐：导入进当前播放频道）；否则用 title/episode 派生 */
      channelId?: string
      title?: string
      episode?: string
    }
    result: {
      ok: boolean
      channelId: string
      /** xml | json */
      format: string
      imported: number
      total: number
      /**
       * 其中当前被屏蔽词挡住的条数。
       * 这些条目**已入库**、只是不显示 —— 清空屏蔽词后会自动回来。
       */
      blocked?: number
    }
  }
  /** 本地发送（限流/重复/校验失败返回 ok:false，不走 JSON-RPC error） */
  'danmaku.send': {
    params: {
      channelId: string
      time: number
      text: string
      mode?: DanmakuMode
      color?: string
      /** P17 特效：'glow' | 'gradient'；非法值内核归普通 */
      fx?: 'glow' | 'gradient' | null
    }
    result: DanmakuSendResult
  }
  'danmaku.channels': { params: undefined; result: { channels: DanmakuChannel[] } }
  'danmaku.channel.clear': { params: { channelId: string }; result: { cleared: number } }
  'danmaku.channel.remove': { params: { channelId: string }; result: { removed: number } }
  /** 生成 ASS 弹幕文件（libmpv 内核渲染路径，返回文件路径供 mpv sub-add） */
  'danmaku.ass': {
    params: {
      channelId: string
      width?: number
      height?: number
      fontScale?: number
      opacity?: number
      maxItems?: number
    }
    result: { path: string | null; count: number; bytes?: number; reason?: string }
  }
  'danmaku.stats': {
    params: { channelId?: string }
    result: {
      channelId: string
      count: number
      channel: DanmakuChannel | null
      hasCredentials: boolean
      provider: string
      channels: number
      /** ASS 临时文件占用（每集一个，按数量 + 时间双限自动清理） */
      assCache?: { files: number; bytes: number }
    }
  }
  /**
   * 清理 ASS 临时文件（`<data>/danmaku/*.ass`）。
   * `keep: 0` 即清空；不传 `keep` 时默认保留最新 60 个。
   */
  'danmaku.cache.clean': {
    params: { keep?: number; maxAgeHours?: number }
    result: { removed: number; freed: number; files: number; bytes: number; keep: number }
  }

  // ---------- P12 磁力/BT 片源 ----------
  /** 新建磁力任务（立即返回，元数据在后台等；进度靠 magnet.list 轮询） */
  'magnet.add': {
    params: {
      url: string
      /** 直接指定要下的文件下标（不给则自动挑正片） */
      onlyFile?: number
      /** 直连指定 peer（内网/私有种子；给了就绕开 DHT 与 tracker） */
      initialPeers?: string[]
    }
    result: { task: MagnetTask }
  }
  'magnet.list': { params: undefined; result: { tasks: MagnetTask[] } }
  'magnet.files': {
    params: { id: string }
    result: { files: MagnetFile[]; selected?: number | null }
  }
  /** 换集：只下一个文件（多集种子） */
  'magnet.select': { params: { id: string; fileIndex: number }; result: { task: MagnetTask } }
  'magnet.pause': { params: { id: string }; result: { task: MagnetTask } }
  'magnet.resume': { params: { id: string }; result: { task: MagnetTask } }
  'magnet.remove': {
    params: { id: string; deleteFiles?: boolean }
    result: { removed: boolean }
  }
  /** 只允许已下完的任务；返回 /bt 本地代理地址（支持 Range） */
  'magnet.play': { params: { id: string }; result: MagnetPlayInfo }
}

// ---------- 事件参数映射 ----------

export interface RpcEventMap {
  'task.updated': { task: Task }
  'core.log': { level: 'debug' | 'info' | 'warn' | 'error'; message: string; ts: number }
  'sources.updated': { taskId: string; sources: SourceStat[] }
  'proxy.stats': { taskId: string; stats: ProxyStat }
  'mpv.state': MpvState
}

/** core → client 的通知消息（联合类型辅助） */
export type RpcNotification = {
  [K in keyof RpcEventMap]: JsonRpcNotification<RpcEventMap[K]> & { method: K }
}[keyof RpcEventMap]
