//! pf-proxy：本地 HTTP 代理（播放与下载的唯一边界，Stremio 模式）
//!
//! P0：仅 /health 存根 + 随机端口分配（仅监听 127.0.0.1）。
//! P1：HLS playlist 重写（分片 URL → /seg/{token}/{task}/{seq}，key URI → /key/...）、
//!     /seg 命中缓存直回、未命中同步回源 + tee 落盘（DESIGN.md §4.3）。
//! P2：/seg 请求驱动播放头锚点（水位调度）；回源走引擎多源择优；
//!     AES-128 分片本地解密后落盘/回包，playlist 对播放器输出 METHOD=NONE。
//! P2.5：缓存三档——online 模式未命中回源后不落盘（纯实时回源，退出即弃，
//!     DESIGN §4.6）；stream/precache 维持 tee 落盘。
//! P3：master playlist 透传重写（libmpv 轨道选择）+ /raw、/segraw|keyraw 透传路由
//!     （流式管道，Range 原样转发）；EXT-X-MEDIA rendition → /raw 重写路由。

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use futures_util::StreamExt;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::{Bytes, Frame, Incoming};
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use pf_engine::TaskManager;
use pf_parser::MediaIR;
use tokio::sync::mpsc;
// P11：tokio 1.5x 起移除了 mpsc::Receiver 的内置 Stream 实现，
// 统一用 ReceiverStream 包装（Cargo.lock 刷新到 tokio 1.54 后暴露）
use tokio_stream::wrappers::ReceiverStream;

/// 统一响应体：Full（缓冲）与 StreamBody（透传流）共用
type BoxBody = http_body_util::combinators::BoxBody<Bytes, Box<dyn std::error::Error + Send + Sync>>;

/// 缓冲字节 → 统一响应体
fn boxed_full(bytes: Bytes) -> BoxBody {
    Full::new(bytes)
        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { match e {} })
        .boxed()
}

/// 启动代理服务（后台常驻），返回实际绑定的随机高位端口。
///
/// `nd_token`：网盘 shim 路径密钥（P9b，与 `token` 分离——shim URL 会被写进
/// 任务 URL 落库，必须跨重启稳定，而 `token` 每次启动都换新）。
pub async fn serve(engine: Arc<TaskManager>, token: String, nd_token: String) -> std::io::Result<u16> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    tokio::spawn(async move {
        loop {
            let (stream, _) = match listener.accept().await {
                Ok(v) => v,
                Err(_) => continue,
            };
            let engine = engine.clone();
            let token = token.clone();
            let nd_token = nd_token.clone();
            let io = TokioIo::new(stream);
            tokio::spawn(async move {
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(
                        io,
                        service_fn(move |req| {
                            handle(req, engine.clone(), token.clone(), nd_token.clone())
                        }),
                    )
                    .await;
            });
        }
    });
    Ok(port)
}

async fn handle(
    req: Request<Incoming>,
    engine: Arc<TaskManager>,
    token: String,
    nd_token: String,
) -> Result<Response<BoxBody>, std::convert::Infallible> {
    let path = req.uri().path().to_string();
    // P3：透传分片的 Range 头（BYTERANGE 单文件变体依赖客户端 Range 取子区间）
    let range = req
        .headers()
        .get("range")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    // P4：query（segraw ?r=off-len BYTERANGE 收紧参数）
    let query = req.uri().query().map(|q| q.to_string());
    // CORS 预检：hls.js 对带 Range / 自定义头的 XHR 会先发 OPTIONS，
    // 早先这里落到「非 GET/HEAD → 405」分支，预检直接失败。
    if req.method() == &Method::OPTIONS {
        return Ok(with_cors(
            Response::builder()
                .status(StatusCode::NO_CONTENT)
                .body(boxed_full(Bytes::new()))
                .unwrap_or_else(|_| text_response(204, "")),
        ));
    }
    let resp = if req.method() != &Method::GET && req.method() != &Method::HEAD {
        text_response(405, "method not allowed")
    } else {
        match path.as_str() {
            "/health" => json_response(200, r#"{"ok":true,"service":"pf-proxy"}"#),
            _ => {
                route(
                    &path,
                    &engine,
                    &token,
                    &nd_token,
                    range.as_deref(),
                    query.as_deref(),
                    req.method() == &Method::HEAD,
                )
                .await
            }
        }
    };
    Ok(with_cors(resp))
}

/// 统一注入 CORS 头（单一收口点）。
///
/// renderer 页面（dev: `http://localhost:5173`；打包: `file://`，即 `Origin: null`）
/// 与代理 `http://127.0.0.1:<port>` **天然不同源**，hls.js 用 XHR/fetch 拉清单，
/// 响应没有 `Access-Control-Allow-Origin` 就会被浏览器拦成 `manifestLoadError`
/// —— 请求本身在服务端日志里是 200，只有浏览器侧看得到失败，极易误判成源站问题。
///
/// 早期只有 `bytes_response()` 手写了这个头，于是出现「分片能下、清单拉不到」的
/// 诡异症状（分片走 `bytes_response`，清单走手搓的 `playlist_response`）。
/// 现在统一在此注入，新增路由不必再各自记得加。
///
/// 允许 `*` 不影响安全性：路径里的 token 每次都随机轮换，外部站点无从猜起；
/// 且代理只监听 127.0.0.1，不对外可达。
fn with_cors(mut resp: Response<BoxBody>) -> Response<BoxBody> {
    let h = resp.headers_mut();
    h.insert(
        hyper::header::ACCESS_CONTROL_ALLOW_ORIGIN,
        hyper::header::HeaderValue::from_static("*"),
    );
    h.insert(
        hyper::header::ACCESS_CONTROL_ALLOW_METHODS,
        hyper::header::HeaderValue::from_static("GET, HEAD, OPTIONS"),
    );
    h.insert(
        hyper::header::ACCESS_CONTROL_ALLOW_HEADERS,
        hyper::header::HeaderValue::from_static("range, if-range, accept, content-type"),
    );
    h.insert(
        hyper::header::ACCESS_CONTROL_EXPOSE_HEADERS,
        hyper::header::HeaderValue::from_static(
            "content-length, content-range, accept-ranges, etag, last-modified",
        ),
    );
    resp
}

/// 路由分发：/m3u8/{token}/{task}/... | /seg/{token}/{task}/{seq} | /key/{token}/{task}/{idx}
///          | /m3u8/{token}/{task}/master.m3u8 | /m3u8/{token}/{task}/raw/{hex} | /segraw|keyraw/{token}/{task}/{hex}
///          | /nd/{secret}/{owner}/{fileId}/v.mp4（P9b 网盘鉴权透传）
async fn route(
    path: &str,
    engine: &Arc<TaskManager>,
    token: &str,
    nd_token: &str,
    range: Option<&str>,
    query: Option<&str>,
    head: bool,
) -> Response<BoxBody> {
    let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    match parts.as_slice() {
        ["m3u8", t, task_id] | ["m3u8", t, task_id, "playlist.m3u8"] if *t == token => {
            playlist(engine, token, task_id).await
        }
        // P3：master playlist 透传重写（最高码率 variant 本地化 + 音轨/字幕 rendition 归并保留）
        ["m3u8", t, task_id, "master.m3u8"] if *t == token => {
            master_playlist(engine, token, task_id).await
        }
        // P3：任意 playlist 透传重写（音轨/字幕 rendition 的 media playlist，不经下载引擎）
        ["m3u8", t, task_id, "raw", hex] if *t == token => raw_playlist(engine, token, task_id, hex).await,
        // P3：任意分片/key 透传（音轨/字幕分片）；keyraw 为透传解密 key
        ["segraw" | "keyraw", t, task_id, hex] if *t == token => match hex_decode(hex) {
            Some(url) => match guard_outbound_target(&url) {
                Ok(()) => raw_segment(&url, range, query).await,
                Err(reason) => text_response(403, reason),
            },
            None => text_response(400, "invalid hex url"),
        },
        ["seg", t, task_id, seq] if *t == token => segment(engine, task_id, seq).await,
        ["key", t, task_id, idx] if *t == token => key(engine, task_id, idx).await,
        // P4：MP4 虚拟文件（Range 组装：命中读盘 / 未命中回源 tee）
        ["file", t, task_id] if *t == token => file_virtual(engine, task_id, range).await,
        // P12：磁力任务的本地文件（下载完成后按 Range 提供；边下边播不在本版范围）
        ["bt", t, task_id, idx] if *t == token => bt_file(engine, task_id, idx, range, head).await,
        // P7：海报/图片透传（?u= 全量缓冲回包；带源站 Referer 防盗链）
        // P19：先查 src_cache(poster)，命中零回源；源站挂了回退旧图
        ["pic", t] if *t == token => pic_passthrough(engine, query).await,
        // P9b：网盘鉴权透传（稳定 shim URL：注入 provider 请求头 + 直链过期/403 自动换链）
        ["nd", t, owner, file_id, "v.mp4"] if *t == nd_token => {
            // M1：pf-core 生成 shim URL 时对 owner/fileId 做了 percent-encoding，
            // 这里必须先解码再交给 provider —— 否则含 `/`、`,` 等字符的 id
            // （Graph API 常见）在 JSON body/query 里变成 `%2F` 形态查不到文件，
            // 且 LinkCache 键与 RPC 路径不一致导致缓存双份、force 换链失效。
            let owner = percent_decode(owner);
            let file_id = percent_decode(file_id);
            nd_stream(engine, &owner, &file_id, range, head).await
        }
        // token 不匹配：拒绝（防局域网直访）
        ["m3u8" | "seg" | "key" | "segraw" | "keyraw" | "file" | "pic" | "nd" | "bt", ..] => {
            text_response(403, "forbidden")
        }
        _ => text_response(404, "not found"),
    }
}

/// 重写后的 media playlist
async fn playlist(engine: &Arc<TaskManager>, token: &str, task_id: &str) -> Response<BoxBody> {
    let Some(ir) = engine.media_ir(task_id).await else {
        return text_response(404, "task not found");
    };
    let keys = engine.keys(task_id).await;
    let body = build_playlist(&ir, &keys, task_id, token);
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/vnd.apple.mpegurl")
        .header("cache-control", "no-store")
        .body(boxed_full(Bytes::from(body)))
        .unwrap()
}

/// 分片：命中缓存读文件直回；未命中走引擎多源择优回源 + 解密 + 落盘（tee）
async fn segment(engine: &Arc<TaskManager>, task_id: &str, seq_str: &str) -> Response<BoxBody> {
    let Ok(seq) = seq_str.parse::<u64>() else {
        return text_response(400, "invalid seq");
    };
    // 播放头锚点：驱动引擎水位调度（seek 时 |Δseq|>2 触发重排日志）
    engine.note_playhead(task_id, seq).await;
    if let Some(bytes) = engine.read_segment(task_id, seq) {
        engine.stat_proxy_hit(task_id, bytes.len());
        return bytes_response(200, &bytes, seg_content_type(engine, task_id, seq).await);
    }
    // 未命中：回源（多源择优 + 健康度记账 + AES-128 解密，引擎统一处理）
    let bytes = match engine.proxy_fetch_segment(task_id, seq).await {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[pf-proxy] 回源失败 seq={seq}: {e}");
            return text_response(502, &format!("origin fetch failed: {e}"));
        }
    };
    // tee 落盘（引擎并发下载可能已写入同文件，store_segment 幂等处理）；
    // P2.5 online 模式不落盘（纯实时回源，DESIGN §4.6）
    if engine.cache_mode_of(task_id).await != pf_engine::CacheMode::Online {
        if let Err(e) = engine.store_segment(task_id, seq, &bytes, "prx") {
            eprintln!("[pf-proxy] 分片落盘失败 seq={seq}: {e}");
        }
    }
    engine.stat_proxy_fetch(task_id, bytes.len());
    bytes_response(200, &bytes, seg_content_type(engine, task_id, seq).await)
}

/// 解密 key 透传（SAMPLE-AES 等未本地解密场景；AES-128 已在本地解密不会进到这里）
async fn key(engine: &Arc<TaskManager>, task_id: &str, idx_str: &str) -> Response<BoxBody> {
    let Ok(idx) = idx_str.parse::<usize>() else {
        return text_response(400, "invalid key index");
    };
    let keys = engine.keys(task_id).await;
    let Some(k) = keys.get(idx) else {
        return text_response(404, "key not found");
    };
    if let Err(reason) = guard_outbound_target(&k.uri) {
        return text_response(403, reason);
    }
    match fetch_bytes(engine, &k.uri, None).await {
        Ok(bytes) => bytes_response(200, &bytes, "application/octet-stream"),
        Err(e) => {
            eprintln!("[pf-proxy] key 拉取失败 {}: {e}", k.uri);
            text_response(502, &format!("key fetch failed: {e}"))
        }
    }
}

/// P4：MP4 虚拟文件（DESIGN §4.3）——按客户端 Range 组装：
/// 已下载块读盘直回，未下载块同步回源（多源择优 + tee 落盘，online 跳过）。
/// libmpv / <video> 对 /file 的 Range seek 即时可用；块请求同时驱动播放头水位
/// （note_playhead = Range 起点所在块）。无 Range 请求按全量（bytes=0-）流式处理。
///
/// H4：**流式响应** —— 早期实现把响应字节 accumulate 进单个 Vec 再回包，
/// 无 Range 请求（<video>/mpv 初请求）会把整部电影（10GB+）拉进内存 → OOM。
/// 现改为 mpsc 通道 + StreamBody 逐块发送，峰值内存 = 单块（4MiB 级）。
async fn file_virtual(
    engine: &Arc<TaskManager>,
    task_id: &str,
    range: Option<&str>,
) -> Response<BoxBody> {
    let Some(ir) = engine.media_ir(task_id).await else {
        return text_response(404, "task not found");
    };
    let Some(track) = ir.tracks.first() else {
        return text_response(404, "no track");
    };
    let segs = &track.segments;
    let Some(last_range) = segs.last().and_then(|s| s.byterange) else {
        return text_response(404, "empty file");
    };
    let total = last_range.0 + last_range.1; // 块连续切分，总长 = 末块 off+len
    let (start, end) = match range.and_then(|h| parse_http_range(h, total)) {
        Some((s, e)) => (s, e.min(total - 1)),
        None => (0, total.saturating_sub(1)),
    };
    if start >= total || start > end {
        return text_response(416, "range not satisfiable");
    }
    // 播放头锚点 = Range 起点所在块（驱动水位调度；seek 时 |Δseq|>2 即时重排）
    if let Some(first) = segs
        .iter()
        .find(|s| matches!(s.byterange, Some((o, l)) if start >= o && start < o + l))
    {
        engine.note_playhead(task_id, first.seq).await;
    }
    let online = engine.cache_mode_of(task_id).await == pf_engine::CacheMode::Online;

    // 流式管线：后台任务逐块读取/回源，切片后推给响应体（不 accumulate）
    let engine2 = engine.clone();
    let task_id2 = task_id.to_string();
    let chunks: Vec<(u64, u64, u64)> = segs
        .iter()
        .filter_map(|s| s.byterange.map(|(o, l)| (s.seq, o, l)))
        .filter(|&(_, off, len)| {
            let b_end = off + len - 1;
            b_end >= start && off <= end
        })
        .collect();
    let (tx, rx) = mpsc::channel::<Bytes>(4);
    let start2 = start;
    let end2 = end;
    tokio::spawn(async move {
        for (seq, off, len) in chunks {
            let bytes = match engine2.read_segment(&task_id2, seq) {
                Some(b) => {
                    engine2.stat_proxy_hit(&task_id2, b.len());
                    b
                }
                None => match engine2.proxy_fetch_segment(&task_id2, seq).await {
                    Ok(b) => {
                        if !online {
                            if let Err(e) = engine2.store_segment(&task_id2, seq, &b, "prx") {
                                eprintln!("[pf-proxy] 块落盘失败 seq={seq}: {e}");
                            }
                        }
                        engine2.stat_proxy_fetch(&task_id2, b.len());
                        b
                    }
                    Err(e) => {
                        // 响应头已发出，只能截断（播放器按 Range 重试）；
                        // 语义等价于早期整段失败回 502，但不再全量占内存
                        eprintln!("[pf-proxy] 块回源失败 seq={seq}: {e}");
                        break;
                    }
                },
            };
            let b_end = off + len - 1;
            let lo = (start2.max(off) - off) as usize;
            let hi = (end2.min(b_end) - off + 1) as usize;
            if lo < hi && hi <= bytes.len() {
                if tx.send(Bytes::copy_from_slice(&bytes[lo..hi])).await.is_err() {
                    break; // 客户端断开（seek / 停止）→ 停止回源
                }
            }
        }
    });
    let stream = ReceiverStream::new(rx).map(|b| Ok::<_, Box<dyn std::error::Error + Send + Sync>>(Frame::data(b)));
    let body = BodyExt::boxed(StreamBody::new(stream));
    match Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header("content-type", "video/mp4")
        .header("accept-ranges", "bytes")
        .header("content-range", format!("bytes {start}-{end}/{total}"))
        .header("content-length", (end - start + 1).to_string())
        .body(body)
    {
        Ok(r) => r,
        Err(e) => text_response(502, &format!("response build failed: {e}")),
    }
}

/// P12：磁力任务本地文件（/bt/{token}/{task}/{idx}）
///
/// 为什么单独开一条路由而不是复用 /file：`/file` 是「HLS 分片拼出来的虚拟 MP4」，
/// 而磁力任务在磁盘上就是一个完整文件，直接按 Range 读盘即可，既不落缓存也不回源。
/// 路径里带 `idx` 只是为了让「换集」产生新 URL（播放器不会复用旧缓冲），
/// 真实路径一律以表里的 `file_path` 为准 —— 避免 URL 里出现任意文件路径。
async fn bt_file(
    engine: &Arc<TaskManager>,
    task_id: &str,
    idx: &str,
    range: Option<&str>,
    head: bool,
) -> Response<BoxBody> {
    let _ = idx;
    let found = match engine.store().magnet_file(task_id) {
        Ok(v) => v,
        Err(e) => return text_response(500, &format!("查询磁力任务失败: {e}")),
    };
    let Some((path, content_type)) = found else {
        return text_response(404, "磁力任务不存在，或正片还没落到磁盘");
    };
    let total = match tokio::fs::metadata(&path).await {
        Ok(m) => m.len(),
        Err(e) => return text_response(404, &format!("文件不可读: {e}")),
    };
    if total == 0 {
        return text_response(404, "文件为空");
    }
    let ranged = range.is_some();
    let (start, end) = match range.and_then(|h| parse_http_range(h, total)) {
        Some((s, e)) => (s, e.min(total - 1)),
        None => (0, total - 1),
    };
    if start >= total || start > end {
        return text_response(416, "range not satisfiable");
    }
    let len = end - start + 1;

    let mut builder = Response::builder()
        .status(if ranged { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK })
        .header("content-type", content_type)
        .header("accept-ranges", "bytes")
        .header("content-length", len.to_string());
    if ranged {
        builder = builder.header("content-range", format!("bytes {start}-{end}/{total}"));
    }

    if head {
        return match builder.body(boxed_full(Bytes::new())) {
            Ok(r) => r,
            Err(e) => text_response(502, &format!("response build failed: {e}")),
        };
    }

    // 分块读盘：256KB 一片推给响应体，避免大文件整段进内存
    let (tx, rx) = mpsc::channel::<Bytes>(4);
    let path2 = path.clone();
    tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncSeekExt};
        let mut f = match tokio::fs::File::open(&path2).await {
            Ok(f) => f,
            Err(_) => return,
        };
        if f.seek(std::io::SeekFrom::Start(start)).await.is_err() {
            return;
        }
        let mut remaining = len;
        let mut buf = vec![0u8; 256 * 1024];
        while remaining > 0 {
            let want = buf.len().min(remaining as usize);
            match f.read(&mut buf[..want]).await {
                Ok(0) => break,
                Ok(n) => {
                    remaining -= n as u64;
                    if tx.send(Bytes::copy_from_slice(&buf[..n])).await.is_err() {
                        break; // 播放器 seek / 停止 → 不再读盘
                    }
                }
                Err(_) => break,
            }
        }
    });
    let stream = ReceiverStream::new(rx).map(|b| Ok::<_, Box<dyn std::error::Error + Send + Sync>>(Frame::data(b)));
    let body = BodyExt::boxed(StreamBody::new(stream));
    match builder.body(body) {
        Ok(r) => r,
        Err(e) => text_response(502, &format!("response build failed: {e}")),
    }
}

/// 解析 Range 头（单区间）：bytes=a-b / a- / -n；multipart 返回 None（播放器 seek 均为单区间）
fn parse_http_range(h: &str, total: u64) -> Option<(u64, u64)> {
    let spec = h.trim().strip_prefix("bytes=")?.trim();
    if let Some(n) = spec.strip_prefix('-') {
        let n: u64 = n.trim().parse().ok()?;
        if n == 0 || total == 0 {
            return None;
        }
        return Some((total.saturating_sub(n), total - 1));
    }
    let (a, b) = spec.split_once('-')?;
    let start: u64 = a.trim().parse().ok()?;
    let end: u64 = if b.trim().is_empty() {
        total.saturating_sub(1)
    } else {
        b.trim().parse().ok()?
    };
    Some((start, end))
}

async fn fetch_bytes(
    engine: &Arc<TaskManager>,
    url: &str,
    byterange: Option<(u64, u64)>,
) -> Result<Vec<u8>, String> {
    let mut req = engine.http().get(url);
    // BYTERANGE 分片（单文件变体）必须带 Range，否则整文件下载
    if let Some((off, len)) = byterange {
        req = req.header("Range", format!("bytes={off}-{}", off + len - 1));
    }
    let resp = req.send().await.map_err(|e| format!("{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("{e}"))?;
    Ok(bytes.to_vec())
}

// ---------- P3：master playlist 透传重写（libmpv 轨道选择） ----------

/// master playlist 透传重写：
///  - 最高 BANDWIDTH 的 variant → 本地 /m3u8/{token}/{task}/playlist.m3u8（走下载引擎，缓存/多源/解密生效）
///  - 其余 variant + EXT-X-MEDIA（音轨/字幕 rendition）→ /m3u8/{token}/{task}/raw/{hex}（纯透传）
///  - EXT-X-KEY/MAP URI → /keyraw、/segraw 本地化
/// 非 master（单一 media playlist）直接退回重写版 playlist。
async fn master_playlist(engine: &Arc<TaskManager>, token: &str, task_id: &str) -> Response<BoxBody> {
    let Some(task_url) = engine.task_url(task_id).await else {
        return text_response(404, "task not found");
    };
    // mpv 内核只有这一个入口：单次回源抖动（连点/边缘节点切换）就直接黑屏，
    // 实测连点风暴后 /master.m3u8 偶发 502。三次短退避重试 → 仍失败则退回本地
    // 已解析的 media playlist（丢清晰度选择，但保证有画面）。
    let mut raw = None;
    let mut last = String::new();
    for attempt in 0..3u32 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(300 * u64::from(attempt))).await;
        }
        match fetch_bytes(engine, &task_url, None).await {
            Ok(b) => {
                raw = Some(b);
                break;
            }
            Err(e) => last = e,
        }
    }
    let Some(raw) = raw else {
        let _ = last;
        return playlist(engine, token, task_id).await;
    };
    let text = String::from_utf8_lossy(&raw);
    if !text.contains("#EXT-X-STREAM-INF") {
        return playlist(engine, token, task_id).await;
    }
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();

    // Pass 1：找最高 BANDWIDTH
    let mut best_bw = 0u64;
    let mut i = 0;
    while i < lines.len() {
        if let Some(attrs) = lines[i].strip_prefix("#EXT-X-STREAM-INF:") {
            if let Some(uri) = lines.get(i + 1) {
                if !uri.starts_with('#') {
                    let bw = attr_pairs(attrs)
                        .iter()
                        .find(|(k, _, _)| k == "BANDWIDTH")
                        .and_then(|(_, _, v)| v.parse::<u64>().ok())
                        .unwrap_or(0);
                    best_bw = best_bw.max(bw);
                    i += 2;
                    continue;
                }
            }
        }
        i += 1;
    }

    // Pass 2：重写输出
    let mut out = String::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if let Some(attrs) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            let uri = lines.get(i + 1).copied().unwrap_or("");
            if !uri.is_empty() && !uri.starts_with('#') {
                let abs = pf_parser::resolve_url(&task_url, uri);
                let bw = attr_pairs(attrs)
                    .iter()
                    .find(|(k, _, _)| k == "BANDWIDTH")
                    .and_then(|(_, _, v)| v.parse::<u64>().ok())
                    .unwrap_or(0);
                let localized = if bw == best_bw && best_bw > 0 {
                    format!("/m3u8/{token}/{task_id}/playlist.m3u8")
                } else {
                    format!("/m3u8/{token}/{task_id}/raw/{}", hex_encode(&abs))
                };
                out.push_str(line);
                out.push('\n');
                out.push_str(&localized);
                out.push('\n');
                i += 2;
                continue;
            }
        }
        if let Some(attrs) = line.strip_prefix("#EXT-X-MEDIA:") {
            out.push_str(&rewrite_attr_uris(&format!("#EXT-X-MEDIA:{attrs}"), &task_url, token, task_id));
            out.push('\n');
            i += 1;
            continue;
        }
        out.push_str(line);
        out.push('\n');
        i += 1;
    }
    playlist_response(out)
}

/// 任意 playlist 透传重写（音轨/字幕 rendition 的 media playlist，不经下载引擎）
async fn raw_playlist(engine: &Arc<TaskManager>, token: &str, task_id: &str, hex: &str) -> Response<BoxBody> {
    let Some(url) = hex_decode(hex) else {
        return text_response(400, "invalid hex url");
    };
    if let Err(reason) = guard_outbound_target(&url) {
        return text_response(403, reason);
    }
    let raw = match fetch_bytes(engine, &url, None).await {
        Ok(b) => b,
        Err(e) => return text_response(502, &format!("raw playlist fetch failed: {e}")),
    };
    let text = String::from_utf8_lossy(&raw);
    let mut out = String::new();
    // P4：BYTERANGE 收紧——分片 URL 编码 ?r=off-len（RFC 8216 §4.3.2.2：
    // 省略 @offset 时按前片结束偏移续算），raw_segment 用它把开放式 Range 的
    // 终点收到块尾，避免 BYTERANGE 单文件变体（410MB main.ts）开放式拉全量
    let mut pending_br: Option<(u64, u64)> = None;
    let mut prev_end: u64 = 0;
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() {
            out.push('\n');
        } else if let Some(spec) = t.strip_prefix("#EXT-X-BYTERANGE:") {
            pending_br = parse_byterange_spec(spec.trim(), prev_end);
            if let Some((off, len)) = pending_br {
                prev_end = off + len;
            }
            out.push_str(t);
            out.push('\n');
        } else if t.starts_with("#EXT-X-KEY:") || t.starts_with("#EXT-X-MAP:") {
            out.push_str(&rewrite_attr_uris(t, &url, token, task_id));
            out.push('\n');
        } else if t.starts_with('#') {
            out.push_str(t);
            out.push('\n');
        } else {
            let abs = pf_parser::resolve_url(&url, t);
            let mut u = format!("/segraw/{token}/{task_id}/{}", hex_encode(&abs));
            if let Some((off, len)) = pending_br.take() {
                u.push_str(&format!("?r={off}-{len}"));
            }
            out.push_str(&u);
            out.push('\n');
        }
    }
    playlist_response(out)
}

/// 解析 BYTERANGE 属性 `len[@offset]`：省略 offset 时按前片结束偏移续算
fn parse_byterange_spec(spec: &str, prev_end: u64) -> Option<(u64, u64)> {
    match spec.split_once('@') {
        Some((len, off)) => Some((off.trim().parse().ok()?, len.trim().parse().ok()?)),
        None => Some((prev_end, spec.trim().parse().ok()?)),
    }
}

/// P4 Range 收紧：起点保留、终点收到块尾（exclusive end = off+len）。
/// 精确区间（a-b）原样（客户端字节对齐依赖）；开放式（a-）/无 Range 才收紧。
fn clamp_range_start_end(range: Option<&str>, br_end: Option<u64>) -> Option<String> {
    match (range, br_end) {
        (None, Some(e)) => {
            if e > 0 {
                Some(format!("bytes=0-{}", e - 1))
            } else {
                None
            }
        }
        (Some(r), Some(e)) => {
            let spec = r.trim().strip_prefix("bytes=")?.trim();
            if let Some(a) = spec.strip_suffix('-') {
                let start: u64 = a.trim().parse().ok()?;
                if start < e {
                    Some(format!("bytes={start}-{}", e - 1))
                } else {
                    None
                }
            } else {
                Some(r.to_string())
            }
        }
        (Some(r), None) => Some(r.to_string()),
        (None, None) => None,
    }
}

/// 任意分片/key 透传（音轨/字幕分片与解密 key）。
/// 关键：**流式透传**（origin body → client 管道，不整段缓冲）。BYTERANGE 单文件变体
/// （gear2/gear5 main.ts 达 124MB/410MB）下 ffmpeg 用开放式 Range（bytes=0-）只读所需
/// 字节即断开——缓冲式回源会撞 30s 整体超时（diag-d 实测）。客户端断开 → 响应体被
/// drop → reqwest 连接同步取消，不浪费带宽。
/// P4 Range 收紧：分片 URL 带 ?r=off-len 时，开放式/无 Range 请求的终点收到块尾
/// （起点保留，客户端按 offset 自行切片），避免单请求拉穿整个 410MB 基线文件。
async fn raw_segment(url: &str, range: Option<&str>, query: Option<&str>) -> Response<BoxBody> {
    let br_end = query.and_then(|q| {
        q.split('&').find_map(|kv| kv.strip_prefix("r=")).and_then(|spec| {
            spec.split_once('-')
                .and_then(|(o, l)| Some(o.trim().parse::<u64>().ok()? + l.trim().parse::<u64>().ok()?))
        })
    });
    let mut req = raw_client().get(url);
    if let Some(r) = clamp_range_start_end(range, br_end) {
        req = req.header("Range", r);
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[pf-proxy] raw 拉取失败 {url}: {e}");
            return text_response(502, &format!("raw fetch failed: {e}"));
        }
    };
    // 状态归一：客户端带 Range → 透传源状态（206 + Content-Range，mpv/ffmpeg 语义）；
    // 客户端无 Range → 即使回源用了收紧 Range（源 206）也对客户端按 200 全量回包
    // （BYTERANGE extent 即分片完整表示；RFC 7233 §4.1 禁止对无 Range 请求回 206）
    let client_ranged = range.is_some();
    let status = if client_ranged { resp.status().as_u16() } else { 200 };
    let headers = resp.headers().clone();
    let has_enc = headers.contains_key("content-encoding");
    let stream = resp.bytes_stream().map(|r| r.map(Frame::data));
    let body = StreamBody::new(stream)
        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { Box::new(e) })
        .boxed();
    let ct = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| content_type_by_ext(url).to_string());
    let mut b = Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::OK))
        .header("content-type", ct)
        .header("accept-ranges", "bytes");
    if client_ranged {
        if let Some(cr) = headers.get("content-range") {
            b = b.header("content-range", cr);
        }
    }
    // content-length 仅在无内容编码时透传（gzip 自动解码会改变实际字节数）
    if !has_enc {
        if let Some(cl) = headers.get("content-length") {
            b = b.header("content-length", cl);
        }
    }
    match b.body(body) {
        Ok(r) => r,
        Err(e) => text_response(502, &format!("raw response build failed: {e}")),
    }
}

/// P7 海报/图片透传：/pic/{token}?u={percent-encoded-url}
/// 全量缓冲（图片小）+ 总超时；带同源 Referer 与浏览器 UA 过基础防盗链。
///
/// P19：结果落 `src_cache(poster)` —— 海报是「已经获取过就该留住」的典型：
/// 同一个 URL 在发现页/收藏/详情弹层会被反复请求，源站图床还常限速。
/// 命中直接回字节（`x-pf-cache: hit`），回源失败且有旧图时降级返回旧图。
async fn pic_passthrough(engine: &TaskManager, query: Option<&str>) -> Response<BoxBody> {
    let Some(raw) = query.and_then(|q| {
        q.split('&').find_map(|kv| kv.strip_prefix("u="))
    }) else {
        return text_response(400, "missing u");
    };
    let u = percent_decode(raw);
    // 基础校验：仅 http(s)，拒空白/控制字符（防 URL 注入）
    if !(u.starts_with("http://") || u.starts_with("https://"))
        || u.bytes().any(|b| b <= 0x20 || b == 0x7f)
        || u.len() > 2048
    {
        return text_response(400, "invalid u");
    }
    // M5：私网/环回目标默认拒绝（海报只应来自公网图床）
    if let Err(reason) = guard_outbound_target(&u) {
        return text_response(403, reason);
    }
    let store = engine.store();
    // 命中新鲜缓存：零回源（海报 TTL 以天计，命中率极高）
    if let Some(hit) = store.src_cache_lookup(pf_engine::KIND_POSTER, &u, pf_engine::now_ms_i64()) {
        if hit.fresh {
            return pic_response(hit.body, "hit");
        }
    }
    // 同源 Referer（防盗链常见要求）
    let referer = if u.starts_with("http://") {
        u.strip_prefix("http://")
    } else {
        u.strip_prefix("https://")
    }
    .and_then(|rest| rest.split('/').next())
    .map(|host| {
        let scheme = if u.starts_with("http://") { "http://" } else { "https://" };
        format!("{scheme}{host}/")
    });
    let mut req = pic_client().get(u.as_str());
    if let Some(r) = referer {
        req = req.header("Referer", r);
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[pf-proxy] pic 拉取失败: {e}");
            // 回源失败：有旧图就给旧图（离线/图床挂掉时列表不至于全是破图）
            if let Some(stale) = store.src_cache_lookup(pf_engine::KIND_POSTER, &u, pf_engine::now_ms_i64()) {
                store.src_cache_note_stale(pf_engine::KIND_POSTER);
                return pic_response(stale.body, "stale");
            }
            return text_response(502, "pic fetch failed");
        }
    };
    if !resp.status().is_success() {
        return text_response(502, &format!("pic upstream {}", resp.status().as_u16()));
    }
    // 上限 10MB（海报足够；防异常大响应占内存）
    let bytes = match resp.bytes().await {
        Ok(b) if b.len() <= 10 * 1024 * 1024 => b,
        Ok(_) => return text_response(502, "pic too large"),
        Err(e) => {
            eprintln!("[pf-proxy] pic 读取失败: {e}");
            return text_response(502, "pic read failed");
        }
    };
    // 落盘：TTL 走策略（默认 7 天）；超过 4MB 的图片 src_cache 会自行拒绝
    let policy = poster_policy(engine);
    store.src_cache_put(
        pf_engine::KIND_POSTER,
        &u,
        &bytes,
        policy.ttl_ms(pf_engine::KIND_POSTER),
        pf_engine::now_ms_i64(),
    );
    store.src_cache_maintain(&policy);
    pic_response(bytes.to_vec(), "miss")
}

/// 按魔数猜图片类型（缓存里只存裸字节，不回存 content-type）
fn sniff_image_type(b: &[u8]) -> &'static str {
    if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if b.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if b.starts_with(b"GIF8") {
        "image/gif"
    } else if b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        "image/webp"
    } else if b.starts_with(b"<svg") || b.starts_with(b"<?xml") {
        "image/svg+xml"
    } else {
        "image/jpeg"
    }
}

fn pic_response(bytes: Vec<u8>, cache_state: &str) -> Response<BoxBody> {
    let ct = sniff_image_type(&bytes);
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", ct)
        .header("cache-control", "public, max-age=86400")
        .header("x-pf-cache", cache_state)
        .body(boxed_full(Bytes::from(bytes)))
        .unwrap_or_else(|_| text_response(500, "pic response build failed"))
}

/// 海报策略读取（settings 查询很轻，但海报是每页几十次的高频路径 → 30s 记忆）
fn poster_policy(engine: &TaskManager) -> pf_engine::SrcCachePolicy {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    static C: std::sync::OnceLock<Mutex<Option<(Instant, pf_engine::SrcCachePolicy)>>> =
        std::sync::OnceLock::new();
    let slot = C.get_or_init(|| Mutex::new(None));
    let mut g = slot.lock().unwrap_or_else(|p| p.into_inner());
    let fresh = g.as_ref().map(|(t, _)| t.elapsed() < Duration::from_secs(30)).unwrap_or(false);
    if !fresh {
        *g = Some((Instant::now(), pf_engine::SrcCachePolicy::load(engine.store())));
    }
    g.as_ref().map(|(_, p)| p.clone()).unwrap_or_default()
}

/// 最小 percent-decode（%XX → 字节；容忍截断/非法序列原样保留）
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 3 <= bytes.len() {
            if let Ok(v) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------- M5/L1：SSRF 私网目标过滤 ----------

/// 本地/局域网部署（LAN NAS、本机测试源）显式放开：设 `PF_PROXY_ALLOW_PRIVATE=1`。
/// 冒烟脚本与开发环境均以此放开；生产默认拒绝经代理触达私网。
fn private_targets_allowed() -> bool {
    std::env::var("PF_PROXY_ALLOW_PRIVATE").map(|v| v == "1").unwrap_or(false)
}

/// 判断 URL 目标是否为环回 / 私网 / 链路本地地址（盲 SSRF 防护）。
/// 仅做字符串层判定（代理解析 DNS 前拦截）；不做 DNS rebinding 深防
/// （token 门禁 + 盲 SSRF 语义下收益有限）。
fn is_private_target(url: &str) -> bool {
    let rest = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
        .unwrap_or(url);
    // 去掉 userinfo 与 path/query
    let hostport = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    let hostport = hostport.rsplit('@').next().unwrap_or(hostport);
    let host = hostport
        .rsplit_once(':')
        .filter(|(h, _)| !h.contains(':')) // 不误切 IPv6 字面量
        .map(|(h, _)| h)
        .unwrap_or(hostport)
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    if host.is_empty() {
        return true;
    }
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") || host.ends_with(".internal") {
        return true;
    }
    // IPv6：环回 / 链路本地 / ULA / IPv4-mapped
    if host.contains(':') {
        return host == "::1"
            || host.starts_with("fe80")
            || host.starts_with("fc")
            || host.starts_with("fd")
            || host.starts_with("::ffff:127.")
            || host.starts_with("::ffff:10.")
            || host.starts_with("::ffff:192.168.");
    }
    // IPv4 点分：逐段判断
    let o: Vec<u32> = host.split('.').filter_map(|s| s.parse().ok()).collect();
    if o.len() != 4 {
        return false; // 纯域名交由默认放行（DNS 层防护超出本层职责）
    }
    let [a, b, _, _] = [o[0], o[1], o[2], o[3]];
    a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))      // CGNAT
        || (a == 169 && b == 254)                     // 链路本地（含云元数据 169.254.169.254）
        || (a == 172 && (16..=31).contains(&b))       // 私网
        || (a == 192 && b == 168)                     // 私网
        || (a == 192 && b == 0 && o[2] == 2)          // 测试网
        || (a == 198 && (b == 18 || b == 19))         // 基准测试网
}

/// 代理回源目标的统一门禁：私网默认拒绝（M5/L1）
fn guard_outbound_target(url: &str) -> Result<(), &'static str> {
    if !private_targets_allowed() && is_private_target(url) {
        return Err("private/loopback target blocked (set PF_PROXY_ALLOW_PRIVATE=1 for LAN sources)");
    }
    Ok(())
}

/// 图片拉取客户端：浏览器 UA（部分图床拒非浏览器 UA）+ 短总超时
fn pic_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")
            .http1_only()
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(15))
            .build()
            .unwrap_or_default()
    })
}

/// 透传专用客户端：无总超时（大文件流式），仅连接/空闲读超时防停摆
fn raw_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            // 浏览器 UA：部分片源 CDN WAF 拦非浏览器 UA（同 pf-parser::BROWSER_UA 口径）
            .user_agent(pf_parser::BROWSER_UA)
            .http1_only()
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default()
    })
}

// ---------- P9b：网盘鉴权透传（稳定 shim URL） ----------

/// shim 路径 owner 段解析：`a-<账号 id>` / `s-<分享 id>`
fn split_owner(owner: &str) -> Option<(Option<String>, Option<String>)> {
    if let Some(id) = owner.strip_prefix("a-") {
        return (!id.is_empty()).then(|| (Some(id.to_string()), None));
    }
    if let Some(id) = owner.strip_prefix("s-") {
        return (!id.is_empty()).then(|| (None, Some(id.to_string())));
    }
    None
}

/// 网盘客户端：**禁用压缩**（gzip 会让 Content-Length 与实际字节数不符，
/// 破坏 `<video>` / mpv 的 Range 语义），无总超时（大文件流式），仅空闲读超时兜底
fn nd_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .no_gzip()
            .no_deflate()
            .no_brotli()
            .http1_only()
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(60))
            .build()
            .unwrap_or_default()
    })
}

fn nd_content_type(url: &str) -> &'static str {
    let lower = url.split('?').next().unwrap_or(url).to_ascii_lowercase();
    if lower.ends_with(".mp4") || lower.ends_with(".m4v") {
        "video/mp4"
    } else if lower.ends_with(".mkv") {
        "video/x-matroska"
    } else if lower.ends_with(".webm") {
        "video/webm"
    } else if lower.ends_with(".ts") {
        "video/mp2t"
    } else if lower.ends_with(".mov") {
        "video/quicktime"
    } else {
        "application/octet-stream"
    }
}

/// 带 provider 请求头向网盘发起请求（Cookie / Referer / UA 由适配器给出）
async fn nd_send(
    target: &pf_netdisk::PlayTarget,
    range: Option<&str>,
) -> Result<reqwest::Response, String> {
    let mut req = nd_client().get(&target.url);
    for (k, v) in &target.headers {
        req = req.header(k.as_str(), v.as_str());
    }
    if let Some(r) = range {
        req = req.header("Range", r);
    }
    req.send().await.map_err(|e| format!("{e}"))
}

/// 网盘文件透传（DESIGN §4.7）：
///  1. 用账号/分享 + fileId 解析直链（缓存命中则零网络）
///  2. 注入 provider 请求头 + Range 透传
///  3. **直链失效（401/403/410）→ 强制换链 → 重试一次**（有效期刷新机制）
///
/// 播放器只看到 `/nd/{secret}/.../v.mp4`，直链短命特性对内隐藏。
async fn nd_stream(
    engine: &Arc<TaskManager>,
    owner: &str,
    file_id: &str,
    range: Option<&str>,
    head: bool,
) -> Response<BoxBody> {
    // L4：HEAD 用 1 字节 Range 探测（bytes=0-0），总长从 Content-Range 提取；
    // 早期实现对 HEAD 也发起整文件 GET，白耗带宽与源站配额
    let upstream_range = if head { Some("bytes=0-0") } else { range };
    let Some((account, share)) = split_owner(owner) else {
        return text_response(400, "invalid owner");
    };
    let svc = engine.netdisk();
    let mut target = match svc
        .resolve(account.as_deref(), share.as_deref(), file_id, false)
        .await
    {
        Ok(t) => t,
        Err(e) => {
            eprintln!("[pf-proxy] 网盘直链解析失败 {owner}/{file_id}: {e}");
            return text_response(502, &format!("netdisk resolve failed: {e}"));
        }
    };
    let mut resp = match nd_send(&target, upstream_range).await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[pf-proxy] 网盘拉取失败 {owner}/{file_id}: {e}");
            return text_response(502, &format!("netdisk fetch failed: {e}"));
        }
    };
    let mut status = resp.status().as_u16();

    if matches!(status, 401 | 403 | 410) {
        eprintln!(
            "[pf-proxy] 网盘直链失效（{status}），强制换链后重试：{owner}/{file_id}"
        );
        match svc
            .resolve(account.as_deref(), share.as_deref(), file_id, true)
            .await
        {
            Ok(t) => {
                target = t;
                match nd_send(&target, upstream_range).await {
                    Ok(r) => {
                        status = r.status().as_u16();
                        resp = r;
                    }
                    Err(e) => {
                        return text_response(502, &format!("netdisk retry failed: {e}"));
                    }
                }
            }
            Err(e) => {
                return text_response(502, &format!("netdisk re-resolve failed: {e}"));
            }
        }
    }

    if !(200..300).contains(&status) {
        return text_response(502, &format!("netdisk upstream {status}"));
    }

    let headers = resp.headers().clone();
    let ct = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.starts_with("application/octet-stream"))
        .map(|s| s.to_string())
        .unwrap_or_else(|| nd_content_type(&target.url).to_string());
    let client_ranged = range.is_some();
    // 无 Range 请求不得回 206（RFC 7233 §4.1）；此处源通常直接 200
    let status_out = if client_ranged { status } else { 200 };

    // HEAD 探测分支：长度取 Content-Range total（bytes 0-0/N 的 N）
    if head {
        let total = headers
            .get("content-range")
            .and_then(|v| v.to_str().ok())
            .and_then(|cr| cr.rsplit('/').next())
            .and_then(|n| n.trim().parse::<u64>().ok())
            .or_else(|| headers.get("content-length").and_then(|v| v.to_str().ok()).and_then(|n| n.parse::<u64>().ok()));
        let mut b = Response::builder()
            .status(StatusCode::OK)
            .header("content-type", ct)
            .header("accept-ranges", "bytes");
        if let Some(t) = total {
            b = b.header("content-length", t.to_string());
        }
        return b
            .body(boxed_full(Bytes::new()))
            .unwrap_or_else(|_| text_response(500, "response build failed"));
    }

    let mut b = Response::builder()
        .status(StatusCode::from_u16(status_out).unwrap_or(StatusCode::OK))
        .header("content-type", ct)
        .header("accept-ranges", "bytes");
    if client_ranged {
        if let Some(cr) = headers.get("content-range") {
            b = b.header("content-range", cr);
        }
    }
    if let Some(cl) = headers.get("content-length") {
        b = b.header("content-length", cl);
    }
    let stream = resp.bytes_stream().map(|r| r.map(Frame::data));
    let body = StreamBody::new(stream)
        .map_err(|e| -> Box<dyn std::error::Error + Send + Sync> { Box::new(e) })
        .boxed();
    match b.body(body) {
        Ok(r) => r,
        Err(e) => text_response(502, &format!("netdisk response build failed: {e}")),
    }
}

/// HEX 路径解码（raw 路由用）
fn hex_decode(s: &str) -> Option<String> {
    if s.len() % 2 != 0 || !s.bytes().all(|b| b.is_ascii_hexdigit()) || s.len() > 4096 {
        return None;
    }
    let bytes: Vec<u8> = (0..s.len())
        .step_by(2)
        .filter_map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect();
    String::from_utf8(bytes).ok()
}

/// URL → 十六进制路径段
fn hex_encode(s: &str) -> String {
    s.bytes().map(|b| format!("{b:02x}")).collect()
}

/// HLS 属性串分词：逗号分隔（引号内逗号不分），返回 (KEY, 原始值含引号, 去引号值)
fn attr_pairs(attrs: &str) -> Vec<(String, String, String)> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_q = false;
    for ch in attrs.chars() {
        match ch {
            '"' => {
                in_q = !in_q;
                cur.push(ch);
            }
            ',' if !in_q => {
                out.push(cur.clone());
                cur.clear();
            }
            _ => cur.push(ch),
        }
    }
    if !cur.trim().is_empty() {
        out.push(cur);
    }
    out.into_iter()
        .filter_map(|kv| {
            let (k, v) = kv.split_once('=')?;
            let k = k.trim().to_string();
            let raw = v.trim().to_string();
            let unq = raw.trim_matches('"').to_string();
            Some((k, raw, unq))
        })
        .collect()
}

/// #EXT-X-KEY / #EXT-X-MAP / #EXT-X-MEDIA 行的 URI 属性本地化：
/// KEY → /keyraw（key 透传）；MAP（init 段）→ /segraw（分片透传）；
/// MEDIA（rendition 是 playlist）→ /m3u8/.../raw（走重写路由，其内部分片再本地化）
fn rewrite_attr_uris(line: &str, base_url: &str, token: &str, task_id: &str) -> String {
    let (tag, attrs) = match line.split_once(':') {
        Some((t, a)) => (t, a),
        None => return line.to_string(),
    };
    let route = match tag {
        "#EXT-X-KEY" => format!("keyraw/{token}/{task_id}"),
        "#EXT-X-MEDIA" => format!("m3u8/{token}/{task_id}/raw"),
        _ => format!("segraw/{token}/{task_id}"),
    };
    let mut out = String::from(tag);
    out.push(':');
    let mut first = true;
    for (k, raw, unq) in attr_pairs(attrs) {
        if !first {
            out.push(',');
        }
        first = false;
        if k == "URI" {
            let abs = pf_parser::resolve_url(base_url, &unq);
            out.push_str(&format!("URI=\"/{route}/{}\"", hex_encode(&abs)));
        } else {
            out.push_str(&k);
            out.push('=');
            out.push_str(&raw);
        }
    }
    out
}

/// 按 URL 扩展名推断透传 Content-Type
fn content_type_by_ext(url: &str) -> &'static str {
    let lower = url.split('?').next().unwrap_or(url).to_ascii_lowercase();
    if lower.ends_with(".ts") {
        "video/mp2t"
    } else if lower.ends_with(".m4s") {
        "video/iso.segment"
    } else if lower.ends_with(".mp4") || lower.ends_with(".m4a") {
        "audio/mp4"
    } else if lower.ends_with(".vtt") || lower.ends_with(".webvtt") {
        "text/vtt"
    } else if lower.ends_with(".m3u8") {
        "application/vnd.apple.mpegurl"
    } else {
        "application/octet-stream"
    }
}

fn playlist_response(body: String) -> Response<BoxBody> {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/vnd.apple.mpegurl")
        .header("cache-control", "no-store")
        .body(boxed_full(Bytes::from(body)))
        .unwrap()
}

/// 按分片原始扩展名推断 Content-Type
async fn seg_content_type(engine: &Arc<TaskManager>, task_id: &str, seq: u64) -> &'static str {
    let uri = engine.segment_uri(task_id, seq).await.unwrap_or_default();
    let lower = uri.to_ascii_lowercase();
    if lower.ends_with(".ts") {
        "video/mp2t"
    } else if lower.ends_with(".m4s") || lower.ends_with(".mp4") {
        "video/iso.segment"
    } else {
        "application/octet-stream"
    }
}

/// media playlist 重写：分片 → /seg，key → /key，保留时长/序号/加密语义
pub fn build_playlist(ir: &MediaIR, keys: &[pf_parser::KeyInfo], task_id: &str, token: &str) -> String {
    let track = match ir.tracks.iter().max_by_key(|t| t.bandwidth.unwrap_or(0)) {
        Some(t) => t,
        None => return String::new(),
    };
    let target = track
        .segments
        .iter()
        .map(|s| s.duration)
        .fold(0.0f64, f64::max)
        .ceil()
        .max(1.0) as u64;

    // P4 live 滑动窗口：直播流只输出最近 8 片 + MEDIA-SEQUENCE 随窗口前移
    // （hls.js 跟播语义；远历史分片不再出现在 playlist，引擎水位调度天然不预取）
    const LIVE_WINDOW: usize = 8;
    let segs: Vec<&pf_parser::Segment> = if ir.live && track.segments.len() > LIVE_WINDOW {
        track.segments[track.segments.len() - LIVE_WINDOW..].iter().collect()
    } else {
        track.segments.iter().collect()
    };
    let first = segs.first().map(|s| s.seq).unwrap_or(0);

    let mut out = String::from("#EXTM3U\n#EXT-X-VERSION:3\n");
    out.push_str(&format!("#EXT-X-TARGETDURATION:{target}\n"));
    out.push_str(&format!("#EXT-X-MEDIA-SEQUENCE:{first}\n"));

    // 哨兵初值：确保首分片即使是未加密也显式输出 METHOD=NONE（hls.js 语义更稳）
    let mut cur_key_sig: Option<String> = Some(String::from("\u{0}__init__"));
    for seg in &segs {
        // P2：AES-128 分片已在本地解密落盘，对播放器按未加密输出（METHOD=NONE）；
        // SAMPLE-AES 等无法本地解密的保留 key 重写指向 /key 透传
        let eff = seg
            .key
            .as_ref()
            .filter(|k| !k.method.eq_ignore_ascii_case("AES-128"));
        let sig = eff.map(|k| format!("{}|{}", k.method, k.uri));
        if sig != cur_key_sig {
            match eff {
                Some(k) => {
                    let idx = keys.iter().position(|x| x == k).unwrap_or(0);
                    out.push_str(&format!("#EXT-X-KEY:METHOD={}", k.method));
                    out.push_str(&format!(",URI=\"/key/{token}/{task_id}/{idx}\""));
                    if let Some(iv) = &k.iv {
                        out.push_str(&format!(",IV=\"{iv}\""));
                    }
                    out.push('\n');
                }
                None => out.push_str("#EXT-X-KEY:METHOD=NONE\n"),
            }
            cur_key_sig = sig;
        }
        out.push_str(&format!("#EXTINF:{:.6},\n", seg.duration));
        if let Some((off, len)) = seg.byterange {
            out.push_str(&format!("#EXT-X-BYTERANGE:{len}@{off}\n"));
        }
        out.push_str(&format!("/seg/{token}/{task_id}/{}\n", seg.seq));
    }
    if !ir.live {
        out.push_str("#EXT-X-ENDLIST\n");
    }
    out
}

fn bytes_response(status: u16, bytes: &[u8], content_type: &str) -> Response<BoxBody> {
    Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .header("content-type", content_type)
        .header("access-control-allow-origin", "*")
        .body(boxed_full(Bytes::copy_from_slice(bytes)))
        .unwrap()
}

fn text_response(status: u16, body: &str) -> Response<BoxBody> {
    Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .header("content-type", "text/plain; charset=utf-8")
        .body(boxed_full(Bytes::copy_from_slice(body.as_bytes())))
        .unwrap()
}

fn json_response(status: u16, body: &'static str) -> Response<BoxBody> {
    Response::builder()
        .status(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
        .header("content-type", "application/json")
        .body(boxed_full(Bytes::from_static(body.as_bytes())))
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use pf_parser::{KeyInfo, Segment, Track, TrackKind};

    fn fixture_ir() -> MediaIR {
        let key = KeyInfo {
            method: "AES-128".into(),
            uri: "https://cdn.example.com/v9/key.bin".into(),
            iv: Some("0xabcdef".into()),
        };
        MediaIR {
            tracks: vec![Track {
                kind: TrackKind::Video,
                bandwidth: Some(2227464),
                resolution: Some("960x540".into()),
                codecs: None,
                segments: vec![
                    Segment {
                        seq: 0,
                        duration: 9.009,
                        uri: "https://cdn.example.com/v9/fileSequence0.ts".into(),
                        byterange: None,
                        key: Some(key.clone()),
                    },
                    Segment {
                        seq: 1,
                        duration: 8.5,
                        uri: "https://cdn.example.com/v9/fileSequence1.ts".into(),
                        byterange: None,
                        key: Some(key.clone()),
                    },
                    Segment {
                        seq: 2,
                        duration: 9.0,
                        uri: "https://cdn.example.com/v9/fileSequence2.ts".into(),
                        byterange: None,
                        key: None,
                    },
                ],
            }],
            live: false,
            total_duration: Some(26.509),
            map_uri: None,
        }
    }

    #[test]
    fn rewrites_segments_and_strips_aes128_key() {
        let ir = fixture_ir();
        let keys = engine_keys(&ir);
        let out = build_playlist(&ir, &keys, "task-1", "tok123");
        assert!(out.starts_with("#EXTM3U"));
        assert!(out.contains("#EXT-X-TARGETDURATION:10"));
        assert!(out.contains("#EXT-X-MEDIA-SEQUENCE:0"));
        // P2：AES-128 已本地解密 → 对播放器输出 METHOD=NONE，且不下发 key URI
        assert!(out.contains("#EXT-X-KEY:METHOD=NONE"));
        assert!(!out.contains("/key/"));
        assert!(!out.contains("AES-128"));
        assert!(out.contains("#EXTINF:9.009000,"));
        assert!(out.contains("/seg/tok123/task-1/0"));
        assert!(out.contains("/seg/tok123/task-1/1"));
        assert!(!out.contains("cdn.example.com"));
        assert!(out.ends_with("#EXT-X-ENDLIST\n"));
    }

    /// SAMPLE-AES 无法本地解密 → 保留重写 key URI（/key 透传）
    #[test]
    fn rewrites_sample_aes_key() {
        let mut ir = fixture_ir();
        for seg in ir.tracks[0].segments.iter_mut() {
            if let Some(k) = &mut seg.key {
                k.method = "SAMPLE-AES".into();
            }
        }
        let keys: Vec<pf_parser::KeyInfo> = ir
            .tracks[0]
            .segments
            .iter()
            .filter_map(|s| s.key.clone())
            .collect();
        let out = build_playlist(&ir, &keys, "task-1", "tok123");
        assert!(out.contains("#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"/key/tok123/task-1/0\""));
        assert!(out.contains("IV=\"0xabcdef\""));
    }

    fn engine_keys(ir: &MediaIR) -> Vec<pf_parser::KeyInfo> {
        ir.tracks[0]
            .segments
            .iter()
            .filter_map(|s| s.key.clone())
            .filter(|k| !k.method.eq_ignore_ascii_case("AES-128"))
            .collect()
    }

    #[test]
    fn live_playlist_has_no_endlist() {
        let mut ir = fixture_ir();
        ir.live = true;
        let out = build_playlist(&ir, &[], "t", "k");
        assert!(!out.contains("#EXT-X-ENDLIST"));
    }

    /// P4 live 滑动窗口：>8 片只输出最近 8 片 + MEDIA-SEQUENCE 前移到窗口首片
    #[test]
    fn live_playlist_sliding_window() {
        let mut ir = fixture_ir(); // 3 片
        ir.live = true;
        for i in 3..12 {
            ir.tracks[0].segments.push(Segment {
                seq: i,
                duration: 4.0,
                uri: format!("seg{i}.ts"),
                byterange: None,
                key: None,
            });
        }
        // 签名 (ir, keys, task_id, token)：token="t"、task_id="k" → /seg/t/k/{seq}
        let out = build_playlist(&ir, &[], "k", "t");
        assert!(out.contains("#EXT-X-MEDIA-SEQUENCE:4")); // 12 片 → 窗口 4..12
        assert!(out.contains("/seg/t/k/11"));
        assert!(!out.contains("/seg/t/k/3\n"));
        // VOD 不裁窗
        let out2 = build_playlist(&fixture_ir(), &[], "k", "t");
        assert!(out2.contains("#EXT-X-MEDIA-SEQUENCE:0"));
        assert!(out2.contains("/seg/t/k/2"));
    }

    /// P4 BYTERANGE 续算与 Range 收紧
    #[test]
    fn byterange_spec_and_range_clamp() {
        // 省略 @offset → 前片结束偏移续算
        assert_eq!(parse_byterange_spec("1000", 5000), Some((5000, 1000)));
        assert_eq!(parse_byterange_spec("1000@200", 9999), Some((200, 1000)));
        assert_eq!(parse_byterange_spec("bad", 0), None);
        // 无 Range + 块尾 → 0..end-1
        assert_eq!(clamp_range_start_end(None, Some(1024)), Some("bytes=0-1023".into()));
        // 开放式 → 终点收紧（起点保留）
        assert_eq!(
            clamp_range_start_end(Some("bytes=0-"), Some(1024)),
            Some("bytes=0-1023".into())
        );
        assert_eq!(
            clamp_range_start_end(Some("bytes=200-"), Some(1024)),
            Some("bytes=200-1023".into())
        );
        // 起点越过块尾 → 不发（空区间）
        assert_eq!(clamp_range_start_end(Some("bytes=2000-"), Some(1024)), None);
        // 精确区间原样（客户端字节对齐）
        assert_eq!(
            clamp_range_start_end(Some("bytes=10-99"), Some(1024)),
            Some("bytes=10-99".into())
        );
        // 无块尾 → 原样透传
        assert_eq!(clamp_range_start_end(Some("bytes=0-"), None), Some("bytes=0-".into()));
        assert_eq!(clamp_range_start_end(None, None), None);
    }

    /// P4 MP4 /file Range 头解析（单区间三种形态）
    #[test]
    fn http_range_parsing() {
        assert_eq!(parse_http_range("bytes=100-199", 1000), Some((100, 199)));
        assert_eq!(parse_http_range("bytes=100-", 1000), Some((100, 999)));
        assert_eq!(parse_http_range("bytes=-300", 1000), Some((700, 999)));
        assert_eq!(parse_http_range("bytes=-0", 1000), None);
        assert_eq!(parse_http_range("bytes=abc-", 1000), None);
        assert_eq!(parse_http_range("multipart", 1000), None);
        // end 越界由调用方 min(total-1) 收敛（这里验证解析不误伤）
        assert_eq!(parse_http_range("bytes=0-999999", 1000), Some((0, 999999)));
    }

    /// P9b 网盘 shim：owner 段（账号/分享）解析与内容类型兜底
    #[test]
    fn netdisk_shim_owner_and_content_type() {
        let (a, s) = split_owner("a-acc123").unwrap();
        assert_eq!(a.as_deref(), Some("acc123"));
        assert!(s.is_none());
        let (a, s) = split_owner("s-share9").unwrap();
        assert!(a.is_none());
        assert_eq!(s.as_deref(), Some("share9"));
        // 非法 owner 段一律拒绝（防路径穿越/空 id）
        assert!(split_owner("acc123").is_none());
        assert!(split_owner("a-").is_none());
        assert!(split_owner("s-").is_none());
        assert!(split_owner("x-1").is_none());

        assert_eq!(nd_content_type("https://cdn/x/a.MP4?sig=1"), "video/mp4");
        assert_eq!(nd_content_type("https://cdn/x/a.mkv"), "video/x-matroska");
        assert_eq!(nd_content_type("https://cdn/x/a.unknown"), "application/octet-stream");
    }
}
