//! P10 视频云解析：解析接口建链 / 直链提取 / 失效页识别（纯文本，无网络）
//!
//! 第三方「云解析」接口统一形态是 `https://host/?url=<视频站页面地址>`，响应分两类：
//!  - **JSON**：直接给直链（`{"code":200,"url":"https://.../x.m3u8"}`）——优选路径，
//!    拿到直链后可以走本地代理（边下边播 / 缓存 / libmpv / 弹幕外的一切能力）
//!  - **HTML 播放页**：页面内 JS 再向自己的后端拉流，只能内嵌或由主进程嗅探
//!
//! 本模块只做纯文本判定（可单测）：建链、从响应里挖直链、识别「站点已关停」这类
//! 失效页、判断能否被 iframe 内嵌。网络编排在 `pf-core::parse`。

use serde_json::Value;

/// 直链扩展名（m3u8/mp4/mpd/flv；flv 播放器不一定支持，由上层按内核能力决定）
const MEDIA_EXTS: [&str; 4] = [".m3u8", ".mp4", ".mpd", ".flv"];

/// 失效页特征串（2026 实测：大量 `jx.*` 站点被同一套模板替换成关停公告）
const DEAD_MARKERS: [&str; 11] = [
    "江湖路远",
    "后会无期",
    "站点创建成功",
    "域名出售",
    "域名已过期",
    "该站点已关闭",
    "站点已关闭",
    "已停止服务",
    "接口已失效",
    "解析接口已失效",
    "无法访问此网站",
];

// ---------- 基础判定 ----------

/// 是否媒体直链（去 query/hash 后按扩展名判定）
pub fn is_media_url(u: &str) -> bool {
    let t = u.trim();
    if !(t.starts_with("http://") || t.starts_with("https://")) {
        return false;
    }
    let lower = t.to_ascii_lowercase();
    let end = lower.find(['?', '#']).unwrap_or(lower.len());
    MEDIA_EXTS.iter().any(|e| lower[..end].ends_with(e))
}

/// 页面地址归一：缺协议补 https；主机必须像域名（防「庆余年」这类纯词误入）
pub fn normalize_page_url(input: &str) -> Option<String> {
    let t = input.trim();
    if t.is_empty() {
        return None;
    }
    let with_scheme = if t.starts_with("http://") || t.starts_with("https://") {
        t.to_string()
    } else if t.contains("://") {
        return None; // ftp:// 等一律拒绝
    } else {
        format!("https://{t}")
    };
    let rest = with_scheme.split("://").nth(1)?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.split(':').next()?;
    if host.is_empty() || !(host.contains('.') || host == "localhost") {
        return None;
    }
    if with_scheme.chars().any(|c| c.is_whitespace()) {
        return None;
    }
    Some(with_scheme)
}

/// 查询参数百分号编码（等价 encodeURIComponent：只保留 unreserved）
pub fn encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// 接口模板 → 实际请求地址
///
/// 支持三种写法（社区接口两种都存在，不能只认一种）：
///  - `https://host/jx.php?url={url}` / `{url_raw}`（未编码）
///  - `https://host/?url=`（以 `=`/`?` 结尾，直接拼）
///  - `https://host/api?key=1`（已有其他参数，补 `&url=`）
pub fn build_parse_url(api: &str, page: &str) -> String {
    let api = api.trim();
    let enc = encode_component(page);
    if api.contains("{url_raw}") {
        return api.replace("{url_raw}", page);
    }
    if api.contains("{url}") {
        return api.replace("{url}", &enc);
    }
    if api.ends_with('=') || api.ends_with('?') {
        return format!("{api}{enc}");
    }
    if api.contains('?') {
        return format!("{api}&url={enc}");
    }
    format!("{api}?url={enc}")
}

// ---------- 失效页识别 ----------

/// 命中失效页特征则返回该特征串（用于给用户看「接口已关停」而不是「解析失败」）
pub fn dead_marker(text: &str) -> Option<&'static str> {
    // 只看头部：正常播放页体积大，关停公告页通常 < 8KB
    let head: String = text.chars().take(8000).collect();
    let lower = head.to_ascii_lowercase();
    for m in DEAD_MARKERS {
        if lower.contains(&m.to_ascii_lowercase()) {
            return Some(m);
        }
    }
    // 通用错误页：短响应里出现才算（长页面里的 "not found" 多为脚本文案）
    if text.len() < 1500 {
        for m in ["not found", "502 bad gateway", "503 service unavailable", "404"] {
            if lower.contains(m) {
                return Some(if m == "404" { "not found" } else { m });
            }
        }
    }
    None
}

/// 播放页是否「像」一个播放器（用于区分空壳页与真播放页）
pub fn looks_like_player_page(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    ["<video", "player", "<iframe", "m3u8", "hls.js", "dplayer", "artplayer"]
        .iter()
        .any(|k| lower.contains(k))
}

/// iframe 能否内嵌：X-Frame-Options 非 ALLOW / CSP 未禁 frame-ancestors
pub fn frame_blocked(x_frame_options: Option<&str>, csp: Option<&str>) -> bool {
    if let Some(x) = x_frame_options {
        let v = x.trim().to_ascii_lowercase();
        if v == "deny" || v == "sameorigin" || v.starts_with("allow-from") {
            return true;
        }
    }
    if let Some(c) = csp {
        let l = c.to_ascii_lowercase();
        if let Some(pos) = l.find("frame-ancestors") {
            let tail = &l[pos + "frame-ancestors".len()..];
            let tail = tail.split(';').next().unwrap_or("");
            // frame-ancestors 'none' / 'self' 都不允许第三方（我们）内嵌
            if tail.contains("'none'") || tail.contains("'self'") {
                return true;
            }
        }
    }
    false
}

// ---------- 直链提取 ----------

/// 反转义：JSON 里的 `\/`、`\u002F`/`\u003A`、HTML 里的 `&amp;`、二次编码的 `%3A%2F%2F`
///
/// 二次编码（整条 URL 被 encodeURIComponent 过）在部分接口的 JSON 里很常见，
/// 这里连 `%2F` 一起还原——只是给「提取结果」用，不会回写给接口。
pub fn unescape_media_text(s: &str) -> String {
    s.replace("\\/", "/")
        .replace("\\u002F", "/")
        .replace("\\u002f", "/")
        .replace("\\u003A", ":")
        .replace("\\u003a", ":")
        .replace("\\u0026", "&")
        .replace("&amp;", "&")
        .replace("&#x2F;", "/")
        .replace("&#47;", "/")
        .replace("%3A%2F%2F", "://")
        .replace("%3a%2f%2f", "://")
        .replace("%2F", "/")
        .replace("%2f", "/")
        .replace("%3A", ":")
        .replace("%3a", ":")
        .replace("%3F", "?")
        .replace("%3f", "?")
        .replace("%3D", "=")
        .replace("%3d", "=")
        .replace("%26", "&")
}

/// 无引号包裹的裸 URL 扫描（`url: https://x/y.m3u8` 这种，scan_html 抓不到）
fn scan_loose(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (i, _) in text.char_indices() {
        let tail = &text[i..];
        if !(tail.starts_with("http://") || tail.starts_with("https://")) {
            continue;
        }
        let mut end = i;
        for (k, ch) in tail.char_indices() {
            let ok = ch.is_ascii_alphanumeric() || "-._~:/?#[]@!$&()*+,;=%".contains(ch);
            if !ok {
                break;
            }
            end = i + k + ch.len_utf8();
        }
        let cand = &text[i..end];
        if is_media_url(cand) && !out.iter().any(|x| x == cand) {
            out.push(cand.to_string());
        }
    }
    out
}

/// 从响应文本（HTML / JS / JSON 片段）挖出全部直链候选，去重保序
pub fn extract_media(text: &str, base: &str) -> Vec<String> {
    let t = unescape_media_text(text);
    let mut out = crate::scan_html(&t, base);
    for u in scan_loose(&t) {
        if !out.contains(&u) {
            out.push(u);
        }
    }
    // HLS 优先：m3u8 通常就是正主，mp4 多为广告或预告
    out.sort_by_key(|u| if u.to_ascii_lowercase().contains(".m3u8") { 0 } else { 1 });
    out.truncate(20);
    out
}

/// JSON 递归收集媒体直链（常见键优先，保证同一份响应结果稳定）
pub fn collect_json_media(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::String(s) => {
            if is_media_url(s) && !out.iter().any(|x| x == s) {
                out.push(s.clone());
            }
        }
        Value::Array(a) => {
            for x in a {
                collect_json_media(x, out);
            }
        }
        Value::Object(m) => {
            const PRIORITY: [&str; 6] = ["url", "playUrl", "play_url", "m3u8", "video", "src"];
            for k in PRIORITY {
                if let Some(x) = m.get(k) {
                    collect_json_media(x, out);
                }
            }
            for (k, x) in m {
                if !PRIORITY.contains(&k.as_str()) {
                    collect_json_media(x, out);
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_parse_url_with_all_template_shapes() {
        let page = "https://v.qq.com/x/cover/abc.html?x=1";
        let enc = "https%3A%2F%2Fv.qq.com%2Fx%2Fcover%2Fabc.html%3Fx%3D1";
        assert_eq!(
            build_parse_url("https://jx.example.com/?url=", page),
            format!("https://jx.example.com/?url={enc}")
        );
        assert_eq!(
            build_parse_url("https://jx.example.com/jx.php?url={url}", page),
            format!("https://jx.example.com/jx.php?url={enc}")
        );
        assert_eq!(
            build_parse_url("https://jx.example.com/api?key=9", page),
            format!("https://jx.example.com/api?key=9&url={enc}")
        );
        // 裸域名补 ?url=
        assert_eq!(
            build_parse_url("https://jx.example.com", page),
            format!("https://jx.example.com?url={enc}")
        );
        // {url_raw} 不做编码（少数接口自己编码）
        assert_eq!(
            build_parse_url("https://jx.example.com/?u={url_raw}", page),
            format!("https://jx.example.com/?u={page}")
        );
    }

    #[test]
    fn normalizes_page_url() {
        assert_eq!(
            normalize_page_url("  https://v.qq.com/x/cover/a.html ").as_deref(),
            Some("https://v.qq.com/x/cover/a.html")
        );
        assert_eq!(
            normalize_page_url("www.iqiyi.com/v_19.html").as_deref(),
            Some("https://www.iqiyi.com/v_19.html")
        );
        assert_eq!(normalize_page_url("庆余年"), None);
        assert_eq!(normalize_page_url("ftp://a.com/x"), None);
        assert_eq!(normalize_page_url(""), None);
        assert_eq!(normalize_page_url("http://127.0.0.1:9000/p").as_deref(), Some("http://127.0.0.1:9000/p"));
    }

    #[test]
    fn detects_media_and_dead_pages() {
        assert!(is_media_url("https://c.example/a.m3u8?t=1"));
        assert!(is_media_url("https://c.example/a.mp4"));
        assert!(!is_media_url("https://v.qq.com/x/cover/a.html"));
        assert!(!is_media_url("/relative/a.m3u8"));

        // 真实关停模板（2026 实测冰豆/aidouer 都是这套）
        let dead = r#"<!DOCTYPE html><html><body><div>江湖路远，后会无期</div></body></html>"#;
        assert_eq!(dead_marker(dead), Some("江湖路远"));
        assert_eq!(dead_marker("<title>恭喜，站点创建成功！</title>"), Some("站点创建成功"));
        assert_eq!(dead_marker("<html>OK player</html>"), None);
        // 长页面里的 "not found" 不算失效
        let long = format!("{}not found", "a".repeat(4000));
        assert_eq!(dead_marker(&long), None);
    }

    #[test]
    fn extracts_media_from_html_and_json_escapes() {
        let base = "https://jx.example.com/player/";
        // JSON 转义 + 二次编码 + HTML 实体三种形态混排
        let text = r#"var cfg={"url":"https:\/\/cdn.example.com\/v\/ep1.m3u8?k=1"};
        var p2 = "https\u003A\u002F\u002Fcdn.example.com\u002Fv\u002Fep2.mp4";
        var p3 = "https%3A%2F%2Fcdn.example.com%2Fv%2Fep3.m3u8";
        fetch("https://cdn.example.com/v/ep4.m3u8?a=1&amp;b=2")
        unquoted: https://cdn.example.com/v/ep5.m3u8
        <img src="/pic.jpg">"#;
        let got = extract_media(text, base);
        assert!(got.iter().any(|u| u == "https://cdn.example.com/v/ep1.m3u8?k=1"), "{got:?}");
        assert!(got.iter().any(|u| u == "https://cdn.example.com/v/ep2.mp4"), "{got:?}");
        assert!(
            got.iter().any(|u| u == "https://cdn.example.com/v/ep3.m3u8"),
            "二次编码未解码: {got:?}"
        );
        assert!(
            got.iter().any(|u| u == "https://cdn.example.com/v/ep4.m3u8?a=1&b=2"),
            "HTML 实体未解码: {got:?}"
        );
        assert!(got.iter().any(|u| u == "https://cdn.example.com/v/ep5.m3u8"), "{got:?}");
        // m3u8 排在前，且结果里没有图片
        assert!(got[0].contains(".m3u8"), "{got:?}");
        assert!(!got.iter().any(|u| u.ends_with(".jpg")));
    }

    #[test]
    fn collects_json_media_recursively() {
        let v: Value = serde_json::from_str(
            r#"{"code":200,"data":{"url":"https://c.example/a.m3u8","src":"https://c.example/b.mp4",
                "list":[{"play_url":"https://c.example/c.m3u8"}],"poster":"https://c.example/p.jpg"}}"#,
        )
        .unwrap();
        let mut out = Vec::new();
        collect_json_media(&v, &mut out);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0], "https://c.example/a.m3u8");
        assert!(out.iter().all(|u| !u.ends_with(".jpg")));
        // 非媒体 JSON 不产生候选
        let mut empty = Vec::new();
        collect_json_media(&serde_json::json!({"code": 0, "msg": "解析失败"}), &mut empty);
        assert!(empty.is_empty());
    }

    #[test]
    fn judges_iframe_embeddability() {
        assert!(frame_blocked(Some("DENY"), None));
        assert!(frame_blocked(Some("SAMEORIGIN"), None));
        assert!(!frame_blocked(None, None));
        assert!(frame_blocked(None, Some("default-src 'self'; frame-ancestors 'self'")));
        assert!(frame_blocked(None, Some("frame-ancestors 'none'")));
        assert!(!frame_blocked(None, Some("default-src *; frame-ancestors *")));
    }

    #[test]
    fn detects_player_pages() {
        assert!(looks_like_player_page("<video id=x src=y></video>"));
        assert!(looks_like_player_page("<script src=/static/dplayer.js>"));
        assert!(!looks_like_player_page("<h1>404</h1>"));
    }
}
