//! P19 片源内容缓存（src_cache）：把「已经获取过」的片源数据落盘复用
//!
//! P2.5 的分片缓存解决的是**播放载荷**（.bin 分片），本模块解决的是**片源元数据**：
//! 采集站搜索/分类/详情 JSON、TMDB 评分人气、海报图片、P10 解析出的可播直链。
//! 这些数据此前每次都要重新扇出到全部源站，源站一挂历史结果就一起没了。
//!
//! 设计要点：
//! - **单表多 kind**：`kind` 是命名空间（search/category/detail/tmdb/poster/parselink），
//!   便于按类统计与按类清理；`(kind,key)` 主键天然幂等覆盖。
//! - **TTL 只判新鲜度，不删数据**：过期行仍是「旧值」，网络失败时可回退（SWR），
//!   这是离线可用性的根；真正的删除交给 prune（过期且超出保留窗口）/ LRU。
//! - **容量 LRU**：按 `COALESCE(last_hit_at, stored_at)` 升序淘汰，命中即续命。
//! - **命中/未命中计数落 `src_cache_stat`**：行不存在时无法在行上计数，
//!   所以按 kind 单独记，命中率才算得出来。

use std::sync::atomic::{AtomicI64, Ordering};

use rusqlite::OptionalExtension;
use serde::Serialize;

use crate::CacheStore;

/// 表结构（随 CacheStore::open 建，全新表无迁移）
pub const SRC_CACHE_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS src_cache(
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  body BLOB NOT NULL,
  bytes INTEGER NOT NULL,
  stored_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  last_hit_at INTEGER,
  PRIMARY KEY(kind, key)
);
CREATE INDEX IF NOT EXISTS idx_src_cache_exp ON src_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_src_cache_kind ON src_cache(kind);
CREATE INDEX IF NOT EXISTS idx_src_cache_lru ON src_cache(last_hit_at, stored_at);
CREATE TABLE IF NOT EXISTS src_cache_stat(
  kind TEXT PRIMARY KEY,
  hits INTEGER NOT NULL DEFAULT 0,
  misses INTEGER NOT NULL DEFAULT 0,
  stale_served INTEGER NOT NULL DEFAULT 0
);
";

// ---------- 缓存类别（字符串即落库值，改动需同步前端与文档） ----------

/// 采集站聚合搜索（key = api|query）
pub const KIND_SEARCH: &str = "search";
/// 采集站分类/更新流（key = api|pg|hours）
pub const KIND_CATEGORY: &str = "category";
/// 采集站详情（key = api|vodId）
pub const KIND_DETAIL: &str = "detail";
/// TMDB search/multi 命中对象（key = name|year）
pub const KIND_TMDB: &str = "tmdb";
/// 海报图片二进制（key = 图片 URL）
pub const KIND_POSTER: &str = "poster";
/// P10 解析出的可播直链（key = pageUrl|serviceApi）
pub const KIND_PARSE_LINK: &str = "parselink";

/// 单条缓存的体积上限：超过就不入库（防异常响应把库撑爆）
pub const MAX_ENTRY_BYTES: usize = 4 * 1024 * 1024;

// ---------- 策略（settings 持久化，与前端 SrcCachePolicy 同构） ----------

/// 缓存策略：各类 TTL + 总容量 + 是否允许旧值回退
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SrcCachePolicy {
    /// 搜索结果 TTL（分钟）
    pub ttl_search_min: i64,
    /// 分类/更新流 TTL（分钟）
    pub ttl_category_min: i64,
    /// 详情 TTL（分钟）
    pub ttl_detail_min: i64,
    /// TMDB TTL（小时）
    pub ttl_tmdb_hours: i64,
    /// 海报 TTL（天）
    pub ttl_poster_days: i64,
    /// 解析直链 TTL（分钟）
    pub ttl_parse_min: i64,
    /// 总容量上限（MB）
    pub capacity_mb: i64,
    /// 回源失败时是否回退旧值（离线可用）
    pub offline_fallback: bool,
}

impl Default for SrcCachePolicy {
    fn default() -> Self {
        Self {
            ttl_search_min: 10,
            ttl_category_min: 5,
            ttl_detail_min: 30,
            ttl_tmdb_hours: 24,
            ttl_poster_days: 7,
            ttl_parse_min: 10,
            capacity_mb: 64,
            offline_fallback: true,
        }
    }
}

/// settings 键（一处定义，避免读写键名漂移）
const K_TTL_SEARCH: &str = "srccache.ttl_search_min";
const K_TTL_CATEGORY: &str = "srccache.ttl_category_min";
const K_TTL_DETAIL: &str = "srccache.ttl_detail_min";
const K_TTL_TMDB: &str = "srccache.ttl_tmdb_hours";
const K_TTL_POSTER: &str = "srccache.ttl_poster_days";
const K_TTL_PARSE: &str = "srccache.ttl_parse_min";
const K_CAPACITY: &str = "srccache.capacity_mb";
const K_FALLBACK: &str = "srccache.offline_fallback";

impl SrcCachePolicy {
    /// 从 settings 读（缺失用默认值）；数值一律夹到合理区间，防手改库搞崩调度
    pub fn load(store: &CacheStore) -> Self {
        let d = Self::default();
        let num = |k: &str, def: i64, lo: i64, hi: i64| -> i64 {
            store
                .setting_get(k)
                .and_then(|v| v.trim().parse::<i64>().ok())
                .map(|v| v.clamp(lo, hi))
                .unwrap_or(def)
        };
        Self {
            ttl_search_min: num(K_TTL_SEARCH, d.ttl_search_min, 2, 1440),
            ttl_category_min: num(K_TTL_CATEGORY, d.ttl_category_min, 1, 1440),
            ttl_detail_min: num(K_TTL_DETAIL, d.ttl_detail_min, 2, 10_080),
            ttl_tmdb_hours: num(K_TTL_TMDB, d.ttl_tmdb_hours, 1, 720),
            ttl_poster_days: num(K_TTL_POSTER, d.ttl_poster_days, 1, 3650),
            ttl_parse_min: num(K_TTL_PARSE, d.ttl_parse_min, 1, 1440),
            capacity_mb: num(K_CAPACITY, d.capacity_mb, 8, 4096),
            offline_fallback: store
                .setting_get(K_FALLBACK)
                .map(|v| v != "0")
                .unwrap_or(d.offline_fallback),
        }
    }

    /// 写入 settings；入参逐项夹取（None = 不改）
    pub fn save(
        store: &CacheStore,
        ttl_search_min: Option<i64>,
        ttl_category_min: Option<i64>,
        ttl_detail_min: Option<i64>,
        ttl_tmdb_hours: Option<i64>,
        ttl_poster_days: Option<i64>,
        ttl_parse_min: Option<i64>,
        capacity_mb: Option<i64>,
        offline_fallback: Option<bool>,
    ) -> Result<Self, String> {
        let cur = Self::load(store);
        let pick = |v: Option<i64>, def: i64, lo: i64, hi: i64| v.map(|x| x.clamp(lo, hi)).unwrap_or(def);
        let next = Self {
            ttl_search_min: pick(ttl_search_min, cur.ttl_search_min, 2, 1440),
            ttl_category_min: pick(ttl_category_min, cur.ttl_category_min, 1, 1440),
            ttl_detail_min: pick(ttl_detail_min, cur.ttl_detail_min, 2, 10_080),
            ttl_tmdb_hours: pick(ttl_tmdb_hours, cur.ttl_tmdb_hours, 1, 720),
            ttl_poster_days: pick(ttl_poster_days, cur.ttl_poster_days, 1, 3650),
            ttl_parse_min: pick(ttl_parse_min, cur.ttl_parse_min, 1, 1440),
            capacity_mb: pick(capacity_mb, cur.capacity_mb, 8, 4096),
            offline_fallback: offline_fallback.unwrap_or(cur.offline_fallback),
        };
        store.setting_set(K_TTL_SEARCH, &next.ttl_search_min.to_string())?;
        store.setting_set(K_TTL_CATEGORY, &next.ttl_category_min.to_string())?;
        store.setting_set(K_TTL_DETAIL, &next.ttl_detail_min.to_string())?;
        store.setting_set(K_TTL_TMDB, &next.ttl_tmdb_hours.to_string())?;
        store.setting_set(K_TTL_POSTER, &next.ttl_poster_days.to_string())?;
        store.setting_set(K_TTL_PARSE, &next.ttl_parse_min.to_string())?;
        store.setting_set(K_CAPACITY, &next.capacity_mb.to_string())?;
        store.setting_set(K_FALLBACK, if next.offline_fallback { "1" } else { "0" })?;
        Ok(next)
    }

    /// 各类 TTL 折算为毫秒
    ///
    /// 测试钩子：`PF_SRC_CACHE_TTL_MS` 可把全部类别压成同一毫秒数（冒烟脚本用，
    /// 否则「过期 → 回退旧值」这条路径要等 2 分钟起步，没法在 CI 里验）
    pub fn ttl_ms(&self, kind: &str) -> i64 {
        if let Some(ms) = std::env::var("PF_SRC_CACHE_TTL_MS").ok().and_then(|v| v.parse::<i64>().ok()) {
            if ms > 0 {
                return ms;
            }
        }
        let mins = match kind {
            KIND_SEARCH => self.ttl_search_min,
            KIND_CATEGORY => self.ttl_category_min,
            KIND_DETAIL => self.ttl_detail_min,
            KIND_PARSE_LINK => self.ttl_parse_min,
            KIND_TMDB => self.ttl_tmdb_hours * 60,
            KIND_POSTER => self.ttl_poster_days * 24 * 60,
            // 未知 kind 给保守 10 分钟（不 panic，便于新增类别渐进接入）
            _ => 10,
        };
        mins.saturating_mul(60_000)
    }

    /// 容量换算字节
    pub fn capacity_bytes(&self) -> i64 {
        self.capacity_mb.saturating_mul(1024 * 1024)
    }
}

// ---------- 读写结果模型 ----------

/// 一次查表结果（`fresh=false` 表示已过 TTL，只能作为回退旧值）
#[derive(Debug, Clone)]
pub struct SrcCacheHit {
    pub body: Vec<u8>,
    pub stored_at: i64,
    pub expires_at: i64,
    pub fresh: bool,
}

impl SrcCacheHit {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SrcCacheKindStat {
    pub kind: String,
    pub entries: i64,
    pub bytes: i64,
    pub hits: i64,
    pub misses: i64,
    pub stale_served: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SrcCacheStats {
    pub entries: i64,
    pub bytes: i64,
    pub hits: i64,
    pub misses: i64,
    pub stale_served: i64,
    pub expired: i64,
    pub kinds: Vec<SrcCacheKindStat>,
}

/// 当前毫秒时间戳（缓存时间轴统一用它，避免与 iso 字符串混用）
pub fn now_ms_i64() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 维护节流：同一进程内最多每 15s 跑一轮 prune/evict（避免每次 put 全表扫）
static LAST_MAINT: AtomicI64 = AtomicI64::new(0);

impl CacheStore {
    /// 查缓存。新鲜命中记 hit；行不存在记 miss；**过期命中不计任何计数**
    /// （过期只是「不新鲜」，交给调用方决定是否 note_stale 后回退）。
    pub fn src_cache_lookup(&self, kind: &str, key: &str, now: i64) -> Option<SrcCacheHit> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let row = conn
            .query_row(
                "SELECT body, stored_at, expires_at FROM src_cache WHERE kind=?1 AND key=?2",
                rusqlite::params![kind, key],
                |r| {
                    Ok((
                        r.get::<_, Vec<u8>>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional();
        match row {
            Ok(Some((body, stored_at, expires_at))) => {
                let fresh = expires_at > now;
                if fresh {
                    let _ = conn.execute(
                        "UPDATE src_cache SET hits=hits+1, last_hit_at=?3 WHERE kind=?1 AND key=?2",
                        rusqlite::params![kind, key, now],
                    );
                    let _ = Self::stat_bump(&conn, kind, 1, 0, 0);
                }
                Some(SrcCacheHit { body, stored_at, expires_at, fresh })
            }
            _ => {
                let _ = Self::stat_bump(&conn, kind, 0, 1, 0);
                None
            }
        }
    }

    /// 旧值回退计数（调用方真的把 stale 数据交给用户时记一次）
    pub fn src_cache_note_stale(&self, kind: &str) {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let _ = Self::stat_bump(&conn, kind, 0, 0, 1);
    }

    /// 写缓存（同 kind/key 覆盖）；body 超过 MAX_ENTRY_BYTES 直接丢弃并返回 false
    pub fn src_cache_put(&self, kind: &str, key: &str, body: &[u8], ttl_ms: i64, now: i64) -> bool {
        if body.len() > MAX_ENTRY_BYTES {
            return false;
        }
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "INSERT INTO src_cache(kind,key,body,bytes,stored_at,expires_at,hits,last_hit_at)
             VALUES(?1,?2,?3,?4,?5,?6,0,NULL)
             ON CONFLICT(kind,key) DO UPDATE SET
               body=excluded.body, bytes=excluded.bytes,
               stored_at=excluded.stored_at, expires_at=excluded.expires_at",
            rusqlite::params![
                kind,
                key,
                body,
                body.len() as i64,
                now,
                now.saturating_add(ttl_ms.max(0))
            ],
        )
        .is_ok()
    }

    /// 精确失效（源站被删/改、或需要强制刷新时用）
    pub fn src_cache_invalidate(&self, kind: &str, key: &str) {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let _ = conn.execute(
            "DELETE FROM src_cache WHERE kind=?1 AND key=?2",
            rusqlite::params![kind, key],
        );
    }

    /// 按前缀失效（key 以 `{prefix}` 开头的全部删掉；删源站时清其名下搜索/分类缓存）
    pub fn src_cache_invalidate_prefix(&self, kind: &str, prefix: &str) -> i64 {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "DELETE FROM src_cache WHERE kind=?1 AND substr(key,1,length(?2))=?2",
            rusqlite::params![kind, prefix],
        )
        .map(|n| n as i64)
        .unwrap_or(0)
    }

    /// 清空（kind=None 全清）；返回 (删除条数, 释放字节)
    pub fn src_cache_clear(&self, kind: Option<&str>) -> (i64, i64) {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let sum: i64 = conn
            .query_row(
                match kind {
                    Some(_) => "SELECT COALESCE(SUM(bytes),0) FROM src_cache WHERE kind=?1",
                    None => "SELECT COALESCE(SUM(bytes),0) FROM src_cache",
                },
                rusqlite::params_from_iter(kind.iter()),
                |r| r.get(0),
            )
            .unwrap_or(0);
        let removed = conn
            .execute(
                match kind {
                    Some(_) => "DELETE FROM src_cache WHERE kind=?1",
                    None => "DELETE FROM src_cache",
                },
                rusqlite::params_from_iter(kind.iter()),
            )
            .map(|n| n as i64)
            .unwrap_or(0);
        (removed, sum)
    }

    /// 统计：总量 + 按 kind 分布 + 命中率原料
    pub fn src_cache_stats(&self) -> SrcCacheStats {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let now = now_ms_i64();
        let mut rows: Vec<SrcCacheKindStat> = Vec::new();
        if let Ok(mut stmt) = conn.prepare(
            "SELECT c.kind, COUNT(*), COALESCE(SUM(c.bytes),0),
                    COALESCE(s.hits,0), COALESCE(s.misses,0), COALESCE(s.stale_served,0)
             FROM src_cache c LEFT JOIN src_cache_stat s ON s.kind=c.kind
             GROUP BY c.kind ORDER BY SUM(c.bytes) DESC",
        ) {
            if let Ok(it) = stmt.query_map([], |r| {
                Ok(SrcCacheKindStat {
                    kind: r.get(0)?,
                    entries: r.get(1)?,
                    bytes: r.get(2)?,
                    hits: r.get(3)?,
                    misses: r.get(4)?,
                    stale_served: r.get(5)?,
                })
            }) {
                rows.extend(it.filter_map(|x| x.ok()));
            }
        }
        // 清空后仍有计数残留的 kind：entries=0 但命中率有意义，补 0 行
        if let Ok(mut stmt) = conn.prepare(
            "SELECT kind, hits, misses, stale_served FROM src_cache_stat WHERE kind NOT IN
             (SELECT DISTINCT kind FROM src_cache)",
        ) {
            if let Ok(it) = stmt.query_map([], |r| {
                Ok(SrcCacheKindStat {
                    kind: r.get(0)?,
                    entries: 0,
                    bytes: 0,
                    hits: r.get(1)?,
                    misses: r.get(2)?,
                    stale_served: r.get(3)?,
                })
            }) {
                rows.extend(it.filter_map(|x| x.ok()));
            }
        }
        let expired: i64 = conn
            .query_row("SELECT COUNT(*) FROM src_cache WHERE expires_at<=?1", rusqlite::params![now], |r| r.get(0))
            .unwrap_or(0);
        SrcCacheStats {
            entries: rows.iter().map(|k| k.entries).sum(),
            bytes: rows.iter().map(|k| k.bytes).sum(),
            hits: rows.iter().map(|k| k.hits).sum(),
            misses: rows.iter().map(|k| k.misses).sum(),
            stale_served: rows.iter().map(|k| k.stale_served).sum(),
            expired,
            kinds: rows,
        }
    }

    /// 删过期行（`retain_ms` 内仍保留：过期只是不新鲜，回退还要用）
    pub fn src_cache_prune(&self, now: i64, retain_ms: i64) -> i64 {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "DELETE FROM src_cache WHERE expires_at < ?1",
            rusqlite::params![now.saturating_sub(retain_ms.max(0))],
        )
        .map(|n| n as i64)
        .unwrap_or(0)
    }

    /// 容量 LRU：超过上限时按最久未用删到 80% 水位；返回释放字节
    pub fn src_cache_evict_lru(&self, capacity_bytes: i64) -> i64 {
        if capacity_bytes <= 0 {
            return 0;
        }
        let mut conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let total: i64 = conn
            .query_row("SELECT COALESCE(SUM(bytes),0) FROM src_cache", [], |r| r.get(0))
            .unwrap_or(0);
        if total <= capacity_bytes {
            return 0;
        }
        let target = capacity_bytes * 8 / 10;
        let mut freed = 0i64;
        // 候选按「最近使用时间」升序（没命中过就看写入时间）
        let candidates: Vec<(String, String, i64)> = {
            let mut out = Vec::new();
            if let Ok(mut stmt) = conn.prepare(
                "SELECT kind, key, bytes FROM src_cache
                 ORDER BY COALESCE(last_hit_at, stored_at) ASC LIMIT 512",
            ) {
                if let Ok(it) = stmt.query_map([], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
                }) {
                    out.extend(it.filter_map(|x| x.ok()));
                }
            }
            out
        };
        for (kind, key, bytes) in candidates {
            if total - freed <= target {
                break;
            }
            if conn
                .execute(
                    "DELETE FROM src_cache WHERE kind=?1 AND key=?2",
                    rusqlite::params![kind, key],
                )
                .is_ok()
            {
                freed += bytes;
            }
        }
        freed
    }

    /// 周期维护（节流 15s）：先删过期超过 7 天的，再按容量 LRU 淘汰。
    /// 返回释放字节（用于日志）。
    pub fn src_cache_maintain(&self, policy: &SrcCachePolicy) -> i64 {
        let now = now_ms_i64();
        let last = LAST_MAINT.load(Ordering::Relaxed);
        if now - last < 15_000 {
            return 0;
        }
        LAST_MAINT.store(now, Ordering::Relaxed);
        // 保留窗口：海报最久（7 天 × 其 TTL 倍数），其余统一 7 天
        let mut freed = 0i64;
        freed += self.src_cache_prune(now, 7 * 86_400_000);
        freed += self.src_cache_evict_lru(policy.capacity_bytes());
        freed
    }

    fn stat_bump(
        conn: &rusqlite::Connection,
        kind: &str,
        hits: i64,
        misses: i64,
        stale: i64,
    ) -> rusqlite::Result<()> {
        conn.execute(
            "INSERT INTO src_cache_stat(kind,hits,misses,stale_served) VALUES(?1,?2,?3,?4)
             ON CONFLICT(kind) DO UPDATE SET
               hits=hits+excluded.hits, misses=misses+excluded.misses,
               stale_served=stale_served+excluded.stale_served",
            rusqlite::params![kind, hits, misses, stale],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::iso_now;

    fn temp_store(tag: &str) -> (CacheStore, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "pf-srccache-{tag}-{}-{}",
            std::process::id(),
            now_ms_i64()
        ));
        std::fs::create_dir_all(&dir).ok();
        let store = CacheStore::open(&dir.join("core.db"), dir.join("cache")).expect("open store");
        (store, dir)
    }

    #[test]
    fn put_get_fresh_and_expiry() {
        let (store, dir) = temp_store("ttl");
        let now = 1_800_000_000_000i64;
        assert!(store.src_cache_lookup(KIND_SEARCH, "a|b", now).is_none());
        assert!(store.src_cache_put(KIND_SEARCH, "a|b", b"hello", 60_000, now));
        let hit = store.src_cache_lookup(KIND_SEARCH, "a|b", now + 1).expect("hit");
        assert!(hit.fresh);
        assert_eq!(hit.text(), "hello");
        // 过期仍可读（回退用），但 fresh=false
        let stale = store.src_cache_lookup(KIND_SEARCH, "a|b", now + 60_001).expect("stale");
        assert!(!stale.fresh);
        assert_eq!(stale.text(), "hello");
        // 覆盖写：TTL 与内容同步更新
        assert!(store.src_cache_put(KIND_SEARCH, "a|b", b"world", 120_000, now + 60_001));
        let again = store.src_cache_lookup(KIND_SEARCH, "a|b", now + 60_002).expect("hit2");
        assert!(again.fresh);
        assert_eq!(again.text(), "world");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn oversized_body_rejected() {
        let (store, dir) = temp_store("big");
        let big = vec![0u8; MAX_ENTRY_BYTES + 1];
        assert!(!store.src_cache_put(KIND_POSTER, "u", &big, 1000, 1));
        assert!(store.src_cache_lookup(KIND_POSTER, "u", 2).is_none());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn stats_hits_and_misses() {
        let (store, dir) = temp_store("stats");
        let now = 1_800_000_000_000i64;
        store.src_cache_put(KIND_DETAIL, "api|1", b"x", 60_000, now);
        store.src_cache_lookup(KIND_DETAIL, "api|1", now); // hit
        store.src_cache_lookup(KIND_DETAIL, "api|1", now); // hit
        store.src_cache_lookup(KIND_DETAIL, "api|2", now); // miss
        store.src_cache_note_stale(KIND_DETAIL); // stale
        let s = store.src_cache_stats();
        assert_eq!(s.entries, 1);
        assert_eq!(s.hits, 2);
        assert_eq!(s.misses, 1);
        assert_eq!(s.stale_served, 1);
        let k = s.kinds.iter().find(|k| k.kind == KIND_DETAIL).unwrap();
        assert_eq!(k.bytes, 1);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn clear_and_prefix_invalidate() {
        let (store, dir) = temp_store("clear");
        let now = 1_800_000_000_000i64;
        store.src_cache_put(KIND_SEARCH, "http://a/api|q1", b"1", 60_000, now);
        store.src_cache_put(KIND_SEARCH, "http://a/api|q2", b"22", 60_000, now);
        store.src_cache_put(KIND_CATEGORY, "http://a/api|1|0", b"333", 60_000, now);
        // 前缀失效：只删 http://a 名下 search
        assert_eq!(store.src_cache_invalidate_prefix(KIND_SEARCH, "http://a/"), 2);
        assert!(store.src_cache_lookup(KIND_SEARCH, "http://a/api|q1", now).is_none());
        assert!(store.src_cache_lookup(KIND_CATEGORY, "http://a/api|1|0", now).is_some());
        // 按 kind 清空
        let (removed, freed) = store.src_cache_clear(Some(KIND_CATEGORY));
        assert_eq!(removed, 1);
        assert_eq!(freed, 3);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn lru_evicts_least_recently_used() {
        let (store, dir) = temp_store("lru");
        let now = 1_800_000_000_000i64;
        // 每条 100B，容量上限 250B → 必然淘汰
        for i in 0..3 {
            store.src_cache_put(KIND_POSTER, &format!("p{i}"), &vec![7u8; 100], 86_400_000, now + i);
        }
        // 命中 p0 → 续命，最旧的变成 p1
        store.src_cache_lookup(KIND_POSTER, "p0", now + 10);
        let freed = store.src_cache_evict_lru(250);
        assert!(freed >= 100, "freed={freed}");
        assert!(store.src_cache_lookup(KIND_POSTER, "p0", now + 11).is_some());
        assert!(store.src_cache_lookup(KIND_POSTER, "p1", now + 11).is_none());
        let total: i64 = store.src_cache_stats().bytes;
        assert!(total <= 250, "total={total}");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn prune_keeps_recent_expired() {
        let (store, dir) = temp_store("prune");
        let now = 1_800_000_000_000i64;
        store.src_cache_put(KIND_TMDB, "old", b"o", 1000, now - 30 * 86_400_000);
        store.src_cache_put(KIND_TMDB, "fresh", b"f", 86_400_000, now);
        // 过期超 7 天的才删
        assert_eq!(store.src_cache_prune(now, 7 * 86_400_000), 1);
        assert!(store.src_cache_lookup(KIND_TMDB, "old", now).is_none());
        assert!(store.src_cache_lookup(KIND_TMDB, "fresh", now).is_some());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn policy_roundtrip_and_clamp() {
        let (store, dir) = temp_store("policy");
        let d = SrcCachePolicy::load(&store);
        assert_eq!(d, SrcCachePolicy::default());
        // 越界入参被夹取
        let p = SrcCachePolicy::save(&store, Some(1), Some(99999), None, None, None, None, Some(0), Some(false))
            .expect("save");
        assert_eq!(p.ttl_search_min, 2); // 下限
        assert_eq!(p.ttl_category_min, 1440); // 上限
        assert_eq!(p.capacity_mb, 8);
        assert!(!p.offline_fallback);
        let reloaded = SrcCachePolicy::load(&store);
        assert_eq!(reloaded, p);
        assert_eq!(p.ttl_ms(KIND_TMDB), 24 * 3_600_000);
        assert_eq!(p.capacity_bytes(), 8 * 1024 * 1024);
        // 未改动的项保持原值
        let p2 = SrcCachePolicy::save(&store, None, None, None, Some(48), None, None, None, None).expect("save2");
        assert_eq!(p2.ttl_tmdb_hours, 48);
        assert_eq!(p2.ttl_search_min, 2);
        let _ = iso_now();
        std::fs::remove_dir_all(dir).ok();
    }
}
