//! pf-danmaku：弹幕能力层
//!
//! 分三块，都不依赖 pf-engine / pf-core，可独立单测：
//!  - [`model`]：领域模型、文本净化、颜色归一、时间轴缩放
//!  - [`dandanplay`]：第三方弹幕库客户端（签名 / 搜索 / 拉取）
//!  - [`ass`]：ASS 字幕生成（libmpv 内核下的弹幕渲染路径）
//!
//! 本地发送的**限流与去重**放在 [`SendGuard`]：状态机保持纯函数式（时间戳外部传入），
//! 这样「重复发送 / 连点刷屏」这类缺陷可以用单测钉死，不依赖真实时钟。

pub mod ass;
pub mod dandanplay;
pub mod import;
pub mod model;

pub use ass::{build_ass, TrackAllocator};
pub use dandanplay::{
    normalize_anime_title, guess_episode_no, DanmakuCredentials, DandanplayClient, DpError,
    EpisodeCandidate,
};
pub use import::{parse_import, ImportFormat};
pub use model::{
    dedup_sorted, is_blocked, make_id, normalize_color, normalize_fx, sanitize_blocked_words,
    sanitize_text, scale_time, DanmakuError, DanmakuItem, DanmakuMode, DUP_WINDOW_SECS,
    MAX_BATCH_ITEMS, MAX_BLOCKED_WORD_CHARS, MAX_BLOCKED_WORDS, MAX_TEXT_CHARS,
    MIN_SEND_INTERVAL_SECS,
};

/// 本地发送被拒原因
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendReject {
    /// 同内容在去重窗口内重复
    Duplicate,
    /// 距上一条太近（连点）
    TooFast { retry_after_ms: u64 },
    /// 文本非法
    Invalid(DanmakuError),
}

impl SendReject {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Duplicate => "duplicate",
            Self::TooFast { .. } => "too_fast",
            Self::Invalid(e) => e.code(),
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::Duplicate => "相同内容刚刚发过了".into(),
            Self::TooFast { retry_after_ms } => {
                format!("发送太快了，{} 秒后可再发", (*retry_after_ms as f64 / 1000.0).ceil() as u64)
            }
            Self::Invalid(e) => e.message(),
        }
    }
}

/// 本地发送守卫：去重 + 限流
///
/// 时间戳由调用方传入（毫秒），保证可测试；`recent` 只保留一个去重窗口内的条目，
/// 常驻内存规模上界 = 窗口内发送条数，不会无限增长。
#[derive(Debug, Default)]
pub struct SendGuard {
    /// 最近一次通过校验的时间（ms）
    last_ok_ms: Option<u64>,
    /// 去重窗口内的已发内容 `(时间, 归一化文本)`
    recent: Vec<(u64, String)>,
}

impl SendGuard {
    pub fn new() -> Self {
        Self::default()
    }

    /// 校验并记账。`Ok` 表示已计入限流状态。
    pub fn check(&mut self, raw_text: &str, now_ms: u64) -> Result<String, SendReject> {
        let text = sanitize_text(raw_text).map_err(SendReject::Invalid)?;
        let window_ms = (DUP_WINDOW_SECS * 1000.0) as u64;
        // 淘汰窗口外条目
        self.recent.retain(|(t, _)| now_ms.saturating_sub(*t) < window_ms);

        if self.recent.iter().any(|(_, t)| t == &text) {
            return Err(SendReject::Duplicate);
        }
        if let Some(last) = self.last_ok_ms {
            let interval = (MIN_SEND_INTERVAL_SECS * 1000.0) as u64;
            let elapsed = now_ms.saturating_sub(last);
            if elapsed < interval {
                return Err(SendReject::TooFast {
                    retry_after_ms: interval - elapsed,
                });
            }
        }
        self.last_ok_ms = Some(now_ms);
        self.recent.push((now_ms, text.clone()));
        Ok(text)
    }

    /// 播放切换时重置（换集后不应继承上一集的去重窗口）
    pub fn reset(&mut self) {
        self.last_ok_ms = None;
        self.recent.clear();
    }

    #[cfg(test)]
    fn window_len(&self) -> usize {
        self.recent.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_send_passes() {
        let mut g = SendGuard::new();
        assert_eq!(g.check("你好", 1_000).unwrap(), "你好");
    }

    #[test]
    fn duplicate_within_window_rejected() {
        let mut g = SendGuard::new();
        g.check("你好", 1_000).unwrap();
        // 越过 1.5s 间隔但仍在 10s 去重窗口内
        assert_eq!(g.check("你好", 3_000), Err(SendReject::Duplicate));
    }

    #[test]
    fn duplicate_allowed_after_window() {
        let mut g = SendGuard::new();
        g.check("你好", 1_000).unwrap();
        assert!(g.check("你好", 1_000 + 10_001).is_ok());
    }

    #[test]
    fn rapid_fire_rejected() {
        let mut g = SendGuard::new();
        g.check("a", 1_000).unwrap();
        assert_eq!(
            g.check("b", 1_200),
            Err(SendReject::TooFast { retry_after_ms: 1300 })
        );
    }

    #[test]
    fn interval_boundary_passes() {
        let mut g = SendGuard::new();
        g.check("a", 1_000).unwrap();
        // 恰好 1.5s 后
        assert!(g.check("b", 2_500).is_ok());
    }

    #[test]
    fn empty_rejected() {
        let mut g = SendGuard::new();
        assert!(matches!(
            g.check("   ", 1_000),
            Err(SendReject::Invalid(DanmakuError::Empty))
        ));
    }

    #[test]
    fn overlong_rejected() {
        let mut g = SendGuard::new();
        let s = "字".repeat(MAX_TEXT_CHARS + 1);
        assert!(matches!(g.check(&s, 1_000), Err(SendReject::Invalid(_))));
    }

    #[test]
    fn rejected_send_does_not_consume_budget() {
        let mut g = SendGuard::new();
        assert!(g.check("", 1_000).is_err());
        // 上一次失败不应影响下一次合法发送
        assert!(g.check("合法内容", 1_100).is_ok());
    }

    #[test]
    fn window_does_not_grow_unbounded() {
        let mut g = SendGuard::new();
        for i in 0..1000u64 {
            let _ = g.check(&format!("msg{i}"), i * 2_000);
        }
        // 每条间隔 2s > 1.5s，但去重窗口 10s → 最多保留 6 条
        assert!(g.window_len() <= 6, "window grew to {}", g.window_len());
    }

    #[test]
    fn reset_clears_state() {
        let mut g = SendGuard::new();
        g.check("你好", 1_000).unwrap();
        g.reset();
        assert!(g.check("你好", 1_100).is_ok());
    }

    #[test]
    fn normalized_text_dedups_variants() {
        let mut g = SendGuard::new();
        g.check("你好", 1_000).unwrap();
        // 前后空格属于同一内容
        assert_eq!(g.check("  你好  ", 3_000), Err(SendReject::Duplicate));
    }
}
