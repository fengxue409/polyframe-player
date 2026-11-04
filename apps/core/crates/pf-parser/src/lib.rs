//! pf-parser：协议探测与解析
//!
//! P0：仅基于 URL 特征的同步判定（无网络）。
//! P1：拉取 HLS master/media playlist，产出 MediaIR 统一中间表示（DESIGN.md §4.1）。
//!     DASH(MPD) 归一化留待 P5；MP4 直链 Range 聚合留待 P4；AES-128 解密执行留待 P2。

use serde::{Deserialize, Serialize};
use url::Url;

pub mod cms;
pub mod parseurl;
pub mod sourcelist;

/// 视频协议类型（与 packages/shared 的 Protocol 同构）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    Hls,
    Dash,
    Mp4,
    Unknown,
}

/// 解析结果（P0 中间表示的最小集）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseResult {
    pub protocol: Protocol,
    pub url: String,
}

// ---------- MediaIR 统一中间表示（DESIGN §4.1） ----------

/// 轨道类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackKind {
    Video,
    Audio,
    Subtitle,
}

/// 解密信息（P1 仅记录并在重写 playlist 时本地化 URI；解密执行在 P2）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyInfo {
    /// AES-128 / SAMPLE-AES
    pub method: String,
    /// 已解析为绝对 URL
    pub uri: String,
    /// 0x 前缀 hex 或十进制（按规范原样保留）
    pub iv: Option<String>,
}

/// 分片（调度原子单元）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Segment {
    /// 媒体序列号（从 EXT-X-MEDIA-SEQUENCE 起算）
    pub seq: u64,
    /// 时长（秒）
    pub duration: f64,
    /// 绝对 URL（解析时已按 playlist base 解析）
    pub uri: String,
    /// (offset, length)，来自 EXT-X-BYTERANGE；P1 仅记录不执行
    pub byterange: Option<(u64, u64)>,
    /// 当前生效的解密信息（NONE 后为 None）
    pub key: Option<KeyInfo>,
}

/// 轨道（variant 流）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Track {
    pub kind: TrackKind,
    pub bandwidth: Option<u64>,
    /// 如 "640x360"
    pub resolution: Option<String>,
    /// 如 "avc1.64001f,mp4a.40.2"
    pub codecs: Option<String>,
    pub segments: Vec<Segment>,
}

/// 统一中间表示
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaIR {
    pub tracks: Vec<Track>,
    /// 直播流（无 EXT-X-ENDLIST）；P1 按创建时刻的快照处理，滑动窗口留 P2
    pub live: bool,
    /// VOD 总时长（秒）
    pub total_duration: Option<f64>,
    /// EXT-X-MAP init 段绝对 URL（fMP4；P6 合并导出前置拼接用）
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub map_uri: Option<String>,
}

/// master playlist 中的变体条目
#[derive(Debug, Clone)]
pub struct MasterVariant {
    pub uri: String,
    pub bandwidth: Option<u64>,
    pub resolution: Option<String>,
    pub codecs: Option<String>,
}

// ---------- URL 特征探测（P0） ----------

/// 判定 URL 指向的媒体协议：去掉 query/hash 后按扩展名匹配。
pub fn detect(url: &str) -> Protocol {
    let path = url
        .split(['?', '#'])
        .next()
        .unwrap_or(url)
        .to_ascii_lowercase();
    if path.ends_with(".m3u8") || path.contains(".m3u8/") {
        Protocol::Hls
    } else if path.ends_with(".mpd") || path.contains(".mpd/") {
        Protocol::Dash
    } else if path.ends_with(".mp4") {
        Protocol::Mp4
    } else {
        Protocol::Unknown
    }
}

/// 该 URL 本身是否已是媒体直链（决定解析失败后还要不要走页面提取）。
///
/// 与 `detect` 的区别：除标准扩展名外，还认得采集站常见的 `index.m3u8/xxx`、
/// `/hls/` 形态，避免把「明确是 m3u8 的地址」误当网页去扫。
pub fn looks_like_media_url(url: &str) -> bool {
    if detect(url) != Protocol::Unknown {
        return true;
    }
    let path = url
        .split(['?', '#'])
        .next()
        .unwrap_or(url)
        .to_ascii_lowercase();
    path.contains("/hls/") || path.contains("m3u8") || path.contains("/mp4/")
}

/// 便捷入口：返回带回填 URL 的解析结果
pub fn parse(url: &str) -> ParseResult {    ParseResult {
        protocol: detect(url),
        url: url.to_string(),
    }
}

// ---------- MP4 直链探测与块化（P4，DESIGN §5） ----------

/// MP4 探测：首块 Range 请求字节数（同时验证 206 能力 + 产出 hash 指纹）
pub const MP4_PROBE_BYTES: u64 = 16 * 1024;
/// MP4 P2SP 分块大小（min_split_size 2MiB 的 2 倍，4MiB 平衡请求数与回源延迟）
pub const MP4_CHUNK: u64 = 4 * 1024 * 1024;

/// MP4 直链探测结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mp4Probe {
    /// 文件总字节数（Content-Range "bytes 0-16383/12345678" 末段）
    pub content_length: u64,
    /// 首块（≤16KB）SHA-256 指纹（hex 前 16 字符）：多镜像字节一致性预检，
    /// 不一致 = 不是同一文件，禁止跨源混拼
    pub first_sha: String,
}

/// Range 请求探测 MP4 直链：HTTP 206 + Content-Range 总长 + 首块 hash。
/// 服务器不支持 Range（200/416 等）→ 直接报错（P2SP 前提不成立）。
pub async fn probe_mp4(client: &reqwest::Client, url: &str) -> Result<Mp4Probe, String> {
    let resp = client
        .get(url)
        .header("Range", format!("bytes=0-{}", MP4_PROBE_BYTES - 1))
        .send()
        .await
        .map_err(|e| format!("MP4 探测请求失败 {url}: {e}"))?;
    let status = resp.status().as_u16();
    if status != 206 {
        return Err(format!("源不支持 Range 请求（HTTP {status}），无法启用 P2SP：{url}"));
    }
    let cr = resp
        .headers()
        .get("content-range")
        .and_then(|v| v.to_str().ok())
        .ok_or("206 响应缺少 Content-Range 头")?
        .to_string();
    let total: u64 = cr
        .rsplit('/')
        .next()
        .and_then(|s| s.trim().parse().ok())
        .ok_or_else(|| format!("Content-Range 解析失败: {cr}"))?;
    let bytes = resp.bytes().await.map_err(|e| format!("读取失败: {e}"))?;
    Ok(Mp4Probe {
        content_length: total,
        first_sha: sha256_hex16(&bytes),
    })
}

/// SHA-256 → hex（取前 16 字符作为短指纹，防碰撞足够：镜像误判需 64bit 前缀冲突）
pub fn sha256_hex16(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    let out = h.finalize();
    out.iter().map(|b| format!("{b:02x}")).collect::<String>()[..16].to_string()
}

/// MP4 直链 → 块化 MediaIR：按 MP4_CHUNK 切块，每块一个 BYTERANGE Segment
/// （复用 P1 的 BYTERANGE 下载管线：自动 Range 头 / 幂等清单 / 水位调度）。
/// duration 恒 0（进度按块数/字节记账），total_duration None（播放器自取 moov 元数据）。
pub fn build_mp4_ir(url: &str, content_length: u64, chunk: u64) -> MediaIR {
    let chunk = chunk.max(1);
    let mut segments = Vec::new();
    let mut off: u64 = 0;
    while off < content_length {
        let len = (content_length - off).min(chunk);
        segments.push(Segment {
            seq: segments.len() as u64,
            duration: 0.0,
            uri: url.to_string(),
            byterange: Some((off, len)),
            key: None,
        });
        off += len;
    }
    MediaIR {
        tracks: vec![Track {
            kind: TrackKind::Video,
            bandwidth: None,
            resolution: None,
            codecs: None,
            segments,
        }],
        live: false,
        total_duration: None,
        map_uri: None,
    }
}

// ---------- HLS 解析 ----------

/// 相对 URI → 绝对 URL（基于 playlist 地址）
pub fn resolve_url(base: &str, uri: &str) -> String {
    if uri.starts_with("http://") || uri.starts_with("https://") {
        return uri.to_string();
    }
    match Url::parse(base) {
        Ok(b) => b.join(uri).map(|u| u.to_string()).unwrap_or_else(|_| uri.to_string()),
        Err(_) => uri.to_string(),
    }
}

/// 解析 HLS 属性行（KEY=VALUE,KEY="VALUE,..."），兼容引号内逗号
pub fn parse_attributes(line: &str) -> Vec<(String, String)> {
    let mut parts = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    for ch in line.chars() {
        match ch {
            '"' => {
                in_quotes = !in_quotes;
                cur.push(ch);
            }
            ',' if !in_quotes => {
                parts.push(std::mem::take(&mut cur));
            }
            _ => cur.push(ch),
        }
    }
    if !cur.trim().is_empty() {
        parts.push(cur);
    }
    parts
        .into_iter()
        .filter_map(|p| {
            let (k, v) = p.split_once('=')?;
            Some((
                k.trim().to_ascii_uppercase(),
                v.trim().trim_matches('"').to_string(),
            ))
        })
        .collect()
}

/// master playlist → variant 列表
pub fn parse_master(text: &str, base_url: &str) -> Result<Vec<MasterVariant>, String> {
    let mut variants = Vec::new();
    let mut pending: Option<MasterVariant> = None;
    for raw in text.lines() {
        let line = raw.trim();
        if let Some(attrs_str) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            let get = |k: &str| {
                parse_attributes(attrs_str)
                    .into_iter()
                    .find(|(a, _)| a == k)
                    .map(|(_, v)| v)
            };
            pending = Some(MasterVariant {
                uri: String::new(),
                bandwidth: get("BANDWIDTH").and_then(|v| v.parse().ok()),
                resolution: get("RESOLUTION"),
                codecs: get("CODECS"),
            });
        } else if !line.starts_with('#') && !line.is_empty() {
            if let Some(mut v) = pending.take() {
                v.uri = resolve_url(base_url, line);
                variants.push(v);
            }
        }
    }
    if variants.is_empty() {
        Err("master playlist 未找到任何 variant".into())
    } else {
        Ok(variants)
    }
}

/// media playlist → MediaIR（单视频轨道；音轨/字幕轨道归并留 P2）
pub fn parse_media(text: &str, base_url: &str) -> Result<MediaIR, String> {
    // HLS 规范：playlist 必须以 #EXTM3U 开头。不校验的话，包装播放器的 HTML 页
    // （如极速源 /play/<hash> 返回 DPlayer 页）会被当「全是裸行分片」的清单解析：
    // HTML 源码行 → 0 时长伪分片 + 无 ENDLIST → live 语义，起播必坏。
    // 校验失败报错，由上层（引擎 extract_fallback）走站点提取兜底。
    let head = text.trim_start_matches('\u{feff}').trim_start();
    if !head.starts_with("#EXTM3U") {
        return Err("响应不是 m3u8 播放列表（疑似网页），需走站点提取".into());
    }
    let mut segments: Vec<Segment> = Vec::new();
    let mut media_sequence: u64 = 0;
    let mut cur_key: Option<KeyInfo> = None;
    let mut pending_dur: Option<f64> = None;
    let mut pending_byterange: Option<(u64, u64)> = None;
    // BYTERANGE 省略 @offset 时按上一分片结束偏移续算（RFC 8216 §4.3.2.2）
    let mut byterange_next_off: u64 = 0;
    let mut live = true;
    let mut map_uri: Option<String> = None;

    for raw in text.lines() {
        let line = raw.trim();
        if let Some(rest) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            media_sequence = rest.trim().parse().unwrap_or(0);
        } else if let Some(rest) = line.strip_prefix("#EXT-X-KEY:") {
            let get = |k: &str| {
                parse_attributes(rest)
                    .into_iter()
                    .find(|(a, _)| a == k)
                    .map(|(_, v)| v)
            };
            let method = get("METHOD").unwrap_or_default();
            if method.is_empty() || method == "NONE" {
                cur_key = None;
            } else if let Some(kuri) = get("URI") {
                cur_key = Some(KeyInfo {
                    method,
                    uri: resolve_url(base_url, &kuri),
                    iv: get("IV"),
                });
            }
        } else if let Some(rest) = line.strip_prefix("#EXT-X-MAP:") {
            // fMP4 init 段（P6 合并导出前置拼接；BYTERANGE 变体极罕见，暂不处理）
            let uri = parse_attributes(rest)
                .into_iter()
                .find(|(a, _)| a == "URI")
                .map(|(_, v)| v);
            if let Some(u) = uri {
                map_uri = Some(resolve_url(base_url, &u));
            }
        } else if let Some(rest) = line.strip_prefix("#EXTINF:") {
            // 形如 "9.009," —— 取逗号前的时长
            pending_dur = rest.split(',').next().and_then(|d| d.trim().parse().ok());
        } else if let Some(rest) = line.strip_prefix("#EXT-X-BYTERANGE:") {
            // 形如 "length[@offset]"；offset 缺省 = 上一分片结束处
            let mut it = rest.trim().split('@');
            let len = it.next().and_then(|v| v.parse().ok());
            let off = it.next().and_then(|v| v.parse().ok());
            if let Some(len) = len {
                let start = off.unwrap_or(byterange_next_off);
                pending_byterange = Some((start, len));
                byterange_next_off = start + len;
            }
        } else if line == "#EXT-X-ENDLIST" {
            live = false;
        } else if !line.starts_with('#') && !line.is_empty() {
            let dur = pending_dur.take().unwrap_or(0.0);
            segments.push(Segment {
                seq: media_sequence + segments.len() as u64,
                duration: dur,
                uri: resolve_url(base_url, line),
                byterange: pending_byterange.take(),
                key: cur_key.clone(),
            });
        }
    }
    if segments.is_empty() {
        return Err("media playlist 未找到任何分片".into());
    }
    let total: f64 = segments.iter().map(|s| s.duration).sum();
    Ok(MediaIR {
        tracks: vec![Track {
            kind: TrackKind::Video,
            bandwidth: None,
            resolution: None,
            codecs: None,
            segments,
        }],
        live,
        total_duration: Some(total),
        map_uri,
    })
}

// ---------- 网络加载 ----------

/// M6：限量读取响应体 —— Content-Length 预检 + 流式累计截断。
/// 恶意源可省略 Content-Length 推 GB 级响应打爆内存（订阅导入已有 4MB 上限，
/// 此处对 playlist/文本资源统一限量）。
const FETCH_TEXT_MAX: usize = 16 * 1024 * 1024;

async fn read_limited(resp: &mut reqwest::Response, max: usize, url: &str) -> Result<Vec<u8>, String> {
    if let Some(len) = resp.content_length() {
        if len as usize > max {
            return Err(format!("响应体超限（{len} > {max} 字节）{url}"));
        }
    }
    let mut out: Vec<u8> = Vec::with_capacity(64 * 1024);
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("读取失败 {url}: {e}"))? {
        if out.len() + chunk.len() > max {
            return Err(format!("响应体超限（>{max} 字节）{url}"));
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// 浏览器 UA（重试伪装用，与 pf-proxy pic_client 同口径）
pub const BROWSER_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/// 软失败（值得重试）：403（WAF/防盗链风控，如非凡 ffzy CDN）、425/429（频控）、5xx（边缘节点抖动）。
/// 404/401 等确定性失败不重试，避免无谓拖延。
fn is_soft_failure(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 403 | 425 | 429) || status.is_server_error()
}

/// 拉取文本资源。
///
/// 部分片源 CDN 的 WAF 会按客户端特征/频率/边缘节点间歇性拦截（实测 ffzy 同一
/// URL curl 常态 200、应用内偶发 403，且隔几分钟自愈），属「稍后重试即可」的
/// 软失败。重试策略（0/500ms/1.5s/3s 共四次尝试，单次上限 8s）：
/// - 重试一律伪装浏览器 UA（绕开非浏览器指纹拦截）
/// - 重试改用**新建的独立 client**：新 TLS 会话 + 新连接池，避开被风控标记的
///   连接复用，大概率路由到不同边缘节点（同一 client 复用连接会一直命中同一节点）
/// - **响应体读取错误（连接中断/gzip 解码失败）同属软失败**：多源实测 100 条
///   中 5 条失败全部集中在此阶段，且同 URL 稍后重试即成功
/// - 「响应体超限」为确定性失败，不重试
/// - 最坏总耗时 ~4×8s+5s≈37s/次拉取；task.create RPC 放宽 75s 覆盖 master+variant 链式两拉
///
/// 解析类拉取的进程级并发闸门。
///
/// 用户连续点多个视频时，前端会并发发多个 `task.create`，每个都要拉 playlist
/// （master + variant 两跳）。实测 16 路并发打同一 CDN 时，单请求会被拖到 8s 超时，
/// 重试把总延迟推到 ~19s，极端情况直接失败（「点几个就播不了」）。这些请求都很小，
/// 限 8 路并发既不会拖慢单次，又能避免自己把自己打满。
///
/// 闸门**按单次尝试**申请、读完即放（不是罩住整条重试链）：否则 8 个坏 URL
/// 会把 8 个名额各占 37s，健康请求只能干等。
fn fetch_gate() -> &'static tokio::sync::Semaphore {
    static GATE: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    GATE.get_or_init(|| tokio::sync::Semaphore::new(8))
}

pub async fn fetch_text(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let RETRY_DELAYS_MS: [u64; 3] = [500, 1500, 3000];
    const ATTEMPT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);
    let mut last_err = String::new();
    for attempt in 0..=RETRY_DELAYS_MS.len() {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(RETRY_DELAYS_MS[attempt - 1])).await;
        }
        // 首次用调用方 client（连接池/头策略由上游定）；重试换新 client + 浏览器 UA
        let retry_client;
        let effective: &reqwest::Client = if attempt == 0 {
            client
        } else {
            retry_client = reqwest::Client::builder()
                .user_agent(BROWSER_UA)
                .build()
                .map_err(|e| format!("构建重试 client 失败: {e}"))?;
            &retry_client
        };
        // 只在这一跳的 I/O 期间占名额；重试间隔与等待退避时不占用
        let _permit = match fetch_gate().acquire().await {
            Ok(p) => p,
            Err(e) => return Err(format!("解析闸门关闭: {e}")),
        };
        match effective.get(url).timeout(ATTEMPT_TIMEOUT).send().await {
            Ok(resp) => {
                if resp.status().is_success() {
                    let mut resp = resp;
                    match read_limited(&mut resp, FETCH_TEXT_MAX, url).await {
                        Ok(bytes) => return Ok(String::from_utf8_lossy(&bytes).into_owned()),
                        Err(e) => {
                            if e.starts_with("响应体超限") {
                                return Err(e); // 内容性失败，重试无意义
                            }
                            last_err = e; // 读取中断/解码失败 → 软失败，继续重试
                        }
                    }
                } else {
                    let status = resp.status();
                    if !is_soft_failure(status) {
                        return Err(format!("HTTP {} {url}", status));
                    }
                    last_err = format!("HTTP {} {url}", status);
                }
            }
            Err(e) => last_err = format!("请求失败 {url}: {e}"),
        }
    }
    Err(last_err)
}

/// 加载入口：master → 最高码率 variant → MediaIR；直接给 media playlist 也兼容
pub async fn load(client: &reqwest::Client, url: &str) -> Result<MediaIR, String> {
    let text = fetch_text(client, url).await?;
    if text.contains("#EXT-X-STREAM-INF") {
        let variants = parse_master(&text, url)?;
        let best = variants
            .iter()
            .max_by_key(|v| v.bandwidth.unwrap_or(0))
            .ok_or("master playlist 无可用 variant")?;
        let vtext = fetch_text(client, &best.uri).await?;
        let mut ir = parse_media(&vtext, &best.uri)?;
        if let Some(t) = ir.tracks.first_mut() {
            t.bandwidth = best.bandwidth;
            t.resolution = best.resolution.clone();
            t.codecs = best.codecs.clone();
        }
        Ok(ir)
    } else {
        parse_media(&text, url)
    }
}

// ---------- P6 站点提取兜底（DESIGN §4.1：非媒体 URL 交提取器） ----------

/// 从 HTML 页面文本扫描内嵌媒体链接（m3u8 / mpd / mp4，大小写不敏感）。
/// 策略：枚举全部引号包夹字面量，按扩展名命中；相对路径按 base_url 归一；
/// 去重保序，上限 20 条。零正则依赖，覆盖 <video src> / hls.js 配置 /
/// JSON 内嵌等常见直嵌场景。
pub fn scan_html(html: &str, base_url: &str) -> Vec<String> {
    const EXTS: [&str; 3] = [".m3u8", ".mpd", ".mp4"];
    let mut out: Vec<String> = Vec::new();
    let mut push = |raw: &str| {
        let cand = raw.trim().trim_matches(|c| c == '\'' || c == '"');
        // URL 合法性预过滤：跨引号拼接产生的垃圾段必含空白/尖括号
        if cand.is_empty()
            || cand.chars().any(|c| c.is_whitespace() || c == '<' || c == '>')
        {
            return;
        }
        let lower = cand.to_ascii_lowercase();
        let path_end = lower.find(['?', '#']).unwrap_or(lower.len());
        if !EXTS.iter().any(|e| lower[..path_end].ends_with(e)) {
            return;
        }
        if cand.starts_with("data:") || cand.starts_with("blob:") {
            return;
        }
        // 相对路径归一（resolve_url 对绝对 URL 原样返回）
        let abs = resolve_url(base_url, cand);
        if !out.contains(&abs) {
            out.push(abs);
        }
    };
    for seg in html.split('"') {
        push(seg);
    }
    // 单引号字面量再扫一轮（attrs/json 单引号场景）
    for seg in html.split('\'') {
        push(seg);
    }
    out.truncate(20);
    out
}

/// 站点提取第一步：抓取页面 → scan_html 扫描候选流
pub async fn extract_from_page(client: &reqwest::Client, url: &str) -> Result<Vec<String>, String> {
    let html = fetch_text(client, url).await?;
    Ok(scan_html(&html, url))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_protocols() {
        assert_eq!(
            detect("https://a.com/x/bipbop_16x9_variant.m3u8"),
            Protocol::Hls
        );
        assert_eq!(detect("https://a.com/x.m3u8?token=1"), Protocol::Hls);
        assert_eq!(detect("https://a.com/manifest.mpd"), Protocol::Dash);
        assert_eq!(detect("https://a.com/video.mp4?range=0-1"), Protocol::Mp4);
        assert_eq!(detect("https://a.com/page"), Protocol::Unknown);
    }

    #[test]
    fn parses_attributes_with_quoted_comma() {
        let attrs = parse_attributes(
            r#"BANDWIDTH=2227464,RESOLUTION=960x540,CODECS="avc1.64001f,mp4a.40.2""#,
        );
        assert_eq!(attrs[0], ("BANDWIDTH".into(), "2227464".into()));
        assert_eq!(attrs[1], ("RESOLUTION".into(), "960x540".into()));
        assert_eq!(attrs[2], ("CODECS".into(), "avc1.64001f,mp4a.40.2".into()));
    }

    /// P6：HTML 页面扫描站点提取候选
    #[test]
    fn scans_html_for_media_links() {
        let base = "https://site.example/watch/42";
        let html = r#"<html>
          <video src="/media/ep1.m3u8?token=abc"></video>
          <script>var cfg = { url: "https://cdn.example.com/hd/ep1.m3u8", poster: 'x.jpg' };</script>
          <a href="/sub/track.mpd">dash</a>
          <img src="/img/poster.jpg">
          <span data-u='https://cdn.example.com/v/clip.mp4'></span>
        </html>"#;
        let got = scan_html(html, base);
        assert_eq!(
            got,
            vec![
                "https://site.example/media/ep1.m3u8?token=abc",
                "https://cdn.example.com/hd/ep1.m3u8",
                "https://site.example/sub/track.mpd",
                "https://cdn.example.com/v/clip.mp4"
            ]
        );
        // 无候选 / data: 与 blob: 排除 / 上限 20
        assert!(scan_html("<p>hello world</p>", base).is_empty());
        assert!(scan_html(
            r#"<video src="blob:https://x/y.m3u8"></video><img src="data:image/png;base64,AAA">"#,
            base
        )
        .is_empty());
        let many: String = (0..30).map(|i| format!(r#""https://c.example/{i}.m3u8""#)).collect();
        assert_eq!(scan_html(&many, base).len(), 20);
    }

    /// MP4 块化 IR：整除/非整除/空文件三种形态
    #[test]
    fn builds_mp4_ir_chunks() {
        let url = "https://cdn.example.com/v/BigBuckBunny.mp4";
        // 10MiB / 4MiB → 3 块（4+4+2）
        let ir = build_mp4_ir(url, 10 * 1024 * 1024, MP4_CHUNK);
        let segs = &ir.tracks[0].segments;
        assert_eq!(segs.len(), 3);
        assert!(!ir.live);
        assert_eq!(ir.total_duration, None);
        assert_eq!(segs[0].byterange, Some((0, MP4_CHUNK)));
        assert_eq!(segs[2].byterange, Some((2 * MP4_CHUNK, 2 * 1024 * 1024))); // 尾块 2MiB
        // 尾块与全量校验
        let total: u64 = segs.iter().map(|s| s.byterange.unwrap().1).sum();
        assert_eq!(total, 10 * 1024 * 1024);
        // 非 chunk 倍数的极小文件 → 单块
        let small = build_mp4_ir(url, 1024, MP4_CHUNK);
        assert_eq!(small.tracks[0].segments.len(), 1);
        // 0 字节 → 无块（engine 侧应拒绝任务）
        assert!(build_mp4_ir(url, 0, MP4_CHUNK).tracks[0].segments.is_empty());
        // 所有块 uri 指向源文件
        assert!(segs.iter().all(|s| s.uri == url && s.key.is_none() && s.duration == 0.0));
    }

    /// 指纹：相同字节相同指纹、不同字节不同指纹
    #[test]
    fn sha256_fingerprint_stable() {
        let a = b"PolyFrame first block bytes".repeat(4);
        let mut b = a.clone();
        b[0] ^= 0xff;
        assert_eq!(sha256_hex16(&a), sha256_hex16(&a.clone()));
        assert_ne!(sha256_hex16(&a), sha256_hex16(&b));
        assert_eq!(sha256_hex16(&a).len(), 16);
    }

    /// 极速源 /play/<hash> 返回 DPlayer 包装页（text/html）——不能被当成
    /// 「裸行分片」清单解析出 0 时长伪分片（回归：jisuzyv 起播黑屏）
    #[test]
    fn parse_media_rejects_html_page() {
        let html = "<head>\n<meta charset=\"utf-8\">\n\
                    <script src=\"https://s2.pstatp.com/cdn/expire-1-M/hls.js/1.1.5/hls.min.js\"></script>\n\
                    </head>\n<body>\n<div id=\"dplayer\"></div>\n\
                    <script>\n        const vid = 'https://vv.jisuzyv.com/play/elYp21ja/index.m3u8';\n</script>\n\
                    </body>";
        let err = parse_media(html, "https://vv.jisuzyv.com/play/elYp21ja").unwrap_err();
        assert!(err.contains("疑似网页"), "实际错误: {err}");
        // BOM + 前导空白仍要放行合法 m3u8
        let ok = "\u{feff}\n#EXTM3U\n#EXTINF:4,\nseg0.ts\n";
        assert!(parse_media(ok, "https://x/").is_ok());
    }

    #[test]
    fn parses_master_playlist() {
        let base = "https://cdn.example.com/live/bipbop_16x9_variant.m3u8";
        let master = "#EXTM3U\n\
                      #EXT-X-STREAM-INF:BANDWIDTH=2227464,RESOLUTION=960x540,CODECS=\"avc1.64001f,mp4a.40.2\"\n\
                      v9/prog_index.m3u8\n\
                      #EXT-X-STREAM-INF:BANDWIDTH=474560,RESOLUTION=400x300\n\
                      v5/prog_index.m3u8\n";
        let variants = parse_master(master, base).unwrap();
        assert_eq!(variants.len(), 2);
        assert_eq!(variants[0].bandwidth, Some(2227464));
        assert_eq!(
            variants[0].uri,
            "https://cdn.example.com/live/v9/prog_index.m3u8"
        );
        assert_eq!(variants[1].resolution.as_deref(), Some("400x300"));
    }

    #[test]
    fn parses_media_playlist_vod_with_key() {
        let base = "https://cdn.example.com/live/v9/prog_index.m3u8";
        let media = "#EXTM3U\n\
                     #EXT-X-VERSION:3\n\
                     #EXT-X-TARGETDURATION:10\n\
                     #EXT-X-MEDIA-SEQUENCE:5\n\
                     #EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",IV=0x10ef8f758ca555115584bb5b3c687f52\n\
                     #EXTINF:9.009,\n\
                     fileSequence0.ts\n\
                     #EXTINF:9.009,\n\
                     fileSequence1.ts\n\
                     #EXT-X-ENDLIST\n";
        let ir = parse_media(media, base).unwrap();
        assert!(!ir.live);
        let segs = &ir.tracks[0].segments;
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].seq, 5);
        assert_eq!(segs[1].seq, 6);
        assert_eq!(segs[0].duration, 9.009);
        assert_eq!(
            segs[0].uri,
            "https://cdn.example.com/live/v9/fileSequence0.ts"
        );
        let key = segs[0].key.as_ref().unwrap();
        assert_eq!(key.method, "AES-128");
        assert_eq!(key.uri, "https://cdn.example.com/live/v9/key.bin");
        assert!(key.iv.as_deref().unwrap().starts_with("0x"));
        assert!((ir.total_duration.unwrap() - 18.018).abs() < 1e-9);
    }

    /// P6：EXT-X-MAP init 段捕获（fMP4 合并导出）
    #[test]
    fn parses_media_playlist_fmp4_map() {
        let base = "https://cdn.example.com/fmp4/prog_index.m3u8";
        let media = "#EXTM3U\n\
                     #EXT-X-VERSION:6\n\
                     #EXT-X-TARGETDURATION:10\n\
                     #EXT-X-MAP:URI=\"init.mp4\"\n\
                     #EXTINF:9.009,\n\
                     seg0.m4s\n\
                     #EXTINF:9.009,\n\
                     seg1.m4s\n\
                     #EXT-X-ENDLIST\n";
        let ir = parse_media(media, base).unwrap();
        assert_eq!(
            ir.map_uri.as_deref(),
            Some("https://cdn.example.com/fmp4/init.mp4")
        );
        // TS 流无 MAP → None
        let ts_ir = parse_media(
            "#EXTM3U\n#EXTINF:9.0,\nseg0.ts\n#EXT-X-ENDLIST\n",
            base,
        )
        .unwrap();
        assert_eq!(ts_ir.map_uri, None);
    }

    #[test]
    fn parses_media_playlist_live_none_key() {
        let base = "https://cdn.example.com/live/v9/prog_index.m3u8";
        let media = "#EXTM3U\n\
                     #EXT-X-TARGETDURATION:10\n\
                     #EXT-X-KEY:METHOD=NONE\n\
                     #EXTINF:9.009,\n\
                     a.ts\n\
                     #EXTINF:8.0,\n\
                     b.ts\n";
        let ir = parse_media(media, base).unwrap();
        assert!(ir.live);
        assert!(ir.total_duration.unwrap() > 0.0);
        assert!(ir.tracks[0].segments[0].key.is_none());
    }

    /// 隔离验证 reqwest 对 Apple CDN 的分片下载（网络用例，手动跑）
    #[tokio::test]
    #[ignore]
    async fn fetch_bipbop_segment() {
        let client = reqwest::Client::builder()
            .user_agent("PolyFrame/0.1")
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap();
        let t0 = std::time::Instant::now();
        let url = "https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/v9/fileSequence0.ts";
        let resp = client.get(url).send().await.unwrap();
        println!("status={} in {:?}", resp.status(), t0.elapsed());
        let bytes = resp.bytes().await.unwrap();
        println!("{} bytes in {:?}", bytes.len(), t0.elapsed());
        assert!(bytes.len() > 100_000);
    }
}
