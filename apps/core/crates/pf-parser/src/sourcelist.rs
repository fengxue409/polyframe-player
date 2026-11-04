//! 源清单解析：把网络上流传的各种「源站清单」格式统一归一为 `(name, api)`。
//!
//! 纯解析、零网络，便于单测。支持：
//!  - 纯文本：每行 `名称$URL` / `名称,URL` / `名称 URL` / 裸 URL（`#`、`//`、`;` 开头为注释）
//!  - JSON：LibreTV-SourceList `{"sources":[{"name","url"}]}`、MoonTV `{"api_site":{k:{"name","api"}}}`、
//!    根数组 `[{"name","url"}]`，以及任意含 `api` 字段的对象（含 `isAdult` 标记）
//!  - Base58：MoonTV / LunaTV 订阅链接常见的 Base58(JSON) 文本
//!
//! 归一规则：api 去首尾空白与尾部 `/`；必须 http(s) 开头；按 api 去重（大小写不敏感）。

use serde_json::Value;

/// 单条候选源站
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceCandidate {
    pub name: String,
    pub api: String,
    /// 清单自带的成人内容标记（仅记录，是否入库由上层决定）
    pub adult: bool,
}

/// 单次导入的候选上限（防误粘超长文件）
pub const MAX_CANDIDATES: usize = 500;

/// 文本 → 候选源站列表（无法识别时返回空）
pub fn parse_sources(text: &str) -> Vec<SourceCandidate> {
    let t = text.trim_start_matches('\u{feff}').trim();
    if t.is_empty() || t.len() > 4 * 1024 * 1024 {
        return Vec::new();
    }

    let mut out = Vec::new();
    if t.starts_with('{') || t.starts_with('[') {
        if let Ok(v) = serde_json::from_str::<Value>(t) {
            collect_json(&v, false, &mut out);
        }
    } else if looks_base58(t) {
        if let Some(bytes) = base58_decode(t) {
            if let Ok(decoded) = String::from_utf8(bytes) {
                if let Ok(v) = serde_json::from_str::<Value>(decoded.trim_start_matches('\u{feff}').trim()) {
                    collect_json(&v, false, &mut out);
                }
            }
        }
    }
    if out.is_empty() {
        parse_lines(t, &mut out);
    }
    dedupe(out)
}

// ---------- JSON / Base58 ----------

/// 容器键：其子数组内的 `url` 才当作源站地址，避免把海报/详情页链接当源站
fn is_source_container(key: &str) -> bool {
    matches!(key, "sources" | "sites" | "api_site" | "apis" | "list" | "data" | "config" | "vod" | "cms")
}

fn name_of(map: &serde_json::Map<String, Value>) -> Option<String> {
    for k in ["name", "title", "label", "site", "nick"] {
        if let Some(s) = map.get(k).and_then(Value::as_str) {
            let s = clean_name(s);
            if !s.is_empty() {
                return Some(s);
            }
        }
    }
    None
}

fn collect_json(v: &Value, in_source_container: bool, out: &mut Vec<SourceCandidate>) {
    match v {
        Value::Object(map) => {
            let adult = map.get("isAdult").and_then(Value::as_bool).unwrap_or(false)
                || map.get("is_adult").and_then(Value::as_bool).unwrap_or(false);
            let mut pushed = false;
            if let Some(api) = map.get("api").and_then(Value::as_str) {
                if let Some(c) = make_candidate(name_of(map).unwrap_or_default(), api, adult) {
                    out.push(c);
                    pushed = true;
                }
            }
            if !pushed && in_source_container {
                if let Some(url) = map.get("url").and_then(Value::as_str) {
                    if let Some(c) = make_candidate(name_of(map).unwrap_or_default(), url, adult) {
                        out.push(c);
                    }
                }
            }
            for (k, val) in map {
                if k == "liveSources" || k == "live_sources" || k == "live" {
                    continue; // 直播源（m3u）不属采集站体系
                }
                collect_json(val, is_source_container(k), out);
            }
        }
        Value::Array(arr) => {
            for item in arr {
                collect_json(item, true, out);
            }
        }
        _ => {}
    }
}

/// Base58 快速判定：长度足够且字符全在字母表内
fn looks_base58(t: &str) -> bool {
    const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    if t.len() < 40 || t.len() > 512 * 1024 {
        return false;
    }
    t.bytes().all(|b| ALPHABET.contains(&b))
}

/// Base58 解码（大整数按字节进位，避免引入 bignum 依赖）
fn base58_decode(s: &str) -> Option<Vec<u8>> {
    const ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut table = [255u8; 128];
    for (i, c) in ALPHABET.iter().enumerate() {
        table[*c as usize] = i as u8;
    }
    let mut out: Vec<u8> = Vec::new(); // 小端
    for ch in s.bytes() {
        if ch as usize >= 128 {
            return None;
        }
        let v = table[ch as usize];
        if v == 255 {
            return None;
        }
        let mut carry = v as u32;
        for b in out.iter_mut() {
            let x = (*b as u32) * 58 + carry;
            *b = (x & 0xff) as u8;
            carry = x >> 8;
        }
        while carry > 0 {
            out.push((carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    for ch in s.bytes() {
        if ch == b'1' {
            out.push(0);
        } else {
            break;
        }
    }
    out.reverse();
    Some(out)
}

// ---------- 纯文本 ----------

fn parse_lines(text: &str, out: &mut Vec<SourceCandidate>) {
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with("//") || line.starts_with(';') {
            continue;
        }
        let Some(pos) = line.find("http://").or_else(|| line.find("https://")) else {
            continue;
        };
        let rest = &line[pos..];
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        let url = &rest[..end];
        let prefix = line[..pos].trim();
        let name = clean_name(prefix.trim_end_matches(|c: char| {
            matches!(c, '$' | ',' | '|' | '\t' | '-' | '—' | ':' | '：' | '=')
        }));
        if let Some(c) = make_candidate(name, url, false) {
            out.push(c);
        }
    }
}

// ---------- 归一 ----------

fn clean_name(s: &str) -> String {
    s.trim()
        .trim_start_matches(|c: char| matches!(c, '*' | '-' | '—' | '•' | '|'))
        .trim()
        .chars()
        .take(40)
        .collect::<String>()
        .trim()
        .to_string()
}

fn host_of(url: &str) -> String {
    url.split("//")
        .nth(1)
        .unwrap_or(url)
        .split('/')
        .next()
        .unwrap_or(url)
        .trim_start_matches("www.")
        .to_string()
}

/// 归一 api 并构造候选；非法地址返回 None
fn make_candidate(name: String, api: &str, adult: bool) -> Option<SourceCandidate> {
    let api = api.trim().trim_end_matches('/');
    if !(api.starts_with("http://") || api.starts_with("https://")) {
        return None;
    }
    let host = host_of(api);
    if host.is_empty() || !host.contains('.') {
        return None;
    }
    let name = if name.trim().is_empty() { host } else { clean_name(&name) };
    Some(SourceCandidate { name, api: api.to_string(), adult })
}

/// 去重（保留首个；先出现的占位主机名可被后续更完整的名称替换）
fn dedupe(list: Vec<SourceCandidate>) -> Vec<SourceCandidate> {
    let mut out: Vec<SourceCandidate> = Vec::new();
    let mut idx: std::collections::HashMap<String, usize> = Default::default();
    for c in list {
        let key = c.api.to_lowercase();
        match idx.get(&key) {
            Some(&i) => {
                let existing = &out[i];
                if existing.name == host_of(&existing.api) && c.name != host_of(&c.api) {
                    out[i].name = c.name;
                }
                out[i].adult = out[i].adult || c.adult;
            }
            None => {
                idx.insert(key, out.len());
                out.push(c);
                if out.len() >= MAX_CANDIDATES {
                    break;
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_plain_lines() {
        let text = "\n# 注释\n量子资源$http://cj.lziapi.com/api.php/provide/vod/\n\
                    非凡资源,https://cj.ffzyapi.com/api.php/provide/vod\n\
                    暴风资源 https://bfzyapi.com/api.php/provide/vod  # 行内注释\n\
                    https://api.wujinapi.com/api.php/provide/vod\n\
                    重复行$http://cj.lziapi.com/api.php/provide/vod/\n\
                    乱七八糟没有链接\n";
        let got = parse_sources(text);
        assert_eq!(got.len(), 4, "{got:?}");
        assert_eq!(got[0].name, "量子资源");
        assert_eq!(got[0].api, "http://cj.lziapi.com/api.php/provide/vod");
        assert_eq!(got[1].name, "非凡资源");
        assert_eq!(got[2].name, "暴风资源");
        // 裸 URL → 主机名兜底（去 www.）
        assert_eq!(got[3].name, "api.wujinapi.com");
    }

    #[test]
    fn test_libretv_source_list() {
        let json = r#"{
          "name": "我的源列表", "version": 2,
          "sources": [
            {"name": "示例点播源", "url": "https://example.com/api.php/provide/vod", "detail": "https://example.com"},
            {"url": "https://cdn.demo.tv/api.php/provide/vod/"},
            {"name": "带标记", "url": "https://x.demo.tv/api.php/provide/vod", "isAdult": true}
          ],
          "liveSources": [{"name": "直播", "url": "https://example.com/list.m3u"}]
        }"#;
        let got = parse_sources(json);
        assert_eq!(got.len(), 3, "{got:?}");
        assert_eq!(got[0].name, "示例点播源");
        assert_eq!(got[1].name, "cdn.demo.tv");
        assert!(got[2].adult);
        // 直播源不入采集站体系
        assert!(got.iter().all(|c| !c.api.ends_with(".m3u")));
    }

    #[test]
    fn test_moontv_api_site() {
        let json = r#"{"cache_time":7200,"api_site":{
            "lziapi.com":{"name":"🎬-量子-","api":"http://cj.lziapi.com/api.php/provide/vod","detail":"http://x"},
            "dbzy.tv":{"name":"豆瓣","api":"https://caiji.dbzy5.com/api.php/provide/vod","isAdult":true}
        }}"#;
        let got = parse_sources(json);
        assert_eq!(got.len(), 2);
        // 对象键序不稳定（serde_json 默认 BTreeMap），按内容断言
        assert!(got.iter().any(|c| c.name == "🎬-量子-" && c.api.contains("lziapi.com") && !c.adult));
        let db = got.iter().find(|c| c.name == "豆瓣").expect("豆瓣条目");
        assert_eq!(db.api, "https://caiji.dbzy5.com/api.php/provide/vod");
        assert!(db.adult);
    }

    #[test]
    fn test_root_array_and_garbage() {
        let got = parse_sources(r#"[{"name":"A","url":"https://a.tv/api.php/provide/vod"},{"name":"无地址"}]"#);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "A");
        // 非 http / 无点号 → 丢弃
        assert!(parse_sources(r#"[{"api":"ftp://a.tv/x"},{"api":"http://localhost/x"}]"#).is_empty());
        assert!(parse_sources("   ").is_empty());
    }

    #[test]
    fn test_base58_subscription() {
        const ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
        // 测试用编码器（与解码器互为反运算）
        fn encode(input: &[u8]) -> String {
            let mut digits: Vec<u8> = vec![0];
            for b in input {
                let mut carry = *b as u32;
                for d in digits.iter_mut() {
                    let x = (*d as u32) * 256 + carry;
                    *d = (x % 58) as u8;
                    carry = x / 58;
                }
                while carry > 0 {
                    digits.push((carry % 58) as u8);
                    carry /= 58;
                }
            }
            let mut s = String::new();
            for _ in 0..input.iter().take_while(|b| **b == 0).count() {
                s.push('1');
            }
            for d in digits.iter().rev() {
                s.push(ALPHABET[*d as usize] as char);
            }
            s
        }

        let json = r#"{"sources":[{"name":"量子","url":"http://cj.lziapi.com/api.php/provide/vod"}]}"#;
        let encoded = encode(json.as_bytes());
        assert_eq!(base58_decode(&encoded).unwrap(), json.as_bytes());

        // Base58 订阅文本可直接解析出源站
        let got = parse_sources(&encoded);
        assert_eq!(got.len(), 1, "{got:?}");
        assert_eq!(got[0].name, "量子");
        assert_eq!(got[0].api, "http://cj.lziapi.com/api.php/provide/vod");

        // 字母表外字符 → 解码失败
        assert!(base58_decode("0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl").is_none());
        // 含 JSON 结构的文本不会被误判为 base58
        assert!(!looks_base58(json));
    }
}
