//! 阿里云盘适配器（api.aliyundrive.com v2，refresh_token 鉴权）
//!
//! 鉴权：用户在阿里云盘开放平台 / 网页版登录后可获得 `refresh_token`，
//! 本适配器用它换取 access_token（2 小时）并自动续期——这是社区客户端的标准做法，
//! 因为官方 OAuth 同样需要注册应用。
//!
//! 能力：目录分页（marker）/ 播放直链（get_download_url，900s）/ 分享链接浏览与播放
//! （get_share_token + get_share_link_download_url）。
//!
//! 直链特性：默认 15 分钟有效，且必须带 `Referer: https://www.aliyundrive.com/`，
//! 因此直链的「换链」必须由本地代理完成，播放器只持有稳定 shim URL。

use serde_json::{json, Value};

use crate::{
    http::{expires_from_secs, opt_i64, opt_str, post_json},
    AuthMode, BoxFut, Credentials, NetdiskItem, Page, PlayTarget, Provider, ProviderKind, ShareRef,
};

const API: &str = "https://api.aliyundrive.com";
const AUTH: &str = "https://auth.aliyundrive.com";
/// 申请直链有效期（秒）；阿里云盘上限 14400，取 900 平衡安全与请求数
const DLINK_EXPIRE_SEC: i64 = 900;

pub struct AliyunProvider;

impl AliyunProvider {
    pub fn new() -> Self {
        Self
    }

    fn bearer(cred: &Credentials) -> Result<String, String> {
        cred.bearer()
            .ok_or_else(|| "缺少阿里云盘 access_token（请先填写 refresh_token 并刷新）".to_string())
    }

    fn headers(cred: &Credentials) -> Result<Vec<(String, String)>, String> {
        Ok(vec![("Authorization".into(), Self::bearer(cred)?)])
    }

    fn drive_id(cred: &Credentials) -> Result<String, String> {
        cred.drive_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .ok_or_else(|| "缺少 drive_id（请先执行一次「刷新账号」以自动获取）".to_string())
    }

    fn parse_item(v: &Value) -> Option<NetdiskItem> {
        let id = opt_str(v, &["file_id", "fileId"])?;
        let name = opt_str(v, &["name"]).unwrap_or_else(|| id.clone());
        let is_dir = v.get("type").and_then(Value::as_str).map(|t| t == "folder").unwrap_or(false);
        let size = opt_i64(v, &["size"]).unwrap_or(0).max(0) as u64;
        let mtime = opt_str(v, &["updated_at", "updatedAt"])
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok())
            .map(|d| d.timestamp_millis());
        Some(NetdiskItem::classify(id, name, is_dir, size, mtime))
    }

    /// 分享令牌（stateless：每次现取，避免把会话塞进凭据）
    async fn share_token(_cred: &Credentials, share: &ShareRef) -> Result<String, String> {
        let body = json!({
            "share_id": share.share_id,
            "share_pwd": share.pwd.clone().unwrap_or_default(),
        });
        let v = post_json(
            &format!("{API}/v2/share_link/get_share_token"),
            vec![("Referer".into(), "https://www.aliyundrive.com/".into())],
            body,
            20,
        )
        .await
        .map_err(|e| format!("获取分享令牌失败：{e}"))?;
        opt_str(&v, &["share_token"]).ok_or_else(|| "分享令牌为空（提取码可能错误或分享已失效）".to_string())
    }

    async fn list_share_inner(
        cred: &Credentials,
        share: &ShareRef,
        dir_id: &str,
        cursor: Option<&str>,
        page_size: u32,
    ) -> Result<Page, String> {
        let token = Self::share_token(cred, share).await?;
        let body = json!({
            "share_id": share.share_id,
            "share_token": token,
            "parent_file_id": if dir_id.trim().is_empty() { "root" } else { dir_id },
            "limit": page_size.clamp(1, 100),
            "marker": cursor.unwrap_or(""),
            "order_by": "name",
            "order_direction": "ASC",
            "fields": "*",
        });
        let v = post_json(
            &format!("{API}/v2/file/list"),
            vec![
                ("Authorization".into(), Self::bearer(cred)?),
                ("Referer".into(), "https://www.aliyundrive.com/".into()),
            ],
            body,
            25,
        )
        .await?;
        let items = v
            .get("items")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Self::parse_item).collect::<Vec<_>>())
            .unwrap_or_default();
        let next = opt_str(&v, &["next_marker"]).filter(|s| !s.is_empty());
        Ok(Page { items, next_cursor: next, total: None })
    }
}

impl Default for AliyunProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl Provider for AliyunProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Aliyun
    }
    fn name(&self) -> &'static str {
        "阿里云盘"
    }
    fn auth_modes(&self) -> Vec<AuthMode> {
        vec![AuthMode::Token]
    }
    fn supports_share(&self) -> bool {
        true
    }

    /// 补齐 drive_id / user_id（首次使用时自动派生，由上层回写凭据）
    fn prepare<'a>(&'a self, cred: &'a mut Credentials) -> BoxFut<'a, Result<bool, String>> {
        Box::pin(async move {
            if cred.drive_id.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false) {
                return Ok(false);
            }
            let v = post_json(&format!("{API}/v2/user/get"), Self::headers(cred)?, json!({}), 20).await?;
            let drive = opt_str(&v, &["default_drive_id", "defaultDriveId"])
                .ok_or_else(|| "阿里云盘未返回 default_drive_id（token 可能已失效）".to_string())?;
            cred.drive_id = Some(drive);
            if let Some(uid) = opt_str(&v, &["user_id", "userId"]) {
                cred.user_id = Some(uid);
            }
            Ok(true)
        })
    }

    fn verify<'a>(&'a self, cred: &'a Credentials) -> BoxFut<'a, Result<(), String>> {
        Box::pin(async move { self.list(cred, "root", None, 1).await.map(|_| ()) })
    }

    fn list<'a>(
        &'a self,
        cred: &'a Credentials,
        dir_id: &'a str,
        cursor: Option<&'a str>,
        page_size: u32,
    ) -> BoxFut<'a, Result<Page, String>> {
        Box::pin(async move {
            let body = json!({
                "drive_id": Self::drive_id(cred)?,
                "parent_file_id": if dir_id.trim().is_empty() { "root" } else { dir_id },
                "limit": page_size.clamp(1, 100),
                "marker": cursor.unwrap_or(""),
                "order_by": "name",
                "order_direction": "ASC",
                "fields": "*",
            });
            let v = post_json(
                &format!("{API}/v2/file/list"),
                vec![
                    ("Authorization".into(), Self::bearer(cred)?),
                    ("Referer".into(), "https://www.aliyundrive.com/".into()),
                ],
                body,
                25,
            )
            .await?;
            let items = v
                .get("items")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Self::parse_item).collect::<Vec<_>>())
                .unwrap_or_default();
            let next = opt_str(&v, &["next_marker"]).filter(|s| !s.is_empty());
            Ok(Page { items, next_cursor: next, total: None })
        })
    }

    fn resolve<'a>(&'a self, cred: &'a Credentials, file_id: &'a str) -> BoxFut<'a, Result<PlayTarget, String>> {
        Box::pin(async move {
            let body = json!({
                "drive_id": Self::drive_id(cred)?,
                "file_id": file_id,
                "expire_sec": DLINK_EXPIRE_SEC,
            });
            let v = post_json(
                &format!("{API}/v2/file/get_download_url"),
                vec![
                    ("Authorization".into(), Self::bearer(cred)?),
                    ("Referer".into(), "https://www.aliyundrive.com/".into()),
                ],
                body,
                25,
            )
            .await?;
            let url = opt_str(&v, &["url"]).ok_or_else(|| {
                "阿里云盘未返回直链（可能为「仅在线预览」文件或无下载权限）".to_string()
            })?;
            // expiration 为 ISO8601；缺失时按申请的有效期兜底
            let expires_at = opt_str(&v, &["expiration"])
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok())
                .map(|d| d.timestamp_millis())
                .or_else(|| expires_from_secs(DLINK_EXPIRE_SEC));
            Ok(PlayTarget {
                url,
                headers: vec![
                    ("Referer".into(), "https://www.aliyundrive.com/".into()),
                    ("User-Agent".into(), "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AliyunDrive".into()),
                ],
                expires_at,
                ext: None,
            })
        })
    }

    fn refresh<'a>(&'a self, cred: &'a Credentials) -> BoxFut<'a, Result<Credentials, String>> {
        Box::pin(async move {
            let rt = cred
                .refresh_token
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "缺少阿里云盘 refresh_token".to_string())?;
            let body = json!({ "grant_type": "refresh_token", "refresh_token": rt });
            let v = post_json(&format!("{AUTH}/v2/account/token"), vec![], body, 20)
                .await
                .map_err(|e| format!("阿里云盘 token 刷新失败：{e}"))?;
            let mut next = cred.clone();
            next.access_token = opt_str(&v, &["access_token"]);
            if let Some(t) = opt_str(&v, &["refresh_token"]) {
                next.refresh_token = Some(t);
            }
            next.expires_at = opt_i64(&v, &["expires_in"]).and_then(expires_from_secs);
            if next.access_token.is_none() {
                return Err("刷新响应缺少 access_token".into());
            }
            // 刷新后重新派生 drive_id（换设备时可能变化）
            let mut probe = next.clone();
            if let Err(e) = self.prepare(&mut probe).await {
                eprintln!("[pf-netdisk] aliyun prepare after refresh 失败: {e}");
            }
            Ok(probe)
        })
    }

    fn list_share<'a>(
        &'a self,
        cred: &'a Credentials,
        share: &'a ShareRef,
        dir_id: &'a str,
        cursor: Option<&'a str>,
        page_size: u32,
    ) -> BoxFut<'a, Result<Page, String>> {
        Box::pin(async move { Self::list_share_inner(cred, share, dir_id, cursor, page_size).await })
    }

    fn resolve_share<'a>(
        &'a self,
        cred: &'a Credentials,
        share: &'a ShareRef,
        file_id: &'a str,
    ) -> BoxFut<'a, Result<PlayTarget, String>> {
        Box::pin(async move {
            let token = Self::share_token(cred, share).await?;
            let body = json!({
                "share_id": share.share_id,
                "file_id": file_id,
                "share_token": token,
                "expire_sec": DLINK_EXPIRE_SEC,
            });
            let v = post_json(
                &format!("{API}/v2/file/get_share_link_download_url"),
                vec![
                    ("Authorization".into(), Self::bearer(cred)?),
                    ("Referer".into(), "https://www.aliyundrive.com/".into()),
                ],
                body,
                25,
            )
            .await?;
            let url = opt_str(&v, &["url"]).ok_or_else(|| "分享直链为空（分享可能已失效）".to_string())?;
            Ok(PlayTarget {
                url,
                headers: vec![("Referer".into(), "https://www.aliyundrive.com/".into())],
                expires_at: expires_from_secs(DLINK_EXPIRE_SEC),
                ext: None,
            })
        })
    }
}
