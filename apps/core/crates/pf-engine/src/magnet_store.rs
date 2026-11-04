//! P12 磁力任务存储（magnet_tasks）
//!
//! 与 pf-core::magnet 的运行时会话分离：本模块只做 SQLite 持久化（同步、可单测）。
//! 运行时句柄（`Arc<ManagedTorrent>`）在进程内，重启后靠这张表恢复「下过什么」的展示，
//! 已完成的文件仍可从 `file_path` 直接播放/导出。

use rusqlite::OptionalExtension;

use crate::{iso_now, CacheStore};

/// epoch 毫秒（进度戳；与 catalog_store 内部同名函数各自独立，避免扩大可见性）
fn iso_now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 磁力任务行（serde camelCase，与 packages/shared 的 MagnetTask 同构）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MagnetTaskRow {
    pub id: String,
    /// 规范化后的 magnet URI（或 .torrent 地址）
    pub url: String,
    /// 40 位 hex；.torrent 地址在元数据到手前为空
    pub info_hash: String,
    /// 显示名（优先 `dn`，其次元数据里的 name）
    pub name: String,
    pub save_dir: String,
    /// adding（等元数据）/ downloading / paused / done / error
    pub status: String,
    pub error: Option<String>,
    pub total_bytes: i64,
    pub done_bytes: i64,
    /// 当前选中的文件下标（多集种子用它选项）
    pub file_index: Option<i64>,
    pub file_name: Option<String>,
    pub file_len: Option<i64>,
    /// 正片落盘绝对路径（下载中即已知；完成后可直接播放）
    pub file_path: Option<String>,
    /// 种子内文件列表（JSON 数组，给前端做选集）
    pub files_json: String,
    pub created_at: String,
    pub updated_at: i64,
}

impl MagnetTaskRow {
    fn from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: r.get(0)?,
            url: r.get(1)?,
            info_hash: r.get(2)?,
            name: r.get(3)?,
            save_dir: r.get(4)?,
            status: r.get(5)?,
            error: r.get(6)?,
            total_bytes: r.get(7)?,
            done_bytes: r.get(8)?,
            file_index: r.get(9)?,
            file_name: r.get(10)?,
            file_len: r.get(11)?,
            file_path: r.get(12)?,
            files_json: r.get(13)?,
            created_at: r.get(14)?,
            updated_at: r.get(15)?,
        })
    }
}

/// 磁力任务表 schema（随 CacheStore::open 一起执行）
pub const MAGNET_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS magnet_tasks(
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  info_hash TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  save_dir TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'adding',
  error TEXT,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  done_bytes INTEGER NOT NULL DEFAULT 0,
  file_index INTEGER,
  file_name TEXT,
  file_len INTEGER,
  file_path TEXT,
  files_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_magnet_created ON magnet_tasks(created_at DESC);
";

const COLS: &str = "id,url,info_hash,name,save_dir,status,error,total_bytes,done_bytes,\
file_index,file_name,file_len,file_path,files_json,created_at,updated_at";

impl CacheStore {
    pub fn insert_magnet_task(
        &self,
        id: &str,
        url: &str,
        info_hash: &str,
        name: &str,
        save_dir: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "INSERT INTO magnet_tasks(id,url,info_hash,name,save_dir,status,created_at,updated_at)
             VALUES(?1,?2,?3,?4,?5,'adding',?6,?7)",
            rusqlite::params![id, url, info_hash, name, save_dir, iso_now(), iso_now_millis()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_magnet_tasks(&self) -> Result<Vec<MagnetTaskRow>, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {COLS} FROM magnet_tasks ORDER BY created_at DESC"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], MagnetTaskRow::from_row)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    pub fn get_magnet_task(&self, id: &str) -> Result<Option<MagnetTaskRow>, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.query_row(
            &format!("SELECT {COLS} FROM magnet_tasks WHERE id=?1"),
            [id],
            MagnetTaskRow::from_row,
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    /// 更新状态（可选带错误文案）
    pub fn set_magnet_status(&self, id: &str, status: &str, error: Option<&str>) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "UPDATE magnet_tasks SET status=?2, error=?3, updated_at=?4 WHERE id=?1",
            rusqlite::params![id, status, error, iso_now_millis()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 更新进度与总长
    pub fn set_magnet_progress(&self, id: &str, done: i64, total: i64) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "UPDATE magnet_tasks SET done_bytes=?2, total_bytes=?3, updated_at=?4 WHERE id=?1",
            rusqlite::params![id, done, total, iso_now_millis()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 元数据到手：写 name / info_hash / 文件列表 / 选中的正片
    #[allow(clippy::too_many_arguments)]
    pub fn set_magnet_meta(
        &self,
        id: &str,
        name: &str,
        info_hash: &str,
        files_json: &str,
        file_index: Option<i64>,
        file_name: Option<&str>,
        file_len: Option<i64>,
        file_path: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            // info_hash 传空串表示「不改」：magnet 链接本身已带 hash，
            // 元数据回填时若用空串覆盖会让去重失效（同一磁力被重复添加）
            "UPDATE magnet_tasks SET name=?2,
             info_hash=CASE WHEN ?3='' THEN info_hash ELSE ?3 END,
             files_json=?4, file_index=?5,
             file_name=?6, file_len=?7, file_path=?8, updated_at=?9 WHERE id=?1",
            rusqlite::params![
                id,
                name,
                info_hash,
                files_json,
                file_index,
                file_name,
                file_len,
                file_path,
                iso_now_millis()
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 切换选中文件（选集）
    pub fn set_magnet_selection(
        &self,
        id: &str,
        file_index: i64,
        file_name: &str,
        file_len: i64,
        file_path: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute(
            "UPDATE magnet_tasks SET file_index=?2, file_name=?3, file_len=?4, file_path=?5,
             updated_at=?6 WHERE id=?1",
            rusqlite::params![id, file_index, file_name, file_len, file_path, iso_now_millis()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 内核启动时调用：把上次没跑完的任务标成「已中断」
    ///
    /// BT 会话句柄只存在内存里，进程重启后无法续传（librqbit 的持久化没开）。
    /// 不标记的话界面会永远停在「下载中 0%」，比失败更让人困惑。
    /// 已下完的文件仍在磁盘上，`magnet.play` 不受影响。
    pub fn mark_interrupted_magnet_tasks(&self) -> Result<usize, String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        let n = conn
            .execute(
                "UPDATE magnet_tasks SET status='paused',
                 error='内核重启，BT 会话已丢失：未下完的请重新添加同一磁力链接；已下完的仍可直接播放',
                 updated_at=?1 WHERE status IN ('adding','downloading')",
                rusqlite::params![iso_now_millis()],
            )
            .map_err(|e| e.to_string())?;
        Ok(n)
    }

    pub fn remove_magnet_task(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        conn.execute("DELETE FROM magnet_tasks WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 代理层用：磁力任务可播放的本地文件（路径 + content-type）
    ///
    /// 只认已落盘且非空的文件，让 `/bt` 路由能明确区分「还没下完」和「文件没了」。
    pub fn magnet_file(&self, task_id: &str) -> Result<Option<(std::path::PathBuf, String)>, String> {
        let row = self.get_magnet_task(task_id)?;
        let Some(row) = row else { return Ok(None) };
        let Some(p) = row.file_path else { return Ok(None) };
        let path = std::path::PathBuf::from(&p);
        if !path.is_file() {
            return Ok(None);
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let ct = match ext.as_str() {
            "mp4" | "m4v" => "video/mp4",
            "mkv" => "video/x-matroska",
            "webm" => "video/webm",
            "avi" => "video/x-msvideo",
            "mov" => "video/quicktime",
            "ts" | "m2ts" => "video/mp2t",
            "flv" => "video/x-flv",
            "rmvb" => "application/vnd.rn-realmedia-vbr",
            "wmv" => "video/x-ms-wmv",
            _ => "application/octet-stream",
        };
        Ok(Some((path, ct.to_string())))
    }
}
