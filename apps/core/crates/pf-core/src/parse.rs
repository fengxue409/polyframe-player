//! P10 视频云解析（DESIGN §10）
//!
//! 职责：解析接口（第三方 `?url=` 云解析）的增删改查与测活、以及「页面地址 → 可播直链」
//! 的三段式解析编排。纯文本判定在 `pf-parser::parseurl`，持久化在
//! `pf-engine::parse_store`，本模块只做网络编排 + 出参序列化（camelCase 与
//! packages/shared 同构）。
//!
//! 三段式（越靠前越优先，能落地的能力越多）：
//!  1. **直链**：接口直接返回 JSON/HTML 里的 m3u8/mp4 → 交给本地代理边下边播（可缓存、可 mpv）
//!  2. **嗅探**：HTML 播放页由主进程用隐藏窗口实跑 JS，从网络请求里截 m3u8（前端触发）
//!  3. **内嵌**：界面 iframe 直接嵌播放页（X-Frame-Options 允许时）
//!
//! 解析接口的生存期极短，任何失败都必须给出可操作的原因（关停 / 超时 / 空响应），
//! 不能一律报「解析失败」。

use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use pf_engine::{CacheStore, ParseServiceRow, SrcCachePolicy, TaskManager};
use pf_parser::parseurl;
use serde_json::{json, Value};

use crate::parse_presets::{self, DIRECT_API};
use crate::srccache::{peek_fresh, remember};
use crate::{error_response, ok_response};

/// 单次解析请求超时（含接口服务端自己回源的时间，12s 已覆盖大多数）
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(12);
/// 测活超时（只打接口首页，不需要等回源）
const PROBE_TIMEOUT: Duration = Duration::from_secs(6);

/// 浏览器 UA：解析接口基本都拦非浏览器 UA
/// （注意与 catalog 的 `PolyFrame/0.1` 相反 —— 采集站只认简单 UA）
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                         (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(BROWSER_UA)
            .http1_only()
            .connect_timeout(Duration::from_secs(6))
            .redirect(reqwest::redirect::Policy::limited(8))
            .build()
            .unwrap_or_default()
    })
}

fn rand_id() -> String {
    use rand::Rng;
    let b: [u8; 16] = rand::thread_rng().gen();
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn str_param<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params.get(key).and_then(|v| v.as_str())
}

/// 接口归一：去空白；`direct://` 哨兵放行；其余必须 http(s)，去尾 `/`
fn normalize_api(api: &str) -> String {
    let t = api.trim();
    if t == DIRECT_API {
        return t.to_string();
    }
    let t = t.trim_end_matches('/');
    if t.starts_with("http://") || t.starts_with("https://") {
        t.to_string()
    } else {
        String::new()
    }
}

// ---------- 出厂播种 ----------

/// 仅当 parse_services 表为空时播种（用户删光后不被强制复活）
pub fn ensure_builtin_parses(store: &pf_engine::CacheStore) {
    let Ok(existing) = store.list_parse_services() else {
        return;
    };
    if !existing.is_empty() {
        return;
    }
    for (name, api) in parse_presets::PRESETS {
        let _ = store.insert_parse_service(&rand_id(), name, api, true, true);
    }
}

/// 把失效特征串说成人话：关停模板 vs 通用错误页（404/502/503）分开表述
fn dead_label(marker: &str) -> String {
    let generic = ["not found", "502 bad gateway", "503 service unavailable"];
    if generic.contains(&marker) {
        format!("接口返回错误页（{marker}）")
    } else {
        format!("接口已关停（响应含「{marker}」）")
    }
}

// ---------- 测活 ----------

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Probe {
    ok: bool,
    latency_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}

impl Probe {
    fn fail(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            latency_ms: None,
            error: Some(msg.into()),
            note: None,
        }
    }
    fn pass(ms: i64, note: Option<String>) -> Self {
        Self {
            ok: true,
            latency_ms: Some(ms),
            error: None,
            note,
        }
    }
}

/// 测活：只打接口首页（不带 url 参数），因此「能连上」≠「能解析」，
/// 但对用户区分「域名已死」和「接口能用但没解析出片」已经够用。
async fn probe_api(api: &str) -> Probe {
    let api = api.trim();
    if api == DIRECT_API {
        return Probe::pass(0, Some("内置直连嗅探，不依赖第三方接口".into()));
    }
    // 首页 = 去掉 query 的接口地址
    let base = api.split(['?', '#']).next().unwrap_or(api);
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Probe::fail("接口地址无效");
    }
    let t0 = Instant::now();
    let resp = match client()
        .get(base)
        .timeout(PROBE_TIMEOUT)
        .header("Accept", "text/html,application/json;q=0.9,*/*;q=0.8")
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            let msg = if e.is_timeout() {
                "连接超时（域名可能已失效）".to_string()
            } else if e.is_connect() {
                "无法连接（DNS 或端口不通）".to_string()
            } else {
                format!("请求失败：{e}")
            };
            return Probe::fail(msg);
        }
    };
    let status = resp.status();
    let head = resp.text().await.unwrap_or_default();
    let ms = t0.elapsed().as_millis() as i64;
    if let Some(marker) = parseurl::dead_marker(&head) {
        return Probe::fail(dead_label(marker));
    }
    if status.as_u16() >= 500 {
        return Probe::fail(format!("服务端错误 HTTP {}", status.as_u16()));
    }
    let note = if status.as_u16() >= 400 {
        Some(format!("HTTP {}（服务在线但首页不可用）", status.as_u16()))
    } else if !parseurl::looks_like_player_page(&head) {
        Some("响应不像播放器页，可能已改版".into())
    } else {
        None
    };
    Probe::pass(ms, note)
}

// ---------- 解析（页面地址 → 直链 / 播放页） ----------

/// 解析结果（与 packages/shared 的 ParseResolveResult 同构）
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Resolved {
    /// direct = 已拿直链；page = 只能内嵌/嗅探
    kind: &'static str,
    page_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    parse_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    play_url: Option<String>,
    candidates: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    service_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    service_name: Option<String>,
    latency_ms: i64,
    /// 直链来源：input / json / html
    via: &'static str,
    /// 播放页能否 iframe 内嵌（X-Frame-Options / CSP 判定）
    frameable: bool,
    /// 响应里有播放器痕迹（用于提示「接口能解析但需要嗅探」）
    player_like: bool,
    /// P19：直链来自缓存（未回源解析接口）
    cached: bool,
    /// P19：缓存写入时刻（毫秒）
    #[serde(skip_serializing_if = "Option::is_none")]
    cached_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}

/// M6：限量读取解析接口响应体（HTML 页面 8MB 足够；防异常接口推大响应占内存）
async fn read_limited_text(mut resp: reqwest::Response) -> Result<String, String> {
    const MAX: usize = 8 * 1024 * 1024;
    if let Some(len) = resp.content_length() {
        if len as usize > MAX {
            return Err(format!("响应体超限（{len} > {MAX} 字节）"));
        }
    }
    let mut out: Vec<u8> = Vec::with_capacity(64 * 1024);
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("读取响应失败：{e}"))? {
        if out.len() + chunk.len() > MAX {
            return Err(format!("响应体超限（>{MAX} 字节）"));
        }
        out.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

async fn fetch_parse_page(parse_url: &str, referer: &str) -> Result<(String, String), String> {
    let resp = client()
        .get(parse_url)
        .timeout(RESOLVE_TIMEOUT)
        .header("Referer", referer)
        .header("Accept", "text/html,application/json;q=0.9,*/*;q=0.8")
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "接口响应超时（12s）".to_string()
            } else if e.is_connect() {
                "接口无法连接（域名可能已失效）".to_string()
            } else {
                format!("接口请求失败：{e}")
            }
        })?;
    let status = resp.status();
    let ctype = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let xfo = resp
        .headers()
        .get("x-frame-options")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let csp = resp
        .headers()
        .get("content-security-policy")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let text = read_limited_text(resp).await?;
    if status.as_u16() >= 400 {
        return Err(format!("接口返回 HTTP {}", status.as_u16()));
    }
    let blocked = parseurl::frame_blocked(xfo.as_deref(), csp.as_deref());
    // 用 ctype 打头塞进 meta，避免再定义一个结构体
    let meta = format!("{ctype}|{}", if blocked { "block" } else { "ok" });
    Ok((text, meta))
}

/// 解析入口：service 为 None 时按「直连嗅探」处理
///
/// P19：接口解析出的**直链**按 `pageUrl|api` 缓存一小段时间（默认 10 分钟）——
/// 同一集反复点播（暂停后重进、连播重试）不必每次再打一次解析接口；
/// 不回退过期直链（签名链过期会让播放器报误导性的错），只认新鲜命中。
async fn resolve_page(
    store: &CacheStore,
    policy: &SrcCachePolicy,
    page: &str,
    service: Option<&ParseServiceRow>,
) -> Result<Resolved, String> {
    let page_url = parseurl::normalize_page_url(page).ok_or("请输入合法的视频页面地址（http/https）")?;

    // 1) 本身就是直链：不打扰任何接口
    if parseurl::is_media_url(&page_url) {
        return Ok(Resolved {
            kind: "direct",
            page_url: page_url.clone(),
            parse_url: None,
            play_url: Some(page_url),
            candidates: vec![],
            service_id: service.map(|s| s.id.clone()),
            service_name: service.map(|s| s.name.clone()),
            latency_ms: 0,
            via: "input",
            frameable: false,
            player_like: false,
            cached: false,
            cached_at_ms: None,
            note: Some("输入本身就是媒体直链，直接播放".into()),
        });
    }

    let (api, sid, sname) = match service {
        Some(s) if s.api != DIRECT_API => (s.api.clone(), Some(s.id.clone()), Some(s.name.clone())),
        // 2) 直连嗅探 / 未选接口：交给主进程嗅探
        _ => {
            return Ok(Resolved {
                kind: "page",
                page_url,
                parse_url: None,
                play_url: None,
                candidates: vec![],
                service_id: sid_none(service),
                service_name: sname_none(service),
                latency_ms: 0,
                via: "page",
                frameable: true,
                player_like: false,
                cached: false,
                cached_at_ms: None,
                note: Some("不用接口，直接嗅探页面里的播放地址".into()),
            })
        }
    };

    // 2.5) 直链缓存：新鲜命中直接返回，连接口都不碰
    let cache_key = format!("{page_url}|{api}");
    if let Some((body, mark)) = peek_fresh(store, pf_engine::KIND_PARSE_LINK, &cache_key) {
        if let Some(link) = Some(body.trim().to_string()).filter(|s| !s.is_empty()) {
            return Ok(Resolved {
                kind: "direct",
                page_url: page_url.clone(),
                parse_url: Some(parseurl::build_parse_url(&api, &page_url)),
                play_url: Some(link.clone()),
                candidates: vec![link],
                service_id: sid,
                service_name: sname,
                latency_ms: 0,
                via: "cache",
                frameable: true,
                player_like: true,
                cached: true,
                cached_at_ms: Some(mark.stored_at_ms),
                note: Some("命中直链缓存，未回源解析接口".into()),
            });
        }
    }

    let parse_url = parseurl::build_parse_url(&api, &page_url);
    let t0 = Instant::now();
    let (text, meta) = fetch_parse_page(&parse_url, &page_url).await?;
    let latency = t0.elapsed().as_millis() as i64;
    let mut parts = meta.split('|');
    let ctype = parts.next().unwrap_or("");
    let frameable = parts.next().unwrap_or("ok") != "block";

    if let Some(marker) = parseurl::dead_marker(&text) {
        return Err(format!("{}，请换一个接口或导入新的", dead_label(marker)));
    }

    // 3) JSON 接口：优先取直链
    let is_json = ctype.contains("json")
        || text.trim_start().starts_with('{')
        || text.trim_start().starts_with('[');
    let mut candidates: Vec<String> = Vec::new();
    let mut via = "html";
    if is_json {
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            parseurl::collect_json_media(&v, &mut candidates);
            via = "json";
        }
        // JSON 里也可能把 URL 转义进字符串，兜底再扫一遍原文
        if candidates.is_empty() {
            candidates = parseurl::extract_media(&text, &parse_url);
            via = "json";
        }
    } else {
        candidates = parseurl::extract_media(&text, &parse_url);
    }

    if let Some(first) = candidates.first().cloned() {
        remember(store, policy, pf_engine::KIND_PARSE_LINK, &cache_key, &first);
        return Ok(Resolved {
            kind: "direct",
            page_url,
            parse_url: Some(parse_url),
            play_url: Some(first),
            candidates,
            service_id: sid,
            service_name: sname,
            latency_ms: latency,
            via,
            frameable,
            player_like: true,
            cached: false,
            cached_at_ms: None,
            note: None,
        });
    }

    // 4) 没直链：能内嵌就内嵌，内嵌不了交给主进程嗅探
    let player_like = parseurl::looks_like_player_page(&text);
    let note = if player_like {
        Some("播放页已就绪，正片地址在页面内动态加载（可嗅探或内嵌播放）".to_string())
    } else if text.trim().is_empty() {
        Some("接口返回空响应".to_string())
    } else {
        Some("响应里没有播放器也没有直链，接口可能已改版".to_string())
    };
    Ok(Resolved {
        kind: "page",
        page_url,
        parse_url: Some(parse_url),
        play_url: None,
        candidates,
        service_id: sid,
        service_name: sname,
        latency_ms: latency,
        via: "page",
        frameable,
        player_like,
        cached: false,
        cached_at_ms: None,
        note,
    })
}

fn sid_none(s: Option<&ParseServiceRow>) -> Option<String> {
    s.map(|x| x.id.clone())
}
fn sname_none(s: Option<&ParseServiceRow>) -> Option<String> {
    s.map(|x| x.name.clone())
}

// ---------- RPC 入口 ----------

/// parse.* 方法处理（rest = method 去掉 "parse." 前缀）
/// 返回 None 表示方法未识别（由 main.rs 报 -32601）
pub async fn handle(
    rest: &str,
    params: &Value,
    id: Value,
    engine: &Arc<TaskManager>,
) -> Option<String> {
    // 先判归属：未识别方法要留给 main.rs 统一报 -32601（不能变成 -32000）
    let known = rest.starts_with("service.") || rest == "resolve";
    if !known {
        return None;
    }
    Some(match dispatch(rest, params, engine).await {
        Ok(v) => ok_response(id, v),
        Err((code, msg)) => error_response(id, code, &msg),
    })
}

async fn dispatch(
    rest: &str,
    params: &Value,
    engine: &Arc<TaskManager>,
) -> Result<Value, (i32, String)> {
    let store = engine.store();
    let result: Result<Value, (i32, String)> = match rest {
        "service.list" => store
            .list_parse_services()
            .map(|rows| {
                json!({
                    "services": rows,
                    "presetsVersion": parse_presets::PRESET_VERSION,
                    "directApi": DIRECT_API,
                })
            })
            .map_err(|e| (-32000, e)),

        "service.add" => {
            let name = str_param(params, "name").unwrap_or_default().trim().to_string();
            let api = normalize_api(str_param(params, "api").unwrap_or_default());
            if name.is_empty() || api.is_empty() {
                Err((-32602, "invalid params: name / api required".into()))
            } else if store.get_parse_service_by_api(&api).ok().flatten().is_some() {
                Err((-32000, "该接口地址已存在".into()))
            } else {
                let sid = rand_id();
                if let Err(e) = store.insert_parse_service(&sid, &name, &api, true, false) {
                    return Err((-32000, e));
                }
                let probe = probe_api(&api).await;
                let row = store
                    .update_parse_service(&sid, None, None, None, probe.latency_ms, probe.ok)
                    .map_err(|e| (-32000, e))?;
                Ok(json!({ "service": row, "probe": probe }))
            }
        }

        "service.update" => {
            let sid = str_param(params, "id").unwrap_or_default();
            if sid.is_empty() {
                return Err((-32602, "invalid params: id required".into()));
            }
            let name = str_param(params, "name").map(|s| s.trim().to_string());
            let api = str_param(params, "api").map(normalize_api);
            if matches!(&api, Some(a) if a.is_empty()) {
                return Err((-32602, "接口地址无效".into()));
            }
            let enabled = params.get("enabled").and_then(|v| v.as_bool());
            let row = store
                .update_parse_service(
                    sid,
                    name.as_deref(),
                    api.as_deref(),
                    enabled,
                    None,
                    false,
                )
                .map_err(|e| (-32000, e))?
                .ok_or((-32000, "接口不存在".to_string()))?;
            Ok(json!({ "service": row }))
        }

        "service.remove" => {
            let sid = str_param(params, "id").unwrap_or_default();
            let removed = store.delete_parse_service(sid).map_err(|e| (-32000, e))?;
            // P19：直链缓存 key 是 `pageUrl|api`，删接口后无法按 api 前缀批量失效
            // （api 在尾部），直链缓存本身 TTL 只有 10 分钟且总量很小，直接全清
            store.src_cache_clear(Some(pf_engine::KIND_PARSE_LINK));
            Ok(json!({ "removed": removed }))
        }

        "service.probe" => {
            // id 优先，其次直接给 api（未入库的地址也能先测再存）
            let (api, sid) = if let Some(sid) = str_param(params, "id").filter(|s| !s.is_empty()) {
                match store.get_parse_service(sid).map_err(|e| (-32000, e))? {
                    Some(row) => (row.api, Some(row.id)),
                    None => return Err((-32000, "接口不存在".into())),
                }
            } else {
                let api = normalize_api(str_param(params, "api").unwrap_or_default());
                if api.is_empty() {
                    return Err((-32602, "invalid params: id or api required".into()));
                }
                (api, None)
            };
            let probe = probe_api(&api).await;
            if let Some(sid) = sid {
                let _ = store.update_parse_service(&sid, None, None, None, probe.latency_ms, probe.ok);
            }
            Ok(json!({ "probe": probe }))
        }

        "service.presets" => {
            let existing = store.list_parse_services().map_err(|e| (-32000, e))?;
            let installed: std::collections::HashSet<&str> =
                existing.iter().map(|s| s.api.as_str()).collect();
            let presets: Vec<Value> = parse_presets::PRESETS
                .iter()
                .map(|(name, api)| {
                    json!({
                        "name": name,
                        "api": api,
                        "installed": installed.contains(*api),
                        "direct": *api == DIRECT_API,
                    })
                })
                .collect();
            Ok(json!({ "presets": presets, "version": parse_presets::PRESET_VERSION }))
        }

        "service.sync_presets" => {
            let existing = store.list_parse_services().map_err(|e| (-32000, e))?;
            let have: std::collections::HashSet<String> =
                existing.into_iter().map(|s| s.api).collect();
            let mut added = 0u32;
            for (name, api) in parse_presets::PRESETS {
                if have.contains(*api) {
                    continue;
                }
                if store
                    .insert_parse_service(&rand_id(), name, api, true, true)
                    .is_ok()
                {
                    added += 1;
                }
            }
            Ok(json!({ "added": added, "version": parse_presets::PRESET_VERSION }))
        }

        "resolve" => {
            let url = str_param(params, "url").unwrap_or_default();
            if url.trim().is_empty() {
                return Err((-32602, "invalid params: url required".into()));
            }
            // 服务选择：id 优先；显式 api 次之；都没有 → 直连嗅探
            let service = if let Some(sid) = str_param(params, "serviceId").filter(|s| !s.is_empty()) {
                store.get_parse_service(sid).map_err(|e| (-32000, e))?
            } else if let Some(api) = str_param(params, "api").filter(|s| !s.trim().is_empty()) {
                Some(ParseServiceRow {
                    id: String::new(),
                    name: "临时接口".into(),
                    api: normalize_api(api),
                    enabled: true,
                    builtin: false,
                    latency_ms: None,
                    last_ok_at: None,
                    created_at: String::new(),
                })
            } else {
                None
            };
            match resolve_page(store, &SrcCachePolicy::load(store), url, service.as_ref()).await {
                Ok(r) => Ok(serde_json::to_value(r).map_err(|e| (-32000, e.to_string()))?),
                Err(e) => Err((-32000, e)),
            }
        }

        _ => return Err((-32601, format!("method not found: parse.{rest}"))),
    };

    result
}
