//! pf-netdisk：网盘视频源插件模块（P9b）
//!
//! 设计目标（与既有视频源架构兼容，DESIGN §4.7）：
//!  1. **provider 抽象**：新增网盘只需实现 [`Provider`] trait 并在 [`provider`] 注册，
//!     上层（引擎 / 代理 / RPC / UI）零改动。
//!  2. **纯 HTTP + 纯逻辑**：本 crate 不做持久化、不碰 SQLite、不依赖全局状态，
//!     只把「网盘语义」翻译成统一的 [`Page`] / [`PlayTarget`]。
//!  3. **两类播放路径**：解析出的直链 + 必要请求头，交给 pf-proxy `/nd` 路由统一注入，
//!     播放链接过期/403 时由上层强制换链——播放器永远只看到稳定的本地 shim URL。
//!
//! 接入新网盘的最小实现集：
//!  - `kind()` / `name()` / `auth_modes()`
//!  - `list()`（分页游标）+ `resolve()`（播放直链 + 请求头 + 过期时刻）
//!  - 需要长期登录态时实现 `refresh()`；需要派生字段（如 drive_id）时实现 `prepare()`
//!  - 支持分享链接时实现 `supports_share()` + `list_share()` / `resolve_share()`

mod aliyun;
mod baidu;
mod http;
mod onedrive;
pub mod link;
pub mod share;

use std::future::Future;
use std::pin::Pin;

use serde::{Deserialize, Serialize};

pub use link::{link_fresh, token_fresh, LinkCache, LINK_SKEW_MS};
pub use share::{parse_share, ShareRef};

/// 对象安全的异步返回值（trait 内不依赖 async_trait）
pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// 网盘种类（与 packages/shared 的 NetdiskProvider 同构）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    Baidu,
    Aliyun,
    OneDrive,
    /// 通用 HTTP 目录网关（alist/openlist/自建服务，端点契约见 http.rs）
    Http,
}

impl ProviderKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProviderKind::Baidu => "baidu",
            ProviderKind::Aliyun => "aliyun",
            ProviderKind::OneDrive => "onedrive",
            ProviderKind::Http => "http",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "baidu" => Some(ProviderKind::Baidu),
            "aliyun" | "alipan" => Some(ProviderKind::Aliyun),
            "onedrive" | "graph" => Some(ProviderKind::OneDrive),
            "http" | "httpdir" => Some(ProviderKind::Http),
            _ => None,
        }
    }
}

/// 授权方式（UI 据此渲染对应录入表单）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthMode {
    /// 浏览器 Cookie（百度 BDUSS 等）
    Cookie,
    /// 粘贴 access/refresh token
    Token,
    /// 设备码流程（OneDrive）/ 授权码流程
    DeviceCode,
}

impl AuthMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            AuthMode::Cookie => "cookie",
            AuthMode::Token => "token",
            AuthMode::DeviceCode => "deviceCode",
        }
    }
}

/// 账号凭据（序列化后整段存 SQLite；字段全可选，按网盘取用）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Credentials {
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    /// 浏览器 Cookie 串（百度网盘网页版鉴权）
    pub cookie: Option<String>,
    /// HTTP 目录网关地址
    pub base_url: Option<String>,
    /// OAuth 应用标识（OneDrive 设备码流程必填）
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    /// 阿里云盘 drive_id（首次 list 时自动派生并回写）
    pub drive_id: Option<String>,
    /// 账号唯一标识（阿里云盘 user_id / OneDrive 用户 id）
    pub user_id: Option<String>,
    /// access_token 过期时刻（epoch ms；None = 未知/不过期）
    pub expires_at: Option<i64>,
    /// 网盘特有附加字段
    pub extra: Option<serde_json::Value>,
}

impl Credentials {
    /// 从 JSON 文本解析（容错：非法 JSON 视为空凭据）
    pub fn from_json(s: &str) -> Self {
        serde_json::from_str(s).unwrap_or_default()
    }
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".into())
    }
    pub fn bearer(&self) -> Option<String> {
        self.access_token
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| format!("Bearer {s}"))
    }
}

/// 目录条目（与 packages/shared 的 NetdiskItem 同构）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetdiskItem {
    pub id: String,
    pub name: String,
    pub is_dir: bool,
    #[serde(default)]
    pub size: u64,
    /// 修改时间（epoch ms）
    #[serde(default)]
    pub modified_at: Option<i64>,
    /// dir | video | audio | image | other
    pub kind: String,
    #[serde(default)]
    pub ext: Option<String>,
}

impl NetdiskItem {
    /// 按扩展名归类（视频判定同时用于 UI 过滤与「加入任务」可用性）
    pub fn classify(id: String, name: String, is_dir: bool, size: u64, modified_at: Option<i64>) -> Self {
        let ext = std::path::Path::new(&name)
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase());
        let kind = if is_dir {
            "dir"
        } else {
            match ext.as_deref() {
                Some("mp4") | Some("m4v") | Some("mkv") | Some("avi") | Some("mov") | Some("wmv")
                | Some("flv") | Some("ts") | Some("webm") | Some("rmvb") | Some("mpg") | Some("mpeg")
                | Some("m2ts") => "video",
                Some("mp3") | Some("flac") | Some("aac") | Some("wav") | Some("m4a") | Some("ogg") => "audio",
                Some("jpg") | Some("jpeg") | Some("png") | Some("webp") | Some("gif") | Some("bmp") => "image",
                _ => "other",
            }
        };
        Self { id, name, is_dir, size, modified_at, kind: kind.to_string(), ext }
    }
    /// 是否可作为视频源（视频文件；目录另走浏览）
    pub fn playable(&self) -> bool {
        self.kind == "video"
    }
}

/// 分页结果（游标式分页，next_cursor = None 表示到底）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub items: Vec<NetdiskItem>,
    #[serde(default)]
    pub next_cursor: Option<String>,
    #[serde(default)]
    pub total: Option<u64>,
}

/// 播放目标：直链 + 注入头 + 过期时刻
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayTarget {
    pub url: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    /// 直链失效时刻（epoch ms；None = 无明确期限，仅在 403 时换链）
    #[serde(default)]
    pub expires_at: Option<i64>,
    /// 容器提示（mp4/mkv/…，播放内核选择参考）
    #[serde(default)]
    pub ext: Option<String>,
}

/// 设备码授权挑战
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthChallenge {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    /// 建议轮询间隔（秒）
    pub interval_secs: u64,
    /// 设备码有效期（秒）
    pub expires_in: u64,
    #[serde(default)]
    pub message: Option<String>,
}

/// 轮询结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthOutcome {
    /// true = 用户尚未完成授权（继续轮询）
    pub pending: bool,
    #[serde(default)]
    pub cred: Option<Credentials>,
    #[serde(default)]
    pub message: Option<String>,
}

/// 网盘适配器契约（新增网盘只实现本 trait）
pub trait Provider: Send + Sync {
    fn kind(&self) -> ProviderKind;
    fn name(&self) -> &'static str;
    fn auth_modes(&self) -> Vec<AuthMode>;

    /// 是否支持「分享链接直接解析」（否则需先转存到自己的网盘）
    fn supports_share(&self) -> bool {
        false
    }

    /// 凭据派生字段补齐（如阿里云盘 drive_id）；返回 true 表示有变更需回写
    fn prepare<'a>(&'a self, _cred: &'a mut Credentials) -> BoxFut<'a, Result<bool, String>> {
        Box::pin(async { Ok(false) })
    }

    /// 轻量连通性校验（列表首页）
    fn verify<'a>(&'a self, cred: &'a Credentials) -> BoxFut<'a, Result<(), String>>;

    /// 目录列举（cursor 为网盘原生分页游标：页码 / marker / nextLink）
    fn list<'a>(
        &'a self,
        cred: &'a Credentials,
        dir_id: &'a str,
        cursor: Option<&'a str>,
        page_size: u32,
    ) -> BoxFut<'a, Result<Page, String>>;

    /// 解析播放直链（每次调用都应向网盘换取新链接）
    fn resolve<'a>(&'a self, cred: &'a Credentials, file_id: &'a str) -> BoxFut<'a, Result<PlayTarget, String>>;

    /// 刷新登录态（refresh_token → access_token）；不支持时返回原凭据
    fn refresh<'a>(&'a self, cred: &'a Credentials) -> BoxFut<'a, Result<Credentials, String>> {
        Box::pin(async move { Ok(cred.clone()) })
    }

    /// 设备码授权开始（OneDrive / 部分 openapi）
    fn device_auth<'a>(&'a self, _client_id: &'a str) -> BoxFut<'a, Result<AuthChallenge, String>> {
        Box::pin(async { Err("该网盘不支持设备码授权".into()) })
    }

    /// 设备码授权轮询
    fn poll_device_auth<'a>(
        &'a self,
        _client_id: &'a str,
        _device_code: &'a str,
    ) -> BoxFut<'a, Result<AuthOutcome, String>> {
        Box::pin(async { Err("该网盘不支持设备码授权".into()) })
    }

    /// 分享链接目录列举（share 内文件树）
    fn list_share<'a>(
        &'a self,
        _cred: &'a Credentials,
        _share: &'a ShareRef,
        _dir_id: &'a str,
        _cursor: Option<&'a str>,
        _page_size: u32,
    ) -> BoxFut<'a, Result<Page, String>> {
        Box::pin(async { Err("该网盘不支持分享链接直接浏览（请先转存到自己的网盘）".into()) })
    }

    /// 分享链接内文件解析播放直链
    fn resolve_share<'a>(
        &'a self,
        _cred: &'a Credentials,
        _share: &'a ShareRef,
        _file_id: &'a str,
    ) -> BoxFut<'a, Result<PlayTarget, String>> {
        Box::pin(async { Err("该网盘不支持分享链接直接播放（请先转存到自己的网盘）".into()) })
    }
}

/// 按种类取适配器（'static 单例，无分配）
pub fn provider(kind: ProviderKind) -> &'static dyn Provider {
    use std::sync::OnceLock;
    static BAIDU: OnceLock<baidu::BaiduProvider> = OnceLock::new();
    static ALIYUN: OnceLock<aliyun::AliyunProvider> = OnceLock::new();
    static ONEDRIVE: OnceLock<onedrive::OneDriveProvider> = OnceLock::new();
    static HTTP: OnceLock<http::HttpDirProvider> = OnceLock::new();
    match kind {
        ProviderKind::Baidu => BAIDU.get_or_init(baidu::BaiduProvider::new),
        ProviderKind::Aliyun => ALIYUN.get_or_init(aliyun::AliyunProvider::new),
        ProviderKind::OneDrive => ONEDRIVE.get_or_init(onedrive::OneDriveProvider::new),
        ProviderKind::Http => HTTP.get_or_init(http::HttpDirProvider::new),
    }
}

/// 全部已注册适配器（RPC `netdisk.providers` 用）
pub fn all_providers() -> Vec<&'static dyn Provider> {
    [ProviderKind::Baidu, ProviderKind::Aliyun, ProviderKind::OneDrive, ProviderKind::Http]
        .into_iter()
        .map(provider)
        .collect()
}

/// provider 描述（UI 渲染授权表单用）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub kind: &'static str,
    pub name: &'static str,
    pub auth_modes: Vec<&'static str>,
    pub supports_share: bool,
    /// 凭据录入提示（占位符）
    pub hint: &'static str,
}

pub fn provider_infos() -> Vec<ProviderInfo> {
    all_providers()
        .into_iter()
        .map(|p| {
            let kind = p.kind();
            ProviderInfo {
                kind: kind.as_str(),
                name: p.name(),
                auth_modes: p.auth_modes().iter().map(|m| m.as_str()).collect(),
                supports_share: p.supports_share(),
                hint: match kind {
                    ProviderKind::Baidu => "粘贴浏览器 Cookie（需含 BDUSS=；仅访问自己的网盘）",
                    ProviderKind::Aliyun => "粘贴 refresh_token（阿里云盘开放平台 / 网页版登录后获取）",
                    ProviderKind::OneDrive => "设备码登录：填写 Azure 应用 client_id 后点「开始授权」",
                    ProviderKind::Http => "填写 HTTP 目录网关地址（如 http://127.0.0.1:8080）+ 访问 token",
                },
            }
        })
        .collect()
}

/// 统一错误包装：把网盘错误归类，便于 UI 给出可操作提示
#[derive(Debug, Clone)]
pub struct NetdiskError {
    /// unauthorized | not_found | rate_limited | unsupported | network | other
    pub kind: &'static str,
    pub message: String,
}

impl NetdiskError {
    pub fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
    /// 是否需要刷新登录态（401/403 语义）
    pub fn need_reauth(&self) -> bool {
        self.kind == "unauthorized"
    }
}

impl std::fmt::Display for NetdiskError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
