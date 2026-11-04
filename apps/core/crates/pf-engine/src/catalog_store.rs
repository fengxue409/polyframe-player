//! P7 影视发现与片源聚合：目录存储（catalog_sources / favorites / favorite_sources）
//!
//! 与 pf-core 的 catalog 编排分离：本模块只做 SQLite CRUD（纯同步、可单测）。
//! 聚合去重匹配（normalize(name)+year）复用 pf_parser::cms::aggregate_key。

use rusqlite::OptionalExtension;

use crate::CacheStore;
use crate::iso_now;
use pf_parser::cms::aggregate_key;

// ---------- 行模型（serde camelCase，与 packages/shared 同构） ----------

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSourceRow {
    pub id: String,
    pub name: String,
    pub api: String,
    pub enabled: bool,
    pub builtin: bool,
    pub latency_ms: Option<i64>,
    pub last_ok_at: Option<i64>,
    pub created_at: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteRow {
    pub id: String,
    pub name: String,
    pub year: Option<String>,
    pub type_name: Option<String>,
    pub remarks: Option<String>,
    pub poster: Option<String>,
    pub content: Option<String>,
    /// 收录片源数（读时 COUNT 子查询实时计算）
    pub source_count: i64,
    pub created_at: String,
    pub last_played_at: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteSourceRow {
    pub id: String,
    pub favorite_id: String,
    pub site_name: String,
    pub api: Option<String>,
    pub vod_id: Option<String>,
    /// 剧集快照 JSON：[{"name":"第01集","url":"https://..."}]
    pub episodes: String,
    pub remarks: Option<String>,
    /// 该站封面（P33：同片多站各有海报，前端按视频聚合后作为多张缩略图）
    pub poster: Option<String>,
    /// search = 搜索收藏带入；manual = 手动补充
    pub origin: String,
    pub added_at: String,
}

/// P9 观看进度行（每收藏一条，继续观看用）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchProgressRow {
    pub favorite_id: String,
    pub favorite_name: String,
    pub year: Option<String>,
    pub poster: Option<String>,
    pub episode_name: String,
    pub episode_url: String,
    pub position_sec: f64,
    pub duration_sec: f64,
    pub updated_at: i64,
}

/// P26 历史播放记录行（按「片」去重：同一影片只留最近一集）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayHistoryRow {
    /// 去重键（有来源站时 `vod|api|vodId`，否则归一化后的 URL）
    pub key: String,
    pub title: String,
    pub episode_name: String,
    pub episode_url: String,
    pub site_name: Option<String>,
    pub api: Option<String>,
    pub vod_id: Option<String>,
    pub poster: Option<String>,
    /// 剧集快照 JSON（CatalogEpisodeGroup[]）：续播不用重新回源
    pub groups: String,
    pub group_index: i64,
    pub position_sec: f64,
    pub duration_sec: f64,
    /// 最近播放时间（Unix ms）
    pub played_at: i64,
}

/// 写入/更新历史记录入参（position/duration 为 None 时保留旧值）
#[derive(Debug, Clone, Default)]
pub struct PlayHistoryRecord {
    pub key: String,
    pub title: String,
    pub episode_name: String,
    pub episode_url: String,
    pub site_name: Option<String>,
    pub api: Option<String>,
    pub vod_id: Option<String>,
    pub poster: Option<String>,
    pub groups: String,
    pub group_index: i64,
    pub position_sec: Option<f64>,
    pub duration_sec: Option<f64>,
}

/// 目录表 schema（随 CacheStore::open 一起执行）
pub const CATALOG_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS catalog_sources(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  builtin INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  last_ok_at INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS favorites(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  year TEXT,
  type_name TEXT,
  remarks TEXT,
  poster TEXT,
  content TEXT,
  created_at TEXT NOT NULL,
  last_played_at INTEGER
);
CREATE TABLE IF NOT EXISTS favorite_sources(
  id TEXT PRIMARY KEY,
  favorite_id TEXT NOT NULL,
  site_name TEXT NOT NULL,
  api TEXT,
  vod_id TEXT,
  episodes TEXT NOT NULL DEFAULT '[]',
  remarks TEXT,
  poster TEXT,
  origin TEXT NOT NULL DEFAULT 'search',
  added_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fav_sources_fav ON favorite_sources(favorite_id);
CREATE TABLE IF NOT EXISTS watch_progress(
  favorite_id TEXT PRIMARY KEY,
  episode_name TEXT NOT NULL,
  episode_url TEXT NOT NULL,
  position_sec REAL NOT NULL DEFAULT 0,
  duration_sec REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS play_history(
  hkey TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  episode_name TEXT NOT NULL DEFAULT '',
  episode_url TEXT NOT NULL,
  site_name TEXT,
  api TEXT,
  vod_id TEXT,
  poster TEXT,
  groups TEXT NOT NULL DEFAULT '[]',
  group_index INTEGER NOT NULL DEFAULT 0,
  position_sec REAL NOT NULL DEFAULT 0,
  duration_sec REAL NOT NULL DEFAULT 0,
  played_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_play_history_played ON play_history(played_at DESC);
";

const FAV_BASE: &str = "f.id, f.name, f.year, f.type_name, f.remarks, f.poster, f.content, \
                        f.created_at, f.last_played_at, \
                        (SELECT COUNT(*) FROM favorite_sources s WHERE s.favorite_id = f.id) AS source_count";

impl CacheStore {
    // ---------- 源站（catalog_sources） ----------

    pub fn list_catalog_sources(&self) -> Result<Vec<CatalogSourceRow>, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let mut stmt = conn
            .prepare("SELECT id,name,api,enabled,builtin,latency_ms,last_ok_at,created_at \
                      FROM catalog_sources ORDER BY builtin DESC, created_at ASC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(CatalogSourceRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    api: r.get(2)?,
                    enabled: r.get::<_, i64>(3)? != 0,
                    builtin: r.get::<_, i64>(4)? != 0,
                    latency_ms: r.get(5)?,
                    last_ok_at: r.get(6)?,
                    created_at: r.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    pub fn get_catalog_source_by_api(&self, api: &str) -> Result<Option<CatalogSourceRow>, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.query_row(
            "SELECT id,name,api,enabled,builtin,latency_ms,last_ok_at,created_at \
             FROM catalog_sources WHERE api=?1",
            [api],
            |r| {
                Ok(CatalogSourceRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    api: r.get(2)?,
                    enabled: r.get::<_, i64>(3)? != 0,
                    builtin: r.get::<_, i64>(4)? != 0,
                    latency_ms: r.get(5)?,
                    last_ok_at: r.get(6)?,
                    created_at: r.get(7)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    pub fn get_catalog_source(&self, id: &str) -> Result<Option<CatalogSourceRow>, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.query_row(
            "SELECT id,name,api,enabled,builtin,latency_ms,last_ok_at,created_at \
             FROM catalog_sources WHERE id=?1",
            [id],
            |r| {
                Ok(CatalogSourceRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    api: r.get(2)?,
                    enabled: r.get::<_, i64>(3)? != 0,
                    builtin: r.get::<_, i64>(4)? != 0,
                    latency_ms: r.get(5)?,
                    last_ok_at: r.get(6)?,
                    created_at: r.get(7)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    pub fn insert_catalog_source(
        &self,
        id: &str,
        name: &str,
        api: &str,
        enabled: bool,
        builtin: bool,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "INSERT INTO catalog_sources(id,name,api,enabled,builtin,created_at) \
             VALUES(?1,?2,?3,?4,?5,?6)",
            rusqlite::params![id, name, api, enabled as i64, builtin as i64, iso_now()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 更新源站（None 字段保持原值）；测速成功时顺带刷新 latency/last_ok
    pub fn update_catalog_source(
        &self,
        id: &str,
        name: Option<&str>,
        api: Option<&str>,
        enabled: Option<bool>,
        latency_ms: Option<i64>,
        ok: bool,
    ) -> Result<CatalogSourceRow, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(v) = name {
            conn.execute("UPDATE catalog_sources SET name=?2 WHERE id=?1", rusqlite::params![id, v])
                .map_err(|e| e.to_string())?;
        }
        if let Some(v) = api {
            conn.execute("UPDATE catalog_sources SET api=?2 WHERE id=?1", rusqlite::params![id, v])
                .map_err(|e| e.to_string())?;
        }
        if let Some(v) = enabled {
            conn.execute(
                "UPDATE catalog_sources SET enabled=?2 WHERE id=?1",
                rusqlite::params![id, v as i64],
            )
            .map_err(|e| e.to_string())?;
        }
        if let Some(v) = latency_ms {
            conn.execute(
                "UPDATE catalog_sources SET latency_ms=?2 WHERE id=?1",
                rusqlite::params![id, v],
            )
            .map_err(|e| e.to_string())?;
        }
        if ok {
            conn.execute(
                "UPDATE catalog_sources SET last_ok_at=?2 WHERE id=?1",
                rusqlite::params![id, iso_now_millis()],
            )
            .map_err(|e| e.to_string())?;
        }
        drop(conn);
        self.get_catalog_source(id)?
            .ok_or_else(|| "源站不存在".to_string())
    }

    pub fn delete_catalog_source(&self, id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let n = conn
            .execute("DELETE FROM catalog_sources WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        Ok(n > 0)
    }

    // ---------- 收藏（favorites + favorite_sources） ----------

    fn row_to_fav(r: &rusqlite::Row) -> rusqlite::Result<FavoriteRow> {
        Ok(FavoriteRow {
            id: r.get(0)?,
            name: r.get(1)?,
            year: r.get(2)?,
            type_name: r.get(3)?,
            remarks: r.get(4)?,
            poster: r.get(5)?,
            content: r.get(6)?,
            created_at: r.get(7)?,
            last_played_at: r.get(8)?,
            source_count: r.get(9)?,
        })
    }

    pub fn list_favorites(&self) -> Result<Vec<FavoriteRow>, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {FAV_BASE} FROM favorites f \
                 ORDER BY COALESCE(f.last_played_at, 0) DESC, f.created_at DESC"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], Self::row_to_fav)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    /// 按聚合键（normalize(name)+year）找既有收藏（跨站同名归并）
    pub fn find_favorite_by_key(&self, name: &str, year: &str) -> Result<Option<FavoriteRow>, String> {
        let key = aggregate_key(name, year);
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let mut stmt = conn
            .prepare(&format!("SELECT {FAV_BASE} FROM favorites f"))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], Self::row_to_fav)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows.into_iter().find(|f| {
            aggregate_key(&f.name, f.year.as_deref().unwrap_or("")) == key
        }))
    }

    pub fn get_favorite(&self, id: &str) -> Result<Option<FavoriteRow>, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.query_row(
            &format!("SELECT {FAV_BASE} FROM favorites f WHERE f.id=?1"),
            [id],
            Self::row_to_fav,
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    /// 新建收藏（补齐非空元数据由调用方传入）
    pub fn insert_favorite(
        &self,
        id: &str,
        name: &str,
        year: Option<&str>,
        type_name: Option<&str>,
        remarks: Option<&str>,
        poster: Option<&str>,
        content: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "INSERT INTO favorites(id,name,year,type_name,remarks,poster,content,created_at) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            rusqlite::params![id, name, year, type_name, remarks, poster, content, iso_now()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 收藏元数据补齐（后续详情加载后回填非空字段）
    pub fn update_favorite_meta(
        &self,
        id: &str,
        type_name: Option<&str>,
        remarks: Option<&str>,
        poster: Option<&str>,
        content: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "UPDATE favorites SET \
               type_name = COALESCE(?2, type_name), \
               remarks = COALESCE(?3, remarks), \
               poster = COALESCE(?4, poster), \
               content = COALESCE(?5, content) \
             WHERE id=?1",
            rusqlite::params![id, type_name, remarks, poster, content],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_favorite(&self, id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute("DELETE FROM favorite_sources WHERE favorite_id=?1", [id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM watch_progress WHERE favorite_id=?1", [id])
            .map_err(|e| e.to_string())?;
        let n = conn
            .execute("DELETE FROM favorites WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        Ok(n > 0)
    }

    /// 记录播放（最近播放排序 + 热度展示）
    pub fn touch_favorite_played(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "UPDATE favorites SET last_played_at=?2 WHERE id=?1",
            rusqlite::params![id, iso_now_millis()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    // ---------- 收藏片源（favorite_sources） ----------

    pub fn insert_favorite_source(
        &self,
        id: &str,
        favorite_id: &str,
        site_name: &str,
        api: Option<&str>,
        vod_id: Option<&str>,
        episodes_json: &str,
        remarks: Option<&str>,
        poster: Option<&str>,
        origin: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "INSERT INTO favorite_sources(id,favorite_id,site_name,api,vod_id,episodes,remarks,poster,origin,added_at) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            rusqlite::params![id, favorite_id, site_name, api, vod_id, episodes_json, remarks, poster, origin, iso_now()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 同站同 vodId 片源去重（返回是否已存在）
    pub fn find_favorite_source_by_site(
        &self,
        favorite_id: &str,
        api: &str,
        vod_id: &str,
    ) -> Result<Option<FavoriteSourceRow>, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.query_row(
            "SELECT id,favorite_id,site_name,api,vod_id,episodes,remarks,poster,origin,added_at \
             FROM favorite_sources WHERE favorite_id=?1 AND api=?2 AND vod_id=?3",
            rusqlite::params![favorite_id, api, vod_id],
            |r| {
                Ok(FavoriteSourceRow {
                    id: r.get(0)?,
                    favorite_id: r.get(1)?,
                    site_name: r.get(2)?,
                    api: r.get(3)?,
                    vod_id: r.get(4)?,
                    episodes: r.get(5)?,
                    remarks: r.get(6)?,
                    poster: r.get(7)?,
                    origin: r.get(8)?,
                    added_at: r.get(9)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    /// 更新片源剧集快照（详情加载后回填）
    pub fn update_favorite_source_episodes(
        &self,
        source_id: &str,
        episodes_json: &str,
        remarks: Option<&str>,
        poster: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "UPDATE favorite_sources SET episodes=?2, \
               remarks = COALESCE(?3, remarks), \
               poster = COALESCE(?4, poster) \
             WHERE id=?1",
            rusqlite::params![source_id, episodes_json, remarks, poster],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_favorite_sources(&self, favorite_id: &str) -> Result<Vec<FavoriteSourceRow>, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let mut stmt = conn
            .prepare(
                "SELECT id,favorite_id,site_name,api,vod_id,episodes,remarks,poster,origin,added_at \
                 FROM favorite_sources WHERE favorite_id=?1 ORDER BY added_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([favorite_id], |r| {
                Ok(FavoriteSourceRow {
                    id: r.get(0)?,
                    favorite_id: r.get(1)?,
                    site_name: r.get(2)?,
                    api: r.get(3)?,
                    vod_id: r.get(4)?,
                    episodes: r.get(5)?,
                    remarks: r.get(6)?,
                    poster: r.get(7)?,
                    origin: r.get(8)?,
                    added_at: r.get(9)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    pub fn delete_favorite_source(&self, source_id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let n = conn
            .execute("DELETE FROM favorite_sources WHERE id=?1", [source_id])
            .map_err(|e| e.to_string())?;
        Ok(n > 0)
    }

    // ---------- 观看进度（watch_progress，P9 继续观看） ----------

    /// 记录/更新观看进度（每收藏一条，INSERT OR REPLACE 覆盖）
    pub fn set_watch_progress(
        &self,
        favorite_id: &str,
        episode_name: &str,
        episode_url: &str,
        position_sec: f64,
        duration_sec: f64,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "INSERT INTO watch_progress(favorite_id,episode_name,episode_url,position_sec,duration_sec,updated_at) \
             VALUES(?1,?2,?3,?4,?5,?6) \
             ON CONFLICT(favorite_id) DO UPDATE SET \
               episode_name=excluded.episode_name, episode_url=excluded.episode_url, \
               position_sec=excluded.position_sec, duration_sec=excluded.duration_sec, \
               updated_at=excluded.updated_at",
            rusqlite::params![favorite_id, episode_name, episode_url, position_sec, duration_sec, iso_now_millis()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_watch_progress(&self, favorite_id: &str) -> Result<Option<WatchProgressRow>, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let sql = format!("{} WHERE p.favorite_id=?1", Self::WATCH_PROGRESS_SQL);
        conn.query_row(&sql, [favorite_id], Self::row_to_watch)
            .optional()
            .map_err(|e| e.to_string())
    }

    /// 继续观看列表：最近更新的收藏进度（JOIN favorites 补名称/海报）
    pub fn list_watch_progress(&self, limit: u32) -> Result<Vec<WatchProgressRow>, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let sql = format!(
            "{} ORDER BY p.updated_at DESC LIMIT {}",
            Self::WATCH_PROGRESS_SQL,
            limit.max(1)
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], Self::row_to_watch)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    /// 删收藏时级联清进度
    pub fn delete_watch_progress(&self, favorite_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute("DELETE FROM watch_progress WHERE favorite_id=?1", [favorite_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    const WATCH_PROGRESS_SQL: &str = "SELECT p.favorite_id, f.name, f.year, f.poster, \
         p.episode_name, p.episode_url, p.position_sec, p.duration_sec, p.updated_at \
         FROM watch_progress p JOIN favorites f ON f.id = p.favorite_id";
    fn row_to_watch(r: &rusqlite::Row) -> rusqlite::Result<WatchProgressRow> {
        Ok(WatchProgressRow {
            favorite_id: r.get(0)?,
            favorite_name: r.get(1)?,
            year: r.get(2)?,
            poster: r.get(3)?,
            episode_name: r.get(4)?,
            episode_url: r.get(5)?,
            position_sec: r.get(6)?,
            duration_sec: r.get(7)?,
            updated_at: r.get(8)?,
        })
    }

    // ---------- P26 历史播放记录（play_history） ----------

    /// 记录/更新历史：同一 key 覆盖（换集只更新），position/duration 为 None 时保留旧值
    pub fn upsert_play_history(&self, rec: &PlayHistoryRecord) -> Result<PlayHistoryRow, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let played_at = iso_now_millis();
        let has_pos = i64::from(rec.position_sec.is_some());
        let has_dur = i64::from(rec.duration_sec.is_some());
        conn.execute(
            "INSERT INTO play_history(hkey,title,episode_name,episode_url,site_name,api,vod_id,poster,groups,group_index,position_sec,duration_sec,played_at) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13) \
             ON CONFLICT(hkey) DO UPDATE SET \
               title=excluded.title, \
               episode_name=excluded.episode_name, \
               episode_url=excluded.episode_url, \
               site_name=COALESCE(excluded.site_name, play_history.site_name), \
               api=COALESCE(excluded.api, play_history.api), \
               vod_id=COALESCE(excluded.vod_id, play_history.vod_id), \
               poster=COALESCE(excluded.poster, play_history.poster), \
               groups=CASE WHEN excluded.groups='[]' THEN play_history.groups ELSE excluded.groups END, \
               group_index=excluded.group_index, \
               position_sec=CASE WHEN ?14=1 THEN excluded.position_sec ELSE play_history.position_sec END, \
               duration_sec=CASE WHEN ?15=1 THEN excluded.duration_sec ELSE play_history.duration_sec END, \
               played_at=excluded.played_at",
            rusqlite::params![
                rec.key,
                rec.title,
                rec.episode_name,
                rec.episode_url,
                rec.site_name,
                rec.api,
                rec.vod_id,
                rec.poster,
                rec.groups,
                rec.group_index,
                rec.position_sec.unwrap_or(0.0),
                rec.duration_sec.unwrap_or(0.0),
                played_at,
                has_pos,
                has_dur,
            ],
        )
        .map_err(|e| e.to_string())?;
        conn.query_row(
            &format!("{} WHERE hkey=?1", Self::PLAY_HISTORY_SQL),
            [rec.key.as_str()],
            Self::row_to_history,
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "历史记录写入后读回失败".to_string())
    }

    /// 只刷进度（进度上报高频路径，不重复写元数据）；行不存在返回 None
    pub fn update_play_history_progress(
        &self,
        key: &str,
        position_sec: f64,
        duration_sec: f64,
    ) -> Result<Option<PlayHistoryRow>, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "UPDATE play_history SET position_sec=?2, duration_sec=?3, played_at=?4 WHERE hkey=?1",
            rusqlite::params![key, position_sec, duration_sec, iso_now_millis()],
        )
        .map_err(|e| e.to_string())?;
        conn.query_row(
            &format!("{} WHERE hkey=?1", Self::PLAY_HISTORY_SQL),
            [key],
            Self::row_to_history,
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    pub fn get_play_history(&self, key: &str) -> Result<Option<PlayHistoryRow>, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.query_row(
            &format!("{} WHERE hkey=?1", Self::PLAY_HISTORY_SQL),
            [key],
            Self::row_to_history,
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    /// 历史列表（最近播放倒序）+ 总条数（分页用）
    pub fn list_play_history(
        &self,
        limit: u32,
        offset: u32,
    ) -> Result<(Vec<PlayHistoryRow>, i64), String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM play_history", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let sql = format!(
            "{} ORDER BY played_at DESC LIMIT {} OFFSET {}",
            Self::PLAY_HISTORY_SQL,
            limit.max(1),
            offset
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], Self::row_to_history)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok((rows, total))
    }

    pub fn delete_play_history(&self, key: &str) -> Result<bool, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let n = conn
            .execute("DELETE FROM play_history WHERE hkey=?1", [key])
            .map_err(|e| e.to_string())?;
        Ok(n > 0)
    }

    /// 清空历史，返回删除条数
    pub fn clear_play_history(&self) -> Result<u32, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let n = conn
            .execute("DELETE FROM play_history", [])
            .map_err(|e| e.to_string())?;
        Ok(n as u32)
    }

    const PLAY_HISTORY_SQL: &str = "SELECT hkey,title,episode_name,episode_url,site_name,api,\
         vod_id,poster,groups,group_index,position_sec,duration_sec,played_at FROM play_history";

    fn row_to_history(r: &rusqlite::Row) -> rusqlite::Result<PlayHistoryRow> {
        Ok(PlayHistoryRow {
            key: r.get(0)?,
            title: r.get(1)?,
            episode_name: r.get(2)?,
            episode_url: r.get(3)?,
            site_name: r.get(4)?,
            api: r.get(5)?,
            vod_id: r.get(6)?,
            poster: r.get(7)?,
            groups: r.get(8)?,
            group_index: r.get(9)?,
            position_sec: r.get(10)?,
            duration_sec: r.get(11)?,
            played_at: r.get(12)?,
        })
    }
}

fn iso_now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> CacheStore {
        // 每个用例独立目录：多个 case 并行跑时会互相 remove_dir_all，导致 "readonly database"
        static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("pf-cat-test-{}-{}", std::process::id(), n));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        CacheStore::open(&dir.join("t.db"), dir.join("cache")).unwrap()
    }

    #[test]
    fn test_catalog_source_crud() {
        let s = store();
        assert!(s.list_catalog_sources().unwrap().is_empty());

        s.insert_catalog_source("s1", "内置源", "https://a/api", true, true).unwrap();
        // 同 api 幂等（UNIQUE 冲突由调用方 via get_by_api 预检）
        assert!(s.get_catalog_source_by_api("https://a/api").unwrap().is_some());
        assert!(s.get_catalog_source_by_api("https://x/api").unwrap().is_none());

        let updated = s
            .update_catalog_source("s1", Some("改名"), None, Some(false), Some(123), true)
            .unwrap();
        assert_eq!(updated.name, "改名");
        assert!(!updated.enabled);
        assert_eq!(updated.latency_ms, Some(123));
        assert!(updated.last_ok_at.is_some());

        assert!(s.delete_catalog_source("s1").unwrap());
        assert!(!s.delete_catalog_source("s1").unwrap());
    }

    #[test]
    fn test_favorite_merge_and_sources() {
        let s = store();
        // 两个站同名影片 → 归并到同一收藏
        s.insert_favorite("f1", "流浪地球", Some("2023"), Some("科幻片"), None, Some("p.jpg"), None)
            .unwrap();
        let found = s.find_favorite_by_key("流浪 地球", "2023").unwrap().unwrap();
        assert_eq!(found.id, "f1");
        // normalize 空白后命中
        assert_eq!(s.find_favorite_by_key("流浪地球", "2023").unwrap().unwrap().id, "f1");
        // 不同年份不归并
        assert!(s.find_favorite_by_key("流浪地球", "2019").unwrap().is_none());

        let eps = r#"[{"name":"第01集","url":"https://a/1.m3u8"}]"#;
        s.insert_favorite_source("fs1", "f1", "站A", Some("https://a/api"), Some("9"), eps, Some("HD"), Some("a.jpg"), "search")
            .unwrap();
        // 同站同 vod 去重
        assert!(s
            .find_favorite_source_by_site("f1", "https://a/api", "9")
            .unwrap()
            .is_some());
        s.insert_favorite_source("fs2", "f1", "站B", Some("https://b/api"), Some("3"), "[]", None, Some("b.jpg"), "manual")
            .unwrap();
        let fav = s.get_favorite("f1").unwrap().unwrap();
        assert_eq!(fav.source_count, 2);

        s.update_favorite_source_episodes("fs1", "[]", Some("蓝光"), None).unwrap();
        let srcs = s.list_favorite_sources("f1").unwrap();
        assert_eq!(srcs.len(), 2);
        assert_eq!(srcs[0].remarks.as_deref(), Some("蓝光"));
        assert_eq!(srcs[0].origin, "search");
        assert_eq!(srcs[1].origin, "manual");

        s.touch_favorite_played("f1").unwrap();
        assert!(s.get_favorite("f1").unwrap().unwrap().last_played_at.is_some());

        // 元数据补齐：非空才覆盖
        s.update_favorite_meta("f1", None, Some("蓝光60帧"), None, Some("<p>简介</p>")).unwrap();
        let fav = s.get_favorite("f1").unwrap().unwrap();
        assert_eq!(fav.remarks.as_deref(), Some("蓝光60帧"));
        assert_eq!(fav.poster.as_deref(), Some("p.jpg"));

        // 删收藏级删片源
        assert!(s.delete_favorite("f1").unwrap());
        assert!(s.list_favorite_sources("f1").unwrap().is_empty());
        assert!(s.get_favorite("f1").unwrap().is_none());
    }

    #[test]
    fn test_watch_progress() {
        let s = store();
        s.insert_favorite("f1", "流浪地球", Some("2023"), None, None, Some("p.jpg"), None).unwrap();
        s.insert_favorite("f2", "三体", Some("2024"), None, None, None, None).unwrap();
        // 无进度
        assert!(s.get_watch_progress("f1").unwrap().is_none());
        assert!(s.list_watch_progress(20).unwrap().is_empty());

        s.set_watch_progress("f1", "第02集", "https://a/2.m3u8", 300.0, 2700.0).unwrap();
        s.set_watch_progress("f2", "第01集", "https://b/1.m3u8", 60.0, 2400.0).unwrap();
        // 同收藏覆盖（INSERT OR REPLACE）
        s.set_watch_progress("f1", "第02集", "https://a/2.m3u8", 900.0, 2700.0).unwrap();

        let p1 = s.get_watch_progress("f1").unwrap().unwrap();
        assert_eq!(p1.episode_name, "第02集");
        assert!((p1.position_sec - 900.0).abs() < f64::EPSILON);
        assert_eq!(p1.favorite_name, "流浪地球");
        assert_eq!(p1.poster.as_deref(), Some("p.jpg"));

        let list = s.list_watch_progress(20).unwrap();
        assert_eq!(list.len(), 2);
        // 最近更新在前（f1 后写）
        assert_eq!(list[0].favorite_id, "f1");
        // 进度百分比口径交给前端，这里只存秒
        assert!(list[1].duration_sec > list[1].position_sec);

        // 删收藏级联清进度
        s.delete_favorite("f2").unwrap();
        let list = s.list_watch_progress(20).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].favorite_id, "f1");
        s.delete_watch_progress("f1").unwrap();
        assert!(s.list_watch_progress(20).unwrap().is_empty());
    }

    #[test]
    fn test_play_history() {
        let s = store();
        assert_eq!(s.list_play_history(20, 0).unwrap().1, 0);

        // 首次记录：带剧集快照与元数据
        let rec = PlayHistoryRecord {
            key: "vod|https://api.a|42".into(),
            title: "流浪地球".into(),
            episode_name: "第01集".into(),
            episode_url: "https://cdn/1.m3u8".into(),
            site_name: Some("测试站".into()),
            api: Some("https://api.a".into()),
            vod_id: Some("42".into()),
            poster: Some("p.jpg".into()),
            groups: r#"[{"from":"线路一","episodes":[{"name":"第01集","url":"https://cdn/1.m3u8"}]}]"#.into(),
            group_index: 0,
            position_sec: Some(12.0),
            duration_sec: Some(2700.0),
        };
        let row = s.upsert_play_history(&rec).unwrap();
        assert_eq!(row.key, "vod|https://api.a|42");
        assert_eq!(row.episode_name, "第01集");
        assert!((row.position_sec - 12.0).abs() < f64::EPSILON);

        // 换集：同一片覆盖为新集，进度重置为显式 0
        let mut rec2 = rec.clone();
        rec2.episode_name = "第02集".into();
        rec2.episode_url = "https://cdn/2.m3u8".into();
        rec2.position_sec = Some(0.0);
        let row = s.upsert_play_history(&rec2).unwrap();
        assert_eq!(row.episode_name, "第02集");
        assert!((row.position_sec).abs() < f64::EPSILON);
        assert_eq!(s.list_play_history(20, 0).unwrap().1, 1);

        // 进度上报未带元数据也可用（只刷位置，不改集名/海报/快照）
        let upd = s
            .update_play_history_progress(&rec.key, 600.0, 2700.0)
            .unwrap()
            .unwrap();
        assert!((upd.position_sec - 600.0).abs() < f64::EPSILON);
        assert_eq!(upd.episode_name, "第02集");
        assert_eq!(upd.poster.as_deref(), Some("p.jpg"));
        assert!(upd.groups.contains("线路一"));
        // 未知 key 不凭空建行
        assert!(s
            .update_play_history_progress("nope", 1.0, 2.0)
            .unwrap()
            .is_none());
        assert_eq!(s.list_play_history(20, 0).unwrap().1, 1);

        // 无来源站：靠 URL 键去重；再起播不带 groups 时保留旧快照
        let rec3 = PlayHistoryRecord {
            key: "url|https://cdn/x.m3u8".into(),
            title: "直链片".into(),
            episode_url: "https://cdn/x.m3u8".into(),
            groups: "[]".into(),
            ..Default::default()
        };
        s.upsert_play_history(&rec3).unwrap();
        let mut rec4 = rec3.clone();
        rec4.groups = "[]".into();
        s.upsert_play_history(&rec4).unwrap();
        let (list, total) = s.list_play_history(20, 0).unwrap();
        assert_eq!(total, 2);
        assert_eq!(list[0].key, "url|https://cdn/x.m3u8");

        // 分页
        let (page2, _) = s.list_play_history(1, 1).unwrap();
        assert_eq!(page2.len(), 1);
        assert_eq!(page2[0].key, rec.key);

        // 删除 / 清空
        assert!(s.delete_play_history("url|https://cdn/x.m3u8").unwrap());
        assert!(!s.delete_play_history("url|https://cdn/x.m3u8").unwrap());
        assert_eq!(s.clear_play_history().unwrap(), 1);
        assert_eq!(s.list_play_history(20, 0).unwrap().1, 0);
    }
}
