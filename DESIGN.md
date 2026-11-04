# PolyFrame Player 技术设计方案

> 版本：v0.1 · 日期：2026-10-24 · 状态：待评审
> 定位：Windows 桌面端多进程播放器 —— 多源镜像聚合 + 自动分片 + 多线程并行加载 + 边下边播

---

## 1. 项目目标

| 目标 | 说明 |
|---|---|
| 多源聚合 | 同一视频的多个镜像/CDN 源带宽聚合下载，单源慢速/失效时自动切换（P2SP 思路，参考 IDM/aria2） |
| 自动分片 | 支持 HLS (TS/fMP4)、DASH (MPD)、MP4 直链 Range 分块，自动解析与调度 |
| 多线程加载 | 分片级并发（连接池 + 自适应并发数），绕过单连接限速 |
| 边下边播 | 本地 HTTP 代理作为下载与播放的唯一边界，播放头附近优先预取，支持秒开与任意 seek |
| 分级缓存策略 | 三档模式（纯在线不落盘 / 边下边播 / 预缓存 N 集）；TTL 清理（如播完 1 天后删除）+ 容量 LRU |
| 全格式兜底 | libmpv 内核渲染，格式/硬解支持对齐 mpv |
| 进程隔离 | 下载引擎、解析器、播放内核独立进程，坏源/崩溃不拖垮 UI |

非目标（本期不做）：DRM（Widevine/FairPlay）内容、P2P 分发、转码服务、移动端。

---

## 2. 调研结论（开源参考）

| 项目 | 可借鉴要点 |
|---|---|
| **mpv / libmpv**（⭐36k+） | 独立 demux 线程；按秒数控制的 readahead 水位；`--demuxer-max-bytes=150MB` 多 range 包缓存；JSON IPC 控制面；render API 解耦播放内核与 UI |
| **Stremio**（stremio-core Rust） | **本地 HTTP 代理 = 下载与播放的唯一边界**；播放器只见 `127.0.0.1` URL，后端来源无感知；prebuffer、分片缓存 TTL |
| **N_m3u8DL-RE** | 分片号幂等命名 + 临时目录 + 断点续存；分片级重试（默认 7 次）；多轨道并发；AES-128 内置解密；二进制 concat 合并 |
| **yt-dlp** | FragmentFD 分片生命周期抽象；`--concurrent-fragments(-N)` 并发；`.ytdl` JSON 书签断点；key 按 URI 缓存 |
| **aria2**（⭐37k） | `max-connection-per-server`(8–16) + `min-split-size` 防过度切分；**自适应并发公式 `N = A + B·log₁₀(带宽Mbps)`**；慢块分裂转移 |
| **IDM 动态分段** | 新连接空闲时把最大剩余块对半分，替代静态切块，天然负载均衡 |
| **hls.js / dash.js** | 双缓冲约束（时长 30s + 字节 60MB）驱动拉取；分片级可中断下载（abandon）；`stableBufferTime=12s` 起播目标 |
| **HLS Content Steering (IETF)** | 多源切换的标准化方案：`PATHWAY-ID` + steering server，错误回退 |
| **Chromium 媒体架构** | 播放管线与进程部署解耦；网络 I/O 收敛到可信进程；pull 驱动天然实现"缓冲不足即暂停" |
| **IINA / Jellyfin MP / Splayer** | 共识："UI 壳随便换，播放内核统一收敛到 libmpv / 本地 server" |

**关键结论**：
1. 分片是调度的原子单元，分片级重试/跳过/换源，而非整任务重试。
2. HLS/DASH 各镜像的分片是**独立编码产物，字节不保证一致** → 多镜像做**逐片 fallback（换源重试该片）**，不做跨源字节混拼；仅确认同一文件的 MP4 镜像才做字节级 Range 聚合。
3. 本地代理重写 playlist 是兼容性最好的出海口（hls.js / libmpv 零改造）。

---

## 3. 总体架构

### 3.1 进程模型

```
┌─────────────────────────────────────────────────────────────┐
│ Electron 主进程 (Node, 编排层)                                │
│  · 窗口/生命周期管理   · 任务编排 RPC 客户端                     │
│  · 原生窗口句柄转发 (getNativeWindowHandle → HWND)            │
└──────────────┬──────────────────────────────┬───────────────┘
               │ contextBridge IPC            │ JSON-RPC (WebSocket 127.0.0.1)
┌──────────────▼──────────────┐  ┌────────────▼────────────────┐
│ Renderer (Vue3 + Vite)      │  │ Rust Core 进程 (tokio)       │
│  · 播放页/媒体库/下载管理 UI  │  │  ├─ pf-proxy  本地HTTP代理    │
│  · MVP阶段: hls.js 播放      │  │  ├─ pf-engine 下载调度引擎    │
└─────────────────────────────┘  │  ├─ pf-parser  m3u8/MPD解析   │
                                 │  └─ pf-mpv     libmpv 托管线程 │
                                 └────────────┬────────────────┘
                                              │ Win32 子窗口嵌入
┌─────────────────────────────────────────────▼───────────────┐
│ 主窗口 HWND  ← [libmpv 视频子窗口 (Rust创建, SetParent)]       │
│              + [透明 UI 覆盖 BrowserWindow: 控制栏/菜单/弹幕]  │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 数据流（边下边播）

```
用户粘贴 URL / 选择源
   │
   ▼
pf-parser: 探测协议(HLS/DASH/MP4) → 拉取 master playlist → 解析多码率/多音轨/字幕/加密
   │
   ▼
pf-engine 建立任务: 源列表注册 → 健康度探测(HEAD/首片测速) → 生成分片清单
   │
   ▼
调度循环（双缓冲水位驱动）:
   玩法头附近 ±60s 高优先 → 前向 30~60s 窗口 → 可选后台全量预取
   每分片: 选源(健康度加权) → 并发下载(连接池) → AES解密 → 落盘+SQLite索引
   │
   ▼
pf-proxy:
   GET /m3u8/{task}/{quality}/index.m3u8   → 重写分片 URL → 指向本地
   GET /seg/{task}/{seq}                   → 命中缓存直接回 / 未命中则回源流式转发+落盘
   GET /file/{task}?range=                 → MP4 虚拟文件, 支持 Range (并行块按序拼装)
   │
   ▼
播放器 (hls.js 或 libmpv) 只见 127.0.0.1 本地地址
```

---

## 4. 模块设计

### 4.1 pf-parser（协议探测与解析，Rust）

- 输入 URL 特征 + Content-Type + 首字节嗅探三重判定：`.m3u8` / `.mpd` / MP4 / 其他（交 yt-dlp 式提取兜底，P4 再做）。
- HLS：master → variant 映射（带宽/分辨率/编解码 CODECS）；media playlist → 分片序列（seq、时长、byterange、KEYMap）。
- DASH：MPD XML → Period/AdaptationSet/Representation，SegmentTemplate/SegmentList/SegmentBase 归一化为统一 `SegmentTimeline` 模型。
- 统一中间表示（IR）：

```rust
struct MediaIR {
  tracks: Vec<Track>,          // video/audio/subtitle
  tracks: Track { kind, codecs, bandwidth, resolution, segments: Vec<Segment> },
  segments: Segment { seq, duration, uris: Vec<SourceUri>, byterange, key: Option<KeyInfo> },
  key: KeyInfo { method: AES128|SAMPLE_AES|CENC, uri, iv },
  live: bool, total_duration: Option<f64>,
}
```

- 多镜像归并：`SourceGroup { canonical_id, sources: Vec<Source> }` —— 由用户显式添加镜像（P2 起支持按文件名/时长/分辨率自动匹配候选）。

### 4.2 pf-engine（下载调度引擎，Rust + tokio）

**调度单元 = 分片**。任务级并发由三层参数控制：

| 参数 | 默认 | 说明（借鉴来源） |
|---|---|---|
| `max_concurrency` | 自适应 `N = 4 + 6·log₁₀(带宽Mbps)` | aria2 公式，测速后动态修正 |
| `max_conn_per_source` | 8 | aria2 `max-connection-per-server` |
| `min_split_size` | 2 MiB（MP4 块）/ 1 片（HLS） | 防过度切分 |
| `retry_per_segment` | 7，失败换源重试 | N_m3u8DL-RE |
| `buffer_target` | 前向 ≥30s 且 ≤60MB | hls.js 双约束 |

**选源策略（健康度加权）**：

```
score(s) = w1·throughput_ewma + w2·(1/latency_p50) + w3·success_rate − w4·error_ewma
分段失败 → 指数退避重试同源 2 次 → 换次优源 → 全部失败标记 segment.degraded
源连续 N 片失败/超时 → 熔断 60s，期间仅保活探测
```

**MP4 直链（P2SP 模式，P4）**：HEAD 拿 `Content-Length` + 验证 `Accept-Ranges: bytes` → IDM 动态分段（空闲连接把最大剩余块对半分）→ 多镜像仅在 Content-Length 一致时聚合，块级校验（首 16KB hash 预检）不一致的镜像剔除。

**断点续存**：分片文件名 `{task_id}/{seq:08d}.bin` 幂等落盘；SQLite 记录状态机 `pending → downloading → done | failed`；启动时扫描临时目录恢复。

### 4.3 pf-proxy（本地 HTTP 代理，Rust + hyper）

- 仅监听 `127.0.0.1`，随机高位端口 + 路径内随机 token（防局域网访问）。
- **HLS 重写**：代理 master/variant playlist，分片 URL 改写为 `/seg/{token}/{task}/{seq}`；`#EXT-X-KEY` URI 同样本地化；直播流按滑动窗口重生成。
- **MP4 虚拟文件**：`/file/{token}/{task}` 按请求 Range 返回——已下载块从磁盘读，未下载块**同步阻塞回源**（配合引擎把该 Range 前后块提升为最高优先级），实现 libmpv/hls.js 的 Range 直接 seek。
- 命中缓存零拷贝回源（sendfile/tokio file stream）；未命中边回源边 T恤转发（tee）给播放器并落盘。
- 另暴露 RPC 通道：同端口 `/rpc` WebSocket，JSON-RPC 2.0（任务增删、进度事件、配置热更）。

### 4.4 pf-mpv（libmpv 托管，Rust）—— 最高风险点，含备选

**选定方案（Win32 子窗口嵌入 + 透明 UI 覆盖层）**：
1. Electron 主进程取 `mainWindow.getNativeWindowHandle()`（HWND）经 RPC 传给 Rust。
2. Rust 创建无边框子窗口 → `SetParent` 挂到主窗口 HWND，mpv 以 `--wid=子窗口` + `--vo=gpu-next`（D3D11 硬解渲染）。
3. Renderer 用 `ResizeObserver` 上报 `#video-placeholder` 布局矩形 → Rust 同步移动子窗口（含 DPI 缩放）。
4. 控制栏/菜单/弹幕放在**第二个透明 always-on-top BrowserWindow 覆盖层**（子 HWND 在父窗口内恒在最上层，Electron 内容会被遮住，故 UI 必须走覆盖层；用 `setIgnoreMouseEvents({forward:true})` 做点击穿透区域）。

**备选/降级路线**：
- B1：MVP 阶段先用 **hls.js 页内播放**（覆盖 90% 测试源），mpv 集成放 P3，风险后置。
- B2：`mpv.exe` 独立进程 + `--input-ipc-server` JSON IPC（开发期快速验证，最终收编进 core 进程）。
- B3：若子窗口方案在 DPI/焦点上问题过多 → 降级 mpv 独立顶层窗口跟随主窗口移动。

**mpv 关键参数**：`demuxer-max-bytes=256MB`、`demuxer-readahead-secs=8`、`cache-pause-wait=2`、`hwdec=auto-safe`、`--http-header-fields` 不需要（源已被本地代理接管）。

### 4.5 Electron 壳与 UI（Vue3 + Vite + Pinia）

- 主进程只做编排：起停 Rust core（`child_process.spawn`，随应用退出清理）、窗口管理、协议注册、单实例锁、崩溃自动重启 core。
- Renderer ↔ 主进程 contextBridge 暴露 `polyframe.*` API（`addTask/addSources/seek/onProgress/...`）。
- 页面：播放页（占位 div + 覆盖层控制栏 + 分片热力图/源速度监控面板）、媒体库（SQLite 前端只读镜像）、任务管理、缓存管理（各任务模式/占用/剩余保留时间）、设置（并发/缓存路径/限速/**缓存模式与预缓存集数/播完 TTL/容量上限**）。
- 调试面板（内建亮点）：实时显示每个源的速度曲线、分片缓存命中率、缓冲水位——直接可视化多源聚合效果。

### 4.6 存储与缓存策略（SQLite + 文件）

```sql
series(id, title, source_group_key)                                 -- 剧集聚合
tasks(id, created_at, title, status, total_duration, live,
      series_id, episode_index,                                     -- 剧集内序次
      cache_mode,                                                   -- online | stream | precache（默认 precache，P29）
      retain_until, finished_at)                                    -- TTL 清理依据
sources(id, task_id, url, score, state, last_probe_at)              -- 多镜像
segments(task_id, seq, bytes, state, source_id, path, tries)        -- 分片索引
```

**三档缓存模式（任务级可配置，剧集级可批量设置）**：

| 模式 | 行为 | 适用 |
|---|---|---|
| `online` 纯在线 | 引擎不预取不落盘，proxy 纯实时回源 + 透明转发，仅内存保留播放头附近少量缓冲；退出即弃 | 不占磁盘、一次性观看 |
| `stream` 边下边播 | 播放头 ±60s 高优 + 前向 30~60s 水位，看过的分片保留为缓存（供复播/复用）；不预取未播内容 | 省流量/省磁盘，秒开 + 可回看 |
| `precache` 预缓存（默认，P29） | 播放头窗口优先之外，低优持续预取全部剩余分片（整片落盘）；`live` 直播自动退化为 stream 窗口 | 追剧/离线囤流；代价是带宽与磁盘占用高于 stream |

**预缓存队列调度规则**：
1. 优先级恒低于当前播放集：播放水位不足时自动让路（暂停预取连接，回收并发额度）。
2. 按集顺序推进：当前集缓存完整度 ≥95% 后自动激活下一集；`live` 直播任务不参与预缓存。
3. 剧集队列内每集继承 `cache_mode`，用户可对单集覆盖。
4. 预取的分片同样走 SQLite 索引与幂等命名，预缓存到一半可随时转正播放（无缝衔接，不重复下载）。

**清理策略（设置页可配，支持全局默认 + 单任务覆盖）**：

| 规则 | 默认 | 说明 |
|---|---|---|
| 播完 TTL | **播完 1 天后清理** | 任务进入 `finished` 状态起计时 `retain_until = finished_at + N 天`；N 可设 0（播完即删）/ 1 / 7 / 30 / 永久 |
| 未播完 TTL | 14 天 | 长期未动的半截任务按 LRU 淘汰 |
| 容量上限 LRU | 20GB（可配） | 超限按「最久未播放」优先清理；正在播放、预取中、`retain_until` 未到的任务受保护 |
| 手动清理 | — | 单集/整季/全量三级入口；清理按分片粒度删除文件并同步 SQLite |
| 启动清扫 | 每次启动 | 扫描过期任务 + 孤儿分片文件（无索引记录的 .bin）回收空间 |

- 目录：`%LOCALAPPDATA%/PolyFrame/cache/{task_id}/{seq:08d}.bin`，任务完成可选合并导出（TS 二进制 concat，fMP4 走 ffmpeg merge，P4）。
- 播放头 ±60s 驻内存 ring buffer（`online` 模式下这是唯一缓冲层）。

### 4.7 pf-netdisk（网盘视频源插件，Rust）

**定位**：独立 crate，把「网盘 / 分享链接 / HTTP 目录」统一抽象成 *可列举的目录 + 短命直链*，再借 §4.3 的 `/nd` shim 路由喂给既有播放管线。**不改引擎、不改播放器**——网盘文件在系统里就是「一个 MP4 直链」。

```
netdisk.* RPC (pf-core)  ──►  NetdiskService (pf-engine，编排/持久化/续期)
                                      │
                                      ├─► pf-netdisk::Provider（适配器，纯 HTTP + 纯逻辑）
                                      │     baidu / aliyun / onedrive / http-gateway
                                      └─► LinkCache（直链 + 请求头 + 过期时刻，内存）

播放路径：播放器 ──► http://127.0.0.1:{port}/nd/{nd_token}/{owner}/{fileId}/v.mp4
                     └─ pf-proxy 注入 provider 请求头 → 回源网盘直链（Range 透传 / 401·403 换链）
```

**适配器契约**（对象安全，`BoxFut` 手写 future，不引入 `async_trait`；`&'static dyn Provider` 单例存 `OnceLock`）：

```rust
trait Provider: Send + Sync {
  fn kind(&self) -> ProviderKind;
  fn name(&self) -> &'static str;
  fn auth_modes(&self) -> Vec<AuthMode>;                 // cookie | token | deviceCode
  fn supports_share(&self) -> bool;                      // 能否直接浏览分享链接
  fn prepare(&self, cred: &mut Credentials) -> BoxFut<Result<bool, String>>;   // 派生字段（drive_id）
  fn verify(&self, cred: &Credentials) -> BoxFut<Result<(), String>>;          // 连通性校验
  fn list(&self, cred, dir_id, cursor, page_size) -> BoxFut<Result<Page, String>>;
  fn resolve(&self, cred, file_id) -> BoxFut<Result<PlayTarget, String>>;      // 直链 + 头 + 过期
  fn refresh(&self, cred) -> BoxFut<Result<Credentials, String>>;              // 登录态续期
  fn device_auth(&self, client_id) -> BoxFut<Result<AuthChallenge, String>>;
  fn poll_device_auth(&self, client_id, device_code) -> BoxFut<Result<AuthOutcome, String>>;
  fn list_share(&self, cred, share, dir_id, cursor, page_size) -> BoxFut<Result<Page, String>>;
  fn resolve_share(&self, cred, share, file_id) -> BoxFut<Result<PlayTarget, String>>;
}
```

核心类型：`Credentials`（access/refresh token、cookie、base_url、client_id、drive_id、expires_at，整段 JSON 落库——各家字段差异不做列迁移）、`NetdiskItem`（`kind` 由扩展名归类：video/audio/image/dir/other，视频判定同时驱动 UI 过滤与「加入任务」可用性）、`Page{items,next_cursor,total}`、`PlayTarget{url,headers,expires_at,ext}`。错误统一 `NetdiskError{kind: unauthorized|not_found|rate_limited|unsupported|network|other}`，`unauthorized` 即账号置 `expired` 并提示重新授权。

**四家适配器差异**（同一契约下的现实差异，全部收敛在 crate 内）：

| provider | 鉴权 | 分页游标 | 直链有效期 | 分享链接 |
|---|---|---|---|---|
| `baidu` 百度网盘 | Cookie（必含 `BDUSS=`），`User-Agent: pan.baidu.com` + Referer | 页码 + `has_more` | `dlink` 按 6h TTL 保守处理 | ✗（需先转存，`supports_share=false` 并在 UI 给出可读提示） |
| `aliyun` 阿里云盘 | refresh_token → access_token（`auth.aliyundrive.com`），首列派生 `drive_id`/`user_id` 回写 | `marker` | `expire_sec=900` | ✓ `get_share_token` + `get_share_link_download_url` |
| `onedrive` OneDrive | OAuth 设备码 + refresh（`login.microsoftonline.com`） | `@odata.nextLink`（**只跟随 `graph.microsoft.com` 前缀**，防凭据外泄） | `@microsoft.graph.downloadUrl` 55min | ✓ `/shares/{id}/driveItem(/children)`，子项借 `parentReference.driveId` 走 `/drives/{d}/items/{id}` |
| `http` 通用目录网关 | Bearer token | 服务端 `nextCursor` | 服务端 `expiresAt` | ✗（网关自行处理） |

**通用 HTTP 目录网关（v1 契约，既是可落地真实源也是契约基准/冒烟载体）**：

```text
GET  {base}/api/list?dir={dir}&cursor={cursor}&size={n}
     → {"items":[{"id","name","isDir","size","modifiedAt"}],"nextCursor","total"}
GET  {base}/api/resolve?id={fileId}
     → {"url":"https://…/dl/x","expiresAt":<epochMs>,"headers":{k:v}}
POST {base}/api/refresh   {"refreshToken"}      → {"accessToken","refreshToken","expiresAt"}
POST {base}/api/auth/begin {"clientId"}         → {"deviceCode","userCode","verificationUri",…}
GET  {base}/api/auth/poll?deviceCode=…          → {"pending":bool,"accessToken",…}
```

鉴权 `Authorization: Bearer {access_token}`；直链请求**同样带网盘凭据**，再叠加 `resolve` 显式下发的附加头（Referer / `X-*` 防盗链），同名头以直链请求为准。

**稳定 shim URL（零改造复用的关键）**：

```
http://127.0.0.1:{proxyPort}/nd/{nd_token}/{owner}/{fileId}/v.mp4
                                              owner = a-{accountId} | s-{shareId}
```

- 尾部恒为 `.mp4` → `pf_parser::detect` 判为 MP4 直链 → 直接进 `build_mp4_ir` 的 4MiB 分块 + `/file` 虚拟文件 + 缓存三档 + 水位调度，**引擎侧一行未改**。
- `nd_token` 是**独立于 proxy `token`** 的长期密钥，落 `settings` 表：proxy `token` 每次启动轮换，而 shim URL 会被写进任务 URL 并跨重启复用，故必须稳定；`nd_token` 泄露只暴露「网盘读」，与 proxy 本身的会话隔离。
- `fileId` 逐字节 percent-encode（仅放行 `A-Za-z0-9-_.~!$`），兼容阿里云盘 `!`、百度 `$` 类 id；owner 段非法（空/缺前缀）直接 403，且 `nd` 已在 proxy 的路径黑名单内防止越权访问。

**直链有效期刷新机制（三层）**：

1. **L1 解析层**：`resolve()` 每次执行都向网盘换新链接，结果写 `LinkCache{cache_key(owner,file_id) → PlayTarget}`，键 = `owner|fileId`（分享/账号天然隔离）。
2. **L2 判定层**：`link_fresh()` / `LINK_SKEW_MS = 60_000` —— 剩余有效期不足 60s 即视为过期，提前换链，避免「起播瞬间刚好失效」。`NetdiskService::ctx_for` 在加载账号时同样以 60s 余量判定 `token_fresh()`，需要时先 `refresh()` 再 `prepare()` 重派生并落库。
3. **L3 容错层**：proxy 回源遇 `401 / 403 / 410` → 强制 `resolve(..., force=true)` 重新换链并重试**一次**；仍失败则把错误分类回传（不吞异常）。缓存 >512 条整体清空（`LinkCache` 上限），删账号/删分享时按 `invalidate_prefix` 失效其名下全部直链。

RPC `netdisk.resolve` 主动解析并回给 UI：`{url, expiresAt, expiresInSecs, headerCount, ext, host}` —— 播放前即可看到「链接已就绪 / 几分钟后自动续期」，而不是等播放器 502。`netdisk.play` 亦先预解析再 `create_task`，下载受限/需转码的文件提前报错。

**分页模型**：统一游标式 `Page{items,next_cursor,total}`，`next_cursor = None` 即到底；`pageSize` 缺省读 `settings`（默认 100，clamp 1..=200）。各家游标不互通（百度页码 / 阿里 marker / OneDrive nextLink），但对上层完全同构。

**存储**（随 `CacheStore::open` 建表，全新表无迁移）：

```sql
netdisk_accounts(id, provider, name, cred /*JSON*/, status /*ok|expired|error*/,
                 last_error, expires_at, created_at, last_used_at)
netdisk_shares(id, provider, account_id, share_url, share_id, pwd, title, created_at)
```

账号出参**脱敏**：只给 `status / expiresAt / needReauth / lastError`，`cred`（Cookie/token）永不出内核。

**分享链接解析**（纯逻辑，4 个单测覆盖）：百度 `/s/xxx`、`?surl=`（补 `1` 前缀）、「链接 提取码: abcd」混排；阿里云盘 / `alipan.com`；OneDrive `1drv.ms / onedrive.live.com / sharepoint.com / 1drv.com` → `u!base64url(url)`（无填充）。

**扩展一个新网盘的最小步骤**（上层零改动）：

1. 新建 `pf-netdisk/src/xxx.rs`，实现 `Provider` 的必需集：`kind/name/auth_modes`、`list`、`resolve`；需要长期登录态补 `refresh`，需要派生字段补 `prepare`，支持分享补 `supports_share + list_share + resolve_share`。
2. `ProviderKind` 增一枚举 + `parse` 分支；`provider()`/`all_providers()`/`provider_infos()` 各加一行（`hint` 用于 UI 占位符）。
3. `packages/shared` 的 `NetdiskProviderKind` 加同名字符串 —— 前端表单、账号列表、分享解析全部自动适配，无需新增页面。

---

### 4.8 弹幕子系统（P14）

核心约束：**libmpv 的视频表面是 Win32 子窗口**（`WS_CHILD`，父 HWND = 主窗口），恒定绘制在父客户区之上、不参与 Chromium 合成 —— renderer 里的 DOM/Canvas 在 mpv 模式下**必然被完全遮住**。所以弹幕做两条同源路径：

| 内核 | 载体 | 实现 |
|---|---|---|
| hls / `<video>` | Canvas 2D 覆盖层（`pointer-events:none`） | `renderer/src/danmaku/engine.ts` |
| libmpv | ASS 字幕（libass） | `pf-danmaku/src/ass.rs` + `danmaku.ass` + `mpv.command` |

两条路径共用同一套轨道分配语义（`track.ts` 与 `ass.rs` 同构），切内核不改变落位。

**数据链路**：`danmaku.open`（建频道）→ `danmaku.fetch`（弹弹play 拉取，6 h TTL 缓存）→ 落 `danmaku` 表 → `danmaku.list` 回放 / `danmaku.ass` 生成字幕。发送走 `danmaku.send`，**被拒绝返回 `{ok:false, kind, message}` 而不是 JSON-RPC error**（限流/空内容/未绑定频道属业务结果，前端需按 `kind` 分文案）。

**表结构**（`pf-engine/src/danmaku_store.rs`）：

```sql
CREATE TABLE danmaku(
  channel TEXT NOT NULL, id TEXT NOT NULL, time_ms INTEGER NOT NULL,
  text TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'scroll',
  color TEXT NOT NULL DEFAULT '#FFFFFF', source TEXT NOT NULL DEFAULT 'local',
  ctime INTEGER, PRIMARY KEY(channel, id),        -- 不是单列 id：不同频道 id 会撞
  UNIQUE(channel, time_ms, text, mode)            -- 去重靠这个；时间必须存整数毫秒
);
CREATE TABLE danmaku_channels(...);
```

**三个算法要点**：

1. **轨道分配**：`v = (画布宽 + 文本宽) / duration`；同轨可复用需「前一条尾部已进屏」且「前一条已远到追不上」。**屏满直接丢弃不排队**（排队会让弹幕越积越晚，整屏全是几秒前的）。
2. **时间轴缩放**：库里永远存弹幕源原始时间轴，缩放只在渲染侧做（偏差 < 2% 不缩放）。换片源/换剪辑版不重拉弹幕。
3. **双时钟**：hls 直读 `video.currentTime`；mpv 用「`mpv.state` 事件锚点 + `performance.now()` 墙钟插值」（250 ms 一次的状态直接当帧时钟会一跳一跳），seek 时**主动掰锚点**避免 250 ms 空窗。

**三重去重**：`SendGuard`（内存 10 s 内容去重 + 1.5 s 间隔限流，被拒不占额度）→ DB `UNIQUE` → 前端稳定 `make_id`（时间按毫秒整数参与哈希，`{:.2}` 会让 12.345 与 12.35 撞 id）。

**性能**：游标 + 区间消费（不遍历全量）、同屏上限自适应（帧耗时超预算降级）、`measureText` 缓存、页面隐藏停 rAF。500 条注入单帧 0.57 ms。弹幕数据放**模块级裸数组**、store 只存 `itemsVersion` 计数——5000 条进深度 reactive 会让拉取完成那一刻主线程卡数百毫秒。

**已知断点**：`danmaku.match` 回带的候选列表目前**没有 UI 渲染**（角标写"手动指定"但点进去是设置页），应优先补；ASS 路径做不了发光/渐变/图片弹幕，需要这些效果只能回到"透明覆盖层 BrowserWindow"方案（§3 原计划）。

---

## 5. 关键流程时序

**打开 URL → 起播**
```
Renderer: addTask(url, mirrors?)
  → Main: RPC core.createTask
  → core: parser.parse → 建 task + source 探测(1s) → 引擎起播优先级下载(前2片+3s起播缓冲)
  → core: proxy 生成重写 playlist → 返回 127.0.0.1 URL
  → Renderer: hls.js/mpv loadSource(url) → 起播
目标: < 1.5s (缓冲 12s 目标水位后自动补满)
```

**Seek**：proxy 收到 `/seg` 请求序号跳跃 → 引擎重排优先级（seek 点最近优先，旧前向队列降级）；MP4 走虚拟文件 Range 同步回源。

**源故障**：分片重试→换源（逐片粒度）；源熔断后保活探测，恢复自动回池；全源失效 → 播放器缓冲耗尽暂停 → UI 提示。

---

## 6. 开源视频源清单（已验证，2026-10-24 探测）

### 6.1 公共测试流（演示优先用 Akamai/Apple 系，大陆网络可达性最好）

| 名称 | URL | 协议 | 适用测试 |
|---|---|---|---|
| Apple bipbop 6码率 | `https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/bipbop_16x9_variant.m3u8` | HLS/TS | ABR 基线 |
| Apple bipbop Advanced | `https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8` | HLS | 多音轨+WebVTT 字幕 |
| Apple bipbop fMP4 | `https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_adv_example_fmp4/master.m3u8` | HLS/fMP4 | fMP4/CODECS |
| Apple DV+Atmos | `https://devstreaming-cdn.apple.com/videos/streaming/examples/adv_dv_atmos/main.m3u8` | HLS/fMP4 | 4K 高码率并发 |
| Mux BBB 自适应 | `https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8` | HLS | hls.js 基准 |
| Mux ToS+IMSC | `https://test-streams.mux.dev/tos_ismc/main.m3u8` | HLS | 字幕轨 |
| Bitmovin Sintel | `https://bitmovin-a.akamaihd.net/content/sintel/hls/playlist.m3u8` | HLS+DASH | 双协议（**需 Referer: bitmovin.com**） |
| DASH-IF BBB | `https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd` | DASH | DASH 分片/ABR |
| DASH-IF livesim2 | `https://livesim2.dashif.org/livesim2/testpic_2s/Manifest.mpd` | DASH live | 直播/低延迟 |
| Unified ToS | `https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8` | HLS+DASH | CMAF 双协议 |

### 6.2 开放版权电影（CC BY，测 MP4 Range 并行/大文件）

| 影片 | URL | 规格 |
|---|---|---|
| Sintel | `https://download.blender.org/durian/movies/Sintel.2010.1080p.mkv` | 1080p 1.18GB（**注意 Cloudflare 质询，下载器需模拟浏览器 UA**） |
| BBB Sunflower | `https://download.blender.org/demo/movies/BBB/bbb_sunflower_1080p_30fps_normal.mp4.zip` | 1080p，另有 4K/60fps 671MB（zip 本身即理想 Range 测试对象） |
| gtv-videos-bucket 系列 | `https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4`（Sintel/TearsOfSteel 等同名替换） | 720–1080p（大陆需代理，标待验证） |

### 6.3 公开直播流

| 频道 | URL |
|---|---|
| NASA TV（公有领域） | `https://ntv1.akamaized.net/hls/live/2014075/NASA-NTV1-HLS/master.m3u8` |
| Red Bull TV | `https://rbmn-live.akamaized.net/hls/live/590964/BoRB-AT/master.m3u8` |
| iptv-org 总表 | `https://iptv-org.github.io/iptv/index.m3u`（分国家：`/countries/cn.m3u`） |

### 6.4 仓库/数据集

- DASH-IF 测试向量库：`testassets.dashif.org`（308+ 向量，含多周期/字幕/DRM）
- Netflix 开放内容（4K/HDR）：`opencontent.netflix.com`
- Apple HLS 官方示例总览：`docs.developer.apple.com/streaming/examples/`（配套 mediastreamvalidator 校验）

> 直播 URL 会轮换，播放器内置探活重试；多镜像聚合测试可用「同一影片的 HLS 版 + MP4 版 + DASH 版」组合做逐片 fallback 演示。

---

## 7. 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 壳 | Electron (latest stable) | 用户选定；生态成熟，getNativeWindowHandle 支持子窗口嵌入 |
| UI | Vue3 + Vite + Pinia + TypeScript | 用户既有技术栈 |
| 内核 | Rust (tokio + hyper + reqwest) | 连接池/HTTP2 开箱即用，吞吐与内存最优，进程隔离 |
| 播放 | libmpv (gpu-next) + MVP 桥接 hls.js | 全格式兜底 + 低风险起步 |
| 解析 | m3u8-rs / 自研 MPD (quick-xml) | IR 统一归一化 |
| 存储 | rusqlite (SQLite WAL) + segment 文件 | 断点续存与元数据 |
| RPC | JSON-RPC 2.0 over WebSocket (127.0.0.1) | 双向事件推送，调试方便（curl/wscat 可测） |
| 构建 | pnpm workspace + cargo workspace | monorepo 双栈 |

**仓库结构**：

```
PolyFrame Player/
├── DESIGN.md
├── apps/
│   ├── desktop/            # Electron + Vue3
│   │   ├── electron/       # 主进程（编排、RPC客户端、窗口）
│   │   └── src/            # Vue3 渲染层
│   └── core/               # Rust workspace
│       └── crates/
│           ├── pf-core/    # 进程入口 + RPC server
│           ├── pf-proxy/   # 本地 HTTP 代理
│           ├── pf-engine/  # 下载调度引擎
│           ├── pf-parser/  # m3u8/MPD 解析 + IR
│           └── pf-mpv/     # libmpv 托管（P3）
└── packages/
    └── shared/             # RPC 协议 TS 类型定义（双端共用）
```

---

## 8. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| libmpv 嵌入 Electron（DPI/焦点/遮挡） | 高 | 选定 B1 路线：MVP 用 hls.js 先跑通全链路，P3 再做子窗口嵌入；备选 B2/B3 |
| 多镜像分片字节不一致导致花屏 | 高 | 严格按调研结论：HLS/DASH 只做逐片换源，禁止跨源混拼；MP4 镜像先做首块 hash 预检 |
| 某些 CDN 拒绝多连接/无 Range | 中 | 探测阶段记录 `Accept-Ranges` 与并发容忍度，自动降级为单连接顺序下载 |
| AES-128 解密密钥获取失败/REFERER 限制 | 中 | 下载器可配置 UA/Referer/Proxy；key 请求同样走源健康度调度 |
| 大量小分片磁盘 IO | 低 | 写合并（WAL + 批量事务）、播放头邻域走内存 |
| core 进程崩溃 | 低 | Electron 主进程守护重启 + 任务状态持久化秒级恢复 |

---

## 9. 实施路线图

| 阶段 | 交付物 | 验收标准 |
|---|---|---|
| **P0 骨架** | monorepo 脚手架；Electron+Vue3 起壳；Rust core 进程 + JSON-RPC 打通；hls.js 播放 Apple bipbop | RPC 双向通；直连起播 <1s |
| **P1 下载引擎** | pf-parser(HLS) + pf-engine 单源并发分片 + pf-proxy playlist 重写 + SQLite 续存 | bipbop 经本地代理起播 <1.5s；kill core 后重启续播 |
| **P2 多源聚合** | 多镜像注册 + 健康度调度 + 逐片换源 + 熔断；调试面板（源速度/命中率/水位） | 拔掉主源无卡顿（2 镜像演示） |
| **P2.5 缓存策略** | 三档缓存模式（online/stream/precache）+ 剧集预缓存队列 + TTL/LRU 清理引擎 + 缓存管理页 | 预缓存 2 集后断网可连续播放；播完 1 天后自动清理生效 |
| **P3 libmpv 内核** | pf-mpv 子窗口嵌入 + 覆盖层 UI + mpv 参数调优 | Sintel.mkv（MP4/容器直链）可播可 seek |
| **P4 P2SP + 完整功能** | MP4 动态分段多连接 + 多镜像字节聚合（hash 预检）；任务管理/媒体库/合并导出 | BBB 4K zip 源聚合速度 ≈ 单源 × N（上限受带宽） |
| **P5 打磨** | DASH 完整支持、直播低延迟、设置页、自动更新、打包（NSIS/squirrel） | 安装包一键装、冒烟清单全绿 |

每阶段结束同步一份「稳定文档」（接口变更 + 行为说明），保证桌面端/网页端后续同步调整。

---

## 10. 实施状态

### P0 骨架（✅ 2026-10-25 交付）

**已交付**：

| 模块 | 位置 | 说明 |
|---|---|---|
| monorepo 脚手架 | `package.json` `pnpm-workspace.yaml` `tsconfig.base.json` | pnpm workspace（apps/desktop + packages/*）+ cargo workspace（apps/core） |
| 共享 RPC 协议 | `packages/shared/src/index.ts` | JSON-RPC 2.0 类型、Task/CoreInfo 模型、方法与事件映射（TS 侧权威定义，Rust 侧 serde camelCase 同构） |
| Rust 内核四 crate | `apps/core/crates/` | pf-parser（URL 协议探测，2 单测）；pf-engine（内存任务表 + broadcast 事件，2 单测）；pf-proxy（hyper /health 存根，随机端口）；pf-core（NDJSON RPC server，`PF_CORE_PORT=` 端口发现） |
| 桌面端 | `apps/desktop/` | electron-vite 6 + Vite 8 + Vue 3.5 + Pinia 4；主进程 spawn pf-core + node:net NDJSON 客户端（`electron/main/rpc.ts`）；preload contextBridge 暴露 `window.polyframe`；渲染层播放页（hls.js 直连 bipbop + RPC 状态灯 + 任务面板 + 事件日志，浏览器模式优雅降级） |
| 冒烟测试 | `apps/core/scripts/smoke.mjs` | 无头验证：端口发现 → ping/hello → task.create/list → 事件推送 → 错误码 |

**RPC 变更记录（相对 §7 选型）**：P0 传输层为 **NDJSON over 127.0.0.1 TCP**（JSON-RPC 2.0 语义），WebSocket（同端口 `/rpc`）延后评估；端口发现协议：core 启动向 stdout 打印 `PF_CORE_PORT=<port>`（附带 `PF_PROXY_PORT=<port>`）。

**验证结果**（2026-10-25）：

- Rust 单元测试 4/4 通过（cargo test --release）
- 无头冒烟 7/7 通过（`pnpm smoke`，exit 0）
- tsc/vue-tsc typecheck 通过；electron-vite build 三端产物通过
- 真实窗口 E2E（CDP 驱动）：状态灯「内核在线」、hls.js 起播 Apple bipbop（currentTime 递增，readyState 4）

**常用命令**：

```bash
pnpm core:build     # cargo build --release（Rust 内核 → apps/core/target/release/pf-core.exe）
pnpm smoke          # 内核无头冒烟测试
pnpm dev            # Electron 开发模式（自动拉起 pf-core，找不到则 UI 降级提示）
pnpm build          # electron-vite build 三端产物
pnpm typecheck      # tsc + vue-tsc
```

**已知事项 / P1 待办**：

- pnpm 10 需 `onlyBuiltDependencies` 白名单（根 package.json 已配 electron/esbuild）；沙箱/代理环境下 electron 二进制下载可设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
- engine 任务状态恒为 `ready`；P1 接入 probing（源健康度探测）与 playUrl（pf-proxy 重写地址）
- pf-proxy 仅有 `/health`；P1 实现 playlist 重写 + `/seg` 分片缓存/回源
- 渲染层未做 CSP meta；打包分发（P5）前补充

### P1 下载引擎（✅ 2026-10-26 交付）

**已交付**：

| 模块 | 位置 | 说明 |
|---|---|---|
| pf-parser | `crates/pf-parser` | MediaIR/Track/Segment 统一中间表示（§4.1 子集）；master（STREAM-INF 属性引号容错）+ media playlist 解析（MEDIA-SEQUENCE / EXTINF / EXT-X-KEY / BYTERANGE 含省略 offset 续算 / ENDLIST→live 标记）；相对 URI → 绝对 URL；`load()` = master → 最高码率 variant → MediaIR；单测 5（另有 1 个 #[ignore] 网络用例） |
| pf-engine | `crates/pf-engine` | CacheStore（rusqlite bundled + WAL + busy_timeout 5s；tasks/sources/segments 表，§4.6 P1 子集）；分片清单 `INSERT OR IGNORE` 幂等登记；并发下载循环（Semaphore 默认 4，分片级重试 3 次 + 指数退避，BYTERANGE 分片自动带 Range 头）；启动恢复 `unfinished_tasks()`；task.updated 进度事件（segDone/segTotal/bytesDone/speedBps 心跳 600ms）；探测在途去重（probing 集合）；单测 3 |
| pf-proxy | `crates/pf-proxy` | hyper HTTP/1.1 服务（仅 127.0.0.1 随机端口 + 32 位路径 token 防局域网直访）；`GET /m3u8/{token}/{task}/playlist.m3u8` 重写（分片→`/seg/{token}/{task}/{seq}`、KEY→`/key/{token}/{task}/{idx}`、保留 BYTERANGE/ENDLIST 语义）；`/seg` 命中缓存直回、未命中同步回源（带 Range）+ tee 幂等落盘；`/key` 透传；单测 2 |
| pf-core | `crates/pf-core` | 打开 `%LOCALAPPDATA%/PolyFrame/{core.db,cache/}` → 起代理 → 起引擎并后台恢复未完结任务 → NDJSON RPC；`task.create` 探测完成后返回含 playUrl 的任务快照（等待 playlist 就绪 ≤15s）；`task.list` 实时聚合进度 |
| RPC/协议 | `packages/shared` + 各端 | Task 增 `playUrl/segDone/segTotal/bytesDone/speedBps`；`task.create` 参数带 title；错误码 -32700/-32601/-32602/-32000 |
| 桌面端 | `apps/desktop` | 创建任务后自动切 playUrl 经代理播放（Stremio 模式）；任务面板显示进度与「代理」标记；CoreBridge 崩溃自动重启（1s 延迟、限 5 次、上线归零） |
| 冒烟测试 | `apps/core/scripts/smoke.mjs` | 11 项：RPC 基础 → playUrl 重写 playlist（无 origin 域名残留）→ /seg 回源 → 事件推送 → 进度推进 → kill 内核重启 → 同 URL 复用任务 → playUrl 仍可用 → 进度不回退 |

**关键实现决策**：

1. **BYTERANGE 单文件变体**：bipbop 最高码率 variant（gear5, 1920x1080）是 EXT-X-BYTERANGE 单文件（main.ts 410MB）。分片下载必须带 `Range: bytes=off-(off+len-1)`（engine 与 proxy 回源均处理），且 BYTERANGE 省略 @offset 时按前片结束偏移续算（RFC 8216 §4.3.2.2）。否则每个分片都会整文件下载（首版踩坑：410MB × 并发 → 带宽打满、SQLite 写爆）。
2. **HTTP/1.1 强制**：reqwest 客户端 `http1_only()`（对齐 aria2/N_m3u8DL-RE 默认；规避部分 CDN h2 多路复用停摆风险）。
3. **task.create 同步等待 playlist 就绪**：restore 与 create 并发进入同一任务时由 probing 集合去重，create 侧轮询等待 MediaIR 就绪，保证返回的 playUrl 立即可播。
4. **SQLite WAL + busy_timeout**：内核被 kill 后重启、跨进程写不阻塞；分片文件 `{task}/{seq:08}.bin` 幂等命名 + `{tag}.part` 临时名原子改名。
5. **P1 下载策略 = 全量顺序预取**（4 并发）；播放头水位驱动调度（§4.2 双缓冲）与多源换源留 P2，当前 proxy 未命中回源兜底任意 seek。

**验证结果**（2026-10-26）：

- Rust 单测 10/10（parser 5 + engine 3 + proxy 2；另 1 个网络用例 #[ignore]）
- 无头冒烟 11/11（`pnpm smoke`）：含 kill core → 重启 → 同 URL 复用 + 进度不回退 + playUrl 可用
- tsc/vue-tsc typecheck 通过；electron-vite build 通过
- 真实窗口 E2E 10/10：窗口启动 → 内核在线 → 创建任务 → 自动切 playUrl（`/m3u8/{token}/...`）→ hls.js 经本地代理起播（readyState≥3，起播 1.56s）→ 任务面板 181/181 · 391.5MB → taskkill pf-core → 状态转 error → **CoreBridge 自动重启恢复在线（socket close 触发，重启本身 ~100ms）** → 重建任务复用缓存再次起播（t=4.4s 即恢复播放）
- 性能抽样：bipbop 181 分片 / 391MB 全量下载平均 ~52MB/s（受限网络波动）；/seg 缓存命中 24ms；playlist 重写 <15ms

**调试期发现的环境坑**（已写入 project_memory）：

- TraleCode 沙箱会干扰进程类操作：spawn 的 pf-core 被秒杀（exit code=1）、taskkill 被拦截报 `TRAE Sandbox Error: hit restricted`、TerminateProcess 的 exit 事件延迟可达 90s。**E2E/冒烟等进程操作脚本须以 dangerouslyDisableSandbox 运行**
- CoreBridge 崩溃重启的触发点：socket close（TCP 断开先于进程 exit 可知）+ proc exit 兜底，幂等去重，限 5 次；Windows 下 exit 事件可能延迟 10s+（杀软/环境），不能作为唯一重启依据
- 内核 stderr 在主进程只丢弃不转发：避免 Windows 上同步写管道被反压阻塞主进程

**P1 遗留（并入 P2）**：

- AES-128 分片本地解密（当前仅记录 KeyInfo 并透传 key URI；bipbop 无加密不影响验收）
- 播放头水位驱动调度（±60s 高优 + 前向窗口）替代全量顺序预取；live 滑动窗口
- 多镜像注册 + 健康度探测 + 逐片换源 + 熔断；调试面板（源速度/命中率/水位）
- core 自动重启后旧 playUrl 的 token 失效，renderer 需重取 task.list 刷新播放地址（当前 E2E 以「重建任务」验证）
- 渲染层 CSP、音频/字幕轨道选择（EXT-X-MEDIA 归并）

### P2 多源聚合（✅ 2026-10-26 交付）

**已交付**：

| 模块 | 位置 | 说明 |
|---|---|---|
| 源健康度 | `pf-engine/src/health.rs` | `SourceHealth`：吞吐/时延/成功率/错误率四路 EWMA（α=0.3）+ `score = 2·tp_norm + 1·(1/(1+lat)) + 2·sr − 3·err`（tp 按 5MB/s 归一）；状态机 `active → circuit_open(连续 4 片失败, 60s) → half_open(到期试探, −0.5 惩罚分) → active`（试探失败立即重开熔断）；`pick_source()` 同分主源优先、支持 exclude（同源退避）；`priority(seq, anchor)` 水位分级：前向 ≤7 片(0) > 回看 ≤7 片(1) > 窗口 8..14(2) > 远前向(3) > 历史(4)，无锚点顺序；纯同步可单测，单测 8 |
| 多源注册 | pf-engine `create_task(sources)` + CacheStore `set_sources/sources_of` | `task.create` 参数加 `sources: string[]`（url 为主源，保序去重）；镜像并发解析，**对齐校验不过即剔除**（分片数一致 + 时长差 ≤ max(10%, 1s)，禁止跨源混拼）；sources 表全量重建持久化，启动恢复时带回 |
| 逐片换源 | pf-engine `fetch_on_sources / proxy_fetch_segment` | 每分片按 `pick_source` 择优 → 失败同源退避重试（300ms·2^n，最多 2 次）→ 换次优源 → 全源用尽 `RETRY_PER_SEGMENT=6` 次记 failed；成功/失败均回写健康度（成功含吞吐记账）；engine 下载与 proxy 回源共用同一套择优逻辑 |
| AES-128 本地解密 | `pf-engine/src/crypto.rs` | AES-128-CBC + PKCS7（RustCrypto aes 0.8 + cbc 0.1）；IV 规则：KEY 显式 hex（u128 右对齐解析）优先，缺省按媒体序列号 big-endian 派生（RFC 8216 §5.2）；key 经 URI 拉取后按 (task, uri) 缓存；分片下载/回源后**先解密再落盘/回包**；单测 3（加密往返 + IV 解析 + 错 key 拒绝） |
| proxy 调整 | pf-proxy | playlist 对播放器输出 `METHOD=NONE`（AES-128 已透明解密，hls.js 无感知；SAMPLE-AES 仍重写 `/key` 透传）；`/seg` 请求驱动播放头锚点（`note_playhead`，|Δseq|>2 判定 seek 并广播日志）；命中/回源/出流量统计 |
| 水位调度 | pf-engine `download_job` | worker 池（4）每轮按 `priority(seq, playhead)` 取片，锚点实时读取 → **seek 即时重排，无需重启任务**；分片结果经 `store_segment` 幂等落盘（engine/prx 双 tag 原子改名） |
| 事件协议 | shared + pf-core | 新通知 `sources.updated {taskId, sources[]}` / `proxy.stats {taskId, stats}`；Task 增 `playheadSeq`；`SourceStat`（idx/score/state/throughputEwma/latencyEwma/successRate/requests/failures/circuitRemainingSecs）与 `ProxyStat`（cacheHits/originFetches/bytesServed）TS/Rust 双端同构 |
| 调试面板 | desktop `App.vue` + player store | 「多源监控」卡片：每源 主/镜标记、状态徽章（正常/试探/熔断+剩余秒）、吞吐 EWMA / 时延 / 成功率 / 调度分 / 请求-失败计数；代理命中/回源统计行；镜像 URL 输入框（逗号分隔）；事件只跟随当前播放任务防后台任务刷屏 |
| 冒烟扩展 | `apps/core/scripts/smoke.mjs` | 20 项（新增 9）：本地双源 origin（Node http，可注入分片 404 / AES 加密）；P2 容错：主源分片全 404 → /seg 经镜像兜底回包字节一致 + 主源熔断记账 + 镜像正常记账 + 引擎经镜像推进进度；P2 AES：playlist 输出 METHOD=NONE 且无 /key 残留 + /seg 返回明文；主流程改隔离 LOCALAPPDATA（hermetic） |
| E2E | Temp 脚本（不入仓） | 11 项：bipbop 真实内容反向代理双 origin（主源分片全 404）→ UI 填主源+镜像 → 创建任务 → **主源故障下经镜像兜底起播并推进**（0.93→2.93s）→ 调试面板 2 源/主源熔断/镜像 27MB/s → 代理统计 → 日志痕迹 → origin 侧 404×4/供片×16 |

**关键实现决策**：

1. **对齐校验前置**：镜像解析后立即比对分片数与总时长，不对齐剔除（warn 日志）——HLS 各镜像独立编码产物，字节不保证一致，跨源混拼会产出坏流（DESIGN §2 结论 2 的工程落点）。
2. **健康度记账位置**：引擎单分片下载与 proxy 回源共用 `fetch_on_sources` 级逻辑，成功记吞吐（bytes/latency），失败记 error EWMA——保证调试面板曲线与真实调度决策同源。
3. **AES-128 解密后落盘**：缓存中只存明文（重写 playlist 对播放器隐藏加密），proxy `/seg` 命中缓存无需再解密；key 缓存避免每片重复拉取（yt-dlp 式）。
4. **水位锚点由 proxy 驱动**：播放头以 `/seg` 请求序号为准（hls.js 请求即真实消费位置），renderer 无需上报；seek 判定 |Δseq|>2。
5. **E2E 教训：CDP 不是 JSON-RPC**——消息体带 `jsonrpc:"2.0"` 字段会被 Chromium 整体拒绝（-32600 Message has property...）；且页面加载早期 execution context 会重建，evaluate 需重连重试；合成字节过不了 MSE 解复用，E2E origin 必须回源真实内容（bipbop 反向代理）。

**验证结果**（2026-10-26）：

- Rust 单测 25/25（parser 5 + engine 17 + proxy 3；另 1 个网络用例 #[ignore]）
- 无头冒烟 20/20（`pnpm smoke`）：P0/P1 11 项回归 + P2 容错/AES 9 项
- tsc/vue-tsc typecheck 通过；electron-vite build 通过；cargo build --release 通过
- 真实窗口 E2E 11/11：主源分片全 404 的容错起播 + 多源调试面板全链路

**P2 遗留（并入后续阶段）**：

- ~~缓存三档模式与 TTL/容量清理~~ → P2.5 已交付（见下）
- MP4 直链 P2SP 字节级聚合（P4，需 Content-Length 一致 + 首块 hash 预检）
- live 直播滑动窗口重生成 playlist（当前按创建时刻快照）
- core 自动重启后旧 playUrl token 失效 → renderer 重取 task.list（P1 遗留顺延）
- 音频/字幕轨道选择（EXT-X-MEDIA 归并）、渲染层 CSP

### P2.5 缓存三档模式（✅ 2026-10-26 交付）

**已交付**：

| 模块 | 位置 | 说明 |
|---|---|---|
| 缓存模式语义 | pf-engine `CacheMode` | `online`（纯在线：引擎不预取不落盘、proxy 未命中回源后跳过 tee 落盘、任务即 ready 并按播完 TTL 记账）/ `stream`（当时默认，边下边播：**只调度播放头窗口**——前向 ≤14 片 + 回看 ≤7 片，窗口谓词 `in_schedule_window`，无锚点按 seq 0 开窗保证起播缓冲；P29 起改为非默认档）/ `precache`（预缓存：全量在窗，`priority()` 分级天然让播放头附近恒优先，播放头未动也全量预取；**P29 起为默认档**） |
| 调度窗口化 | pf-engine `download_job` | worker 取片时按 `in_schedule_window(seq, anchor, mode)` 过滤；todo 非空但窗口未开（stream 等播放头推进）→ worker 400ms 轮询等待而非退出；**修正 P1 遗留：stream 不再全量顺序预取**（对齐 DESIGN §4.6「不预取未播内容」） |
| 模式切换 | RPC `task.set_cache_mode` + pf-engine `set_cache_mode` | → online：协同停止下载 job（`job_stops` AtomicBool，worker/心跳每轮检查）+ 清缓存（`purge_task_cache`：删目录 + segments 行）；→ stream/precache：重新 spawn 下载 job（todo 集合重建，已有缓存幂等跳过）；旧模式为 online 时直接起 job（media 已在内存） |
| 清理器 | pf-engine `cleanup.rs` + `cleanup_loop` | 纯同步 `sweep(store, dir, cfg, protected, now)`（now 注入可单测）+ 引擎后台 60s 循环（pf-core 启动，首扫延迟 5s 等恢复就绪）；四规则：① 播完 TTL（`retain_until <= now` 且最近无播放活跃）② 未播完 LRU（14 天未动）③ 容量 LRU（20GB 上限，按任务聚合 done 字节，最久未活跃优先，正在下载/播放受保护）④ 孤儿清扫（无索引 `.bin` + 空任务目录；`.part` 临时文件不动）；删除均为任务级联（目录 + segments/sources/tasks 行），`removed_ids` 回传同步内存任务表 |
| TTL/LRU 记账 | CacheStore | tasks 新列 `retain_until/finished_at/last_played_at/series_id/episode_index`（`CREATE TABLE IF NOT EXISTS` + 旧库 `ALTER TABLE` 兜底迁移）；`mark_finished`（下载全量完成时写 finished_at + retain_until = now + N 天，永久 = NULL）/ `touch_played`（note_playhead 30s 节流落库）/ `expired_finished_tasks / stale_unfinished_tasks / task_bytes_by_activity`（activity = COALESCE(last_played, finished_at, created_at)） |
| series 剧集 | CacheStore `series` 表 + `upsert_series/attach_task_series` | P2.5 仅落库骨架（id/title/created_at + tasks.series_id/episode_index）；剧集级批量设模式与预缓存队列调度（当前集 ≥95% 激活下一集）留 P3 |
| 数据模型 | shared + 双端 | `CacheMode` 类型（online/stream/precache）TS/Rust 同构；Task 增 `cacheMode`（必填，默认 stream）+ `retainUntil`（ISO8601）；`task.create` 参数加 `cacheMode?`；新方法 `task.set_cache_mode {taskId, cacheMode}` |
| 桌面端 | desktop `App.vue` + player store | 新建任务缓存模式下拉（三档）；任务面板「缓存」列模式徽章下拉（online 橙 / stream 绿 / precache 蓝）+ 「保留至」列（retainUntil 人类可读：分钟/小时/天，永久显示 —）；`setCacheMode` action |

**关键实现决策**：

1. **stream 窗口谓词收敛**：P1 的 download_job 是全集顺序预取，与 §4.6「stream 不预取未播内容」不符；P2.5 用 `in_schedule_window` 过滤（前向 ≤14 / 回看 ≤7，与 priority() 分级窗口一致），worker 在窗口未开时 sleep(400ms) 等待播放头推进——todo 非空 + 无可调度片 ≠ 完成。
2. **precache = 窗口全开**：不新增后台队列，直接让 `in_schedule_window` 对 precache 返回 true，复用 priority() 分级实现「播放头附近恒优先、其余低优推进」；直播 live 任务不参与预缓存的限制留 P3（当前 VOD only）。
3. **online 即 ready**：create_task 解析完 playlist 直接置 ready（分片清单都不登记），retain_until 按播完 TTL 起算（元数据 1 天后随清理器回收）；proxy /seg 未命中照常回源（解密链路不变）但跳过 store_segment——复播重看时缓存已清，退化为纯在线。
4. **清理以任务为粒度**：容量 LRU 超限时按整任务级联删除（而非逐分片截断），避免「半截任务更难续传」；保护集 = 在途下载 job + 有播放头的任务 + 10 分钟内播放活跃。
5. **删列兼容**：旧库迁移用 `ALTER TABLE ADD COLUMN` + 忽略 duplicate column 错误（SQLite 无 IF NOT EXISTS 语法）；created_at 是 ISO 字符串，SQL 里用 `strftime('%s', created_at)*1000` 转 epoch ms 兜底排序。

**验证结果**（2026-10-26）：

- Rust 单测 31/31（parser 5 + engine 23 + proxy 3；engine 新增 8：调度窗口谓词 / CacheMode 往返与 TTL 换算 / 播完 TTL+LRU 查询+级联删除 / cleanup 3 个——播完 TTL、容量 LRU（含保护集）、孤儿清扫）
- 无头冒烟 29/29（`pnpm smoke`）：P0/P1/P2 20 项回归 + P2.5 六项新断言——online 任务即 ready（segTotal=0）/ /seg 实时回源 / 引擎不预取（2s 恒 0）/ 缓存目录无 .bin / set_cache_mode → stream 恢复调度推进 / precache 无播放头全量预取（6/6）
- tsc/vue-tsc typecheck 通过；electron-vite build 通过；cargo build --release 通过

**P2.5 遗留（并入后续阶段）**：

- 设置页可配（TTL 天数 0/1/7/30/永久、容量上限、未播完天数）——当前为常量默认（1 天/20GB/14 天）
- 剧集级批量设模式 + 预缓存队列调度（当前集 ≥95% 激活下一集、live 排除）——series 表已就绪，P3 接
- 缓存管理页（各任务占用字节/手动清理单集/整季/全量）——P3 与媒体库一起做
- MP4 直链 P2SP（P4）、live 滑动窗口、core 重启后 token 刷新（P1 遗留顺延）

### P3 libmpv 集成 + 剧集队列 + 缓存管理（✅ 2026-10-26 交付）

**已交付**：

| 模块 | 位置 | 说明 |
|---|---|---|
| pf-mpv crate | apps/core/crates/pf-mpv | **动态 FFI**（libloading 加载 libmpv-2.dll，手写 13 函数指针表，不依赖 libmpv-rs/pkg-config）；API 版本校验（≥2.6）；DLL 发现顺序：`PF_MPV_DLL` env > exe 同目录 > exe/mpv/ > exe/../../vendor/mpv/，缺失时 `mpv.probe` 返回 available=false，桌面端保持 hls.js 内核（优雅降级） |
| Win32 子窗口 | pf-mpv `window.rs` | 独立线程 RegisterClassW + CreateWindowExW（WS_CHILD\|WS_VISIBLE，hWndParent=Electron HWND）+ GetMessageW 消息泵；mpv 选项 `wid=<hwnd>` + `vo=gpu-next` + `hwdec=auto-safe`；`hwnd=0` → headless（vo=null/ao=null，供冒烟）；`mpv.move`（SetWindowPos）/ `mpv.detach`（WM_CLOSE + join + mpv_terminate_destroy） |
| 事件与状态 | pf-mpv 事件线程 | 单线程独占 `mpv_wait_event`；observe_property ×5（time-pos/duration/pause/eof-reached/media-title）→ `MpvState` 快照（AtomicU64 版本号驱动）；END_FILE（EOF/ERROR→last_error）、SHUTDOWN（alive=false）、LOG_MESSAGE→stderr；pf-core 250ms 泵轮询版本号变化 → `mpv.state` 通知（Arc::ptr_eq 校验句柄未被替换） |
| RPC（mpv.*） | pf-core + shared | `mpv.probe / mpv.attach {hwnd}`（spawn_blocking，reused 幂等）/ `mpv.detach / mpv.load {url}`（loadfile+show）/ `mpv.stop / mpv.seek {seconds,absolute} / mpv.move {x,y,w,h} / mpv.set {name,value} / mpv.get {name}`（get_property_string，**返回字符串**）/ `mpv.tracklist`；shared TS `MpvState/MpvTrack` + `RpcEvent.MpvState` |
| master 透传重写 | pf-proxy `master_playlist` | 最高 BANDWIDTH variant → `/m3u8/{token}/{task}/playlist.m3u8`（走下载引擎，缓存/多源/解密生效）；其余 variant → `/m3u8/.../raw/{hex}` 透传重写；**EXT-X-MEDIA rendition URI → `/m3u8/.../raw/{hex}`**（重写路由，非 /segraw——rendition 是 playlist，其内部分片需二次本地化）；Task 新字段 `masterUrl`（仅 HLS），mpv 内核播 masterUrl（轨道选择需要全部 variant/rendition） |
| raw 透传路由 | pf-proxy `raw_playlist/raw_segment` | `hex_encode/decode`（路径段，上限 4096B）；raw_playlist 重写 EXT-X-KEY→/keyraw、分片→/segraw、保留 BYTERANGE；`raw_segment` **流式透传**（StreamBody 管道，不缓冲）+ Range 原样转发 + 206/Content-Range 透传；透传专用 reqwest client（无总超时，`read_timeout(30s)` 防停摆）；客户端断开 → 响应体 drop → 回源连接同步取消 |
| 轨道选择 | desktop mpv 控制行 | mpv.load masterUrl 后 tracklist 归并（video/audio/sub，含 EXT-X-MEDIA rendition）；音轨/字幕下拉切换（`mpv.set aid/sid/vid`，id=0 关字幕）；暂停/时间/seek range 控件 |
| series 剧集队列 | pf-engine `series.rs` + `series_queue_loop` | 纯同步 `pick_next_episode(EpisodeSnap)`（当前集 done=ready 或 ≥95% → 激活 episode_index+1 的非 live/非 online/非 done 集）+ 4 单测；引擎 5s tick：当前集 = 最近 2min 有播放头（last_touch+playheads）的任务 → snaps → 决策 → `activate_task`（probe_and_start 恢复管线，job_stops 在途跳过）；`task.attach_series {taskId,seriesId,episodeIndex}` 挂接 |
| 缓存策略可配 | pf-engine `cache_policy()` + settings KV 表 | `cache.retain_days / unfinished_days / capacity_gb`（默认 1 天/14 天/20GB）；cleanup sweep 与 mark_finished/online TTL 记账均读 policy；RPC `config.get_cache_policy / config.set_cache_policy`（set 即持久化，下一轮清理生效） |
| 手动清理 | RPC `task.purge_cache` | stop_download_job → purge_task_cache → 状态回 ready → 返回 freedBytes；desktop 任务表「清缓存」列 |
| 桌面端 HWND | electron main/preload | `pf:native-hwnd` IPC（`getNativeWindowHandle().readBigUInt64LE(0)`）；preload `nativeHwnd()`；App.vue videoWrapEl ResizeObserver + 60ms 防抖 → `mpv.move`（CSS px × devicePixelRatio = 物理像素） |

**关键实现决策**：

1. **mpv_command 必须 NULL 指针终止**：`CString::default()` 是空字符串而非 NULL，传给 mpv_command 的 argv 数组以 `ptrs.push(std::ptr::null())` 结尾，否则 "invalid parameter"。
2. **EXT-X-MEDIA URI 走重写路由而非裸透传**：diag 实测裸 /segraw 会把未重写的原始 rendition playlist 交给 mpv（相对分片以代理 URL 为 base 解析 → 400）；rendition 是 playlist，必须经 raw_playlist 二次本地化。
3. **raw 透传必须流式**：ffmpeg 对 BYTERANGE 单文件变体（gear2/gear5 main.ts 达 124MB/410MB）用开放式 Range（`bytes=0-`）只读所需字节即断开；缓冲式回源整文件后返回会撞 reqwest 30s 整体超时（diag-d 实测 30022ms "error decoding response body"）；流式管道下首字节毫秒级、客户端断开即取消回源。
4. **libmpv 动态 FFI 而非链接**：122MB DLL 随 vendor 分发（已 gitignore），构建零依赖；事件线程闭包用 `#[derive(Clone,Copy)] RawHandle` 包装 HWND 满足 'static 捕获。
5. **子窗口渲染验证靠桌面截图**：CDP 截图只截 Chromium 层（mpv 原生子窗口不可见），PowerShell CopyFromScreen 截全屏人眼确认 bipbop 画面 + UI 覆盖层共存。

**验证结果**（2026-10-26）：

- Rust 单测 35/35（parser 5 + engine 27〔含 series 4〕+ proxy 3）
- P3 冒烟 20/20（`node apps/core/scripts/smoke-p3.mjs`，需 `pnpm core:build`）：A 轮 mpv headless 直连真实 HLS（probe/attach/起播 t=0.2s/tracklist 12 轨/pause/seek/stop/detach）；B 轮 master 透传（最高码率 1 引擎 + 5 透传、EXT-X-MEDIA 保留无泄漏、raw playlist 分片本地化 /segraw、mpv 播 masterUrl 起播 + 12 轨归并）；C 轮 series 队列（e0 precache 全量 → 自动激活 e1）+ purge_cache + 策略读写往返
- 旧冒烟回归 29/29（`pnpm smoke`）
- 真实窗口 E2E 6/6（裸 CDP + 桌面截图）：nativeHwnd → mpv.attach（Win32 子窗口）→ 起播 t=0.4s → mpv.move → 截图确认 mpv 画面渲染 + UI 覆盖共存
- tsc/vue-tsc typecheck 通过；electron-vite build 通过；cargo build --release 通过

**P3 遗留（并入后续阶段）**：

- mpv 窗口模式下 `mpv.get` 数字属性返回字符串（get_property_string），如需强类型可改 MPV_FORMAT_DOUBLE
- BYTERANGE 开放式 Range 透传存在带宽浪费（客户端只读所需字节，CDN 多发的尾部字节被丢弃）；可结合 raw_playlist 已知的 BYTERANGE 表收紧 Range 上界
- 直播 live 任务不参与 series 队列与 precache（VOD only）；live 滑动窗口 P4
- MP4 直链 P2SP 多源聚合、core 重启后 token 刷新（P1 遗留顺延）→ P4

### P4 P2SP 多源聚合 + 收尾（✅ 2026-10-26 交付）

**已交付**：

| 模块 | 位置 | 说明 |
|---|---|---|
| MP4 探测 | pf-parser `probe_mp4` | `Range: bytes=0-16383` 预检：HTTP 206 + `Content-Range` 解析总长 + 首 16KB SHA-256 短指纹（hex 前 16 字符）；非 206（源不支持 Range）→ 报错拒绝建任务 |
| MP4 块化 MediaIR | pf-parser `build_mp4_ir` | 按 `MP4_CHUNK = 4MiB` 切块，每块一个 `Segment { byterange: Some((off, len)) }`，duration=0 / total_duration=None（播放器自取 moov）；**完全复用 P1 下载管线**（自动 Range 头 / 幂等清单 / 水位调度 / 多源择优 / 缓存三档），零新增引擎下载代码 |
| MP4 任务分支 | pf-engine `probe_and_start_inner` | `detect(url)` 分流：MP4 → 主源 `probe_mp4` + `build_mp4_ir`（空文件报错）；镜像 mp4 分支 `probe_mp4` 与主源比对（Content-Length + 首 16KB hash 一致才接受），不一致剔除并日志「禁止跨源混拼」；HLS 分支保持 load + 对齐校验；playUrl = `/file/{token}/{task}`（Protocol::Mp4） |
| P2SP 分摊 | pf-engine `pick_source` 增 `spread` 参数 | `spread=true`（MP4 多镜像，字节一致性已预检）→ **纯 seq 轮转** `cands[seq % len]`，不受 health score 分化影响（score 分化会破坏同分轮转，见决策 2）；`spread=false`（HLS）→ score 择优 + 同分轮转；故障兜底不变（熔断 available + exclude 同源退避） |
| /file 虚拟文件 | pf-proxy `file_virtual` | 按客户端 Range 跨块组装：已下载块 `read_segment` 读盘直回，未下载块 `proxy_fetch_segment` 回源 + tee 落盘（online 跳过）；Range 起点所在块触发 `note_playhead`（驱动水位调度）；206 + Content-Range 组装 + accept-ranges；`parse_http_range` 三形态（`bytes=a-b / a- / -n`，multipart → None） |
| token 刷新 | desktop `replayAfterReconnect` | CoreBridge 重连（online 翻转）后：源含 `/m3u8/` 或 `/file/`（代理地址依赖 token）→ refreshTasks → 从任务表取新 playUrl（mpv 引擎用 masterUrl ?? playUrl）→ 重新 play；App.vue `watch(store.online)` 挂接 |
| MP4 直链播放 | desktop `play()` | `isHlsSrc = /\.m3u8($|\?)/.test(src) \|\| src.includes('/m3u8/')` 分流：HLS → hls.js/原生 HLS；非 HLS（MP4 直链 / /file）→ `video.src = src` 原生 Range 播放（浏览器 video 自带 Range 请求语义） |
| live 滑动窗口 | pf-proxy `build_playlist` | live 且 >8 片只输出最近 8 片（LIVE_WINDOW=8）+ MEDIA-SEQUENCE 前移到窗口首片 + 无 ENDLIST（hls.js 跟播语义）；pf-engine `in_schedule_window` 加 live 参数：live && precache → 退化为 stream 窗口（直播无全量预取概念） |
| BYTERANGE 透传收紧 | pf-proxy `raw_playlist/raw_segment` | raw_playlist 输出分片 URL 带 `?r={off}-{len}`（含省略 @offset 按 `parse_byterange_spec(prev_end)` 续算）；raw_segment 用 `clamp_range_start_end` 把开放式/无 Range 的终点收到块尾（起点保留，精确区间原样）——客户端只读所需字节，CDN 不再多发尾部字节 |
| mpv.get 强类型 | pf-mpv ffi/lib | 函数指针表加 `mpv_get_property`（format 参数化）；get_property 先试 MPV_FORMAT_DOUBLE（数值属性直取），失败回退 get_property_string |

**关键实现决策**：

1. **MP4 块化复用 BYTERANGE 管线而非新写 P2SP 引擎**：4MiB 块 = Segment{byterange}，幂等清单/并发/重试/多源/水位/缓存三档全部免费复用；/file 是「虚拟文件」视图，按客户端 Range 找到覆盖块序列逐块拼装（命中读盘 / 未命中回源）。
2. **P2SP 分摊用纯 seq 轮转而非 score 择优**：镜像字节一致性已由首块 hash 预检保证，带宽聚合靠「均分」；score 择优会被首次 record_success 的吞吐分化破坏轮转（实测 src2=0 → 全走主源），故 spread 模式不看 score，故障场景由熔断 + exclude 兜底。
3. **无 Range 客户端请求回源可用收紧 Range，但对客户端回 200**：raw_segment 收紧后源回 206，若原样透传违反 RFC 7233 §4.1（无 Range 请求不得回 206）且破坏普通 GET 语义；按「客户端是否带 Range」归一状态 + 裁剪 Content-Range 头。
4. **重启恢复只救未完结任务**：`unfinished_tasks()` WHERE status IN (pending/probing/downloading)，ready 任务不参与——冒烟验证 kill 续传需用大文件（256MiB）保证 kill 时任务仍 downloading。

**验证结果**（2026-10-26）：

- Rust 单测 42/42 通过 + 1 忽略（parser 8〔MP4 块化/sha256 指纹〕+ engine 28〔live 窗口退化 4 项〕+ proxy 6〔live 滑窗/BYTERANGE 续算/Range 解析〕）
- P4 冒烟 17/17（`node apps/core/scripts/smoke-p4.mjs`）：A 轮 MP4 单源（/file 三形态 Range 字节对齐 + precache 落盘 + 命中读盘）；B 轮双镜像 P2SP（**src1=4 src2=4 对称分摊** + 聚合字节完整）；C 轮异源镜像 hash 预检剔除；D 轮 kill 续传 + token 刷新（playUrl 换新 token + 新 token /file 字节续传一致）；E 轮 live 滑动窗口（MEDIA-SEQUENCE=4 + 8 片 + 无 ENDLIST）
- 旧冒烟回归 29/29（`pnpm smoke`）；P3 冒烟回归 20/20（segraw 状态归一后复验）
- tsc/vue-tsc typecheck 通过；electron-vite build 通过；cargo build --release 通过

**P4 遗留（低优，不影响交付）**：

- MP4 合并导出（P2 P1 遗留顺延：任务完成可选合并导出，fMP4 走 ffmpeg merge）
- yt-dlp 式站点提取兜底（DESIGN §4.1「其他协议交提取器」，暂无需求场景）
- IDM 式动态分段（空闲连接把最大剩余块对半分）；当前 4MiB 固定块 + 4 并发已满足带宽聚合演示目标

### P5 产品化打磨：任务管理 / 媒体库 / 设置页（✅ 2026-10-26 交付）

**前端架构**（apps/desktop/src/renderer/src，无 vue-router，Pinia route 状态驱动）：

- **App 壳**：左侧窄边栏（SideNav：播放/媒体库/任务/设置 + 内核状态灯）+ 顶栏页题/状态 + 内容区四视图切换；播放页 `v-show` 保活（切页不打断播放，video/mpv 子窗口元素常驻），其余视图 `v-if`。全局 CSS 设计 token（`--bg/--panel/--line/--accent/--ok/...` 统一色板圆角）+ 共享基础类（card/badge/kv/mono/表格）收敛进 App.vue 全局 style
- **组件拆分**：App.vue（≈1100 行单页）拆为 components/{SideNav,PlayerView,TasksView,LibraryView,SettingsView}.vue；播放页保留引擎切换/mpv 控制/调试面板（默认折叠：多源监控 + 事件日志）；player.ts 新增 `route/pendingPlay` 状态与 `go/playTask/pauseTask/resumeTask/deleteTask/saveUiPrefs` actions，`deriveTitle()` 从 URL 派生任务标题（文件名/主机名），新建任务默认缓存档 localStorage 持久化
- **任务管理页**：表格化——任务标题+id、状态徽章（含 P5 新增 paused）、**可视化进度条**（分片+字节+百分比）、**实时速度**（speedBps，事件心跳已在推、此前 UI 未显示）、缓存模式下拉（三档着色）、保留期、操作列（**播放**〔跨页跳转+自动起播〕/**暂停**/**恢复**/清缓存/**删除**）
- **媒体库**：卡片墙（渐变缩略图 + 协议徽章 + 状态/模式徽章 + 进度条 + 添加时间），卡片 ▶ 跨页起播；空态引导「去播放页」
- **设置页**：内核状态卡（版本/双端口/ping/libmpv DLL 路径）+ 播放与缓存卡（新建默认模式 + 播完 TTL/未播完 LRU/容量上限策略编辑，自 P3 播放页归拢）+ 关于卡

**Rust 侧**（pf-core + pf-engine）：

- **task.pause**：`pause_task` —— stop_download_job 协同停 worker + 700ms 收尾窗口（防最后心跳把 Paused 覆盖回 Downloading）→ DB/内存/通知三处 paused；播放不受影响（proxy 未命中仍实时回源）
- **task.resume**：`resume_task` —— 复用剧集队列激活管线 `activate_task`（新增 media-in-memory 快捷分支：会话内暂停跳过重新解析直接 spawn job；core 重启后走 probe_and_start 全量续传）；online 模式拒绝
- **task.delete**：`delete_task` —— 停 job → purge_task_cache（文件+分片索引）→ `delete_task_cascade` 级联删库行（tasks/sources/segments）→ 清五张内存表 + last_touch；返回 freedBytes。删后同 URL 可重建（UNIQUE url 不再冲突）
- **启动恢复全量化**：`all_tasks()`（全行含 ready/paused）替代 `unfinished_tasks()` 驱动 `restore_from_db` —— ready 任务重建内存表（媒体库跨重启可见），paused 保持暂停不起 job，未完结照旧续传；probe_and_start 补 title 透传（restore 重建任务后 upsert 不再置空标题）+ 探测期间已暂停则不 spawn job
- **shared**：TaskStatus 加 `paused`；RpcMethod 加 TaskPause/TaskResume/TaskDelete；三个 RPC 类型定义

**关键修复（P2.5 潜伏 bug，P5 冒烟暴露）**：

- `finish_job` 把 `retain_ms()` 的**时长**（86400000）当**绝对时刻**传给 `store.mark_finished`（cleanup 单测传的是 `now + 86_400_000` 绝对语义）→ retain_until 写成 1970-01-02 → 60s 清理循环把**刚播完的任务当过期任务删除**。旧冒烟每轮内核存活 <60s，清理循环从未触发，潜伏两阶段未暴露。诊断手段：最小复现脚本（origin + core + RPC 轮询 task.list + 通知流）抓到 `缓存保留至 1970-01-02` + `缓存清理：删任务 1` 现场证据。修复：`retain_until = retain_ms(...).map(|ms| now + ms)`
- 附带发现：cargo test 只编测试不产出 bin，`pnpm build` 也不含 Rust —— 冒烟前必须 `cargo build --release`（此前 P4 曾用旧二进制跑出「task.pause method not found」假象）

**验证结果**（2026-10-26）：

- Rust 单测 41 过 + 1 忽略（engine 28 / parser 7+1 / proxy 6）
- P5 冒烟 40/40（`pnpm smoke`）：P1–P4 全量回归 + 第七轮新增 12 项——pause 状态回带/进度冻结、resume 状态回带/任务保留不回退（retain_until 回归断言）、delete freedBytes/列表清空/缓存目录移除/同 URL 可重建、**暂停任务跨重启保留且不自动续传**
- P4 冒烟 17/17、P3 冒烟 20/20 回归；tsc/vue-tsc typecheck、electron-vite build、cargo build --release 全绿
- 真实窗口 E2E 14/14（裸 CDP）：侧导航四项/默认播放页/调试面板折叠/设置页内核在线+策略卡/媒体库渲染/本地代理起播 currentTime>0/新任务首行（标题+暂停+删除按钮）/播放页 v-show 保活/任务页点播放跨页起播/暂停徽章/恢复徽章/删除回基线（confirm 自动接受）

**E2E 注意**：桌面端用真实数据目录（%LOCALAPPDATA%/PolyFrame），历史任务会被全量恢复 —— 同 URL task.create 复用任务（P1 特性）会破坏「+1 基线」断言，E2E 需先清理历史 bipbop 任务再取基线。

### P6 遗留收官 + Windows 安装包（✅ 2026-10-26 交付）

DESIGN §10 P4 表遗留三项全部落地，并产出可分发的 Windows 安装包。

**IDM 动态分段（pf-engine，DESIGN §4.2）**：

- MP4 任务调度从静态 4MiB 块逐片取件升级为 IDM 动态分段：空闲 worker 把**调度窗口内最大剩余连续 run** 对半分认领前半段（`largest_window_run` + `Claim{next, stop_at}` CAS 游标块）；todo 清空后可**窃取最大在途块剩余段**（`try_steal_claim`，剩余 ≥4 片才值得切，原块 stop_at 前移至切分点）
- 块只是调度范围：认领块内仍逐片走既有 `fetch_on_sources`（换源/重试/健康度记账/出窗归还 todo 重排不变），分片存储与断点续存零改动
- HLS 任务照旧逐片调度，不受影响

**合并导出（task.exportInfo / task.export，DESIGN §4.6）**：

- 纯 Rust 二进制 concat（零外部依赖）：TS 分片按 seq 直拼；**fMP4 前置 EXT-X-MAP init 段**（parser 新增 `MediaIR.map_uri` 捕获，导出时重新拉取 init）再拼 m4s → .mp4；MP4 块回拼原始文件
- 格式判定：嗅探首缓存片首字节（0x47 = TS，否则 mp4）；`.part` 先写后 rename 防半截文件；未完成缓存允许导出（warn 日志）；`.part` 残留清理
- 桌面端编排：任务页「导出」按钮（有缓存且非 dash）→ 主进程 `pf:export` IPC → task.exportInfo 探测 → 保存对话框（标题派生文件名）→ task.export（10 分钟长超时）→ 日志反馈
- parser 附带 EXT-X-MAP 单测；冒烟第八轮：exportInfo 完成度回带 / export 成品字节级一致 / .part 无残留 / 未知任务报错

**站点提取兜底（DESIGN §4.1）**：

- 两级提取：① `pf_parser::scan_html`（零正则，引号字面量枚举 + 扩展名命中 + URL 合法性预过滤 + 相对路径归一 + 去重上限 20）扫页面内嵌 m3u8/mpd/mp4，候选逐个尝试（上限 5）；② 无候选时调用外挂 yt-dlp（`find_ytdlp`：pf-core.exe 同目录 → PATH；`-g --no-playlist`，90s 超时）取直链
- 挂载点：`probe_and_start` 主源 HLS 解析失败时走 `extract_fallback`（MP4 主源不走兜底）；过程日志全程可见
- UI：播放页 url-hint 提示直链支持范围与 yt-dlp 解锁说明

**Windows 安装包（electron-builder）**：

- 双产物：NSIS Setup（引导式安装：目录可选/桌面+开始菜单快捷方式/卸载器）+ portable 免安装版；图标 `apps/desktop/build/icon.ico`（256px 圆角渐变 + 播放三角，脚本生成）
- **pf-core + libmpv-2.dll 内置**：extraResources → `<install>/resources/pf-core/`；`locateCoreBin` 补打包分支（`process.resourcesPath`），优先级 环境变量 > 打包 resources > dev release > debug
- 产物体积：Setup ≈161MB / portable ≈144MB（libmpv 116MB 内置）；无签名证书（SmartScreen 首次运行需「仍要运行」）

**验证结果**（2026-10-26）：

- Rust 单测 45 过 + 1 忽略（engine 30 新增 IDM 2 / parser 8 新增 MAP+HTML 扫描 2 / proxy 6）
- 冒烟 46/46（P1–P5 全量回归 + P6 导出轮次 5 项）
- typecheck / electron-vite build / cargo build --release 全绿；真实窗口 E2E 9/9（dev 构建四视图 + url-hint）+ **打包版** E2E 2/2（win-unpacked 内核在线 + libmpv 条目）
- NSIS 闭环：静默安装 /S → 布局验证（exe/resources/pf-core/卸载器）→ 启动运行 → 静默卸载 → 目录清理干净

### P7 影视发现与片源聚合（✅ 2026-10-26 交付）

在线搜索 + 片源聚合（对标 LibreTV/MoonTV 的 CMS 采集站聚合模式）。用户输入片名 → 聚合全部启用采集站搜索 → 同名影片按 `normalize(name)+year` 归并成卡片（收录站数 = 热度参考）→ 详情弹层多站片源选集起播 → 收藏入库（多站片源快照 + 手动补充）。

**pf-parser::cms（纯解析，无网络）**：

- 苹果CMS V10 API 解析：`parse_vod_list`（serde 全字段 default + `vod_id` 数字/字符串弹性解析，站点实现参差不炸）；`parse_play_groups`（`vod_play_from`/`vod_play_url` 按 `$$$` 分组、组内 `#` 分集、`名称$URL` 按首个 $ 切分容忍 URL 含 $、from 缺失「播放」兜底、裸 URL 序号命名）
- URL 构造：`search_url`（ac=detail&wd 一步拿全 play_url）/ `search_url_fallback`（ac=videolist，仅支持列表搜索的站回退）/ `detail_url` / `list_url`（测速最小请求）；wd 表单编码
- 聚合键：`normalize_name`（去全部空白 + 小写）+ year → `aggregate_key`

**pf-engine::catalog_store（三表）**：`catalog_sources`（api UNIQUE）/ `favorites`（含 last_played_at）/ `favorite_sources`（episodes 快照 JSON + origin=search|manual）；随 `CacheStore::open` 建表（ALTER 免，全新表）。CRUD + `find_favorite_by_key`（聚合归并）+ `find_favorite_source_by_site`（同站同 vodId 去重）+ 元数据 COALESCE 回填。

**pf-core::catalog（网络编排）**：

- 源站：出厂播种 5 个社区采集站（仅表空时写入，builtin 可删可重加）；`source.add` 先探测（ac=list 计时）失败拒绝入库；`source.test` 回写 latency/last_ok；搜索只走 enabled 源
- 聚合搜索 `catalog.search`：并发 fan-out 全部启用源（单请求 4.5s 超时，detail+videolist 最坏 8s < RPC 60s），归并排序（收录站数优先）截 60 卡；失败站进 failures 回显
- 详情 `catalog.detail`：ac=detail&ids → 分组剧集（CatalogDetail/EpisodeGroup/Episode，serde camelCase 与 shared 同构）
- 收藏：`favorite.add` 接 card（并发拉 ≤3 站详情并入）或 detail；`favorite.source.add` 手动补充（换行归一为 `#` 复用 play_url 解析，裸 URL 序号命名）；`favorite.touch` 记录最近播放；site+vodId 去重
- **片源切换语义**：同片不同站 = 不同编码版本，不走 P2SP 字节聚合；切换 = 详情弹层选另一站剧集重新起播

**pf-proxy /pic 海报透传**：`/pic/{token}?u={percent-encoded}`（同 token 门禁）；percent-decode + http(s) 白名单 + 控制字符拒绝 + 10MB 上限；同源 Referer + 浏览器 UA 过基础防盗链；24h cache-control。`core.hello` 新增 `proxyToken`（渲染层拼海报 URL 用）。

**桌面端**：

- `stores/catalog.ts`：源站管理/搜索/详情/收藏/海报 URL 组装（posterUrl 经 /pic）；起播复用 player.playTask（task.create → 跨页起播，缓存档位沿用设置页默认）
- `DiscoverView.vue`（发现页，v-show 保活保留搜索状态）：搜索栏 + 卡片墙（▲N 站热度徽章）+ 详情弹层（元数据 + 分组选集网格 + 收藏）+ 收藏片源弹层（多站分组 + 手动补充 textarea）；发现页内嵌源站管理
- `LibraryView.vue`：双 tab（下载内容 / 收藏）；收藏卡 poster + sourceCount + 一键播放第一片源第一集
- `SettingsView.vue`：发现源站卡（表格：启停/测速/删除 + 添加自动探测）

**验证结果**（2026-10-26）：

- Rust 单测：parser 32（cms 新增 4）/ engine 13+1 忽略（catalog_store 2）/ proxy 6 全绿
- P7 冒烟 `smoke-p7.mjs` 24/24：源站管理 7（hello token/播种/探测入库/重复拒绝/坏站拒绝/测速回写）+ 聚合搜索 5（双站归并/字段/fallback/空 failures/空白归一）+ 详情 2 + 收藏 5（聚合/去重/快照/手动混合解析 3 集/touch）+ /pic 3（透传/门禁/Referer）+ 级联删除
- 回归：cargo test 全绿、P1–P6 冒烟 46/46、P3 20/20、P4 17/17、typecheck / electron-vite build 全绿

### P8 全网视频源集成（✅ 2026-10-26 交付）

把「一个源站一个源站手动加」变成「预设库 + 批量导入 + 全量测速」：内置 18 个实测可用的 CMS 采集站，同时支持从公开源清单（纯文本 / LibreTV-SourceList JSON / MoonTV `api_site` JSON / Base58 订阅）一次性导入，导入前逐条探测，只收能返回数据的站。

**pf-parser::sourcelist（纯解析，无网络）**：

- `parse_sources(text)`：三种形态归一
  - 纯文本：每行 `名称$URL` / `名称,URL` / `名称 URL` / 裸 URL；`#`、`//`、`;` 开头为注释；名称缺失用主机名兜底（去 `www.`）
  - JSON：`sources[]`（LibreTV）、`api_site{}`（MoonTV）、根数组；只把容器键（sources/sites/api_site/apis/list/data/config/vod/cms）下的 `url` 当源站地址，`liveSources` 直播源跳过
  - Base58：`Base58(JSON)` 订阅文本（自带解码，无 bignum 依赖）
- 归一与去重：api 去尾 `/`、必须 http(s) 且主机含 `.`、按 api 大小写不敏感去重、单次上限 500 条、`isAdult` 标记透出给上层

**pf-core::presets（出厂预设库，`PRESET_VERSION=2`）**：18 个非成人向采集站，逐个过两道实测门槛（`?ac=list&pg=1` 返回 JSON + `?ac=detail&wd=` 真能搜到片并带 m3u8）。新装播种全量；老用户走「同步预设库」补齐缺口（同 API 不重复、不覆盖用户改名）。

**新增 RPC**：

| 方法 | 语义 |
|---|---|
| `catalog.source.presets` | 返回全量预设 + `installed` 标记 + `version`（前端算缺口） |
| `catalog.source.import` | `{text?, url?, probe?, enabled?, builtin?}` → 解析 → 去重（同 API 跳过）→ 12 路并发探测 → 只写成功项；返回 `imported/skipped/failed/adultDropped` |
| `catalog.source.probe_all` | `{ids?}` → 12 路并发测速，成功回写 `latency_ms`/`last_ok_at`，返回逐条结果 |

**健壮性修复（实测暴露）**：

- cms 外层 `code/page/pagecount/total` 改弹性解析（大量站回 `"1"` 字符串，原 `u32` 直接整站判失败）；`list` 改弹性数组（null/非数组→空、坏条目跳过）
- `catalog_store` 单测临时库按用例唯一化（并行跑时互相 `remove_dir_all` 导致 readonly database）

**桌面端**：

- `stores/catalog.ts`：`loadPresetStat` / `syncPresets`（按 12 条分批，避免单次 RPC 超时）/ `importSources`（纯 JSON/Base58 整段提交，行文本按批切）/ `probeAllSources`（按批）
- `electron/main`：`catalog.source.import` / `probe_all` 超时放宽到 60s（默认 10s），其余 RPC 不变
- `DiscoverView` 源站面板：右上工具条（同步预设库 / 批量导入 / 全部测速）+ 展开式导入区（textarea + 订阅 URL）+ 预设库计数器；`SettingsView` 同卡补两个快捷按钮

**验证结果**（2026-10-26）：

- Rust 单测：parser 19（sourcelist 5 + cms 弹性 1）/ engine 32 / proxy 6，连续 3 轮全绿
- P8 冒烟 `smoke-p8.mjs` 14/14：预设播种/文本导入计数/幂等/isAdult 丢弃/直播源跳过/Base58/参数校验/probe_all 回写/清理还原
- 真机：隔离 LOCALAPPDATA 起 release 内核，预设库 **18/18 可用**（电影天堂 281ms … 暴风 1285ms）
- 回归：P1–P6 46/46、P3 20/20、P4 17/17、P7 24/24（断言从「固定 5 源」改为「≥5 且全 builtin」「基线+1」）
- 真实窗口 E2E `e2e-p8.mjs` 9/9：切发现页 → 工具条三按钮 → 预设库 18/18 → 导入本地假站（toast+入表）→ 全部测速 19 可用 → 删除还原

### P9 影视发现闭环：分类浏览 / 剧集连播 / 追更 / 继续观看（✅ 2026-10-26 交付）

对照 LibreTV（分类 + 豆瓣推荐 + 进度同步 + 换源测速）、MoonTV（收藏 + 继续观看 + 播放记录）与「观影 GYING」（分类筛选、今日更新、追更、观影历史）补齐「发现 → 浏览 → 追看」闭环。Rust 侧新增 4 个 RPC 与 1 张表，桌面端补齐三处 UI。

**新增 RPC**：

| 方法 | 语义 |
|---|---|
| `catalog.category` | `{pg?, hours?, category?, year?}` → `ac=detail&pg=N` 翻页扇出全部启用源站；`category` 按 `type_name` 关键词客户端过滤（站间 `t=` 类型 ID 不互通，不做透传）；`year` 精确匹配；`hours` 走苹果CMS `h` 参数（今日更新流）；结果按站内 `vod_time` 降序 |
| `catalog.favorite.refresh` | `{id?}` → 回拉收藏各片源站 `ac=detail&ids=` 对比集数，快照变多才写回；返回 `updated[{oldCount,newCount,added}]`；幂等，手动补充片源（无 api/vodId）跳过 |
| `catalog.favorite.progress.set` | 每收藏一条进度（`INSERT OR REPLACE`），顺带刷新 `last_played_at` |
| `catalog.progress.list` | `{limit?}` → `watch_progress JOIN favorites`，补片名/年份/海报，按 `updated_at` 降序 |

**数据模型**：`pf-engine` 新增 `watch_progress(favorite_id PK, episode_name, episode_url, position_sec, duration_sec, updated_at)`，删收藏级联清进度。`pf-parser::cms` 新增 `page_url(api, pg, hours)`（翻页 + `h` 参数）与 `category_matches`（动漫→剧集→综艺→电影，顺序敏感以避免「纪录片」串门）；`Card` 增 `updateTime`（站内 `vod_time` 聚合最大值）。

**连播语义**：选集时整组剧集入队（`playFromQueue`），hls 走 `ended`、mpv 走 `mpvState.eof` 触发 `playNext`；播放页提供「下一集 ▶ 集名」。队列只存在渲染进程（`queue / queueIndex / queueFavoriteId`），不入库。

**进度与续播**：PlayerView 每 5s 节流上报 `timePos`；续播时重建队列并置 `pendingSeek`，hls 在 `canplay` 后消费，mpv 在首次 `playing` 后 seek。看过 >15s 且距片尾 >30s 才跳，否则从头播。

**桌面端 UI**：

- 发现页：搜索 / 分类 双 tab；分类页筛选 chips（今日更新 · 电影/剧集/动漫/综艺 · 年份）+ 加载更多；卡片海报显示更新日期角标
- 发现页详情弹层：「片源（N 站）」chips 可切换同一部片的其他收录站（`openCardDetail` 记住聚合卡片 → `switchDetailSource` 重拉详情），补齐 LibreTV「跨源同名聚合可比较选源」
- 媒体库：收藏 tab 顶部「继续观看」行（海报 + 集名 + 进度条 + 续播）+ tabs 右侧「检查更新」；收藏卡显示 `+N 集` 徽章
- 播放页：「下一集」按钮 + 自动连播

**验证结果**（2026-10-26）：

- Rust 单测：`cargo test` 全绿（parser 36 / engine 28+1 ignored / proxy 7 / netdisk 11）
- P9 冒烟 `smoke-p9.mjs` **28/28**：分类分页/大类过滤/年份/h 参数/第二页、追更 added=2 与幂等、进度读写与覆盖、JOIN 补名、级联清理、参数校验
- 回归：P1–P6 46/46、P3 20/20、P4 17/17、P7 24/24、P8 14/14
- typecheck / build：tsc + vue-tsc + electron-vite 全绿
- 真实窗口 E2E **10/10**：清空预设 → 注入本地假站 → 分类 tab 出卡 22 张 → 剧集筛选生效 → 加载更多取第二页 → 详情弹层收藏 → 媒体库收藏卡 → 追更出现 `+2 集` → 继续观看行显示「第02集 · 26%」→ 清理还原
- 换源 E2E **6/6**：同名影片两站收录 → 聚合卡「▲2 站」→ 详情弹层片源 chips 2 个 → 切到 B 站后剧集 2 → 5 集、当前站高亮

### P9b 网盘视频源插件（✅ 2026-10-26 交付）

> **编号说明**：本批与 `P9 影视发现闭环（吸收 GYING）` 是**并行交付的两批**，共用同一时间窗，故记为 **P9b**（代码注释里的「P9b 网盘…」均指本批），与 `P10 云解析` 无重叠。

接入网盘作为视频源：**授权账号 + 分享链接**两条入口，浏览目录（分页）→ 挑视频 → 在线播放 / 加入任务。核心诉求是「与现有视频源架构兼容」与「可扩展插件模块」，实现上收敛为一句：**网盘文件对系统就是一个 MP4 直链**（详见 §4.7）。

**新增 crate `pf-netdisk`**（纯 HTTP + 纯逻辑，不碰 SQLite/全局状态）：

| 文件 | 职责 |
|---|---|
| `lib.rs` | `Provider` 契约、`ProviderKind`/`AuthMode`/`Credentials`/`NetdiskItem`/`Page`/`PlayTarget`/`AuthChallenge`/`AuthOutcome`/`NetdiskError`、单例注册表与 `provider_infos()` |
| `share.rs` | 分享链接解析（百度/阿里云盘/OneDrive → 统一 `ShareRef`）、`base64url` 编码，4 单测 |
| `link.rs` | `LinkCache` 直链缓存 + `LINK_SKEW_MS=60s` 提前过期判定，3 单测 |
| `http.rs` | 通用 HTTP 目录网关适配器（契约基准）+ 共用原语（`client/get_json/post_json/opt_str/join_url/urlencode`），4 单测 |
| `baidu.rs` / `aliyun.rs` / `onedrive.rs` | 三家真实网盘适配器（Cookie / refresh_token / 设备码） |

**零改造复用**（本批最关键的设计）：shim URL `http://127.0.0.1:{port}/nd/{nd_token}/{owner}/{fileId}/v.mp4` 以 `.mp4` 结尾 → `pf_parser::detect` 判为 MP4 → 走既有 `build_mp4_ir` 4MiB 分块 + `/file` 虚拟文件 Range + 缓存三档 + 水位调度。**pf-engine 下载/缓存代码与播放器一行未改**，只新增网盘存储与服务门面。

**新增 RPC（15 个，`netdisk.` 前缀）**：

| 方法 | 语义 |
|---|---|
| `netdisk.providers` | 适配器能力表（`authModes`/`supportsShare`/`hint`，UI 据此渲染授权表单） |
| `netdisk.account.list\|add\|refresh\|remove` | 账号 CRUD；`add` 先 `verify` 校验，失败不入库；出参脱敏（无 cred） |
| `netdisk.auth.begin\|poll` | 设备码授权（OneDrive）：`authorization_pending`/`slow_down` 继续轮询，完成即入库 |
| `netdisk.list` | `{accountId\|shareId, dirId, cursor, pageSize}` → `{items, nextCursor, total}` |
| `netdisk.resolve` / `netdisk.playUrl` | 主动解析一次 → `{url(shim), expiresAt, expiresInSecs, headerCount, ext, host}` |
| `netdisk.play` | 预解析 → 生成 shim URL → `create_task`（`cacheMode` 可选，默认 stream） |
| `netdisk.share.list\|add\|parse\|remove` | 分享 CRUD + 纯解析预览（`canBrowse` 提前告知该网盘是否支持直接浏览） |

**关键机制**：

- **有效期三层**：解析层每次换新链并缓存 → 判定层余量 <60s 视为过期提前换 → 容错层 proxy 遇 401/403/410 强制 `force` 换链重试一次；`LinkCache` >512 条清空，删账号/分享按 `invalidate_prefix` 级联失效。
- **独立 shim 密钥**：`nd_token` 与 proxy `token` 分离且落 `settings` 表 —— proxy token 每次启动轮换，而 shim URL 会写进任务 URL 需跨重启稳定；`nd` 已进 proxy 路径黑名单，owner/fileId 段严格校验与转义。
- **分页同构**：`Page{items,next_cursor,total}`，百度页码 / 阿里 marker / OneDrive nextLink 全部收敛；`pageSize` 缺省读 settings（100，clamp 1..=200）。
- **登录态续期**：`ctx_for` 在加载账号时以 60s 余量判定 → `refresh()` → `prepare()` 重派生 `drive_id` → 落库；认证类错误把账号置 `expired` 并回 `needReauth=true`。
- **安全边界**：账号出参不含 Cookie/token；OneDrive `@odata.nextLink` 只跟随 `graph.microsoft.com` 前缀（防凭据外发）；百度 Cookie 必须含 `BDUSS=`。

**桌面端**：新增「网盘」导航项与 `NetdiskView`（左栏 = 账号列表〔状态徽章/续期/删除〕+ 添加账号〔按 `authModes` 渲染 Cookie/Token/网关地址/client_id + 设备码面板〕+ 分享链接；右栏 = 面包屑目录表〔名称/大小/修改时间/操作〕+ 直链信息条〔有效期、注入头数〕+ 加载更多 + 空态）。`stores/netdisk.ts` 管理全部状态；路由用 `v-show` 保活以免切换丢目录位置。

**验证结果**（2026-10-26）：

- `cargo test --release` 全绿（engine 36 / netdisk 11 / proxy 7 / parser 28+1 ignored）
- P9b 冒烟 `smoke-netdisk.mjs` **38/38**（全本地假网关，不依赖真实网盘）：A 适配器能力与分享解析 4 + B 账号鉴权（错 token 不入库/出参脱敏）4 + C 目录分页与归类 7 + D 播放地址（shim 形态/有效期/头数）4 + E shim 透传（200 全量 / 206 区间 / 头注入）5 + F 直链缓存命中不换链 1 + G 直链作废后 shim 仍可播（换链计数 +1）2 + H 加入任务（`protocol=mp4`、`/file/`、`segTotal`、Range 字节一致）5 + I 续期 2 + J 边界与清理 4
- 回归：P1–P6 46/46、P7 24/24、P8 14/14、P9 28/28、P10 32/32
- `pnpm -r typecheck` / `pnpm -r build` 全绿（main 侧 `netdisk.list 45s`、`account.add 45s`、`share.add 60s`、`play 60s` 放宽超时）

**边界**：百度网盘分享链接受官方策略限制，只能走「先转存到自己网盘再浏览」，UI 用 `supportsShare=false` + 可读提示说明而不是报错；三家网盘接口均为非官方/开放平台接口，字段与风控随时可能变化，适配器已做弹性解析（数字 id 容错、字段缺失兜底、错误分类），但长期维护成本客观存在 —— 这也是把每家差异全部关在 `pf-netdisk` 内的原因：上层契约不变，坏一家不影响其余。

### P10 第三方视频云解析（✅ 2026-10-26 交付）

把「VIP 视频解析」这类工具做进来：粘贴爱奇艺/腾讯/优酷等播放页地址，换成能直接播的流。**关键设计是不假设接口一定能用** —— 免费解析接口生存期以周计，2026-10 实测公开流传的 `jx.*` 接口基本已被替换成关停公告页。因此实现成**三段式降级 + 可管理接口库**，而不是写死几个 URL：

| 段 | 触发 | 落地能力 |
|---|---|---|
| ① 直链 | 接口返回 JSON 或页面里内嵌 m3u8/mp4 | 建任务走本地代理：边下边播 / 缓存三档 / libmpv / 断点续传全部复用 |
| ② 嗅探 | 接口只给 HTML 播放页，正片地址由页面 JS 运行时换取 | 主进程隐藏窗口实跑 JS，从 `webRequest` 截 m3u8 → 同样进代理 |
| ③ 内嵌 | 嗅探也拿不到（要登录/点播/验证码） | iframe 直接嵌播放页；`X-Frame-Options`/CSP 禁止内嵌时提示改用独立窗口 |

**pf-parser::parseurl（纯文本，可单测）**：

- `build_parse_url(api, page)`：三种模板形态 —— `?url=` 结尾直拼、`{url}`/`{url_raw}` 占位符、已有参数补 `&url=`；页面地址按 `encodeURIComponent` 规则编码（自实现，零新依赖）
- `extract_media(text, base)`：`scan_html`（引号字面量）+ 裸 URL 扫描；先反转义 `\/`、`\u002F`、`\u003A`、`&amp;`、`%3A%2F%2F`（二次编码整条 URL 的接口很常见）；结果 m3u8 优先、去重、上限 20
- `collect_json_media`：递归取直链，常见键（url/playUrl/play_url/m3u8/video/src）优先保证结果稳定
- `dead_marker`：识别「江湖路远 / 站点创建成功 / 域名出售 / 该站点已关闭」等 11 个关停特征 + 短响应的 404/502/503
- `frame_blocked`：X-Frame-Options `DENY|SAMEORIGIN` 与 CSP `frame-ancestors 'none'|'self'` 判定
- `normalize_page_url`：缺协议补 https、主机必须像域名（「庆余年」这类词直接拒）

**pf-core::parse（网络编排）**：`parse.resolve` 一次完成归一 → 建链 → 取响应 → 挖直链 → 判内嵌，返回 `{kind: direct|page, playUrl?, candidates[], via: input|json|html|page, frameable, playerLike, latencyMs, note}`；失败按原因分类（超时 / 无法连接 / 已关停 / 空响应 / 已改版），不给「解析失败」这种无信息量的话。

**解析接口库**（`parse_services` 表，与 `catalog_sources` 同构）：`direct://` 是内置哨兵 = 零接口直连嗅探（不依赖任何第三方，长期有效）；其余 6 条为公开流传地址，**测活状态如实显示**（可用/失效/未测），支持新增、改名、停用、删除、批量导入、恢复预设。预设 `PRESET_VERSION=1`。

**桌面端**：

- 主进程 `sniff.ts`：独立内存分区 + 静音 + `backgroundThrottling: false` + `autoplayPolicy: no-user-gesture-required`；`onBeforeRequest` 抓 `.m3u8/.mp4/.flv/.mpd`（不抓 `.ts` 分片免噪声）、每 700ms 轮询 `video.currentSrc`、每 1.8s 尝试点击播放按钮；命中 m3u8 即返回，否则等超时取已有候选
- `pf:parse-open-window`：独立窗口打开播放页（共享 `persist:parse` 分区，登录态可复用），用于嗅探失败时人工兜底
- 渲染层 `ParseView`：接口下拉带状态点、地址输入、四动作（解析播放 / 内嵌播放 / 新窗口 / 接口管理）、16:9 舞台（iframe/进度/错误三态）、结果详情与候选直链切换、最近解析、接口管理抽屉
- IPC 错误信息去掉 `Error invoking remote method 'pf:rpc':` 前缀（用户不需要看传输层）

**验证结果**（2026-10-26）：

- Rust 单测：`cargo test` 全绿（parser 36 含 parseurl 7 / engine 28+1 ignored / proxy 11 / netdisk 11）
- P10 冒烟 `smoke-p10.mjs` **32/32**：预设播种、增删改与重复拒绝、JSON 直链、HTML 转义直链、播放页禁内嵌判定、关停识别、输入即直链不打接口、非法地址、直连嗅探、直链建任务走代理
- 真实窗口 E2E `e2e-p10.mjs` **24/24**：解析页工具条、新增三个假接口、直链解析自动切播放页起播、内嵌 iframe、独立窗口、**运行时拼出的 m3u8 被嗅探抓到并起播**、失效接口提示、清理还原
- 回归：P1–P6 46/46、P3 20/20、P4 17/17、P7 24/24、P8 14/14
- typecheck / build 全绿；截图 `.screenshots/p10-parse.png`

**边界**：解析能力完全取决于第三方接口与站点本身，界面只做「尽力而为 + 说清楚为什么不行」；接口内容由第三方提供，合规使用需自行确认。

### P12 磁力/BT 片源（✅ 2026-10-26 交付）

GYING 吸收清单里最后一项、也是工程量最大的一项：把磁力链接变成第五种片源。选型 **librqbit 9（纯 Rust BT 客户端）**——不需要 libtorrent 的 C++ 绑定与 MSVC 工具链，交叉编译和分发都更干净。

**为什么不做「边下边播」**：MP4 的 `moov` 常在文件末尾、MKV 的 cues 也在末尾，按顺序下载时播放器一 seek 就撞上还没到的字节。与其做一个「有时能播有时黑屏」的播放器，本版明确「下载完成后播放」，界面把进度、正片名、体积讲清楚。这是产品取舍，不是缺失。

**新增 crate `pf-magnet`**：

| 模块 | 内容 |
|---|---|
| `magnet.rs` | 纯逻辑：`normalize_magnet` 把 `magnet:?xt=urn:btih:`（40 位 hex / 32 位 base32）、裸 info hash、`.torrent` 地址统一成规范 URI；`pick_video_file` 选片（视频白名单 → 排除 sample/trailer/字幕/说明 → 体积 ≥10MB 优先 → 取最大）；自带 percent 编解码与 base32 解码，零新增轻量依赖 |
| `engine.rs` | 会话封装：`Engine::new`（显式开 TCP 监听、关 UPnP）、`add` / `add_with_peers`、`wait_metadata`（45s 上限）、`files`、`select_files`（`only_files`）、`stats`（归一成 camelCase 进度）、`file_path`、`pause`/`resume`/`remove`、`seed_file`（本地做种，专供离线测试）。`TorrentHandle` 是不透明句柄，上层不依赖 librqbit 类型 |
| `bin/pf-bt-seed` | 开发/测试用做种器：把本地文件做成种子并打印 `PF_BT_SEED_MAGNET` / `PF_BT_SEED_PEER`，让冒烟与 E2E **完全不依赖公网** |

**存储**（`pf-engine::magnet_store`，表 `magnet_tasks`）：id / url / info_hash / name / save_dir / status / error / total_bytes / done_bytes / file_index / file_name / file_len / file_path / files_json / created_at / updated_at。`files_json` 存种子内文件列表，供前端选集。

**RPC（`magnet.*`）**：

| 方法 | 语义 |
|---|---|
| `magnet.add` | `{url, onlyFile?, initialPeers?}` → 归一 → 去重（同 info_hash 直接复用）→ 落库 → 加入会话 → 立即返回（元数据后台等）；`initialPeers` 给内网/私有种子/测试直连，绕过 DHT 与 tracker |
| `magnet.list` | 全部任务（含 `files` 数组；进度每秒落库，前端 1.5s 轮询） |
| `magnet.files` / `magnet.select` | 看文件列表 / 换集（多集种子只下选中那集） |
| `magnet.pause` / `resume` / `remove` | 暂停 / 继续 / 删除（`deleteFiles` 连数据一起删） |
| `magnet.play` | 仅 `status=done` 时返回 `http://127.0.0.1:{port}/bt/{token}/{id}/{idx}`，未完成时报「还没下完（xx%）」而不是含糊失败 |

**代理层 `/bt/{token}/{task}/{idx}`**：直接按 Range 读磁盘上的正片（256KB 分块流式回包），不落缓存也不回源；内容类型按扩展名给（mp4/mkv/webm/avi/ts…）。路径里带 `idx` 只为让换集产生新 URL，真实路径一律以表里的 `file_path` 为准（避免 URL 里出现任意文件路径）。

**健壮性（均为实测暴露）**：

- **DHT 起不来不该瘫**：沙箱/防火墙下 `Session` 初始化会报 `error initializing persistent DHT`，原来直接让整个磁力功能不可用 → 改为降级成「无 DHT 会话」，tracker 与 `initialPeers` 仍可用。
- **`info_hash` 被空串覆盖**：元数据回填时把 hash 写成 `""`，导致「重复添加同一磁力」去重失效并触发 librqbit 的元数据发现失败 → SQL 改 `CASE WHEN ?3='' THEN info_hash ELSE ?3 END`。
- **重启后不要假装还在下**：会话句柄只在内存，重启后未完成任务标为 `paused` + 说明文案；**已下完的文件仍可直接播放**。
- **重复添加复用**：同 `info_hash` 已有非失败任务时直接返回原任务（`duplicated: true`）。
- **前端轮询不看 `hasActive`**：任务可能从别处产生（另一窗口 / 重启恢复），页面挂载期间就一直轮询。

**桌面端**：`stores/magnet.ts`（轮询/添加/暂停/继续/删除/选集/播放）+ `MagnetView.vue`（输入条、任务行、进度条、选集展开、状态徽章）+ 侧栏「磁力」入口 + `AppRoute` 与标题表。

**验证结果**（2026-10-26）：

- `cargo test`：parser 46 / engine 44 / proxy 11 / netdisk 29 / magnet 9 + 集成 1（本地做种→下载→字节一致）全绿
- `smoke-p12.mjs` **21/21**：非法地址拒绝、建任务立即返回、未下完不许播、下载完成、选片跳过 readme/sample、全量 200 字节一致、Range 206 与 Content-Range 正确、**重启后仍可播放**、重复添加复用、删除后 `/bt` 404
- `e2e-p12.mjs` **13/13**：侧栏入口、页面可见、空态、RPC 建任务、列表推进到「已完成」、进度条 100%、点播放切页、源指向 `/bt`、**播放器 readyState=4 且 currentTime 前进**（用 ffmpeg 生成的真 MP4，否则这条断言没有意义）、删除还原
- 回归：P1–P6 46 / P7 24 / P8 14 / P9 50 / P10 32 全绿；typecheck / build 全绿；截图 `.screenshots/p12-magnet.png`

**边界**：不做磁力搜索站（只处理用户粘贴的链接）；不做「边下边播」；下载中会按 BT 协议向其他 peer 上传分片（协议本身决定，无法只下不传）；种子内容由第三方提供，合规使用需自行确认。

### P14 弹幕（✅ 2026-10-26 交付）

> **编号说明**：`P11`/`P12`/`P13` 已被「追更巡检」「磁力/BT」「巡检间隔可配置」三批占用，弹幕这批取 **P14**（早期脚本 `smoke-p11.mjs`/`e2e-p11.mjs` 已改名为 `*-p14.mjs`）。

自查发现弹幕当时是 **0 代码**，故本批从零实现：**双路径渲染**（hls → Canvas，libmpv → ASS 字幕，见 §4.8）、弹弹play 源接入、本地存储与发送、设置页。

- **新 crate `pf-danmaku`**：`model.rs`（模型 / `sanitize_text` 按字符数校验 / `normalize_color` / `scale_time` / `make_id` / `dedup_sorted`）、`dandanplay.rs`（签名 / 剧集定位 / `p` 字段解析）、`ass.rs`（`TrackAllocator` 与前端同语义 + `build_ass` + RGB→BGR）、`lib.rs`（`SendGuard`：10 s 内容去重 + 1.5 s 间隔限流，被拒不占额度），**46 单测**
- **存储**：`danmaku` / `danmaku_channels` 两表；时间存**整数毫秒**、`PRIMARY KEY(channel, id)`（单列 id 会让跨频道相同 id 互相顶掉）、批量写单事务
- **RPC 15 个**：`settings.get/set`、`credentials.set/clear/test`、`open`、`channels`、`channel.clear/remove`、`match`、`fetch`、`list`、`send`、`ass`、`stats`；新增 `mpv.command`（`sub-add`/`secondary-sub-add` 是命令，`mpv.set` 改不了）
- **前端**：`danmaku/clock.ts`（双时钟）、`danmaku/track.ts`（轨道分配 + `selfTest()`）、`danmaku/engine.ts`（Canvas 引擎）、`stores/danmaku.ts`（裸数组 + `itemsVersion`）、`DanmakuLayer.vue` / `PlayerView.vue`（开关、发送栏、即时上屏、ASS 同步）/ `SettingsView.vue`（4 滑块、屏蔽类型、来源、凭据、已缓存频道）

**顺手修掉的基础设施缺陷**（影响所有 RPC 客户端，不只弹幕）：`pf-core` 的 `next_line_bounded()` 用裸 `read()` 绕过 `BufReader`，一次读到多行时丢弃第一行之后的所有行 —— 客户端把 `PF_AUTH` 首行与首个请求同包发出时请求永久丢失，表现为**随机超时**。改 `read_until(b'\n')` 并兼容 CRLF。

**验证结果**（2026-10-26）：

- Rust 单测全量 **151 通过**（pf_core 4 / pf_danmaku 46 / pf_engine 44 / pf_parser 29+1 ignored / pf_netdisk 11 / pf_magnet 9 / pf_proxy 7 / bt_local 1）
- 冒烟 `smoke-p14.mjs` **82/82**：设置夹取、凭据与签名（用 node `crypto` 独立验算）、频道缓存与 `force`、脏数据解析、发送限流去重、清理删除、ASS 顶/底标签、异常 6 类、并发（8000 条入库 + 20 并发拉取 5.6 s + 20 并发发送只放行 1）
- 真实窗口 E2E `e2e-p14.mjs` **28/28**：播放页 UI、画布位图尺寸、轨道自检、注入后读到 canvas 像素 32283px、500 条高密度 54718px 且单帧 0.57 ms、字号 1.8 → 轨道 19→10、发送即时上屏且不重复、mpv 层隐藏、ASS 生成、开关、设置页
- typecheck / build 全绿

**环境注记**：E2E 环境里 `requestAnimationFrame` 完全不投递（被遮挡/无头时 Chromium 停掉帧生产，`ResizeObserver` 回调跟着帧走也不投递）。E2E 因此改为「显式量尺寸 + `engine.step(n)` 同步出帧」，有帧/无帧两种环境下结论一致（`tick` 与 `step` 共用同一个 `frame()`）。

**边界**：ASS 路径做不了发光/渐变/图片弹幕，需要这些效果只能回到透明覆盖层窗口方案。候选列表 UI / 屏蔽词 / 本地导入已在 P15 收尾（见下）。

### P14b 弹幕收尾（✅ 2026-10-27 交付）

> **编号说明**：本批最初记为 `P15`，但 `P15` 已被「倍速播放 + 源站巡检一键停用」占用（`docs/P15-交付总结.md`），按 `P9b` 先例改为 **P14b**；脚本 `smoke-p15.mjs` 已改名 `smoke-p14b.mjs`。

P14 遗留项的落地，见 `docs/P14b-弹幕收尾-交付总结.md`：

- **候选匹配 UI**：`DanmakuLayer.vue` 新增候选面板 —— `no_match` 角标点击即搜（`danmaku.match`）并渲染剧集候选，点选后 `switchEpisode(episodeId)` 强制重拉。补了三点原本缺失的能力：**改关键词重搜**（`match` 新增 `query` 参数，原样送搜索不做归一化）、**`episodeNo` 显式指定**、**仅本地弹幕**；播放页控制条另加常驻「源」按钮，不必等自动匹配失败。
- **屏蔽词**：`DanmakuSettings.blockedWords`（清洗 = trim/去空/去重/超长丢弃，上限 200 词 × 50 字）；过滤在**内核出参侧**统一做（`fetch`/`list`/`ass` 三处 `filter_blocked`），库中全量保存 —— 改屏蔽词无需重拉，历史频道即时生效；设置页每行一词编辑，失焦保存后 **await** 重读当前频道（不 await 会让条数晚一拍跳变）。
- **本地导入**：`danmaku.import` RPC + `pf-danmaku/src/import.rs`（纯逻辑，17 单测）—— B 站 XML（手写扫描含实体反转义，不引 XML 库）与 JSON（`comments[].p/m` **及顶层数组/平铺字段**）按内容自动探测；坏条目跳过、`sanitize_text` 逐条净化、去重排序、8MB 上限、重复导入幂等（唯一约束吸收）；导入目标 = 当前播放频道（与在线弹幕并存），播放页发送栏「导入」按钮。
- **ASS 临时文件治理**：libmpv 每集生成一个 `<channelId>.ass`，按「保留最新 60 个 + 7 天」双限清理，**每次写完顺手跑一次**；`danmaku.cache.clean`（`keep:0` 即清空）+ `stats.assCache` 占用统计 + 设置页手动清理入口。只处理 `.ass`，不动目录里其他文件。
- **验证**：Rust 全量 **167**；`smoke-p14b` **25/25**；`smoke-p14` **113/113**（新增 J 段 31 条）；`e2e-p14` **43/43**（新增 15 条）；typecheck/build 全绿。

### P16 网盘 × 收藏体系打通（✅ 2026-10-27 交付）

P9b 网盘与 P7/P9 收藏/续播/追更管线的合流，见 `docs/P16-网盘收藏打通-交付总结.md`：

- **`netdisk.favorite.add` RPC**：目录收藏 = 剧集（翻页收集全部视频为剧集快照，cap 20 页 × 200），文件收藏 = 电影（先 `resolve` 预检可播）。快照 URL 用**稳定 shim URL**（nd_token 落库跨重启不变、proxy 自动换链），因此连播 / 进度上报 / 继续观看 / 追更全套复用既有管线，**播放器与 catalog 侧零特殊分支**。
- **同名归并**：`find_favorite_by_key(normalize(name)+year)` 天然跨源 —— 多账号 / 网盘与 CMS 站同名的目录自动合并为同一条收藏下的多个片源（`origin=netdisk`、`site_name=网盘·{provider}·{账号/分享名}`）；写入复用 catalog 的 `upsert_fav_source`（同收藏 + 同 api 引用去重，重复收藏幂等）。
- **网盘追更**：片源 `api` 引用形态 `netdisk:{owner}:{dirId}`，`favorite.refresh` / 后台巡检对 `netdisk:` 前缀走**重新列目录**回拉（`refresh_netdisk_episodes`），集数有增才回写快照 —— 网盘剧集目录与 CMS 站点享受同一套追更/巡检。
- **前端**：网盘页操作列「收藏」按钮（目录与视频均可见）；收藏后媒体库 / 继续观看 / 追更自动可见，无需任何额外入口。
- **验证**：`smoke-p16` **23/23**（独立数据目录防残留污染）；Rust 全量单测通过；回归 smoke 46/46、p7 24/24、netdisk 38/38；typecheck/build 全绿。调试插曲：RPC 方法名层级错位（`netdisk.favorite` vs handle 内 `favorite.add`）曾伪装成「编译产物不含新代码」的假象。

**本批 review 修掉的五个缺陷**（详见交付总结 §6）：① `detect_format` 的 `&content[..8192]` 在汉字中间切片会 **panic 崩内核**（中文文件必然命中）；② `import` 先过滤再入库导致被屏蔽弹幕**永久丢失**，与「出参过滤」原则自相矛盾；③ 屏蔽词变更后 `void reloadList()` 让条数晚一拍；④ 属性解析不支持单引号与 `=` 两侧空格；⑤ JSON 不认顶层数组。

### P17 弹幕高级特效：发光 / 渐变 / 图片 + mpv 透明覆盖层（✅ 2026-10-27 交付）

libass 表达不了图片弹幕、发光渐变也只是近似 —— mpv 内核的弹幕改走**透明覆盖层窗口**：透明无边框 BrowserWindow `parent` 挂主窗口（Windows owned window 恒浮在 owner 之上，连 mpv 的 `WS_CHILD` 视频表面一起盖住），覆盖层里跑与 hls 路径同一套 `DanmakuEngine`（Canvas 2D）。见 `docs/P17-弹幕高级特效-交付总结.md`：

- **特效语义**（`danmaku/fx.ts` 纯函数 + engine 绘制分支）：`glow` = 同色 shadowBlur 双重填充；`gradient` = 亮→主色→暗横向三停；图片弹幕 = text 是图片 URL（http(s) 扩展名白名单 / `data:image/*`）时 `drawImage`，异步解码完成后**热替换**已入屏的占位项并按真实宽高比重算布局。fx 白名单 `glow|gradient`，脏值双侧静默归普通。
- **数据**：`danmaku` 表加 `fx TEXT`（MIGRATIONS 补列）；`danmaku.send` 带 fx；出参 None 省略字段保持旧协议兼容；去重语义不变；ASS 导出忽略 fx（覆盖层关闭时 mpv 仍走 ASS，前端保证两路径互斥防双重弹幕）。
- **覆盖层**（`electron/main/overlay.ts`）：点击穿透 + focusable:false + skipTaskbar；尺寸恒 = 主窗口 contentBounds（事件 + 500ms 轮询双保险）；弹幕画布按主窗口上报的视频区矩形定位；时钟复用 `MpvInterpolatedClock` 直吃主进程转发的 `mpv.state`。IPC 三通道：`pf:overlay-cmd`（窗口命令就地消化 / 数据命令转发）、`pf:overlay-apply`、`pf:overlay-ready`（就绪重发全量 + 1.5s 竞态兜底）。
- **UI**：发送栏样式下拉（普通/发光/渐变）；设置页「mpv 高级特效弹幕」开关 → `DanmakuSettings.fxOverlay`（默认 false）。hls 内核不受开关影响（DOM Canvas 恒支持特效）。
- **验证**：Rust 全量 170 通过；`smoke-p17` 17/17；`e2e-p17` **像素级** 17/17（光晕包围盒/像素量、渐变左亮右暗、图片真画上 canvas、fx 落库链路）；回归 smoke-p14 113、p14b 25、p16 23、e2e-p14 43 全过；typecheck/build 全绿。

### P18 切页隐藏画面：离开播放页收起 mpv 视频表面，播放不停（✅ 2026-10-28 交付）

播放页是 `v-show` 保活的（切页不卸载、不断播），但 libmpv 的视频表面是 **Win32 子窗口**（`WS_CHILD`，父 HWND = 主窗口），只服 Win32 显隐、完全不吃 DOM 的 `display:none`。过去的隐式行为是「切页后 video-wrap 的 rect 变 0 → `mpv.move 0×0` → `move_window` 把尺寸夹到 `.max(1)`」，效果是留下一个 1×1 像素的子窗口，且回到播放页时矩形早被写坏，画面回不来。见 `docs/P18-切页隐藏画面-交付总结.md`：

- **显式显隐**：`MpvHost` 新增 `surface_visible: AtomicBool`（用户意图）+ `set_surface_visible()`；pf-mpv 内 `show()/hide()` 保持裸显隐语义（`stop()` 仍用它），`load()` 改为**按意图决定是否 show** —— 在别的页面上自动连播下一集时不会把窗口弹出来盖住当前页。
- **RPC `mpv.visible {visible}`**：返回 `{visible, attached}`；未 attach 时返回 `attached:false` 而不是报错（调用方是切页钩子，不该被未挂接状态打断）。
- **前端**：`player.surfaceWanted` 记意图（`setSurfaceWanted`）+ `mpvPushSurface()` 只落 RPC（意图与「当下该不该显示」分开）；`playMpv` 在 loadfile **之前**按意图校准一次（既防切页连播弹窗，也保证「停止后再播」能重新显示）；`PlayerView.applySurface()` 在 `route / engine` 变化时执行 —— 离开播放页 `SW_HIDE`，回来 `SW_SHOW` + 连补三拍（nextTick / 80ms / 320ms）重对齐矩形，且**只有真有内容**（`playing` 或 `eof`）才恢复画面，避免「停止后回来显示一块空黑窗口」。全程不 pause、不 stop。
- **矩形守卫**：`syncMpvRect()` 在 `route !== 'player'` 或 rect < 2px 时直接早退，不再把 0 矩形写进 `mpv.move`（这条 1×1 的老路是「画面回不来」的根）。
- **覆盖层同步收起**（P17 那条链路）：透明覆盖层是 owner 挂主窗口的独立顶层窗口，同样不吃 `display:none`；`DanmakuLayer` 增 route 监听，离开时 `overlayEnabled(false) + overlayHide()`，回来 `syncOverlay()` 全量重推。
- **验证**：`e2e-p18` **14/14**（真窗口 + 真播放 + Win32 `IsWindowVisible`/`GetWindowRect` 取证）：切页后子窗口不可见而 `time-pos` 1.20s → 5.20s 继续走、`pause=no`；回来窗口恢复且矩形 891×501 与视频区完全一致、继续播到 7.67s；按「停止」再切页回来不留空黑窗口。另有 `mpv.visible` RPC 冒烟 6/6。typecheck / build / release 内核编译全绿。

### P19 片源内容缓存：把「已经获取过」的片源数据留住（✅ 2026-10-28 交付）

P2.5 的分片缓存只管**播放载荷**（`.bin` 分片）；片源**元数据**此前每次都要重新扇出：同一个关键词再搜一遍要打全部源站，翻回上一页要重打一遍，源站一挂历史结果连影子都不剩。本批新增一层 `src_cache`（SQLite 单表多 kind），统一收口搜索/分类/详情 JSON、TMDB 命中对象、海报二进制与 P10 解析出的可播直链。见 `docs/P19-片源缓存-交付总结.md`：

- **存储**（`pf-engine::srccache`）：`src_cache(kind,key,body BLOB,bytes,stored_at,expires_at,hits,last_hit_at)` 主键 `(kind,key)`；`src_cache_stat(kind,hits,misses,stale_served)` 因为**未命中没有行可计数**，命中率必须单独记。kind 取值 `search|category|detail|tmdb|poster|parselink`。单条上限 4MB（超限直接不入库）。
- **TTL 只判新鲜度，不删数据**：过期行仍是「旧值」，网络失败时可回退（stale-while-revalidate），这是离线可用性的根；真正删除交给 `prune`（过期超 7 天）+ 容量 LRU（按 `COALESCE(last_hit_at, stored_at)` 升序淘汰到 80% 水位，命中即续命）。维护动作节流 15s，不必调用方控频。
- **读法约定**（`pf-core::srccache`）：`peek_fresh`（新鲜命中直返）→ 未命中回源 → 失败且 `offlineFallback` 开放时 `peek_stale`（记一次 `stale_served`）。聚合类出参带 `cache: {fromCache, stale, total, failed, oldestMs}`，前端据此在「发现」页标一行「N 个源站命中本地缓存（X 分钟前）」或告警色「M 个源站暂不可达，正在显示 X 前缓存的内容」。
- **接入点**：`catalog.search`（按 `api|q`，detail 空则回退 videolist，空结果不写缓存避免把空列表固化一个 TTL）、`catalog.category`（`api|pg|hours`；大类/年份/地区是本地过滤，不进 key）、`catalog.detail`（`api|vodId`，追更巡检复用同一条）、TMDB（`name|year` 落盘替换原进程内 `pop_cache`，重启后热门榜不再重打 30 次）、`/pic` 海报（命中直接回字节 + `x-pf-cache: hit`，图床挂了回退旧图，content-type 按魔数还原，不回存响应头）、`parse.resolve`（`pageUrl|api` 只缓存直链，**不回退过期直链** —— 签名链过期会让播放器报误导性错误）。
- **失效**：删源站按其 `api|` 前缀清 search/category/detail；删解析接口清空 parselink（key 的 api 在尾部无法前缀匹配，且总量与 TTL 都很小）。
- **策略**（`src_cache` settings 键 `srccache.*`）：搜索 10min / 分类 5min / 详情 30min / TMDB 24h / 海报 7d / 解析直链 10min / 容量 64MB / 回退开；`config.get|set_src_cache_policy` 读写，入参逐项夹取（`ttlSearchMin` 2–1440、`capacityMb` 8–4096 …）。设置页「片源内容缓存」区块给出占用、条目、命中率、降级次数与按类清理。
- **测试钩子**：`PF_SRC_CACHE_TTL_MS` 把全部 TTL 压成同一毫秒数 —— 否则「过期→回退」这条路径要等 2 分钟起步，CI 无法验证。
- **验证**：Rust 单测 +7（fresh/expiry、超限拒绝、命中与未命中计数、前缀失效与按类清空、LRU 淘汰、prune 保留窗口、策略往返与夹取）；`smoke-p19` 覆盖搜索/详情/海报/直链四类命中、零回源、过期回退、关闭回退、统计、按类清空、策略夹取、删源站连带失效；typecheck / build / release 全绿。

### P20 播放页信息侧栏：把起播上下文带进播放页（✅ 2026-10-30 交付）

P9 的选集起播只把「某一集的 URL」送到播放页：弹层里的简介、年份、来源与整屏剧集一进播放页就没了，想换第 8 集得回发现页重搜。本批把**起播上下文**沿链路带过去，并让它成为新的选集入口。见 `docs/P20-播放页信息侧栏-交付总结.md`：

- **`PlayContext`（`stores/catalog.ts`）** 是起播方写给播放页的**快照**：`title/subtitle/poster/content/year/typeName/remarks/actor/director/siteName/api/vodId/groups/groupIndex/favoriteId/startedAt`。不让播放页按 `api+vodId` 回源，是因为收藏/网盘/直链三种起播根本没有 api，而起播方手里现成有全量信息；`contextFromDetail()` / `favoriteContext()` 统一来源差异。
- **选集语义**：`playAt(index, force?)`（同集且正在播放时返回 false → 调用方转 `resumeCurrent()` 直接续播，**不重建任务**，重建会丢进度）、`switchPlayGroup(gi)`（换线路按**集名**对齐，尽量停在同一集）、`playNext()` 退化为 `playAt(queueIndex+1, true)`；`playFavoriteEpisode` 的单集分支也走 `playFromQueue`（队列长度 1），保证侧栏与连播语义一致。
- **进度**：切集/换线路前 `flushProgress()` 立刻落库并更新节流时间戳（否则「看到 41:30 换集」会被 5s 节流吞掉最后几秒）。侧栏进度条每拍都跟，不受上报节流影响。
- **布局**：`.player-view` 用 **grid + grid-template-areas**（`player/side/debug`），不是两层 flex —— 窄屏要的是「侧栏在播放器之后、调试面板之前」，flex 只能排到整列之后。`side-collapsed` 把第二列压到 56px（播放区 872→1138px）。
- **收起形态**：56px 竖条 = 展开按钮 + 迷你海报 + `writing-mode: vertical-rl` 竖排片名 + `2/12` 集序徽章；窄屏（≤900px）压成一行摘要。状态落 `localStorage['pf.playerSide']`，默认 `innerWidth ≥ 1180` 才展开。
- **上下文失效**（谁会把侧栏写脏）：解析页/首页演示 → `setLooseContext(title,'解析直链'/'演示片源')`；网盘在线播放/磁力 → `setLooseContext(文件名, provider)`；媒体库/任务页/网盘加入任务 → 播放页 watch `sourceTaskId`（新任务 url ≠ 当前队列集且标题不同才覆盖）；手输 URL 播放 → `clearQueue()` 回空态。**空态**（从没播过）与**无剧集**（正在放直链）是两种文案，不可混用。
- **mpv**：侧栏收缩改变视频区宽度，`ResizeObserver` 之外在 `setSide()` 里补一拍（nextTick + 120ms）重推 `mpv.move`，防首帧旧矩形。
- **验证**：`e2e-p20` **27/27**（真窗口 + CDP 取 DOM 矩形 + 3 张截图）：展开态 336px 在右、12 集仅 1 个 active、2 线路 chip、`第 2/12 集`；收起 56px 且播放区变宽 266px；点第 4 集 `queueIndex=3`；切第 2 线路 `groupIndex=1` 且仍停在第 4 集；760px 侧栏落到视频区下方且同宽；直链上下文与空态文案各自正确。typecheck / build 全绿。

### P23 窗口状态持久化：位置 / 尺寸 / 最大化跨启动还原（✅ 2026-10-30 交付）

主窗口状态写 `userData/window-state.json`（`PF_WINDOW_STATE` 可覆盖），`close` 时同步 flush，move/resize 走 400ms 节流。见 `docs/P23-窗口状态持久化-交付总结.md` 与 `apps/core/scripts/e2e-p23.mjs`（34/34）：

- **模块**：`electron/main/window-state.ts` —— `loadWindowState()` / `saveWindowState()` / `trackWindowState()`；读失败（缺失 / JSON 坏 / 字段非法 / 路径是目录）回落默认值，写失败（目录不可写 / 父路径是文件）只 `console.warn`，绝不阻断启动退出。写入走「`.tmp` + `rename`」原子替换。
- **还原顺序**：`show:false` 建窗 → `ready-to-show` 里「先 `maximize()` 再 `show()`」，最大化赶在首帧前，不闪普通尺寸；另加 3s 兜底 `show()`（防页面异常时窗口不露面）。
- **Windows 两个语义坑**：① 最小化后 `isMaximized()` 会变 false，采信它就丢掉「本来是最大化」——最小化期间沿用上次已知值；② 最大化时 `getBounds()` 是铺满屏幕的矩形，必须用 `getNormalBounds()` 存还原尺寸，否则越开越大。
- **越屏保护**：`fitBounds()` 先收敛脏数据（`MIN`/`MAX_SIZE`），再找重叠 ≥80px 的那块屏；原副屏拔掉 → 回默认居中；找到则压尺寸进工作区并把左上角拉回可见区（标题栏必须露出来）。
- **最小化只记录不还原**：`window-state.json` 里如实记 `minimized:true`，但下次启动按正常窗口显示 —— 启动即最小化会让用户以为应用没起来。
- **验证**：`e2e-p23` **34/34**，7 次启动、Win32 取证（`GetWindowRect` / `GetWindowPlacement.showCmd` / `SetWindowPos` / `WM_CLOSE`）：默认 1280×800 → 移到 1000×700 未退出即落盘 → 重启精确还原 → 最大化落盘 `maximized:true` 且 normal bounds 未被污染 → 重启即最大化 → 最小化落盘但下次仍可见 → 损坏/不可写/不可读三种容错全部照常启动退出。
