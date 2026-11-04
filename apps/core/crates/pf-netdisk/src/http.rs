//! 通用 HTTP 目录网关适配器 + 共用 HTTP 原语
//!
//! 「HTTP 目录」既是可落地的真实源（alist/openlist/自建服务把网盘转成 HTTP 目录），
//! 也是本模块的**契约基准**与冒烟测试载体。端点契约（v1）：
//!
//! ```text
//! GET  {base}/api/list?dir={dir}&cursor={cursor}&size={n}
//!      → {"items":[{"id","name","isDir","size","modifiedAt"}],"nextCursor","total"}
//! GET  {base}/api/resolve?id={fileId}
//!      → {"url":"https://…/dl/x","expiresAt":<epochMs>,"headers":{k:v}}
//! POST {base}/api/refresh {"refreshToken"}  → {"accessToken","refreshToken","expiresAt"}
//! POST {base}/api/auth/begin {"clientId"}   → {"deviceCode","userCode","verificationUri","intervalSecs","expiresIn"}
//! GET  {base}/api/auth/poll?deviceCode=…    → {"pending":bool,"accessToken","refreshToken","expiresAt"}
//! ```
//!
//! 鉴权：`Authorization: Bearer {access_token}`（缺失时 401）。
//! 该契约刻意保持「薄」：任何能列目录 + 给直链的服务都能接入。

use std::sync::OnceLock;

use serde_json::{json, Value};

use crate::{
    AuthChallenge, AuthMode, AuthOutcome, BoxFut, Credentials, NetdiskItem, Page, PlayTarget,
    Provider, ProviderKind, ShareRef,
};

// ---------- 共用原语 ----------

/// 通用网盘 HTTP 客户端（连接池 + 连接超时；请求级超时单独挂）
pub(crate) fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) \
                 Chrome/124.0.0.0 Safari/537.36",
            )
            .connect_timeout(std::time::Duration::from_secs(8))
            .build()
            .unwrap_or_default()
    })
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// 秒级 expires_in → 绝对毫秒时刻
pub(crate) fn expires_from_secs(secs: i64) -> Option<i64> {
    if secs > 0 {
        Some(now_ms() + secs * 1000)
    } else {
        None
    }
}

pub(crate) fn opt_str(v: &Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(s) = v.get(*k).and_then(Value::as_str) {
            if !s.trim().is_empty() {
                return Some(s.trim().to_string());
            }
        }
        // 部分实现把数字 id 当 number 返回
        if let Some(n) = v.get(*k).and_then(Value::as_i64) {
            return Some(n.to_string());
        }
    }
    None
}

pub(crate) fn opt_i64(v: &Value, keys: &[&str]) -> Option<i64> {
    for k in keys {
        if let Some(n) = v.get(*k).and_then(Value::as_i64) {
            return Some(n);
        }
        if let Some(s) = v.get(*k).and_then(Value::as_str) {
            if let Ok(n) = s.parse::<i64>() {
                return Some(n);
            }
        }
    }
    None
}

/// 状态码 → 可读错误（含错误分类关键词，便于上层判定是否换链/重登）
pub(crate) fn http_error(op: &str, status: u16, body: &str) -> String {
    let brief: String = body.chars().take(200).collect();
    format!("{op} 失败：HTTP {status} {brief}")
}

pub(crate) async fn get_json(url: &str, headers: Vec<(String, String)>, timeout_s: u64) -> Result<Value, String> {
    let mut req = client().get(url).timeout(std::time::Duration::from_secs(timeout_s));
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let mut resp = req.send().await.map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status().as_u16();
    let text = read_limited_text(&mut resp).await?;
    if !(200..300).contains(&status) {
        return Err(http_error("GET", status, &text));
    }
    serde_json::from_str(&text).map_err(|e| format!("响应非 JSON（{e}）：{}", text.chars().take(160).collect::<String>()))
}

pub(crate) async fn post_json(
    url: &str,
    headers: Vec<(String, String)>,
    body: Value,
    timeout_s: u64,
) -> Result<Value, String> {
    let mut req = client()
        .post(url)
        .timeout(std::time::Duration::from_secs(timeout_s))
        .header("Content-Type", "application/json")
        .json(&body);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let mut resp = req.send().await.map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status().as_u16();
    let text = read_limited_text(&mut resp).await?;
    if !(200..300).contains(&status) {
        return Err(http_error("POST", status, &text));
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|e| format!("响应非 JSON（{e}）：{}", text.chars().take(160).collect::<String>()))
}

/// M6：限量读取响应体（Content-Length 预检 + 流式截断，16MB 上限）。
/// 目录列表 JSON 理论上可达数 MB，16MB 足够宽裕；防恶意网关推大响应耗内存。
async fn read_limited_text(resp: &mut reqwest::Response) -> Result<String, String> {
    const MAX: usize = 16 * 1024 * 1024;
    if let Some(len) = resp.content_length() {
        if len as usize > MAX {
            return Err(format!("响应体超限（{len} > {MAX} 字节）"));
        }
    }
    let mut out: Vec<u8> = Vec::with_capacity(64 * 1024);
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("读取失败: {e}"))? {
        if out.len() + chunk.len() > MAX {
            return Err(format!("响应体超限（>{MAX} 字节）"));
        }
        out.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

/// 相对直链补全为绝对地址
pub(crate) fn join_url(base: &str, url: &str) -> String {
    if url.starts_with("http://") || url.starts_with("https://") {
        return url.to_string();
    }
    let base = base.trim_end_matches('/');
    if let Some(rest) = url.strip_prefix('/') {
        // base 可能带路径前缀（http://host/gw），只替换到 host 段之后
        if let Some(scheme_end) = base.find("://") {
            let after = &base[scheme_end + 3..];
            let host_end = after.find('/').map(|i| scheme_end + 3 + i).unwrap_or(base.len());
            return format!("{}{}", &base[..host_end], format!("/{rest}"));
        }
        format!("{base}/{rest}")
    } else {
        format!("{base}/{url}")
    }
}

fn auth_headers(cred: &Credentials) -> Vec<(String, String)> {
    match cred.bearer() {
        Some(b) => vec![("Authorization".into(), b)],
        None => Vec::new(),
    }
}

fn base_of(cred: &Credentials) -> Result<String, String> {
    cred.base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| s.starts_with("http://") || s.starts_with("https://"))
        .map(|s| s.trim_end_matches('/').to_string())
        .ok_or_else(|| "缺少网关地址（baseUrl，需 http(s) 开头）".to_string())
}

fn parse_item(v: &Value) -> Option<NetdiskItem> {
    let id = opt_str(v, &["id", "fileId", "fsId"])?;
    let name = opt_str(v, &["name", "fileName", "title"]).unwrap_or_else(|| id.clone());
    let is_dir = v
        .get("isDir")
        .or_else(|| v.get("isdir"))
        .or_else(|| v.get("dir"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let size = opt_i64(v, &["size", "bytes"]).unwrap_or(0).max(0) as u64;
    let modified = opt_i64(v, &["modifiedAt", "modified", "mtime"]).map(|n| if n < 10_000_000_000 { n * 1000 } else { n });
    Some(NetdiskItem::classify(id, name, is_dir, size, modified))
}

fn parse_headers(v: Option<&Value>) -> Vec<(String, String)> {
    let Some(v) = v else { return Vec::new() };
    let mut out = Vec::new();
    if let Some(obj) = v.as_object() {
        for (k, val) in obj {
            if let Some(s) = val.as_str() {
                out.push((k.clone(), s.to_string()));
            }
        }
    } else if let Some(arr) = v.as_array() {
        for pair in arr {
            if let (Some(k), Some(val)) = (
                pair.get(0).and_then(Value::as_str),
                pair.get(1).and_then(Value::as_str),
            ) {
                out.push((k.to_string(), val.to_string()));
            }
        }
    }
    out
}

// ---------- HTTP 目录适配器 ----------

pub struct HttpDirProvider;

impl HttpDirProvider {
    pub fn new() -> Self {
        Self
    }

    async fn list_inner(
        &self,
        cred: &Credentials,
        dir_id: &str,
        cursor: Option<&str>,
        page_size: u32,
    ) -> Result<Page, String> {
        let base = base_of(cred)?;
        let mut url = format!(
            "{base}/api/list?dir={}&size={}",
            urlencode(if dir_id.is_empty() { "root" } else { dir_id }),
            page_size.max(1)
        );
        if let Some(c) = cursor {
            url.push_str(&format!("&cursor={}", urlencode(c)));
        }
        let v = get_json(&url, auth_headers(cred), 20).await?;
        let items = v
            .get("items")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(parse_item).collect::<Vec<_>>())
            .unwrap_or_default();
        Ok(Page {
            items,
            next_cursor: opt_str(&v, &["nextCursor", "next"]),
            total: opt_i64(&v, &["total"]).map(|n| n.max(0) as u64),
        })
    }
}

impl Default for HttpDirProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl Provider for HttpDirProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Http
    }
    fn name(&self) -> &'static str {
        "HTTP 目录网关"
    }
    fn auth_modes(&self) -> Vec<AuthMode> {
        vec![AuthMode::Token, AuthMode::DeviceCode]
    }

    fn verify<'a>(&'a self, cred: &'a Credentials) -> BoxFut<'a, Result<(), String>> {
        Box::pin(async move { self.list_inner(cred, "root", None, 1).await.map(|_| ()) })
    }

    fn list<'a>(
        &'a self,
        cred: &'a Credentials,
        dir_id: &'a str,
        cursor: Option<&'a str>,
        page_size: u32,
    ) -> BoxFut<'a, Result<Page, String>> {
        Box::pin(async move { self.list_inner(cred, dir_id, cursor, page_size).await })
    }

    fn resolve<'a>(&'a self, cred: &'a Credentials, file_id: &'a str) -> BoxFut<'a, Result<PlayTarget, String>> {
        Box::pin(async move {
            let base = base_of(cred)?;
            let url = format!("{base}/api/resolve?id={}", urlencode(file_id));
            let v = get_json(&url, auth_headers(cred), 20).await?;
            let raw = opt_str(&v, &["url", "link", "downloadUrl"])
                .ok_or_else(|| "网关未返回直链（url）".to_string())?;
            // 直链请求同样带网盘凭据（网关契约：/dl 也需要 Bearer），
            // 再叠加网关显式下发的附加头（如 Referer / X-* 防盗链）
            let mut headers = auth_headers(cred);
            for h in parse_headers(v.get("headers")) {
                if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case(&h.0)) {
                    headers.push(h);
                }
            }
            Ok(PlayTarget {
                url: join_url(&base, &raw),
                headers,
                expires_at: opt_i64(&v, &["expiresAt", "expires"]),
                ext: opt_str(&v, &["ext"]),
            })
        })
    }

    fn refresh<'a>(&'a self, cred: &'a Credentials) -> BoxFut<'a, Result<Credentials, String>> {
        Box::pin(async move {
            let base = base_of(cred)?;
            let body = json!({ "refreshToken": cred.refresh_token.clone().unwrap_or_default() });
            let v = post_json(&format!("{base}/api/refresh"), auth_headers(cred), body, 20).await?;
            let mut next = cred.clone();
            if let Some(t) = opt_str(&v, &["accessToken", "access_token", "token"]) {
                next.access_token = Some(t);
            }
            if let Some(t) = opt_str(&v, &["refreshToken", "refresh_token"]) {
                next.refresh_token = Some(t);
            }
            next.expires_at = opt_i64(&v, &["expiresAt"])
                .or_else(|| opt_i64(&v, &["expiresIn"]).and_then(expires_from_secs));
            Ok(next)
        })
    }

    fn device_auth<'a>(&'a self, client_id: &'a str) -> BoxFut<'a, Result<AuthChallenge, String>> {
        Box::pin(async move {
            if client_id.is_empty() {
                return Err("设备码授权需要先填写网关 clientId".into());
            }
            let base = normalize_base(client_id).map_err(|_| "clientId 需填网关地址（http(s)://…）".to_string())?;
            let v = post_json(&format!("{base}/api/auth/begin"), vec![], json!({ "clientId": client_id }), 20).await?;
            Ok(AuthChallenge {
                device_code: opt_str(&v, &["deviceCode"]).ok_or("网关未返回 deviceCode")?,
                user_code: opt_str(&v, &["userCode"]).unwrap_or_default(),
                verification_uri: opt_str(&v, &["verificationUri"]).unwrap_or_default(),
                interval_secs: opt_i64(&v, &["intervalSecs"]).unwrap_or(5).max(1) as u64,
                expires_in: opt_i64(&v, &["expiresIn"]).unwrap_or(900).max(1) as u64,
                message: opt_str(&v, &["message"]),
            })
        })
    }

    fn poll_device_auth<'a>(
        &'a self,
        client_id: &'a str,
        device_code: &'a str,
    ) -> BoxFut<'a, Result<AuthOutcome, String>> {
        Box::pin(async move {
            let base = normalize_base(client_id).map_err(|_| "clientId 需填网关地址".to_string())?;
            let url = format!("{base}/api/auth/poll?deviceCode={}", urlencode(device_code));
            let v = get_json(&url, vec![], 20).await?;
            let pending = v.get("pending").and_then(Value::as_bool).unwrap_or(false);
            if pending {
                return Ok(AuthOutcome { pending: true, cred: None, message: opt_str(&v, &["message"]) });
            }
            let mut cred = Credentials {
                base_url: Some(base),
                ..Default::default()
            };
            cred.access_token = opt_str(&v, &["accessToken", "access_token"]);
            cred.refresh_token = opt_str(&v, &["refreshToken", "refresh_token"]);
            cred.expires_at = opt_i64(&v, &["expiresAt"])
                .or_else(|| opt_i64(&v, &["expiresIn"]).and_then(expires_from_secs));
            Ok(AuthOutcome { pending: false, cred: Some(cred), message: None })
        })
    }

    fn list_share<'a>(
        &'a self,
        _cred: &'a Credentials,
        _share: &'a ShareRef,
        _dir_id: &'a str,
        _cursor: Option<&'a str>,
        _page_size: u32,
    ) -> BoxFut<'a, Result<Page, String>> {
        Box::pin(async { Err("HTTP 目录网关不支持分享链接（直接填网关地址即可）".into()) })
    }
}

fn normalize_base(s: &str) -> Result<String, String> {
    let t = s.trim().trim_end_matches('/');
    if t.starts_with("http://") || t.starts_with("https://") {
        Ok(t.to_string())
    } else {
        Err("invalid".into())
    }
}

/// 最小 percent-encode（保留 unreserved 字符）
pub(crate) fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_url_handles_relative_forms() {
        assert_eq!(join_url("http://h:8080", "/dl/a.mp4"), "http://h:8080/dl/a.mp4");
        assert_eq!(join_url("http://h:8080/gw/", "dl/a.mp4"), "http://h:8080/gw/dl/a.mp4");
        assert_eq!(join_url("http://h:8080/gw", "/dl/a.mp4"), "http://h:8080/dl/a.mp4");
        // 绝对地址原样
        assert_eq!(join_url("http://h", "https://cdn/a.mp4"), "https://cdn/a.mp4");
    }

    #[test]
    fn urlencode_escapes_reserved() {
        assert_eq!(urlencode("a b/c"), "a%20b%2Fc");
        assert_eq!(urlencode("中文"), "%E4%B8%AD%E6%96%87");
        assert_eq!(urlencode("a-b_c.d~e"), "a-b_c.d~e");
    }

    #[test]
    fn parse_item_classifies_video_and_seconds_mtime() {
        let v = json!({ "id": "f1", "name": "movie.MKV", "isDir": false, "size": 100, "modifiedAt": 1_700_000_000 });
        let it = parse_item(&v).unwrap();
        assert_eq!(it.kind, "video");
        assert_eq!(it.ext.as_deref(), Some("mkv"));
        // 秒级时间戳自动升为毫秒
        assert_eq!(it.modified_at, Some(1_700_000_000_000));
        // 目录
        let d = parse_item(&json!({ "id": "d1", "name": "合集", "isDir": true })).unwrap();
        assert!(d.is_dir && d.kind == "dir");
        // 数字 id 容错
        let n = parse_item(&json!({ "id": 42, "name": "x.mp4" })).unwrap();
        assert_eq!(n.id, "42");
    }

    #[test]
    fn expires_from_secs_is_absolute() {
        let e = expires_from_secs(900).unwrap();
        assert!(e > now_ms() + 800_000);
        assert!(expires_from_secs(0).is_none());
    }
}
