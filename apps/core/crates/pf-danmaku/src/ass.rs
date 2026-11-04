//! ASS 字幕生成：把弹幕时间轴导出成 libass 可渲染的 v4+ 脚本。
//!
//! 为什么要这条路径：libmpv 内核把视频渲染在**独立的 Win32 子窗口**里
//! （`pf-mpv/src/window.rs` 用 `WS_CHILD` 挂在主窗口 HWND 下），
//! 子窗口恒定绘制在父窗口客户区之上、不参与 Chromium 合成 ——
//! 也就是说 renderer 里的任何 DOM/Canvas 在 mpv 模式下**必然被视频盖住**。
//! 所以 mpv 内核的弹幕只能交给 mpv 自己画（`sub-add` 加载本模块生成的 ASS）。
//!
//! 轨道分配算法与前端 Canvas 引擎（`danmaku/track.ts`）保持同一套语义，
//! 两处改动需同步，否则切换内核时弹幕密度观感会突变。

use crate::model::{DanmakuItem, DanmakuMode, MAX_TEXT_CHARS};

/// 滚动弹幕穿屏时长（秒）—— 与前端 `scrollDuration` 默认值一致
pub const SCROLL_DURATION_SECS: f64 = 8.0;
/// 顶部/底部弹幕停留时长（秒）
pub const STATIC_DURATION_SECS: f64 = 5.0;
/// 轨道间最小垂直间隙（相对字号的倍数）
const TRACK_GAP_RATIO: f64 = 0.45;
/// 同轨道前后两条的最小水平间隙（相对字号的倍数）
const ITEM_GAP_RATIO: f64 = 0.8;

/// 字号档位（相对播放高度的比例）
pub fn font_size_for(height: f64, scale: f64) -> f64 {
    // 基准：1080p 下 36px；scale 为前端「字号」倍率（0.6 ~ 1.8）
    (height * 0.033 * scale).clamp(16.0, height * 0.09)
}

/// 估算文本像素宽度。
///
/// libass 的真实排版拿不到测量结果，只能估算；误差靠 `ITEM_GAP_RATIO` 的
/// 保守间隙吸收。CJK 近全宽、ASCII 近半宽是字体排版的稳定规律。
pub fn estimate_text_width(text: &str, font_size: f64) -> f64 {
    let mut w = 0.0;
    for c in text.chars() {
        w += if is_cjk(c) {
            font_size
        } else if c.is_ascii_uppercase() || c.is_ascii_digit() {
            font_size * 0.58
        } else if c.is_ascii() {
            font_size * 0.50
        } else {
            // 全角标点、emoji 等按全宽
            font_size * 0.95
        };
    }
    w.max(font_size * 0.5)
}

fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3000..=0x303F |  // CJK 标点
        0x3040..=0x30FF |  // 日文假名
        0x3400..=0x4DBF |  // 扩展 A
        0x4E00..=0x9FFF |  // 基本汉字
        0xF900..=0xFAFF |  // 兼容汉字
        0xFF00..=0xFFEF |  // 全角
        0x20000..=0x2FA1F  // 扩展 B+
    )
}

/// 单轨道状态
#[derive(Debug, Clone, Copy, Default)]
struct TrackState {
    /// 最近一条的入场时间
    last_t: f64,
    /// 最近一条的宽度
    last_w: f64,
    /// 最近一条的速度（px/s）
    last_v: f64,
    /// 顶部/底部模式：占用到何时
    busy_until: f64,
}

/// 布局结果：一条弹幕落在哪条轨道、何时起止
#[derive(Debug, Clone, PartialEq)]
pub struct PlacedItem {
    pub item: DanmakuItem,
    /// 轨道索引（0 起，自上而下）
    pub track: usize,
    /// ASS 用的纵坐标（Alignment=7/8/2 语义下的锚点 y）
    pub y: f64,
    /// 估算文字宽度
    pub width: f64,
    /// 滚动速度（px/s）；固定弹幕为 0
    pub speed: f64,
    pub start: f64,
    pub end: f64,
}

/// 轨道分配器：时间顺序贪心，保证同轨道不重叠、不追尾
pub struct TrackAllocator {
    width: f64,
    height: f64,
    font_size: f64,
    line_height: f64,
    track_count: usize,
    scroll: Vec<TrackState>,
    top: Vec<TrackState>,
    bottom: Vec<TrackState>,
}

impl TrackAllocator {
    pub fn new(width: f64, height: f64, font_size: f64) -> Self {
        let w = width.max(320.0);
        let h = height.max(180.0);
        let fs = font_size.clamp(10.0, 200.0);
        let line_height = fs * (1.0 + TRACK_GAP_RATIO);
        // 上下各留 4% 安全区（避免贴边被裁）
        let usable = h * 0.92;
        let track_count = ((usable / line_height).floor() as usize).max(1);
        Self {
            width: w,
            height: h,
            font_size: fs,
            line_height,
            track_count,
            scroll: vec![TrackState::default(); track_count],
            top: vec![TrackState::default(); track_count],
            bottom: vec![TrackState::default(); track_count],
        }
    }

    pub fn track_count(&self) -> usize {
        self.track_count
    }

    fn gap(&self) -> f64 {
        self.font_size * ITEM_GAP_RATIO
    }

    /// 判断某条滚动轨道在 `t` 时刻能否放入宽度 `w`、速度 `v` 的新弹幕
    fn scroll_track_ok(&self, st: &TrackState, t: f64, w: f64) -> bool {
        if st.last_v <= 0.0 {
            return true; // 空轨道
        }
        let elapsed = t - st.last_t;
        if elapsed < 0.0 {
            return false; // 时间倒退（乱序），保守拒绝
        }
        let travelled = st.last_v * elapsed;
        // 条件 1：前一条尾部已完全进入屏幕（不压右边界）
        let ok_enter = travelled >= st.last_w + self.gap();
        // 条件 2：前一条已远离到新弹幕追不上（不遮挡/不追尾）
        let ok_follow = travelled >= w + self.gap();
        ok_enter && ok_follow
    }

    /// 放置一条弹幕。返回 None = 该时刻屏满，丢弃（不再排队，避免延迟累积穿帮）
    pub fn place(&mut self, item: &DanmakuItem, t: f64) -> Option<PlacedItem> {
        let w = estimate_text_width(&item.text, self.font_size);
        match item.mode {
            DanmakuMode::Scroll => {
                let v = (self.width + w) / SCROLL_DURATION_SECS;
                let idx = (0..self.track_count).find(|&i| self.scroll_track_ok(&self.scroll[i], t, w))?;
                self.scroll[idx] = TrackState {
                    last_t: t,
                    last_w: w,
                    last_v: v,
                    busy_until: t + SCROLL_DURATION_SECS,
                };
                let y = self.height * 0.04 + idx as f64 * self.line_height;
                Some(PlacedItem {
                    item: item.clone(),
                    track: idx,
                    y,
                    width: w,
                    speed: v,
                    start: t,
                    end: t + SCROLL_DURATION_SECS,
                })
            }
            DanmakuMode::Top | DanmakuMode::Bottom => {
                let is_top = item.mode == DanmakuMode::Top;
                let pool = if is_top { &mut self.top } else { &mut self.bottom };
                let idx = (0..self.track_count).find(|&i| pool[i].busy_until <= t)?;
                pool[idx] = TrackState {
                    last_t: t,
                    last_w: w,
                    last_v: 0.0,
                    busy_until: t + STATIC_DURATION_SECS,
                };
                let y = if is_top {
                    self.height * 0.04 + idx as f64 * self.line_height
                } else {
                    self.height * 0.96 - idx as f64 * self.line_height
                };
                Some(PlacedItem {
                    item: item.clone(),
                    track: idx + self.track_count, // 与滚动轨道编号区分（仅内部用）
                    y,
                    width: w,
                    speed: 0.0,
                    start: t,
                    end: t + STATIC_DURATION_SECS,
                })
            }
        }
    }
}

/// ASS 时间格式 `H:MM:SS.cc`
pub fn ass_time(sec: f64) -> String {
    let t = sec.max(0.0);
    let h = (t / 3600.0).floor() as u64;
    let m = ((t % 3600.0) / 60.0).floor() as u64;
    let s = t % 60.0;
    format!("{h}:{m:02}:{s:05.2}")
}

/// `#RRGGBB` → ASS 的 `&H00BBGGRR&`（BGR 顺序，注意不是 RGB）
pub fn ass_color(hex: &str) -> String {
    let h = hex.trim_start_matches('#');
    if h.len() != 6 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return "&H00FFFFFF&".into();
    }
    let r = &h[0..2];
    let g = &h[2..4];
    let b = &h[4..6];
    format!("&H00{}{}{}&", b.to_ascii_uppercase(), g.to_ascii_uppercase(), r.to_ascii_uppercase())
}

/// ASS 文本转义：花括号是覆盖标签定界符、反斜杠是转义符，替换为全角等价字符。
/// 换行在入库前已被压平，这里不再处理 `\N`。
fn ass_escape(text: &str) -> String {
    text.chars()
        .take(MAX_TEXT_CHARS)
        .map(|c| match c {
            '{' => '｛',
            '}' => '｝',
            '\\' => '＼',
            c => c,
        })
        .collect()
}

/// 生成完整 ASS 脚本
///
/// - `width`/`height`：视频分辨率（mpv 的 `width` / `height` 属性，缺省 1920×1080）
/// - `font_scale`：前端字号倍率
/// - `alpha`：不透明度 0..1（1 = 完全不透明），转成 ASS 的 `&HAA&` 透明度
/// - `max_items`：防御性上限，超出截断（ASS 文件过大会拖慢 libass 首次解析）
pub fn build_ass(
    items: &[DanmakuItem],
    width: f64,
    height: f64,
    font_scale: f64,
    alpha: f64,
    max_items: usize,
) -> String {
    let w = if width.is_finite() && width >= 320.0 { width } else { 1920.0 };
    let h = if height.is_finite() && height >= 180.0 { height } else { 1080.0 };
    let fs = font_size_for(h, font_scale);
    let mut alloc = TrackAllocator::new(w, h, fs);

    // 透明度：(1-alpha)*255，ASS 里 FF = 全透明
    let a = ((1.0 - alpha.clamp(0.0, 1.0)) * 255.0).round() as u32;

    let mut out = String::with_capacity(1024 + items.len() * 96);
    out.push_str("[Script Info]\n");
    out.push_str("ScriptType: v4.00+\n");
    out.push_str(&format!("PlayResX: {w:.0}\n"));
    out.push_str(&format!("PlayResY: {h:.0}\n"));
    out.push_str("ScaledBorderAndShadow: yes\n");
    out.push_str("WrapStyle: 2\n");
    out.push_str("Collisions: Normal\n");
    out.push('\n');
    out.push_str("[V4+ Styles]\n");
    out.push_str(
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, \
         Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, \
         Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n",
    );
    // 描边保证在亮背景上也看得清（弹幕可读性的下限保障）
    out.push_str(&format!(
        "Style: DM,Microsoft YaHei,{fs:.1},&H{a:02X}FFFFFF,&H{a:02X}FFFFFF,&H{a:02X}000000,\
         &H{a:02X}000000,0,0,0,0,100,100,0,0,1,1.6,0,7,0,0,0,1\n"
    ));
    out.push('\n');
    out.push_str("[Events]\n");
    out.push_str("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n");

    // 时间序 + 上限截断（保留前半集优先：用户先看开头）
    let mut sorted: Vec<&DanmakuItem> = items.iter().collect();
    sorted.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap_or(std::cmp::Ordering::Equal));
    sorted.truncate(max_items.max(1));

    // 轨道状态是按时间推进的，必须严格按 time 升序放置
    for it in sorted {
        if !it.time.is_finite() || it.time < 0.0 {
            continue;
        }
        let Some(p) = alloc.place(it, it.time) else {
            continue;
        };
        let color = ass_color(&it.color);
        let text = ass_escape(&it.text);
        let tag = match it.mode {
            DanmakuMode::Scroll => {
                // 从右侧屏外滑入，滑到左侧屏外
                let x1 = w + p.width / 2.0;
                let x2 = -p.width / 2.0;
                // Alignment=7（左上），\move 用左上角坐标
                format!(
                    "{{\\c{color}\\move({x1:.1},{y:.1},{x2:.1},{y:.1})}}",
                    y = p.y
                )
            }
            DanmakuMode::Top => format!("{{\\an8\\c{color}\\pos({cx:.1},{y:.1})}}", cx = w / 2.0, y = p.y),
            DanmakuMode::Bottom => format!("{{\\an2\\c{color}\\pos({cx:.1},{y:.1})}}", cx = w / 2.0, y = p.y),
        };
        out.push_str(&format!(
            "Dialogue: 0,{},{},DM,,0,0,0,,{}{}\n",
            ass_time(p.start),
            ass_time(p.end),
            tag,
            text
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::make_id;

    fn item(t: f64, text: &str, mode: DanmakuMode) -> DanmakuItem {
        DanmakuItem {
            id: make_id("t", "c", t, text),
            time: t,
            text: text.into(),
            mode,
            color: "#FFFFFF".into(),
            source: "t".into(),
            ctime: None,
            fx: None,
        }
    }

    #[test]
    fn ass_time_formats() {
        assert_eq!(ass_time(0.0), "0:00:00.00");
        assert_eq!(ass_time(61.5), "0:01:01.50");
        assert_eq!(ass_time(3661.25), "1:01:01.25");
        assert_eq!(ass_time(-5.0), "0:00:00.00");
    }

    #[test]
    fn ass_color_swaps_to_bgr() {
        assert_eq!(ass_color("#FF0000"), "&H000000FF&");
        assert_eq!(ass_color("#00FF00"), "&H0000FF00&");
        assert_eq!(ass_color("#FFFFFF"), "&H00FFFFFF&");
        assert_eq!(ass_color("bad"), "&H00FFFFFF&");
    }

    #[test]
    fn escape_protects_tags() {
        assert_eq!(ass_escape("a{b}c\\d"), "a｛b｝c＼d");
    }

    #[test]
    fn width_estimate_is_monotonic() {
        let a = estimate_text_width("ab", 32.0);
        let b = estimate_text_width("abcd", 32.0);
        assert!(b > a);
        // 中文比等量 ASCII 宽
        let cjk = estimate_text_width("中文", 32.0);
        let ascii = estimate_text_width("ab", 32.0);
        assert!(cjk > ascii);
    }

    #[test]
    fn allocator_separates_overlapping_scroll() {
        let mut a = TrackAllocator::new(1920.0, 1080.0, 36.0);
        // 同一时刻两条应落在不同轨道
        let p1 = a.place(&item(10.0, "第一条", DanmakuMode::Scroll), 10.0).unwrap();
        let p2 = a.place(&item(10.0, "第二条", DanmakuMode::Scroll), 10.0).unwrap();
        assert_ne!(p1.track, p2.track);
    }

    #[test]
    fn allocator_reuses_track_after_gap() {
        let mut a = TrackAllocator::new(1920.0, 1080.0, 36.0);
        let p1 = a.place(&item(10.0, "短", DanmakuMode::Scroll), 10.0).unwrap();
        // 足够长时间后同一轨道应可复用
        let p2 = a.place(&item(30.0, "短", DanmakuMode::Scroll), 30.0).unwrap();
        assert_eq!(p1.track, p2.track);
    }

    #[test]
    fn allocator_rejects_when_full() {
        let mut a = TrackAllocator::new(640.0, 200.0, 40.0);
        let n = a.track_count();
        for i in 0..n {
            assert!(a.place(&item(1.0, &format!("弹幕{i}"), DanmakuMode::Scroll), 1.0).is_some());
        }
        // 屏满 → 丢弃
        assert!(a.place(&item(1.0, "溢出", DanmakuMode::Scroll), 1.0).is_none());
    }

    #[test]
    fn allocator_ignores_time_going_backwards() {
        let mut a = TrackAllocator::new(1920.0, 1080.0, 36.0);
        assert!(a.place(&item(10.0, "甲", DanmakuMode::Scroll), 10.0).is_some());
        // 时间倒退到同一条轨道 → 第一条轨道拒绝，但其他轨道仍可用
        let p = a.place(&item(9.0, "乙", DanmakuMode::Scroll), 9.0).unwrap();
        assert_eq!(p.track, 1);
    }

    #[test]
    fn top_and_bottom_are_independent_pools() {
        let mut a = TrackAllocator::new(1920.0, 1080.0, 36.0);
        let t = a.place(&item(5.0, "顶", DanmakuMode::Top), 5.0).unwrap();
        let b = a.place(&item(5.0, "底", DanmakuMode::Bottom), 5.0).unwrap();
        assert_eq!(t.track, a.track_count());
        assert_eq!(b.track, a.track_count());
        assert!(t.y < 200.0);
        assert!(b.y > 900.0);
    }

    #[test]
    fn build_ass_has_required_sections() {
        let items = vec![
            item(1.0, "滚动", DanmakuMode::Scroll),
            item(2.0, "顶部", DanmakuMode::Top),
            item(3.0, "底部", DanmakuMode::Bottom),
        ];
        let ass = build_ass(&items, 1920.0, 1080.0, 1.0, 1.0, 1000);
        assert!(ass.contains("[Script Info]"));
        assert!(ass.contains("PlayResX: 1920"));
        assert!(ass.contains("[V4+ Styles]"));
        assert!(ass.contains("[Events]"));
        assert_eq!(ass.matches("Dialogue:").count(), 3);
        assert!(ass.contains("\\move("));
        assert!(ass.contains("\\an8"));
        assert!(ass.contains("\\an2"));
    }

    #[test]
    fn build_ass_clamps_bad_dimensions() {
        let ass = build_ass(&[item(1.0, "x", DanmakuMode::Scroll)], 0.0, f64::NAN, 1.0, 1.0, 10);
        assert!(ass.contains("PlayResX: 1920"));
        assert!(ass.contains("PlayResY: 1080"));
    }

    #[test]
    fn build_ass_respects_max_items() {
        let items: Vec<_> = (0..100)
            .map(|i| item(i as f64, "x", DanmakuMode::Scroll))
            .collect();
        let ass = build_ass(&items, 1920.0, 1080.0, 1.0, 1.0, 10);
        assert_eq!(ass.matches("Dialogue:").count(), 10);
    }

    #[test]
    fn build_ass_alpha_applied() {
        let ass = build_ass(&[item(1.0, "x", DanmakuMode::Scroll)], 1920.0, 1080.0, 1.0, 0.5, 10);
        // alpha=0.5 → 透明度 128 → 0x80
        assert!(ass.contains("&H80FFFFFF"));
    }
}
