//! 百度网盘适配器（pan.baidu.com 网页版 API，Cookie 鉴权）
//!
//! 为何走 Cookie 而非 OAuth：百度网盘开放平台需要企业资质申请 API Key，
//! 桌面端无法内置。Cookie（BDUSS）是社区客户端的通行做法，仅访问用户自己的网盘。
//!
//! 能力边界（诚实声明，UI 会展示）：
//!  - ✅ 目录列举（分页）/ 播放直链解析（dlink）
//!  - ❌ 分享链接直接播放：需先「转存到我的网盘」（百度侧有验证码/风控，不做自动化）
//!
//! 直链特性：dlink 未声明有效期，实测数小时；带 Cookie + `User-Agent: pan.baidu.com`
//! 才能通过 CDN 校验（否则 403）——因此播放请求头必须由代理注入。

use serde_json::Value;

use crate::{
    http::{get_json, now_ms, opt_i64, opt_str, urlencode},
    AuthMode, BoxFut, Credentials, NetdiskItem, Page, PlayTarget, Provider, ProviderKind,
};

const PAN: &str = "https://pan.baidu.com";
/// dlink 无官方有效期，保守按 6 小时缓存（到期前主动换链；403 亦兜底换链）
const DLINK_TTL_MS: i64 = 6 * 3600 * 1000;

pub struct BaiduProvider;

impl BaiduProvider {
    pub fn new() -> Self {
        Self
    }

    fn cookie(cred: &Credentials) -> Result<String, String> {
        let c = cred
            .cookie
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "缺少百度 Cookie（需含 BDUSS=；可在浏览器登录 pan.baidu.com 后复制）".to_string())?;
        if !c.contains("BDUSS=") {
            return Err("Cookie 缺少 BDUSS 字段（请复制完整 Cookie）".into());
        }
        Ok(c.to_string())
    }

    fn headers(cred: &Credentials) -> Result<Vec<(String, String)>, String> {
        Ok(vec![
            ("Cookie".into(), Self::cookie(cred)?),
            // 百度 CDN 校验 UA 站点亲和性，非 pan.baidu.com 会 403
            ("User-Agent".into(), "pan.baidu.com".into()),
            ("Referer".into(), "https://pan.baidu.com/".into()),
        ])
    }

    /// errno 语义归一（0 成功；-6 未登录；-9 不存在；-62 请求过多）
    fn errno_error(errno: i64, op: &str, body: &str) -> Option<String> {
        if errno == 0 {
            return None;
        }
        let hint = match errno {
            -6 => "（Cookie 已失效，请重新登录后粘贴）",
            -9 => "（文件不存在或已删除）",
            -62 => "（请求过于频繁，已触发限流）",
            _ => "",
        };
        Some(format!(
            "{op} 失败：errno={errno}{hint} {}",
            body.chars().take(160).collect::<String>()
        ))
    }

    fn parse_item(v: &Value) -> Option<NetdiskItem> {
        let id = opt_str(v, &["fs_id", "fsId"])?;
        let name = opt_str(v, &["server_filename", "filename", "name"]).unwrap_or_else(|| id.clone());
        // isdir 可能是 0/1 或 true/false
        let is_dir = v
            .get("isdir")
            .map(|d| d.as_bool().unwrap_or_else(|| d.as_i64().unwrap_or(0) == 1))
            .unwrap_or(false);
        let size = opt_i64(v, &["size"]).unwrap_or(0).max(0) as u64;
        let mtime = opt_i64(v, &["server_mtime", "local_mtime"]).map(|s| s * 1000);
        Some(NetdiskItem::classify(id, name, is_dir, size, mtime))
    }
}

impl Default for BaiduProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl Provider for BaiduProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Baidu
    }
    fn name(&self) -> &'static str {
        "百度网盘"
    }
    fn auth_modes(&self) -> Vec<AuthMode> {
        vec![AuthMode::Cookie]
    }

    fn verify<'a>(&'a self, cred: &'a Credentials) -> BoxFut<'a, Result<(), String>> {
        Box::pin(async move { self.list(cred, "/", None, 1).await.map(|_| ()) })
    }

    fn list<'a>(
        &'a self,
        cred: &'a Credentials,
        dir_id: &'a str,
        cursor: Option<&'a str>,
        page_size: u32,
    ) -> BoxFut<'a, Result<Page, String>> {
        Box::pin(async move {
            let dir = if dir_id.trim().is_empty() { "/" } else { dir_id };
            // 游标 = 页码（百度原生分页）
            let page: u32 = cursor.and_then(|c| c.parse().ok()).unwrap_or(1).max(1);
            let num = page_size.clamp(1, 200);
            let url = format!(
                "{PAN}/api/list?dir={}&page={page}&num={num}&order=name&desc=0&web=1&clienttype=0",
                urlencode(dir)
            );
            let v = get_json(&url, Self::headers(cred)?, 20).await?;
            let errno = opt_i64(&v, &["errno"]).unwrap_or(0);
            if let Some(e) = Self::errno_error(errno, "列目录", &v.to_string()) {
                return Err(e);
            }
            let items = v
                .get("list")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Self::parse_item).collect::<Vec<_>>())
                .unwrap_or_default();
            // has_more 为 1 时下一页 = page+1
            let has_more = opt_i64(&v, &["has_more"]).unwrap_or(0) == 1
                || v.get("has_more").and_then(Value::as_bool).unwrap_or(false);
            Ok(Page {
                items,
                next_cursor: has_more.then(|| (page + 1).to_string()),
                total: None,
            })
        })
    }

    fn resolve<'a>(&'a self, cred: &'a Credentials, file_id: &'a str) -> BoxFut<'a, Result<PlayTarget, String>> {
        Box::pin(async move {
            let fsids = format!("[{}]", urlencode(file_id));
            let url = format!("{PAN}/api/filemetas?dlink=1&fsids={fsids}&web=1");
            let v = get_json(&url, Self::headers(cred)?, 20).await?;
            let errno = opt_i64(&v, &["errno"]).unwrap_or(0);
            if let Some(e) = Self::errno_error(errno, "解析直链", &v.to_string()) {
                return Err(e);
            }
            // 新版本返回 info[]，旧版本返回 list[]
            let dlink = ["info", "list"]
                .iter()
                .find_map(|k| {
                    v.get(*k)
                        .and_then(Value::as_array)
                        .and_then(|a| a.first())
                        .and_then(|f| opt_str(f, &["dlink"]))
                })
                .ok_or_else(|| "百度未返回 dlink（该文件可能无下载权限或已被限速）".to_string())?;
            Ok(PlayTarget {
                url: dlink,
                headers: vec![
                    ("User-Agent".into(), "pan.baidu.com".into()),
                    ("Referer".into(), "https://pan.baidu.com/".into()),
                    ("Cookie".into(), Self::cookie(cred)?),
                ],
                expires_at: Some(now_ms() + DLINK_TTL_MS),
                ext: None,
            })
        })
    }

    // 百度 Cookie 登录态无 refresh_token 机制：失效后需用户重新粘贴
    fn refresh<'a>(&'a self, cred: &'a Credentials) -> BoxFut<'a, Result<Credentials, String>> {
        Box::pin(async move {
            if cred.cookie.as_deref().map(|c| c.contains("BDUSS=")).unwrap_or(false) {
                Ok(cred.clone())
            } else {
                Err("百度网盘 Cookie 已失效，请在网盘页重新粘贴（含 BDUSS=）".into())
            }
        })
    }

    fn list_share<'a>(
        &'a self,
        _cred: &'a Credentials,
        _share: &'a crate::ShareRef,
        _dir_id: &'a str,
        _cursor: Option<&'a str>,
        _page_size: u32,
    ) -> BoxFut<'a, Result<Page, String>> {
        Box::pin(async {
            Err("百度网盘分享链接需先「转存到我的网盘」再播放（分享接口有验证码/风控，未做自动化）".into())
        })
    }
}
