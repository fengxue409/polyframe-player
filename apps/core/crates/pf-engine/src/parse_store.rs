//! P10 视频云解析：解析接口存储（parse_services）
//!
//! 与 pf-core::parse 的网络编排分离，本模块只做 SQLite CRUD（同步、可单测）。
//! 表结构与 catalog_sources 对齐（enabled/builtin/latency/last_ok_at），
//! 前端一张表就能同时渲染「源站」与「解析接口」两套管理面板。

use rusqlite::OptionalExtension;

use crate::iso_now;
use crate::CacheStore;

/// 解析接口行（serde camelCase，与 packages/shared 的 ParseService 同构）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseServiceRow {
    pub id: String,
    pub name: String,
    /// 接口模板：`https://host/?url=` 或含 `{url}` 占位符
    pub api: String,
    pub enabled: bool,
    pub builtin: bool,
    pub latency_ms: Option<i64>,
    pub last_ok_at: Option<i64>,
    pub created_at: String,
}

impl ParseServiceRow {
    fn from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            name: r.get(1)?,
            api: r.get(2)?,
            enabled: r.get::<_, i64>(3)? != 0,
            builtin: r.get::<_, i64>(4)? != 0,
            latency_ms: r.get(5)?,
            last_ok_at: r.get(6)?,
            created_at: r.get(7)?,
        })
    }
}

/// 解析接口表 schema（随 CacheStore::open 一起执行）
pub const PARSE_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS parse_services(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  builtin INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  last_ok_at INTEGER,
  created_at TEXT NOT NULL
);
";

const COLS: &str = "id,name,api,enabled,builtin,latency_ms,last_ok_at,created_at";

impl CacheStore {
    pub fn list_parse_services(&self) -> Result<Vec<ParseServiceRow>, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {COLS} FROM parse_services ORDER BY builtin DESC, created_at ASC"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], ParseServiceRow::from_row)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    pub fn get_parse_service(&self, id: &str) -> Result<Option<ParseServiceRow>, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.query_row(
            &format!("SELECT {COLS} FROM parse_services WHERE id=?1"),
            [id],
            ParseServiceRow::from_row,
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    pub fn get_parse_service_by_api(&self, api: &str) -> Result<Option<ParseServiceRow>, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.query_row(
            &format!("SELECT {COLS} FROM parse_services WHERE api=?1"),
            [api],
            ParseServiceRow::from_row,
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    pub fn insert_parse_service(
        &self,
        id: &str,
        name: &str,
        api: &str,
        enabled: bool,
        builtin: bool,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "INSERT INTO parse_services(id,name,api,enabled,builtin,created_at) \
             VALUES(?1,?2,?3,?4,?5,?6)",
            rusqlite::params![id, name, api, enabled as i64, builtin as i64, iso_now()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 更新（None 字段保持原值）；测活成功时顺带刷新 latency/last_ok
    pub fn update_parse_service(
        &self,
        id: &str,
        name: Option<&str>,
        api: Option<&str>,
        enabled: Option<bool>,
        latency_ms: Option<i64>,
        ok: bool,
    ) -> Result<Option<ParseServiceRow>, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(v) = name {
            conn.execute(
                "UPDATE parse_services SET name=?2 WHERE id=?1",
                rusqlite::params![id, v],
            )
            .map_err(|e| e.to_string())?;
        }
        if let Some(v) = api {
            conn.execute(
                "UPDATE parse_services SET api=?2 WHERE id=?1",
                rusqlite::params![id, v],
            )
            .map_err(|e| e.to_string())?;
        }
        if let Some(v) = enabled {
            conn.execute(
                "UPDATE parse_services SET enabled=?2 WHERE id=?1",
                rusqlite::params![id, v as i64],
            )
            .map_err(|e| e.to_string())?;
        }
        if ok {
            // 失败不清空历史延迟：上次可用时间比「刚失败」更有信息量
            conn.execute(
                "UPDATE parse_services SET latency_ms=?2, last_ok_at=?3 WHERE id=?1",
                rusqlite::params![id, latency_ms, crate::now_ms() as i64],
            )
            .map_err(|e| e.to_string())?;
        }
        drop(conn);
        self.get_parse_service(id)
    }

    pub fn delete_parse_service(&self, id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let n = conn
            .execute("DELETE FROM parse_services WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        Ok(n > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(tag: &str) -> CacheStore {
        // 每个用例独立目录：并行跑时互不删库（P8 踩过 remove_dir_all 竞争）
        let dir = std::env::temp_dir().join(format!(
            "pf-parse-store-{}-{tag}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        CacheStore::open(&dir.join("t.db"), dir.join("cache")).unwrap()
    }

    #[test]
    fn parse_service_crud() {
        let s = store("crud");
        assert!(s.list_parse_services().unwrap().is_empty());

        s.insert_parse_service("a", "接口A", "https://a.example/?url=", true, true)
            .unwrap();
        s.insert_parse_service("b", "接口B", "https://b.example/?url=", false, false)
            .unwrap();
        // api 唯一
        assert!(s
            .insert_parse_service("c", "重复", "https://a.example/?url=", true, false)
            .is_err());

        let rows = s.list_parse_services().unwrap();
        assert_eq!(rows.len(), 2);
        // builtin 优先排序
        assert_eq!(rows[0].id, "a");
        assert!(rows[0].enabled && rows[0].builtin);
        assert!(!rows[1].enabled);

        // 改名 + 启用 + 测活回写
        let r = s
            .update_parse_service("b", Some("改名B"), None, Some(true), Some(123), true)
            .unwrap()
            .unwrap();
        assert_eq!(r.name, "改名B");
        assert!(r.enabled);
        assert_eq!(r.latency_ms, Some(123));
        assert!(r.last_ok_at.is_some());

        // 失败不动历史延迟
        let r2 = s
            .update_parse_service("b", None, None, None, None, false)
            .unwrap()
            .unwrap();
        assert_eq!(r2.latency_ms, Some(123));

        assert_eq!(
            s.get_parse_service_by_api("https://b.example/?url=")
                .unwrap()
                .unwrap()
                .id,
            "b"
        );
        assert!(s.delete_parse_service("b").unwrap());
        assert!(!s.delete_parse_service("b").unwrap());
        assert_eq!(s.list_parse_services().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(std::env::temp_dir().join(format!(
            "pf-parse-store-{}-crud",
            std::process::id()
        )));
    }
}
