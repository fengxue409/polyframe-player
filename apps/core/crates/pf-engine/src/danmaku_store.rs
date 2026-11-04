//! 弹幕存储（danmaku / danmaku_channels）
//!
//! 只做 SQLite CRUD，不碰网络（网络在 pf-danmaku / pf-core 的 danmaku 模块）。
//!
//! 两个关键设计：
//!  1. **时间存整数毫秒**（`time_ms`）—— 去重键要是 `REAL`，浮点误差会让
//!     `INSERT OR IGNORE` 形同虚设，同一批弹幕每拉一次就多一份；
//!  2. **`UNIQUE(channel, time_ms, text, mode)` 兜底去重** —— 本地重复发送、
//!     第三方源重复条目、多次拉取叠加，三种重复都由 DB 唯一约束统一吸收，
//!     不依赖上层记得去重。

use rusqlite::OptionalExtension;

use crate::CacheStore;
use pf_danmaku::{DanmakuItem, DanmakuMode};

/// 弹幕表 schema（随 CacheStore::open 一起执行）
pub const DANMAKU_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS danmaku(
  channel TEXT NOT NULL,
  id TEXT NOT NULL,
  time_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'scroll',
  color TEXT NOT NULL DEFAULT '#FFFFFF',
  source TEXT NOT NULL DEFAULT 'local',
  ctime INTEGER,
  fx TEXT,
  PRIMARY KEY(channel, id),
  UNIQUE(channel, time_ms, text, mode)
);
CREATE INDEX IF NOT EXISTS idx_danmaku_channel_time ON danmaku(channel, time_ms);
CREATE TABLE IF NOT EXISTS danmaku_channels(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  episode TEXT,
  provider TEXT NOT NULL,
  provider_ep_id TEXT,
  duration REAL,
  item_count INTEGER NOT NULL DEFAULT 0,
  matched_at INTEGER,
  last_fetch_at INTEGER,
  last_error TEXT
);
";

/// 弹幕频道（一次「剧集 ↔ 弹幕库」的绑定关系）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DanmakuChannelRow {
    pub id: String,
    pub title: String,
    pub episode: Option<String>,
    /// local | dandanplay
    pub provider: String,
    pub provider_ep_id: Option<String>,
    /// 该弹幕源对应版本的时长（秒，时间轴缩放基准）
    pub duration: Option<f64>,
    pub item_count: i64,
    pub matched_at: Option<i64>,
    pub last_fetch_at: Option<i64>,
    pub last_error: Option<String>,
}

impl DanmakuChannelRow {
    fn from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            title: r.get(1)?,
            episode: r.get(2)?,
            provider: r.get(3)?,
            provider_ep_id: r.get(4)?,
            duration: r.get(5)?,
            item_count: r.get(6)?,
            matched_at: r.get(7)?,
            last_fetch_at: r.get(8)?,
            last_error: r.get(9)?,
        })
    }
}

const CH_COLS: &str = "id,title,episode,provider,provider_ep_id,duration,item_count,\
                       matched_at,last_fetch_at,last_error";

fn to_ms(sec: f64) -> i64 {
    if sec.is_finite() {
        (sec * 1000.0).round() as i64
    } else {
        0
    }
}

impl CacheStore {
    // ---------- 频道 ----------

    pub fn upsert_danmaku_channel(&self, ch: &DanmakuChannelRow) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "INSERT INTO danmaku_channels(id,title,episode,provider,provider_ep_id,duration,\
                item_count,matched_at,last_fetch_at,last_error) \
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
             ON CONFLICT(id) DO UPDATE SET
                title=excluded.title, episode=excluded.episode, provider=excluded.provider,
                provider_ep_id=excluded.provider_ep_id, duration=excluded.duration,
                matched_at=excluded.matched_at, last_fetch_at=excluded.last_fetch_at,
                last_error=excluded.last_error",
            rusqlite::params![
                ch.id,
                ch.title,
                ch.episode,
                ch.provider,
                ch.provider_ep_id,
                ch.duration,
                ch.item_count,
                ch.matched_at,
                ch.last_fetch_at,
                ch.last_error,
            ],
        )
        .map_err(|e| format!("写弹幕频道失败: {e}"))?;
        Ok(())
    }

    pub fn get_danmaku_channel(&self, id: &str) -> Result<Option<DanmakuChannelRow>, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.query_row(
            &format!("SELECT {CH_COLS} FROM danmaku_channels WHERE id=?1"),
            [id],
            DanmakuChannelRow::from_row,
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    pub fn list_danmaku_channels(&self) -> Result<Vec<DanmakuChannelRow>, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {CH_COLS} FROM danmaku_channels ORDER BY COALESCE(last_fetch_at,0) DESC"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], DanmakuChannelRow::from_row)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    /// 记录拉取结果（成功=清空 last_error；失败=只写错误，不动已有弹幕）
    pub fn touch_danmaku_channel(
        &self,
        id: &str,
        count: i64,
        duration: Option<f64>,
        error: Option<&str>,
        now_ms: i64,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "UPDATE danmaku_channels SET item_count=?2, \
                duration=COALESCE(?3, duration), \
                last_fetch_at=?4, last_error=?5 WHERE id=?1",
            rusqlite::params![id, count, duration, now_ms, error],
        )
        .map_err(|e| format!("更新弹幕频道失败: {e}"))?;
        Ok(())
    }

    pub fn delete_danmaku_channel(&self, id: &str) -> Result<i64, String> {
        let mut conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let removed: i64 = tx
            .execute("DELETE FROM danmaku WHERE channel=?1", [id])
            .map_err(|e| e.to_string())? as i64;
        tx.execute("DELETE FROM danmaku_channels WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(removed)
    }

    // ---------- 弹幕条目 ----------

    /// 批量写入。返回**实际新增**条数（重复条目被唯一约束吃掉，不计入）。
    ///
    /// 单事务写入是并发安全的要点：5000 条逐条 autocommit 会退化成 5000 次 fsync。
    pub fn insert_danmaku_batch(&self, channel: &str, items: &[DanmakuItem]) -> Result<i64, String> {
        if items.is_empty() {
            return Ok(0);
        }
        let mut conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut inserted = 0i64;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT OR IGNORE INTO danmaku(id,channel,time_ms,text,mode,color,source,ctime,fx) \
                     VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                )
                .map_err(|e| e.to_string())?;
            for it in items {
                let n = stmt
                    .execute(rusqlite::params![
                        it.id,
                        channel,
                        to_ms(it.time),
                        it.text,
                        it.mode.as_str(),
                        it.color,
                        it.source,
                        it.ctime,
                        it.fx,
                    ])
                    .map_err(|e| format!("写弹幕失败: {e}"))?;
                inserted += n as i64;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(inserted)
    }

    /// 单条写入（本地发送路径）；返回 false = 重复被忽略
    pub fn insert_danmaku(&self, channel: &str, it: &DanmakuItem) -> Result<bool, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let n = conn
            .execute(
                "INSERT OR IGNORE INTO danmaku(id,channel,time_ms,text,mode,color,source,ctime,fx) \
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                rusqlite::params![
                    it.id,
                    channel,
                    to_ms(it.time),
                    it.text,
                    it.mode.as_str(),
                    it.color,
                    it.source,
                    it.ctime,
                    it.fx,
                ],
            )
            .map_err(|e| format!("写弹幕失败: {e}"))?;
        Ok(n > 0)
    }

    /// 读取整个频道的弹幕（按时间升序）
    pub fn list_danmaku(&self, channel: &str) -> Result<Vec<DanmakuItem>, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let mut stmt = conn
            .prepare(
                "SELECT id,time_ms,text,mode,color,source,ctime,fx FROM danmaku \
                 WHERE channel=?1 ORDER BY time_ms ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([channel], |r| {
                let ms: i64 = r.get(1)?;
                let mode: String = r.get(3)?;
                Ok(DanmakuItem {
                    id: r.get(0)?,
                    time: ms as f64 / 1000.0,
                    text: r.get(2)?,
                    mode: DanmakuMode::parse(&mode),
                    color: r.get(4)?,
                    source: r.get(5)?,
                    ctime: r.get(6)?,
                    fx: r.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    pub fn count_danmaku(&self, channel: &str) -> Result<i64, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.query_row("SELECT COUNT(*) FROM danmaku WHERE channel=?1", [channel], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())
    }

    /// 清空某频道弹幕（保留频道绑定关系，重新拉取用）
    pub fn clear_danmaku(&self, channel: &str) -> Result<i64, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let n = conn
            .execute("DELETE FROM danmaku WHERE channel=?1", [channel])
            .map_err(|e| e.to_string())?;
        Ok(n as i64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pf_danmaku::make_id;

    fn store() -> CacheStore {
        let dir = std::env::temp_dir().join(format!(
            "pf-danmaku-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        CacheStore::open(&dir.join("t.db"), dir.join("cache")).unwrap()
    }

    fn item(t: f64, text: &str) -> DanmakuItem {
        DanmakuItem {
            id: make_id("local", "ch", t, text),
            time: t,
            text: text.into(),
            mode: DanmakuMode::Scroll,
            color: "#FFFFFF".into(),
            source: "local".into(),
            ctime: Some(1_700_000_000_000),
            fx: None,
        }
    }

    #[test]
    fn fx_survives_roundtrip_and_legacy_rows_read_as_none() {
        let s = store();
        let mut glow = item(1.0, "发光");
        glow.fx = Some("glow".into());
        s.insert_danmaku("ch", &glow).unwrap();
        // 旧结构（fx=None）也写一条
        s.insert_danmaku("ch", &item(2.0, "普通")).unwrap();
        let list = s.list_danmaku("ch").unwrap();
        assert_eq!(list[0].fx.as_deref(), Some("glow"));
        assert_eq!(list[1].fx, None);
    }

    #[test]
    fn batch_insert_dedups_on_resend() {
        let s = store();
        let batch = vec![item(1.0, "a"), item(2.0, "b")];
        assert_eq!(s.insert_danmaku_batch("ch", &batch).unwrap(), 2);
        // 同一批再写一次 → 全部被唯一约束吃掉
        assert_eq!(s.insert_danmaku_batch("ch", &batch).unwrap(), 0);
        assert_eq!(s.count_danmaku("ch").unwrap(), 2);
    }

    #[test]
    fn time_roundtrip_preserves_ms_precision() {
        let s = store();
        s.insert_danmaku_batch("ch", &[item(12.345, "x")]).unwrap();
        let list = s.list_danmaku("ch").unwrap();
        assert!((list[0].time - 12.345).abs() < 1e-9);
    }

    #[test]
    fn list_is_time_sorted() {
        let s = store();
        s.insert_danmaku_batch("ch", &[item(9.0, "后"), item(1.0, "前"), item(5.0, "中")])
            .unwrap();
        let texts: Vec<_> = s.list_danmaku("ch").unwrap().into_iter().map(|d| d.text).collect();
        assert_eq!(texts, vec!["前", "中", "后"]);
    }

    #[test]
    fn channels_are_isolated() {
        let s = store();
        s.insert_danmaku_batch("a", &[item(1.0, "x")]).unwrap();
        s.insert_danmaku_batch("b", &[item(1.0, "x")]).unwrap();
        assert_eq!(s.count_danmaku("a").unwrap(), 1);
        assert_eq!(s.count_danmaku("b").unwrap(), 1);
    }

    #[test]
    fn delete_channel_removes_items_too() {
        let s = store();
        let ch = DanmakuChannelRow {
            id: "ch".into(),
            title: "剧".into(),
            episode: Some("第1集".into()),
            provider: "dandanplay".into(),
            provider_ep_id: Some("100".into()),
            duration: Some(1500.0),
            item_count: 0,
            matched_at: Some(1),
            last_fetch_at: None,
            last_error: None,
        };
        s.upsert_danmaku_channel(&ch).unwrap();
        s.insert_danmaku_batch("ch", &[item(1.0, "x")]).unwrap();
        assert_eq!(s.delete_danmaku_channel("ch").unwrap(), 1);
        assert_eq!(s.count_danmaku("ch").unwrap(), 0);
        assert!(s.get_danmaku_channel("ch").unwrap().is_none());
    }

    #[test]
    fn touch_keeps_duration_when_none() {
        let s = store();
        let ch = DanmakuChannelRow {
            id: "ch".into(),
            title: "剧".into(),
            episode: None,
            provider: "dandanplay".into(),
            provider_ep_id: Some("1".into()),
            duration: Some(1400.0),
            item_count: 0,
            matched_at: Some(1),
            last_fetch_at: None,
            last_error: None,
        };
        s.upsert_danmaku_channel(&ch).unwrap();
        s.touch_danmaku_channel("ch", 10, None, None, 123).unwrap();
        let got = s.get_danmaku_channel("ch").unwrap().unwrap();
        assert_eq!(got.duration, Some(1400.0));
        assert_eq!(got.item_count, 10);
        assert!(got.last_error.is_none());
    }

    #[test]
    fn clear_keeps_channel_binding() {
        let s = store();
        let ch = DanmakuChannelRow {
            id: "ch".into(),
            title: "剧".into(),
            episode: None,
            provider: "local".into(),
            provider_ep_id: None,
            duration: None,
            item_count: 0,
            matched_at: None,
            last_fetch_at: None,
            last_error: None,
        };
        s.upsert_danmaku_channel(&ch).unwrap();
        s.insert_danmaku_batch("ch", &[item(1.0, "x")]).unwrap();
        assert_eq!(s.clear_danmaku("ch").unwrap(), 1);
        assert!(s.get_danmaku_channel("ch").unwrap().is_some());
    }

    #[test]
    fn insert_single_reports_duplicate() {
        let s = store();
        let it = item(1.0, "x");
        assert!(s.insert_danmaku("ch", &it).unwrap());
        assert!(!s.insert_danmaku("ch", &it).unwrap());
    }
}
