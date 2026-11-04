//! librqbit 会话封装：只暴露本项目需要的窄接口。
//!
//! 为什么包一层：
//! 1. 上层（pf-core）不该依赖 librqbit 的具体类型/生命周期，换引擎只改这一层；
//! 2. 「选片」「进度归一」「超时话术」是产品语义，放在这里才好单测与统一文案。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use librqbit::{
    AddTorrent, AddTorrentOptions, AddTorrentResponse, ListenerOptions, ManagedTorrent, Session,
    SessionOptions,
};

use crate::pick_video_file;

/// 种子里的一个文件
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FileInfo {
    /// 种子内下标（`only_files` 需要它）
    pub index: usize,
    /// 相对路径（多文件种子会带目录）
    pub name: String,
    pub len: u64,
    /// 是否被判定为「正片」
    #[serde(rename = "isVideo")]
    pub is_video: bool,
}

/// 进度快照（归一后的形态，字段名直接给前端用）
#[derive(Debug, Clone, serde::Serialize)]
pub struct TorrentStatsView {
    /// initializing / live / paused / finished / error
    pub state: String,
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
    #[serde(rename = "doneBytes")]
    pub done_bytes: u64,
    /// 当前选中文件的已完成字节（「正片下到哪了」）
    #[serde(rename = "fileDoneBytes")]
    pub file_done_bytes: u64,
    pub finished: bool,
    pub error: Option<String>,
}

/// 不透明种子句柄：上层只传递、不解读
#[derive(Clone)]
pub struct TorrentHandle {
    inner: Arc<ManagedTorrent>,
}

impl TorrentHandle {
    /// 会话内数字 id（删除、去重时用）
    pub fn id(&self) -> usize {
        self.inner.id()
    }

    /// 种子名（元数据到手后才有）
    pub fn name(&self) -> Option<String> {
        self.inner.name()
    }
}

/// BT 引擎：一个进程一个会话（DHT + TCP 监听）
pub struct Engine {
    session: Arc<Session>,
    dir: PathBuf,
}

impl Engine {
    /// 启动会话。`dir` 是默认下载目录（多文件种子会在其下建同名子目录）。
    pub async fn new(dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建下载目录失败: {e}"))?;
        // 必须显式开监听：SessionOptions.listen 默认 None，只出不进，
        // 别人连不上你，做种/互传都会退化。端口 0 = 系统分配，避免和用户其它软件抢。
        let make_opts = || SessionOptions {
            listen: Some(ListenerOptions {
                listen_addr: "0.0.0.0:0".parse().expect("固定字面量"),
                ipv4_only: true,
                // UPnP 在局域网里常常卡几十秒，默认关掉；需要端口映射由用户自己处理
                enable_upnp_port_forwarding: false,
                ..Default::default()
            }),
            ipv4_only: true,
            ..Default::default()
        };
        let session = match Session::new_with_opts(dir.clone(), make_opts()).await {
            Ok(s) => s,
            Err(e) => {
                // DHT 起不来（端口被占/被防火墙拦/沙箱限制）不该让整个磁力功能瘫掉：
                // 退化成「无 DHT 会话」，tracker 与 initial_peers 仍然可用。
                eprintln!("[pf-magnet] DHT 初始化失败（降级为无 DHT 会话）: {e}");
                let fallback = SessionOptions {
                    dht: None,
                    ..make_opts()
                };
                Session::new_with_opts(dir.clone(), fallback)
                    .await
                    .map_err(|e2| format!("BT 会话启动失败: {e2}"))?
            }
        };
        Ok(Self { session, dir })
    }

    /// 下载根目录
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// 加入种子/磁力。
    ///
    /// `only_files` 为 `None` 时先不限制文件，等元数据到手后再 `select_files` 精确挑片。
    pub async fn add(
        &self,
        uri: &str,
        only_files: Option<Vec<usize>>,
    ) -> Result<TorrentHandle, String> {
        let opts = AddTorrentOptions {
            only_files,
            overwrite: true,
            ..Default::default()
        };
        self.finish(self.session.add_torrent(AddTorrent::from_url(uri), Some(opts)).await)
            .await
    }

    /// 以固定 peer 加入（内网/本地测试：绕开 DHT 与 tracker）
    pub async fn add_with_peers(
        &self,
        uri: &str,
        peers: Vec<std::net::SocketAddr>,
        only_files: Option<Vec<usize>>,
    ) -> Result<TorrentHandle, String> {
        let opts = AddTorrentOptions {
            only_files,
            overwrite: true,
            initial_peers: Some(peers),
            disable_trackers: true,
            ..Default::default()
        };
        self.finish(self.session.add_torrent(AddTorrent::from_url(uri), Some(opts)).await)
            .await
    }

    /// 统一处理加入结果；对错误类型泛型化，避免为了写签名而引入 anyhow 依赖
    async fn finish<E: std::fmt::Display>(
        &self,
        resp: Result<AddTorrentResponse, E>,
    ) -> Result<TorrentHandle, String> {
        match resp.map_err(|e| format!("加入种子失败: {e}"))? {
            AddTorrentResponse::Added(_, h) | AddTorrentResponse::AlreadyManaged(_, h) => {
                Ok(TorrentHandle { inner: h })
            }
            AddTorrentResponse::ListOnly(_) => {
                Err("只列举模式没有返回句柄，请改用普通加入".to_string())
            }
        }
    }

    /// 等待元数据到手（磁力必须走这一步）。超时返回错误，不挂死。
    pub async fn wait_metadata(
        &self,
        handle: &TorrentHandle,
        timeout: Duration,
    ) -> Result<(), String> {
        tokio::time::timeout(timeout, handle.inner.wait_until_initialized())
            .await
            .map_err(|_| {
                format!(
                    "{}s 内没拿到种子元数据（多半是既没有 tracker 也没有 DHT 节点，也可能是死种）",
                    timeout.as_secs()
                )
            })?
            .map_err(|e| format!("初始化失败: {e}"))
    }

    /// 种子内文件列表（元数据到手后才有意义），并标出被判为正片的那个
    pub fn files(&self, handle: &TorrentHandle) -> Vec<FileInfo> {
        let mut out: Vec<FileInfo> = Vec::new();
        let _ = handle.inner.with_metadata(|m| {
            for (idx, f) in m.file_infos.iter().enumerate() {
                out.push(FileInfo {
                    index: idx,
                    name: f.relative_filename.to_string_lossy().to_string(),
                    len: f.len,
                    is_video: false,
                });
            }
        });
        let picked = pick_video_file(
            &out.iter()
                .map(|f| (f.index, f.name.clone(), f.len))
                .collect::<Vec<_>>(),
        );
        if let Some(idx) = picked {
            for f in out.iter_mut() {
                f.is_video = f.index == idx;
            }
        }
        out
    }

    /// 只下指定文件（空列表 = 不限制）
    pub async fn select_files(&self, handle: &TorrentHandle, ids: Vec<usize>) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        let set: std::collections::HashSet<usize> = ids.into_iter().collect();
        self.session
            .update_only_files(&handle.inner, &set)
            .await
            .map_err(|e| format!("设置下载文件失败: {e}"))
    }

    /// 进度
    pub fn stats(&self, handle: &TorrentHandle, file_index: Option<usize>) -> TorrentStatsView {
        let s = handle.inner.stats();
        let file_done = file_index
            .and_then(|i| s.file_progress.get(i).copied())
            .unwrap_or(0);
        TorrentStatsView {
            state: format!("{:?}", s.state).to_ascii_lowercase(),
            total_bytes: s.total_bytes,
            done_bytes: s.progress_bytes,
            file_done_bytes: file_done,
            finished: s.finished,
            error: s.error,
        }
    }

    /// 正片在磁盘上的绝对路径（下载中即已知，完成后可直接播放）
    pub fn file_path(&self, handle: &TorrentHandle, index: usize) -> Option<PathBuf> {
        let mut name: Option<PathBuf> = None;
        let _ = handle.inner.with_metadata(|m| {
            if let Some(f) = m.file_infos.get(index) {
                name = Some(f.relative_filename.clone());
            }
        });
        let rel = name?;
        // librqbit 的 output_folder 已经包含多文件种子的子目录，直接拼即可
        Some(handle.inner.output_folder().join(&rel))
    }

    pub async fn pause(&self, handle: &TorrentHandle) -> Result<(), String> {
        self.session
            .pause(&handle.inner)
            .await
            .map_err(|e| format!("暂停失败: {e}"))
    }

    pub async fn resume(&self, handle: &TorrentHandle) -> Result<(), String> {
        self.session
            .unpause(&handle.inner)
            .await
            .map_err(|e| format!("继续失败: {e}"))
    }

    /// 移除种子；`delete_files` 决定是否连数据一起删
    pub async fn remove(&self, id: usize, delete_files: bool) -> Result<(), String> {
        self.session
            .delete(librqbit::api::TorrentIdOrHash::Id(id), delete_files)
            .await
            .map_err(|e| format!("移除失败: {e}"))
    }

    /// 会话监听端口（本地测试用它做 initial_peers；正常运行时可能为 None）
    pub fn listen_addr(&self) -> Option<std::net::SocketAddr> {
        self.session.listen_addr()
    }

    /// 把本地文件做成种子并开始做种，返回 magnet 与句柄。
    ///
    /// 存在的意义：**不依赖公网就能验证整条 BT 链路**（本机做种 → 另起会话下载 → 对比字节）。
    /// 生产流程不会调用它。
    pub async fn seed_file(&self, path: &Path) -> Result<(String, TorrentHandle), String> {
        let (res, handle) = self
            .session
            .create_and_serve_torrent(path, Default::default())
            .await
            .map_err(|e| format!("做种失败: {e}"))?;
        Ok((res.as_magnet().to_string(), TorrentHandle { inner: handle }))
    }

    /// 轮询直到完成或超时（测试用；业务侧由前端轮询进度）
    pub async fn wait_done(&self, handle: &TorrentHandle, timeout: Duration) -> Result<(), String> {
        let start = Instant::now();
        loop {
            if handle.inner.stats().finished {
                return Ok(());
            }
            if start.elapsed() > timeout {
                return Err(format!("{}s 内没下载完", timeout.as_secs()));
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }
}
