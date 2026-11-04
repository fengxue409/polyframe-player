//! 播放链接有效期管理：判定新鲜度 + 进程内缓存（纯逻辑，可单测）
//!
//! 语义（P9b 关键机制）：
//!  - 网盘直链普遍短命（阿里云盘 15 分钟、OneDrive 约 1 小时、百度未声明但会 403），
//!    因此**播放器永远不直接持有网盘直链**，只拿稳定 shim URL；直链由本模块缓存，
//!    到期前主动换新，403 时强制换新。
//!  - 提前 `LINK_SKEW_MS` 判定过期，避免「刚好在播放中途失效」。

use std::collections::HashMap;
use std::sync::Mutex;

use crate::PlayTarget;

/// 提前换链的安全余量（网盘直链失效通常无宽限）
pub const LINK_SKEW_MS: i64 = 60_000;

/// 直链是否仍然可用（`None` 视为无明确期限，交给 403 兜底）
pub fn link_fresh(expires_at: Option<i64>, now_ms: i64) -> bool {
    match expires_at {
        None => true,
        Some(e) => e - LINK_SKEW_MS > now_ms,
    }
}

/// 登录态是否仍然可用（同样提前 60s）
pub fn token_fresh(expires_at: Option<i64>, now_ms: i64) -> bool {
    link_fresh(expires_at, now_ms)
}

/// (owner, file) → 缓存键；owner = `a-<accountId>` / `s-<shareId>`
pub fn cache_key(owner: &str, file_id: &str) -> String {
    format!("{owner}|{file_id}")
}

/// 直链缓存（跨 core / proxy 共用同一实例，放在 TaskManager 内）
#[derive(Default)]
pub struct LinkCache {
    inner: Mutex<HashMap<String, PlayTarget>>,
}

impl LinkCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// 取未过期的直链副本
    pub fn get(&self, key: &str, now_ms: i64) -> Option<PlayTarget> {
        let guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        guard.get(key).filter(|t| link_fresh(t.expires_at, now_ms)).cloned()
    }

    pub fn put(&self, key: String, target: PlayTarget) {
        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        // 简单容量保护：超 512 条清空（网盘播放热点极集中，无需 LRU）
        if guard.len() > 512 {
            guard.clear();
        }
        guard.insert(key, target);
    }

    pub fn invalidate(&self, key: &str) {
        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        guard.remove(key);
    }

    /// 按前缀批量失效（删账号 / 删分享时清理其名下所有直链）
    pub fn invalidate_prefix(&self, prefix: &str) {
        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        guard.retain(|k, _| !k.starts_with(prefix));
    }

    pub fn len(&self) -> usize {
        let guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        guard.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn freshness_uses_skew() {
        let now = 1_000_000i64;
        // 无期限 → 恒新鲜（403 兜底）
        assert!(link_fresh(None, now));
        // 距过期 61s → 新鲜
        assert!(link_fresh(Some(now + 61_000), now));
        // 距过期 60s → 已按过期处理（留出换链窗口）
        assert!(!link_fresh(Some(now + 60_000), now));
        // 已过期
        assert!(!link_fresh(Some(now - 1), now));
        // 登录态同规则
        assert!(token_fresh(Some(now + 3_600_000), now));
        assert!(!token_fresh(Some(now + 1_000), now));
    }

    #[test]
    fn cache_returns_only_fresh_targets() {
        let cache = LinkCache::new();
        let key = cache_key("a-acc1", "f1");
        cache.put(key.clone(), PlayTarget {
            url: "https://cdn.example.com/a.mp4".into(),
            headers: vec![("Referer".into(), "https://pan.example.com/".into())],
            expires_at: Some(200_000),
            ext: Some("mp4".into()),
        });
        // 未到期（含 skew 余量）
        let hit = cache.get(&key, 100_000).expect("应命中");
        assert_eq!(hit.url, "https://cdn.example.com/a.mp4");
        // 到期前 60s 内不再命中
        assert!(cache.get(&key, 150_000).is_none());
        // 失效后可强制清除
        cache.invalidate(&key);
        assert!(cache.is_empty());
    }

    #[test]
    fn indefinitely_valid_link_stays_cached() {
        let cache = LinkCache::new();
        let key = cache_key("s-share1", "f9");
        cache.put(key.clone(), PlayTarget {
            url: "https://cdn.example.com/b.mkv".into(),
            headers: vec![],
            expires_at: None,
            ext: Some("mkv".into()),
        });
        assert!(cache.get(&key, i64::MAX / 4).is_some());
    }
}
