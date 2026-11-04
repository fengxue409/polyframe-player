//! P12 磁力/BT 片源（DESIGN §10）
//!
//! 职责：把 `pf-magnet` 的会话能力接成 RPC —— 建任务、等元数据、选片、报告进度、
//! 完成后给出可播放的本地代理地址。纯文本解析在 `pf-magnet::magnet`，
//! 持久化在 `pf-engine::magnet_store`，播放由 `pf-proxy` 的 `/bt` 路由按 Range 读盘。
//!
//! 关键取舍：**本版只在下载完成后播放**。
//! MP4 的 moov 常在文件末尾、MKV 的 cues 也在末尾，强行边下边播必然 seek 失败；
//! 与其做一个时灵时不灵的播放器，不如把「下载进度 + 完成后可播」讲清楚。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use pf_engine::{MagnetTaskRow, ProxyInfo, TaskManager};
use pf_magnet::{normalize_magnet, Engine, FileInfo, TorrentHandle};
use serde_json::{json, Value};
use tokio::sync::OnceCell;

use crate::{error_response, ok_response};

/// 等元数据的上限：冷门种靠 DHT 汇合有时要几十秒，给足但别挂死
const META_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);
/// 进度轮询间隔（前端也用同样的节奏拉 list，两者叠加不会抖）
const TICK: std::time::Duration = std::time::Duration::from_millis(1000);

struct Runtime {
    engine: Engine,
    handles: Mutex<HashMap<String, TorrentHandle>>,
}

/// 惰性初始化：只有真正用到磁力功能时才起会话（DHT + 监听），不拖慢内核启动
static RT: OnceCell<Arc<Runtime>> = OnceCell::const_new();

async fn rt(engine: &Arc<TaskManager>) -> Result<Arc<Runtime>, (i32, String)> {
    RT.get_or_try_init(|| async {
        // 下载目录与缓存目录同级：%LOCALAPPDATA%/PolyFrame/magnet
        let root = engine
            .store()
            .cache_dir()
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from("."));
        let dir = root.join("magnet");
        let engine = Engine::new(dir)
            .await
            .map_err(|e| (-32000, e))?;
        Ok::<_, (i32, String)>(Arc::new(Runtime {
            engine,
            handles: Mutex::new(HashMap::new()),
        }))
    })
    .await
    .cloned()
}

fn rand_id() -> String {
    use rand::Rng;
    let b: [u8; 12] = rand::thread_rng().gen();
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn str_param<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params.get(key).and_then(|v| v.as_str())
}

fn bool_param(params: &Value, key: &str) -> Option<bool> {
    params.get(key).and_then(|v| v.as_bool())
}

fn u64_param(params: &Value, key: &str) -> Option<u64> {
    params.get(key).and_then(|v| v.as_u64())
}

/// 行 → 出参（把 files_json 解析成数组，前端不必再解字符串）
fn task_view(row: &MagnetTaskRow) -> Value {
    let files: Value = serde_json::from_str(&row.files_json).unwrap_or_else(|_| json!([]));
    let mut v = serde_json::to_value(row).unwrap_or_else(|_| json!({}));
    if let Some(obj) = v.as_object_mut() {
        obj.insert("files".into(), files);
        obj.remove("filesJson");
    }
    v
}

fn load_row(engine: &Arc<TaskManager>, id: &str) -> Result<MagnetTaskRow, (i32, String)> {
    engine
        .store()
        .get_magnet_task(id)
        .map_err(|e| (-32000, e))?
        .ok_or_else(|| (-32000, "磁力任务不存在".to_string()))
}

/// 元数据到手后：挑正片、只下正片、记录文件名/路径
async fn after_metadata(
    rt: &Arc<Runtime>,
    engine: &Arc<TaskManager>,
    id: &str,
    handle: &TorrentHandle,
    only: Option<usize>,
) {
    let files: Vec<FileInfo> = rt.engine.files(handle);
    if files.is_empty() {
        let _ = engine
            .store()
            .set_magnet_status(id, "error", Some("种子里没有文件"));
        return;
    }
    let picked = only.unwrap_or_else(|| {
        files
            .iter()
            .find(|f| f.is_video)
            .map(|f| f.index)
            .unwrap_or(0)
    });
    let picked_file = files.iter().find(|f| f.index == picked);
    let files_json = serde_json::to_string(&files).unwrap_or_else(|_| "[]".into());

    if let Err(e) = rt.engine.select_files(handle, vec![picked]).await {
        let _ = engine.store().set_magnet_status(id, "error", Some(&e));
        return;
    }

    let name = handle
        .name()
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| picked_file.map(|f| f.name.clone()).unwrap_or_default());
    let path = rt
        .engine
        .file_path(handle, picked)
        .map(|p| p.to_string_lossy().to_string());

    let _ = engine.store().set_magnet_meta(
        id,
        &name,
        "",
        &files_json,
        Some(picked as i64),
        picked_file.map(|f| f.name.as_str()),
        picked_file.map(|f| f.len as i64),
        path.as_deref(),
    );
    let _ = engine.store().set_magnet_status(id, "downloading", None);
}

/// 后台推进：等元数据 → 选片 → 周期写进度
fn spawn_progress(
    rt: Arc<Runtime>,
    engine: Arc<TaskManager>,
    id: String,
    handle: TorrentHandle,
    only: Option<usize>,
) {
    tokio::spawn(async move {
        if let Err(e) = rt.engine.wait_metadata(&handle, META_TIMEOUT).await {
            let _ = engine.store().set_magnet_status(&id, "error", Some(&e));
            return;
        }
        after_metadata(&rt, &engine, &id, &handle, only).await;

        // 进度轮询：状态落库，前端拉 list 就能看到
        let mut idle_rounds = 0u32;
        loop {
            let row = match engine.store().get_magnet_task(&id) {
                Ok(Some(r)) => r,
                _ => return, // 任务被删
            };
            if row.status == "paused" || row.status == "error" {
                return;
            }
            let st = rt.engine.stats(&handle, row.file_index.map(|i| i as u64 as usize));
            let _ = engine
                .store()
                .set_magnet_progress(&id, st.done_bytes as i64, st.total_bytes as i64);
            if st.finished {
                let _ = engine.store().set_magnet_status(&id, "done", None);
                return;
            }
            if let Some(err) = st.error {
                let _ = engine.store().set_magnet_status(&id, "error", Some(&err));
                return;
            }
            // 连续长时间零进度 → 只提示，不改状态（可能只是慢种）
            if st.done_bytes as i64 == row.done_bytes {
                idle_rounds += 1;
            } else {
                idle_rounds = 0;
            }
            if idle_rounds > 0 && idle_rounds % 60 == 0 {
                let _ = engine.store().set_magnet_status(
                    &id,
                    "downloading",
                    Some("已连续 1 分钟没有新数据（可能是死种或连接不上 peer）"),
                );
            }
            tokio::time::sleep(TICK).await;
        }
    });
}

/// magnet.* 方法处理（rest = method 去掉 "magnet." 前缀）
pub async fn handle(
    rest: &str,
    params: &Value,
    id: Value,
    engine: &Arc<TaskManager>,
    proxy: &ProxyInfo,
) -> Option<String> {
    let out: Result<Value, (i32, String)> = match rest {
        "add" => add(params, engine).await,
        "list" => list(engine),
        "files" => files(params, engine),
        "select" => select(params, engine).await,
        "pause" => set_paused(params, engine, true).await,
        "resume" => set_paused(params, engine, false).await,
        "remove" => remove(params, engine).await,
        "play" => play(params, engine, proxy),
        _ => return None,
    };
    Some(match out {
        Ok(v) => ok_response(id, v),
        Err((code, msg)) => error_response(id, code, &msg),
    })
}

async fn add(params: &Value, engine: &Arc<TaskManager>) -> Result<Value, (i32, String)> {
    let raw = str_param(params, "url").ok_or((-32602, "invalid params: url required".to_string()))?;
    let info = normalize_magnet(raw).map_err(|e| (-32602, e.to_string()))?;
    let rt = rt(engine).await?;

    // 同一个 info hash 已有任务时直接复用：重复点「添加」不该产生第二条记录，
    // 也不该让 librqbit 再走一次元数据发现（DHT/tracker 都被关掉时会直接报错）
    if !info.info_hash.is_empty() {
        if let Ok(rows) = engine.store().list_magnet_tasks() {
            if let Some(hit) = rows
                .iter()
                .find(|r| r.info_hash == info.info_hash && r.status != "error")
            {
                return Ok(json!({ "task": task_view(hit), "duplicated": true }));
            }
        }
    }

    let id = rand_id();
    let display = info
        .name
        .clone()
        .unwrap_or_else(|| info.info_hash.chars().take(12).collect::<String>());
    let save_dir = rt.engine.dir().to_string_lossy().to_string();
    engine
        .store()
        .insert_magnet_task(&id, &info.canonical, &info.info_hash, &display, &save_dir)
        .map_err(|e| (-32000, e))?;

    // 显式指定 peer（内网 / 私有种子 / 测试）；给了就绕开 DHT 与 tracker
    let peers: Vec<std::net::SocketAddr> = params
        .get("initialPeers")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| p.as_str())
                .filter_map(|s| s.parse::<std::net::SocketAddr>().ok())
                .collect()
        })
        .unwrap_or_default();
    let only = u64_param(params, "onlyFile").map(|v| v as usize);

    let added = if peers.is_empty() {
        rt.engine.add(&info.canonical, None).await
    } else {
        rt.engine.add_with_peers(&info.canonical, peers, None).await
    };
    let handle = match added {
        Ok(h) => h,
        Err(e) => {
            let _ = engine.store().set_magnet_status(&id, "error", Some(&e));
            return Err((-32000, e));
        }
    };

    rt.handles
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(id.clone(), handle.clone());
    spawn_progress(rt.clone(), engine.clone(), id.clone(), handle, only);

    let row = load_row(engine, &id)?;
    Ok(json!({ "task": task_view(&row) }))
}

fn list(engine: &Arc<TaskManager>) -> Result<Value, (i32, String)> {
    let rows = engine.store().list_magnet_tasks().map_err(|e| (-32000, e))?;
    Ok(json!({ "tasks": rows.iter().map(task_view).collect::<Vec<_>>() }))
}

fn files(params: &Value, engine: &Arc<TaskManager>) -> Result<Value, (i32, String)> {
    let id = str_param(params, "id").ok_or((-32602, "invalid params: id required".to_string()))?;
    let row = load_row(engine, id)?;
    let files: Value = serde_json::from_str(&row.files_json).unwrap_or_else(|_| json!([]));
    Ok(json!({ "files": files, "selected": row.file_index }))
}

async fn select(params: &Value, engine: &Arc<TaskManager>) -> Result<Value, (i32, String)> {
    let id = str_param(params, "id").ok_or((-32602, "invalid params: id required".to_string()))?;
    let idx = u64_param(params, "fileIndex")
        .ok_or((-32602, "invalid params: fileIndex required".to_string()))? as usize;
    let row = load_row(engine, id)?;
    let files: Vec<FileInfo> = serde_json::from_str(&row.files_json).unwrap_or_default();
    let picked = files
        .iter()
        .find(|f| f.index == idx)
        .ok_or((-32602, "文件下标不存在".to_string()))?
        .clone();

    let rt = rt(engine).await?;
    let handle = {
        let map = rt.handles.lock().unwrap_or_else(|p| p.into_inner());
        map.get(id).cloned()
    };
    let Some(handle) = handle else {
        return Err((-32000, "任务已重启，请重新添加磁力链接".to_string()));
    };
    rt.engine
        .select_files(&handle, vec![idx])
        .await
        .map_err(|e| (-32000, e))?;
    let path = rt
        .engine
        .file_path(&handle, idx)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    engine
        .store()
        .set_magnet_selection(id, idx as i64, &picked.name, picked.len as i64, &path)
        .map_err(|e| (-32000, e))?;
    let row = load_row(engine, id)?;
    Ok(json!({ "task": task_view(&row) }))
}

async fn set_paused(
    params: &Value,
    engine: &Arc<TaskManager>,
    paused: bool,
) -> Result<Value, (i32, String)> {
    let id = str_param(params, "id").ok_or((-32602, "invalid params: id required".to_string()))?;
    let _ = load_row(engine, id)?;
    let rt = rt(engine).await?;
    let handle = {
        let map = rt.handles.lock().unwrap_or_else(|p| p.into_inner());
        map.get(id).cloned()
    };
    let Some(handle) = handle else {
        return Err((-32000, "任务已重启，无法控制（重新添加即可）".to_string()));
    };
    if paused {
        rt.engine.pause(&handle).await.map_err(|e| (-32000, e))?;
        let _ = engine.store().set_magnet_status(id, "paused", None);
    } else {
        rt.engine.resume(&handle).await.map_err(|e| (-32000, e))?;
        let _ = engine.store().set_magnet_status(id, "downloading", None);
        // 续传后重新挂进度轮询
        spawn_progress(rt.clone(), engine.clone(), id.to_string(), handle, None);
    }
    let row = load_row(engine, id)?;
    Ok(json!({ "task": task_view(&row) }))
}

async fn remove(params: &Value, engine: &Arc<TaskManager>) -> Result<Value, (i32, String)> {
    let id = str_param(params, "id").ok_or((-32602, "invalid params: id required".to_string()))?;
    let delete_files = bool_param(params, "deleteFiles").unwrap_or(false);
    let rt = rt(engine).await?;
    let handle = {
        let mut map = rt.handles.lock().unwrap_or_else(|p| p.into_inner());
        map.remove(id)
    };
    if let Some(h) = handle {
        // 会话级移除失败不阻塞记录清理（任务可能已不在会话里）
        let _ = rt.engine.remove(h.id(), delete_files).await;
    } else if delete_files {
        // 进程重启过：句柄没了，但文件还在，按表里的路径删
        if let Ok(Some(row)) = engine.store().get_magnet_task(id) {
            if let Some(p) = row.file_path {
                let path = std::path::PathBuf::from(&p);
                let _ = std::fs::remove_file(&path);
                if let Some(dir) = path.parent() {
                    if dir.starts_with(rt.engine.dir()) {
                        let _ = std::fs::remove_dir_all(dir);
                    }
                }
            }
        }
    }
    engine.store().remove_magnet_task(id).map_err(|e| (-32000, e))?;
    Ok(json!({ "removed": true }))
}

fn play(
    params: &Value,
    engine: &Arc<TaskManager>,
    proxy: &ProxyInfo,
) -> Result<Value, (i32, String)> {
    let id = str_param(params, "id").ok_or((-32602, "invalid params: id required".to_string()))?;
    let row = load_row(engine, id)?;
    if row.status != "done" {
        let pct = if row.total_bytes > 0 {
            row.done_bytes as f64 / row.total_bytes as f64 * 100.0
        } else {
            0.0
        };
        return Err((
            -32000,
            format!(
                "还没下完（{:.1}%），磁力任务要等文件落盘后才能播放；进度会在列表里实时更新",
                pct
            ),
        ));
    }
    if row.file_path.as_deref().map(|p| std::path::Path::new(p).is_file()) != Some(true) {
        return Err((-32000, "文件不在磁盘上（可能被手动删除或移走）".to_string()));
    }
    let idx = row.file_index.unwrap_or(0);
    Ok(json!({
        "playUrl": format!("http://127.0.0.1:{}/bt/{}/{}/{}", proxy.port, proxy.token, id, idx),
        "name": row.file_name.clone().unwrap_or(row.name.clone()),
    }))
}
