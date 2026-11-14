//! pf-engine：下载调度引擎
//!
//! P0：内存任务表 + 事件广播（task.updated / log）。
//! P1：分片清单 + 并发下载 + SQLite 断点续存 + 进度事件（DESIGN.md §4.2 / §4.6）。
//! P2：多镜像注册 + 源健康度（EWMA/熔断，DESIGN §4.2）+ 逐片换源 +
//!     播放头水位驱动调度 + AES-128 本地解密（DESIGN §4.1/§4.3）。
//! P2.5：缓存三档模式（online/stream/precache，DESIGN §4.6）+ 播完 TTL/
//!     未播完 LRU/容量 LRU/孤儿清扫（cleanup.rs）；series 剧集表先落库，
//!     剧集级预缓存队列调度留待 P3；MP4 P2SP 字节级聚合留待 P4。
//! P6：MP4 任务 IDM 动态分段（空闲 worker 对半分认领最大剩余连续块 +
//!     在途大块剩余段窃取，DESIGN §4.2）+ task.export 合并导出（TS/fMP4
//!     二进制 concat）。

mod catalog_store;
mod cleanup;
mod crypto;
mod danmaku_store;
mod health;
mod magnet_store;
mod netdisk;
mod netdisk_store;
mod parse_store;
pub mod series;
mod srccache;

pub use catalog_store::{
    CatalogSourceRow, FavoriteRow, FavoriteSourceRow, PlayHistoryRecord, PlayHistoryRow,
    WatchProgressRow, CATALOG_SCHEMA,
};
pub use danmaku_store::{DanmakuChannelRow, DANMAKU_SCHEMA};
pub use magnet_store::{MagnetTaskRow, MAGNET_SCHEMA};
pub use netdisk::NetdiskService;
pub use netdisk_store::{NetdiskAccountRow, NetdiskShareRow, NETDISK_SCHEMA};
pub use parse_store::{ParseServiceRow, PARSE_SCHEMA};
pub use srccache::{
    now_ms_i64, SrcCacheHit, SrcCacheKindStat, SrcCachePolicy, SrcCacheStats, KIND_CATEGORY,
    KIND_DETAIL, KIND_PARSE_LINK, KIND_POSTER, KIND_SEARCH, KIND_TMDB, MAX_ENTRY_BYTES,
    SRC_CACHE_SCHEMA,
};

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use pf_parser::{KeyInfo, MediaIR, Protocol, Segment};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, Mutex as TokioMutex};

pub use health::SourceStat;

/// 代理信息（引擎用它生成 playUrl）
#[derive(Debug, Clone)]
pub struct ProxyInfo {
    pub port: u16,
    /// 路径内随机 token（防局域网直访）
    pub token: String,
}

/// P46 剧集集序行（series_episodes）
#[derive(Debug, Clone)]
pub struct SeriesEpisode {
    pub idx: i64,
    pub name: Option<String>,
    pub url: String,
    /// 预缓存失败次数（≥3 不再自动重试）
    pub attempts: i64,
    pub last_error: Option<String>,
    /// 退避到期时刻（毫秒；0 = 可立即尝试）
    pub next_try_at: i64,
}

/// 任务行快照（库里有、内存还没有时用它补建 Task）
#[derive(Debug, Clone)]
pub struct TaskBrief {
    pub url: String,
    pub title: Option<String>,
    pub protocol: String,
    pub status: String,
    pub cache_mode: String,
}

/// P46 预缓存策略（settings 表持久化）
#[derive(Debug, Clone, Copy)]
pub struct PrefetchConfig {
    pub mode: series::PrefetchMode,
    pub count: u32,
}

/// 缓存三档模式（DESIGN §4.6，与 packages/shared 的 CacheMode 同构）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CacheMode {
    /// 纯在线：引擎不预取不落盘，proxy 纯实时回源，退出即弃
    Online,
    /// 边下边播：播放头 ±60s 高优 + 前向水位窗口，不预取窗口外内容
    Stream,
    /// 预缓存（默认，P29）：播放头窗口优先之外，低优持续预取全部剩余分片
    Precache,
}

impl Default for CacheMode {
    /// P29：默认播放策略由 stream（边下边播）改为 precache（预缓存）。
    /// `task.create` 缺省值、DB 列缺省值、读库失败兜底全部走这里，
    /// 保证「前端没传 / 参数不认识 / 库值异常」三种情况落在同一个档位上。
    fn default() -> Self {
        CacheMode::Precache
    }
}

impl CacheMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            CacheMode::Online => "online",
            CacheMode::Stream => "stream",
            CacheMode::Precache => "precache",
        }
    }
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "online" => Some(CacheMode::Online),
            "stream" => Some(CacheMode::Stream),
            "precache" => Some(CacheMode::Precache),
            _ => None,
        }
    }
}

/// 播放任务（与 packages/shared 的 Task 同构，camelCase 序列化）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub url: String,
    pub protocol: Protocol,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub status: TaskStatus,
    /// ISO8601 时间戳
    pub created_at: String,
    /// 本地代理播放地址（pf-proxy 生成的重写 playlist）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub play_url: Option<String>,
    /// master playlist 重写地址（P3：mpv 轨道选择用，含全部 variant + EXT-X-MEDIA 归并）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub master_url: Option<String>,
    /// 缓存三档模式（P2.5）
    pub cache_mode: CacheMode,
    /// 缓存保留截止（播完 TTL，ISO8601；None = 未完结或永久保留）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retain_until: Option<String>,
    // ---- 进度（由 segments 表实时聚合，不在库中存列） ----
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seg_done: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seg_total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_done: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed_bps: Option<u64>,
    /// 播放头所在分片（proxy /seg 请求驱动，水位调度锚点）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playhead_seq: Option<u64>,
}

/// 任务状态（与 packages/shared 的 TaskStatus 同构）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Pending,
    Probing,
    Ready,
    Downloading,
    /// P5 用户暂停下载（播放不受影响；重启后保持暂停）
    Paused,
    Failed,
}

impl TaskStatus {
    fn as_str(&self) -> &'static str {
        match self {
            TaskStatus::Pending => "pending",
            TaskStatus::Probing => "probing",
            TaskStatus::Ready => "ready",
            TaskStatus::Downloading => "downloading",
            TaskStatus::Paused => "paused",
            TaskStatus::Failed => "failed",
        }
    }
    fn from_str(s: &str) -> Self {
        match s {
            "pending" => TaskStatus::Pending,
            "probing" => TaskStatus::Probing,
            "ready" => TaskStatus::Ready,
            "downloading" => TaskStatus::Downloading,
            "paused" => TaskStatus::Paused,
            _ => TaskStatus::Failed,
        }
    }
}

/// proxy 实时统计（与 packages/shared 的 ProxyStat 同构）
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyStat {
    pub cache_hits: u64,
    pub origin_fetches: u64,
    pub bytes_served: u64,
}

/// 合并导出探测（与 packages/shared 的 ExportInfo 同构）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportInfo {
    /// 建议扩展名（ts / mp4）
    pub ext: String,
    /// 已缓存分片数
    pub done: u64,
    /// 分片总数
    pub total: u64,
}

/// 合并导出结果（与 packages/shared 的 ExportResult 同构）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub bytes: u64,
    pub segments: u64,
}

/// 缓存清理策略（P3 设置页可配；settings 表持久化，缺省回落常量）
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachePolicy {
    /// 播完 TTL 保留天数（负数 = 永久）
    pub retain_days: f64,
    /// 未播完 LRU 天数
    pub unfinished_days: f64,
    /// 容量上限（GB）
    pub capacity_gb: f64,
}

/// 引擎事件：经 pf-core 转发为 JSON-RPC 通知
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EngineEvent {
    TaskUpdated { task: Task },
    Log { level: String, message: String },
    /// 源健康度快照（调试面板，下载/播放过程周期推送）
    SourcesUpdated { task_id: String, sources: Vec<SourceStat> },
    /// 代理命中/回源计数（调试面板）
    ProxyStats { task_id: String, stats: ProxyStat },
    /// libmpv 播放状态快照（P3；payload 与 packages/shared 的 MpvState 同构）
    MpvState { state: serde_json::Value },
}

// ---------- 存储层（SQLite + 分片文件，DESIGN §4.6 的 P1/P2/P2.5 子集） ----------

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS series(
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at INTEGER NOT NULL
);
-- P46 剧集集序表：前端起播时把整组剧集的 url/集名同步进来，
-- 预缓存窗口靠它把「后面第 N 集」变成可建任务的 URL（内核自己没有片源详情）
CREATE TABLE IF NOT EXISTS series_episodes(
  series_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  name TEXT,
  url TEXT NOT NULL,
  -- 失败重试：attempts 累计、next_try_at 退避时刻（毫秒），超过上限不再自动重试
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_try_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(series_id, idx)
);
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks(
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  title TEXT,
  protocol TEXT NOT NULL,
  status TEXT NOT NULL,
  live INTEGER NOT NULL DEFAULT 0,
  total_duration REAL,
  cache_mode TEXT NOT NULL DEFAULT 'precache',
  -- P29：1 = 用户在任务页显式改过该任务的缓存档，此后 task.create 复用任务时不再用默认值覆盖
  cache_mode_explicit INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  retain_until INTEGER,
  finished_at INTEGER,
  last_played_at INTEGER,
  series_id TEXT,
  episode_index INTEGER
);
CREATE TABLE IF NOT EXISTS sources(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  url TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_sources_task ON sources(task_id);
CREATE TABLE IF NOT EXISTS segments(
  task_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  bytes INTEGER,
  state TEXT NOT NULL DEFAULT 'pending',
  source_id INTEGER,
  path TEXT,
  tries INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(task_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_segments_task ON segments(task_id, state);
";

/// 旧库兼容迁移：缺列补列（重复执行报 duplicate column，忽略）
const MIGRATIONS: &[&str] = &[
    "ALTER TABLE tasks ADD COLUMN retain_until INTEGER",
    "ALTER TABLE tasks ADD COLUMN finished_at INTEGER",
    "ALTER TABLE tasks ADD COLUMN last_played_at INTEGER",
    "ALTER TABLE tasks ADD COLUMN series_id TEXT",
    "ALTER TABLE tasks ADD COLUMN episode_index INTEGER",
    // P17 弹幕特效：'glow' | 'gradient' | NULL（NULL = 普通样式）
    "ALTER TABLE danmaku ADD COLUMN fx TEXT",
    // P29：旧库补缓存档来源标记（0 = 默认值，1 = 用户显式设置）
    "ALTER TABLE tasks ADD COLUMN cache_mode_explicit INTEGER NOT NULL DEFAULT 0",
    // P33：片源自带封面。同一部影片在不同站的海报不同，是「一个视频多张缩略图」的真实来源
    "ALTER TABLE favorite_sources ADD COLUMN poster TEXT",
];

/// 分片缓存存储：SQLite 索引 + 幂等文件命名 `{task_id}/{seq:08}.bin`
pub struct CacheStore {
    conn: Mutex<Connection>,
    cache_dir: PathBuf,
}

impl CacheStore {
    pub fn open(db_path: &Path, cache_dir: PathBuf) -> Result<Self, String> {
        if let Some(p) = db_path.parent() {
            std::fs::create_dir_all(p).map_err(|e| format!("创建数据目录失败: {e}"))?;
        }
        std::fs::create_dir_all(&cache_dir).map_err(|e| format!("创建缓存目录失败: {e}"))?;
        let conn = Connection::open(db_path).map_err(|e| format!("打开 SQLite 失败: {e}"))?;
        // WAL + busy_timeout：内核被 kill 后重启时，跨进程写不互斥阻塞
        let _ = conn.busy_timeout(Duration::from_secs(5));
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        conn.execute_batch(SCHEMA)
            .map_err(|e| format!("初始化表结构失败: {e}"))?;
        // P7 目录表（catalog_sources / favorites / favorite_sources）
        conn.execute_batch(crate::CATALOG_SCHEMA)
            .map_err(|e| format!("初始化目录表失败: {e}"))?;
        // P9b 网盘表（netdisk_accounts / netdisk_shares）
        conn.execute_batch(crate::NETDISK_SCHEMA)
            .map_err(|e| format!("初始化网盘表失败: {e}"))?;
        // P10 解析接口表（parse_services）
        conn.execute_batch(crate::PARSE_SCHEMA)
            .map_err(|e| format!("初始化解析接口表失败: {e}"))?;
        // P14 弹幕表（danmaku / danmaku_channels）
        conn.execute_batch(crate::DANMAKU_SCHEMA)
            .map_err(|e| format!("初始化弹幕表失败: {e}"))?;
        // P12 磁力任务表（magnet_tasks）
        conn.execute_batch(crate::MAGNET_SCHEMA)
            .map_err(|e| format!("初始化磁力任务表失败: {e}"))?;
        // P19 片源内容缓存表（src_cache / src_cache_stat）
        conn.execute_batch(crate::SRC_CACHE_SCHEMA)
            .map_err(|e| format!("初始化片源缓存表失败: {e}"))?;
        // 旧库缺列补列（新库建表已含，ALTER 报 duplicate column 忽略）
        for m in MIGRATIONS {
            let _ = conn.execute_batch(m);
        }
        Ok(Self {
            conn: Mutex::new(conn),
            cache_dir,
        })
    }

    pub fn cache_dir(&self) -> &Path {
        &self.cache_dir
    }

    /// 分片最终落盘路径（幂等命名）
    pub fn segment_path(&self, task_id: &str, seq: u64) -> PathBuf {
        self.cache_dir.join(task_id).join(format!("{seq:08}.bin"))
    }

    pub fn upsert_task(
        &self,
        id: &str,
        url: &str,
        title: Option<&str>,
        protocol: &str,
        status: &str,
        live: bool,
        total_duration: Option<f64>,
        cache_mode: &str,
        created_at: &str,
    ) -> Result<(), String> {
        let mut conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "INSERT INTO tasks(id,url,title,protocol,status,live,total_duration,cache_mode,created_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
             ON CONFLICT(id) DO UPDATE SET
               title=excluded.title, protocol=excluded.protocol, status=excluded.status,
               live=excluded.live, total_duration=excluded.total_duration,
               cache_mode=excluded.cache_mode",
            rusqlite::params![id, url, title, protocol, status, live, total_duration, cache_mode, created_at],
        )
        .map_err(|e| format!("upsert task 失败: {e}"))?;
        Ok(())
    }

    pub fn find_task_id_by_url(&self, url: &str) -> Result<Option<String>, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let mut stmt = conn
            .prepare("SELECT id FROM tasks WHERE url=?1")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query(rusqlite::params![url]).map_err(|e| e.to_string())?;
        if let Some(r) = rows.next().map_err(|e| e.to_string())? {
            Ok(r.get::<_, String>(0).ok())
        } else {
            Ok(None)
        }
    }

    /// 未完结任务（启动时恢复下载），返回 (id, url, cache_mode)
    pub fn unfinished_tasks(&self) -> Result<Vec<(String, String, String)>, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let mut stmt = conn
            .prepare(
                "SELECT id,url,cache_mode FROM tasks
                 WHERE status IN ('pending','probing','downloading') AND cache_mode != 'online'",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// 全量任务行（P5 启动恢复/媒体库用）：(id, url, cache_mode, status, title)
    /// 已完结（ready）与已暂停（paused）任务也恢复到内存任务表，媒体库跨重启保留
    pub fn all_tasks(&self) -> Vec<(String, String, String, String, Option<String>)> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let mut stmt = match conn.prepare("SELECT id,url,cache_mode,status,title FROM tasks") {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        })
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
    }

    pub fn set_task_status(&self, id: &str, status: &str) {
        let mut conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let _ = conn.execute(
            "UPDATE tasks SET status=?2 WHERE id=?1",
            rusqlite::params![id, status],
        );
    }

    // ---------- P2.5 缓存三档模式（DESIGN §4.6） ----------

    /// 用户显式切换（RPC task.set_cache_mode）→ 打来源标记，
    /// 此后 task.create 复用该任务时不再用「默认档」覆盖用户的选择。
    pub fn set_cache_mode(&self, id: &str, mode: &str) -> Result<(), String> {
        let mut conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "UPDATE tasks SET cache_mode=?2, cache_mode_explicit=1 WHERE id=?1",
            rusqlite::params![id, mode],
        )
        .map_err(|e| format!("set cache_mode 失败: {e}"))?;
        Ok(())
    }

    /// 任务既有缓存档 + 是否用户显式设置（P29 复用时决定要不要套用默认档）
    pub fn task_cache_mode_meta(&self, id: &str) -> Result<Option<(String, bool)>, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let mut stmt = conn
            .prepare("SELECT cache_mode, cache_mode_explicit FROM tasks WHERE id=?1")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query(rusqlite::params![id]).map_err(|e| e.to_string())?;
        match rows.next().map_err(|e| e.to_string())? {
            Some(r) => Ok(Some((
                r.get::<_, String>(0).map_err(|e| e.to_string())?,
                r.get::<_, i64>(1).unwrap_or(0) != 0,
            ))),
            None => Ok(None),
        }
    }

    /// 播完 TTL 起点与保留截止（finished_at = now；retain_until = now + N 天；
    /// N < 0 或 INFINITY 视为永久 → retain_until 置 NULL）
    pub fn mark_finished(&self, id: &str, now_ms: i64, retain_ms: Option<i64>) {
        let mut conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let _ = conn.execute(
            "UPDATE tasks SET finished_at=?2, retain_until=?3 WHERE id=?1",
            rusqlite::params![id, now_ms, retain_ms],
        );
    }

    /// 播放活跃记账（容量 LRU 的「最久未播放」依据；note_playhead 节流调用）
    pub fn touch_played(&self, id: &str, now_ms: i64) {
        let mut conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let _ = conn.execute(
            "UPDATE tasks SET last_played_at=?2 WHERE id=?1",
            rusqlite::params![id, now_ms],
        );
    }

    /// 清空任务分片索引（模式转 online / 级联删除前的文件清理由调用方负责）
    pub fn clear_segments(&self, task_id: &str) {
        let mut conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let _ = conn.execute(
            "DELETE FROM segments WHERE task_id=?1",
            rusqlite::params![task_id],
        );
    }

    /// 任务存在性（孤儿清扫后判空目录用）
    pub fn task_exists(&self, id: &str) -> bool {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.query_row("SELECT 1 FROM tasks WHERE id=?1", rusqlite::params![id], |_| Ok(()))
            .is_ok()
    }

    /// 保留截止（epoch ms）；None = 未完结或永久
    pub fn retain_until_of(&self, id: &str) -> Option<i64> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.query_row(
            "SELECT retain_until FROM tasks WHERE id=?1",
            rusqlite::params![id],
            |r| r.get::<_, Option<i64>>(0),
        )
        .ok()
        .flatten()
    }

    /// 播完 TTL 过期任务：retain_until 非空且已到期，且不在播放保护窗口内
    pub fn expired_finished_tasks(
        &self,
        now_ms: i64,
        playing_window_ms: i64,
    ) -> Vec<String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let mut stmt = match conn.prepare(
            "SELECT id FROM tasks
             WHERE retain_until IS NOT NULL AND retain_until <= ?1
               AND (last_played_at IS NULL OR last_played_at < ?2)",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let cutoff_played = now_ms - playing_window_ms;
        stmt.query_map(rusqlite::params![now_ms, cutoff_played], |r| r.get::<_, String>(0))
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    }

    /// 未播完 LRU：长期未动的半截任务（DESIGN §4.6：14 天）
    pub fn stale_unfinished_tasks(&self, now_ms: i64, ttl_ms: i64) -> Vec<String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let cutoff = now_ms - ttl_ms;
        let mut stmt = match conn.prepare(
            "SELECT id FROM tasks
             WHERE status IN ('pending','probing','downloading')
               AND COALESCE(last_played_at, CAST(strftime('%s', created_at) AS INTEGER) * 1000) <= ?1",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(rusqlite::params![cutoff], |r| r.get::<_, String>(0))
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default()
    }

    /// 容量 LRU 候选：各任务已落盘字节 + 活跃时间（最久未播放优先）
    /// 返回 (task_id, bytes, activity_ms)；activity = COALESCE(last_played_at, finished_at, created_at_ms)
    pub fn task_bytes_by_activity(&self) -> Vec<(String, u64, i64)> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let mut stmt = match conn.prepare(
            "SELECT t.id,
                    COALESCE(SUM(CASE WHEN s.state='done' THEN s.bytes ELSE 0 END),0),
                    COALESCE(t.last_played_at, t.finished_at,
                             CAST(strftime('%s', t.created_at) AS INTEGER) * 1000)
             FROM tasks t LEFT JOIN segments s ON s.task_id = t.id
             GROUP BY t.id",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)? as u64,
                r.get::<_, Option<i64>>(2)?.unwrap_or(0),
            ))
        })
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
    }

    /// 任务级联删除：缓存目录 + segments/sources/tasks 行（清理器与 online 切换共用）
    pub fn delete_task_cascade(&self, task_id: &str) {
        let dir = self.cache_dir.join(task_id);
        if dir.exists() {
            let _ = std::fs::remove_dir_all(&dir);
        }
        let mut conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let _ = conn.execute("DELETE FROM segments WHERE task_id=?1", rusqlite::params![task_id]);
        let _ = conn.execute("DELETE FROM sources WHERE task_id=?1", rusqlite::params![task_id]);
        let _ = conn.execute("DELETE FROM tasks WHERE id=?1", rusqlite::params![task_id]);
    }

    /// 已完成分片集合（孤儿清扫对比用）
    pub fn done_pairs(&self) -> HashSet<(String, u64)> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let mut stmt = match conn.prepare("SELECT task_id, seq FROM segments WHERE state='done'") {
            Ok(s) => s,
            Err(_) => return HashSet::new(),
        };
        stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u64))
        })
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
    }

    // ---------- series 剧集（P2.5 落库骨架；队列调度 P3） ----------

    pub fn upsert_series(&self, id: &str, title: Option<&str>) -> Result<(), String> {
        let mut conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "INSERT INTO series(id,title,created_at) VALUES(?1,?2,?3)
             ON CONFLICT(id) DO UPDATE SET title=COALESCE(excluded.title, title)",
            rusqlite::params![id, title, now_ms() as i64],
        )
        .map_err(|e| format!("upsert series 失败: {e}"))?;
        Ok(())
    }

    /// 任务挂到剧集（episode_index 为集序，从 0 起）
    pub fn attach_task_series(
        &self,
        task_id: &str,
        series_id: &str,
        episode_index: i64,
    ) -> Result<(), String> {
        let mut conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "UPDATE tasks SET series_id=?2, episode_index=?3 WHERE id=?1",
            rusqlite::params![task_id, series_id, episode_index],
        )
        .map_err(|e| format!("attach series 失败: {e}"))?;
        Ok(())
    }

    /// 任务所属剧集：(series_id, episode_index)
    pub fn series_episode_of(&self, task_id: &str) -> Option<(String, i64)> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.query_row(
            "SELECT series_id, episode_index FROM tasks WHERE id=?1 AND series_id IS NOT NULL",
            rusqlite::params![task_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
        )
        .ok()
    }

    // ---------- series 队列 RPC 入口（TaskManager 透传） ----------

    /// 剧集全部任务：(task_id, episode_index, cache_mode, status, live)
    pub fn series_episodes(&self, series_id: &str) -> Vec<(String, i64, String, String, bool)> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let mut stmt = match conn.prepare(
            "SELECT id, episode_index, cache_mode, status, live FROM tasks
             WHERE series_id=?1 AND episode_index IS NOT NULL ORDER BY episode_index",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(rusqlite::params![series_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)? != 0,
            ))
        })
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
    }

    // ---------- P46 剧集集序（预缓存窗口的数据源） ----------

    /// 整组剧集同步。已存在的集**保留**重试计数（用户重播同一部片不该清掉退避），
    /// 只更新集名/URL —— 换线路时 URL 会变，必须覆盖。
    pub fn series_upsert_episodes(
        &self,
        series_id: &str,
        eps: &[(i64, Option<String>, String)],
    ) -> Result<(), String> {
        let mut conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let tx = conn.transaction().map_err(|e| format!("开启事务失败: {e}"))?;
        for (idx, name, url) in eps {
            tx.execute(
                "INSERT INTO series_episodes(series_id,idx,name,url) VALUES(?1,?2,?3,?4)
                 ON CONFLICT(series_id,idx) DO UPDATE SET name=excluded.name, url=excluded.url",
                rusqlite::params![series_id, idx, name, url],
            )
            .map_err(|e| format!("写入剧集失败: {e}"))?;
        }
        tx.commit().map_err(|e| format!("提交剧集失败: {e}"))?;
        Ok(())
    }

    pub fn series_episode_list(&self, series_id: &str) -> Vec<SeriesEpisode> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let mut stmt = match conn.prepare(
            "SELECT idx, name, url, attempts, last_error, next_try_at FROM series_episodes
             WHERE series_id=?1 ORDER BY idx",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        stmt.query_map(rusqlite::params![series_id], |r| {
            Ok(SeriesEpisode {
                idx: r.get(0)?,
                name: r.get(1)?,
                url: r.get(2)?,
                attempts: r.get(3)?,
                last_error: r.get(4)?,
                next_try_at: r.get(5)?,
            })
        })
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
    }

    /// 记一次预缓存失败：累加 attempts 并写入退避时刻
    pub fn series_episode_error(
        &self,
        series_id: &str,
        idx: i64,
        err: &str,
        next_try_at: i64,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "UPDATE series_episodes SET attempts=attempts+1, last_error=?3, next_try_at=?4
             WHERE series_id=?1 AND idx=?2",
            rusqlite::params![series_id, idx, err, next_try_at],
        )
        .map_err(|e| format!("记录预缓存失败: {e}"))?;
        Ok(())
    }

    /// 该集已经下起来（或已完成）：清掉失败痕迹，窗口下次滚动时可重新纳入
    pub fn series_episode_clear_error(&self, series_id: &str, idx: i64) {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let _ = conn.execute(
            "UPDATE series_episodes SET attempts=0, last_error=NULL, next_try_at=0
             WHERE series_id=?1 AND idx=?2",
            rusqlite::params![series_id, idx],
        );
    }

    /// 单行任务快照（库里有、内存还没有的任务：重启后未被恢复的集）
    pub fn task_brief(&self, id: &str) -> Option<TaskBrief> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.query_row(
            "SELECT url, title, protocol, status, cache_mode FROM tasks WHERE id=?1",
            rusqlite::params![id],
            |r| {
                Ok(TaskBrief {
                    url: r.get(0)?,
                    title: r.get(1)?,
                    protocol: r.get(2)?,
                    status: r.get(3)?,
                    cache_mode: r.get(4)?,
                })
            },
        )
        .ok()
    }

    // ---------- settings KV（P3 设置页可配：清理策略等） ----------

    pub fn setting_get(&self, key: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.query_row("SELECT value FROM settings WHERE key=?1", rusqlite::params![key], |r| {
            r.get::<_, String>(0)
        })
        .ok()
    }

    pub fn setting_set(&self, key: &str, value: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "INSERT INTO settings(key,value) VALUES(?1,?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            rusqlite::params![key, value],
        )
        .map_err(|e| format!("写设置失败: {e}"))?;
        Ok(())
    }

    /// 多镜像登记（全量重建；主源 URL 在 tasks.url，此处仅镜像）
    pub fn set_sources(&self, task_id: &str, urls: &[String]) -> Result<(), String> {
        let mut conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute("DELETE FROM sources WHERE task_id=?1", rusqlite::params![task_id])
            .map_err(|e| format!("清理 sources 失败: {e}"))?;
        for u in urls {
            conn.execute(
                "INSERT INTO sources(task_id,url) VALUES(?1,?2)",
                rusqlite::params![task_id, u],
            )
            .map_err(|e| format!("登记 source 失败: {e}"))?;
        }
        Ok(())
    }

    /// 镜像 URL 列表（启动恢复用）
    pub fn sources_of(&self, task_id: &str) -> Vec<String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let mut stmt = match conn.prepare("SELECT url FROM sources WHERE task_id=?1 ORDER BY id") {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = match stmt.query_map(rusqlite::params![task_id], |r| r.get::<_, String>(0)) {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };
        rows.filter_map(|r| r.ok()).collect()
    }

    /// 登记分片清单（INSERT OR IGNORE：已完成的记录保留，实现断点续传）
    pub fn upsert_segments(&self, task_id: &str, segs: &[Segment]) -> Result<(), String> {
        let mut conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        for s in segs {
            conn.execute(
                "INSERT OR IGNORE INTO segments(task_id,seq,state) VALUES(?1,?2,'pending')",
                rusqlite::params![task_id, s.seq as i64],
            )
            .map_err(|e| format!("upsert segment 失败: {e}"))?;
        }
        Ok(())
    }

    /// 已完成分片序号集合
    pub fn done_seqs(&self, task_id: &str) -> Result<HashSet<u64>, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let mut stmt = conn
            .prepare("SELECT seq FROM segments WHERE task_id=?1 AND state='done'")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![task_id], |r| {
                r.get::<_, i64>(0).map(|v| v as u64)
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<HashSet<_>, _>>().map_err(|e| e.to_string())
    }

    /// 登记分片状态；bytes 落盘成功后传 Some
    pub fn mark_segment(
        &self,
        task_id: &str,
        seq: u64,
        state: &str,
        bytes: Option<u64>,
        path: Option<&str>,
        tries: i64,
    ) {
        let mut conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let _ = conn.execute(
            "INSERT INTO segments(task_id,seq,bytes,state,path,tries) VALUES(?1,?2,?3,?4,?5,?6)
             ON CONFLICT(task_id,seq) DO UPDATE SET
               bytes=COALESCE(?3,bytes), state=?4, path=COALESCE(?5,path), tries=?6",
            rusqlite::params![task_id, seq as i64, bytes.map(|b| b as i64), state, path, tries],
        );
    }

    /// 进度聚合：(done, total, bytes)
    pub fn progress(&self, task_id: &str) -> (u64, u64, u64) {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let r = conn.query_row(
            "SELECT
               COALESCE(SUM(CASE WHEN state='done' THEN 1 ELSE 0 END),0),
               COUNT(*),
               COALESCE(SUM(CASE WHEN state='done' THEN bytes ELSE 0 END),0)
             FROM segments WHERE task_id=?1",
            rusqlite::params![task_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)? as u64,
                    row.get::<_, i64>(1)? as u64,
                    row.get::<_, i64>(2)? as u64,
                ))
            },
        );
        match r {
            Ok((d, t, b)) => (d, t, b),
            Err(_) => (0, 0, 0),
        }
    }

    pub fn count_failed(&self, task_id: &str) -> u64 {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.query_row(
            "SELECT COUNT(*) FROM segments WHERE task_id=?1 AND state='failed'",
            rusqlite::params![task_id],
            |r| r.get::<_, i64>(0).map(|v| v as u64),
        )
        .unwrap_or(0)
    }
}

// ---------- 任务管理器 ----------

/// 每任务源集合：主源 + 镜像（各源独立 MediaIR，分片按 seq 对齐；禁止跨源混拼）
#[derive(Debug, Clone)]
pub struct SourceSet {
    /// 主源 MediaIR（播放/重写 playlist 用）
    pub primary: MediaIR,
    /// 镜像 MediaIR（与 healths[1..] 一一对应）
    pub mirrors: Vec<MediaIR>,
}

/// P46 预缓存窗口里的一集（RPC 输出）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefetchItem {
    pub index: i64,
    pub name: Option<String>,
    pub task_id: Option<String>,
    /// queued | caching | ready | paused | failed
    pub state: &'static str,
    pub attempts: i64,
    pub error: Option<String>,
}

/// P46 预缓存窗口状态
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefetchStatus {
    pub series_id: String,
    pub mode: &'static str,
    pub count: u32,
    pub current: i64,
    /// 该剧已知总集数
    pub total: usize,
    /// 当前集之后的剩余集数
    pub remaining: usize,
    /// 剩余集数少于策略要求（数量不足时如实标记，而不是静默少缓）
    pub truncated: bool,
    pub items: Vec<PrefetchItem>,
}

pub struct TaskManager {
    store: CacheStore,
    tasks: TokioMutex<BTreeMap<String, Task>>,
    media: TokioMutex<BTreeMap<String, SourceSet>>,
    /// 源健康度（index 0 = 主源）
    healths: TokioMutex<BTreeMap<String, Vec<health::SourceHealth>>>,
    /// 播放头锚点（proxy /seg 请求驱动）
    playheads: TokioMutex<BTreeMap<String, u64>>,
    /// 解密 key 缓存：(task_id, key_uri) → 16B（yt-dlp 式按 URI 缓存）
    keys_cache: TokioMutex<HashMap<(String, String), [u8; 16]>>,
    /// proxy 实时统计
    pstats: Mutex<HashMap<String, ProxyStat>>,
    /// 探测/解析中的任务 id（并发去重）
    probing: TokioMutex<HashSet<String>>,
    /// 探测/解析最终失败的错误（id → 错误消息）。探测被去重时，
    /// create_task 的等待循环凭此立即拿到真实失败原因，而非空转至超时
    probe_errors: TokioMutex<HashMap<String, String>>,
    /// 在途下载任务停止标志（P2.5：转 online 时协同停止预取）
    job_stops: TokioMutex<HashMap<String, Arc<AtomicBool>>>,
    /// 播放活跃节流（last_played_at 落库限频）
    last_touch: Mutex<HashMap<String, Instant>>,
    events: broadcast::Sender<EngineEvent>,
    seq: AtomicU64,
    client: reqwest::Client,
    max_concurrency: usize,
    /// P9b 网盘播放直链缓存（core 解析 / proxy 取用共享同一份，403 时强制失效）
    links: pf_netdisk::LinkCache,
    /// P46 预缓存窗口的在途集（同一时刻只推进一集：抢播放带宽比「多存几集」代价高）
    prefetch_inflight: TokioMutex<HashSet<String>>,
    /// P46 预缓存是定时循环驱动的，没有 RPC 的 proxy 入参 —— 启动时注入一份
    proxy_slot: Mutex<Option<ProxyInfo>>,
}

/// 分片下载重试（DESIGN §4.2：同源最多 2 次，其余换源，分片级）
const RETRY_PER_SEGMENT: usize = 6;
const SAME_SOURCE_TRIES: usize = 2;
/// 重试基础退避（指数：300ms * 2^n）
const RETRY_BACKOFF_MS: u64 = 300;
/// 进度/健康度心跳间隔
const PROGRESS_TICK_MS: u64 = 600;
/// 镜像对齐容差：时长差 ≤ max(10%, 1s)
const ALIGN_TOLERANCE: f64 = 0.1;
/// 播完 TTL 默认保留天数（DESIGN §4.6：播完 1 天后清理；可 0/7/30，永久 = 负数）
const RETAIN_DAYS_DEFAULT: f64 = 1.0;
/// 未播完 LRU 天数（DESIGN §4.6：14 天）
const UNFINISHED_TTL_DAYS: f64 = 14.0;
/// 容量上限默认 20GB（DESIGN §4.6，P2.5 为常量；设置页可配留待后续）
const CAPACITY_BYTES_DEFAULT: u64 = 20 * 1024 * 1024 * 1024;
/// 「正在播放」保护窗口：10 分钟内有播放头活动不受清理
const PLAYING_WINDOW_MS: i64 = 10 * 60 * 1000;
/// P46 预缓存失败重试上限（超过后不再自动重试，等用户自己播或点重试）
const PREFETCH_MAX_ATTEMPTS: i64 = 3;
/// P46 退避（秒）：60s / 5min / 15min
const PREFETCH_BACKOFF_SECS: [i64; 3] = [60, 300, 900];
/// last_played_at 落库限频
const TOUCH_THROTTLE: Duration = Duration::from_secs(30);
/// stream 模式窗口未开时 worker 等待间隔（等播放头推进）
const WINDOW_WAIT_MS: u64 = 400;

/// IDM 窃取门槛：在途块剩余 ≥4 片（16MiB）才值得对半分接管
const IDM_STEAL_MIN: u64 = 4;

/// P6 IDM 动态分段认领块（DESIGN §4.2，仅 MP4 任务）：
/// worker 认领一段连续 seq（块）后原子游标逐片取件；空闲 worker 可把
/// 最大在途块的剩余段对半分接管（原块 stop_at 前移至切分点），即
/// IDM「空闲连接把最大剩余块对半分」。块只是调度范围，逐片仍走既有
/// fetch_on_sources（换源/重试/健康度记账不变），存储与断点续存不变。
struct Claim {
    /// 下一个待下载 seq（CAS 游标）
    next: AtomicU64,
    /// 本 worker 负责终点（不含；被窃取后前移）
    stop_at: AtomicU64,
}

impl Claim {
    fn new(next: u64, stop_at: u64) -> Arc<Self> {
        Arc::new(Self {
            next: AtomicU64::new(next),
            stop_at: AtomicU64::new(stop_at),
        })
    }

    /// 取下一个待下载 seq；块耗尽返回 None
    fn take_next(&self) -> Option<u64> {
        loop {
            let n = self.next.load(Ordering::Relaxed);
            if n >= self.stop_at.load(Ordering::Relaxed) {
                return None;
            }
            if self
                .next
                .compare_exchange(n, n + 1, Ordering::Relaxed, Ordering::Relaxed)
                .is_ok()
            {
                return Some(n);
            }
        }
    }

    /// 剩余未取件片数
    fn remaining(&self) -> u64 {
        self.stop_at
            .load(Ordering::Relaxed)
            .saturating_sub(self.next.load(Ordering::Relaxed))
    }
}

/// todo 集合在调度窗口内的最大连续 run（返回 [a, b) 半开区间）；
/// IDM 认领源：无可认领返回 None。
fn largest_window_run(
    todo: &BTreeSet<u64>,
    anchor: Option<u64>,
    mode: CacheMode,
    live: bool,
) -> Option<(u64, u64)> {
    fn max_run(a: Option<(u64, u64)>, b: Option<(u64, u64)>) -> Option<(u64, u64)> {
        match (a, b) {
            (None, r) => r,
            (l, None) => l,
            (Some(x), Some(y)) => Some(if x.1 >= y.1 { x } else { y }),
        }
    }
    let mut best: Option<(u64, u64)> = None; // (start, len)
    let mut run: Option<(u64, u64)> = None;
    for &s in todo {
        if !in_schedule_window(s, anchor, mode, live) {
            continue;
        }
        match run {
            Some((a, len)) if a + len == s => run = Some((a, len + 1)),
            other => {
                best = max_run(best, other);
                run = Some((s, 1));
            }
        }
    }
    max_run(best, run).map(|(a, len)| (a, a + len))
}

/// IDM 空闲窃取：把剩余量最大的在途块的剩余段对半分，返回接管后半段的
/// 新认领块（原块 stop_at 前移至切分点）。剩余 < min_rem 不切分。
fn try_steal_claim(claims: &[Arc<Claim>], min_rem: u64) -> Option<Arc<Claim>> {
    let mut best: Option<(u64, usize)> = None; // (remaining, idx)
    for (i, c) in claims.iter().enumerate() {
        let rem = c.remaining();
        if rem >= min_rem && best.map_or(true, |(r, _)| rem > r) {
            best = Some((rem, i));
        }
    }
    let (_, i) = best?;
    let c = &claims[i];
    let mid = c.next.load(Ordering::Relaxed) + c.remaining() / 2;
    let stop = c.stop_at.swap(mid, Ordering::Relaxed);
    Some(Claim::new(mid, stop))
}

// ---------- P6 站点提取兜底（DESIGN §4.1） ----------

/// yt-dlp 外挂查找：pf-core.exe 同目录（安装包随附 / 手动放置）→ PATH
fn find_ytdlp() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("yt-dlp.exe");
            if p.is_file() {
                return Some(p);
            }
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let p = dir.join("yt-dlp.exe");
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// yt-dlp 直链提取：`yt-dlp -g --no-playlist URL` → stdout URL 行（90s 超时）
async fn ytdlp_extract(ytdlp: &Path, url: &str) -> Result<Vec<String>, String> {
    let out = tokio::time::timeout(
        Duration::from_secs(90),
        tokio::process::Command::new(ytdlp)
            .args(["-g", "--no-playlist", url])
            .output(),
    )
    .await
    .map_err(|_| "yt-dlp 提取超时（90s）".to_string())?
    .map_err(|e| format!("运行 yt-dlp 失败: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail: String = stderr.lines().rev().take(3).collect::<Vec<_>>().join(" | ");
        return Err(format!("yt-dlp 退出码 {:?}: {}", out.status.code(), tail));
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with("http"))
        .map(String::from)
        .collect())
}

impl TaskManager {
    // ---------- series 队列 RPC 入口（P3，store 透传） ----------

    pub fn upsert_series(&self, id: &str) -> Result<(), String> {
        self.store.upsert_series(id, None)
    }

    pub fn attach_series(&self, task_id: &str, series_id: &str, episode_index: i64) -> Result<(), String> {
        self.store.attach_task_series(task_id, series_id, episode_index)
    }

    // ---------- P46 剧集预缓存（窗口化） ----------

    /// 当前预缓存策略（settings 覆盖默认：后续 3 集）
    pub fn prefetch_config(&self) -> PrefetchConfig {
        let mode = self
            .store
            .setting_get("series.prefetch_mode")
            .and_then(|v| series::PrefetchMode::from_str(&v))
            .unwrap_or(series::PrefetchMode::Ahead);
        let count = self
            .store
            .setting_get("series.prefetch_count")
            .and_then(|v| v.parse::<u32>().ok())
            .map(|v| v.clamp(1, series::PREFETCH_COUNT_MAX))
            .unwrap_or(series::PREFETCH_COUNT_DEFAULT);
        PrefetchConfig { mode, count }
    }

    /// 更新预缓存策略（只写传入字段）；立即对下一次 tick 生效，无需重启
    pub fn set_prefetch_config(
        &self,
        mode: Option<&str>,
        count: Option<u32>,
    ) -> Result<PrefetchConfig, String> {
        if let Some(m) = mode {
            let parsed = series::PrefetchMode::from_str(m)
                .ok_or("mode 必须是 off | ahead | all")?;
            self.store.setting_set("series.prefetch_mode", parsed.as_str())?;
        }
        if let Some(c) = count {
            if c == 0 || c > series::PREFETCH_COUNT_MAX {
                return Err(format!("count 需在 1..={}", series::PREFETCH_COUNT_MAX));
            }
            self.store.setting_set("series.prefetch_count", &c.to_string())?;
        }
        Ok(self.prefetch_config())
    }

    /// 起播时同步整组剧集 + 挂接当前集，并立刻 kick 一轮窗口调度。
    ///
    /// 触发时机由前端决定：起播成功（任务已建、播放器已起）后调用一次；
    /// 换集/换线路会再次调用（集序与 URL 一起刷新）。
    pub async fn series_attach(
        self: &Arc<Self>,
        series_id: &str,
        title: Option<&str>,
        task_id: Option<&str>,
        current: i64,
        episodes: &[(i64, Option<String>, String)],
    ) -> Result<PrefetchStatus, String> {
        if series_id.trim().is_empty() {
            return Err("seriesId 不能为空".into());
        }
        self.store.upsert_series(series_id, title)?;
        if !episodes.is_empty() {
            self.store.series_upsert_episodes(series_id, episodes)?;
        }
        if let Some(tid) = task_id {
            self.store.attach_task_series(tid, series_id, current)?;
        }
        // 立即调度一次（不等 5s 轮询）；探测/下载在后台跑，不阻塞 RPC
        let this = self.clone();
        let sid = series_id.to_string();
        tokio::spawn(async move { this.dispatch_window(&sid, current).await });
        Ok(self.prefetch_status(series_id, current).await)
    }

    /// 预缓存窗口状态（UI / 探针用）
    pub async fn prefetch_status(&self, series_id: &str, current: i64) -> PrefetchStatus {
        let cfg = self.prefetch_config();
        let eps = self.store.series_episode_list(series_id);
        let avail: Vec<i64> = eps.iter().map(|e| e.idx).collect();
        let window = series::pick_window(cfg.mode, cfg.count, current, &avail);
        let remaining = avail.iter().filter(|i| **i > current).count();
        let truncated = cfg.mode == series::PrefetchMode::Ahead
            && remaining > 0
            && remaining < cfg.count as usize;
        let mut items = Vec::with_capacity(window.len());
        for idx in &window {
            let Some(ep) = eps.iter().find(|e| e.idx == *idx) else { continue };
            let tid = self.store.find_task_id_by_url(&ep.url).ok().flatten();
            let state = match &tid {
                Some(t) => self.episode_state(t).await,
                None => {
                    if ep.attempts >= PREFETCH_MAX_ATTEMPTS {
                        "failed"
                    } else {
                        "queued"
                    }
                }
            };
            items.push(PrefetchItem {
                index: *idx,
                name: ep.name.clone(),
                task_id: tid,
                state,
                attempts: ep.attempts,
                error: ep.last_error.clone(),
            });
        }
        PrefetchStatus {
            series_id: series_id.to_string(),
            mode: cfg.mode.as_str(),
            count: cfg.count,
            current,
            total: eps.len(),
            remaining,
            truncated,
            items,
        }
    }

    /// 按 taskId 查窗口状态（播放页侧栏只需要当前任务）
    pub async fn series_status_of_task(&self, task_id: &str) -> Result<PrefetchStatus, String> {
        let (sid, idx) = self
            .store
            .series_episode_of(task_id)
            .ok_or("该任务没有挂接剧集（不是从剧集列表起播的）")?;
        Ok(self.prefetch_status(&sid, idx).await)
    }

    /// 单集状态：caching 表示「正在解析或下载」，队列据此串行推进
    async fn episode_state(&self, task_id: &str) -> &'static str {
        if self.job_running(task_id).await {
            return "caching";
        }
        let status = self.tasks.lock().await.get(task_id).map(|t| t.status);
        match status {
            Some(TaskStatus::Ready) => "ready",
            Some(TaskStatus::Paused) => "paused",
            Some(TaskStatus::Failed) => "failed",
            Some(TaskStatus::Downloading) | Some(TaskStatus::Probing) => "caching",
            Some(TaskStatus::Pending) => "queued",
            None => match self.store.task_brief(task_id).map(|b| b.status) {
                Some(s) if s == "paused" => "paused",
                Some(s) if s == "failed" => "failed",
                Some(s) if s == "ready" => "ready",
                Some(s) if s == "downloading" || s == "probing" => "caching",
                _ => "queued",
            },
        }
    }

    /// 窗口调度：只推进「窗口内最早一个未完成」的集（并发 1）。
    ///
    /// 串行而不是一次拉起 N 集，是因为下载 job 与播放共用同一条出网带宽：
    /// 并发预取会把正在播的那一集拖成卡顿，而这恰恰是本功能最该避免的事。
    async fn dispatch_window(self: &Arc<Self>, series_id: &str, current: i64) {
        let cfg = self.prefetch_config();
        if cfg.mode == series::PrefetchMode::Off {
            return;
        }
        let eps = self.store.series_episode_list(series_id);
        if eps.is_empty() {
            return;
        }
        let avail: Vec<i64> = eps.iter().map(|e| e.idx).collect();
        let window = series::pick_window(cfg.mode, cfg.count, current, &avail);
        self.drop_out_of_window(&window, &eps).await;
        if window.is_empty() {
            return;
        }

        let now = now_ms() as i64;
        for idx in &window {
            let Some(ep) = eps.iter().find(|e| e.idx == *idx) else { continue };
            if let Ok(Some(tid)) = self.store.find_task_id_by_url(&ep.url) {
                match self.episode_state(&tid).await {
                    // 已好：清掉历史失败痕迹，继续看下一集
                    "ready" => {
                        self.store.series_episode_clear_error(series_id, ep.idx);
                        continue;
                    }
                    // 串行：这一集还在解析/下载，后面的排队等着
                    "caching" => return,
                    // 用户手动暂停的集不自动拉起（尊重明确意图）
                    "paused" => continue,
                    _ => {}
                }
                if self.prefetch_inflight.lock().await.contains(&tid) {
                    return;
                }
            }
            // 失败封顶/退避未到：跳过这一集，但允许后面的集继续推进，
            // 否则一部剧里有一集死链会堵死整个窗口
            if ep.attempts >= PREFETCH_MAX_ATTEMPTS || ep.next_try_at > now {
                continue;
            }
            self.start_prefetch(series_id.to_string(), ep.clone()).await;
            return;
        }
    }

    /// 窗口滑动后，已滑出窗口的在途预取一律停掉（别继续抢带宽）
    async fn drop_out_of_window(&self, window: &[i64], eps: &[SeriesEpisode]) {
        let keep: HashSet<String> = eps
            .iter()
            .filter(|e| window.contains(&e.idx))
            .filter_map(|e| self.store.find_task_id_by_url(&e.url).ok().flatten())
            .collect();
        let stale: Vec<String> = self
            .prefetch_inflight
            .lock()
            .await
            .iter()
            .filter(|t| !keep.contains(*t))
            .cloned()
            .collect();
        for tid in stale {
            self.stop_download_job(&tid).await;
            self.prefetch_inflight.lock().await.remove(&tid);
            self.log("info", format!("剧集预缓存：{tid} 已滑出窗口，停止预取"))
                .await;
        }
    }

    /// 起一集预缓存：建任务（不探测）→ 后台探测+下载 → 失败记退避
    async fn start_prefetch(self: &Arc<Self>, series_id: String, ep: SeriesEpisode) {
        let tid = match self.ensure_episode_task(&series_id, &ep).await {
            Ok(t) => t,
            Err(e) => {
                self.note_prefetch_error(&series_id, ep.idx, &ep.url, &e).await;
                return;
            }
        };
        self.prefetch_inflight.lock().await.insert(tid.clone());
        let this = self.clone();
        let sid = series_id.clone();
        let idx = ep.idx;
        let url = ep.url.clone();
        let label = ep
            .name
            .clone()
            .map(|n| format!(" · {n}"))
            .unwrap_or_default();
        tokio::spawn(async move {
            match this.activate_task(&tid).await {
                Ok(true) => {
                    this.store.series_episode_clear_error(&sid, idx);
                    this.log(
                        "info",
                        format!("剧集预缓存：开始缓存第 {} 集{label}（{tid}）", idx + 1),
                    )
                    .await;
                }
                Ok(false) => {}
                Err(e) => this.note_prefetch_error(&sid, idx, &url, &e).await,
            }
            this.prefetch_inflight.lock().await.remove(&tid);
        });
    }

    /// 建/复用一集的任务行。**不探测**：把探测留给后台 job，
    /// 否则 5s 的调度循环会被一次慢探测堵住（task.create 的同步探测是起播才需要的）。
    async fn ensure_episode_task(
        &self,
        series_id: &str,
        ep: &SeriesEpisode,
    ) -> Result<String, String> {
        if let Ok(Some(tid)) = self.store.find_task_id_by_url(&ep.url) {
            self.store.attach_task_series(&tid, series_id, ep.idx)?;
            // 库里有、内存没有（重启后未恢复 / 被清理过）：补建内存 Task，否则 activate_task 报不存在
            let known = self.tasks.lock().await.contains_key(&tid);
            if !known {
                if let Some(b) = self.store.task_brief(&tid) {
                    let proxy = self.proxy().ok_or("内核缺少 proxy 信息，无法建任务")?;
                    let status = match b.status.as_str() {
                        "paused" => TaskStatus::Paused,
                        "ready" => TaskStatus::Ready,
                        "downloading" => TaskStatus::Downloading,
                        "failed" => TaskStatus::Failed,
                        _ => TaskStatus::Pending,
                    };
                    let mode = CacheMode::from_str(&b.cache_mode).unwrap_or_default();
                    let proto = pf_parser::detect(&ep.url);
                    self.upsert_task_row(&tid, &ep.url, b.title, mode, &iso_now(), proto, status, &proxy)
                        .await?;
                }
            }
            return Ok(tid);
        }
        let proxy = self.proxy().ok_or("内核缺少 proxy 信息，无法建任务")?;
        let id = format!(
            "task-{}-{}",
            now_ms(),
            self.seq.fetch_add(1, Ordering::Relaxed)
        );
        let proto = pf_parser::detect(&ep.url);
        // 预缓存任务固定按 precache 建（否则「预缓存」与 online/stream 语义冲突）；
        // 用户之后亲自播放这一集时，仍按他自己的默认档覆盖（P29 规则不变）
        self.upsert_task_row(
            &id,
            &ep.url,
            ep.name.clone(),
            CacheMode::Precache,
            &iso_now(),
            proto,
            TaskStatus::Pending,
            &proxy,
        )
        .await?;
        self.store.attach_task_series(&id, series_id, ep.idx)?;
        Ok(id)
    }

    /// 记一次预缓存失败并写入指数退避（60s / 5min / 15min，第 3 次后不再自动重试）。
    ///
    /// 同时把任务状态对齐成「看得见的真相」：
    /// 可重试 → `pending`（任务页显示准备中，下一拍会再来）；达上限 → `failed`。
    /// 不这么做的话，探测失败只留在 `probe_errors` 里，任务行永远停在 pending，
    /// 侧栏会一直显示「排队中」而窗口其实已经放弃。
    async fn note_prefetch_error(&self, series_id: &str, idx: i64, url: &str, err: &str) {
        let attempts = self
            .store
            .series_episode_list(series_id)
            .iter()
            .find(|e| e.idx == idx)
            .map(|e| e.attempts)
            .unwrap_or(0)
            + 1;
        let secs = PREFETCH_BACKOFF_SECS[(attempts as usize - 1).min(PREFETCH_BACKOFF_SECS.len() - 1)];
        let _ = self
            .store
            .series_episode_error(series_id, idx, err, now_ms() as i64 + secs * 1000);
        let exhausted = attempts >= PREFETCH_MAX_ATTEMPTS;
        if let Ok(Some(tid)) = self.store.find_task_id_by_url(url) {
            let next = if exhausted {
                TaskStatus::Failed
            } else {
                TaskStatus::Pending
            };
            let _ = self.store.set_task_status(&tid, next.as_str());
            if let Some(t) = self.tasks.lock().await.get_mut(&tid) {
                t.status = next;
            }
            self.emit(&tid, next, None).await;
        }
        let tail = if exhausted {
            "，已达上限，不再自动重试"
        } else {
            ""
        };
        self.log(
            "warn",
            format!(
                "剧集预缓存：第 {} 集失败（{attempts}/{PREFETCH_MAX_ATTEMPTS}）：{err}{tail}",
                idx + 1
            ),
        )
        .await;
    }

    // ---------- 缓存策略（P3 设置页可配） ----------

    /// 当前清理策略（settings 表覆盖默认常量）
    pub fn cache_policy(&self) -> CachePolicy {
        let g = |k: &str| self.store.setting_get(k);
        CachePolicy {
            retain_days: g("cache.retain_days")
                .and_then(|v| v.parse().ok())
                .unwrap_or(RETAIN_DAYS_DEFAULT),
            unfinished_days: g("cache.unfinished_days")
                .and_then(|v| v.parse().ok())
                .unwrap_or(UNFINISHED_TTL_DAYS),
            capacity_gb: g("cache.capacity_gb")
                .and_then(|v| v.parse::<f64>().ok())
                .unwrap_or(CAPACITY_BYTES_DEFAULT as f64 / 1073741824.0),
        }
    }

    /// 更新清理策略（仅写入提供的字段；下一次清理循环/收尾记账生效）
    pub fn set_cache_policy(
        &self,
        retain_days: Option<f64>,
        unfinished_days: Option<f64>,
        capacity_gb: Option<f64>,
    ) -> Result<CachePolicy, String> {
        if let Some(v) = retain_days {
            self.store.setting_set("cache.retain_days", &format!("{v}"))?;
        }
        if let Some(v) = unfinished_days {
            self.store.setting_set("cache.unfinished_days", &format!("{v}"))?;
        }
        if let Some(v) = capacity_gb {
            self.store.setting_set("cache.capacity_gb", &format!("{v}"))?;
        }
        Ok(self.cache_policy())
    }

    /// 手动清理任务缓存（缓存管理页）：停在途 job → 删分片文件+索引，返回释放字节
    pub async fn purge_task(&self, task_id: &str) -> Result<u64, String> {
        let one = task_id.to_string();
        let (purged, freed, failed) = self.purge_tasks(std::slice::from_ref(&one)).await;
        if purged == 0 {
            return Err(failed
                .into_iter()
                .next()
                .map(|(_, e)| e)
                .unwrap_or_else(|| "任务不存在".into()));
        }
        Ok(freed)
    }

    pub fn new(store: CacheStore) -> Self {
        let client = reqwest::Client::builder()
            // 浏览器 UA：部分片源 CDN（如非凡 ffzy）WAF 会拦非浏览器 UA，
            // 与 pf-parser::fetch_text 重试伪装口径一致。
            .user_agent(pf_parser::BROWSER_UA)
            // 强制 HTTP/1.1：部分 CDN 的 h2 连接在多路复用大响应时会停摆（playlist 正常、
            // 分片挂死）。aria2/N_m3u8DL-RE 亦默认 1.1。
            .http1_only()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        let (events, _) = broadcast::channel(256);
        Self {
            store,
            tasks: TokioMutex::new(BTreeMap::new()),
            media: TokioMutex::new(BTreeMap::new()),
            healths: TokioMutex::new(BTreeMap::new()),
            playheads: TokioMutex::new(BTreeMap::new()),
            keys_cache: TokioMutex::new(HashMap::new()),
            pstats: Mutex::new(HashMap::new()),
            probing: TokioMutex::new(HashSet::new()),
            probe_errors: TokioMutex::new(HashMap::new()),
            job_stops: TokioMutex::new(HashMap::new()),
            last_touch: Mutex::new(HashMap::new()),
            events,
            seq: AtomicU64::new(0),
            client,
            max_concurrency: 4,
            links: pf_netdisk::LinkCache::new(),
            prefetch_inflight: TokioMutex::new(HashSet::new()),
            proxy_slot: Mutex::new(None),
        }
    }

    /// P46：启动时注入代理信息（预缓存循环建任务要用它拼 playUrl）
    pub fn set_proxy(&self, proxy: ProxyInfo) {
        *self.proxy_slot.lock().unwrap_or_else(|p| p.into_inner()) = Some(proxy);
    }

    fn proxy(&self) -> Option<ProxyInfo> {
        self.proxy_slot.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// P9b 网盘服务（账号/分享/目录/直链）——借用式门面，不复制状态
    pub fn netdisk(&self) -> NetdiskService<'_> {
        NetdiskService { store: &self.store, links: &self.links }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<EngineEvent> {
        self.events.subscribe()
    }

    pub fn store(&self) -> &CacheStore {
        &self.store
    }

    /// 共享 HTTP 客户端（pf-proxy 复用，带连接池）
    pub fn http(&self) -> &reqwest::Client {
        &self.client
    }

    async fn emit(&self, task_id: &str, status: TaskStatus, speed_bps: Option<u64>) {
        let mut tasks = self.tasks.lock().await;
        let Some(t) = tasks.get_mut(task_id) else { return };
        t.status = status;
        let (d, tot, b) = self.store.progress(task_id);
        t.seg_done = Some(d);
        t.seg_total = Some(tot);
        t.bytes_done = Some(b);
        t.speed_bps = speed_bps;
        t.playhead_seq = self.playheads.lock().await.get(task_id).copied();
        t.retain_until = self
            .store
            .retain_until_of(task_id)
            .map(iso_from_ms);
        let snap = t.clone();
        drop(tasks);
        let _ = self.events.send(EngineEvent::TaskUpdated { task: snap });
    }

    async fn log(&self, level: &str, message: impl Into<String>) {
        let _ = self.events.send(EngineEvent::Log {
            level: level.to_string(),
            message: message.into(),
        });
    }

    /// 公共事件广播（pf-core 的 mpv 状态泵等外部模块推送用）
    pub fn broadcast_event(&self, ev: EngineEvent) {
        let _ = self.events.send(ev);
    }

    /// 创建任务：协议探测 → 解析（主源 + 镜像）→ 入库 → 水位驱动下载。
    /// `extra_sources`：镜像 URL 列表（对齐校验通过才纳入源池）。
    /// `cache_mode`：缓存三档（online/stream/precache，DESIGN §4.6）。
    /// 同 URL 复用既有任务 id（断点续传：已完成分片直接跳过）。
    /// 落一行任务：DB + 内存 + 事件，**不探测**。
    ///
    /// create_task 与 P46 预缓存共用：前者随后同步探测（起播要立刻拿到 playUrl），
    /// 后者把探测交给后台下载 job，避免 5s 调度循环被一次慢探测堵住。
    #[allow(clippy::too_many_arguments)]
    async fn upsert_task_row(
        &self,
        id: &str,
        url: &str,
        title: Option<String>,
        cache_mode: CacheMode,
        created_at: &str,
        proto: pf_parser::Protocol,
        status: TaskStatus,
        proxy: &ProxyInfo,
    ) -> Result<Task, String> {
        let play_url = if proto == pf_parser::Protocol::Mp4 {
            build_file_url(proxy, id)
        } else {
            build_play_url(proxy, id)
        };
        let master_url = (proto == pf_parser::Protocol::Hls).then(|| build_master_url(proxy, id));
        let task = Task {
            id: id.to_string(),
            url: url.to_string(),
            protocol: proto,
            title,
            status,
            created_at: created_at.to_string(),
            play_url: Some(play_url),
            master_url,
            cache_mode,
            retain_until: None,
            seg_done: None,
            seg_total: None,
            bytes_done: None,
            speed_bps: None,
            playhead_seq: None,
        };
        self.store.upsert_task(
            &task.id,
            &task.url,
            task.title.as_deref(),
            protocol_str(task.protocol),
            task.status.as_str(),
            false,
            None,
            task.cache_mode.as_str(),
            &task.created_at,
        )?;
        self.tasks.lock().await.insert(id.to_string(), task.clone());
        let _ = self.events.send(EngineEvent::TaskUpdated { task: task.clone() });
        Ok(task)
    }

    pub async fn create_task(
        self: &Arc<Self>,
        url: &str,
        title: Option<String>,
        extra_sources: Vec<String>,
        cache_mode: CacheMode,
        proxy: &ProxyInfo,
    ) -> Result<Task, String> {
        if url.trim().is_empty() {
            return Err("url is empty".into());
        }
        let url = url.trim();
        // 保序去重：url 在前（主源）
        let mut urls: Vec<String> = Vec::new();
        for u in std::iter::once(url.to_string()).chain(extra_sources) {
            let u = u.trim().to_string();
            if !u.is_empty() && !urls.contains(&u) {
                urls.push(u);
            }
        }
        // 同 URL 复用（续播）
        let existing = self.store.find_task_id_by_url(url)?;
        let (id, created_at) = match &existing {
            Some(id) => {
                let created_at = {
                    let tasks = self.tasks.lock().await;
                    tasks
                        .get(id)
                        .map(|t| t.created_at.clone())
                        .unwrap_or_else(iso_now)
                };
                (id.clone(), created_at)
            }
            None => (
                format!("task-{}-{}", now_ms(), self.seq.fetch_add(1, Ordering::Relaxed)),
                iso_now(),
            ),
        };
        let proto = pf_parser::detect(url);
        // P29：复用任务的缓存档怎么定——
        //  · 用户在任务页显式切过（cache_mode_explicit=1）→ 尊重用户，本次请求的档位不生效；
        //  · 否则以本次请求为准（前端传的是「播放默认档」，缺省 precache），并随 upsert 写回库。
        // 早前这里只在内存换了新 Task、DB 的 cache_mode 一动不动，重启后档位会静默回退，
        // 表现为「设置里写了预缓存，重开还是边下边播」。
        let cache_mode = match &existing {
            Some(id) => match self.store.task_cache_mode_meta(id) {
                Ok(Some((mode, true))) => CacheMode::from_str(&mode).unwrap_or(cache_mode),
                _ => cache_mode,
            },
            None => cache_mode,
        };
        // F4：create_task 整体 deadline。probe_and_start 里 extract_fallback 的
        // 页面扫描 + yt-dlp 最坏可超 Electron 侧 task.create 的 75s 超时线
        // （SLOW_RPC_TIMEOUT），届时真实原因被掐成「RPC 超时」。这里 70s
        // （严格 < 75s）主动收口：标 Failed 并返回可读错误。
        let inner_id = id.clone();
        let task_fut = async move {
            let _task = self
                .upsert_task_row(
                    &inner_id,
                    url,
                    title,
                    cache_mode,
                    &created_at,
                    proto,
                    TaskStatus::Probing,
                    proxy,
                )
                .await?;
            if existing.is_some() {
                self.log("info", format!("任务复用既有缓存，续传中：{inner_id}"))
                    .await;
            }

            if let Err(e) = self.probe_and_start(inner_id.clone(), urls).await {
                // 标记失败：任务列表不再停留在 probing，重启恢复也不会误续传
                let _ = self.store.set_task_status(&inner_id, TaskStatus::Failed.as_str());
                if let Some(t) = self.tasks.lock().await.get_mut(&inner_id) {
                    t.status = TaskStatus::Failed;
                }
                self.probe_errors.lock().await.remove(&inner_id);
                self.log("error", format!("任务创建失败：{inner_id} ({e})")).await;
                return Err(e);
            }
            // 等 playlist 就绪再返回（若探测被去重，等待在途解析完成），
            // 保证 RPC 返回的 playUrl 立即可播。去重期间在途解析若失败，
            // 凭 probe_errors 立即返回真实错误，而非空转到超时。
            // deadline 覆盖 fetch_text 最坏重试链（3×10s + 退避 ≈ 32s）。
            let deadline = Instant::now() + Duration::from_secs(35);
            loop {
                if self.media.lock().await.contains_key(&inner_id) {
                    self.probe_errors.lock().await.remove(&inner_id);
                    break;
                }
                if let Some(e) = self.probe_errors.lock().await.remove(&inner_id) {
                    let _ = self.store.set_task_status(&inner_id, TaskStatus::Failed.as_str());
                    if let Some(t) = self.tasks.lock().await.get_mut(&inner_id) {
                        t.status = TaskStatus::Failed;
                    }
                    self.log("error", format!("任务创建失败（在途解析）：{inner_id} ({e})")).await;
                    return Err(e);
                }
                if Instant::now() > deadline {
                    return Err("等待 playlist 就绪超时（源站无响应或过慢）".into());
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            self.tasks
                .lock()
                .await
                .get(&inner_id)
                .cloned()
                .ok_or_else(|| "任务不存在".to_string())
        };
        match tokio::time::timeout(Duration::from_secs(70), task_fut).await {
            Ok(r) => r,
            Err(_) => {
                // 标记失败：任务列表不再停留在 probing，重启恢复也不会误续传
                let _ = self.store.set_task_status(&id, TaskStatus::Failed.as_str());
                if let Some(t) = self.tasks.lock().await.get_mut(&id) {
                    t.status = TaskStatus::Failed;
                }
                self.probe_errors.lock().await.remove(&id);
                self.log("error", format!("任务创建失败（探测超时）：{id}")).await;
                Err("源站无响应（探测超时）".into())
            }
        }
    }

    /// 任务快照列表（进度字段从 segments 表实时聚合）
    pub async fn list_tasks(&self) -> Vec<Task> {
        let mut tasks = self.tasks.lock().await;
        let playheads = self.playheads.lock().await;
        for t in tasks.values_mut() {
            let (d, tot, b) = self.store.progress(&t.id);
            t.seg_done = Some(d);
            t.seg_total = Some(tot);
            t.bytes_done = Some(b);
            t.playhead_seq = playheads.get(&t.id).copied();
            t.retain_until = self.store.retain_until_of(&t.id).map(iso_from_ms);
        }
        tasks.values().cloned().collect()
    }

    /// 启动恢复（P5 起全量恢复）：扫描 DB 全部任务行——
    /// 未完结（pending/probing/downloading）重新解析续传；paused 保持暂停；
    /// ready（已完结）仅重建内存任务表供媒体库/复播，不起 job。
    pub async fn restore_from_db(self: Arc<Self>, proxy: ProxyInfo) {
        // P46：预缓存是定时循环驱动的，proxy 在这里注入一次供后续建任务用
        self.set_proxy(proxy.clone());
        let rows = self.store.all_tasks();
        for (id, url, mode, status, title) in rows {
            let proto = pf_parser::detect(&url);
            let play_url = if proto == pf_parser::Protocol::Mp4 {
                build_file_url(&proxy, &id)
            } else {
                build_play_url(&proxy, &id)
            };
            let st = match status.as_str() {
                "ready" => TaskStatus::Ready,
                "paused" => TaskStatus::Paused,
                _ => TaskStatus::Probing,
            };
            let task = Task {
                id: id.clone(),
                url: url.clone(),
                protocol: proto,
                title,
                status: st,
                created_at: iso_now(),
                play_url: Some(play_url),
                master_url: (proto == pf_parser::Protocol::Hls)
                    .then(|| build_master_url(&proxy, &id)),
                cache_mode: CacheMode::from_str(&mode).unwrap_or_default(),
                retain_until: None,
                seg_done: None,
                seg_total: None,
                bytes_done: None,
                speed_bps: None,
                playhead_seq: None,
            };
            // 保持 DB 中原 created_at：upsert 不覆盖该列
            self.tasks.lock().await.insert(id.clone(), task);
            let resume = matches!(status.as_str(), "pending" | "probing" | "downloading");
            self.log("info", format!("恢复任务：{id}（{status}）")).await;
            if resume {
                let this = self.clone();
                tokio::spawn(async move {
                    let mirrors = this.store.sources_of(&id);
                    if let Err(e) =
                        this.probe_and_start(id, std::iter::once(url).chain(mirrors).collect()).await
                    {
                        this.log("warn", format!("任务恢复失败：{e}")).await;
                    }
                });
            }
        }
    }

    /// P6 站点提取兜底（DESIGN §4.1）：非媒体 URL 或解析失败时的两级提取——
    /// ① 抓取页面 HTML，扫描内嵌 m3u8/mpd/mp4 候选流，逐个尝试（上限 5 个）；
    /// ② 无候选时若检出 yt-dlp.exe（pf-core 同目录或 PATH）则调用其提取直链。
    async fn extract_fallback(&self, url: &str) -> Result<MediaIR, String> {
        self.log("info", format!("非直链媒体 URL，尝试站点提取：{url}")).await;
        match pf_parser::extract_from_page(&self.client, url).await {
            Ok(cands) if !cands.is_empty() => {
                self.log(
                    "info",
                    format!("页面扫描发现 {} 个候选流：{}", cands.len(), cands.join(" , ")),
                )
                .await;
                let mut last = String::from("无候选");
                for c in cands.iter().take(5) {
                    match pf_parser::load(&self.client, c).await {
                        Ok(ir) => {
                            self.log("info", format!("站点提取成功：{c}")).await;
                            return Ok(ir);
                        }
                        Err(e) => last = format!("{c}: {e}"),
                    }
                }
                return Err(format!("候选流解析均失败（最后一个：{last}）"));
            }
            Ok(_) => self.log("warn", "页面扫描未发现内嵌媒体流").await,
            Err(e) => self.log("warn", format!("页面抓取失败：{e}")).await,
        }
        let Some(yt) = find_ytdlp() else {
            return Err(
                "页面未发现 m3u8/mpd/mp4 流。将 yt-dlp.exe 放入应用目录或 PATH 可解锁站点提取"
                    .into(),
            );
        };
        self.log("info", format!("调用 yt-dlp 提取直链：{}", yt.display())).await;
        let links = ytdlp_extract(&yt, url).await?;
        if links.is_empty() {
            return Err("yt-dlp 未返回可用直链".into());
        }
        self.log("info", format!("yt-dlp 提取到 {} 条直链，尝试解析", links.len())).await;
        pf_parser::load(&self.client, &links[0])
            .await
            .map_err(|e| format!("yt-dlp 直链解析失败: {e}"))
    }

    /// 解析 playlist → 登记分片 → 启动下载循环（create 与 resume 共用）
    async fn probe_and_start(self: &Arc<Self>, id: String, urls: Vec<String>) -> Result<(), String> {
        // 在途去重：启动恢复与 task.create 并发进入时只解析一次
        {
            let mut probing = self.probing.lock().await;
            if probing.contains(&id) {
                return Ok(());
            }
            probing.insert(id.clone());
        }
        let r = self.probe_and_start_inner(id.clone(), urls).await;
        self.probing.lock().await.remove(&id);
        if let Err(e) = &r {
            // 留痕供等待方（去重复用的 create_task）立即取到真实失败原因
            self.probe_errors.lock().await.insert(id, e.clone());
        }
        r
    }

    async fn probe_and_start_inner(self: &Arc<Self>, id: String, urls: Vec<String>) -> Result<(), String> {
        let (url, mirrors) = urls.split_first().ok_or("源列表为空")?;
        let mp4 = pf_parser::detect(url) == pf_parser::Protocol::Mp4;

        // 主源：MP4 走 Range 探测（206 能力 + 总长 + 首块 hash）；HLS 走 playlist 解析。
        // 主源失败直接报错；镜像并发解析，失败/不对齐剔除。
        // P6：HLS 主源解析失败时走站点提取兜底（页面扫描 → yt-dlp）。
        let (primary, primary_probe) = if mp4 {
            let p = pf_parser::probe_mp4(&self.client, url).await?;
            let ir = pf_parser::build_mp4_ir(url, p.content_length, pf_parser::MP4_CHUNK);
            if ir.tracks.first().map(|t| t.segments.is_empty()).unwrap_or(true) {
                return Err("MP4 文件为空（Content-Length=0）".into());
            }
            (ir, Some(p))
        } else {
            match pf_parser::load(&self.client, url).await {
                Ok(ir) => (ir, None),
                Err(e) => {
                    // 直链媒体（.m3u8/.mpd/.mp4）解析失败 = 源站直接拒绝或文件已不在，
                    // 再去扫页面只会白等 10-40s，并把错误替换成误导性的「页面未发现 m3u8」。
                    // 这里直接返回带处置建议的原始错误。
                    if pf_parser::looks_like_media_url(url) {
                        return Err(media_error_hint(&e));
                    }
                    match self.extract_fallback(url).await {
                        Ok(ir) => (ir, None),
                        Err(e2) => return Err(format!("{e}；{e2}")),
                    }
                }
            }
        };

        let mut ok_mirrors: Vec<MediaIR> = Vec::new();
        let mut ok_urls: Vec<String> = Vec::new();
        if mp4 {
            // MP4 镜像预检：Content-Length 一致 + 首 16KB hash 一致（DESIGN §5 禁止跨源混拼）
            let mut futs = Vec::new();
            for m in mirrors {
                let client = self.client.clone();
                let m = m.clone();
                futs.push(tokio::spawn(async move { (m.clone(), pf_parser::probe_mp4(&client, &m).await) }));
            }
            for f in futs {
                let (murl, res) = f.await.unwrap_or((String::new(), Err("join 失败".into())));
                match res {
                    Ok(p) if Some(&p) == primary_probe.as_ref() => {
                        ok_mirrors
                            .push(pf_parser::build_mp4_ir(&murl, p.content_length, pf_parser::MP4_CHUNK));
                        ok_urls.push(murl);
                    }
                    Ok(p) => {
                        self.log(
                            "warn",
                            format!(
                                "MP4 镜像剔除（字节不一致，禁止跨源混拼）：{murl}（len {}≠{} / sha {}≠{}）",
                                p.content_length,
                                primary_probe.as_ref().map(|x| x.content_length).unwrap_or(0),
                                p.first_sha,
                                primary_probe.as_ref().map(|x| x.first_sha.clone()).unwrap_or_default()
                            ),
                        )
                        .await;
                    }
                    Err(e) => {
                        self.log("warn", format!("镜像探测失败，剔除：{murl} ({e})")).await;
                    }
                }
            }
        } else {
            let mut futs = Vec::new();
            for m in mirrors {
                let client = self.client.clone();
                let m = m.clone();
                futs.push(tokio::spawn(async move { (m.clone(), pf_parser::load(&client, &m).await) }));
            }
            for f in futs {
                let (murl, res) = f.await.unwrap_or((String::new(), Err("join 失败".into())));
                match res {
                    Ok(ir) if aligns(&primary, &ir) => {
                        ok_mirrors.push(ir);
                        ok_urls.push(murl);
                    }
                    Ok(_) => {
                        self.log(
                            "warn",
                            format!("镜像剔除（分片/时长不对齐，禁止跨源混拼）：{murl}"),
                        )
                        .await;
                    }
                    Err(e) => {
                        self.log("warn", format!("镜像解析失败，剔除：{murl} ({e})")).await;
                    }
                }
            }
        }

        // 健康度注册：index 0 = 主源
        let hs: Vec<health::SourceHealth> = std::iter::once(health::SourceHealth::new(0, url.as_str()))
            .chain(
                ok_urls
                    .iter()
                    .enumerate()
                    .map(|(i, u)| health::SourceHealth::new(i + 1, u.as_str())),
            )
            .collect();
        self.healths.lock().await.insert(id.clone(), hs);
        self.media.lock().await.insert(
            id.clone(),
            SourceSet {
                primary: primary.clone(),
                mirrors: ok_mirrors,
            },
        );
        let cache_mode = self
            .tasks
            .lock()
            .await
            .get(&id)
            .map(|t| t.cache_mode)
            .unwrap_or_default();
        // P5：title 透传（restore 重建的内存任务带库中原标题，避免 upsert 置空）
        let title = self.tasks.lock().await.get(&id).and_then(|t| t.title.clone());
        self.store.set_sources(&id, &ok_urls)?;
        self.store
            .upsert_task(
                &id,
                url,
                title.as_deref(),
                protocol_str(pf_parser::detect(url)),
                TaskStatus::Downloading.as_str(),
                primary.live,
                primary.total_duration,
                cache_mode.as_str(),
                &iso_now(),
            )
            .ok();
        let seg_count = primary.tracks.first().map(|t| t.segments.len()).unwrap_or(0);
        self.log(
            "info",
            format!(
                "解析完成：{} 分片 / {:.1}s / live={} / 源 {}+{} 镜像 / 模式 {}",
                seg_count,
                primary.total_duration.unwrap_or(0.0),
                primary.live,
                1,
                ok_urls.len(),
                cache_mode.as_str()
            ),
        )
        .await;

        // P2.5 online：不登记分片、不启动预取；proxy 请求时纯实时回源。
        // 任务行按播完 TTL 保留（默认 1 天后随清理器回收元数据）。
        if cache_mode == CacheMode::Online {
            let now = now_ms() as i64;
            let retain = retain_ms(self.cache_policy().retain_days).map(|ms| now + ms);
            self.store.set_task_status(&id, TaskStatus::Ready.as_str());
            self.store.mark_finished(&id, now, retain);
            self.emit(&id, TaskStatus::Ready, None).await;
            return Ok(());
        }

        if let Some(track) = primary.tracks.first() {
            self.store.upsert_segments(&id, &track.segments)?;
        }
        // P5：用户在探测期间已暂停——分片登记照常，但不启动下载（重启恢复同此语义）
        let paused = self
            .tasks
            .lock()
            .await
            .get(&id)
            .map(|t| t.status == TaskStatus::Paused)
            .unwrap_or(false);
        if paused {
            self.store.set_task_status(&id, TaskStatus::Paused.as_str());
            self.emit(&id, TaskStatus::Paused, None).await;
            return Ok(());
        }
        self.emit(&id, TaskStatus::Downloading, None).await;
        self.spawn_download_job(id).await;
        Ok(())
    }

    /// 下载循环（P2 水位驱动）：worker 池每轮按播放头优先级取分片，
    /// 播放头由 proxy /seg 请求实时更新，seek 即时重排，无需重启任务。
    /// P2.5：stream 只调度播放头窗口（前向 ≤14 片 + 回看 ≤7 片，无锚点按 0 起
    /// 跑起播缓冲），窗口外不预取；precache 全量低优预取（priority 分级天然让路）。
    /// P6：MP4 任务走 IDM 动态分段（对半分认领 + 在途窃取），HLS 照旧逐片取件。
    async fn download_job(self: Arc<Self>, task_id: String, stop: Arc<AtomicBool>) {
        let job_start = Instant::now();
        // 分片表（seq → Segment）+ 待下载集合。
        // R2：media 缺失 / 无 track 的早退也必须摘掉自己的 job_stops 条目
        // （core 重启后 restore_from_db 只建 tasks 不建 media，把 online 任务
        // 切 stream/precache 档即可触达），否则残留的 stop=false 幽灵条目让
        // resume 假成功、清理器永久保护。按值 retain 摘除，与 finish_job 同款，
        // 不误删窗口内新起的 job 条目。
        let segs_map: BTreeMap<u64, Segment> = {
            let media = self.media.lock().await;
            let segs = media
                .get(&task_id)
                .and_then(|ss| ss.primary.tracks.first())
                .map(|track| {
                    track
                        .segments
                        .iter()
                        .map(|s| (s.seq, s.clone()))
                        .collect::<BTreeMap<u64, Segment>>()
                });
            match segs {
                Some(m) => m,
                None => {
                    drop(media);
                    self.log("warn", format!("任务 {task_id} 无可下载分片（media 缺失或无轨道），job 退出")).await;
                    self.job_stops
                        .lock()
                        .await
                        .retain(|_, f| !Arc::ptr_eq(f, &stop));
                    return;
                }
            }
        };
        let live = {
            let media = self.media.lock().await;
            media.get(&task_id).map(|ss| ss.primary.live).unwrap_or(false)
        };
        let is_mp4 = self
            .tasks
            .lock()
            .await
            .get(&task_id)
            .map(|t| t.protocol == Protocol::Mp4)
            .unwrap_or(false);
        let done = self.store.done_seqs(&task_id).unwrap_or_default();
        let todo: BTreeSet<u64> = segs_map
            .keys()
            .copied()
            .filter(|s| !done.contains(s))
            .collect();
        let seg_total = segs_map.len();
        let already = seg_total - todo.len();
        if already > 0 {
            self.log("info", format!("命中既有缓存 {already}/{seg_total} 分片，跳过"))
                .await;
        }
        struct Sched {
            todo: Mutex<BTreeSet<u64>>,
            inflight: Mutex<HashSet<u64>>,
            /// IDM 认领块（仅 MP4）：空闲 worker 窃取的候选
            claims: Mutex<Vec<Arc<Claim>>>,
        }
        let sched = Arc::new(Sched {
            todo: Mutex::new(todo),
            inflight: Mutex::new(HashSet::new()),
            claims: Mutex::new(Vec::new()),
        });
        if sched.todo.lock().unwrap_or_else(|p| p.into_inner()).is_empty() {
            self.finish_job(&task_id, job_start, stop.clone()).await;
            return;
        }

        let bytes_delta = Arc::new(AtomicU64::new(0));
        let mut workers = Vec::new();
        for _ in 0..self.max_concurrency {
            let this = self.clone();
            let task_id = task_id.clone();
            let sched = sched.clone();
            let segs_map = segs_map.clone();
            let bytes_delta = bytes_delta.clone();
            let stop = stop.clone();
            workers.push(tokio::spawn(async move {
                loop {
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    enum Pick {
                        Seg(u64),
                        /// IDM 认领块（MP4）：逐片下载 [next, stop_at)
                        Claim(Arc<Claim>),
                        /// 窗口未开 / 等在途分片：稍后重试
                        Wait,
                        /// 全部完成
                        Done,
                    }
                    // 取下一个最高优先级分片（播放头锚点实时读取，seek 即时生效）
                    let pick = {
                        let anchor = this.playheads.lock().await.get(&task_id).copied();
                        let mode = this
                            .tasks
                            .lock()
                            .await
                            .get(&task_id)
                            .map(|t| t.cache_mode)
                            .unwrap_or_default();
                        let mut todo = sched.todo.lock().unwrap_or_else(|p| p.into_inner());
                        let mut inflight = sched.inflight.lock().unwrap_or_else(|p| p.into_inner());
                        if is_mp4 {
                            // P6 IDM 动态分段（DESIGN §4.2）：空闲 worker 把最大剩余
                            // 连续块对半分认领前半段，逐片走既有换源/重试管线；
                            // todo 无可认领时窃取最大在途块的剩余段（对半分接管）。
                            if let Some((a, b)) = largest_window_run(&todo, anchor, mode, live) {
                                let mid = if b - a > 1 { a + (b - a + 1) / 2 } else { b };
                                for s in a..mid {
                                    todo.remove(&s);
                                    inflight.insert(s);
                                }
                                let c = Claim::new(a, mid);
                                sched
                                    .claims
                                    .lock()
                                    .unwrap_or_else(|p| p.into_inner())
                                    .push(c.clone());
                                Pick::Claim(c)
                            } else if todo.is_empty() && inflight.is_empty() {
                                Pick::Done
                            } else if todo.is_empty() {
                                match try_steal_claim(
                                    &sched.claims.lock().unwrap_or_else(|p| p.into_inner()),
                                    IDM_STEAL_MIN,
                                ) {
                                    Some(c) => Pick::Claim(c),
                                    None => Pick::Wait,
                                }
                            } else {
                                Pick::Wait
                            }
                        } else {
                            let next = todo
                                .iter()
                                .filter(|&&s| {
                                    !inflight.contains(&s)
                                        && in_schedule_window(s, anchor, mode, live)
                                })
                                .copied()
                                .min_by_key(|&s| health::priority(s, anchor));
                            match next {
                                Some(s) => {
                                    todo.remove(&s);
                                    inflight.insert(s);
                                    Pick::Seg(s)
                                }
                                None => {
                                    if todo.is_empty() && inflight.is_empty() {
                                        Pick::Done
                                    } else {
                                        Pick::Wait
                                    }
                                }
                            }
                        }
                    };
                    match pick {
                        Pick::Seg(seq) => {
                            if let Some(seg) = segs_map.get(&seq) {
                                match this.fetch_on_sources(&task_id, seg, "eng").await {
                                    Ok(n) => {
                                        bytes_delta.fetch_add(n as u64, Ordering::Relaxed);
                                    }
                                    Err(e) => {
                                        this.log("warn", format!("分片 {seq} 失败：{e}")).await;
                                    }
                                }
                            }
                            sched
                                .inflight
                                .lock()
                                .unwrap_or_else(|p| p.into_inner())
                                .remove(&seq);
                        }
                        Pick::Claim(c) => {
                            // 逐片处理认领块：窗口随播放头实时校验，出窗剩余片归还 todo
                            loop {
                                let Some(seq) = c.take_next() else { break };
                                if stop.load(Ordering::Relaxed) {
                                    break;
                                }
                                let (anchor, mode) = {
                                    let a = this.playheads.lock().await.get(&task_id).copied();
                                    let m = this
                                        .tasks
                                        .lock()
                                        .await
                                        .get(&task_id)
                                        .map(|t| t.cache_mode)
                                        .unwrap_or_default();
                                    (a, m)
                                };
                                if !in_schedule_window(seq, anchor, mode, live) {
                                    // 出窗：本块剩余片（含当前）归还 todo，随窗口重排再认领
                                    let stop_at = c.stop_at.load(Ordering::Relaxed);
                                    let mut todo =
                                        sched.todo.lock().unwrap_or_else(|p| p.into_inner());
                                    let mut inflight =
                                        sched.inflight.lock().unwrap_or_else(|p| p.into_inner());
                                    for s in seq..stop_at {
                                        todo.insert(s);
                                        inflight.remove(&s);
                                    }
                                    break;
                                }
                                if let Some(seg) = segs_map.get(&seq) {
                                    match this.fetch_on_sources(&task_id, seg, "eng").await {
                                        Ok(n) => {
                                            bytes_delta.fetch_add(n as u64, Ordering::Relaxed);
                                        }
                                        Err(e) => {
                                            this.log("warn", format!("分片 {seq} 失败：{e}")).await;
                                        }
                                    }
                                }
                                sched
                                    .inflight
                                    .lock()
                                    .unwrap_or_else(|p| p.into_inner())
                                    .remove(&seq);
                            }
                            sched
                                .claims
                                .lock()
                                .unwrap_or_else(|p| p.into_inner())
                                .retain(|x| !Arc::ptr_eq(x, &c));
                        }
                        Pick::Wait => {
                            tokio::time::sleep(Duration::from_millis(WINDOW_WAIT_MS)).await;
                        }
                        Pick::Done => break,
                    }
                }
            }));
        }

        // 心跳：进度 + 源健康度 + proxy 统计（节流广播）
        let ticker = {
            let this = self.clone();
            let task_id = task_id.clone();
            let bytes_delta = bytes_delta.clone();
            let stop = stop.clone();
            tokio::spawn(async move {
                let mut last_bytes: u64 = 0;
                loop {
                    tokio::time::sleep(Duration::from_millis(PROGRESS_TICK_MS)).await;
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    let cur = bytes_delta.load(Ordering::Relaxed);
                    let speed = (cur.saturating_sub(last_bytes)) * 1000 / PROGRESS_TICK_MS;
                    last_bytes = cur;
                    this.emit(&task_id, TaskStatus::Downloading, Some(speed))
                        .await;
                    this.push_source_stats(&task_id).await;
                    this.push_proxy_stats(&task_id);
                }
            })
        };
        for w in workers {
            let _ = w.await;
        }
        ticker.abort();
        self.finish_job(&task_id, job_start, stop.clone()).await;
    }

    /// 任务收尾：有失败分片 → 记录告警；终态 ready；
    /// 全量完成 → 记 finished_at 并起算播完 TTL（DESIGN §4.6）。
    /// `stop` 是本 job 自己的停止标志：摘除 job_stops 必须按值（Arc::ptr_eq）
    /// 而非按 key——pause 700ms 窗口内用户 resume 会插入新条目并起新 job，
    /// 旧 job 滞后数秒收尾时按 key remove 会把新 job 的停止位一起摘掉。
    async fn finish_job(&self, task_id: &str, job_start: Instant, stop: Arc<AtomicBool>) {
        let (done, total, bytes) = self.store.progress(task_id);
        let failed = self.store.count_failed(task_id);
        let all_done = total > 0 && done == total;
        // P40：job 收尾不许把「已暂停」改回 ready。
        // pause_task 只等 700ms 让进度心跳落地，而 worker 手上那批分片可能还要几秒才退出；
        // finish_job 晚到就会覆盖成 ready —— 界面徽章从「已暂停」变「未下完」，
        // 「自动」标记也消失（它要求 status==paused），用户以为暂停没生效。
        let paused = self
            .tasks
            .lock()
            .await
            .get(task_id)
            .map(|t| t.status == TaskStatus::Paused)
            .unwrap_or(false);
        let status = if failed > 0 && done == 0 {
            TaskStatus::Failed
        } else if all_done {
            TaskStatus::Ready
        } else if paused {
            TaskStatus::Paused
        } else {
            TaskStatus::Ready
        };
        self.store.set_task_status(task_id, status.as_str());
        let mut retain_note = String::new();
        if status == TaskStatus::Ready && total > 0 && done == total {
            let now = now_ms() as i64;
            // retain_ms() 返回时长，mark_finished 第三参是绝对截止时刻（cleanup 单测语义）
            let retain_until = retain_ms(self.cache_policy().retain_days).map(|ms| now + ms);
            self.store.mark_finished(task_id, now, retain_until);
            retain_note = match retain_until {
                Some(ms) => format!(" / 缓存保留至 {}", iso_from_ms(ms)),
                None => " / 缓存永久保留".into(),
            };
        }
        let secs = job_start.elapsed().as_secs_f64().max(0.001);
        self.log(
            "info",
            format!(
                "下载结束：{done}/{total} 分片 / {:.2} MB / 平均 {:.2} MB/s / 失败 {failed}{retain_note}",
                bytes as f64 / 1048576.0,
                bytes as f64 / 1048576.0 / secs
            ),
        )
        .await;
        self.emit(task_id, status, None).await;
        // F3：job 收尾即摘除 job_stops 条目——否则 job_running() 对该任务永真：
        // 清理器把跑过 job 的任务永久保护（容量 LRU 失效），resume/activate
        // 也会误判「job 已在途」而假成功（界面停在「下载中」却永无下载）。
        // 按值摘除（只删自己的标志），不动窗口内 resume 新插入的条目。
        self.job_stops
            .lock()
            .await
            .retain(|_, f| !Arc::ptr_eq(f, &stop));
    }

    // ---------- P6 合并导出（DESIGN §4.6：任务完成可选合并导出） ----------

    /// 导出格式：TS 嗅探首片 0x47 同步字节；MP4/fMP4 → mp4
    async fn export_ext(&self, task_id: &str, protocol: Protocol) -> Result<String, String> {
        match protocol {
            Protocol::Mp4 => Ok("mp4".into()),
            Protocol::Dash | Protocol::Unknown => Err("该协议合并导出暂不支持".into()),
            Protocol::Hls => {
                let mut done: Vec<u64> = self
                    .store
                    .done_seqs(task_id)
                    .unwrap_or_default()
                    .into_iter()
                    .collect();
                done.sort();
                let Some(&first) = done.first() else {
                    return Err("暂无可导出的缓存分片".into());
                };
                // 引擎落盘前已做 AES-128 解密（明文媒体），TS 包首字节恒 0x47；
                // fMP4 fragment 以 styp/moof/ftyp box 开头（'s'/'m'/'f'）
                let is_ts = std::fs::File::open(self.store.segment_path(task_id, first))
                    .and_then(|mut f| {
                        use std::io::Read;
                        let mut b = [0u8; 1];
                        f.read_exact(&mut b)?;
                        Ok(b[0] == 0x47)
                    })
                    .unwrap_or(false);
                Ok(if is_ts { "ts" } else { "mp4" }.into())
            }
        }
    }

    /// 导出探测：格式扩展名 + 缓存完成度（桌面端据此弹保存对话框）
    pub async fn export_info(&self, task_id: &str) -> Result<ExportInfo, String> {
        let protocol = self
            .tasks
            .lock()
            .await
            .get(task_id)
            .map(|t| t.protocol)
            .ok_or("任务不存在")?;
        let (done, total, _) = self.store.progress(task_id);
        if done == 0 {
            return Err("暂无可导出的缓存分片".into());
        }
        let ext = self.export_ext(task_id, protocol).await?;
        Ok(ExportInfo { ext, done, total })
    }

    /// 合并导出：分片二进制 concat（纯 Rust，无外部依赖）。
    /// · MP4 直链：块按 seq 拼回原始 .mp4；
    /// · HLS/TS：分片按 seq 拼接为 .ts；
    /// · HLS/fMP4：EXT-X-MAP init 段前置（导出时重新拉取），再拼 .m4s → .mp4。
    /// 未完成缓存允许导出（按已缓存分片拼接，日志告警）。
    pub async fn export_task(&self, task_id: &str, out_path: &str) -> Result<ExportResult, String> {
        let task = self
            .tasks
            .lock()
            .await
            .get(task_id)
            .cloned()
            .ok_or("任务不存在")?;
        let mut done: Vec<u64> = self
            .store
            .done_seqs(task_id)
            .unwrap_or_default()
            .into_iter()
            .collect();
        done.sort();
        if done.is_empty() {
            return Err("暂无可导出的缓存分片".into());
        }
        let ext = self.export_ext(task_id, task.protocol).await?;
        let (_, total, _) = self.store.progress(task_id);
        self.log(
            "info",
            format!(
                "开始合并导出：{}/{} 分片 → {}（.{}）",
                done.len(),
                total,
                out_path,
                ext
            ),
        )
        .await;

        use tokio::io::AsyncWriteExt;
        // .part 先写，完成后 rename（防半截文件冒充成品）
        let tmp = format!("{out_path}.part");
        let mut out = tokio::fs::File::create(&tmp)
            .await
            .map_err(|e| format!("创建输出文件失败: {e}"))?;
        let mut bytes: u64 = 0;

        // fMP4：init 段（EXT-X-MAP）前置
        if task.protocol == Protocol::Hls && ext == "mp4" {
            let ir = pf_parser::load(&self.client, &task.url).await.map_err(|e| {
                format!("拉取 playlist 失败（无法获取 fMP4 init 段）: {e}")
            })?;
            let map_uri = ir
                .map_uri
                .ok_or("playlist 无 EXT-X-MAP（非 fMP4，无法确定 init 段）")?;
            let init = self
                .client
                .get(&map_uri)
                .send()
                .await
                .map_err(|e| format!("拉取 init 段失败: {e}"))?
                .error_for_status()
                .map_err(|e| format!("拉取 init 段失败: {e}"))?
                .bytes()
                .await
                .map_err(|e| format!("读取 init 段失败: {e}"))?;
            out.write_all(&init)
                .await
                .map_err(|e| format!("写入 init 段失败: {e}"))?;
            bytes += init.len() as u64;
        }

        let mut segments: u64 = 0;
        for seq in &done {
            let p = self.store.segment_path(task_id, *seq);
            let data = tokio::fs::read(&p).await.map_err(|e| format!("读取分片 {seq} 失败: {e}"))?;
            out.write_all(&data)
                .await
                .map_err(|e| format!("写入分片 {seq} 失败: {e}"))?;
            bytes += data.len() as u64;
            segments += 1;
        }
        out.flush().await.map_err(|e| format!("刷盘失败: {e}"))?;
        drop(out);
        tokio::fs::rename(&tmp, out_path)
            .await
            .map_err(|e| format!("落定输出文件失败: {e}"))?;
        if (done.len() as u64) < total {
            self.log(
                "warn",
                format!("导出使用未完成缓存：{}/{} 分片，成品可能不完整", done.len(), total),
            )
            .await;
        }
        self.log(
            "info",
            format!("导出完成：{out_path}（{:.2} MB / {segments} 分片）", bytes as f64 / 1048576.0),
        )
        .await;
        Ok(ExportResult {
            path: out_path.into(),
            bytes,
            segments,
        })
    }

    // ---------- P2.5 三档模式运行时（DESIGN §4.6） ----------

    /// 启动下载 job（登记停止标志；重复启动受在途标志保护）。
    /// 返回是否真的起了 job：已有在途 job 时去重早退返回 false，
    /// 调用方（activate/resume）据此不改写状态为「下载中」。
    async fn spawn_download_job(self: &Arc<Self>, task_id: String) -> bool {
        {
            let stops = self.job_stops.lock().await;
            if let Some(f) = stops.get(&task_id) {
                if !f.load(Ordering::Relaxed) {
                    return false; // 已有在途 job
                }
            }
        }
        let stop = Arc::new(AtomicBool::new(false));
        self.job_stops
            .lock()
            .await
            .insert(task_id.clone(), stop.clone());
        tokio::spawn(TaskManager::download_job(self.clone(), task_id, stop));
        true
    }

    /// 协同停止下载 job（worker/ticker 每轮检查标志，自然收尾）
    async fn stop_download_job(&self, task_id: &str) {
        if let Some(f) = self.job_stops.lock().await.get(task_id) {
            f.store(true, Ordering::Relaxed);
        }
    }

    /// 任务当前缓存模式（内存为准，pf-proxy 在线判断用）
    pub async fn cache_mode_of(&self, task_id: &str) -> CacheMode {
        self.tasks
            .lock()
            .await
            .get(task_id)
            .map(|t| t.cache_mode)
            .unwrap_or_default()
    }

    /// 清空任务已落盘缓存（segments 行 + 文件；模式切到 online 时调用），返回释放字节数
    fn purge_task_cache(&self, task_id: &str) -> u64 {
        let (_done, _total, bytes) = self.store.progress(task_id);
        let dir = self.store.cache_dir().join(task_id);
        if dir.exists() {
            let _ = std::fs::remove_dir_all(&dir);
        }
        self.store.clear_segments(task_id);
        bytes
    }

    /// 切换缓存模式（RPC task.set_cache_mode）：
    /// → online：停预取 + 清缓存（不占磁盘语义）；→ stream/precache：恢复调度。
    ///
    /// P40：**状态必须跟着真实调度走**。早前这里无条件 `emit(Downloading)`，
    /// 于是一个暂停中的任务被改档位后，库里/界面上写着「下载中」，而实际上
    /// 没有任何 job 在跑 —— 用户看到进度条不动，还以为是源站慢。
    pub async fn set_cache_mode(self: &Arc<Self>, task_id: &str, mode: CacheMode) -> Result<Task, String> {
        let old = {
            let mut tasks = self.tasks.lock().await;
            let t = tasks.get_mut(task_id).ok_or("任务不存在")?;
            let old = t.cache_mode;
            t.cache_mode = mode;
            old
        };
        self.store.set_cache_mode(task_id, mode.as_str())?;
        // 暂停是用户的明确意图（或 P40 的下载槽让位），改档位不该把它悄悄激活
        let paused = self
            .tasks
            .lock()
            .await
            .get(task_id)
            .map(|t| t.status == TaskStatus::Paused)
            .unwrap_or(false);

        let mut next = TaskStatus::Downloading;
        if mode == CacheMode::Online {
            if old != CacheMode::Online {
                self.stop_download_job(task_id).await;
                let freed = self.purge_task_cache(task_id);
                self.log(
                    "info",
                    format!("任务 {task_id} 转 online：预取停止，释放缓存 {:.2} MB", freed as f64 / 1048576.0),
                )
                .await;
            }
            // online 不下载，终态就是 ready
            next = TaskStatus::Ready;
        } else if paused {
            self.log("info", format!("任务 {task_id} → {}：保持暂停，需手动启动", mode.as_str())).await;
            next = TaskStatus::Paused;
        } else if old == CacheMode::Online || !self.job_running(task_id).await {
            // online→下载档，或 job 已收尾（ready 但没下完）→ 必须真的把 job 起起来，
            // 否则「切了预缓存却不动」。job 在跑时不要去重起（会丢在途分片）。
            self.log("info", format!("任务 {task_id} → {}：启动调度", mode.as_str())).await;
            self.spawn_download_job(task_id.to_string()).await;
        } else {
            self.log("info", format!("任务 {task_id} → {}（job 在跑，继续）", mode.as_str())).await;
        }
        self.emit(task_id, next, None).await;
        self.tasks
            .lock()
            .await
            .get(task_id)
            .cloned()
            .ok_or_else(|| "任务不存在".to_string())
    }

    /// 某任务是否有下载 job 在跑（`job_stops` 里 stop=false 即未收尾）
    async fn job_running(&self, task_id: &str) -> bool {
        let stops = self.job_stops.lock().await;
        stops
            .get(task_id)
            .map(|f| !f.load(Ordering::Relaxed))
            .unwrap_or(false)
    }

    /// 暂停任务下载（P5 RPC task.pause）：协同停 job + 状态 paused。
    /// 播放不受影响（proxy 未命中仍实时回源）；重启后保持暂停（unfinished_tasks 不含 paused）。
    pub async fn pause_task(self: &Arc<Self>, task_id: &str) -> Result<Task, String> {
        {
            let tasks = self.tasks.lock().await;
            if !tasks.contains_key(task_id) {
                return Err("任务不存在".into());
            }
        }
        self.stop_download_job(task_id).await;
        // worker 协同收尾窗口（等最后一次进度心跳落地，避免 Paused 被 Downloading 覆盖）
        tokio::time::sleep(Duration::from_millis(700)).await;
        self.store.set_task_status(task_id, TaskStatus::Paused.as_str());
        self.log("info", format!("任务 {task_id} 已暂停下载")).await;
        self.emit(task_id, TaskStatus::Paused, None).await;
        self.tasks
            .lock()
            .await
            .get(task_id)
            .cloned()
            .ok_or_else(|| "任务不存在".to_string())
    }

    /// 恢复任务下载（P5 RPC task.resume）：复用剧集队列激活管线——
    /// media 在内存直接起 job（会话内暂停）；缺失则重新解析（core 重启后恢复）。
    pub async fn resume_task(self: &Arc<Self>, task_id: &str) -> Result<Task, String> {
        {
            let tasks = self.tasks.lock().await;
            let t = tasks.get(task_id).ok_or("任务不存在")?;
            if t.cache_mode == CacheMode::Online {
                return Err("online 模式无预取可恢复".into());
            }
        }
        let activated = self.activate_task(task_id).await?;
        if activated {
            self.store.set_task_status(task_id, TaskStatus::Downloading.as_str());
            self.log("info", format!("任务 {task_id} 已恢复下载")).await;
            self.emit(task_id, TaskStatus::Downloading, None).await;
        } else {
            // 没真启动（online 档 / job 已在途）：不要把状态改写成「下载中」，
            // 否则界面显示在下载、进度却永远不动（P40 的状态一致性要求）
            let status = self
                .tasks
                .lock()
                .await
                .get(task_id)
                .map(|t| t.status)
                .unwrap_or(TaskStatus::Ready);
            self.emit(task_id, status, None).await;
        }
        self.tasks
            .lock()
            .await
            .get(task_id)
            .cloned()
            .ok_or_else(|| "任务不存在".to_string())
    }

    /// 删除任务（P5 RPC task.delete）：停 job → 清缓存（文件+分片索引）→
    /// 级联删库行（tasks/sources/segments）→ 移除全部内存态，返回释放字节。
    pub async fn delete_task(self: &Arc<Self>, task_id: &str) -> Result<u64, String> {
        let one = task_id.to_string();
        let (deleted, freed, failed) = self.delete_tasks(std::slice::from_ref(&one)).await;
        if deleted == 0 {
            return Err(failed
                .into_iter()
                .next()
                .map(|(_, e)| e)
                .unwrap_or_else(|| "任务不存在".into()));
        }
        Ok(freed)
    }

    /// P35 批量删除（媒体库 / 任务页的「清理」）：
    /// 先统一停 job → **只为确实在跑的任务等一次** worker 收尾 → 逐个清缓存 + 级联删库行。
    ///
    /// 不能直接循环调 `delete_task`：它每个都 `sleep(400ms)`，删 50 个要 20 秒，
    /// 期间界面只能一条条消失。这里把收尾等待折叠成一次，整体降到 ~0.4s。
    ///
    /// 返回 `(删除数, 释放字节, 失败项)`；不存在的 id 进失败项而不是整体报错，
    /// 因为清理场景里「列表快照过期」是常态，不该让其余任务陪葬。
    pub async fn delete_tasks(
        self: &Arc<Self>,
        ids: &[String],
    ) -> (usize, u64, Vec<(String, String)>) {
        let (targets, mut failed, any_running) = self.cleanup_targets(ids).await;
        if targets.is_empty() {
            return (0, 0, failed);
        }
        for id in &targets {
            self.stop_download_job(id).await;
        }
        if any_running {
            // worker 协同收尾窗口（没有在跑的任务就不必等）
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
        let mut freed_total = 0u64;
        for id in &targets {
            freed_total += self.purge_task_cache(id);
            self.store.delete_task_cascade(id);
            self.forget_task(id).await;
        }
        self.log(
            "info",
            format!(
                "清理 {} 个任务（释放 {:.2} MB）",
                targets.len(),
                freed_total as f64 / 1048576.0
            ),
        )
        .await;
        (targets.len(), freed_total, failed.drain(..).collect())
    }

    /// 批量清缓存（保留任务记录）：与 `delete_tasks` 同一套收尾折叠策略，
    /// 清完把状态打回 ready（缓存没了就不再是「已下完」）。
    pub async fn purge_tasks(&self, ids: &[String]) -> (usize, u64, Vec<(String, String)>) {
        let (targets, mut failed, any_running) = self.cleanup_targets(ids).await;
        if targets.is_empty() {
            return (0, 0, failed);
        }
        for id in &targets {
            self.stop_download_job(id).await;
        }
        if any_running {
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
        let mut freed_total = 0u64;
        for id in &targets {
            freed_total += self.purge_task_cache(id);
            self.store.set_task_status(id, TaskStatus::Ready.as_str());
            self.emit(id, TaskStatus::Ready, None).await;
        }
        self.log(
            "info",
            format!(
                "清理 {} 个任务的缓存（释放 {:.2} MB）",
                targets.len(),
                freed_total as f64 / 1048576.0
            ),
        )
        .await;
        (targets.len(), freed_total, failed.drain(..).collect())
    }

    /// 清理前的目标筛选：把 id 拆成「存在 / 不存在」，并报告是否有在跑的下载。
    /// 单独抽出来是因为删除与清缓存两条路径的判定完全相同，避免两处漂移。
    async fn cleanup_targets(
        &self,
        ids: &[String],
    ) -> (Vec<String>, Vec<(String, String)>, bool) {
        let tasks = self.tasks.lock().await;
        let mut targets = Vec::with_capacity(ids.len());
        let mut failed = Vec::new();
        let mut any_running = false;
        for id in ids {
            match tasks.get(id) {
                Some(t) => {
                    if t.status == TaskStatus::Downloading {
                        any_running = true;
                    }
                    targets.push(id.clone());
                }
                None => failed.push((id.clone(), "任务不存在".to_string())),
            }
        }
        (targets, failed, any_running)
    }

    /// 移除任务在内存里的全部痕迹（表、媒体信息、健康度、播放头、job 停止位、活跃时间）
    async fn forget_task(&self, task_id: &str) {
        self.tasks.lock().await.remove(task_id);
        self.media.lock().await.remove(task_id);
        self.healths.lock().await.remove(task_id);
        self.playheads.lock().await.remove(task_id);
        self.job_stops.lock().await.remove(task_id);
        self.last_touch
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(task_id);
    }

    /// 清理器主循环（pf-core 启动）：启动清扫 + 每 60s 一轮
    pub async fn cleanup_loop(self: Arc<Self>) {
        tokio::time::sleep(Duration::from_secs(5)).await; // 等启动恢复就绪
        loop {
            self.run_cleanup_once().await;
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    }

    /// series 预缓存队列循环（P3，pf-core 启动）：每 5s 推进一轮
    pub async fn series_queue_loop(self: Arc<Self>) {
        tokio::time::sleep(Duration::from_secs(10)).await; // 等启动恢复就绪
        loop {
            self.series_queue_tick().await;
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    }

    /// 单轮调度（每 5s）：
    /// 1. **P46 窗口**：当前集之后按策略（3 集 / 全部 / 自定义）串行推进；
    /// 2. **P3 顺延**：仅当预缓存关闭（off）时保留旧行为 —— 当前集 ≥95% 才激活下一集。
    ///
    /// 「当前集」= 最近 2min 有播放头活动的任务；没有活跃播放直接返回（不做无人观看的预取）。
    pub async fn series_queue_tick(self: &Arc<Self>) {
        let cur_id = {
            let ph = self.playheads.lock().await;
            let lt = self.last_touch.lock().unwrap_or_else(|p| p.into_inner());
            lt.iter()
                .filter(|(id, t)| t.elapsed() < Duration::from_secs(120) && ph.contains_key(*id))
                .max_by_key(|(_, t)| *t)
                .map(|(id, _)| id.clone())
        };
        let Some(cur_id) = cur_id else { return };
        let Some((series_id, cur_idx)) = self.store.series_episode_of(&cur_id) else {
            return;
        };
        self.dispatch_window(&series_id, cur_idx).await;
        if self.prefetch_config().mode == series::PrefetchMode::Off {
            self.activate_next_after_finish(&series_id, &cur_id).await;
        }
    }

    /// P3 旧行为（关闭预缓存时兜底）：当前集完结 → 激活下一集
    async fn activate_next_after_finish(self: &Arc<Self>, series_id: &str, cur_id: &str) {
        let eps = self.store.series_episodes(series_id);
        let snaps: Vec<series::EpisodeSnap> = eps
            .iter()
            .map(|(id, _idx, mode, status, live)| {
                let (done, total, _) = self.store.progress(id);
                series::EpisodeSnap {
                    task_id: id.clone(),
                    episode_index: *_idx,
                    live: *live,
                    online: CacheMode::from_str(mode) == Some(CacheMode::Online),
                    done: status == "ready" || (total > 0 && done as f64 / total as f64 >= 0.95),
                }
            })
            .collect();
        let Some(next) = series::pick_next_episode(&snaps, cur_id) else {
            return;
        };
        match self.activate_task(&next).await {
            Ok(true) => {
                let idx = eps.iter().find(|(id, ..)| *id == next).map(|(_, i, ..)| *i);
                self.log(
                    "info",
                    format!(
                        "剧集顺延：当前集 ≥95%，激活下一集 {next}（第 {} 集）",
                        idx.unwrap_or(-1) + 1
                    ),
                )
                .await;
            }
            Ok(false) => {}
            Err(e) => {
                self.log("warn", format!("剧集顺延激活失败 {next}: {e}")).await;
            }
        }
    }

    /// 激活任务（剧集队列/手动恢复用）：非 online、未在途 → 走解析/续传管线。
    /// 返回 false = 无需激活（已在途/online/不存在）。
    pub async fn activate_task(self: &Arc<Self>, task_id: &str) -> Result<bool, String> {
        let (url, mode) = {
            let tasks = self.tasks.lock().await;
            let t = tasks.get(task_id).ok_or("任务不存在")?;
            (t.url.clone(), t.cache_mode)
        };
        if mode == CacheMode::Online {
            return Ok(false);
        }
        // media 已在内存（会话内暂停/恢复）：跳过重新解析直接起 job。
        // F3：job 已在途时 spawn 去重早退返回 false → 上层按「无需激活」处理，
        // 不改写状态（否则 resume 假成功，界面「下载中」却永无下载）。
        if self.media.lock().await.contains_key(task_id) {
            let started = self.spawn_download_job(task_id.to_string()).await;
            return Ok(started);
        }
        {
            let stops = self.job_stops.lock().await;
            if let Some(f) = stops.get(task_id) {
                if !f.load(Ordering::Relaxed) {
                    return Ok(false); // 已在途
                }
            }
        }
        let mirrors = self.store.sources_of(task_id);
        self.probe_and_start(task_id.to_string(), std::iter::once(url).chain(mirrors).collect())
            .await?;
        Ok(true)
    }

    /// 单轮清理：播完 TTL / 未播完 LRU / 容量 LRU / 孤儿分片（cleanup::sweep）
    pub async fn run_cleanup_once(&self) -> cleanup::CleanupReport {
        // 保护集：在途下载任务 + 最近有播放头活动的任务（正在播放）
        let mut protected: HashSet<String> = self
            .job_stops
            .lock()
            .await
            .iter()
            .filter(|(_, f)| !f.load(Ordering::Relaxed))
            .map(|(id, _)| id.clone())
            .collect();
        {
            let ph = self.playheads.lock().await;
            for id in ph.keys() {
                protected.insert(id.clone());
            }
        }
        {
            // F2：正在起播解析中的任务（probing 去重集）同样不许被清理，
            // 否则复用任务在探测窗口内会被 stale sweep 连根删掉。
            let probing = self.probing.lock().await;
            for id in probing.iter() {
                protected.insert(id.clone());
            }
        }
        let policy = self.cache_policy();
        let report = cleanup::sweep(
            &self.store,
            self.store.cache_dir(),
            &cleanup::CleanupConfig {
                retain_days: policy.retain_days,
                unfinished_days: policy.unfinished_days,
                capacity_bytes: (policy.capacity_gb * 1073741824.0) as u64,
                playing_window_ms: PLAYING_WINDOW_MS,
            },
            &protected,
            now_ms() as i64,
        );
        if report.deleted_tasks > 0 || report.orphan_files > 0 {
            self.log(
                "info",
                format!(
                    "缓存清理：删任务 {}（{} 分片 / {:.1} MB）· 孤儿 {} 个（{:.1} MB）",
                    report.deleted_tasks,
                    report.deleted_segments,
                    report.freed_bytes as f64 / 1048576.0,
                    report.orphan_files,
                    report.orphan_bytes as f64 / 1048576.0
                ),
            )
            .await;
        }
        // 内存同步：被清理任务移出任务表，并摘除 media/健康度/job_stops 等
        // 全部内存痕迹（F2：只删 tasks 会遗留 media/healths/job_stops/last_touch，
        // 在跑 job 还会复活 DB 行）。forget_task 自身会锁 tasks，
        // 必须等 tasks 锁 drop 之后再逐个调用，避免自锁。
        if !report.removed_ids.is_empty() {
            let removed = report.removed_ids.clone();
            {
                let mut tasks = self.tasks.lock().await;
                for id in &removed {
                    tasks.remove(id);
                }
            }
            for id in &removed {
                self.forget_task(id).await;
            }
        }
        report
    }

    /// 单分片下载（P2 逐片换源）：健康度择优 → 失败同源重试 → 换次优源；
    /// 成功后 AES-128 解密再落盘。返回明文字节数。
    async fn fetch_on_sources(
        &self,
        task_id: &str,
        seg: &Segment,
        tag: &str,
    ) -> Result<u64, String> {
        let mut exclude: Vec<usize> = Vec::new();
        let mut same_tried = 0usize;
        let mut last_idx = usize::MAX;
        let mut last_err = String::from("无可用源");
        let mut tries = 0i64;
        // P4 P2SP：MP4 多镜像（字节一致已预检）纯 seq 轮转分摊带宽
        let spread = self
            .tasks
            .lock()
            .await
            .get(task_id)
            .map(|t| t.protocol == pf_parser::Protocol::Mp4)
            .unwrap_or(false);
        loop {
            let idx = {
                let hs = self.healths.lock().await;
                health::pick_source(
                    hs.get(task_id).map(|v| v.as_slice()).unwrap_or(&[]),
                    &exclude,
                    Instant::now(),
                    seg.seq,
                    spread,
                )
            };
            let Some(idx) = idx else { break };
            if idx == last_idx {
                same_tried += 1;
            } else {
                same_tried = 0;
                last_idx = idx;
            }
            let uri = self.segment_uri_at(task_id, idx, seg.seq).await;
            let t0 = Instant::now();
            let res = match uri {
                Some(u) => fetch_range(self.http(), &u, seg.byterange).await,
                None => Err(format!("源{idx} 无 seq={} 分片（镜像不对齐）", seg.seq)),
            };
            match res {
                Ok(bytes) => {
                    let lat = t0.elapsed().as_secs_f64();
                    self.health_record(task_id, idx, true, lat, bytes.len() as u64)
                        .await;
                    // AES-128 本地解密（非加密分片原样返回）
                    let plain = match self.decrypt_for(task_id, seg, &bytes).await {
                        Ok(p) => p,
                        Err(e) => {
                            self.store.mark_segment(task_id, seg.seq, "failed", None, None, tries + 1);
                            return Err(format!("源{idx} 解密失败: {e}"));
                        }
                    };
                    self.store_segment(task_id, seg.seq, &plain, tag)?;
                    return Ok(plain.len() as u64);
                }
                Err(e) => {
                    let lat = t0.elapsed().as_secs_f64();
                    self.health_record(task_id, idx, false, lat, 0).await;
                    last_err = format!("源{idx}: {e}");
                    if same_tried + 1 >= SAME_SOURCE_TRIES {
                        exclude.push(idx);
                    }
                }
            }
            tries += 1;
            if tries >= RETRY_PER_SEGMENT as i64 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(RETRY_BACKOFF_MS << tries.min(4))).await;
        }
        self.store
            .mark_segment(task_id, seg.seq, "failed", None, None, tries);
        Err(last_err)
    }

    /// proxy 未命中回源：与健康度调度同一套择优 + 解密逻辑（返回明文，不落盘）
    pub async fn proxy_fetch_segment(&self, task_id: &str, seq: u64) -> Result<Vec<u8>, String> {
        let seg = {
            let media = self.media.lock().await;
            let ss = media.get(task_id).ok_or("任务不存在")?;
            ss.primary
                .tracks
                .first()
                .and_then(|t| t.segments.iter().find(|s| s.seq == seq))
                .cloned()
                .ok_or("segment not found")?
        };
        let mut exclude: Vec<usize> = Vec::new();
        let mut same_tried = 0usize;
        let mut last_idx = usize::MAX;
        let mut last_err = String::from("无可用源");
        let mut tries = 0i64;
        let spread = self
            .tasks
            .lock()
            .await
            .get(task_id)
            .map(|t| t.protocol == pf_parser::Protocol::Mp4)
            .unwrap_or(false);
        loop {
            let idx = {
                let hs = self.healths.lock().await;
                health::pick_source(
                    hs.get(task_id).map(|v| v.as_slice()).unwrap_or(&[]),
                    &exclude,
                    Instant::now(),
                    seq,
                    spread,
                )
            };
            let Some(idx) = idx else { break };
            if idx == last_idx {
                same_tried += 1;
            } else {
                same_tried = 0;
                last_idx = idx;
            }
            let uri = self.segment_uri_at(task_id, idx, seq).await;
            let t0 = Instant::now();
            let res = match uri {
                Some(u) => fetch_range(self.http(), &u, seg.byterange).await,
                None => Err(format!("源{idx} 无 seq={seq} 分片")),
            };
            match res {
                Ok(bytes) => {
                    let lat = t0.elapsed().as_secs_f64();
                    self.health_record(task_id, idx, true, lat, bytes.len() as u64)
                        .await;
                    return self.decrypt_for(task_id, &seg, &bytes).await;
                }
                Err(e) => {
                    let lat = t0.elapsed().as_secs_f64();
                    self.health_record(task_id, idx, false, lat, 0).await;
                    last_err = format!("源{idx}: {e}");
                    if same_tried + 1 >= SAME_SOURCE_TRIES {
                        exclude.push(idx);
                    }
                }
            }
            tries += 1;
            if tries >= RETRY_PER_SEGMENT as i64 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(RETRY_BACKOFF_MS << tries.min(4))).await;
        }
        Err(last_err)
    }

    /// 源 idx 上 seq 分片的绝对 URL（镜像独立 MediaIR，按 seq 对齐）
    async fn segment_uri_at(&self, task_id: &str, src_idx: usize, seq: u64) -> Option<String> {
        let media = self.media.lock().await;
        let ss = media.get(task_id)?;
        let ir = if src_idx == 0 { &ss.primary } else { ss.mirrors.get(src_idx - 1)? };
        let track = ir.tracks.first()?;
        track.segments.iter().find(|s| s.seq == seq).map(|s| s.uri.clone())
    }

    /// 健康度记账；熔断触发时广播告警
    async fn health_record(&self, task_id: &str, idx: usize, ok: bool, latency: f64, bytes: u64) {
        let mut circuit_msg = None;
        {
            let mut hs = self.healths.lock().await;
            if let Some(list) = hs.get_mut(task_id) {
                if let Some(h) = list.get_mut(idx) {
                    let now = Instant::now();
                    if ok {
                        h.record_success(latency, bytes, now);
                    } else {
                        h.record_fail(now);
                        if h.state == health::SourceState::CircuitOpen {
                            circuit_msg = Some(format!(
                                "源{idx}({}) 连续失败熔断 60s，期间仅保活试探",
                                h.url
                            ));
                        }
                    }
                }
            }
        }
        if let Some(m) = circuit_msg {
            self.log("warn", m).await;
        }
    }

    /// 源健康度快照广播（调试面板）
    async fn push_source_stats(&self, task_id: &str) {
        let hs = self.healths.lock().await;
        if let Some(list) = hs.get(task_id) {
            let now = Instant::now();
            let stats: Vec<SourceStat> = list.iter().map(|h| h.stat(now)).collect();
            let _ = self.events.send(EngineEvent::SourcesUpdated {
                task_id: task_id.to_string(),
                sources: stats,
            });
        }
    }

    /// proxy 统计广播
    fn push_proxy_stats(&self, task_id: &str) {
        let stats = self.proxy_stat(task_id);
        let _ = self.events.send(EngineEvent::ProxyStats {
            task_id: task_id.to_string(),
            stats,
        });
    }

    // ---------- 播放头与 proxy 统计（pf-proxy 调用） ----------

    /// 播放头锚点更新（proxy /seg 请求驱动）：跳跃 >2 片视为 seek；
    /// 同时节流落库 last_played_at（清理器「正在播放/最久未播放」依据）
    pub async fn note_playhead(&self, task_id: &str, seq: u64) {
        let mut ph = self.playheads.lock().await;
        let seek = matches!(ph.get(task_id), Some(&old) if old.abs_diff(seq) > 2);
        ph.insert(task_id.to_string(), seq);
        drop(ph);
        if seek {
            self.log("info", format!("检测到 seek：播放头跳至分片 {seq}，调度重排"))
                .await;
        }
        // 播放活跃记账（30s 节流）
        let due = {
            let mut lt = self.last_touch.lock().unwrap_or_else(|p| p.into_inner());
            match lt.get(task_id) {
                Some(t) if t.elapsed() < TOUCH_THROTTLE => false,
                _ => {
                    lt.insert(task_id.to_string(), Instant::now());
                    true
                }
            }
        };
        if due {
            self.store.touch_played(task_id, now_ms() as i64);
        }
    }

    pub fn stat_proxy_hit(&self, task_id: &str, bytes: usize) {
        let mut m = self.pstats.lock().unwrap_or_else(|p| p.into_inner());
        let s = m.entry(task_id.to_string()).or_default();
        s.cache_hits += 1;
        s.bytes_served += bytes as u64;
    }

    pub fn stat_proxy_fetch(&self, task_id: &str, bytes: usize) {
        let mut m = self.pstats.lock().unwrap_or_else(|p| p.into_inner());
        let s = m.entry(task_id.to_string()).or_default();
        s.origin_fetches += 1;
        s.bytes_served += bytes as u64;
    }

    pub fn proxy_stat(&self, task_id: &str) -> ProxyStat {
        *self
            .pstats
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(task_id)
            .unwrap_or(&ProxyStat::default())
    }

    // ---------- AES-128 本地解密 ----------

    /// 按分片 KEY 解密（仅 AES-128；SAMPLE-AES/无加密原样返回）
    pub async fn decrypt_for(
        &self,
        task_id: &str,
        seg: &Segment,
        data: &[u8],
    ) -> Result<Vec<u8>, String> {
        let Some(k) = &seg.key else {
            return Ok(data.to_vec());
        };
        if !k.method.eq_ignore_ascii_case("AES-128") {
            return Ok(data.to_vec());
        }
        let key = self.key_bytes(task_id, &k.uri).await?;
        let iv = crypto::iv_from(k.iv.as_deref(), seg.seq)?;
        crypto::decrypt_aes128(data, &key, &iv)
    }

    /// 拉取并缓存 16B 解密 key
    async fn key_bytes(&self, task_id: &str, uri: &str) -> Result<[u8; 16], String> {
        {
            let cache = self.keys_cache.lock().await;
            if let Some(k) = cache.get(&(task_id.to_string(), uri.to_string())) {
                return Ok(*k);
            }
        }
        let resp = self
            .http()
            .get(uri)
            .send()
            .await
            .map_err(|e| format!("key 拉取失败 {uri}: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("key 拉取 HTTP {} {uri}", resp.status()));
        }
        let bytes = resp.bytes().await.map_err(|e| format!("key 读取失败: {e}"))?;
        if bytes.len() != 16 {
            return Err(format!("key 长度非法: {}（应 16B）", bytes.len()));
        }
        let mut key = [0u8; 16];
        key.copy_from_slice(&bytes);
        self.keys_cache
            .lock()
            .await
            .insert((task_id.to_string(), uri.to_string()), key);
        Ok(key)
    }

    /// 分片落盘（引擎与 proxy tee 共用）：写临时文件 → 原子改名 → SQLite 标记 done
    pub fn store_segment(
        &self,
        task_id: &str,
        seq: u64,
        bytes: &[u8],
        tag: &str,
    ) -> Result<(), String> {
        let dir = self.store.cache_dir().join(task_id);
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建任务目录失败: {e}"))?;
        let final_path = self.store.segment_path(task_id, seq);
        let part = dir.join(format!("{seq:08}.{tag}.part"));
        std::fs::write(&part, bytes).map_err(|e| format!("写分片失败: {e}"))?;
        if final_path.exists() {
            let _ = std::fs::remove_file(&final_path);
        }
        std::fs::rename(&part, &final_path).map_err(|e| format!("重命名分片失败: {e}"))?;
        self.store.mark_segment(
            task_id,
            seq,
            "done",
            Some(bytes.len() as u64),
            Some(final_path.to_string_lossy().as_ref()),
            0,
        );
        Ok(())
    }

    // ---------- pf-proxy 查询接口 ----------

    /// 主源 MediaIR（playlist 重写用；分片已本地解密）
    pub async fn media_ir(&self, task_id: &str) -> Option<MediaIR> {
        self.media.lock().await.get(task_id).map(|ss| ss.primary.clone())
    }

    /// 任务源 URL（master playlist 透传重取用）
    pub async fn task_url(&self, task_id: &str) -> Option<String> {
        self.tasks.lock().await.get(task_id).map(|t| t.url.clone())
    }

    pub async fn segment_uri(&self, task_id: &str, seq: u64) -> Option<String> {
        let media = self.media.lock().await;
        let ss = media.get(task_id)?;
        let track = ss.primary.tracks.first()?;
        track.segments.iter().find(|s| s.seq == seq).map(|s| s.uri.clone())
    }

    /// 任务内去重后的解密 key 列表（SAMPLE-AES 等未本地解密场景由 /key 透传）
    pub async fn keys(&self, task_id: &str) -> Vec<KeyInfo> {
        let media = self.media.lock().await;
        let Some(ss) = media.get(task_id) else { return Vec::new() };
        let mut out: Vec<KeyInfo> = Vec::new();
        if let Some(track) = ss.primary.tracks.first() {
            for seg in &track.segments {
                // AES-128 已本地解密，无需下发 key
                if let Some(k) = &seg.key {
                    if !k.method.eq_ignore_ascii_case("AES-128") && !out.contains(k) {
                        out.push(k.clone());
                    }
                }
            }
        }
        out
    }

    /// 读取已落盘分片内容（缓存命中路径；P2 起落盘均为明文）
    pub fn read_segment(&self, task_id: &str, seq: u64) -> Option<Vec<u8>> {
        std::fs::read(self.store.segment_path(task_id, seq)).ok()
    }

    /// 分片回源信息：绝对 URL + byterange（保留给 /key 等直连场景）
    pub async fn segment_source(
        &self,
        task_id: &str,
        seq: u64,
    ) -> Option<(String, Option<(u64, u64)>)> {
        let media = self.media.lock().await;
        let ss = media.get(task_id)?;
        let track = ss.primary.tracks.first()?;
        track
            .segments
            .iter()
            .find(|s| s.seq == seq)
            .map(|s| (s.uri.clone(), s.byterange))
    }
}

/// 镜像对齐校验：分片数一致且时长差 ≤ max(10%, 1s)（HLS 禁止跨源混拼的前提）
fn aligns(a: &MediaIR, b: &MediaIR) -> bool {
    let sa = a.tracks.first().map(|t| t.segments.len()).unwrap_or(0);
    let sb = b.tracks.first().map(|t| t.segments.len()).unwrap_or(0);
    if sa == 0 || sa != sb {
        return false;
    }
    let da = a.total_duration.unwrap_or(0.0);
    let db = b.total_duration.unwrap_or(0.0);
    (da - db).abs() <= (da * ALIGN_TOLERANCE).max(1.0)
}

/// 带 Range 的 GET（BYTERANGE 单文件变体必须带 Range，否则整文件下载）
async fn fetch_range(
    client: &reqwest::Client,
    url: &str,
    byterange: Option<(u64, u64)>,
) -> Result<Vec<u8>, String> {
    let mut req = client.get(url);
    if let Some((off, len)) = byterange {
        req = req.header("Range", format!("bytes={off}-{}", off + len - 1));
    }
    let resp = req.send().await.map_err(|e| format!("请求失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("读取失败: {e}"))?;
    Ok(bytes.to_vec())
}

/// playUrl 格式：http://127.0.0.1:{port}/m3u8/{token}/{task_id}/playlist.m3u8
pub fn build_play_url(proxy: &ProxyInfo, task_id: &str) -> String {
    format!(
        "http://127.0.0.1:{}/m3u8/{}/{}/playlist.m3u8",
        proxy.port, proxy.token, task_id
    )
}

/// masterUrl 格式（P3 mpv 轨道选择）：http://127.0.0.1:{port}/m3u8/{token}/{task_id}/master.m3u8
pub fn build_master_url(proxy: &ProxyInfo, task_id: &str) -> String {
    format!(
        "http://127.0.0.1:{}/m3u8/{}/{}/master.m3u8",
        proxy.port, proxy.token, task_id
    )
}

/// MP4 虚拟文件 URL（P4）：http://127.0.0.1:{port}/file/{token}/{task_id}
/// 按客户端 Range 组装：已下载块读盘、未下载块同步回源（DESIGN §4.3）
pub fn build_file_url(proxy: &ProxyInfo, task_id: &str) -> String {
    format!(
        "http://127.0.0.1:{}/file/{}/{}",
        proxy.port, proxy.token, task_id
    )
}

/// 直链媒体解析失败时的处置建议：把裸 HTTP 状态码变成用户能照做的结论。
fn media_error_hint(err: &str) -> String {
    if err.contains("HTTP 403") {
        format!("{err}（源站 403：该 CDN 对直连做了防盗链/风控，多为临时性拦截 —— 换源或稍后重试；若长期如此请改用该片的其它播放源）")
    } else if err.contains("HTTP 404") || err.contains("HTTP 410") {
        format!("{err}（源站已无此文件：多半是采集站数据滞后/已下架，换源重试）")
    } else if err.contains("HTTP 5") {
        format!("{err}（源站 5xx：CDN 边缘节点故障，稍后重试或换源）")
    } else {
        err.to_string()
    }
}

/// HLS 判定（master 透传仅对 HLS 有意义）
fn protocol_is_hls(url: &str) -> bool {
    pf_parser::detect(url) == pf_parser::Protocol::Hls
}

/// 协议 → DB protocol 列字符串（与 shared TS 小写枚举一致）
fn protocol_str(p: pf_parser::Protocol) -> &'static str {
    match p {
        pf_parser::Protocol::Hls => "hls",
        pf_parser::Protocol::Dash => "dash",
        pf_parser::Protocol::Mp4 => "mp4",
        pf_parser::Protocol::Unknown => "unknown",
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// 本地随机 hex（P9b 网盘账号 id / shim 密钥）：用 OS 熵播种的 RandomState，
/// 不为一个短标识引入额外随机数依赖。
pub fn rand_hex(len: usize) -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::with_capacity(len + 16);
    while out.len() < len {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos());
        h.write_u64(rand_hex_counter());
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out.truncate(len);
    out
}

/// 同纳秒内多次取值时的去重计数
fn rand_hex_counter() -> u64 {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    SEQ.fetch_add(0x9E37_79B9_7F4A_7C15, Ordering::Relaxed)
}

/// ISO8601（UTC，毫秒精度）
fn iso_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// epoch ms → ISO8601（retain_until 序列化用）
fn iso_from_ms(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// 播完 TTL：保留天数 → 保留毫秒数（负数/NaN 视为永久 → None）
fn retain_ms(days: f64) -> Option<i64> {
    if !days.is_finite() || days < 0.0 {
        None
    } else {
        Some((days * 86_400_000.0) as i64)
    }
}

/// 调度窗口谓词（P2.5 三档差异的核心）：
/// · stream：只调度播放头窗口（前向 ≤14 片起播缓冲，回看 ≤7 片）；
///   无锚点（尚未起播）按 seq 0 开窗，保证起播缓冲先行。
/// · precache：全量在窗（priority 分级保证播放头附近恒优先）。
/// · online：不进调度（job 根本不启动，防御性返回 false）。
/// · P4：live 直播无「全量」概念（playlist 滑动刷新），precache 退化为 stream 窗口。
fn in_schedule_window(seq: u64, anchor: Option<u64>, mode: CacheMode, live: bool) -> bool {
    let mode = if live && mode == CacheMode::Precache {
        CacheMode::Stream
    } else {
        mode
    };
    match mode {
        CacheMode::Online => false,
        CacheMode::Precache => true,
        CacheMode::Stream => {
            let a = anchor.unwrap_or(0);
            seq + 7 >= a && seq <= a + 14
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pf_parser::{Track, TrackKind};

    fn temp_store(tag: &str) -> (CacheStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!("pf-engine-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store =
            CacheStore::open(&dir.join("core.db"), dir.join("cache")).expect("open store");
        (store, dir)
    }

    fn seg(seq: u64, dur: f64, uri: &str) -> Segment {
        Segment {
            seq,
            duration: dur,
            uri: uri.to_string(),
            byterange: None,
            key: None,
        }
    }

    fn ir(segs: Vec<Segment>, dur: f64) -> MediaIR {
        MediaIR {
            tracks: vec![Track {
                kind: TrackKind::Video,
                bandwidth: None,
                resolution: None,
                codecs: None,
                segments: segs,
            }],
            live: false,
            total_duration: Some(dur),
            map_uri: None,
        }
    }

    #[test]
    fn store_roundtrip_and_progress() {
        let (store, dir) = temp_store("roundtrip");
        store
            .upsert_task("t1", "https://a.com/x.m3u8", Some("测试"), "hls", "downloading", false, Some(10.0), "stream", &iso_now())
            .unwrap();
        assert_eq!(store.find_task_id_by_url("https://a.com/x.m3u8").unwrap(), Some("t1".into()));
        let segs: Vec<Segment> = (0..4)
            .map(|i| seg(i, 2.5, &format!("https://a.com/seg{i}.ts")))
            .collect();
        store.upsert_segments("t1", &segs).unwrap();
        let (d, t, b) = store.progress("t1");
        assert_eq!((d, t, b), (0, 4, 0));
        store.mark_segment("t1", 0, "done", Some(100), Some("p"), 0);
        store.mark_segment("t1", 3, "failed", None, None, 3);
        assert_eq!(store.done_seqs("t1").unwrap(), HashSet::from([0]));
        assert_eq!(store.count_failed("t1"), 1);
        let (d, _t, b) = store.progress("t1");
        assert_eq!((d, b), (1, 100));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn segment_path_is_idempotent() {
        let (store, dir) = temp_store("path");
        let p = store.segment_path("t1", 7);
        assert!(p.ends_with(r"t1\00000007.bin") || p.to_string_lossy().ends_with("t1/00000007.bin"));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn sources_roundtrip() {
        let (store, dir) = temp_store("sources");
        store.set_sources("t1", &["https://b/1.m3u8".into(), "https://c/1.m3u8".into()]).unwrap();
        assert_eq!(
            store.sources_of("t1"),
            vec!["https://b/1.m3u8".to_string(), "https://c/1.m3u8".to_string()]
        );
        // 全量重建
        store.set_sources("t1", &["https://d/1.m3u8".into()]).unwrap();
        assert_eq!(store.sources_of("t1"), vec!["https://d/1.m3u8".to_string()]);
        assert!(store.sources_of("t2").is_empty());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn play_url_format() {
        let proxy = ProxyInfo { port: 50000, token: "tok".into() };
        assert_eq!(
            build_play_url(&proxy, "t1"),
            "http://127.0.0.1:50000/m3u8/tok/t1/playlist.m3u8"
        );
    }

    #[test]
    fn alignment_checks() {
        let a = ir((0..4).map(|i| seg(i, 4.0, "u")).collect(), 16.0);
        // 完全一致
        assert!(aligns(&a, &a));
        // 分片数不同
        let b = ir((0..3).map(|i| seg(i, 4.0, "u")).collect(), 12.0);
        assert!(!aligns(&a, &b));
        // 时长差超容差
        let c = ir((0..4).map(|i| seg(i, 6.0, "u")).collect(), 24.0);
        assert!(!aligns(&a, &c));
        // 时长差在容差内（10%）
        let d = ir((0..4).map(|i| seg(i, 4.2, "u")).collect(), 16.8);
        assert!(aligns(&a, &d));
    }

    #[test]
    fn decrypt_roundtrip_with_media_ir() {
        // 端到端：构造 KeyInfo → 手工加密 → decrypt_for 走 seq 派生 IV
        let key = [3u8; 16];
        let iv = [4u8; 16];
        let plain = b"PolyFrame AES segment payload".to_vec();
        let ct = {
            use cbc::cipher::{BlockEncryptMut, KeyIvInit, block_padding::Pkcs7};
            type Enc = cbc::Encryptor<aes::Aes128>;
            Enc::new((&key).into(), (&iv).into()).encrypt_padded_vec_mut::<Pkcs7>(&plain)
        };
        let mut s = seg(0, 4.0, "https://a/0.ts");
        s.key = Some(KeyInfo {
            method: "AES-128".into(),
            uri: "https://a/key.bin".into(),
            iv: Some("0x04040404040404040404040404040404".into()),
        });
        let (store, dir) = temp_store("crypto");
        let tm = TaskManager::new(store);
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            // key 未拉取前无法解密；直接注入缓存模拟已拉取
            tm.keys_cache.lock().await.insert(
                ("t1".to_string(), "https://a/key.bin".to_string()),
                key,
            );
            let out = tm.decrypt_for("t1", &s, &ct).await.unwrap();
            assert_eq!(out, plain);
            // 无 key 分片原样返回
            let s2 = seg(1, 4.0, "u");
            assert_eq!(tm.decrypt_for("t1", &s2, &ct).await.unwrap(), ct);
        });
        rt.shutdown_timeout(Duration::from_secs(1));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn iv_defaults_to_media_seq() {
        // 分片 seq=5 且 KEY 无 IV → IV = 5（big-endian）
        let iv = crypto::iv_from(None, 5).unwrap();
        assert_eq!(iv[15], 5);
        assert!(iv[..15].iter().all(|&b| b == 0));
    }

    #[test]
    fn schedule_window_by_mode() {
        // stream：无锚点按 0 开窗（起播缓冲）
        assert!(in_schedule_window(0, None, CacheMode::Stream, false));
        assert!(in_schedule_window(14, None, CacheMode::Stream, false));
        assert!(!in_schedule_window(15, None, CacheMode::Stream, false));
        // stream：锚点 100 → 回看 ≥93、前向 ≤114
        assert!(in_schedule_window(93, Some(100), CacheMode::Stream, false));
        assert!(!in_schedule_window(92, Some(100), CacheMode::Stream, false));
        assert!(in_schedule_window(114, Some(100), CacheMode::Stream, false));
        assert!(!in_schedule_window(115, Some(100), CacheMode::Stream, false));
        // precache：全量在窗
        assert!(in_schedule_window(999, None, CacheMode::Precache, false));
        // online：不进调度
        assert!(!in_schedule_window(0, None, CacheMode::Online, false));
        // P4 live：precache 退化为 stream 窗口（直播无全量预取概念）
        assert!(!in_schedule_window(999, Some(100), CacheMode::Precache, true));
        assert!(in_schedule_window(114, Some(100), CacheMode::Precache, true));
        // live 不影响 stream/online 语义
        assert!(in_schedule_window(114, Some(100), CacheMode::Stream, true));
        assert!(!in_schedule_window(0, None, CacheMode::Online, true));
    }

    #[test]
    fn cache_mode_roundtrip_and_retain() {
        assert_eq!(CacheMode::from_str("online"), Some(CacheMode::Online));
        assert_eq!(CacheMode::from_str("stream"), Some(CacheMode::Stream));
        assert_eq!(CacheMode::from_str("precache"), Some(CacheMode::Precache));
        assert_eq!(CacheMode::from_str("xxx"), None);
        assert_eq!(CacheMode::Precache.as_str(), "precache");
        // TTL 换算：1 天 / 0 天 / 永久
        assert_eq!(retain_ms(1.0), Some(86_400_000));
        assert_eq!(retain_ms(0.0), Some(0));
        assert_eq!(retain_ms(-1.0), None);
        assert_eq!(retain_ms(f64::INFINITY), None);
    }

    // ---------- P6 IDM 动态分段 ----------

    fn todo_set(v: &[u64]) -> BTreeSet<u64> {
        v.iter().copied().collect()
    }

    /// IDM 认领源：窗口内最大连续 run（precache 全量在窗）
    #[test]
    fn idm_largest_run() {
        // precache：整段连续 → 全量一个 run
        let todo = todo_set(&(0..256).collect::<Vec<_>>());
        assert_eq!(largest_window_run(&todo, None, CacheMode::Precache, false), Some((0, 256)));
        // 断裂 run 取最长：[0,3) 长 3 > [10,12) 长 2 > 单点
        let todo = todo_set(&[0, 1, 2, 10, 11, 20]);
        assert_eq!(largest_window_run(&todo, None, CacheMode::Precache, false), Some((0, 3)));
        // stream 窗口过滤：锚点 100 → 只看 [93, 114]
        let todo = todo_set(&(0..256).collect::<Vec<_>>());
        assert_eq!(largest_window_run(&todo, Some(100), CacheMode::Stream, false), Some((93, 115)));
        // 窗口内全空 → None
        let todo = todo_set(&[200, 300]);
        assert_eq!(largest_window_run(&todo, Some(100), CacheMode::Stream, false), None);
        // 空 todo → None
        assert_eq!(largest_window_run(&todo_set(&[]), None, CacheMode::Precache, false), None);
    }

    /// IDM 认领块：CAS 游标逐片取件 + 空闲窃取对半分接管
    #[test]
    fn idm_claim_and_steal() {
        let c = Claim::new(10, 20);
        assert_eq!(c.take_next(), Some(10));
        assert_eq!(c.take_next(), Some(11));
        assert_eq!(c.remaining(), 8);
        // 窃取：剩余 8 ≥ 4 → 对半分，原块 [12, 16)，新块 [16, 20)
        let stolen = try_steal_claim(std::slice::from_ref(&c), IDM_STEAL_MIN).unwrap();
        assert_eq!(c.stop_at.load(Ordering::Relaxed), 16);
        assert_eq!(c.remaining(), 4);
        assert_eq!(stolen.take_next(), Some(16));
        // 原块耗尽
        assert_eq!(c.take_next(), Some(12));
        assert_eq!(c.take_next(), Some(13));
        assert_eq!(c.take_next(), Some(14));
        assert_eq!(c.take_next(), Some(15));
        assert_eq!(c.take_next(), None);
        // 新块耗尽
        let got: Vec<u64> = std::iter::from_fn(|| stolen.take_next()).collect();
        assert_eq!(got, vec![17, 18, 19]);
        // 剩余不足不窃取
        let small = Claim::new(0, 3);
        assert!(try_steal_claim(std::slice::from_ref(&small), IDM_STEAL_MIN).is_none());
    }

    #[test]
    fn finished_ttl_and_lru_queries() {
        let (store, dir) = temp_store("ttl");
        let now: i64 = 1_800_000_000_000; // 固定「当前时间」
        store
            .upsert_task("t1", "u1", None, "hls", "ready", false, None, "stream", &iso_now())
            .unwrap();
        // 播完 + 1 天保留：未到期不删、到期删除
        store.mark_finished("t1", now - 86_400_000, Some(now - 1000));
        assert_eq!(store.expired_finished_tasks(now, PLAYING_WINDOW_MS), vec!["t1".to_string()]);
        // 未到期
        store.mark_finished("t1", now, Some(now + 86_400_000));
        assert!(store.expired_finished_tasks(now, PLAYING_WINDOW_MS).is_empty());
        // 刚播放过（保护窗口内）→ 不删
        store.mark_finished("t1", now - 86_400_000, Some(now - 1000));
        store.touch_played("t1", now - 1000);
        assert!(store.expired_finished_tasks(now, PLAYING_WINDOW_MS).is_empty());

        // 未播完 LRU：14 天未动
        store
            .upsert_task("t2", "u2", None, "hls", "downloading", false, None, "stream", &iso_now())
            .unwrap();
        store.touch_played("t2", now); // 活跃中，不受 LRU 影响
        let old_iso = iso_from_ms(now - 15 * 86_400_000);
        store
            .upsert_task("t3", "u3", None, "hls", "downloading", false, None, "stream", &old_iso)
            .unwrap();
        assert_eq!(store.stale_unfinished_tasks(now, (UNFINISHED_TTL_DAYS * 86_400_000.0) as i64), vec!["t3".to_string()]);

        // 容量 LRU 候选：bytes 聚合 + activity（last_played_at 优先）
        let segs: Vec<Segment> = (0..2).map(|i| seg(i, 4.0, "u")).collect();
        store.upsert_segments("t1", &segs).unwrap();
        store.mark_segment("t1", 0, "done", Some(500), Some("p"), 0);
        store.mark_segment("t1", 1, "done", Some(300), Some("p"), 0);
        let rows = store.task_bytes_by_activity();
        let t1 = rows.iter().find(|(id, _, _)| id == "t1").unwrap();
        assert_eq!(t1.1, 800);
        assert_eq!(t1.2, now - 1000); // last_played_at
        let t3 = rows.iter().find(|(id, _, _)| id == "t3").unwrap();
        assert_eq!(t3.2, now - 15 * 86_400_000); // created_at 兜底

        // series 挂接 + 级联删除
        store.upsert_series("s1", Some("剧集")).unwrap();
        store.attach_task_series("t1", "s1", 0).unwrap();
        store.mark_segment("t1", 0, "done", Some(500), Some("p"), 0);
        store.delete_task_cascade("t1");
        assert!(store.find_task_id_by_url("u1").unwrap().is_none());
        assert!(store.task_bytes_by_activity().iter().all(|(id, _, _)| id != "t1"));
        std::fs::remove_dir_all(dir).ok();
    }
}
