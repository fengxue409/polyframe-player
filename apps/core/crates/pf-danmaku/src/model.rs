//! 弹幕领域模型 + 文本/颜色校验（纯逻辑，无 IO，可单测）
//!
//! 字段与 `packages/shared` 的 `DanmakuItem` 同构（serde camelCase）。
//! 时间轴约定：`time` 是**相对本集视频起点**的秒数（绝对时间轴），
//! 与播放器 currentTime / mpv time-pos 同一基准 —— 换源后若片长不同，
//! 由上层用 `scale_time` 做线性压缩，而不是让渲染层猜。

use serde::{Deserialize, Serialize};

/// 单条弹幕文本上限（字符数，非字节）。超过直接拒绝，避免超长弹幕铺满整屏。
pub const MAX_TEXT_CHARS: usize = 100;
/// 本地发送限流：同内容在该窗口内不允许重复（秒）
pub const DUP_WINDOW_SECS: f64 = 10.0;
/// 本地发送限流：两条之间最短间隔（秒），防连点刷屏
pub const MIN_SEND_INTERVAL_SECS: f64 = 1.5;
/// 单次拉取返回条数上限（超出截断，防超高并发把内存打爆）
pub const MAX_BATCH_ITEMS: usize = 8000;

/// 弹幕显示模式
///
/// 序列化为小写字符串，与前端 `'scroll' | 'top' | 'bottom'` 及 DB 列值一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DanmakuMode {
    /// 从右向左滚动
    Scroll,
    /// 顶部固定
    Top,
    /// 底部固定
    Bottom,
}

impl DanmakuMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Scroll => "scroll",
            Self::Top => "top",
            Self::Bottom => "bottom",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "top" => Self::Top,
            "bottom" => Self::Bottom,
            _ => Self::Scroll,
        }
    }

    /// B 站 / 弹弹play 的 `p` 字段模式码：1-3 滚动，4 底部，5 顶部
    pub fn from_cm_mode(code: i64) -> Self {
        match code {
            4 => Self::Bottom,
            5 => Self::Top,
            _ => Self::Scroll,
        }
    }
}

/// 一条弹幕
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DanmakuItem {
    /// 稳定 ID：`{source}:{channel}:{hash}`，用于前端去重与 React key
    pub id: String,
    /// 相对视频起点的秒数
    pub time: f64,
    pub text: String,
    pub mode: DanmakuMode,
    /// `#RRGGBB`
    pub color: String,
    /// local | dandanplay | import
    pub source: String,
    /// 发送时间戳（ms，第三方源可能缺省）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ctime: Option<i64>,
    /// 渲染特效（P17）：'glow' 发光 / 'gradient' 渐变；None = 普通。
    /// 只对**本地发送**的弹幕有意义（第三方源不携带）；图片弹幕不走这个字段
    /// （text 本身是图片 URL，渲染侧按 URL 识别）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fx: Option<String>,
}

/// 特效取值白名单：非法值一律归 None（脏数据不值得报错打断播放）。
pub fn normalize_fx(raw: Option<&str>) -> Option<String> {
    match raw?.trim() {
        "glow" => Some("glow".into()),
        "gradient" => Some("gradient".into()),
        _ => None,
    }
}

/// 校验错误（前端按 code 展示文案，不做字符串匹配）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DanmakuError {
    Empty,
    TooLong(usize),
    ControlChars,
}

impl DanmakuError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::TooLong(_) => "too_long",
            Self::ControlChars => "bad_chars",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::Empty => "弹幕内容不能为空".into(),
            Self::TooLong(n) => format!("弹幕过长（{n} 字，上限 {MAX_TEXT_CHARS} 字）"),
            Self::ControlChars => "弹幕包含非法字符".into(),
        }
    }
}

/// 文本净化：去控制字符 / 零宽字符 / 多行，再按字符数校验。
///
/// 故意**不做** HTML 转义 —— 渲染走 Canvas/ASS 纯文本绘制，不存在注入面；
/// 转义反而会让 `&lt;` 这类字面量显示成乱码。
pub fn sanitize_text(raw: &str) -> Result<String, DanmakuError> {
    let mut out = String::with_capacity(raw.len());
    let mut had_bad = false;
    for ch in raw.chars() {
        match ch {
            // 换行/制表统一成空格（弹幕不允许换行）
            '\r' | '\n' | '\t' => out.push(' '),
            // 零宽字符：\u{200B}-\u{200F} \u{202A}-\u{202E} \u{FEFF}
            '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{FEFF}' => had_bad = true,
            // 其余 C0/C1 控制字符
            c if c.is_control() => had_bad = true,
            c => out.push(c),
        }
    }
    let trimmed = out.trim();
    if trimmed.is_empty() {
        return Err(DanmakuError::Empty);
    }
    let n = trimmed.chars().count();
    if n > MAX_TEXT_CHARS {
        return Err(DanmakuError::TooLong(n));
    }
    // 只有控制字符被剔除但文本仍有内容 → 视为含非法字符
    if had_bad && trimmed.chars().all(|c| c.is_whitespace()) {
        return Err(DanmakuError::ControlChars);
    }
    Ok(trimmed.to_string())
}

/// 颜色归一到 `#RRGGBB`：支持 `#RGB` / `#RRGGBB` / 十进制整数（B 站格式）。
/// 非法输入回落白色，不报错（弹幕颜色不值得打断播放）。
pub fn normalize_color(raw: &str) -> String {
    let s = raw.trim();
    if s.is_empty() {
        return "#FFFFFF".into();
    }
    if let Some(hex) = s.strip_prefix('#') {
        return match hex.len() {
            3 => {
                let mut out = String::from("#");
                for c in hex.chars() {
                    if !c.is_ascii_hexdigit() {
                        return "#FFFFFF".into();
                    }
                    out.push(c);
                    out.push(c);
                }
                out.to_ascii_uppercase()
            }
            6 => {
                if hex.chars().all(|c| c.is_ascii_hexdigit()) {
                    format!("#{}", hex.to_ascii_uppercase())
                } else {
                    "#FFFFFF".into()
                }
            }
            _ => "#FFFFFF".into(),
        };
    }
    // 十进制 RGB（B 站 p 字段的第四列）
    if let Ok(v) = s.parse::<u32>() {
        if v <= 0xFF_FFFF {
            return format!("#{:06X}", v);
        }
    }
    "#FFFFFF".into()
}

/// 时间轴线性压缩：源片长 `src` 与本片长 `dst` 不同时按比例贴合。
///
/// 不这么做的话，换源后弹幕会整体错位（60 分钟版对 45 分钟版能差出 15 分钟）。
/// 任一侧时长缺失/非法时原样返回。
pub fn scale_time(time: f64, src_duration: Option<f64>, dst_duration: Option<f64>) -> f64 {
    let (Some(src), Some(dst)) = (src_duration, dst_duration) else {
        return time;
    };
    if src <= 0.0 || dst <= 0.0 {
        return time;
    }
    // 偏差 < 2% 视为同一版本，不做缩放（避免无意义的抖动）
    if (src - dst).abs() / src < 0.02 {
        return time;
    }
    (time * dst / src).max(0.0)
}

/// 稳定 ID 生成：源 + 频道 + 时间 + 文本（不含随机数，保证同一弹幕多次拉取 id 一致）
///
/// 时间按**毫秒整数**参与哈希：曾用 `{:.2}` 格式化，结果 12.345 与 12.35 都落成
/// "12.35" 而产生 ID 碰撞，导致前端误判为同一条弹幕被去重掉。
pub fn make_id(source: &str, channel: &str, time: f64, text: &str) -> String {
    use sha2::{Digest, Sha256};
    let ms = if time.is_finite() {
        (time * 1000.0).round() as i64
    } else {
        0
    };
    let mut h = Sha256::new();
    h.update(format!("{channel}|{ms}|{text}").as_bytes());
    let digest = h.finalize();
    let hex: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    format!("{source}:{channel}:{hex}")
}

/// 批量去重 + 排序（拉取侧兜底：第三方源常带重复条目）
pub fn dedup_sorted(items: &mut Vec<DanmakuItem>) {
    items.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap_or(std::cmp::Ordering::Equal));
    items.dedup_by(|a, b| (a.time - b.time).abs() < 0.01 && a.text == b.text && a.mode == b.mode);
}

// ---------- 屏蔽词（P15） ----------

/// 屏蔽词条数上限（防止脏数据把设置项撑爆）
pub const MAX_BLOCKED_WORDS: usize = 200;
/// 单个屏蔽词长度上限（字符）
pub const MAX_BLOCKED_WORD_CHARS: usize = 50;

/// 清洗用户输入的屏蔽词表：trim / 去空 / 去重 / 截断。
/// 返回新 Vec，不修改输入。
pub fn sanitize_blocked_words(raw: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(raw.len().min(MAX_BLOCKED_WORDS));
    for w in raw {
        let t = w.trim();
        if t.is_empty() || t.chars().count() > MAX_BLOCKED_WORD_CHARS {
            continue;
        }
        if !out.iter().any(|x| x == t) {
            out.push(t.to_string());
        }
        if out.len() >= MAX_BLOCKED_WORDS {
            break;
        }
    }
    out
}

/// 命中判定：任一屏蔽词（大小写不敏感）出现在文本中即命中。
/// 空表恒 false —— 过滤器不该在没有配置时产生开销以外的语义。
pub fn is_blocked(text: &str, words: &[String]) -> bool {
    if words.is_empty() {
        return false;
    }
    let lower = text.to_lowercase();
    words.iter().any(|w| lower.contains(&w.to_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_trims_and_collapses_newlines() {
        assert_eq!(sanitize_text("  hello\nworld  ").unwrap(), "hello world");
    }

    #[test]
    fn sanitize_rejects_blank() {
        assert_eq!(sanitize_text("   \n\t "), Err(DanmakuError::Empty));
    }

    #[test]
    fn sanitize_rejects_overlong() {
        let s = "字".repeat(MAX_TEXT_CHARS + 1);
        match sanitize_text(&s) {
            Err(DanmakuError::TooLong(n)) => assert_eq!(n, MAX_TEXT_CHARS + 1),
            other => panic!("expected TooLong, got {other:?}"),
        }
    }

    #[test]
    fn sanitize_accepts_exact_limit() {
        let s = "字".repeat(MAX_TEXT_CHARS);
        assert_eq!(sanitize_text(&s).unwrap().chars().count(), MAX_TEXT_CHARS);
    }

    #[test]
    fn sanitize_strips_zero_width() {
        assert_eq!(sanitize_text("a\u{200B}b").unwrap(), "ab");
    }

    #[test]
    fn sanitize_counts_chars_not_bytes() {
        // 100 个汉字 = 300 字节，必须按字符数判断
        let s = "中".repeat(100);
        assert!(sanitize_text(&s).is_ok());
    }

    #[test]
    fn color_accepts_all_forms() {
        assert_eq!(normalize_color("#fff"), "#FFFFFF");
        assert_eq!(normalize_color("#ff0000"), "#FF0000");
        assert_eq!(normalize_color("16711680"), "#FF0000");
        assert_eq!(normalize_color("0"), "#000000");
        assert_eq!(normalize_color("garbage"), "#FFFFFF");
        assert_eq!(normalize_color("#12345"), "#FFFFFF");
        assert_eq!(normalize_color(""), "#FFFFFF");
    }

    #[test]
    fn scale_time_noop_when_same_duration() {
        assert!((scale_time(100.0, Some(3600.0), Some(3600.0)) - 100.0).abs() < 1e-9);
    }

    #[test]
    fn scale_time_compresses() {
        // 60min 源 → 45min 片，第 3600s 的弹幕应贴到 2700s
        assert!((scale_time(3600.0, Some(3600.0), Some(2700.0)) - 2700.0).abs() < 1e-6);
    }

    #[test]
    fn scale_time_tolerates_missing_duration() {
        assert!((scale_time(42.0, None, Some(100.0)) - 42.0).abs() < 1e-9);
        assert!((scale_time(42.0, Some(0.0), Some(100.0)) - 42.0).abs() < 1e-9);
    }

    #[test]
    fn mode_parses_cm_codes() {
        assert_eq!(DanmakuMode::from_cm_mode(1), DanmakuMode::Scroll);
        assert_eq!(DanmakuMode::from_cm_mode(4), DanmakuMode::Bottom);
        assert_eq!(DanmakuMode::from_cm_mode(5), DanmakuMode::Top);
    }

    #[test]
    fn id_is_stable() {
        let a = make_id("local", "ch1", 12.345, "hi");
        let b = make_id("local", "ch1", 12.345, "hi");
        assert_eq!(a, b);
        let c = make_id("local", "ch1", 12.35, "hi");
        assert_ne!(a, c);
    }

    #[test]
    fn fx_whitelist() {
        assert_eq!(normalize_fx(Some("glow")).as_deref(), Some("glow"));
        assert_eq!(normalize_fx(Some(" gradient ")).as_deref(), Some("gradient"));
        assert_eq!(normalize_fx(Some("bogus")), None);
        assert_eq!(normalize_fx(Some("")), None);
        assert_eq!(normalize_fx(None), None);
    }

    #[test]
    fn fx_roundtrips_via_serde_and_defaults_to_none() {
        let item: DanmakuItem =
            serde_json::from_str(r##"{"id":"i","time":1.0,"text":"a","mode":"scroll","color":"#FFFFFF","source":"local"}"##)
                .unwrap();
        assert_eq!(item.fx, None, "旧数据/缺字段必须平滑落到 None");
        let mut with_fx = item.clone();
        with_fx.fx = Some("glow".into());
        let raw = serde_json::to_string(&with_fx).unwrap();
        assert!(raw.contains(r#""fx":"glow""#));
        // None 序列化时省略字段，保持与旧版本出参兼容
        assert!(!serde_json::to_string(&item).unwrap().contains("\"fx\""));
    }

    #[test]
    fn dedup_keeps_single_copy() {
        let mk = |t: f64, s: &str| DanmakuItem {
            id: make_id("x", "c", t, s),
            time: t,
            text: s.into(),
            mode: DanmakuMode::Scroll,
            color: "#FFFFFF".into(),
            source: "x".into(),
            ctime: None,
            fx: None,
        };
        let mut v = vec![mk(5.0, "a"), mk(1.0, "b"), mk(5.0, "a")];
        dedup_sorted(&mut v);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].text, "b");
        assert_eq!(v[1].text, "a");
    }

    #[test]
    fn blocked_words_case_insensitive_and_empty_safe() {
        let words = vec!["剧透".to_string(), "SPAM".to_string()];
        assert!(is_blocked("前方高能剧透预警", &words));
        assert!(is_blocked("this is spam content", &words));
        assert!(!is_blocked("正常弹幕", &words));
        assert!(!is_blocked("任何文本", &[]), "空表不应命中");
    }

    #[test]
    fn sanitize_blocked_words_trims_dedups_caps() {
        let raw: Vec<String> = [" a ", "a", "", "  ", "b"].iter().map(|s| s.to_string()).collect();
        let out = sanitize_blocked_words(&raw);
        assert_eq!(out, vec!["a", "b"]);
        // 超长词丢弃
        let long = "长".repeat(MAX_BLOCKED_WORD_CHARS + 1);
        assert!(sanitize_blocked_words(&[long]).is_empty());
        // 条数上限
        let many: Vec<String> = (0..300).map(|i| format!("w{i}")).collect();
        assert_eq!(sanitize_blocked_words(&many).len(), MAX_BLOCKED_WORDS);
    }
}
