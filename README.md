# PolyFrame Player

Windows 桌面端视频播放器：**多源镜像聚合 + 自动分片 + 多线程并行加载 + 边下边播**。

播放内核基于 libmpv，下载引擎、解析器、播放内核各自独立进程，坏源或崩溃不拖垮 UI。
界面为 Electron + Vue 3；核心逻辑由 Rust 实现，通过本地 TCP 上的 JSON-RPC 与前端通信。

> ⚠️ 本项目**仅用于技术研究与个人学习**，不提供、不存储、不分发任何音视频内容。
> 程序本身不含内容资源，所聚合的第三方源站由其运营方负责。请在遵守当地法律法规的前提下使用。

---

## 架构

```
┌─────────────── Electron 主进程 ───────────────┐
│  window / 托盘 / 本地回环代理 / 日志           │
│        │ preload (contextBridge)              │
│        ▼                                       │
│  Renderer: Vue 3 + Pinia + Vite               │
└───────────────┬────────────────────────────────┘
                │  JSON-RPC over TCP (PF_AUTH token)
                ▼
        ┌───────────────┐
        │  pf-core.exe  │  进程编排、任务表、缓存、RPC 路由
        └───┬───────┬───┘
            │       │
   ┌────────┴──┐  ┌─┴────────────┐
   │ pf-engine │  │ pf-parser    │  ...
   └───────────┘  └──────────────┘
```

| 组件 | 位置 | 职责 |
|---|---|---|
| `pf-core` | `apps/core/crates/pf-core` | RPC 服务端、任务生命周期、设置与历史、聚合搜索 |
| `pf-engine` | `apps/core/crates/pf-engine` | 分片下载调度、连接池、断点续存、缓存与清理 |
| `pf-parser` | `apps/core/crates/pf-parser` | CMS 采集站协议、页面提取、直链识别 |
| `pf-proxy` | `apps/core/crates/pf-proxy` | 本地 HTTP 代理，播放与下载的唯一边界 |
| `pf-mpv` | `apps/core/crates/pf-mpv` | libmpv 内核绑定与子窗口管理 |
| `pf-danmaku` | `apps/core/crates/pf-danmaku` | 弹幕协议、ASS 渲染、轨道调度 |
| `pf-netdisk` | `apps/core/crates/pf-netdisk` | 网盘 Provider（阿里云盘 / 百度网盘等）授权与直链 |
| `pf-magnet` | `apps/core/crates/pf-magnet` | 磁力链接解析 |
| `desktop` | `apps/desktop` | Electron 主进程 + Vue 3 渲染层 |
| `shared` | `packages/shared` | RPC 协议与领域模型的跨端类型 |

三档缓存策略：纯在线不落盘 / 边下边播 / 预缓存 N 集，配合 TTL 与容量 LRU 清理。

## 环境要求

- Windows 10/11 x64
- Node.js ≥ 20、pnpm 9+
- Rust stable（MSVC toolchain）
- Visual Studio 2022 Build Tools（C++ 桌面开发负载）
- libmpv 二进制（见下节，不入库）

## 构建

### 1. 依赖

```bash
pnpm install
```

### 2. 放置 libmpv

`apps/core/vendor/mpv/libmpv-2.dll`（约 117 MB）与导入库 `libmpv.dll.a` 因体积原因不入库。
从 [mpv-player-windows](https://sourceforge.net/projects/mpv-player-windows/files/libmpv/) 下载与
`apps/core/vendor/mpv/include/mpv/` 头文件版本匹配的 x86_64 构建，放入该目录即可。

### 3. 编译

```bash
# Rust 内核（产物：apps/core/target/release/pf-core.exe）
cargo build --release --manifest-path apps/core/Cargo.toml

# 前端与主进程
pnpm -r build

# 类型检查
pnpm -r typecheck
```

编译 Rust 部分需要 MSVC 环境变量可用（`LIB` / `INCLUDE` / `PATH` 中的 VC bin 目录）；
在 Git Bash 中若 `cargo` 不可见，先把 `$HOME/.cargo/bin` 加入 `PATH`。

### 4. 开发与打包

```bash
pnpm dev    # 开发模式（electron-vite）
pnpm dist   # 打包：NSIS 安装包 + 免安装版，输出到 apps/desktop/release/
```

`pnpm dist` 依赖上一步产出的 `apps/core/target/release/pf-core.exe` 与 libmpv DLL，
electron-builder 通过 `extraResources` 将其放入 `<install>/resources/pf-core/`。

## 运行期配置

以下参数**不写入仓库**，通过界面或本机数据库保存：

| 配置 | 位置 | 说明 |
|---|---|---|
| TMDB API Key | 设置页 → 评分增强 | 未配置时评分为空，不影响播放 |
| 弹幕 AppId / AppSecret | 设置页 → 弹幕 | 仅存本机 `settings` 表，不进日志 |
| 网盘授权 | 网盘页 | token / cookie 整段 JSON 落本机库，按账号标记过期 |
| 缓存策略 | 设置页 | 默认「预缓存」 |

运行数据目录：`%LOCALAPPDATA%\PolyFrame\`（数据库 `core.db`、分片缓存、`logs\app-YYYY-MM-DD.log`）。

环境变量 `PF_TMDB_API` 可覆盖 TMDB 接口地址（默认 `https://api.themoviedb.org/3`）。

## 目录结构

```
apps/
  core/            Rust 工作区（crates/*、scripts/ 端到端与冒烟脚本）
  desktop/         Electron 应用（electron/ 主进程、src/renderer/ 渲染层）
  video-home/      首页原型 HTML
packages/shared/   RPC 协议与共享类型
docs/              各阶段设计 / 交付 / 排查记录
DESIGN.md          总体技术方案
```

## 文档

`docs/` 下按阶段归档实现记录，排查类问题（黑屏、起播失败、分页、任务分组）都有对应复盘。
新接触代码建议从 `DESIGN.md` 读起，再看 `docs/` 里最近几个阶段。

## 许可

[MIT](LICENSE)。第三方组件遵循各自许可：mpv / libmpv 为 GPL/LGPL，Electron、Vue、hls.js 等见其仓库。
分发时若静态链接 libmpv，需一并满足 GPL 条款。
