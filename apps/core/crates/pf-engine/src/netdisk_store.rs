//! 网盘账号 / 分享持久化（P9b）
//!
//! 只做存储：凭据整段 JSON 落库（不建列，避免各家字段差异导致迁移）；
//! 状态机 `ok → expired`（登录态失效）/ `error`（网络或风控）。

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::CacheStore;

/// 网盘账号表 / 分享表（随 CacheStore::open 建表；全新表，无需 ALTER 迁移）
pub const NETDISK_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS netdisk_accounts(
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  cred TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  last_error TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS netdisk_shares(
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  account_id TEXT,
  share_url TEXT NOT NULL,
  share_id TEXT NOT NULL,
  pwd TEXT,
  title TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_netdisk_shares_account ON netdisk_shares(account_id);
";

/// 账号行（cred 为 JSON 文本，仅内核内部使用，不直接下发前端）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetdiskAccountRow {
    pub id: String,
    pub provider: String,
    pub name: String,
    pub cred: String,
    /// ok | expired | error
    pub status: String,
    pub last_error: Option<String>,
    /// 登录态过期时刻（epoch ms）
    pub expires_at: Option<i64>,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
}

/// 分享行
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetdiskShareRow {
    pub id: String,
    pub provider: String,
    /// 用于解析的账号（同网盘账号；空 = 尚未绑定）
    pub account_id: Option<String>,
    pub share_url: String,
    pub share_id: String,
    pub pwd: Option<String>,
    pub title: Option<String>,
    pub created_at: i64,
}

fn map_account(r: &rusqlite::Row<'_>) -> rusqlite::Result<NetdiskAccountRow> {
    Ok(NetdiskAccountRow {
        id: r.get(0)?,
        provider: r.get(1)?,
        name: r.get(2)?,
        cred: r.get(3)?,
        status: r.get(4)?,
        last_error: r.get(5)?,
        expires_at: r.get(6)?,
        created_at: r.get(7)?,
        last_used_at: r.get(8)?,
    })
}

fn map_share(r: &rusqlite::Row<'_>) -> rusqlite::Result<NetdiskShareRow> {
    Ok(NetdiskShareRow {
        id: r.get(0)?,
        provider: r.get(1)?,
        account_id: r.get(2)?,
        share_url: r.get(3)?,
        share_id: r.get(4)?,
        pwd: r.get(5)?,
        title: r.get(6)?,
        created_at: r.get(7)?,
    })
}

impl CacheStore {
    // ---------- 账号 ----------

    pub fn list_netdisk_accounts(&self) -> Result<Vec<NetdiskAccountRow>, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let mut stmt = conn
            .prepare(
                "SELECT id,provider,name,cred,status,last_error,expires_at,created_at,last_used_at
                 FROM netdisk_accounts ORDER BY created_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], map_account)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        Ok(rows)
    }

    pub fn get_netdisk_account(&self, id: &str) -> Result<Option<NetdiskAccountRow>, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let mut stmt = conn
            .prepare(
                "SELECT id,provider,name,cred,status,last_error,expires_at,created_at,last_used_at
                 FROM netdisk_accounts WHERE id=?1",
            )
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![id]).map_err(|e| e.to_string())?;
        match rows.next().map_err(|e| e.to_string())? {
            Some(r) => Ok(Some(map_account(r).map_err(|e| e.to_string())?)),
            None => Ok(None),
        }
    }

    pub fn insert_netdisk_account(&self, row: &NetdiskAccountRow) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "INSERT INTO netdisk_accounts(id,provider,name,cred,status,last_error,expires_at,created_at,last_used_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                row.id, row.provider, row.name, row.cred, row.status,
                row.last_error, row.expires_at, row.created_at, row.last_used_at
            ],
        )
        .map_err(|e| format!("写入网盘账号失败: {e}"))?;
        Ok(())
    }

    /// 回写凭据（token 续期 / drive_id 派生）与对应过期时刻
    pub fn update_netdisk_cred(&self, id: &str, cred: &str, expires_at: Option<i64>) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "UPDATE netdisk_accounts SET cred=?2, expires_at=?3, status='ok', last_error=NULL WHERE id=?1",
            params![id, cred, expires_at],
        )
        .map_err(|e| format!("更新网盘凭据失败: {e}"))?;
        Ok(())
    }

    pub fn update_netdisk_status(&self, id: &str, status: &str, last_error: Option<&str>) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "UPDATE netdisk_accounts SET status=?2, last_error=?3 WHERE id=?1",
            params![id, status, last_error],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn touch_netdisk_account(&self, id: &str, now_ms: i64) {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let _ = conn.execute(
            "UPDATE netdisk_accounts SET last_used_at=?2 WHERE id=?1",
            params![id, now_ms],
        );
    }

    pub fn delete_netdisk_account(&self, id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let n = conn
            .execute("DELETE FROM netdisk_accounts WHERE id=?1", params![id])
            .map_err(|e| e.to_string())?;
        // 分享解绑（分享本身保留，用户可重新绑定账号）
        let _ = conn.execute(
            "UPDATE netdisk_shares SET account_id=NULL WHERE account_id=?1",
            params![id],
        );
        Ok(n > 0)
    }

    // ---------- 分享 ----------

    pub fn list_netdisk_shares(&self) -> Result<Vec<NetdiskShareRow>, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let mut stmt = conn
            .prepare(
                "SELECT id,provider,account_id,share_url,share_id,pwd,title,created_at
                 FROM netdisk_shares ORDER BY created_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows: Vec<NetdiskShareRow> = stmt
            .query_map([], map_share)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        Ok(rows)
    }

    pub fn get_netdisk_share(&self, id: &str) -> Result<Option<NetdiskShareRow>, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let mut stmt = conn
            .prepare(
                "SELECT id,provider,account_id,share_url,share_id,pwd,title,created_at
                 FROM netdisk_shares WHERE id=?1",
            )
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query(params![id]).map_err(|e| e.to_string())?;
        match rows.next().map_err(|e| e.to_string())? {
            Some(r) => Ok(Some(map_share(r).map_err(|e| e.to_string())?)),
            None => Ok(None),
        }
    }

    /// 同 provider + 同 share_id 去重（重复添加直接复用已有行）
    pub fn find_netdisk_share_by_sid(&self, provider: &str, share_id: &str) -> Option<NetdiskShareRow> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.query_row(
            "SELECT id,provider,account_id,share_url,share_id,pwd,title,created_at
             FROM netdisk_shares WHERE provider=?1 AND share_id=?2 LIMIT 1",
            params![provider, share_id],
            map_share,
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn insert_netdisk_share(&self, row: &NetdiskShareRow) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "INSERT INTO netdisk_shares(id,provider,account_id,share_url,share_id,pwd,title,created_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
            params![
                row.id, row.provider, row.account_id, row.share_url,
                row.share_id, row.pwd, row.title, row.created_at
            ],
        )
        .map_err(|e| format!("写入网盘分享失败: {e}"))?;
        Ok(())
    }

    pub fn update_netdisk_share_title(&self, id: &str, title: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let _ = conn.execute("UPDATE netdisk_shares SET title=?2 WHERE id=?1", params![id, title]);
        Ok(())
    }

    pub fn delete_netdisk_share(&self, id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let n = conn
            .execute("DELETE FROM netdisk_shares WHERE id=?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(n > 0)
    }

    /// 网盘 shim 路径密钥：进程重启保持不变（任务 URL 可跨重启复用）
    pub fn netdisk_shim_token(&self) -> String {
        if let Some(t) = self.setting_get("netdisk.shim_token") {
            if !t.trim().is_empty() {
                return t;
            }
        }
        let t = crate::rand_hex(24);
        let _ = self.setting_set("netdisk.shim_token", &t);
        t
    }

    pub fn netdisk_page_size(&self) -> u32 {
        self.setting_get("netdisk.page_size")
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(100)
            .clamp(1, 200)
    }
}
