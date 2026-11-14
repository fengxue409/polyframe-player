//! pf-core：Rust 内核主进程
//!
//! 职责（P1）：
//!  1. 打开 SQLite（%LOCALAPPDATA%/PolyFrame/core.db）+ 缓存目录
//!  2. 启动 pf-proxy（随机端口，仅 127.0.0.1，路径内随机 token）
//!  3. 启动任务引擎并恢复 DB 中未完结任务（断点续传）
//!  4. 监听 127.0.0.1 随机端口的 NDJSON RPC（JSON-RPC 2.0 语义）
//!  5. 向 stdout 打印 `PF_CORE_PORT=<port>` / `PF_PROXY_PORT=<port>`（端口发现）
//!
//! P2.5：缓存清理器后台循环（播完 TTL / 未播完 LRU / 容量 LRU / 孤儿清扫，
//!       DESIGN §4.6）；task.create 支持 cacheMode；task.set_cache_mode 切换三档。
//!
//! 事件方向：引擎广播（task.updated / core.log）→ 以 JSON-RPC 通知推给所有已连接客户端。

use std::io::Write as _;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use pf_engine::{CacheMode, EngineEvent, ProxyInfo, TaskManager};
use rand::Rng;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;

mod catalog;
mod danmaku;
mod magnet;
mod netdisk;
mod parse;
mod parse_presets;
mod presets;
mod srccache;

/// P3：libmpv 托管句柄（全局唯一；None = 未 attach 或 DLL 不可用）
static MPV: OnceLock<Mutex<Option<Arc<pf_mpv::MpvHost>>>> = OnceLock::new();

fn mpv_slot() -> &'static Mutex<Option<Arc<pf_mpv::MpvHost>>> {
    MPV.get_or_init(|| Mutex::new(None))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// 数据根目录：%LOCALAPPDATA%/PolyFrame（无环境变量时退回临时目录，便于测试）
fn data_root() -> PathBuf {
    std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("PolyFrame")
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    // 1. 存储：SQLite 断点续存 + 分片缓存目录
    let root = data_root();
    let store = match pf_engine::CacheStore::open(&root.join("core.db"), root.join("cache")) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[pf-core] 打开存储失败: {e}");
            return Err(std::io::Error::new(std::io::ErrorKind::Other, e));
        }
    };

    // 2. 任务引擎
    let engine = Arc::new(TaskManager::new(store));

    // 2.5 P7 目录源站播种（表空时写入出厂采集站）
    catalog::ensure_builtin_sources(engine.store());
    // P12：上次没跑完的磁力任务标为「已中断」（会话句柄不跨进程）
    let _ = engine.store().mark_interrupted_magnet_tasks();
    // P10：解析接口预设（表空时播种；direct:// 哨兵 = 零接口直连嗅探）
    parse::ensure_builtin_parses(engine.store());
    // P14：弹幕启动态（只打日志，无凭据也照常运行本地弹幕）
    danmaku::log_startup_state(engine.store());

    // 3. 本地代理（下载与播放的唯一边界）+ 随机 token
    // nd_token：网盘 shim 路径密钥（P9b，落库复用 —— shim URL 会写进任务 URL，
    // 必须跨重启稳定；proxy token 则每次启动轮换）
    let token = format!("{:032x}", rand::thread_rng().r#gen::<u128>());
    let nd_token = engine.store().netdisk_shim_token();
    let proxy_port = pf_proxy::serve(engine.clone(), token.clone(), nd_token).await?;
    let proxy = ProxyInfo { port: proxy_port, token };

    // 4. 启动恢复：DB 中未完结任务重新解析并续传（后台执行，不阻塞 RPC 就绪）
    tokio::spawn(engine.clone().restore_from_db(proxy.clone()));

    // 4.5 缓存清理器：启动清扫 + 每 60s 一轮（P2.5，DESIGN §4.6）
    tokio::spawn(engine.clone().cleanup_loop());

    // 4.6 series 剧集预缓存队列：当前集 ≥95% 激活下一集（P3，DESIGN §4.6）
    tokio::spawn(engine.clone().series_queue_loop());

    // 4.7 P11 收藏追更后台巡检（P13 间隔可配置）：启动 5 分钟后首跑，之后按
    // 可配置间隔（settings，默认 6h，0 = 关闭）。5 分钟 tick 轮询间隔设置，
    // 改配置无需重启内核。（GYING 追更的产品化吸收：无需用户手动「检查更新」）
    tokio::spawn({
        let engine = engine.clone();
        let proxy = proxy.clone(); // 巡检追更需要 proxy 构造网盘 shim URL（P16）
        async move {
            tokio::time::sleep(std::time::Duration::from_secs(catalog::AUTOSCAN_START_DELAY_SECS)).await;
            // 首轮视为已到期（对齐「启动即首跑」语义；关闭状态除外）
            let mut last_run = std::time::Instant::now() - std::time::Duration::from_secs(7 * 86400);
            loop {
                let hours = catalog::autoscan_interval_hours(&engine);
                if hours == 0 {
                    // 巡检已关闭：空转等待；恢复后按间隔重新计时
                    tokio::time::sleep(std::time::Duration::from_secs(300)).await;
                    continue;
                }
                if last_run.elapsed() >= std::time::Duration::from_secs(hours * 3600) {
                    catalog::autoscan_once(&engine, &proxy).await;
                    last_run = std::time::Instant::now();
                }
                tokio::time::sleep(std::time::Duration::from_secs(300)).await;
            }
        }
    });

    // 5. RPC 监听（随机端口）+ 连接鉴权 token（H2）
    // token 仅经 stdout 传给 Electron 主进程（与端口发现同协议），
    // 任何新连接首行必须回传 `PF_AUTH <token>`，否则静默断开。
    let rpc_token = format!("{:032x}", rand::thread_rng().r#gen::<u128>());
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();

    // 6. 端口发现协议：stdout 打印（println 行缓冲，另显式 flush 双保险）
    println!("PF_CORE_PORT={port}");
    println!("PF_PROXY_PORT={proxy_port}");
    println!("PF_CORE_TOKEN={rpc_token}");
    std::io::stdout().flush().ok();

    eprintln!(
        "[pf-core] rpc=127.0.0.1:{port} proxy=127.0.0.1:{proxy_port} data={} version={}",
        root.display(),
        env!("CARGO_PKG_VERSION")
    );

    loop {
        let (stream, _addr) = listener.accept().await?;
        let engine = engine.clone();
        let proxy = proxy.clone();
        let rpc_token = rpc_token.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream, engine, proxy, rpc_token).await {
                eprintln!("[pf-core] connection error: {e}");
            }
        });
    }
}

/// M8：读取单行并限制长度上限（tokio 的 lines() 无上限，超长行会吞内存）
const MAX_RPC_LINE: usize = 1 << 20; // 1 MB

/// 读一行（不含行尾换行符）。
///
/// **必须走 `read_until`（AsyncBufReadExt），不能用裸 `read()`**：
/// 裸 `read` 会绕过 `BufReader` 的内部缓冲，而一次 `read` 常常会带回多行
/// （客户端把鉴权行和首个请求写进同一个 TCP 包时尤其如此）。
/// 用裸 read 只能取到第一行，其余字节随 chunk 一起被丢掉 ——
/// 表现为「鉴权成功但第一个请求永远等不到响应」，是极难定位的随机超时。
async fn next_line_bounded(
    reader: &mut BufReader<tokio::net::tcp::OwnedReadHalf>,
) -> std::io::Result<Option<String>> {
    let mut buf: Vec<u8> = Vec::with_capacity(512);
    loop {
        let n = reader.read_until(b'\n', &mut buf).await?;
        if n == 0 {
            // 对端正常关闭：缓冲区残留（无换行结尾）也当作一行返回
            return Ok(if buf.is_empty() {
                None
            } else {
                Some(String::from_utf8_lossy(&buf).into_owned())
            });
        }
        if buf.len() > MAX_RPC_LINE {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "rpc line too long",
            ));
        }
        if buf.last() == Some(&b'\n') {
            buf.pop();
            // 兼容 CRLF 客户端
            if buf.last() == Some(&b'\r') {
                buf.pop();
            }
            return Ok(Some(String::from_utf8_lossy(&buf).into_owned()));
        }
    }
}

/// 单个 RPC 连接：并发处理「请求响应」与「事件推送」两条流
async fn handle_connection(
    stream: TcpStream,
    engine: Arc<TaskManager>,
    proxy: ProxyInfo,
    rpc_token: String,
) -> std::io::Result<()> {
    let (reader, writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let mut events = engine.subscribe();
    // 写回经互斥锁串行化（请求响应与事件推送共用一条连接），保证 NDJSON 帧完整
    let writer = Arc::new(tokio::sync::Mutex::new(writer));

    // H2：连接鉴权 —— 首行必须为 `PF_AUTH <token>`，5s 内未完成即静默断开
    {
        let expect = format!("PF_AUTH {rpc_token}");
        let first = match tokio::time::timeout(
            Duration::from_secs(5),
            next_line_bounded(&mut reader),
        )
        .await
        {
            Ok(Ok(Some(l))) => l.trim().to_string(),
            _ => return Ok(()), // 超时 / 对端断开 / 行超限 → 拒绝
        };
        if first != expect {
            eprintln!("[pf-core] rpc auth rejected");
            return Ok(());
        }
    }

    // 鉴权通过后才发连接建立通知（同时验证事件推送通道）
    {
        let mut w = writer.lock().await;
        send_notification(
            &mut *w,
            "core.log",
            json!({ "level": "info", "message": "client connected", "ts": now_ms() }),
        )
        .await?;
    }

    // 并发派发：单连接内多个 RPC 并行处理。此前逐行 await 串行派发，
    // 任何慢 RPC（如 task.create 等 playlist 等待）都会队头阻塞后续请求——
    // 磁力页 1s 轮询的 magnet.list 曾被整体堵到主进程 10s 超时。
    loop {
        tokio::select! {
            line = next_line_bounded(&mut reader) => {
                match line? {
                    Some(l) if !l.trim().is_empty() => {
                        let engine = engine.clone();
                        let proxy = proxy.clone();
                        let writer = writer.clone();
                        tokio::spawn(async move {
                            let resp = dispatch(&l, &engine, &proxy).await;
                            let mut w = writer.lock().await;
                            let _ = w.write_all(resp.as_bytes()).await;
                            let _ = w.write_all(b"\n").await;
                            let _ = w.flush().await;
                            // 连接已断开时写失败静默丢弃（对端不再需要响应）
                        });
                    }
                    Some(_) => continue,
                    None => break, // 对端关闭
                }
            }
            ev = events.recv() => {
                match ev {
                    Ok(EngineEvent::TaskUpdated { task }) => {
                        let mut w = writer.lock().await;
                        send_notification(&mut *w, "task.updated", json!({ "task": task })).await?;
                    }
                    Ok(EngineEvent::Log { level, message }) => {
                        let mut w = writer.lock().await;
                        send_notification(
                            &mut *w,
                            "core.log",
                            json!({ "level": level, "message": message, "ts": now_ms() }),
                        )
                        .await?;
                    }
                    Ok(EngineEvent::SourcesUpdated { task_id, sources }) => {
                        let mut w = writer.lock().await;
                        send_notification(
                            &mut *w,
                            "sources.updated",
                            json!({ "taskId": task_id, "sources": sources }),
                        )
                        .await?;
                    }
                    Ok(EngineEvent::ProxyStats { task_id, stats }) => {
                        let mut w = writer.lock().await;
                        send_notification(
                            &mut *w,
                            "proxy.stats",
                            json!({ "taskId": task_id, "stats": stats }),
                        )
                        .await?;
                    }
                    Ok(EngineEvent::MpvState { state }) => {
                        let mut w = writer.lock().await;
                        send_notification(&mut *w, "mpv.state", state).await?;
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        eprintln!("[pf-core] event lagged: {n}");
                    }
                    Err(_) => break, // 通道关闭
                }
            }
        }
    }
    Ok(())
}

async fn send_notification<W>(
    writer: &mut W,
    method: &str,
    params: Value,
) -> std::io::Result<()>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    let note = json!({ "jsonrpc": "2.0", "method": method, "params": params });
    writer.write_all(note.to_string().as_bytes()).await?;
    writer.write_all(b"\n").await?;
    writer.flush().await
}

/// 请求分发：方法路由 + 错误码（-32700/-32601/-32602/-32000）
async fn dispatch(line: &str, engine: &Arc<TaskManager>, proxy: &ProxyInfo) -> String {
    let req: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return error_response(Value::Null, -32700, &format!("parse error: {e}")),
    };
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let method = req
        .get("method")
        .and_then(|m| m.as_str())
        .unwrap_or_default();
    let params = req.get("params").cloned().unwrap_or_else(|| json!({}));

    // P7 影视发现与片源聚合：catalog.* 委托 catalog 模块（None = 未识别方法）
    if let Some(rest) = method.strip_prefix("catalog.") {
        let resp = catalog::handle(rest, &params, id.clone(), engine, proxy).await;
        return resp.unwrap_or_else(|| error_response(id, -32601, &format!("method not found: {method}")));
    }

    // P12 磁力/BT 片源：magnet.* 委托 magnet 模块（需 proxy 信息生成 /bt 播放地址）
    if let Some(rest) = method.strip_prefix("magnet.") {
        let resp = magnet::handle(rest, &params, id.clone(), engine, proxy).await;
        return resp.unwrap_or_else(|| error_response(id, -32601, &format!("method not found: {method}")));
    }

    // P10 视频云解析：parse.* 委托 parse 模块
    if let Some(rest) = method.strip_prefix("parse.") {
        let resp = parse::handle(rest, &params, id.clone(), engine).await;
        return resp.unwrap_or_else(|| error_response(id, -32601, &format!("method not found: {method}")));
    }

    // P9b 网盘视频源：netdisk.* 委托 netdisk 模块（需 proxy 信息生成 shim URL）
    if let Some(rest) = method.strip_prefix("netdisk.") {
        let resp = netdisk::handle(rest, &params, id.clone(), engine, proxy).await;
        return resp.unwrap_or_else(|| error_response(id, -32601, &format!("method not found: {method}")));
    }

    // P14 弹幕：danmaku.* 委托 danmaku 模块
    if let Some(rest) = method.strip_prefix("danmaku.") {
        let resp = danmaku::handle(rest, &params, id.clone(), engine).await;
        return resp.unwrap_or_else(|| error_response(id, -32601, &format!("method not found: {method}")));
    }

    match method {
        "core.ping" => ok_response(id, json!({ "pong": true, "ts": now_ms() })),
        "core.hello" => ok_response(
            id,
            json!({
                "name": "polyframe-core",
                "version": env!("CARGO_PKG_VERSION"),
                "protocolVersion": 1,
                "proxyPort": proxy.port,
                // P7：海报 /pic 透传需要 token 拼代理 URL（与 playUrl 同源防护）
                "proxyToken": proxy.token,
            }),
        ),
        "task.create" => {
            let url = params
                .get("url")
                .and_then(|u| u.as_str())
                .unwrap_or_default()
                .to_string();
            if url.trim().is_empty() {
                return error_response(id, -32602, "invalid params: url is required");
            }
            let title = params.get("title").and_then(|t| t.as_str()).map(str::to_string);
            // P2 多镜像：sources 为镜像 URL 列表（url 本身为主源）
            let sources: Vec<String> = params
                .get("sources")
                .and_then(|s| s.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            // P2.5 三档缓存模式：online | stream | precache（P29 起缺省 = precache）
            let cache_mode = params
                .get("cacheMode")
                .and_then(|c| c.as_str())
                .and_then(CacheMode::from_str)
                .unwrap_or_default();
            // 探测+解析在本次调用内完成（bipbop 两级 playlist，约数百毫秒），
            // 失败返回 -32000，成功返回含 playUrl 的任务快照
            match engine
                .create_task(&url, title, sources, cache_mode, proxy)
                .await
            {
                Ok(task) => ok_response(id, json!({ "task": task })),
                Err(e) => error_response(id, -32000, &format!("create task failed: {e}")),
            }
        }
        "task.list" => {
            let tasks = engine.list_tasks().await;
            ok_response(id, json!({ "tasks": tasks }))
        }
        // P2.5：切换缓存三档（→ online 停预取清缓存；→ stream/precache 恢复调度）
        "task.set_cache_mode" => {
            let task_id = params
                .get("taskId")
                .and_then(|t| t.as_str())
                .unwrap_or_default()
                .to_string();
            let mode = params
                .get("cacheMode")
                .and_then(|c| c.as_str())
                .and_then(CacheMode::from_str);
            if task_id.is_empty() || mode.is_none() {
                return error_response(id, -32602, "invalid params: taskId / cacheMode(online|stream|precache) required");
            }
            match engine.set_cache_mode(&task_id, mode.unwrap()).await {
                Ok(task) => ok_response(id, json!({ "task": task })),
                Err(e) => error_response(id, -32000, &format!("set cache mode failed: {e}")),
            }
        }
        // ---------- P3：剧集预缓存队列 ----------
        "task.attach_series" => {
            let Some(task_id) = params.get("taskId").and_then(|v| v.as_str()) else {
                return error_response(id, -32602, "invalid params: taskId required");
            };
            let Some(series_id) = params.get("seriesId").and_then(|v| v.as_str()) else {
                return error_response(id, -32602, "invalid params: seriesId required");
            };
            let episode_index = params.get("episodeIndex").and_then(|v| v.as_i64()).unwrap_or(0);
            if let Err(e) = engine.upsert_series(series_id) {
                return error_response(id, -32000, &e);
            }
            if let Err(e) = engine.attach_series(task_id, series_id, episode_index) {
                return error_response(id, -32000, &e);
            }
            ok_response(id, json!({ "attached": true, "seriesId": series_id, "episodeIndex": episode_index }))
        }
        // ---------- P46：剧集预缓存（窗口化） ----------
        "series.attach" => {
            let Some(series_id) = params.get("seriesId").and_then(|v| v.as_str()) else {
                return error_response(id, -32602, "invalid params: seriesId required");
            };
            let title = params.get("title").and_then(|v| v.as_str());
            let task_id = params.get("taskId").and_then(|v| v.as_str());
            let current = params.get("index").and_then(|v| v.as_i64()).unwrap_or(0);
            // episodes: [{ index, name?, url }]，允许整组（几百集）一次带上
            let episodes: Vec<(i64, Option<String>, String)> = params
                .get("episodes")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .enumerate()
                        .filter_map(|(i, e)| {
                            let url = e.get("url").and_then(|v| v.as_str())?.trim();
                            if url.is_empty() {
                                return None;
                            }
                            let idx = e.get("index").and_then(|v| v.as_i64()).unwrap_or(i as i64);
                            let name = e.get("name").and_then(|v| v.as_str()).map(str::to_string);
                            Some((idx, name, url.to_string()))
                        })
                        .collect()
                })
                .unwrap_or_default();
            match engine
                .series_attach(series_id, title, task_id, current, &episodes)
                .await
            {
                Ok(st) => ok_response(id, serde_json::to_value(st).unwrap_or_else(|_| json!({}))),
                Err(e) => error_response(id, -32000, &format!("attach series failed: {e}")),
            }
        }
        "series.prefetch_status" => {
            let Some(task_id) = params.get("taskId").and_then(|v| v.as_str()) else {
                return error_response(id, -32602, "invalid params: taskId required");
            };
            match engine.series_status_of_task(task_id).await {
                Ok(st) => ok_response(id, serde_json::to_value(st).unwrap_or_else(|_| json!({}))),
                Err(e) => error_response(id, -32000, &e),
            }
        }
        "config.get_series_prefetch" => {
            let c = engine.prefetch_config();
            ok_response(id, json!({ "mode": c.mode.as_str(), "count": c.count }))
        }
        "config.set_series_prefetch" => {
            let mode = params.get("mode").and_then(|v| v.as_str());
            let count = params
                .get("count")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32);
            match engine.set_prefetch_config(mode, count) {
                Ok(c) => ok_response(id, json!({ "mode": c.mode.as_str(), "count": c.count })),
                Err(e) => error_response(id, -32000, &e),
            }
        }
        // ---------- P3：缓存策略 / 手动清理 ----------
        "config.get_cache_policy" => {
            let p = engine.cache_policy();
            ok_response(
                id,
                json!({ "retainDays": p.retain_days, "unfinishedDays": p.unfinished_days, "capacityGb": p.capacity_gb }),
            )
        }
        "config.set_cache_policy" => {
            let num = |k: &str| params.get(k).and_then(|v| v.as_f64());
            match engine.set_cache_policy(num("retainDays"), num("unfinishedDays"), num("capacityGb")) {
                Ok(p) => ok_response(
                    id,
                    json!({ "retainDays": p.retain_days, "unfinishedDays": p.unfinished_days, "capacityGb": p.capacity_gb }),
                ),
                Err(e) => error_response(id, -32000, &e),
            }
        }
        "task.purge_cache" => {
            let Some(task_id) = params.get("taskId").and_then(|v| v.as_str()) else {
                return error_response(id, -32602, "invalid params: taskId required");
            };
            match engine.purge_task(task_id).await {
                Ok(freed) => ok_response(id, json!({ "freedBytes": freed })),
                Err(e) => error_response(id, -32000, &e),
            }
        }
        // ---------- P19：片源内容缓存（元数据/海报/直链） ----------
        "cache.src_stats" => {
            let stats = engine.store().src_cache_stats();
            let policy = pf_engine::SrcCachePolicy::load(engine.store());
            ok_response(id, json!({ "stats": stats, "policy": policy }))
        }
        "cache.src_clear" => {
            let kind = params.get("kind").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty());
            let (removed, freed) = engine.store().src_cache_clear(kind);
            ok_response(id, json!({ "removed": removed, "freedBytes": freed, "kind": kind }))
        }
        "config.get_src_cache_policy" => {
            ok_response(id, json!({ "policy": pf_engine::SrcCachePolicy::load(engine.store()) }))
        }
        "config.set_src_cache_policy" => {
            let num = |k: &str| params.get(k).and_then(|v| v.as_i64());
            let b = |k: &str| params.get(k).and_then(|v| v.as_bool());
            match pf_engine::SrcCachePolicy::save(
                engine.store(),
                num("ttlSearchMin"),
                num("ttlCategoryMin"),
                num("ttlDetailMin"),
                num("ttlTmdbHours"),
                num("ttlPosterDays"),
                num("ttlParseMin"),
                num("capacityMb"),
                b("offlineFallback"),
            ) {
                Ok(p) => ok_response(id, json!({ "policy": p })),
                Err(e) => error_response(id, -32000, &e),
            }
        }
        // ---------- P5：任务暂停 / 恢复 / 删除（任务管理页） ----------
        "task.pause" => {
            let Some(task_id) = params.get("taskId").and_then(|v| v.as_str()) else {
                return error_response(id, -32602, "invalid params: taskId required");
            };
            match engine.pause_task(task_id).await {
                Ok(task) => ok_response(id, json!({ "task": task })),
                Err(e) => error_response(id, -32000, &format!("pause task failed: {e}")),
            }
        }
        "task.resume" => {
            let Some(task_id) = params.get("taskId").and_then(|v| v.as_str()) else {
                return error_response(id, -32602, "invalid params: taskId required");
            };
            match engine.resume_task(task_id).await {
                Ok(task) => ok_response(id, json!({ "task": task })),
                Err(e) => error_response(id, -32000, &format!("resume task failed: {e}")),
            }
        }
        "task.delete" => {
            let Some(task_id) = params.get("taskId").and_then(|v| v.as_str()) else {
                return error_response(id, -32602, "invalid params: taskId required");
            };
            match engine.delete_task(task_id).await {
                Ok(freed) => ok_response(id, json!({ "freedBytes": freed })),
                Err(e) => error_response(id, -32000, &format!("delete task failed: {e}")),
            }
        }
        // ---------- P35：批量清理（媒体库 / 任务页） ----------
        // 一次 RPC 处理整批：逐个调用单条接口每个都要等 400ms worker 收尾，
        // 清几十个任务会卡十几秒；批量接口把等待折叠成一次。
        "task.delete_many" => {
            let Some(ids) = str_list_param(&params, "taskIds") else {
                return error_response(id, -32602, "invalid params: taskIds required");
            };
            let (deleted, freed, failed) = engine.delete_tasks(&ids).await;
            ok_response(
                id,
                json!({
                    "deleted": deleted,
                    "freedBytes": freed,
                    "failed": failed
                        .into_iter()
                        .map(|(tid, error)| json!({ "id": tid, "error": error }))
                        .collect::<Vec<_>>(),
                }),
            )
        }
        "task.purge_cache_many" => {
            let Some(ids) = str_list_param(&params, "taskIds") else {
                return error_response(id, -32602, "invalid params: taskIds required");
            };
            let (purged, freed, failed) = engine.purge_tasks(&ids).await;
            ok_response(
                id,
                json!({
                    "purged": purged,
                    "freedBytes": freed,
                    "failed": failed
                        .into_iter()
                        .map(|(tid, error)| json!({ "id": tid, "error": error }))
                        .collect::<Vec<_>>(),
                }),
            )
        }
        // ---------- P6：合并导出（DESIGN §4.6） ----------
        "task.exportInfo" => {
            let Some(task_id) = params.get("taskId").and_then(|v| v.as_str()) else {
                return error_response(id, -32602, "invalid params: taskId required");
            };
            match engine.export_info(task_id).await {
                Ok(info) => ok_response(id, serde_json::to_value(info).unwrap_or_default()),
                Err(e) => error_response(id, -32000, &format!("export info failed: {e}")),
            }
        }
        "task.export" => {
            let Some(task_id) = params.get("taskId").and_then(|v| v.as_str()) else {
                return error_response(id, -32602, "invalid params: taskId required");
            };
            let Some(out_path) = params.get("outPath").and_then(|v| v.as_str()) else {
                return error_response(id, -32602, "invalid params: outPath required");
            };
            // H3：outPath 白名单校验 —— 正常路径经主进程保存对话框（可信），
            // 但 RPC 层必须自证：拒绝相对路径 / 路径穿越 / 非媒体扩展名 / 系统目录
            if let Err(e) = validate_export_path(out_path) {
                return error_response(id, -32602, &format!("invalid outPath: {e}"));
            }
            match engine.export_task(task_id, out_path).await {
                Ok(r) => ok_response(id, serde_json::to_value(r).unwrap_or_default()),
                Err(e) => error_response(id, -32000, &format!("export failed: {e}")),
            }
        }
        // ---------- P3：libmpv 播放内核（DESIGN §4.4） ----------
        "mpv.probe" => {
            match pf_mpv::probe() {
                Some(p) => ok_response(id, json!({ "available": true, "path": p.display().to_string() })),
                None => ok_response(id, json!({ "available": false })),
            }
        }
        "mpv.attach" => {
            let hwnd = params.get("hwnd").and_then(|h| h.as_i64()).unwrap_or(0);
            let host = mpv_slot().lock().unwrap_or_else(|p| p.into_inner()).clone();
            if let Some(h) = host {
                if h.is_alive() {
                    return ok_response(id, json!({ "attached": true, "reused": true }));
                }
            }
            // mpv 初始化（含 122MB DLL 加载）阻塞较久 → spawn_blocking
            let r = tokio::task::spawn_blocking(move || pf_mpv::MpvHost::attach(hwnd as isize))
                .await
                .map_err(|e| format!("attach join 失败: {e}"))
                .and_then(|r| r);
            match r {
                Ok(host) => {
                    let host = Arc::new(host);
                    *mpv_slot().lock().unwrap_or_else(|p| p.into_inner()) = Some(host.clone());
                    tokio::spawn(mpv_state_pump(engine.clone(), host));
                    ok_response(id, json!({ "attached": true, "headless": hwnd == 0 }))
                }
                Err(e) => error_response(id, -32000, &format!("mpv attach failed: {e}")),
            }
        }
        "mpv.detach" => {
            if let Some(h) = mpv_slot().lock().unwrap_or_else(|p| p.into_inner()).take() {
                let _ = h.stop();
            }
            ok_response(id, json!({ "detached": true }))
        }
        "mpv.load" => {
            let Some(host) = mpv_slot().lock().unwrap_or_else(|p| p.into_inner()).clone() else {
                return error_response(id, -32000, "mpv not attached");
            };
            let url = params.get("url").and_then(|u| u.as_str()).unwrap_or_default().to_string();
            if url.is_empty() {
                return error_response(id, -32602, "invalid params: url required");
            }
            let paused = params.get("paused").and_then(|p| p.as_bool()).unwrap_or(false);
            match host.load(&url, paused) {
                // 显隐已由 `MpvHost::load` 按 surface_visible 决定（切页自动连播不弹窗）
                Ok(_) => ok_response(id, json!({ "loaded": true })),
                Err(e) => error_response(id, -32000, &format!("mpv load failed: {e}")),
            }
        }
        "mpv.stop" => {
            let Some(host) = mpv_slot().lock().unwrap_or_else(|p| p.into_inner()).clone() else {
                return ok_response(id, json!({ "stopped": true }));
            };
            match host.stop() {
                Ok(_) => ok_response(id, json!({ "stopped": true })),
                Err(e) => error_response(id, -32000, &format!("mpv stop failed: {e}")),
            }
        }
        "mpv.seek" => {
            let Some(host) = mpv_slot().lock().unwrap_or_else(|p| p.into_inner()).clone() else {
                return error_response(id, -32000, "mpv not attached");
            };
            let secs = params.get("seconds").and_then(|s| s.as_f64()).unwrap_or(0.0);
            let absolute = params.get("absolute").and_then(|a| a.as_bool()).unwrap_or(true);
            match host.seek(secs, absolute) {
                Ok(_) => ok_response(id, json!({ "seeked": true })),
                Err(e) => error_response(id, -32000, &format!("mpv seek failed: {e}")),
            }
        }
        "mpv.move" => {
            let Some(host) = mpv_slot().lock().unwrap_or_else(|p| p.into_inner()).clone() else {
                return error_response(id, -32000, "mpv not attached");
            };
            let g = |k: &str| params.get(k).and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            host.move_window(g("x"), g("y"), g("w"), g("h"));
            ok_response(id, json!({ "moved": true }))
        }
        // 视频表面显隐（切页隐藏但不暂停）：子窗口只吃 Win32 显隐，不吃 DOM display:none
        "mpv.visible" => {
            let visible = params.get("visible").and_then(|v| v.as_bool()).unwrap_or(true);
            match mpv_slot().lock().unwrap_or_else(|p| p.into_inner()).clone() {
                Some(host) => {
                    host.set_surface_visible(visible);
                    ok_response(id, json!({ "visible": visible, "attached": true }))
                }
                // 还没 attach：记不住意图也无所谓（窗口此时不存在），
                // 返回 ok 而不是报错——调用方是切页钩子，不该被未挂接的状态打断
                None => ok_response(id, json!({ "visible": visible, "attached": false })),
            }
        }
        "mpv.set" => {
            let Some(host) = mpv_slot().lock().unwrap_or_else(|p| p.into_inner()).clone() else {
                return error_response(id, -32000, "mpv not attached");
            };
            let (Some(name), Some(value)) = (
                params.get("name").and_then(|n| n.as_str()),
                params.get("value").and_then(|v| v.as_str()),
            ) else {
                return error_response(id, -32602, "invalid params: name/value required");
            };
            match host.set_property(name, value) {
                Ok(_) => ok_response(id, json!({ "set": true })),
                Err(e) => error_response(id, -32000, &e),
            }
        }
        "mpv.get" => {
            let Some(host) = mpv_slot().lock().unwrap_or_else(|p| p.into_inner()).clone() else {
                return error_response(id, -32000, "mpv not attached");
            };
            let Some(name) = params.get("name").and_then(|n| n.as_str()) else {
                return error_response(id, -32602, "invalid params: name required");
            };
            ok_response(id, json!({ "value": host.get_property(name) }))
        }
        "mpv.tracklist" => {
            let Some(host) = mpv_slot().lock().unwrap_or_else(|p| p.into_inner()).clone() else {
                return error_response(id, -32000, "mpv not attached");
            };
            ok_response(id, json!({ "tracks": host.tracklist() }))
        }
        // P14 弹幕：ASS 字幕加载需要 `sub-add` / `secondary-sub-add` 这类命令，
        // `mpv.set` 只能改属性，无法执行命令
        "mpv.command" => {
            let Some(host) = mpv_slot().lock().unwrap_or_else(|p| p.into_inner()).clone() else {
                return error_response(id, -32000, "mpv not attached");
            };
            let args: Vec<String> = params
                .get("args")
                .and_then(|a| a.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            if args.is_empty() {
                return error_response(id, -32602, "invalid params: args required");
            }
            let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
            match host.command(&refs) {
                Ok(_) => ok_response(id, json!({ "ok": true })),
                Err(e) => error_response(id, -32000, &format!("mpv command failed: {e}")),
            }
        }
        other => error_response(id, -32601, &format!("method not found: {other}")),
    }
}

/// mpv 状态泵：版本号变化时以 `mpv.state` 通知广播快照（4Hz 节流上限）
async fn mpv_state_pump(engine: Arc<TaskManager>, host: Arc<pf_mpv::MpvHost>) {
    let mut last = 0u64;
    loop {
        tokio::time::sleep(Duration::from_millis(250)).await;
        // 句柄已被替换/移除 → 泵退出
        {
            let guard = mpv_slot().lock().unwrap_or_else(|p| p.into_inner());
            match guard.as_ref() {
                Some(h) if Arc::ptr_eq(h, &host) => {}
                _ => break,
            }
        }
        let v = host.state_version();
        if v != last {
            last = v;
            let state = serde_json::to_value(host.state()).unwrap_or_default();
            engine.broadcast_event(EngineEvent::MpvState { state });
        }
        if !host.is_alive() {
            break;
        }
    }
}

fn ok_response(id: Value, result: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

/// P35：字符串数组参数（批量清理的 `taskIds`）。
///
/// 返回 `None` 表示参数缺失或不合法；**空数组同样视为不合法**——
/// 批量删除收到空列表通常是前端选中态错乱，静默返回成功会把这个 bug 藏起来。
fn str_list_param(params: &Value, key: &str) -> Option<Vec<String>> {
    let arr = params.get(key)?.as_array()?;
    let mut out = Vec::with_capacity(arr.len());
    for v in arr {
        match v.as_str() {
            Some(s) if !s.trim().is_empty() => out.push(s.trim().to_string()),
            _ => return None,
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// H3：导出路径校验（纵深防御 —— 即使 RPC 面被未授权方触达，也不能任意路径写）
///  1. 绝对路径、无 `..` 穿越
///  2. 扩展名必须是 ≤5 位字母数字（覆盖任务真实容器扩展名，挡掉 .db/.exe/.dll 等）
///  3. 拒绝系统受保护目录前缀
fn validate_export_path(p: &str) -> Result<(), String> {
    if p.trim().is_empty() {
        return Err("outPath 为空".into());
    }
    let path = std::path::Path::new(p);
    if !path.is_absolute() {
        return Err("outPath 必须为绝对路径".into());
    }
    if p.split(['/', '\\']).any(|seg| seg == "..") {
        return Err("outPath 含路径穿越段".into());
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default();
    if ext.is_empty() || ext.len() > 5 || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("outPath 扩展名非法（仅允许 ≤5 位字母数字）".into());
    }
    let lower = p.to_ascii_lowercase();
    const BLOCKED: &[&str] = &[
        "c:\\windows\\",
        "c:\\windows",
        "c:\\program files",
        "c:\\program files (x86)",
        "c:\\programdata\\",
        "\\system32",
    ];
    if BLOCKED.iter().any(|b| lower.starts_with(b) || lower.contains(b)) {
        return Err("outPath 指向受保护目录".into());
    }
    Ok(())
}

fn error_response(id: Value, code: i32, message: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string()
}
