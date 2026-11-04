//! P14 弹幕：RPC 编排
//!
//! 职责：弹幕设置/凭据持久化、剧集匹配、第三方拉取并落库、本地发送、ASS 导出。
//! 纯逻辑在 `pf-danmaku`（模型/校验/客户端/ASS），持久化在 `pf-engine::danmaku_store`，
//! 本模块只做网络编排 + 出参序列化（camelCase 与 packages/shared 同构）。
//!
//! ## 时间轴策略（重要）
//!
//! **库里永远存弹幕源的原始时间轴**，不做任何缩放。缩放放在渲染侧：
//! 前端拿 `channelDuration`（弹幕源的片长估计）与播放器实际 `duration` 比，
//! 用 `scale_time` 线性贴合。这样换片源不需要重拉弹幕，同一份弹幕能服务
//! 不同剪辑版本，也不会因为反复缩放而累积误差。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use pf_danmaku::{
    guess_episode_no, is_blocked, normalize_anime_title, parse_import, sanitize_blocked_words,
    DanmakuCredentials, DanmakuItem, DanmakuMode, DandanplayClient, SendGuard, SendReject,
};
use pf_engine::{DanmakuChannelRow, TaskManager};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{error_response, ok_response};

/// 把存储层的 `Result<T, String>` 提升为 RPC 错误形态，避免满屏 `.map_err` 样板
trait RpcResultExt<T> {
    fn rpc(self) -> Result<T, (i32, String)>;
}

impl<T> RpcResultExt<T> for Result<T, String> {
    fn rpc(self) -> Result<T, (i32, String)> {
        self.map_err(|e| (-32000, e))
    }
}

/// 已拉取的弹幕在该窗口内直接读库，不重复打第三方接口
const FETCH_TTL_SECS: i64 = 6 * 3600;
/// 弹幕源片长估计的下限（低于此值不采信"最后一条弹幕时间"作为片长）
const MIN_SOURCE_SPAN_SECS: f64 = 60.0;

const KEY_SETTINGS: &str = "danmaku_settings";
const KEY_APP_ID: &str = "danmaku_app_id";
const KEY_APP_SECRET: &str = "danmaku_app_secret";

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

// ---------- 设置（serde default 保证旧版本配置能平滑升级） ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DanmakuSettings {
    /// 弹幕总开关
    pub enabled: bool,
    /// 不透明度 0.1 ~ 1.0
    pub opacity: f64,
    /// 字号倍率 0.6 ~ 1.8
    pub font_scale: f64,
    /// 滚动时长倍率 0.5 ~ 1.5（越大越慢）
    pub speed: f64,
    /// 同屏密度上限倍率 0.1 ~ 1.0
    pub density: f64,
    pub block_scroll: bool,
    pub block_top: bool,
    pub block_bottom: bool,
    /// dandanplay | local | off
    pub provider: String,
    /// 片长不一致时按比例贴合时间轴
    pub auto_scale: bool,
    pub show_send_bar: bool,
    /// 屏蔽词（P15）：任一命中（大小写不敏感）的弹幕不出现在任何渲染路径
    pub blocked_words: Vec<String>,
    /// P17 mpv 高级特效弹幕（透明覆盖层窗口渲染）。关闭时 mpv 侧仍走 ASS 字幕。
    pub fx_overlay: bool,
}

impl Default for DanmakuSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            opacity: 0.9,
            font_scale: 1.0,
            speed: 1.0,
            density: 1.0,
            block_scroll: false,
            block_top: false,
            block_bottom: false,
            provider: "dandanplay".into(),
            auto_scale: true,
            show_send_bar: true,
            blocked_words: Vec::new(),
            fx_overlay: false,
        }
    }
}

impl DanmakuSettings {
    /// 收敛到合法区间。静态设置页允许自由拖动，越界值在这里统一夹住，
    /// 避免脏值传到渲染层导致「弹幕飞出屏幕」这类难查的现象。
    fn clamp(&mut self) {
        self.opacity = self.opacity.clamp(0.1, 1.0);
        self.font_scale = self.font_scale.clamp(0.6, 1.8);
        self.speed = self.speed.clamp(0.5, 1.5);
        self.density = self.density.clamp(0.1, 1.0);
        if !matches!(self.provider.as_str(), "dandanplay" | "local" | "off") {
            self.provider = "dandanplay".into();
        }
        self.blocked_words = sanitize_blocked_words(&self.blocked_words);
    }
}

fn load_settings(store: &pf_engine::CacheStore) -> DanmakuSettings {
    let mut s = store
        .setting_get(KEY_SETTINGS)
        .and_then(|raw| serde_json::from_str::<DanmakuSettings>(&raw).ok())
        .unwrap_or_default();
    s.clamp();
    s
}

fn load_credentials(store: &pf_engine::CacheStore) -> DanmakuCredentials {
    DanmakuCredentials {
        app_id: store.setting_get(KEY_APP_ID).unwrap_or_default(),
        app_secret: store.setting_get(KEY_APP_SECRET).unwrap_or_default(),
    }
}

/// AppId 脱敏展示（前端只用来确认"填过没有"，不回传密文）
fn mask(s: &str) -> String {
    let n = s.chars().count();
    if n <= 4 {
        return "*".repeat(n.max(1));
    }
    let head: String = s.chars().take(4).collect();
    format!("{head}{}", "*".repeat((n - 4).min(8)))
}

// ---------- 频道 ID ----------

/// 频道 = 「一部剧的一集 × 一个弹幕源」。同一集换片源不影响频道，换弹幕源才变。
pub fn channel_id(provider: &str, title: &str, episode: Option<&str>) -> String {
    let mut h = Sha256::new();
    h.update(provider.as_bytes());
    h.update(b"|");
    h.update(title.trim().as_bytes());
    h.update(b"|");
    h.update(episode.unwrap_or("").trim().as_bytes());
    let digest = h.finalize();
    let hex: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    format!("{provider}-{hex}")
}

// ---------- 参数辅助 ----------

fn str_param(p: &Value, k: &str) -> Option<String> {
    p.get(k)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty())
}

fn num_param(p: &Value, k: &str) -> Option<f64> {
    p.get(k).and_then(|v| v.as_f64()).filter(|f| f.is_finite())
}

fn int_param(p: &Value, k: &str) -> Option<i64> {
    p.get(k).and_then(|v| v.as_i64())
}

fn bool_param(p: &Value, k: &str) -> Option<bool> {
    p.get(k).and_then(|v| v.as_bool())
}

fn str_array_param(p: &Value, k: &str) -> Option<Vec<String>> {
    p.get(k)
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
}

/// 屏蔽词过滤（P15）：所有出渲染路径的统一关卡。
/// 过滤在**出参侧**做而不是落库时删 —— 用户改屏蔽词后无需重拉，历史频道即时生效。
fn filter_blocked(items: Vec<DanmakuItem>, words: &[String]) -> Vec<DanmakuItem> {
    if words.is_empty() {
        return items;
    }
    items.into_iter().filter(|i| !is_blocked(&i.text, words)).collect()
}

/// ASS 输出目录：与分片缓存同级但**不在** cache 子树内（cache 会被清理器整目录扫）
fn ass_dir(store: &pf_engine::CacheStore) -> PathBuf {
    store
        .cache_dir()
        .parent()
        .map(|p| p.join("danmaku"))
        .unwrap_or_else(|| PathBuf::from("danmaku"))
}

// ---------- ASS 临时文件治理 ----------
//
// 每集生成一个 `<channelId>.ass`，一个季 24 集就是 24 个文件、几百 KB。
// 单看不大，但频道 ID 是按「片名+集名」哈希的，换片源/改剧名就会再生成一批，
// 长期运行会无上限堆积。治理策略：**按数量 + 按时间双限**，且写文件后顺手跑一次。

/// 最多保留多少个 ASS 文件（超出按 mtime 从旧到新删）
const ASS_KEEP_FILES: usize = 60;
/// 最长保留时间（秒）
const ASS_MAX_AGE_SECS: u64 = 7 * 24 * 3600;

struct AssEntry {
    path: PathBuf,
    mtime: u64,
    size: u64,
}

/// 列出目录里的 `.ass` 文件（读不到 mtime 的条目按 0 处理，视为最旧）
fn ass_entries(dir: &std::path::Path) -> Vec<AssEntry> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in rd.flatten() {
        let path = e.path();
        if path.extension().and_then(|x| x.to_str()) != Some("ass") {
            continue;
        }
        let meta = match e.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !meta.is_file() {
            continue;
        }
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push(AssEntry {
            path,
            mtime,
            size: meta.len(),
        });
    }
    out
}

/// 统计 `(文件数, 总字节)`
fn ass_cache_stat(dir: &std::path::Path) -> (usize, u64) {
    let e = ass_entries(dir);
    (e.len(), e.iter().map(|x| x.size).sum())
}

/// 清理：先删超期的，再按「最新在前」只留 `keep` 个。返回 `(删除数, 释放字节)`。
///
/// `keep = 0` 表示全清（设置页的「立即清空」走这条路）。
fn clean_ass_cache(dir: &std::path::Path, keep: usize, max_age_secs: u64) -> (usize, u64) {
    let mut e = ass_entries(dir);
    if e.is_empty() {
        return (0, 0);
    }
    e.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    let now = now_ms() as u64 / 1000;
    let mut removed = 0usize;
    let mut freed = 0u64;
    for (idx, x) in e.iter().enumerate() {
        let too_old = max_age_secs > 0 && now.saturating_sub(x.mtime) > max_age_secs;
        let over_quota = idx >= keep;
        if !(too_old || over_quota) {
            continue;
        }
        if std::fs::remove_file(&x.path).is_ok() {
            removed += 1;
            freed += x.size;
        }
    }
    (removed, freed)
}

// ---------- 发送守卫（进程级；按频道隔离） ----------

/// 每个频道一个守卫：换集后自动用新频道的新实例，不会继承上一集的去重窗口
fn send_guard() -> &'static std::sync::Mutex<std::collections::HashMap<String, SendGuard>> {
    static G: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, SendGuard>>> =
        std::sync::OnceLock::new();
    G.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn check_send(channel: &str, raw: &str) -> Result<String, SendReject> {
    let mut map = send_guard().lock().unwrap_or_else(|p| p.into_inner());
    // 上限保护：频道数不会很多，但避免长期运行后无限增长
    if map.len() > 64 {
        map.clear();
    }
    let g = map.entry(channel.to_string()).or_default();
    g.check(raw, now_ms() as u64)
}

// ---------- 导出结构 ----------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FetchOutcome {
    channel_id: String,
    provider: String,
    /// 本次返回给前端的条目（可能来自缓存）
    items: Vec<DanmakuItem>,
    count: i64,
    /// 本次新入库条数（缓存命中时为 0）
    added: i64,
    cached: bool,
    /// 弹幕源片长估计（秒）；前端用它和实际片长算缩放
    channel_duration: Option<f64>,
    /// 失败/降级原因（kind），成功时为 null
    error: Option<Value>,
    /// 匹配到的剧集信息（便于前端提示"匹配自《XX》第N话"）
    matched: Option<Value>,
}

// ---------- 主分发 ----------

pub async fn handle(
    rest: &str,
    params: &Value,
    id: Value,
    engine: &Arc<TaskManager>,
) -> Option<String> {
    match handle_inner(rest, params, engine).await {
        Ok(v) => Some(ok_response(id, v)),
        Err((code, msg)) if code == -32601 => {
            let _ = msg;
            None // 未识别方法交给上层报 method not found
        }
        Err((code, msg)) => Some(error_response(id, code, &msg)),
    }
}

async fn handle_inner(
    rest: &str,
    params: &Value,
    engine: &Arc<TaskManager>,
) -> Result<Value, (i32, String)> {
    let store = engine.store();
    match rest {
        // ---------- 设置 ----------
        "settings.get" => {
            let s = load_settings(store);
            let cred = load_credentials(store);
            Ok(json!({
                "settings": s,
                "hasCredentials": cred.is_configured(),
                "appIdMasked": if cred.app_id.is_empty() { Value::Null } else { json!(mask(&cred.app_id)) },
            }))
        }

        "settings.set" => {
            let mut s = load_settings(store);
            let src = params.get("settings").cloned().unwrap_or_else(|| params.clone());
            // 逐字段覆盖（只改传了的字段，避免前端局部更新时把其他项重置）
            macro_rules! apply_num {
                ($f:ident, $k:literal) => {
                    if let Some(v) = num_param(&src, $k) {
                        s.$f = v;
                    }
                };
            }
            macro_rules! apply_bool {
                ($f:ident, $k:literal) => {
                    if let Some(v) = bool_param(&src, $k) {
                        s.$f = v;
                    }
                };
            }
            apply_bool!(enabled, "enabled");
            apply_num!(opacity, "opacity");
            apply_num!(font_scale, "fontScale");
            apply_num!(speed, "speed");
            apply_num!(density, "density");
            apply_bool!(block_scroll, "blockScroll");
            apply_bool!(block_top, "blockTop");
            apply_bool!(block_bottom, "blockBottom");
            apply_bool!(auto_scale, "autoScale");
            apply_bool!(show_send_bar, "showSendBar");
            apply_bool!(fx_overlay, "fxOverlay");
            if let Some(p) = str_param(&src, "provider") {
                s.provider = p;
            }
            if let Some(words) = str_array_param(&src, "blockedWords") {
                s.blocked_words = words;
            }
            s.clamp();
            let raw = serde_json::to_string(&s).map_err(|e| (-32000, e.to_string()))?;
            store.setting_set(KEY_SETTINGS, &raw).rpc()?;
            Ok(json!({ "settings": s }))
        }

        // ---------- 凭据 ----------
        "credentials.set" => {
            let app_id = str_param(params, "appId").unwrap_or_default();
            let secret = str_param(params, "appSecret").unwrap_or_default();
            if app_id.is_empty() || secret.is_empty() {
                Err((-32602, "invalid params: appId / appSecret required".into()))
            } else {
                store.setting_set(KEY_APP_ID, app_id.trim()).rpc()?;
                store.setting_set(KEY_APP_SECRET, secret.trim()).rpc()?;
                Ok(json!({ "saved": true, "appIdMasked": mask(app_id.trim()) }))
            }
        }

        "credentials.clear" => {
            store.setting_set(KEY_APP_ID, "").rpc()?;
            store.setting_set(KEY_APP_SECRET, "").rpc()?;
            Ok(json!({ "cleared": true }))
        }

        // 连通性自检：搜一个稳定存在的番剧，验证签名与额度都通。
        // 只报诊断，不落库（避免把测试数据污染到用户频道）。
        "credentials.test" => {
            let cred = load_credentials(store);
            match DandanplayClient::new(cred) {
                Err(e) => Ok(json!({ "ok": false, "kind": e.kind, "message": e.message })),
                Ok(client) => {
                    match client.search_episodes("进击的巨人", Some(1)).await {
                        Ok(c) => Ok(json!({
                            "ok": true,
                            "message": format!("连接正常，搜索命中 {} 个剧集条目", c.len()),
                        })),
                        Err(e) => Ok(json!({ "ok": false, "kind": e.kind, "message": e.message })),
                    }
                }
            }
        }

        // ---------- 频道 ----------
        // 打开频道（纯本地，不联网）：前端拿到 channelId 后再决定拉库还是拉网
        "open" => {
            let title = str_param(params, "title").unwrap_or_default();
            let episode = str_param(params, "episode");
            if title.trim().is_empty() {
                return Err((-32602, "invalid params: title required".into()));
            }
            let settings = load_settings(store);
            let provider = str_param(params, "provider").unwrap_or_else(|| settings.provider.clone());
            let provider = if provider == "off" { "local".to_string() } else { provider };
            let cid = channel_id(&provider, &title, episode.as_deref());
            let existing = store.get_danmaku_channel(&cid).ok().flatten();
            Ok(json!({
                "channelId": cid,
                "provider": provider,
                "count": existing.as_ref().map(|c| c.item_count).unwrap_or(0),
                "channelDuration": existing.as_ref().and_then(|c| c.duration),
                "settings": settings,
            }))
        }

        "channels" => {
            let rows = store.list_danmaku_channels().rpc()?;
            Ok(json!({ "channels": rows }))
        }

        "channel.clear" => {
            let cid = str_param(params, "channelId").unwrap_or_default();
            if cid.is_empty() {
                return Err((-32602, "invalid params: channelId required".into()));
            }
            let n = store.clear_danmaku(&cid).rpc()?;
            let _ = store.touch_danmaku_channel(&cid, 0, None, None, now_ms());
            Ok(json!({ "cleared": n }))
        }

        "channel.remove" => {
            let cid = str_param(params, "channelId").unwrap_or_default();
            if cid.is_empty() {
                return Err((-32602, "invalid params: channelId required".into()));
            }
            let n = store.delete_danmaku_channel(&cid).rpc()?;
            Ok(json!({ "removed": n }))
        }

        // ---------- 匹配 ----------
        "match" => {
            let title = str_param(params, "title").unwrap_or_default();
            let episode = str_param(params, "episode");
            if title.trim().is_empty() {
                return Err((-32602, "invalid params: title required".into()));
            }
            let cred = load_credentials(store);
            match DandanplayClient::new(cred) {
                Err(e) => Ok(json!({ "ok": false, "kind": e.kind, "message": e.message, "candidates": [] })),
                Ok(client) => {
                    // `query` 是用户在「手动指定弹幕源」里手输的搜索词，**原样**使用 ——
                    // 任何归一化（去季数后缀、去【】之类）都可能把用户精确输入的关键词改坏。
                    // 没传时才退回按片名归一化。
                    let q = str_param(params, "query")
                        .unwrap_or_else(|| normalize_anime_title(&title));
                    // 集数：显式传了就用（用户可能想看"同一部剧的另一集"），否则从集名推断
                    let no = int_param(params, "episodeNo")
                        .map(|n| n.clamp(0, 9999) as u32)
                        .filter(|n| *n > 0)
                        .or_else(|| episode.as_deref().and_then(guess_episode_no));
                    match client.search_episodes(&q, no).await {
                        Ok(c) => Ok(json!({
                            "ok": true,
                            "query": q,
                            "episodeNo": no,
                            "candidates": c,
                        })),
                        Err(e) => Ok(json!({ "ok": false, "kind": e.kind, "message": e.message, "candidates": [] })),
                    }
                }
            }
        }

        // ---------- 拉取 ----------
        "fetch" => {
            let settings = load_settings(store);
            let title = str_param(params, "title").unwrap_or_default();
            let episode = str_param(params, "episode");
            let duration = num_param(params, "duration");
            let provider = str_param(params, "provider").unwrap_or_else(|| settings.provider.clone());
            let force = bool_param(params, "force").unwrap_or(false);
            let manual_ep = int_param(params, "episodeId");

            if title.trim().is_empty() {
                return Err((-32602, "invalid params: title required".into()));
            }
            let cid = channel_id(&provider, &title, episode.as_deref());

            // 本地源 / 总开关关闭：直接读库，不联网
            if provider == "local" || provider == "off" || !settings.enabled {
                let items = filter_blocked(store.list_danmaku(&cid).rpc()?, &settings.blocked_words);
                let ch = store.get_danmaku_channel(&cid).ok().flatten();
                let out = FetchOutcome {
                    channel_id: cid,
                    provider: "local".into(),
                    count: items.len() as i64,
                    items,
                    added: 0,
                    cached: true,
                    channel_duration: ch.as_ref().and_then(|c| c.duration).or(duration),
                    error: None,
                    matched: None,
                };
                return Ok(serde_json::to_value(out).unwrap_or_default());
            }

            let existing = store.get_danmaku_channel(&cid).ok().flatten();
            let fresh = existing
                .as_ref()
                .and_then(|c| c.last_fetch_at)
                .map(|t| now_ms() - t < FETCH_TTL_SECS * 1000)
                .unwrap_or(false);

            // 缓存命中：读库秒开（换片源时不会重复打第三方接口）
            if !force && manual_ep.is_none() && fresh {
                if let Some(ch) = existing.as_ref() {
                    if ch.item_count > 0 || ch.last_error.is_none() {
                        let items =
                            filter_blocked(store.list_danmaku(&cid).rpc()?, &settings.blocked_words);
                        if !items.is_empty() {
                            let out = FetchOutcome {
                                channel_id: cid,
                                provider: "dandanplay".into(),
                                count: items.len() as i64,
                                items,
                                added: 0,
                                cached: true,
                                channel_duration: ch.duration.or(duration),
                                error: None,
                                matched: ch.provider_ep_id.as_ref().map(|ep| {
                                    json!({ "episodeId": ep, "animeTitle": ch.title, "episodeTitle": ch.episode })
                                }),
                            };
                            return Ok(serde_json::to_value(out).unwrap_or_default());
                        }
                    }
                }
            }

            let cred = load_credentials(store);
            let client = match DandanplayClient::new(cred) {
                Ok(c) => c,
                Err(e) => {
                    // 无 key 不算致命：降级到本地已有弹幕，前端提示去配置
                    let items =
                        filter_blocked(store.list_danmaku(&cid).unwrap_or_default(), &settings.blocked_words);
                    let out = FetchOutcome {
                        channel_id: cid,
                        provider: "dandanplay".into(),
                        count: items.len() as i64,
                        items,
                        added: 0,
                        cached: true,
                        channel_duration: duration,
                        error: Some(json!({ "kind": e.kind, "message": e.message })),
                        matched: None,
                    };
                    return Ok(serde_json::to_value(out).unwrap_or_default());
                }
            };

            // 1) 定 episodeId：手动 > 已有绑定 > 搜索第一个候选
            let mut matched_info: Option<Value> = None;
            let ep_id = if let Some(m) = manual_ep {
                m
            } else if let Some(ep) = existing
                .as_ref()
                .and_then(|c| c.provider_ep_id.as_ref())
                .and_then(|s| s.parse::<i64>().ok())
            {
                ep
            } else {
                let q = normalize_anime_title(&title);
                let no = episode.as_deref().and_then(guess_episode_no);
                match client.search_episodes(&q, no).await {
                    Ok(cands) if !cands.is_empty() => {
                        let first = &cands[0];
                        matched_info = Some(json!({
                            "episodeId": first.episode_id,
                            "animeTitle": first.anime_title,
                            "episodeTitle": first.episode_title,
                            "candidates": cands.len(),
                        }));
                        first.episode_id
                    }
                    Ok(_) => {
                        // 搜不到：记错误但不动已有弹幕（老数据仍可用）
                        let _ = store.touch_danmaku_channel(
                            &cid,
                            0,
                            duration,
                            Some("no_match"),
                            now_ms(),
                        );
                        let items = filter_blocked(
                            store.list_danmaku(&cid).unwrap_or_default(),
                            &settings.blocked_words,
                        );
                        let out = FetchOutcome {
                            channel_id: cid,
                            provider: "dandanplay".into(),
                            count: items.len() as i64,
                            items,
                            added: 0,
                            cached: true,
                            channel_duration: duration,
                            error: Some(json!({
                                "kind": "no_match",
                                "message": format!("弹弹play 未找到《{}》{} 的条目，可在「弹幕源」里手动指定",
                                    q, no.map(|n| format!("第{n}集")).unwrap_or_default()),
                            })),
                            matched: None,
                        };
                        return Ok(serde_json::to_value(out).unwrap_or_default());
                    }
                    Err(e) => {
                        let _ = store.touch_danmaku_channel(
                            &cid,
                            0,
                            duration,
                            Some(e.kind),
                            now_ms(),
                        );
                        let items = store.list_danmaku(&cid).unwrap_or_default();
                        let out = FetchOutcome {
                            channel_id: cid,
                            provider: "dandanplay".into(),
                            count: items.len() as i64,
                            items,
                            added: 0,
                            cached: true,
                            channel_duration: duration,
                            error: Some(json!({ "kind": e.kind, "message": e.message })),
                            matched: None,
                        };
                        return Ok(serde_json::to_value(out).unwrap_or_default());
                    }
                }
            };

            // 2) 拉弹幕
            let items = match client.fetch_comments(ep_id, true).await {
                Ok(v) => v,
                Err(e) => {
                    let _ = store.touch_danmaku_channel(&cid, 0, duration, Some(e.kind), now_ms());
                    let cached_items = filter_blocked(
                        store.list_danmaku(&cid).unwrap_or_default(),
                        &settings.blocked_words,
                    );
                    let out = FetchOutcome {
                        channel_id: cid,
                        provider: "dandanplay".into(),
                        count: cached_items.len() as i64,
                        items: cached_items,
                        added: 0,
                        cached: true,
                        channel_duration: duration,
                        error: Some(json!({ "kind": e.kind, "message": e.message })),
                        matched: matched_info,
                    };
                    return Ok(serde_json::to_value(out).unwrap_or_default());
                }
            };

            // 3) 片长估计：优先用「调用方明确告知的源时长」，否则用弹幕跨度
            let span = items.last().map(|i| i.time).unwrap_or(0.0);
            let est_duration = duration.or(if span > MIN_SOURCE_SPAN_SECS { Some(span) } else { None });

            // 4) 落库（批量事务；重复条目由唯一约束吸收）
            let added = store.insert_danmaku_batch(&cid, &items).rpc()?;
            let total = store.count_danmaku(&cid).unwrap_or(items.len() as i64);
            // 出参按屏蔽词过滤（库里全量保存，改动屏蔽词无需重拉）
            let visible_count = items.len() as i64;
            let visible = filter_blocked(items, &settings.blocked_words);

            let channel_row = DanmakuChannelRow {
                id: cid.clone(),
                title: title.clone(),
                episode: episode.clone(),
                provider: "dandanplay".into(),
                provider_ep_id: Some(ep_id.to_string()),
                duration: est_duration,
                item_count: total,
                matched_at: Some(now_ms()),
                last_fetch_at: Some(now_ms()),
                last_error: None,
            };
            store.upsert_danmaku_channel(&channel_row).rpc()?;

            let out = FetchOutcome {
                channel_id: cid,
                provider: "dandanplay".into(),
                items: visible,
                // 与出参条数一致（库里 total 含被屏蔽的，UI 计数按可见算）
                count: visible_count,
                added,
                cached: false,
                channel_duration: est_duration,
                error: None,
                matched: matched_info.or_else(|| {
                    Some(json!({ "episodeId": ep_id.to_string() }))
                }),
            };
            Ok(serde_json::to_value(out).unwrap_or_default())
        }

        // ---------- 本地列表（缓存优先秒开） ----------
        "list" => {
            let cid = str_param(params, "channelId").unwrap_or_default();
            if cid.is_empty() {
                return Err((-32602, "invalid params: channelId required".into()));
            }
            let settings = load_settings(store);
            let items = filter_blocked(store.list_danmaku(&cid).rpc()?, &settings.blocked_words);
            let ch = store.get_danmaku_channel(&cid).ok().flatten();
            Ok(json!({
                "items": items,
                "count": items.len(),
                "channelDuration": ch.as_ref().and_then(|c| c.duration),
            }))
        }

        // ---------- 发送（本地） ----------
        "send" => {
            let cid = str_param(params, "channelId").unwrap_or_default();
            if cid.is_empty() {
                return Err((-32602, "invalid params: channelId required".into()));
            }
            let Some(time) = num_param(params, "time") else {
                return Err((-32602, "invalid params: time required".into()));
            };
            let raw_text = str_param(params, "text").unwrap_or_default();
            let mode = str_param(params, "mode")
                .map(|m| DanmakuMode::parse(&m))
                .unwrap_or(DanmakuMode::Scroll);
            let color = pf_danmaku::normalize_color(&str_param(params, "color").unwrap_or_default());

            // 限流 + 去重 + 文本校验一把过（SendGuard 保证被拒的请求不占用额度）
            //
            // 被拒是**业务结果**而不是协议错误：返回 ok:false + kind，前端按 kind 出文案。
            // 若包成 JSON-RPC error，前端只能拿到扁平字符串，还要正则解析原因。
            let text = match check_send(&cid, &raw_text) {
                Ok(t) => t,
                Err(rej) => {
                    return Ok(json!({
                        "ok": false,
                        "kind": rej.code(),
                        "message": rej.message(),
                    }))
                }
            };

            let item = DanmakuItem {
                id: pf_danmaku::make_id("local", &cid, time.max(0.0), &text),
                time: time.max(0.0),
                text,
                mode,
                color,
                source: "local".into(),
                ctime: Some(now_ms()),
                // P17：fx 只认白名单（glow/gradient），非法值静默归普通
                fx: pf_danmaku::normalize_fx(params.get("fx").and_then(|v| v.as_str())),
            };
            let persisted = store.insert_danmaku(&cid, &item).rpc()?;
            Ok(json!({ "ok": true, "item": item, "persisted": persisted }))
        }

        // ---------- 本地文件导入（P15：B 站 XML / 弹弹play JSON） ----------
        "import" => {
            let content = str_param(params, "content").unwrap_or_default();
            if content.trim().is_empty() {
                return Err((-32602, "invalid params: content required".into()));
            }
            // 内容上限 8MB：一个两小时视频的弹幕通常 < 2MB，留足余量
            if content.len() > 8 * 1024 * 1024 {
                return Err((-32602, "弹幕文件过大（上限 8MB）".into()));
            }
            let settings = load_settings(store);
            let title = str_param(params, "title").unwrap_or_default();
            let episode = str_param(params, "episode");
            let cid = match str_param(params, "channelId") {
                Some(c) => c,
                None => {
                    if title.trim().is_empty() {
                        return Err((-32602, "invalid params: title or channelId required".into()));
                    }
                    channel_id("local", &title, episode.as_deref())
                }
            };
            // 频道行：已有则沿用其标题/集数（避免覆盖在线匹配信息），没有则按参数建
            let ch = store.get_danmaku_channel(&cid).ok().flatten();
            let title = str_param(params, "title")
                .filter(|t| !t.trim().is_empty())
                .or_else(|| ch.as_ref().map(|c| c.title.clone()))
                .unwrap_or_else(|| "导入弹幕".into());
            let episode = episode.or_else(|| ch.as_ref().and_then(|c| c.episode.clone()));

            let (fmt, items) = parse_import(&content, &cid)
                .map_err(|e| (-32602, e))?;
            // 导入**不做屏蔽词过滤**。
            //
            // 屏蔽是渲染侧语义：`fetch` / `list` / `ass` 三个出口都在按
            // `settings.blocked_words` 过滤。若在这里也过滤一次，被命中的条目
            // 就根本没入库 —— 用户之后清空屏蔽词，那些弹幕也回不来了（只能重新导入）。
            // 数据侧只负责「完整地存下来」，不承担展示策略。
            let span = items.last().map(|i| i.time).unwrap_or(0.0);
            let est_duration = if span > MIN_SOURCE_SPAN_SECS { Some(span) } else { None };
            let imported = store.insert_danmaku_batch(&cid, &items).rpc()?;
            let total = store.count_danmaku(&cid).unwrap_or(items.len() as i64);
            let blocked = if settings.blocked_words.is_empty() {
                0
            } else {
                items.iter().filter(|i| is_blocked(&i.text, &settings.blocked_words)).count()
            };
            let row = DanmakuChannelRow {
                id: cid.clone(),
                title,
                episode,
                provider: ch.as_ref().map(|c| c.provider.clone()).unwrap_or_else(|| "local".into()),
                provider_ep_id: ch.as_ref().and_then(|c| c.provider_ep_id.clone()),
                duration: ch.as_ref().and_then(|c| c.duration).or(est_duration),
                item_count: total,
                matched_at: ch.as_ref().and_then(|c| c.matched_at),
                last_fetch_at: ch.as_ref().and_then(|c| c.last_fetch_at),
                last_error: None,
            };
            store.upsert_danmaku_channel(&row).rpc()?;
            Ok(json!({
                "ok": true,
                "channelId": cid,
                "format": fmt.as_str(),
                "imported": imported,
                "total": total,
                // 其中当前被屏蔽词挡住的条数（已入库，只是不显示）
                "blocked": blocked,
            }))
        }

        // ---------- ASS 导出（libmpv 内核渲染路径） ----------
        "ass" => {
            let cid = str_param(params, "channelId").unwrap_or_default();
            if cid.is_empty() {
                return Err((-32602, "invalid params: channelId required".into()));
            }
            let width = num_param(params, "width").unwrap_or(1920.0);
            let height = num_param(params, "height").unwrap_or(1080.0);
            let settings = load_settings(store);
            let font_scale = num_param(params, "fontScale").unwrap_or(settings.font_scale);
            let opacity = num_param(params, "opacity").unwrap_or(settings.opacity);
            let max_items = int_param(params, "maxItems").unwrap_or(20000).max(1) as usize;

            let mut items = store.list_danmaku(&cid).rpc()?;
            // 屏蔽项在这里生效：mpv 侧没有前端渲染层的过滤能力
            items.retain(|i| match i.mode {
                DanmakuMode::Scroll => !settings.block_scroll,
                DanmakuMode::Top => !settings.block_top,
                DanmakuMode::Bottom => !settings.block_bottom,
            });
            items.retain(|i| !is_blocked(&i.text, &settings.blocked_words));
            if items.is_empty() {
                return Ok(json!({ "path": Value::Null, "count": 0, "reason": "empty" }));
            }
            let ass = pf_danmaku::build_ass(&items, width, height, font_scale, opacity, max_items);
            let dir = ass_dir(store);
            if let Err(e) = std::fs::create_dir_all(&dir) {
                return Err((-32000, format!("创建弹幕目录失败：{e}")));
            }
            let path = dir.join(format!("{cid}.ass"));
            if let Err(e) = std::fs::write(&path, ass) {
                return Err((-32000, format!("写 ASS 失败：{e}")));
            }
            let count = items.len();
            // 写完顺手治理一次：目录里也就几十个文件，扫一遍的开销可忽略，
            // 但省掉了「另外找个时机清理」这件事（这个时机永远会被忘掉）。
            let _ = clean_ass_cache(&dir, ASS_KEEP_FILES, ASS_MAX_AGE_SECS);
            Ok(json!({
                "path": path.to_string_lossy(),
                "count": count,
                "bytes": std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
            }))
        }

        // ---------- ASS 缓存治理 ----------
        // keep=0 即清空；maxAgeHours 缺省时按 7 天
        "cache.clean" => {
            let keep = int_param(params, "keep")
                .map(|v| v.clamp(0, 10_000) as usize)
                .unwrap_or(ASS_KEEP_FILES);
            let max_age = int_param(params, "maxAgeHours")
                .map(|h| (h.clamp(0, 24 * 365) as u64) * 3600)
                .unwrap_or(ASS_MAX_AGE_SECS);
            let dir = ass_dir(store);
            let (removed, freed) = clean_ass_cache(&dir, keep, max_age);
            let (files, bytes) = ass_cache_stat(&dir);
            Ok(json!({
                "removed": removed,
                "freed": freed,
                "files": files,
                "bytes": bytes,
                "keep": keep,
            }))
        }

        // ---------- 诊断 ----------
        "stats" => {
            let cid = str_param(params, "channelId").unwrap_or_default();
            let count = if cid.is_empty() { 0 } else { store.count_danmaku(&cid).rpc()? };
            let ch = if cid.is_empty() {
                None
            } else {
                store.get_danmaku_channel(&cid).ok().flatten()
            };
            let cred = load_credentials(store);
            let (ass_files, ass_bytes) = ass_cache_stat(&ass_dir(store));
            Ok(json!({
                "channelId": cid,
                "count": count,
                "channel": ch,
                "hasCredentials": cred.is_configured(),
                "provider": load_settings(store).provider,
                "channels": store.list_danmaku_channels().map(|v| v.len()).unwrap_or(0),
                "assCache": { "files": ass_files, "bytes": ass_bytes },
            }))
        }

        other => Err((-32601, format!("method not found: danmaku.{other}"))),
    }
}

/// 暴露给 main.rs 做启动期校验（凭据存在性只打日志，不阻塞启动）
pub fn log_startup_state(store: &pf_engine::CacheStore) {
    let cred = load_credentials(store);
    let s = load_settings(store);
    if cred.is_configured() {
        eprintln!(
            "[pf-core] 弹幕就绪：provider={} 已配置弹弹play凭据；本地频道 {} 个",
            s.provider,
            store.list_danmaku_channels().map(|v| v.len()).unwrap_or(0)
        );
    } else {
        eprintln!("[pf-core] 弹幕：未配置弹弹play凭据（本地弹幕可用，第三方源需在设置页填 AppId/AppSecret）");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_id_is_stable_and_provider_scoped() {
        let a = channel_id("dandanplay", "庆余年", Some("第1集"));
        let b = channel_id("dandanplay", " 庆余年 ", Some(" 第1集 "));
        assert_eq!(a, b, "首尾空格不应影响频道");
        let c = channel_id("local", "庆余年", Some("第1集"));
        assert_ne!(a, c, "换弹幕源应换频道");
        let d = channel_id("dandanplay", "庆余年", Some("第2集"));
        assert_ne!(a, d, "换集应换频道");
    }

    #[test]
    fn settings_clamp_out_of_range() {
        let mut s = DanmakuSettings {
            opacity: 5.0,
            font_scale: 0.0,
            speed: 99.0,
            density: -1.0,
            provider: "bogus".into(),
            ..Default::default()
        };
        s.clamp();
        assert_eq!(s.opacity, 1.0);
        assert_eq!(s.font_scale, 0.6);
        assert_eq!(s.speed, 1.5);
        assert_eq!(s.density, 0.1);
        assert_eq!(s.provider, "dandanplay");
    }

    #[test]
    fn settings_deserialize_old_config_with_missing_fields() {
        // 旧版本可能只存了部分字段，缺失项必须由 default 补齐而不是报错
        let s: DanmakuSettings = serde_json::from_str(r#"{"enabled":true,"opacity":0.5}"#).unwrap();
        assert_eq!(s.opacity, 0.5);
        assert_eq!(s.font_scale, 1.0);
        assert_eq!(s.provider, "dandanplay");
    }

    #[test]
    fn mask_hides_secret() {
        assert_eq!(mask("abcd1234"), "abcd****");
        assert_eq!(mask("abc"), "***");
        assert_eq!(mask(""), "*");
    }

    #[test]
    fn ass_cache_clean_respects_quota() {
        let dir = std::env::temp_dir().join(format!("pf-ass-test-{}", now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..5 {
            std::fs::write(dir.join(format!("c{i}.ass")), vec![b'a'; 100]).unwrap();
        }
        // 非 .ass 文件不该被统计/删除
        std::fs::write(dir.join("note.txt"), b"keep me").unwrap();

        assert_eq!(ass_cache_stat(&dir), (5, 500));

        // keep=2 → 删 3 个、释放 300 字节
        let (removed, freed) = clean_ass_cache(&dir, 2, ASS_MAX_AGE_SECS);
        assert_eq!(removed, 3);
        assert_eq!(freed, 300);
        assert_eq!(ass_cache_stat(&dir).0, 2);

        // keep=0 → 全清，但不动其他类型的文件
        let (removed2, _) = clean_ass_cache(&dir, 0, ASS_MAX_AGE_SECS);
        assert_eq!(removed2, 2);
        assert_eq!(ass_cache_stat(&dir).0, 0);
        assert!(dir.join("note.txt").exists(), "非 .ass 文件不该被清理");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ass_cache_clean_on_missing_dir_is_noop() {
        let dir = std::env::temp_dir().join(format!("pf-ass-missing-{}", now_ms()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(clean_ass_cache(&dir, 10, ASS_MAX_AGE_SECS), (0, 0));
        assert_eq!(ass_cache_stat(&dir), (0, 0));
    }
}
