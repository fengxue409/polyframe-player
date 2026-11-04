# P9b 交付总结：网盘视频源插件（2026-10-26）

> 需求：接入主流网盘（百度网盘 / 阿里云盘 / OneDrive 等）的**分享链接**或**授权账号**，解析其中的视频文件列表，实现在线播放或加入播放源，并处理授权鉴权、文件列表分页加载、播放链接有效期刷新；保持与现有视频源架构兼容，做成可扩展的网盘源插件模块。
>
> 本批交付：新增 `pf-netdisk` 插件 crate（4 家适配器）+ 网盘账号/分享持久化 + `/nd` 鉴权流式路由 + 15 个 `netdisk.*` RPC + 桌面端「网盘」页（无头冒烟 **38/38** 全绿）。
>
> **编号说明**：本批与 `P9 影视发现闭环（吸收 GYING）` 为**并行交付的两批**，同一时间窗，故记为 **P9b**；代码注释中的「P9b 网盘…」均指本批。与 `P10 第三方云解析` 无重叠。

---

## 1. 功能总览

| 能力 | 入口 | 说明 |
|---|---|---|
| 授权账号接入 | 网盘页「添加账号」 | 三种授权形态自适应：百度 **Cookie**（须含 `BDUSS=`）、阿里云盘 **refresh_token**、OneDrive **设备码 OAuth**；HTTP 目录网关走 **Bearer token** |
| 分享链接接入 | 网盘页「分享链接」 | 粘贴分享文本/链接（含「链接 + 提取码」混排）自动识别网盘、提取 shareId 与提取码；`canBrowse=false` 时明确提示「需先转存」（百度） |
| 目录浏览（分页） | 右栏目录表 | 面包屑导航、进入子目录、上级、刷新、**加载更多**（游标式，到底自动收起）；条目按扩展名归类（video/audio/image/other），只有 video 可播 |
| 在线播放（不建任务） | 行内「播放」 | 解析直链 → 生成 shim URL → 交给播放器；直链有效期与注入头数实时展示 |
| 加入播放源（建任务） | 行内「加入」 | 走**完整下载管线**（4MiB 分块 + 缓存三档 + 水位调度），返回 task，任务页可见进度 |
| 账号续期 / 移除 | 账号卡片 | 手动 `refresh` 续期并回写过期时刻；移除账号级联失效其名下直链缓存（分享记录保留） |
| 直链自动续期 | 全程无感 | 余量 <60s 视为过期提前换链；proxy 回源遇 401/403/410 强制换链重试一次 |

---

## 2. 架构与代码结构

```
pf-core (RPC 编排)
  └─ netdisk.rs            358 行   netdisk.* → NetdiskService，camelCase 出参 + 脱敏 + shim URL 生成
pf-engine (调度/持久化)
  ├─ netdisk.rs            472 行   账号加载 → 续期 → prepare → 目录/直链编排，错误归类与状态回写
  └─ netdisk_store.rs      279 行   netdisk_accounts / netdisk_shares CRUD，shim_token 落 settings
pf-proxy (唯一播放边界)
  └─ /nd 路由              ~200 行  owner 解析 → 直链缓存 → 注入头 → Range 透传 → 401/403 换链重试
pf-netdisk (插件 crate，纯 HTTP + 纯逻辑)
  ├─ lib.rs                376 行   Provider 契约 + 数据类型 + 单例注册表 + 错误模型
  ├─ http.rs               437 行   通用 HTTP 目录网关（契约基准）+ 共用 HTTP 原语
  ├─ onedrive.rs           367 行   设备码授权 / Graph children / @odata.nextLink
  ├─ aliyun.rs             305 行   refresh_token 续期 / marker 分页 / get_download_url
  ├─ share.rs              217 行   三家分享链接解析 + base64url（4 单测）
  ├─ baidu.rs              197 行   Cookie 鉴权 / 页码分页 / filemetas dlink
  └─ link.rs               134 行   LinkCache + 60s 提前过期判定（3 单测）
桌面端
  ├─ stores/netdisk.ts     458 行   账号/分享/目录分页/播放/设备码全状态
  └─ NetdiskView.vue       520 行   左栏账号+分享，右栏目录表
冒烟
  └─ smoke-netdisk.mjs     477 行   假网关 + 十个分组 38 项断言
```

### 2.1 Provider 契约（对象安全，零 async_trait）

```rust
pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait Provider: Send + Sync {
    fn kind(&self) -> ProviderKind;
    fn name(&self) -> &'static str;
    fn auth_modes(&self) -> Vec<AuthMode>;                  // cookie | token | deviceCode
    fn supports_share(&self) -> bool;                       // 默认 false
    fn prepare<'a>(&'a self, cred: &'a mut Credentials) -> BoxFut<'a, Result<bool, String>>;
    fn verify<'a>(&'a self, cred: &'a Credentials) -> BoxFut<'a, Result<(), String>>;
    fn list<'a>(&'a self, cred, dir_id: &'a str, cursor: Option<&'a str>, page_size: u32)
        -> BoxFut<'a, Result<Page, String>>;
    fn resolve<'a>(&'a self, cred, file_id: &'a str) -> BoxFut<'a, Result<PlayTarget, String>>;
    fn refresh<'a>(&'a self, cred) -> BoxFut<'a, Result<Credentials, String>>;
    fn device_auth / poll_device_auth ...                   // 默认返回「不支持」
    fn list_share / resolve_share ...                       // 默认返回「请先转存」
}
```

适配器为 `&'static dyn Provider` 单例（`OnceLock`），无堆分配、无全局可变状态；crate 内**不碰 SQLite、不做持久化**，只把网盘语义翻译为 `Page` / `PlayTarget`。

### 2.2 稳定 shim URL —— 零改造复用的关键

```
http://127.0.0.1:{proxyPort}/nd/{nd_token}/{owner}/{fileId}/v.mp4
                                          owner = a-{accountId} | s-{shareId}
```

- 尾部恒为 `.mp4` → `pf_parser::detect` 判为 MP4 直链 → 直接落入 `build_mp4_ir` 的 4MiB 分块 + `/file` 虚拟文件 Range + 缓存三档 + 水位调度。**pf-engine 的下载/缓存代码与播放器一行未改**（本批只在 engine 增加「网盘存储 + 服务门面」两个模块）。
- `nd_token` **独立于 proxy `token`**：proxy token 每次启动轮换，而 shim URL 会被写进任务 URL 需跨重启稳定，故单独一枚长期密钥并落 `settings` 表；`nd` 已在 proxy 路径黑名单内，owner/fileId 段严格校验，fileId 逐字节 percent-encode（仅放行 `A-Za-z0-9-_.~!$`，兼容阿里云盘 `!`、百度 `$` 类 id）。

---

## 3. 三家网盘的差异收敛

| 维度 | 百度网盘 | 阿里云盘 | OneDrive | HTTP 目录网关 |
|---|---|---|---|---|
| 鉴权 | Cookie（`BDUSS=`），需 `User-Agent: pan.baidu.com` + Referer | refresh_token → access_token，首列派生 `drive_id`/`user_id` 并回写 | OAuth 设备码 → access/refresh，Graph Bearer | Bearer token |
| 列表 | `/api/list?dir=&page=` + `has_more` | `/v2/file/list` + `marker` | `/me/drive/root/children` + `@odata.nextLink` | `/api/list?dir=&cursor=&size=` |
| 游标形态 | 页码 | marker 字符串 | 完整 nextLink URL（**只跟随 `graph.microsoft.com` 前缀**，防凭据外泄） | 服务端自定义 |
| 直链 | `/api/filemetas?dlink=1`，按 6h TTL 保守处理 | `get_download_url`（`expire_sec=900`） | `@microsoft.graph.downloadUrl`（55min） | `/api/resolve` 返回 `url/expiresAt/headers` |
| 必需请求头 | `User-Agent` + `Referer: pan.baidu.com` | `Referer: aliyundrive.com` | 无（URL 自带签名） | Bearer + 网关附加头 |
| 分享链接 | ✗ 需先转存（`supports_share=false` + 可读提示） | ✓ `get_share_token` + `get_share_link_download_url` | ✓ `/shares/{id}/driveItem(/children)`，子项借 `parentReference.driveId` | ✗ 网关自处理 |

**设计取舍**：把「每家都不一样」的地方全部关在 `pf-netdisk` 内 —— 上层（引擎 / 代理 / RPC / UI）只见 `Page` 与 `PlayTarget`。坏一家不影响其余，新增一家只需实现 trait + 注册一行。

---

## 4. 关键机制

### 4.1 授权鉴权

- `auth_modes()` 决定 UI 渲染哪种录入表单，`hint` 提供占位提示；HTTP 网关的 `refreshToken` 兼作 `access_token`（弱契约兼容）。
- `account.add` **先 `verify()` 再入库**：校验失败直接返回「X 授权校验失败：…」，不留脏账号（冒烟 B 组断言「错误 token 不入库」）。
- 登录态续期：`NetdiskService::ctx_for` 加载账号时以 60s 余量判定 `token_fresh()` → `refresh()` → `prepare()` 重派生（如阿里云盘 drive_id）→ 落库；认证类错误把账号置 `expired` 并回 `needReauth=true`，UI 显示「需重新授权」徽章。
- 凭据脱敏：账号出参只有 `id/provider/providerName/name/status/lastError/expiresAt/createdAt/lastUsedAt/needReauth`，**Cookie 与 token 永不出内核**。

### 4.2 分页加载

统一游标式 `Page{items, next_cursor, total}`，`next_cursor = None` 即到底；`pageSize` 缺省读 `settings`（默认 100，clamp 1..=200）。前端 `loadDir(dirId, cursor)` 首屏与 `loadMore()` 追加分两次；进入子目录/切面包屑重置游标。

### 4.3 播放链接有效期刷新（三层）

1. **解析层** — `resolve()` 每次向网盘换新链，结果按 `owner|fileId` 写入 `LinkCache{PlayTarget{url,headers,expires_at,ext}}`；分享与账号天然隔离。
2. **判定层** — `LINK_SKEW_MS = 60_000`：剩余有效期不足 60s 即视为过期，**提前**换链，避免「起播瞬间刚好失效」。
3. **容错层** — proxy 回源遇 `401 / 403 / 410` 强制 `resolve(force=true)` 换链并重试**一次**，仍失败则按 `NetdiskError.kind` 分类回传（不吞异常）。

配套：`LinkCache` 超 512 条整体清空；删账号/删分享按 `invalidate_prefix` 失效其名下全部直链。RPC `netdisk.resolve` 主动解析并回 `{url, expiresAt, expiresInSecs, headerCount, ext, host}`，播放前即可看到「链接已就绪 / 几分钟后自动续期」，而不是等播放器 502。

### 4.4 分享链接解析（纯逻辑，4 单测）

| 形态 | 归一结果 |
|---|---|
| `pan.baidu.com/s/1abc`、`?surl=xyz`（自动补 `1` 前缀）、「链接: … 提取码: abcd」混排 | `ShareRef{provider: baidu, share_id, pwd}` |
| `aliyundrive.com/s/xxx`、`alipan.com/s/xxx` | `provider: aliyun` |
| `1drv.ms/…`、`onedrive.live.com/…`、`sharepoint.com/…`、`1drv.com/…` | `provider: onedrive`，编码为 `u!base64url(url)`（无填充） |
| 其他 | 报错：「暂不支持该分享链接（支持：百度网盘 / 阿里云盘 / OneDrive）」 |

### 4.5 错误分类

`NetdiskError{kind: unauthorized | not_found | rate_limited | unsupported | network | other}`，UI 据此给可操作提示（重新授权 / 稍后重试 / 该文件不可播 / 请先转存），而不是笼统的「解析失败」。

### 4.6 实现中修正的问题（值得记录）

- **`/api/resolve` 未回带 Bearer**：假网关 `/dl` 也要求鉴权 → shim 拿到 401（20B 错误体）→ 后续 502 连锁失败，冒烟首轮 19/28。修法：`http.rs` 的 `resolve` 直链请求**同样带网盘凭据**，再叠加网关显式下发的附加头（同名头以直链所需为准）。
- 断言写错（带 Range 时源返回 206，却按 200 断言）→ 改为 `status === 206`，第二轮 37/38，第三轮 38/38。
- Rust 借用问题：`query_map` 临时值生命周期不足 → 先 `collect()` 再返回；`find_netdisk_share_by_sid` 改用 `query_row(...).optional()`。
- debug 模式 `cargo test` 报 `target/debug/.cargo-build-lock 拒绝访问` → 统一 `cargo test --release`。

---

## 5. RPC 与数据模型（增量）

```
netdisk.providers                     → { providers: [{ kind, name, authModes[], supportsShare, hint }] }

netdisk.account.list                  → { accounts: AccountView[] }
netdisk.account.add    { provider, name?, cookie?, accessToken?, refreshToken?, baseUrl?, clientId? }
                                      → { account, probe: { ok, latencyMs, error } }
netdisk.account.refresh { id }        → { account }
netdisk.account.remove  { id }        → { removed }

netdisk.auth.begin { provider, clientId? }
                                      → { deviceCode, userCode, verificationUri, intervalSecs, expiresIn, message }
netdisk.auth.poll  { provider, deviceCode, clientId?, name? }
                                      → { pending: true, message } | { pending: false, account }

netdisk.list { accountId?|shareId?, dirId?, cursor?, pageSize? }
                                      → { items: NetdiskItem[], nextCursor, total, dirId }
netdisk.resolve | playUrl { accountId?|shareId?, fileId }
                                      → { url, expiresAt, expiresInSecs, headerCount, ext, host }
netdisk.play { accountId?|shareId?, fileId, name?, cacheMode? }  → { task }

netdisk.share.list                    → { shares: ShareView[] }
netdisk.share.parse { url }           → { provider, providerName, shareId, pwd, canBrowse }
netdisk.share.add   { url, pwd?, accountId? }  → { share, items, nextCursor }
netdisk.share.remove { id }           → { removed }
```

`AccountView` = `{id, provider, providerName, name, status, lastError, expiresAt, createdAt, lastUsedAt, needReauth}`（**无 cred**）。
`NetdiskItem` = `{id, name, isDir, size, modifiedAt, kind, ext}`，`kind ∈ dir|video|audio|image|other`。

存储（随 `CacheStore::open` 建表，全新表无迁移）：

```sql
netdisk_accounts(id TEXT PK, provider, name, cred /*JSON 整段*/, status /*ok|expired|error*/,
                 last_error, expires_at, created_at, last_used_at)
netdisk_shares(id TEXT PK, provider, account_id, share_url, share_id, pwd, title, created_at)
CREATE INDEX idx_netdisk_shares_account ON netdisk_shares(account_id);
```

- 凭据不建列、整段 JSON 落库：各家字段差异（cookie / token / drive_id / base_url / extra）不引起 schema 迁移。
- `shim_token()` 复用 `settings` 表（键 `netdisk_shim_token`），首次启动生成，此后恒定。

---

## 6. 桌面端

- **导航**：`SideNav` 加「网盘」（云图标）；`AppRoute` 加 `'netdisk'`；`App.vue` 用 `v-show` 保活 —— 切到播放页再回来目录位置与滚动都不丢。
- **`NetdiskView`**：
  - 左栏三卡：① 账号列表（网盘名/自定义名、状态徽章 `ok|expired|error`、过期时刻、续期、删除）② 添加账号（按 `authModes` 渲染 Cookie / Token / 网关地址 / client_id，设备码面板含 `user_code` + 跳转按钮 + 轮询倒计时）③ 分享链接（输入框 + 提取码 + 分享列表）。
  - 右栏：面包屑 + 上级/刷新 + 目录表（名称 / 大小 / 修改时间 / 操作）+ 直链信息条（有效期、注入头数、主机）+ 加载更多 + 空态提示。
- **`stores/netdisk.ts`**：`loadAll / pickAccount / openShare / loadDir / loadMore / reload / enterDir / goPath / goRoot / playNow / addAsTask / beginDevice / pollDevice / cancelDevice / addAccount / refreshAccount / removeAccount / addShare / removeShare`；`playNow` **不建任务**（直接给 shim URL 起播），`addAsTask` 才走引擎。
- **超时**：main 侧放宽 `netdisk.list 45s / account.add 45s / share.add 60s / play 60s`（阿里云盘首屏常 1–3s，默认 10s 偏紧）。

---

## 7. 验证结果

| 项 | 结果 |
|---|---|
| Rust 单测 `cargo test --release` | 全绿（engine 36 / **netdisk 11** / proxy 7 / parser 28+1 ignored） |
| P9b 冒烟 `smoke-netdisk.mjs` | **38/38**（全本地假网关，不依赖真实网盘） |
| 回归 | P1–P6 46/46、P7 24/24、P8 14/14、P9 28/28、P10 32/32 |
| `pnpm -r typecheck` | 通过（shared tsc + desktop tsc + vue-tsc） |
| `pnpm -r build` | 通过（electron-vite 三端） |

**冒烟分组**（假网关提供 2+2+1 分页、短命签名 `sig-N`、可主动作废、Range 206、`X-Gw-Header` 注入校验、`refreshHits/resolveHits` 计数）：

| 组 | 项 | 断言要点 |
|---|---|---|
| A 能力/分享 | 4 | 4 家适配器暴露、能力字段完整、三家分享识别 + 提取码、未知链接报错 |
| B 鉴权 | 4 | 错 token 不入库并报错、正确 token 入库回显延迟、出参不含凭据、列表可读 |
| C 分页 | 7 | 首页 2 + nextCursor、第二页 2、第三页 1 到底、归类（目录/视频/其他）、名称大小回带、秒→毫秒归一、子目录独立列举 |
| D 播放地址 | 4 | shim 形态 `/nd/…/v.mp4`、有效期回带（>60s）、注入头数、直链主机 |
| E shim 透传 | 5 | 无 Range → 200 且字节一致、内容一致、provider 头已注入（Bearer + 自定义头）、带 Range → 206 + Content-Range、区间字节正确 |
| F 直链缓存 | 1 | 重复播放不重复换链（resolve 计数不变） |
| G 过期换链 | 2 | 直链作废后 shim 仍可播（206 + 正确字节）、换链计数 +1 |
| H 加入任务 | 5 | `protocol=mp4`、`playUrl` 指向 `/file/`、标题用文件名、`segTotal=1`、`/file` Range 字节与源一致 |
| I 续期 | 2 | 续期回源并回写新过期时刻、状态复位 `ok` |
| J 边界/清理 | 4 | 分享不支持给可操作提示、缺 owner 报参数错误、缺 fileId 报参数错误、删账号后列表清空 |

---

## 8. 打包与依赖

- `pf-netdisk` 是**纯 Rust crate**，编译进 `pf-core.exe`，**不新增运行时依赖、不新增 DLL**（与 P8 一致）；electron-builder 配置无需改动。
- 新增依赖仅 workspace 已有的 `serde/serde_json/reqwest/tokio/chrono`；reqwest 补开 `json` feature（`RequestBuilder::json`）。
- 发布前仍按既有顺序：`cargo build --release` → `pnpm -r build` → `pnpm --filter @polyframe/desktop dist`。

---

## 9. 后续方向（未排期）

- **真实账号联调**：三家网盘凭据需各自申请/登录，当前验证以 HTTP 目录网关契约 + 假网关全覆盖；真实联调应补「风控限流（`rate_limited`）」「大目录翻页耗时」两项观测。
- **百度分享转存**：`share/verify` + `transfer` 接口可打通「分享即播」，需处理验证码与频率限制。
- **阿里云盘分享分页优化**：分享目录首屏较慢，可加本地目录快照缓存。
- **收藏/续播打通**：把网盘目录里的文件加进媒体库收藏与继续观看（复用 P9 的 `watch_progress`）。
- **上传/秒传**：本批只读，写能力不在需求内。
- **多账号同名文件合并**：跨网盘按文件名+大小归并成 `SourceGroup`（引擎已支持多镜像，缺上层入口）。
