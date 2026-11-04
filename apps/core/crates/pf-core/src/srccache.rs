//! P19 片源内容缓存（内核侧编排）
//!
//! `pf-engine::src_cache` 提供落盘与统计，本模块给它一层「读法约定」：
//! **fresh 命中直返 → 未命中回源 → 回源失败回退旧值（SWR）**。
//!
//! 之所以统一放在这里而不是各 RPC 里各写一遍：片源类请求的错误语义必须一致 ——
//! 「源站挂了」不等于「没有数据」，能用旧值就必须给旧值，并把 `stale` 标记带出去
//! 让界面说明白（否则用户会以为看到了最新结果）。

pub use pf_engine::{now_ms_i64, KIND_CATEGORY, KIND_DETAIL, KIND_SEARCH, KIND_TMDB};
use pf_engine::{CacheStore, SrcCachePolicy};

use serde::Serialize;
use serde_json::json;

/// 单次读取的缓存标记（随业务出参回给前端）
#[derive(Debug, Clone, Copy, Default)]
pub struct Mark {
    /// 是否来自缓存（未打网络）
    pub cached: bool,
    /// 是否过期旧值（回源失败时的降级）
    pub stale: bool,
    /// 写入时刻（毫秒；0 = 非缓存）
    pub stored_at_ms: i64,
}

impl Mark {
    pub fn fresh(stored_at_ms: i64) -> Self {
        Self { cached: true, stale: false, stored_at_ms }
    }
    pub fn stale(stored_at_ms: i64) -> Self {
        Self { cached: true, stale: true, stored_at_ms }
    }
}

/// 一次聚合扇出的缓存摘要（`catalog.search` / `catalog.category` 出参的 `cache` 字段）
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheSummary {
    /// 命中新鲜缓存的源站数
    pub from_cache: u32,
    /// 用过期旧值顶上的源站数
    pub stale: u32,
    /// 参与本次聚合的源站数
    pub total: u32,
    /// 最旧的那份缓存写入时刻（毫秒）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oldest_ms: Option<i64>,
}

impl CacheSummary {
    pub fn record(&mut self, m: Mark) {
        self.total += 1;
        if !m.cached {
            return;
        }
        if m.stale {
            self.stale += 1;
        } else {
            self.from_cache += 1;
        }
        if m.stored_at_ms > 0 {
            self.oldest_ms = Some(self.oldest_ms.map_or(m.stored_at_ms, |o| o.min(m.stored_at_ms)));
        }
    }

    /// 全量失败数（供前端判断「是不是全挂了」）
    pub fn to_json(&self, failed: usize) -> serde_json::Value {
        json!({
            "fromCache": self.from_cache,
            "stale": self.stale,
            "total": self.total,
            "failed": failed,
            "oldestMs": self.oldest_ms,
        })
    }
}

/// 只取新鲜命中；过期行不算命中（留给回退路径）
pub fn peek_fresh(store: &CacheStore, kind: &str, key: &str) -> Option<(String, Mark)> {
    let hit = store.src_cache_lookup(kind, key, now_ms_i64())?;
    if !hit.fresh {
        return None;
    }
    Some((hit.text(), Mark::fresh(hit.stored_at)))
}

/// 取过期旧值（记一次 stale_served，统计里能看出「降级了多少次」）
pub fn peek_stale(store: &CacheStore, kind: &str, key: &str) -> Option<(String, Mark)> {
    let hit = store.src_cache_lookup(kind, key, now_ms_i64())?;
    if hit.fresh {
        return None;
    }
    store.src_cache_note_stale(kind);
    Some((hit.text(), Mark::stale(hit.stored_at)))
}

/// 写入缓存并按容量做一次维护（内部节流 15s，不必自己控频）
pub fn remember(store: &CacheStore, policy: &SrcCachePolicy, kind: &str, key: &str, body: &str) {
    let now = now_ms_i64();
    store.src_cache_put(kind, key, body.as_bytes(), policy.ttl_ms(kind), now);
    store.src_cache_maintain(policy);
}

/// 通用「缓存优先 + 失败回退」取文本：`fut` 由调用方提供（各自的 client / 超时 / 头）。
///
/// 三种结局：
/// - 新鲜命中 → 不 poll `fut`，直接返回（注意：`fut` 必须已构造但不会被 await）
/// - 未命中 → await `fut`，成功即落盘
/// - 失败 → `offline_fallback` 开启且有过期旧值时返回旧值（`stale=true`）
pub async fn fetch_text_cached<F>(
    store: &CacheStore,
    policy: &SrcCachePolicy,
    kind: &str,
    key: &str,
    fut: F,
) -> Result<(String, Mark), String>
where
    F: std::future::Future<Output = Result<String, String>>,
{
    if let Some(hit) = peek_fresh(store, kind, key) {
        return Ok(hit);
    }
    match fut.await {
        Ok(body) => {
            remember(store, policy, kind, key, &body);
            Ok((body, Mark::default()))
        }
        Err(e) => {
            if policy.offline_fallback {
                if let Some(stale) = peek_stale(store, kind, key) {
                    return Ok(stale);
                }
            }
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_counts_cache_and_stale() {
        let mut s = CacheSummary::default();
        s.record(Mark::fresh(1000));
        s.record(Mark::stale(500));
        s.record(Mark::default());
        assert_eq!(s.total, 3);
        assert_eq!(s.from_cache, 1);
        assert_eq!(s.stale, 1);
        assert_eq!(s.oldest_ms, Some(500));
        let j = s.to_json(2);
        assert_eq!(j["fromCache"], 1);
        assert_eq!(j["failed"], 2);
    }

    #[test]
    fn empty_summary_has_no_oldest() {
        let s = CacheSummary::default();
        assert!(s.to_json(0)["oldestMs"].is_null());
        assert_eq!(s.to_json(0)["total"], 0);
    }
}
