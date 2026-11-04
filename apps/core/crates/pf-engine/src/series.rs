//! P3 series 剧集预缓存队列调度（DESIGN §4.6 规则 1-3）
//!
//! 纯同步决策逻辑（now/IO 注入由调用方完成，可单测）：
//!  - 规则 1：优先级恒低于当前播放集 —— 由「当前集 ≥95% 才激活下一集」+ 引擎
//!    priority() 分级（当前集窗口 0/1/2 恒高于历史 4）天然保证；
//!  - 规则 2：按集顺序推进，live 直播不参与；
//!  - 规则 3：每集继承 cache_mode（挂接时已落库），online 集不自动激活（无缓存语义）。

/// 某剧集任务的调度快照（调用方从 DB/内存聚合）
#[derive(Debug, Clone)]
pub struct EpisodeSnap {
    pub task_id: String,
    pub episode_index: i64,
    /// live 直播不参与预缓存
    pub live: bool,
    /// online 模式无缓存语义，不自动激活
    pub online: bool,
    /// 已完结：状态 ready 或缓存完整度 ≥95%
    pub done: bool,
}

/// P46 预缓存策略（settings 表持久化，缺省 = 后续 3 集）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrefetchMode {
    /// 关：只有播到 ≥95% 才顺延激活下一集（P3 旧行为）
    Off,
    /// 后续 N 集（N 由 count 决定，默认 3）
    Ahead,
    /// 剩余全部
    All,
}

impl PrefetchMode {
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "off" => Some(Self::Off),
            "ahead" => Some(Self::Ahead),
            "all" => Some(Self::All),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Ahead => "ahead",
            Self::All => "all",
        }
    }
}

/// 默认预缓存档：后续 3 集（用户可改 off / all / 自定义 1..=50）
pub const PREFETCH_COUNT_DEFAULT: u32 = 3;
/// 自定义上限：再多也没有带宽意义，且会让窗口计算失控
pub const PREFETCH_COUNT_MAX: u32 = 50;

/// P46 预缓存窗口：当前集之后要覆盖的集序（升序，含空洞）。
///
/// - `Off` → 空（不预取，仍由 pick_next_episode 负责「播完顺延」）
/// - `Ahead` → 后续 `count` 集
/// - `All` → 剩余全部
///
/// **数量不足即截断**：可选集比策略少时返回实际可用的那些，不报错、不等待；
/// `available` 允许有空洞（前端只传了部分集、或某集解析失败被剔），
/// 这里只按集序挑选，不假设连续。
pub fn pick_window(mode: PrefetchMode, count: u32, current: i64, available: &[i64]) -> Vec<i64> {
    if mode == PrefetchMode::Off {
        return Vec::new();
    }
    let mut rest: Vec<i64> = available.iter().copied().filter(|i| *i > current).collect();
    rest.sort_unstable();
    rest.dedup();
    match mode {
        PrefetchMode::Off => Vec::new(),
        PrefetchMode::All => rest,
        PrefetchMode::Ahead => {
            let n = count.max(1) as usize;
            rest.truncate(n);
            rest
        }
    }
}

/// 队列决策：当前播放集完结（≥95%）→ 返回下一集 task_id（未完结、非 live、非 online）
pub fn pick_next_episode(eps: &[EpisodeSnap], current: &str) -> Option<String> {
    let cur = eps.iter().find(|e| e.task_id == current)?;
    if cur.live || !cur.done {
        return None;
    }
    let next_idx = cur.episode_index + 1;
    eps.iter()
        .find(|e| e.episode_index == next_idx && !e.live && !e.online && !e.done)
        .map(|e| e.task_id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ep(id: &str, idx: i64, live: bool, online: bool, done: bool) -> EpisodeSnap {
        EpisodeSnap {
            task_id: id.to_string(),
            episode_index: idx,
            live,
            online,
            done,
        }
    }

    #[test]
    fn 当前集未达95不推进() {
        let eps = vec![ep("e0", 0, false, false, false), ep("e1", 1, false, false, false)];
        assert_eq!(pick_next_episode(&eps, "e0"), None);
    }

    #[test]
    fn 当前集完结激活下一集() {
        let eps = vec![ep("e0", 0, false, false, true), ep("e1", 1, false, false, false)];
        assert_eq!(pick_next_episode(&eps, "e0"), Some("e1".into()));
    }

    #[test]
    fn live与online与已完结集跳过() {
        let eps = vec![
            ep("e0", 0, false, false, true),
            ep("e1", 1, true, false, false),   // live 跳过
            ep("e2", 1, false, true, false),   // online 跳过
            ep("e3", 1, false, false, true),   // 已完结跳过
        ];
        assert_eq!(pick_next_episode(&eps, "e0"), None);
        // 下一集可用时正常激活
        let eps2 = vec![
            ep("e0", 0, false, false, true),
            ep("e2", 1, false, true, false),
            ep("e4", 1, false, false, false),
        ];
        assert_eq!(pick_next_episode(&eps2, "e0"), Some("e4".into()));
    }

    #[test]
    fn 无当前集或当前集为live不推进() {
        let eps = vec![ep("e0", 0, false, false, true), ep("e1", 1, false, false, false)];
        assert_eq!(pick_next_episode(&eps, "missing"), None);
        let eps2 = vec![ep("e0", 0, true, false, true), ep("e1", 1, false, false, false)];
        assert_eq!(pick_next_episode(&eps2, "e0"), None);
    }

    // ---------- P46 预缓存窗口 ----------

    const ALL10: [i64; 10] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

    #[test]
    fn 后续N集_默认三集() {
        assert_eq!(
            pick_window(PrefetchMode::Ahead, PREFETCH_COUNT_DEFAULT, 2, &ALL10),
            vec![3, 4, 5]
        );
    }

    #[test]
    fn 后续N集_自定义一集与五集() {
        assert_eq!(pick_window(PrefetchMode::Ahead, 1, 0, &ALL10), vec![1]);
        assert_eq!(pick_window(PrefetchMode::Ahead, 5, 0, &ALL10), vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn 全部剩余() {
        assert_eq!(pick_window(PrefetchMode::All, 3, 7, &ALL10), vec![8, 9]);
        assert_eq!(pick_window(PrefetchMode::All, 3, 9, &ALL10), Vec::<i64>::new());
    }

    #[test]
    fn 关闭时不预取() {
        assert_eq!(pick_window(PrefetchMode::Off, 3, 0, &ALL10), Vec::<i64>::new());
    }

    #[test]
    fn 数量不足即截断不报错() {
        assert_eq!(pick_window(PrefetchMode::Ahead, 5, 7, &ALL10), vec![8, 9]);
        assert_eq!(pick_window(PrefetchMode::Ahead, 3, 8, &ALL10), vec![9]);
    }

    #[test]
    fn 集序有空洞也能挑() {
        let avail = [0, 1, 3, 5];
        assert_eq!(pick_window(PrefetchMode::Ahead, 3, 1, &avail), vec![3, 5]);
    }

    #[test]
    fn 窗口随当前集前移() {
        assert_eq!(pick_window(PrefetchMode::Ahead, 2, 0, &ALL10), vec![1, 2]);
        assert_eq!(pick_window(PrefetchMode::Ahead, 2, 1, &ALL10), vec![2, 3]);
        assert!(pick_window(PrefetchMode::All, 3, 0, &ALL10).iter().all(|i| *i > 0));
    }
}
