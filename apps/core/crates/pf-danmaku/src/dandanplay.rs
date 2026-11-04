//! 弹弹play（dandanplay）弹幕库客户端
//!
//! 走官方 v2 开放接口，鉴权三件套：
//!   `X-AppId` / `X-Timestamp`（unix 秒）/ `X-Signature`
//!   `X-Signature = Base64( SHA256( AppId + Timestamp + Path + AppSecret ) )`
//!   其中 `Path` 是**不含 query** 的请求路径（如 `/api/v2/comment/123`）。
//!
//! 设计取舍：
//!  - 不缓存到内存：拉取结果由上层批量落 SQLite，进程重启不重复打接口；
//!  - 不重试：视频站 API 抖动交给用户手动重试，避免把第三方接口打成风控目标；
//!  - 错误分类明确（无 key / 鉴权失败 / 配额 / 网络 / 解析），前端可给可操作提示。

use base64::Engine as _;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::model::{make_id, normalize_color, DanmakuItem, DanmakuMode, MAX_BATCH_ITEMS};

pub const DEFAULT_BASE: &str = "https://api.dandanplay.net";

/// 弹弹play 开放平台凭据（在设置页填写，落 settings 表）
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DanmakuCredentials {
    pub app_id: String,
    pub app_secret: String,
}

impl DanmakuCredentials {
    pub fn is_configured(&self) -> bool {
        !self.app_id.trim().is_empty() && !self.app_secret.trim().is_empty()
    }
}

/// 匹配到的剧集候选（供前端「手动换源」下拉选择）
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeCandidate {
    pub episode_id: i64,
    pub anime_title: String,
    pub episode_title: String,
    pub anime_type: String,
}

/// 客户端错误：`kind` 供前端分支，`message` 直接可展示
#[derive(Debug, Clone, PartialEq)]
pub struct DpError {
    pub kind: &'static str,
    pub message: String,
}

impl DpError {
    fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for DpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.kind, self.message)
    }
}

/// 计算请求签名（纯函数，可单测）
pub fn sign(app_id: &str, timestamp: u64, path: &str, app_secret: &str) -> String {
    let mut h = Sha256::new();
    h.update(app_id.as_bytes());
    h.update(timestamp.to_string().as_bytes());
    h.update(path.as_bytes());
    h.update(app_secret.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(h.finalize())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

// ---------- 响应体（serde 容错：字段缺失一律给默认值） ----------

#[derive(Debug, Deserialize)]
struct SearchResp {
    #[serde(default)]
    success: bool,
    #[serde(default, rename = "errorCode")]
    error_code: i64,
    #[serde(default, rename = "errorMessage")]
    error_message: String,
    #[serde(default)]
    animes: Vec<SearchAnime>,
}

#[derive(Debug, Deserialize)]
struct SearchAnime {
    #[serde(default, rename = "animeTitle")]
    anime_title: String,
    #[serde(default, rename = "typeDescription")]
    type_description: String,
    #[serde(default)]
    episodes: Vec<SearchEpisode>,
}

#[derive(Debug, Deserialize)]
struct SearchEpisode {
    #[serde(default, rename = "episodeId")]
    episode_id: i64,
    #[serde(default, rename = "episodeTitle")]
    episode_title: String,
}

#[derive(Debug, Deserialize)]
struct CommentResp {
    #[serde(default)]
    count: i64,
    #[serde(default)]
    comments: Vec<RawComment>,
}

#[derive(Debug, Deserialize)]
struct RawComment {
    #[serde(default)]
    cid: i64,
    /// "时间,模式,颜色,用户ID"（B 站格式）
    #[serde(default)]
    p: String,
    #[serde(default)]
    m: String,
}

/// 解析一条 `p`/`m` 弹幕：非法条目返回 None（第三方库常混入脏数据）
pub fn parse_raw_comment(channel: &str, cid: i64, p: &str, m: &str) -> Option<DanmakuItem> {
    let mut cols = p.split(',');
    let time: f64 = cols.next()?.trim().parse().ok()?;
    if !time.is_finite() || time < 0.0 {
        return None;
    }
    let mode = cols
        .next()
        .and_then(|s| s.trim().parse::<i64>().ok())
        .map(DanmakuMode::from_cm_mode)
        .unwrap_or(DanmakuMode::Scroll);
    // 颜色列可能是十进制，也可能已经是 #RRGGBB（转发链路上见过）
    let color = cols.next().map(normalize_color).unwrap_or_else(|| "#FFFFFF".into());
    let text = m.trim();
    if text.is_empty() {
        return None;
    }
    // 第三方库文本仍可能带换行 → 压平；超长截断而非丢弃（丢了会改变时间轴密度感）
    let flat: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(crate::model::MAX_TEXT_CHARS)
        .collect();
    let flat = flat.trim();
    if flat.is_empty() {
        return None;
    }
    let id = if cid > 0 {
        format!("dandanplay:{channel}:c{cid}")
    } else {
        make_id("dandanplay", channel, time, flat)
    };
    Some(DanmakuItem {
        id,
        time,
        text: flat.to_string(),
        mode,
        color,
        source: "dandanplay".into(),
        ctime: None,
        fx: None,
    })
}

// ---------- 标题 / 集数归一（决定匹配命中率的核心） ----------

/// 从剧集标题里抽集数：`第05集` / `第5话` / `EP12` / `S01E03` / 末尾裸数字
///
/// 返回 1 基集数。抽不到返回 None（此时退化为「只按片名搜索」）。
pub fn guess_episode_no(title: &str) -> Option<u32> {
    let t = title.trim();
    if t.is_empty() {
        return None;
    }
    let lower = t.to_ascii_lowercase();

    // S01E03
    if let Some(pos) = lower.find('e') {
        if lower[..pos].ends_with('s') || lower[..pos].chars().last().is_some_and(|c| c.is_ascii_digit()) {
            let digits: String = lower[pos + 1..]
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if let Ok(n) = digits.parse::<u32>() {
                if n > 0 {
                    return Some(n);
                }
            }
        }
    }

    // 第N集 / 第N话 / 第N期 / 第N回
    for marker in ["集", "话", "期", "回"] {
        if let Some(idx) = t.find(marker) {
            let head = &t[..idx];
            let digits: String = head
                .chars()
                .rev()
                .take_while(|c| c.is_ascii_digit())
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            if let Ok(n) = digits.parse::<u32>() {
                if n > 0 {
                    return Some(n);
                }
            }
        }
    }

    // EP12 / Ep.12 / E12
    for prefix in ["ep.", "ep", "e"] {
        if let Some(idx) = lower.rfind(prefix) {
            let rest = &lower[idx + prefix.len()..];
            let rest = rest.trim_start_matches(['.', ' ', '-', '_']);
            let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(n) = digits.parse::<u32>() {
                if n > 0 {
                    return Some(n);
                }
            }
        }
    }

    // 裸数字兜底：最后一个独立的数字串（如 "庆余年 02"）
    let mut best: Option<u32> = None;
    let mut cur = String::new();
    for c in t.chars() {
        if c.is_ascii_digit() {
            cur.push(c);
        } else {
            if let Ok(n) = cur.parse::<u32>() {
                if n > 0 && n < 10_000 {
                    best = Some(n);
                }
            }
            cur.clear();
        }
    }
    if let Ok(n) = cur.parse::<u32>() {
        if n > 0 && n < 10_000 {
            best = Some(n);
        }
    }
    best
}

/// 把采集站剧集标题清洗成可用于搜索的番剧名：
/// 去集数标记、去分辨率/编码/字幕组方括号、去季号。
pub fn normalize_anime_title(title: &str) -> String {
    let mut s = title.trim().to_string();
    if s.is_empty() {
        return s;
    }
    // 去掉所有 [] 【】 () （） 内容（多为 1080p / WEB-DL / 字幕组 噪声）
    // 注意 `..=b` 只对单字节闭区间成立，`】` `）` 是多字节，必须按 len_utf8 收尾
    for (open, close) in [('[', ']'), ('【', '】'), ('(', ')'), ('（', '）')] {
        loop {
            let Some(a) = s.find(open) else { break };
            let Some(rel) = s[a..].find(close) else { break };
            let end = a + rel + close.len_utf8();
            s.replace_range(a..end, " ");
        }
    }
    // 去「第N集/话/期/回」——全部按 char 边界操作，避免切在多字节字符中间
    for marker in ["集", "话", "期", "回"] {
        let mlen = marker.len();
        let mut from = 0usize;
        while let Some(rel) = s[from..].find(marker) {
            let idx = from + rel;
            // 向前回溯紧邻的 ASCII 数字
            let mut start = idx;
            while let Some(ch) = s[..start].chars().next_back() {
                if ch.is_ascii_digit() {
                    start -= ch.len_utf8();
                } else {
                    break;
                }
            }
            let has_di = s[..start].ends_with('第');
            // 只有「第N集」或「N集」这种明确集数才裁掉，避免误伤「影集」这类片名
            if has_di || start < idx {
                let begin = if has_di { start - '第'.len_utf8() } else { start };
                s.replace_range(begin..idx + mlen, " ");
                from = begin;
            } else {
                from = idx + mlen;
            }
        }
    }
    // 去尾部 EP/E 编号
    let lower = s.to_ascii_lowercase();
    for prefix in ["ep.", "ep", "e"] {
        if let Some(idx) = lower.rfind(prefix) {
            let tail = &lower[idx + prefix.len()..];
            let body = tail.trim_start_matches(['.', ' ', '-', '_']);
            if !body.is_empty() && body.chars().all(|c| c.is_ascii_digit() || c == ' ') {
                s.truncate(idx);
                break;
            }
        }
    }
    // 去季号尾巴：第二季 / Season 2（保留片名主体，弹弹play 搜索本身对季不敏感）
    for kw in ["第二季", "第三季", "第四季", "第一季"] {
        s = s.replace(kw, " ");
    }
    // 折叠空白 + 去首尾标点
    let collapsed = s.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed
        .trim_matches(|c: char| c.is_whitespace() || "-_·:：|/".contains(c))
        .to_string()
}

/// 弹弹play 客户端
pub struct DandanplayClient {
    http: reqwest::Client,
    base: String,
    cred: DanmakuCredentials,
}

impl DandanplayClient {
    /// `PF_DANDANPLAY_BASE` 可覆盖接口根地址：
    ///  - 冒烟测试指向本地假 origin，用来验证签名/解析/落库全链路而不依赖外网；
    ///  - 用户可指向自建镜像（企业内网 / 反代），无需改代码。
    pub fn new(cred: DanmakuCredentials) -> Result<Self, DpError> {
        let base = std::env::var("PF_DANDANPLAY_BASE")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_BASE.to_string());
        Self::with_base(cred, &base)
    }

    pub fn with_base(cred: DanmakuCredentials, base: &str) -> Result<Self, DpError> {
        if !cred.is_configured() {
            return Err(DpError::new(
                "no_credentials",
                "未配置弹弹play AppId/AppSecret（设置 → 弹幕 填写，官方开放平台免费申请）",
            ));
        }
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(12))
            .user_agent("PolyFramePlayer/0.1 (+https://github.com/polyframe)")
            .build()
            .map_err(|e| DpError::new("network", format!("HTTP 客户端初始化失败：{e}")))?;
        Ok(Self {
            http,
            base: base.trim_end_matches('/').to_string(),
            cred,
        })
    }

    /// 带签名的 GET：`path` 不含 query（签名只覆盖路径）
    async fn get_json<T: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<T, DpError> {
        let ts = now_secs();
        let sig = sign(&self.cred.app_id, ts, path, &self.cred.app_secret);
        let url = format!("{}{}", self.base, path);
        let resp = self
            .http
            .get(&url)
            .query(query)
            .header("X-AppId", &self.cred.app_id)
            .header("X-Timestamp", ts.to_string())
            .header("X-Signature", sig)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    DpError::new("timeout", "弹弹play 请求超时（网络不通或接口被墙）")
                } else {
                    DpError::new("network", format!("弹弹play 请求失败：{e}"))
                }
            })?;

        let status = resp.status();
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(DpError::new(
                "auth",
                "弹弹play 鉴权失败（AppId/AppSecret 不匹配，或该 AppId 未被审核通过）",
            ));
        }
        if status.as_u16() == 429 {
            return Err(DpError::new(
                "quota",
                "弹弹play 接口调用超限（免费额度按天计），请稍后重试",
            ));
        }
        if !status.is_success() {
            return Err(DpError::new(
                "http",
                format!("弹弹play 返回 HTTP {}", status.as_u16()),
            ));
        }
        resp.json::<T>()
            .await
            .map_err(|e| DpError::new("parse", format!("弹弹play 响应解析失败：{e}")))
    }

    /// 按「番剧名 + 集数」搜索剧集候选
    pub async fn search_episodes(
        &self,
        anime: &str,
        episode: Option<u32>,
    ) -> Result<Vec<EpisodeCandidate>, DpError> {
        let mut q: Vec<(&str, String)> = vec![("anime", anime.trim().to_string())];
        if let Some(ep) = episode {
            q.push(("episode", ep.to_string()));
        }
        let r: SearchResp = self.get_json("/api/v2/search/episodes", &q).await?;
        if !r.success && r.error_code != 0 {
            return Err(DpError::new(
                "api",
                format!("弹弹play 搜索失败（{}）：{}", r.error_code, r.error_message),
            ));
        }
        let mut out = Vec::new();
        for a in r.animes {
            for e in a.episodes {
                if e.episode_id <= 0 {
                    continue;
                }
                out.push(EpisodeCandidate {
                    episode_id: e.episode_id,
                    anime_title: a.anime_title.clone(),
                    episode_title: e.episode_title,
                    anime_type: a.type_description.clone(),
                });
            }
        }
        Ok(out)
    }

    /// 拉取某集弹幕（`with_related` 会把同系列其他集弹幕按时间轴合并，命中率更高）
    pub async fn fetch_comments(
        &self,
        episode_id: i64,
        with_related: bool,
    ) -> Result<Vec<DanmakuItem>, DpError> {
        if episode_id <= 0 {
            return Err(DpError::new("bad_params", "episodeId 非法"));
        }
        let path = format!("/api/v2/comment/{episode_id}");
        let q = vec![
            ("withRelated", if with_related { "true" } else { "false" }.to_string()),
            // 0 = 不转换繁体（原文最准）
            ("chConvert", "0".to_string()),
        ];
        let r: CommentResp = self.get_json(&path, &q).await?;
        let channel = episode_id.to_string();
        let mut items: Vec<DanmakuItem> = r
            .comments
            .iter()
            .filter_map(|c| parse_raw_comment(&channel, c.cid, &c.p, &c.m))
            .collect();
        // 超高并发兜底：按时间均摊截断（不是简单截前 N 条，否则后半集没弹幕）
        if items.len() > MAX_BATCH_ITEMS {
            items.sort_by(|a, b| {
                a.time
                    .partial_cmp(&b.time)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            let step = items.len() as f64 / MAX_BATCH_ITEMS as f64;
            items = (0..MAX_BATCH_ITEMS)
                .map(|i| items[(i as f64 * step) as usize].clone())
                .collect();
        }
        crate::model::dedup_sorted(&mut items);
        let _ = r.count;
        Ok(items)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_is_deterministic_and_64_chars() {
        let a = sign("id1", 1700000000, "/api/v2/comment/1", "sec");
        let b = sign("id1", 1700000000, "/api/v2/comment/1", "sec");
        assert_eq!(a, b);
        assert_eq!(a.len(), 44); // SHA256 → 32 字节 → Base64 44 字符（含 padding）
    }

    #[test]
    fn sign_changes_with_every_input() {
        let base = sign("id1", 1700000000, "/p", "sec");
        assert_ne!(base, sign("id2", 1700000000, "/p", "sec"));
        assert_ne!(base, sign("id1", 1700000001, "/p", "sec"));
        assert_ne!(base, sign("id1", 1700000000, "/q", "sec"));
        assert_ne!(base, sign("id1", 1700000000, "/p", "sec2"));
    }

    #[test]
    fn parse_comment_happy_path() {
        let d = parse_raw_comment("42", 7, "12.5,1,16777215,abc", "前方高能").unwrap();
        assert!((d.time - 12.5).abs() < 1e-9);
        assert_eq!(d.mode, DanmakuMode::Scroll);
        assert_eq!(d.color, "#FFFFFF");
        assert_eq!(d.text, "前方高能");
        assert_eq!(d.id, "dandanplay:42:c7");
    }

    #[test]
    fn parse_comment_modes() {
        assert_eq!(
            parse_raw_comment("1", 1, "1,5,0,", "顶").unwrap().mode,
            DanmakuMode::Top
        );
        assert_eq!(
            parse_raw_comment("1", 1, "1,4,0,", "底").unwrap().mode,
            DanmakuMode::Bottom
        );
    }

    #[test]
    fn parse_comment_rejects_garbage() {
        assert!(parse_raw_comment("1", 1, "", "x").is_none());
        assert!(parse_raw_comment("1", 1, "abc,1,0,", "x").is_none());
        assert!(parse_raw_comment("1", 1, "-5,1,0,", "x").is_none());
        assert!(parse_raw_comment("1", 1, "5,1,0,", "   ").is_none());
    }

    #[test]
    fn parse_comment_flattens_newlines() {
        let d = parse_raw_comment("1", 1, "5,1,0,", "a\nb").unwrap();
        assert_eq!(d.text, "a b");
    }

    #[test]
    fn episode_no_variants() {
        assert_eq!(guess_episode_no("第05集"), Some(5));
        assert_eq!(guess_episode_no("庆余年 第二季 第12集"), Some(12));
        assert_eq!(guess_episode_no("EP07"), Some(7));
        assert_eq!(guess_episode_no("Ep.03 1080p"), Some(3));
        assert_eq!(guess_episode_no("S02E11"), Some(11));
        assert_eq!(guess_episode_no("第3话 先行版"), Some(3));
        assert_eq!(guess_episode_no("大结局"), None);
        assert_eq!(guess_episode_no(""), None);
    }

    #[test]
    fn anime_title_strips_noise() {
        assert_eq!(normalize_anime_title("庆余年 第二季 第12集"), "庆余年");
        assert_eq!(
            normalize_anime_title("【高清】进击的巨人 [1080p] 第5集"),
            "进击的巨人"
        );
        assert_eq!(normalize_anime_title("老友记 S01E03"), "老友记 S01");
        assert_eq!(normalize_anime_title("繁花 EP12"), "繁花");
    }

    #[test]
    fn anime_title_keeps_plain_name() {
        assert_eq!(normalize_anime_title("流浪地球2"), "流浪地球2");
    }
}
