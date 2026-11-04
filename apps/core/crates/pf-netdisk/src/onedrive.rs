//! OneDrive / SharePoint 适配器（Microsoft Graph v1.0，设备码授权）
//!
//! 鉴权：设备码流程（OAuth 2.0 device code）。用户需自备 Azure 应用 client_id
//! （公共客户端 + 允许 public client flows），scope = `Files.Read.All offline_access`。
//! 桌面端不内置任何 client_secret——避免把第三方密钥打进安装包。
//!
//! 能力：目录分页（@odata.nextLink 游标）/ 播放直链（@microsoft.graph.downloadUrl）
//! / 分享链接（Graph shares API，支持单文件与文件夹）。
//!
//! 直链特性：downloadUrl 约 1 小时有效，无需额外请求头。

use serde_json::Value;

use crate::{
    http::{client, now_ms, opt_i64, opt_str},
    AuthChallenge, AuthMode, AuthOutcome, BoxFut, Credentials, NetdiskItem, Page, PlayTarget,
    Provider, ProviderKind, ShareRef,
};

const GRAPH: &str = "https://graph.microsoft.com/v1.0";
const LOGIN: &str = "https://login.microsoftonline.com/common/oauth2/v2.0";
const SCOPE: &str = "Files.Read.All offline_access";
/// downloadUrl 名义 1 小时；保守按 55 分钟缓存，到期前换链
const DLINK_TTL_MS: i64 = 55 * 60 * 1000;

pub struct OneDriveProvider;

impl OneDriveProvider {
    pub fn new() -> Self {
        Self
    }

    fn bearer(cred: &Credentials) -> Result<String, String> {
        cred.bearer()
            .ok_or_else(|| "缺少 OneDrive access_token（请先完成设备码授权）".to_string())
    }

    fn root_id(dir_id: &str) -> &str {
        if dir_id.trim().is_empty() {
            "root"
        } else {
            dir_id
        }
    }

    fn parse_item(v: &Value) -> Option<NetdiskItem> {
        let id = opt_str(v, &["id"])?;
        let name = opt_str(v, &["name"]).unwrap_or_else(|| id.clone());
        let is_dir = v.get("folder").map(|f| !f.is_null()).unwrap_or(false);
        let size = opt_i64(v, &["size"]).unwrap_or(0).max(0) as u64;
        let mtime = opt_str(v, &["lastModifiedDateTime"])
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok())
            .map(|d| d.timestamp_millis());
        Some(NetdiskItem::classify(id, name, is_dir, size, mtime))
    }

    /// Graph 分页：只跟随 graph.microsoft.com 的 nextLink（防凭据外泄）
    fn safe_next_link(v: &Value) -> Option<String> {
        opt_str(v, &["@odata.nextLink"]).filter(|u| u.starts_with("https://graph.microsoft.com/"))
    }

    async fn get_json_auth(url: &str, cred: &Credentials) -> Result<Value, String> {
        let resp = client()
            .get(url)
            .timeout(std::time::Duration::from_secs(25))
            .header("Authorization", Self::bearer(cred)?)
            .send()
            .await
            .map_err(|e| format!("请求失败: {e}"))?;
        let status = resp.status().as_u16();
        let text = resp.text().await.map_err(|e| format!("读取失败: {e}"))?;
        if !(200..300).contains(&status) {
            return Err(format!(
                "Graph 请求失败：HTTP {status} {}",
                text.chars().take(200).collect::<String>()
            ));
        }
        serde_json::from_str(&text).map_err(|e| format!("响应非 JSON: {e}"))
    }

    async fn children(url: &str, cred: &Credentials) -> Result<Page, String> {
        let v = Self::get_json_auth(url, cred).await?;
        let items = v
            .get("value")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Self::parse_item).collect::<Vec<_>>())
            .unwrap_or_default();
        Ok(Page { items, next_cursor: Self::safe_next_link(&v), total: None })
    }

    /// 分享根项（用于取 downloadUrl / parentReference.driveId）
    async fn share_root(cred: &Credentials, share: &ShareRef) -> Result<Value, String> {
        Self::get_json_auth(&format!("{GRAPH}/shares/{}/driveItem", share.share_id), cred).await
    }

    async fn share_token_request(form: Vec<(&str, String)>) -> Result<Value, String> {
        let resp = client()
            .post(format!("{LOGIN}/token"))
            .timeout(std::time::Duration::from_secs(25))
            .form(&form)
            .send()
            .await
            .map_err(|e| format!("登录请求失败: {e}"))?;
        let text = resp.text().await.map_err(|e| format!("读取失败: {e}"))?;
        serde_json::from_str(&text).map_err(|e| format!("登录响应非 JSON: {e}（{text}）"))
    }
}

impl Default for OneDriveProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl Provider for OneDriveProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::OneDrive
    }
    fn name(&self) -> &'static str {
        "OneDrive"
    }
    fn auth_modes(&self) -> Vec<AuthMode> {
        vec![AuthMode::DeviceCode, AuthMode::Token]
    }
    fn supports_share(&self) -> bool {
        true
    }

    fn verify<'a>(&'a self, cred: &'a Credentials) -> BoxFut<'a, Result<(), String>> {
        Box::pin(async move {
            Self::get_json_auth(&format!("{GRAPH}/me/drive/root?$select=id"), cred).await.map(|_| ())
        })
    }

    fn list<'a>(
        &'a self,
        cred: &'a Credentials,
        dir_id: &'a str,
        cursor: Option<&'a str>,
        page_size: u32,
    ) -> BoxFut<'a, Result<Page, String>> {
        Box::pin(async move {
            let url = match cursor {
                Some(link) if link.starts_with("https://graph.microsoft.com/") => link.to_string(),
                _ => {
                    // M2：id 白名单（dir_id 直接拼 URL，拒绝路径注入）
                    if !valid_graph_id(dir_id) && dir_id != "root" {
                        return Err("非法的目录 id".to_string());
                    }
                    let id = Self::root_id(dir_id);
                    let base = if id == "root" {
                        format!("{GRAPH}/me/drive/root/children")
                    } else {
                        format!("{GRAPH}/me/drive/items/{id}/children")
                    };
                    format!(
                        "{base}?$top={}&$select=id,name,size,folder,file,lastModifiedDateTime&$orderby=name",
                        page_size.clamp(1, 200)
                    )
                }
            };
            Self::children(&url, cred).await
        })
    }

    fn resolve<'a>(&'a self, cred: &'a Credentials, file_id: &'a str) -> BoxFut<'a, Result<PlayTarget, String>> {
        Box::pin(async move {
            // M2：id 白名单 —— 拒绝可改变 URL 语义的字符（路径注入）
            if !valid_graph_id(file_id) {
                return Err("非法的文件 id".to_string());
            }
            let url = format!(
                "{GRAPH}/me/drive/items/{file_id}?$select=id,name,size,file,@microsoft.graph.downloadUrl"
            );
            let v = Self::get_json_auth(&url, cred).await?;
            let link = opt_str(&v, &["@microsoft.graph.downloadUrl"])
                .ok_or_else(|| "OneDrive 未返回下载地址（该条目可能是文件夹或已被移动）".to_string())?;
            Ok(PlayTarget {
                url: link,
                headers: vec![],
                expires_at: Some(now_ms() + DLINK_TTL_MS),
                ext: opt_str(&v, &["name"]).and_then(|n| n.rsplit_once('.').map(|(_, e)| e.to_lowercase())),
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
                .ok_or_else(|| "缺少 OneDrive refresh_token（请重新设备码授权）".to_string())?;
            let client_id = cred
                .client_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "缺少 client_id（Azure 应用 ID）".to_string())?;
            let v = Self::share_token_request(vec![
                ("grant_type", "refresh_token".into()),
                ("client_id", client_id.to_string()),
                ("refresh_token", rt.to_string()),
                ("scope", SCOPE.into()),
            ])
            .await?;
            let Some(access) = opt_str(&v, &["access_token"]) else {
                let err = opt_str(&v, &["error_description", "error"]).unwrap_or_default();
                return Err(format!("OneDrive token 刷新失败：{err}"));
            };
            let mut next = cred.clone();
            next.access_token = Some(access);
            if let Some(t) = opt_str(&v, &["refresh_token"]) {
                next.refresh_token = Some(t);
            }
            next.expires_at = opt_i64(&v, &["expires_in"]).map(|s| now_ms() + s * 1000);
            Ok(next)
        })
    }

    fn device_auth<'a>(&'a self, client_id: &'a str) -> BoxFut<'a, Result<AuthChallenge, String>> {
        Box::pin(async move {
            if client_id.trim().is_empty() {
                return Err("OneDrive 设备码授权需要 Azure 应用 client_id".into());
            }
            let resp = client()
                .post(format!("{LOGIN}/devicecode"))
                .timeout(std::time::Duration::from_secs(25))
                .form(&[("client_id", client_id.trim()), ("scope", SCOPE)])
                .send()
                .await
                .map_err(|e| format!("设备码请求失败: {e}"))?;
            let status = resp.status().as_u16();
            let text = resp.text().await.map_err(|e| e.to_string())?;
            if !(200..300).contains(&status) {
                return Err(format!("设备码请求失败：HTTP {status} {}", text.chars().take(200).collect::<String>()));
            }
            let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            Ok(AuthChallenge {
                device_code: opt_str(&v, &["device_code"]).ok_or("未返回 device_code")?,
                user_code: opt_str(&v, &["user_code"]).unwrap_or_default(),
                verification_uri: opt_str(&v, &["verification_uri"]).unwrap_or_default(),
                interval_secs: opt_i64(&v, &["interval"]).unwrap_or(5).max(1) as u64,
                expires_in: opt_i64(&v, &["expires_in"]).unwrap_or(900).max(1) as u64,
                message: opt_str(&v, &["message"]),
            })
        })
    }

    fn poll_device_auth<'a>(
        &'a self,
        client_id: &'a str,
        device_code: &'a str,
    ) -> BoxFut<'a, Result<AuthOutcome, String>> {
        Box::pin(async move {
            let v = Self::share_token_request(vec![
                (
                    "grant_type",
                    "urn:ietf:params:oauth:grant-type:device_code".into(),
                ),
                ("client_id", client_id.trim().to_string()),
                ("device_code", device_code.to_string()),
            ])
            .await?;
            // 未完成时返回 error=authorization_pending / slow_down
            if let Some(err) = opt_str(&v, &["error"]) {
                return match err.as_str() {
                    "authorization_pending" | "slow_down" => Ok(AuthOutcome {
                        pending: true,
                        cred: None,
                        message: opt_str(&v, &["error_description"]),
                    }),
                    other => Err(format!(
                        "授权失败：{other} {}",
                        opt_str(&v, &["error_description"]).unwrap_or_default()
                    )),
                };
            }
            let Some(access) = opt_str(&v, &["access_token"]) else {
                return Ok(AuthOutcome {
                    pending: true,
                    cred: None,
                    message: opt_str(&v, &["error_description"]),
                });
            };
            let cred = Credentials {
                access_token: Some(access),
                refresh_token: opt_str(&v, &["refresh_token"]),
                client_id: Some(client_id.trim().to_string()),
                expires_at: opt_i64(&v, &["expires_in"]).map(|s| now_ms() + s * 1000),
                ..Default::default()
            };
            Ok(AuthOutcome { pending: false, cred: Some(cred), message: None })
        })
    }

    fn list_share<'a>(
        &'a self,
        cred: &'a Credentials,
        share: &'a ShareRef,
        _dir_id: &'a str,
        cursor: Option<&'a str>,
        page_size: u32,
    ) -> BoxFut<'a, Result<Page, String>> {
        Box::pin(async move {
            let url = match cursor {
                Some(link) if link.starts_with("https://graph.microsoft.com/") => link.to_string(),
                _ => format!(
                    "{GRAPH}/shares/{}/driveItem/children?$top={}&$select=id,name,size,folder,file,lastModifiedDateTime",
                    share.share_id,
                    page_size.clamp(1, 200)
                ),
            };
            let v = Self::get_json_auth(&url, cred).await?;
            let mut items = v
                .get("value")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Self::parse_item).collect::<Vec<_>>())
                .unwrap_or_default();
            // 单文件分享：没有 children，只有根项本身
            if items.is_empty() {
                if let Ok(root) = Self::share_root(cred, share).await {
                    if let Some(it) = Self::parse_item(&root) {
                        if !it.is_dir {
                            items.push(it);
                        }
                    }
                }
            }
            Ok(Page { items, next_cursor: Self::safe_next_link(&v), total: None })
        })
    }

    fn resolve_share<'a>(
        &'a self,
        cred: &'a Credentials,
        share: &'a ShareRef,
        file_id: &'a str,
    ) -> BoxFut<'a, Result<PlayTarget, String>> {
        Box::pin(async move {
            if !valid_graph_id(file_id) {
                return Err("非法的文件 id".to_string());
            }
            let root = Self::share_root(cred, share).await?;
            let root_id = opt_str(&root, &["id"]).unwrap_or_default();
            // 单文件分享或直接请求根项
            if root_id == file_id || file_id == "root" {
                let link = opt_str(&root, &["@microsoft.graph.downloadUrl"]).ok_or_else(|| {
                    "该分享是文件夹，请进入目录选择具体文件".to_string()
                })?;
                return Ok(PlayTarget {
                    url: link,
                    headers: vec![],
                    expires_at: Some(now_ms() + DLINK_TTL_MS),
                    ext: opt_str(&root, &["name"]).and_then(|n| n.rsplit_once('.').map(|(_, e)| e.to_lowercase())),
                });
            }
            // 子项：借分享根项的 driveId 走 drives/items 取下载地址
            let drive_id = root
                .get("parentReference")
                .and_then(|p| opt_str(p, &["driveId"]))
                .ok_or_else(|| "无法定位分享所在驱动器（parentReference.driveId 缺失）".to_string())?;
            // M2：分享越权校验 —— 沿 parent 链上溯确认 file_id 确实在分享根的
            // 子树内，防止持 shim 密钥者借账号 token 读全盘任意文件
            if !Self::ensure_in_share(cred, &drive_id, file_id, &root_id).await? {
                return Err("该文件不属于此分享".to_string());
            }
            let url = format!(
                "{GRAPH}/drives/{drive_id}/items/{file_id}?$select=id,name,file,@microsoft.graph.downloadUrl"
            );
            let v = Self::get_json_auth(&url, cred).await?;
            let link = opt_str(&v, &["@microsoft.graph.downloadUrl"])
                .ok_or_else(|| "未取得分享文件下载地址".to_string())?;
            Ok(PlayTarget {
                url: link,
                headers: vec![],
                expires_at: Some(now_ms() + DLINK_TTL_MS),
                ext: opt_str(&v, &["name"]).and_then(|n| n.rsplit_once('.').map(|(_, e)| e.to_lowercase())),
            })
        })
    }
}

impl OneDriveProvider {
    /// M2：校验 item 在分享根子树内 —— 沿 `parentReference.id` 上溯至 root_id
    /// （深度上限 12，防异常深目录打爆请求；父链断掉即判定越权）。
    async fn ensure_in_share(
        cred: &Credentials,
        drive_id: &str,
        file_id: &str,
        root_id: &str,
    ) -> Result<bool, String> {
        let mut cur = file_id.to_string();
        for _ in 0..12 {
            if cur == root_id {
                return Ok(true);
            }
            let v = Self::get_json_auth(
                &format!("{GRAPH}/drives/{drive_id}/items/{cur}?$select=id,parentReference"),
                cred,
            )
            .await?;
            let Some(parent) = v.get("parentReference").and_then(|p| opt_str(p, &["id"])) else {
                return Ok(false);
            };
            cur = parent;
        }
        Err("分享路径校验超过深度上限".to_string())
    }
}

/// M2：Graph id 白名单 —— 拒绝会改变 URL/JSON 语义的字符
/// （Graph id 为 base64 型字符串，正常不含 `/ ? # % 空白` 等）
fn valid_graph_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && !id.contains("..")
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.~!$&'()*+,;=:@".contains(&b))
}
