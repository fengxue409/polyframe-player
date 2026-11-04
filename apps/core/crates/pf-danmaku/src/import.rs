//! P15 本地弹幕文件导入解析（纯逻辑，无 IO，可单测）
//!
//! 支持两种主流格式，按内容自动探测：
//! - **B 站 XML**：`<d p="时间,模式,字号,颜色(十进制),...">文本</d>`
//! - **弹弹play JSON**：`{"count":n,"comments":[{"cid":..,"p":"时间,模式,颜色,用户","m":"文本"}]}`
//!
//! 刻意不引 XML 库：B 站弹幕 XML 是扁平的一层 `<d>` 结构，手写扫描即可，
//! 还能对超大文件做流式上限截断（复用 `MAX_BATCH_ITEMS`）。

use super::model::{
    dedup_sorted, make_id, normalize_color, sanitize_text, DanmakuError, DanmakuItem, DanmakuMode,
    MAX_BATCH_ITEMS,
};

/// 探测到的文件格式
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportFormat {
    Xml,
    Json,
}

impl ImportFormat {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Xml => "xml",
            Self::Json => "json",
        }
    }
}

/// 按内容探测格式。
///
/// - `<` 开头 → XML 系（B站弹幕 XML 一定是 XML；空弹幕文件也应报"没有弹幕"，
///   而不是"无法识别格式"，所以不要求必须出现 `<d `）
/// - `{` / `[` 开头且**整体能解析成 JSON** → JSON 系（只做前缀判断会把随便一段
///   以 `[` 开头的文本误判，整份解析一次最稳；导入是低频操作，多解析一次无所谓）
///
/// 注意：这里**不做字节切片**。旧实现写的是 `&content[..content.len().min(8192)]`，
/// 第 8192 字节落在汉字中间时（UTF-8 汉字 3 字节，中文弹幕文件几乎必然命中）
/// 会让内核直接 panic —— 字符串切片是按字节的，没有明确需求就不要切。
pub fn detect_format(content: &str) -> Option<ImportFormat> {
    let body = content.trim_start_matches('\u{feff}').trim_start();
    if body.is_empty() {
        return None;
    }
    if body.starts_with('<') {
        return Some(ImportFormat::Xml);
    }
    if body.starts_with('{') || body.starts_with('[') {
        return serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .map(|_| ImportFormat::Json);
    }
    None
}

/// 导入入口：探测格式 → 解析 → 净化 → 去重排序。
/// `channel` 用于生成稳定 ID。返回 (格式, 条目)。
pub fn parse_import(content: &str, channel: &str) -> Result<(ImportFormat, Vec<DanmakuItem>), String> {
    let fmt = detect_format(content).ok_or_else(|| "无法识别弹幕格式（支持 B 站 XML / 弹弹play JSON）".to_string())?;
    let mut items = match fmt {
        ImportFormat::Xml => parse_bilibili_xml(content, channel),
        ImportFormat::Json => parse_dandanplay_json(content, channel),
    }?;
    if items.is_empty() {
        return Err("文件中没有可导入的弹幕".into());
    }
    dedup_sorted(&mut items);
    Ok((fmt, items))
}

/// XML 实体反转义（含十进制/十六进制数字引用）
fn xml_unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < s.len() {
        if bytes[i] == b'&' {
            if let Some(semi) = s[i..].find(';') {
                let ent = &s[i + 1..i + semi];
                let rep = match ent {
                    "lt" => Some('<'.to_string()),
                    "gt" => Some('>'.to_string()),
                    "amp" => Some('&'.to_string()),
                    "quot" => Some('"'.to_string()),
                    "apos" => Some('\''.to_string()),
                    _ => {
                        if let Some(hex) = ent.strip_prefix("#x").or_else(|| ent.strip_prefix("#X")) {
                            u32::from_str_radix(hex, 16).ok().and_then(char::from_u32).map(|c| c.to_string())
                        } else if let Some(dec) = ent.strip_prefix('#') {
                            dec.parse::<u32>().ok().and_then(char::from_u32).map(|c| c.to_string())
                        } else {
                            None
                        }
                    }
                };
                if let Some(r) = rep {
                    out.push_str(&r);
                    i += semi + 1;
                    continue;
                }
            }
        }
        // 只按字符边界推进（& 不在边界上时安全：ASCII 字节必然是字符边界）
        let ch = s[i..].chars().next().unwrap_or('&');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// 解析 B 站 XML 弹幕。逐段扫描 `<d ...>text</d>`，坏条目跳过不报错。
pub fn parse_bilibili_xml(content: &str, channel: &str) -> Result<Vec<DanmakuItem>, String> {
    let mut items = Vec::new();
    let mut rest = content;
    while items.len() < MAX_BATCH_ITEMS {
        // 找下一个 <d
        let Some(open) = find_tag(rest, "<d") else { break };
        let after_open = &rest[open..];
        let Some(gt) = after_open.find('>') else { break };
        let attrs = &after_open[2..gt]; // ` d ...` 的属性区
        let body_start = open + gt + 1;
        let after_body = &rest[body_start.min(rest.len())..];
        let Some(close_rel) = after_body.find("</d>") else { break };
        let text_raw = &after_body[..close_rel];
        // 下一次扫描从 </d> 之后开始（rest 是本层基准，切片必须相对它）
        rest = &after_body[close_rel + 4..];

        // p 属性：p="time,mode,size,color,..."
        let p = attr_value(attrs, "p");
        let Some(p) = p else { continue };
        let cols: Vec<&str> = p.split(',').collect();
        let time: f64 = cols.first().and_then(|v| v.trim().parse().ok()).unwrap_or(-1.0);
        if !(time.is_finite() && time >= 0.0) {
            continue;
        }
        let mode = cols
            .get(1)
            .and_then(|v| v.trim().parse::<i64>().ok())
            .map(DanmakuMode::from_cm_mode)
            .unwrap_or(DanmakuMode::Scroll);
        let color = cols
            .get(3)
            .map(|v| normalize_color(v.trim()))
            .unwrap_or_else(|| "#FFFFFF".into());
        let text = match sanitize_text(&xml_unescape(text_raw)) {
            Ok(t) => t,
            // 空文本/超长直接跳过；导入场景不值得整文件报错
            Err(DanmakuError::Empty | DanmakuError::ControlChars) => continue,
            Err(DanmakuError::TooLong(_)) => continue,
        };
        items.push(DanmakuItem {
            id: make_id("import", channel, time, &text),
            time,
            text,
            mode,
            color,
            source: "import".into(),
            ctime: None,
            fx: None,
        });
    }
    Ok(items)
}

/// 解析弹弹play JSON 弹幕（`comments[].p` = "time,mode,color,user"）。
///
/// 也吃顶层数组（`[{...}]`）和通用字段（`time`/`text`/`mode`/`color`）——
/// 市面上不少导出工具直接输出数组，只为这一种结构再报错不值得。
fn parse_dandanplay_json(content: &str, channel: &str) -> Result<Vec<DanmakuItem>, String> {
    let v: serde_json::Value =
        serde_json::from_str(content).map_err(|e| format!("JSON 解析失败：{e}"))?;
    let comments = match v.get("comments").and_then(|c| c.as_array()) {
        Some(a) => a,
        None => v
            .as_array()
            .ok_or_else(|| "JSON 中既没有 comments 数组，也不是弹幕数组".to_string())?,
    };
    let mut items = Vec::new();
    for c in comments.iter().take(MAX_BATCH_ITEMS) {
        if let Some(it) = json_row_to_item(c, channel) {
            items.push(it);
        }
    }
    Ok(items)
}

/// 单行 JSON → 弹幕。优先按 `p` 串（弹弹play / B站 同构），否则按平铺字段。
fn json_row_to_item(c: &serde_json::Value, channel: &str) -> Option<DanmakuItem> {
    let text_raw = c.get("m").and_then(|m| m.as_str()).unwrap_or_default();
    let p = c.get("p").and_then(|p| p.as_str()).unwrap_or_default();

    if !p.trim().is_empty() {
        let cols: Vec<&str> = p.split(',').collect();
        let time: f64 = cols.first()?.trim().parse().ok()?;
        if !(time.is_finite() && time >= 0.0) {
            return None;
        }
        let mode = cols
            .get(1)
            .and_then(|v| v.trim().parse::<i64>().ok())
            .map(DanmakuMode::from_cm_mode)
            .unwrap_or(DanmakuMode::Scroll);
        let color = cols
            .get(2)
            .map(|v| normalize_color(v.trim()))
            .unwrap_or_else(|| "#FFFFFF".into());
        let text = sanitize_text(text_raw).ok()?;
        return Some(DanmakuItem {
            id: make_id("import", channel, time, &text),
            time,
            text,
            mode,
            color,
            source: "import".into(),
            ctime: None,
            fx: None,
        });
    }

    // 通用字段：time/t/start + text/content/msg
    let time = ["time", "t", "stime", "start"]
        .iter()
        .find_map(|k| c.get(*k).and_then(json_num))?;
    if !(time.is_finite() && time >= 0.0) {
        return None;
    }
    let raw = ["text", "content", "msg", "m"]
        .iter()
        .find_map(|k| c.get(*k).and_then(|x| x.as_str()))?;
    let text = sanitize_text(raw).ok()?;
    let mode = match c.get("mode").or_else(|| c.get("type")) {
        Some(serde_json::Value::Number(n)) => n
            .as_i64()
            .map(DanmakuMode::from_cm_mode)
            .unwrap_or(DanmakuMode::Scroll),
        Some(serde_json::Value::String(s)) => DanmakuMode::parse(s),
        _ => DanmakuMode::Scroll,
    };
    let color = match c.get("color") {
        Some(serde_json::Value::Number(n)) => {
            normalize_color(&n.as_i64().unwrap_or(0xFF_FFFF).to_string())
        }
        Some(serde_json::Value::String(s)) => normalize_color(s),
        _ => "#FFFFFF".into(),
    };
    Some(DanmakuItem {
        id: make_id("import", channel, time, &text),
        time,
        text,
        mode,
        color,
        source: "import".into(),
        ctime: None,
        fx: None,
    })
}

/// JSON 数字宽容读取：同时接受数字与数字字符串（导出脚本常写成 `"1.5"`）
fn json_num(v: &serde_json::Value) -> Option<f64> {
    if let Some(f) = v.as_f64() {
        return f.is_finite().then_some(f);
    }
    v.as_str()
        .and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|f| f.is_finite())
}

/// 在 `s` 中找标签起点，且要求其后是空白或 `>`（避免匹配到 `<div>`）
fn find_tag(s: &str, tag: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(pos) = s[from..].find(tag) {
        let abs = from + pos;
        let after = s[abs + tag.len()..].chars().next();
        if matches!(after, Some(' ') | Some('>') | Some('\t') | Some('\n') | Some('\r')) {
            return Some(abs);
        }
        from = abs + tag.len();
        if from >= s.len() {
            break;
        }
    }
    None
}

/// 从属性文本中取 `key="value"`（容忍单引号、容忍 `=` 两侧空格）
fn attr_value(attrs: &str, key: &str) -> Option<String> {
    if let Some(v) = attr_value_strict(attrs, key) {
        return Some(v);
    }
    // `<d p = "1,2,3">` 这种等号两侧带空格的写法：压缩后再试一次
    let squeezed = squeeze_eq_spaces(attrs);
    if squeezed == attrs {
        return None;
    }
    attr_value_strict(&squeezed, key)
}

fn attr_value_strict(attrs: &str, key: &str) -> Option<String> {
    for part in attrs.split_whitespace() {
        let Some((k, v)) = part.split_once('=') else { continue };
        if k != key {
            continue;
        }
        let v = v.trim();
        let v = v.strip_prefix('"').or_else(|| v.strip_prefix('\'')).unwrap_or(v);
        let v = v.strip_suffix('"').or_else(|| v.strip_suffix('\'')).unwrap_or(v);
        return Some(v.to_string());
    }
    None
}

/// 把 `\s*=\s*` 压成 `=`（只为了兼容手改过的属性写法）
fn squeeze_eq_spaces(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '=' {
            while matches!(out.chars().last(), Some(' ') | Some('\t') | Some('\n') | Some('\r')) {
                out.pop();
            }
            out.push('=');
            while matches!(chars.peek(), Some(' ') | Some('\t') | Some('\n') | Some('\r')) {
                chars.next();
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_formats() {
        assert_eq!(detect_format(r#"<d p="1.0,1">hi</d>"#), Some(ImportFormat::Xml));
        assert_eq!(
            detect_format(r#"{"count":1,"comments":[{"cid":1,"p":"1,1,16777215,0","m":"a"}]}"#),
            Some(ImportFormat::Json)
        );
        assert_eq!(detect_format("plain text"), None);
    }

    #[test]
    fn xml_unescape_entities() {
        assert_eq!(xml_unescape("a &lt; b &amp; c &#39;d&#39; &#x4E2D;"), "a < b & c 'd' 中");
        assert_eq!(xml_unescape("no entity"), "no entity");
        assert_eq!(xml_unescape("bad &unknown; stay"), "bad &unknown; stay");
    }

    #[test]
    fn parse_bilibili_xml_basic() {
        let xml = r#"<?xml version="1.0"?><i>
<chatserver>chat</chatserver>
<d p="1.5,1,25,16711680,0,0,0,0">红色滚动</d>
<d p="10,5,25,255,0,0,0,0">顶部蓝</d>
<d p="8,4,25,16777215,0,0,0,0">底部</d>
<d p="bad,1,25,0,0,0,0,0">坏时间</d>
<d p="12,1,25,0,0,0,0,0">   </d>
</i>"#;
        let items = parse_bilibili_xml(xml, "ch1").unwrap();
        assert_eq!(items.len(), 3, "坏条目应跳过：{items:?}");
        assert!((items[0].time - 1.5).abs() < 1e-9);
        assert_eq!(items[0].color, "#FF0000");
        assert_eq!(items[1].mode, DanmakuMode::Top);
        assert_eq!(items[2].mode, DanmakuMode::Bottom);
    }

    #[test]
    fn parse_bilibili_xml_unescapes_and_ignores_div() {
        let xml = r#"<i><d p="3,1,25,0,0,0,0,0">&lt;script&gt; &amp; ok</d><div>not danmaku</div></i>"#;
        let items = parse_bilibili_xml(xml, "ch").unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "<script> & ok");
    }

    #[test]
    fn parse_dandanplay_json_basic() {
        let json = r#"{"count":2,"comments":[
{"cid":1,"p":"2.0,1,16777215,0","m":"第一条"},
{"cid":2,"p":"4,4,255,0","m":"底部蓝"},
{"cid":3,"p":"x,1,0,0","m":"坏时间"}
]}"#;
        let items = parse_dandanplay_json(json, "ch2").unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].text, "第一条");
        assert_eq!(items[1].mode, DanmakuMode::Bottom);
        assert_eq!(items[1].color, "#0000FF");
    }

    #[test]
    fn parse_import_sorts_and_dedups() {
        let xml = r#"<d p="5,1,25,0,0,0,0,0">same</d><d p="1,1,25,0,0,0,0,0">first</d><d p="5,1,25,0,0,0,0,0">same</d>"#;
        let (fmt, items) = parse_import(xml, "ch3").unwrap();
        assert_eq!(fmt, ImportFormat::Xml);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].text, "first");
        assert_eq!(items[1].text, "same");
    }

    #[test]
    fn parse_import_rejects_garbage() {
        assert!(parse_import("hello world", "ch").is_err());
        assert!(parse_import(r#"{"comments":[]}"#, "ch").is_err());
    }

    #[test]
    fn detect_format_survives_multibyte_boundary() {
        // 回归：旧实现 `&content[..8192]` 在第 8192 字节落在汉字中间时直接 panic。
        // 中文弹幕文件必然命中（UTF-8 汉字 3 字节），这是会崩内核的真缺陷。
        // 构造：`<i>` + 8188 个 'a' = 8191 字节，再 push '中' 占 8191..8194，
        // 于是字节 8192 正好落在汉字内部。
        let mut s = String::from("<i>");
        s.push_str(&"a".repeat(8188));
        assert_eq!(s.len(), 8191);
        s.push('中');
        s.push_str(r#"<d p="1,1,25,0,0,0,0,0">x</d>"#);
        assert!(s.len() > 8192);
        assert!(!s.is_char_boundary(8192), "构造应让 8192 落在字符中间");
        // 不应 panic
        assert_eq!(detect_format(&s), Some(ImportFormat::Xml));
        let (_, items) = parse_import(&s, "ch").unwrap();
        assert_eq!(items.len(), 1);
    }

    #[test]
    fn attr_value_tolerates_spaces_around_eq() {
        let xml = r#"<i><d p = "2.5,5,25,16711680,0,0,0,1">带空格</d></i>"#;
        let items = parse_bilibili_xml(xml, "ch").unwrap();
        assert_eq!(items.len(), 1);
        assert!((items[0].time - 2.5).abs() < 1e-9);
        assert_eq!(items[0].mode, DanmakuMode::Top);
    }

    #[test]
    fn attr_value_accepts_single_quotes() {
        let xml = r#"<i><d p='3,4,25,255,0,0,0,1'>单引号</d></i>"#;
        let items = parse_bilibili_xml(xml, "ch").unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].mode, DanmakuMode::Bottom);
        assert_eq!(items[0].color, "#0000FF");
    }

    #[test]
    fn parses_top_level_json_array() {
        let s = r#"[
            {"time":1.5,"text":"数组一"},
            {"t":"2.5","content":"数组二","type":5,"color":16711680},
            {"time":"x","text":"坏时间"}
        ]"#;
        let out = parse_import(s, "ch").unwrap();
        assert_eq!(out.0, ImportFormat::Json);
        assert_eq!(out.1.len(), 2);
        assert_eq!(out.1[0].text, "数组一");
        assert_eq!(out.1[1].mode, DanmakuMode::Top);
        assert_eq!(out.1[1].color, "#FF0000");
    }

    #[test]
    fn json_row_prefers_p_over_plain_fields() {
        // 同时有 p 与 time/text 时以 p 为准（弹弹play 的权威时间轴）
        let s = r#"{"comments":[{"p":"9,1,0,0","m":"来自p","time":1,"text":"来自字段"}]}"#;
        let (_, items) = parse_import(s, "ch").unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].text, "来自p");
        assert!((items[0].time - 9.0).abs() < 1e-9);
    }
}
