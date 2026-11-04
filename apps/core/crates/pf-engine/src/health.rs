//! 源健康度模型与选源策略（DESIGN.md §4.2）
//!
//! score(s) = w1·tp_norm + w2·lat_score + w3·success_rate − w4·error_ewma
//! 分片失败 → 同源退避重试 → 换次优源；连续失败 N 片 → 熔断 60s（到期半开试探）。
//! 纯同步无 I/O，便于单测。

use std::time::{Duration, Instant};

use serde::Serialize;

/// 连续失败片数达到阈值 → 熔断
pub const CIRCUIT_THRESHOLD: u32 = 4;
/// 熔断持续时间
pub const CIRCUIT_DURATION: Duration = Duration::from_secs(60);
/// EWMA 平滑系数（越小越平滑）
pub const EWMA_ALPHA: f64 = 0.3;
/// 吞吐归一化基准：5 MB/s 记满分
const TP_NORM_BPS: f64 = 5.0 * 1024.0 * 1024.0;
/// score 权重：吞吐 / 时延 / 成功率 / 错误率
const W_TP: f64 = 2.0;
const W_LAT: f64 = 1.0;
const W_SR: f64 = 2.0;
const W_ERR: f64 = 3.0;
/// 半开源试探惩罚：避免恢复瞬间被并发分片打爆
const HALF_OPEN_PENALTY: f64 = 0.5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceState {
    /// 正常参与调度
    Active,
    /// 熔断到期后的试探态（成功恢复 Active / 失败重开 CircuitOpen）
    HalfOpen,
    /// 熔断中，不参与选源
    CircuitOpen,
}

#[derive(Debug, Clone)]
pub struct SourceHealth {
    /// 源索引（0 = 主源，1.. = 镜像）
    pub idx: usize,
    /// playlist/master URL
    pub url: String,
    pub score: f64,
    /// 吞吐 EWMA（B/s）
    pub throughput_ewma: f64,
    /// 时延 EWMA（秒）
    pub latency_ewma: f64,
    /// 成功率 EWMA（0..1）
    pub success_ewma: f64,
    /// 错误率 EWMA（0..1）
    pub error_ewma: f64,
    pub state: SourceState,
    /// 熔断到期时刻（state == CircuitOpen 时有效）
    pub circuit_until: Option<Instant>,
    /// 连续失败片数（熔断计数器）
    pub consec_fail: u32,
    /// 请求分片总次数
    pub requests: u64,
    /// 失败总次数
    pub failures: u64,
}

impl SourceHealth {
    pub fn new(idx: usize, url: impl Into<String>) -> Self {
        let mut h = Self {
            idx,
            url: url.into(),
            score: 0.0,
            throughput_ewma: 0.0,
            latency_ewma: 0.5,
            success_ewma: 0.5,
            error_ewma: 0.0,
            state: SourceState::Active,
            circuit_until: None,
            consec_fail: 0,
            requests: 0,
            failures: 0,
        };
        h.rescore();
        h
    }

    /// 是否可被选中；熔断到期自动按半开参与试探
    pub fn available(&self, now: Instant) -> bool {
        match self.state {
            SourceState::Active | SourceState::HalfOpen => true,
            SourceState::CircuitOpen => self.circuit_until.map_or(true, |t| now >= t),
        }
    }

    /// 当前调度分：熔断到期（半开身份）降分，避免试探风暴
    pub fn effective_score(&self, now: Instant) -> f64 {
        if self.state == SourceState::CircuitOpen && self.available(now) {
            self.score - HALF_OPEN_PENALTY
        } else {
            self.score
        }
    }

    pub fn record_success(&mut self, latency: f64, bytes: u64, now: Instant) {
        let lat = latency.max(0.001);
        let tp = bytes as f64 / lat;
        let a = EWMA_ALPHA;
        if self.requests == 0 {
            self.throughput_ewma = tp;
            self.latency_ewma = lat;
        } else {
            self.throughput_ewma = a * tp + (1.0 - a) * self.throughput_ewma;
            self.latency_ewma = a * lat + (1.0 - a) * self.latency_ewma;
        }
        self.success_ewma = a + (1.0 - a) * self.success_ewma;
        self.error_ewma *= 1.0 - a;
        self.consec_fail = 0;
        // 半开试探成功（显式 HalfOpen 或熔断到期后的隐式试探）→ 恢复
        if self.state == SourceState::HalfOpen
            || (self.state == SourceState::CircuitOpen && self.available(now))
        {
            self.state = SourceState::Active;
            self.circuit_until = None;
        }
        self.requests += 1;
        self.rescore();
    }

    pub fn record_fail(&mut self, now: Instant) {
        let a = EWMA_ALPHA;
        self.success_ewma *= 1.0 - a;
        self.error_ewma = a + (1.0 - a) * self.error_ewma;
        self.consec_fail += 1;
        self.requests += 1;
        self.failures += 1;
        // 熔断到期后的试探失败 → 立即重开；正常累计达到阈值 → 熔断
        let half_open_probe = self.state == SourceState::CircuitOpen && self.available(now);
        if half_open_probe || self.consec_fail >= CIRCUIT_THRESHOLD {
            self.state = SourceState::CircuitOpen;
            self.circuit_until = Some(now + CIRCUIT_DURATION);
            self.consec_fail = 0;
        }
        self.rescore();
    }

    pub fn rescore(&mut self) {
        let tp = (self.throughput_ewma / TP_NORM_BPS).min(1.0);
        let lat = 1.0 / (1.0 + self.latency_ewma);
        self.score = W_TP * tp + W_LAT * lat + W_SR * self.success_ewma - W_ERR * self.error_ewma;
    }

    /// 展示状态字符串（熔断到期但未成功试探 → half_open）
    pub fn state_label(&self, now: Instant) -> &'static str {
        match self.state {
            SourceState::Active => "active",
            SourceState::HalfOpen => "half_open",
            SourceState::CircuitOpen if self.available(now) => "half_open",
            SourceState::CircuitOpen => "circuit_open",
        }
    }

    /// 调试面板快照
    pub fn stat(&self, now: Instant) -> SourceStat {
        SourceStat {
            idx: self.idx,
            url: self.url.clone(),
            score: self.score,
            state: self.state_label(now),
            throughputEwma: self.throughput_ewma,
            latencyEwma: self.latency_ewma,
            successRate: self.success_ewma,
            requests: self.requests,
            failures: self.failures,
            circuitRemainingSecs: if self.state == SourceState::CircuitOpen && !self.available(now) {
                self.circuit_until
                    .map(|t| t.saturating_duration_since(now).as_secs())
            } else {
                None
            },
        }
    }
}

/// 调试面板源状态快照（与 packages/shared 的 SourceStat 同构）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStat {
    pub idx: usize,
    pub url: String,
    pub score: f64,
    pub state: &'static str,
    pub throughputEwma: f64,
    pub latencyEwma: f64,
    pub successRate: f64,
    pub requests: u64,
    pub failures: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub circuitRemainingSecs: Option<u64>,
}

/// 选源（两种模式）：
/// · `spread=false`（HLS）：可用源里取有效分最高者，同分（< 1e-6）按 seq 轮转。
/// · `spread=true`（P2SP，MP4 多镜像）：**纯 seq 轮转**——镜像字节一致性已预检
///   （首块 hash），带宽聚合靠分摊而非比分；score 分化不破坏轮转，故障仍由
///   available（熔断）+ exclude（同源连败退避）兜底。
pub fn pick_source(
    healths: &[SourceHealth],
    exclude: &[usize],
    now: Instant,
    seq: u64,
    spread: bool,
) -> Option<usize> {
    if spread {
        let cands: Vec<usize> = healths
            .iter()
            .filter(|h| !exclude.contains(&h.idx) && h.available(now))
            .map(|h| h.idx)
            .collect();
        return if cands.is_empty() {
            None
        } else {
            Some(cands[(seq % cands.len() as u64) as usize])
        };
    }
    let mut best: Option<f64> = None;
    let mut cands: Vec<usize> = Vec::new();
    for h in healths {
        if exclude.contains(&h.idx) || !h.available(now) {
            continue;
        }
        let s = h.effective_score(now);
        match best {
            None => {
                best = Some(s);
                cands.push(h.idx);
            }
            Some(bs) if (s - bs).abs() < 1e-6 => cands.push(h.idx),
            Some(bs) if s > bs => {
                best = Some(s);
                cands.clear();
                cands.push(h.idx);
            }
            _ => {}
        }
    }
    if cands.is_empty() {
        return None;
    }
    Some(cands[(seq % cands.len() as u64) as usize])
}

/// 播放头水位优先级（值越小越先下载，DESIGN §4.2 buffer_target）：
///   无锚点 → 顺序下载；锚点前向 0..7 片最高优；后向 ±60s 回看补齐；
///   前向 8..14 片中优；远前向顺序低优；更早历史最后补。
pub fn priority(seq: u64, anchor: Option<u64>) -> (u8, i64) {
    match anchor {
        None => (2, seq as i64),
        Some(a) => {
            let d = seq as i64 - a as i64;
            if d >= 0 && d <= 7 {
                (0, d) // 播放头前向 ~60s：马上要播
            } else if d < 0 && d >= -7 {
                (1, d) // 后向 ~60s：回看缓存补齐
            } else if d > 7 && d <= 14 {
                (2, d) // 前向缓冲窗口
            } else if d > 14 {
                (3, d) // 远前向：低优顺序
            } else {
                (4, d) // 更早历史：最后补齐
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(offset_secs: u64) -> Instant {
        Instant::now() + Duration::from_secs(offset_secs)
    }

    #[test]
    fn initial_scores_equal_and_positive() {
        let a = SourceHealth::new(0, "https://a/1.m3u8");
        let b = SourceHealth::new(1, "https://b/1.m3u8");
        assert_eq!(a.score, b.score);
        assert!(a.score > 0.0);
        // 同分轮转（P2SP 分摊）：seq 0 → 主源，seq 1 → 镜像
        assert_eq!(pick_source(&[a, b], &[], Instant::now(), 0, false), Some(0));
    }

    #[test]
    fn round_robin_on_equal_scores() {
        let a = SourceHealth::new(0, "a");
        let b = SourceHealth::new(1, "b");
        let now = Instant::now();
        // HLS：同分多源按 seq 轮转分摊
        assert_eq!(pick_source(&[a.clone(), b.clone()], &[], now, 0, false), Some(0));
        assert_eq!(pick_source(&[a.clone(), b.clone()], &[], now, 1, false), Some(1));
        assert_eq!(pick_source(&[a.clone(), b.clone()], &[], now, 2, false), Some(0));
        assert_eq!(pick_source(&[a.clone(), b.clone()], &[], now, 3, false), Some(1));
        // 镜像被 exclude 后恒走主源
        assert_eq!(pick_source(&[a.clone(), b.clone()], &[1], now, 1, false), Some(0));
        // P4 P2SP spread 模式：纯 seq 轮转（不看 score）
        assert_eq!(pick_source(&[a.clone(), b.clone()], &[], now, 0, true), Some(0));
        assert_eq!(pick_source(&[a.clone(), b.clone()], &[], now, 1, true), Some(1));
        assert_eq!(pick_source(&[a.clone(), b.clone()], &[], now, 5, true), Some(1));
        assert_eq!(pick_source(&[a.clone(), b.clone()], &[1], now, 1, true), Some(0));
        // spread 不受 score 分化影响
        let mut hot = SourceHealth::new(0, "hot");
        hot.record_success(0.1, 9_000_000, now);
        assert_eq!(pick_source(&[hot, b.clone()], &[], now, 1, true), Some(1));
        // 熔断源不参与轮转
        let mut dead = SourceHealth::new(1, "dead");
        for _ in 0..CIRCUIT_THRESHOLD {
            dead.record_fail(now);
        }
        assert_eq!(pick_source(&[a.clone(), dead], &[], now, 1, true), Some(0));
    }

    #[test]
    fn failures_lower_score_and_switch_source() {
        let now = Instant::now();
        let mut a = SourceHealth::new(0, "a");
        let mut b = SourceHealth::new(1, "b");
        for _ in 0..2 {
            a.record_fail(now);
        }
        b.record_success(0.2, 1_000_000, now);
        assert!(b.score > a.score);
        assert_eq!(pick_source(&[a, b], &[], now, 7, false), Some(1));
    }

    #[test]
    fn circuit_opens_after_threshold_and_expires() {
        let mut h = SourceHealth::new(0, "a");
        let now = Instant::now();
        for _ in 0..CIRCUIT_THRESHOLD {
            h.record_fail(now);
        }
        assert_eq!(h.state, SourceState::CircuitOpen);
        assert!(!h.available(now));
        assert_eq!(pick_source(&[h.clone()], &[], now, 0, false), None);
        // 到期后半开可试探（带惩罚）
        let later = now + CIRCUIT_DURATION + Duration::from_secs(1);
        assert!(h.available(later));
        assert_eq!(h.state_label(later), "half_open");
        assert!(h.effective_score(later) < h.score);
        // 试探成功 → 恢复 active
        h.record_success(0.1, 500_000, later);
        assert_eq!(h.state, SourceState::Active);
        assert_eq!(h.state_label(later), "active");
    }

    #[test]
    fn half_open_fail_reopens_circuit() {
        let mut h = SourceHealth::new(0, "a");
        let now = Instant::now();
        for _ in 0..CIRCUIT_THRESHOLD {
            h.record_fail(now);
        }
        let later = now + CIRCUIT_DURATION + Duration::from_secs(1);
        h.record_fail(later); // 半开试探失败
        assert_eq!(h.state, SourceState::CircuitOpen);
        assert!(!h.available(later));
    }

    #[test]
    fn success_ewma_moves_toward_one() {
        let mut h = SourceHealth::new(0, "a");
        let now = Instant::now();
        h.record_success(0.1, 1_000_000, now);
        assert!(h.success_ewma > 0.5);
        assert!(h.throughput_ewma > 5_000_000.0);
    }

    #[test]
    fn pick_respects_exclude() {
        let a = SourceHealth::new(0, "a");
        let b = SourceHealth::new(1, "b");
        let now = Instant::now();
        assert_eq!(pick_source(&[a.clone(), b.clone()], &[], now, 0, false), Some(0));
        assert_eq!(pick_source(&[a, b], &[0], now, 0, false), Some(1));
    }

    #[test]
    fn priority_windows() {
        let a = Some(10);
        // 前向最高优，按距离递增
        assert_eq!(priority(10, a), (0, 0));
        assert_eq!(priority(11, a), (0, 1));
        assert_eq!(priority(17, a), (0, 7));
        // 后向回看次优
        assert_eq!(priority(9, a), (1, -1));
        assert_eq!(priority(3, a), (1, -7));
        // 前向窗口
        assert_eq!(priority(18, a), (2, 8));
        assert_eq!(priority(24, a), (2, 14));
        // 远前向 / 历史
        assert_eq!(priority(100, a), (3, 90));
        assert_eq!(priority(0, a), (4, -10));
        // 无锚点顺序
        assert_eq!(priority(5, None), (2, 5));
        // 水位调度整体次序：前向 < 回看 < 窗口 < 远前向 < 历史
        let mut v = vec![priority(0, a), priority(100, a), priority(11, a), priority(20, a), priority(9, a)];
        v.sort();
        assert_eq!(v[0], (0, 1));
        assert_eq!(v[1], (1, -1));
        assert_eq!(v[2], (2, 10));
        assert_eq!(v[3], (3, 90));
        assert_eq!(v[4], (4, -10));
    }
}
