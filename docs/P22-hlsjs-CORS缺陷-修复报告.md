# P22 · hls.js `manifestLoadError` 缺陷修复报告

> 现象：播放页报 `hls.js 错误 [networkError]: manifestLoadError`
> 结论：**本地代理的清单响应缺 `Access-Control-Allow-Origin`**，被浏览器 CORS 拦掉。与源站、与内核下载能力都无关。
> 影响面：hls.js 是默认内核（`player.ts` `engine: 'hls'`），因此**每次用 hls.js 起播 HLS 都会失败**；mpv 内核不受影响（不走 XHR）。

## 1. 复现

### 1.1 响应头对照（`node check-cors.mjs`）

```
--- media playlist（hls.js 第一跳）   200  acao=(缺失)  ctype=application/vnd.apple.mpegurl
--- master playlist（mpv 入口）       200  acao=(缺失)  ctype=application/vnd.apple.mpegurl
--- segment（对照）                   200  acao=*       ctype=video/mp2t
--- OPTIONS 预检                      405  acao=(缺失)
```

修复前：清单 200、分片 200 —— 服务端一切正常，唯独清单一侧没有 CORS 头。

### 1.2 浏览器侧（`node e2e-cors.mjs`）

对照组的 Chromium 原始报错，与用户所见完全一致：

```
networkError / manifestLoadError
A network error (status 0) occurred while loading manifest
Access to XMLHttpRequest at 'http://localhost:2061/nocors.m3u8' from origin
'http://127.0.0.1:2061' has been blocked by CORS policy:
No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

`status 0` 是关键特征：请求根本没到「看状态码」这一步，是浏览器在 CORS 检查就掐断了。

## 2. 根因

renderer 页面与代理**天然不同源**：

| 运行形态 | renderer 源 | 代理源 |
|---|---|---|
| `pnpm dev` | `http://localhost:5173` | `http://127.0.0.1:<随机端口>` |
| 打包安装 | `file://`（Origin 为 `null`） | 同上 |

hls.js 用 XHR/fetch 拉清单，跨源必须有 `Access-Control-Allow-Origin`。

`apps/core/crates/pf-proxy/src/lib.rs` 里 CORS 头只写在 `bytes_response()`（分片走这里），
而 `playlist()`、`playlist_response()`（`master.m3u8` 与 `raw` 都走它）、`/file` 的 206、
`pic_response()` 都是各自手搓 `Response::builder()`，**一个都没带**。

因此症状极具迷惑性：**分片能下、清单拉不到**。后端日志里全是 200，只有浏览器控制台看得见失败。

次生问题：`handle()` 只放行 GET/HEAD，OPTIONS 落到 `405 method not allowed`，
hls.js 带 `Range` 请求时的预检必然失败。

## 3. 修复

### 3.1 内核：CORS 收口到入口（`pf-proxy`）

- 新增 `with_cors()`，在 `handle()` 出口统一注入：
  `access-control-allow-origin: *`、
  `allow-methods: GET, HEAD, OPTIONS`、
  `allow-headers: range, if-range, accept, content-type`、
  `expose-headers: content-length, content-range, accept-ranges, etag, last-modified`。
- `handle()` 前置拦截 `OPTIONS`，返回 `204` + 同一组头。

好处是**新增路由不必再各自记得加头**——这正是本次缺陷的成因。

安全性：代理只监听 `127.0.0.1`，路径里的 token 每次启动随机轮换，外部页面无从猜起；
分片路径原本就是 `*`，口径一致。

### 3.2 前端：报错可读 + 自动恢复（`stores/player.ts`）

原来 fatal 直接 `playerError = hls.js 错误 [type]: details`，用户既看不懂也没有挽救手段。

- 新增 `describeHlsError()`：`manifestLoadError` → 「片源清单加载失败：源站无响应、被限流或该线路已失效，建议换源后重试」；`mediaError` → 建议切 libmpv 内核。
- fatal 不再直接判死：`networkError` 退避重试 `startLoad()` 最多 2 次，`mediaError` 调 `recoverMediaError()` 最多 2 次，仍失败才展示错误。

## 4. 验证

| 项目 | 结果 |
|---|---|
| `node e2e-cors.mjs`（真实 Chromium 45，跨源） | **PASS**：对照组 `fatal / manifestLoadError`，正例 `playing / t=0.32s` |
| `node e2e-cors.mjs <真实采集站片源>` | **PASS**：正例 `playing / t=0.37s`（`vip.dytt-tvs.com` 553 分片清单） |
| `node smoke-p21.mjs` | **12 / 12** |
| `cargo test -p pf-proxy -p pf-parser` | **38 passed / 0 failed** |
| `pnpm --filter @polyframe/desktop typecheck` | 通过 |

## 5. 回归脚本

`e2e-cors.mjs`（可复跑，带对照组）

```
node e2e-cors.mjs                 # 默认用演示流
node e2e-cors.mjs "<hls真实链接>"  # 换片源
node e2e-cors.mjs --show          # 显示窗口
```

`check-cors.mjs` 只查响应头，用来快速区分「头没发」还是「源站/清单真的坏」。

脚本本身踩过的坑（已写进文件头注释）：本机 shell 带 `ELECTRON_RUN_AS_NODE=1`；
`electron.exe` 用绝对路径 spawn 会静默返回 -1；入口必须是目录 + `package.json`；
命令行带 `http://` 参数会让 Electron 拒绝启动（改走 `args.json`）；GUI 子系统 stdout 拿不到（结果写文件）。

## 6. 遗留风险

- `Access-Control-Allow-Origin: *` 意味着**本机任何进程**只要拿到 token 就能读代理内容。token 每次启动轮换，风险等同于原有分片路径，未进一步收紧（若要收紧需改成按 `Origin` 白名单回显，但 `file://` 的 `null` 源会让白名单失效）。
- 清单 CORS 修好后，若仍出现 `manifestLoadError`，优先怀疑：内核重启后 token 失效（`replayAfterReconnect` 已覆盖）、源站当天新集 404（见 `docs/P21-播放链路测试报告.md`）。
