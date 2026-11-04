//! 网盘源编排（P9b）：账号鉴权 / 目录分页 / 播放链接解析与续期 / 分享链接
//!
//! 分工：
//!  - `pf-netdisk` 只认「凭据 + 目录 + 直链」三件事（各网盘差异全在那里）
//!  - 本模块负责**状态**：登录态自动续期与落库、直链缓存与强制换链、账号/分享绑定
//!
//! 与既有架构的关系（关键设计）：
//!  - 网盘直链会被「本地代理 shim」包一层（`/nd/{secret}/{owner}/{fileId}/v.mp4`），
//!    播放器只持有 shim URL → 直链过期/403 对播放器完全透明；
//!  - shim URL 以 `.mp4` 结尾，于是 `pf_parser::detect` 走既有 MP4 分块管线，
//!    缓存三档 / 水位调度 / 断点续存 / 多源聚合全部零改造复用。

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::Instant;

use pf_netdisk::{
    link::{cache_key, token_fresh},
    provider, Credentials, LinkCache, Page, PlayTarget, ProviderKind, ShareRef,
};
use serde::Serialize;

use crate::{CacheStore, NetdiskAccountRow, NetdiskShareRow};

/// M3：按账号的登录态刷新互斥锁（单飞）。
/// 阿里云盘 refresh_token 为**轮换型**：播放（resolve）与浏览（list）并发触发
/// 刷新时，两次 refresh 一先一后，后写库者保存的是已被作废的 refresh_token
/// → 账号永久掉线。锁内还必须**重读最新凭据**（前一个持锁者可能刚落库）。
fn refresh_lock(account_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: OnceLock<std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
        OnceLock::new();
    let map = LOCKS.get_or_init(|| std::sync::Mutex::new(HashMap::new()));
    let mut g = map.lock().unwrap_or_else(|p| p.into_inner());
    g.entry(account_id.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

/// 毫秒时间戳（i64：与网盘 API 的 epoch ms 语义一致）
fn now_ms() -> i64 {
    crate::now_ms() as i64
}

/// 账号探测结果（添加账号时回显）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetdiskProbe {
    pub ok: bool,
    pub latency_ms: Option<i64>,
    pub error: Option<String>,
}

/// 一次调用的上下文：账号（必有）+ 分享（可选）
struct Ctx {
    account: NetdiskAccountRow,
    share: Option<NetdiskShareRow>,
    cred: Credentials,
}

impl Ctx {
    fn kind(&self) -> Result<ProviderKind, String> {
        let raw = match &self.share {
            Some(s) => &s.provider,
            None => &self.account.provider,
        };
        ProviderKind::parse(raw).ok_or_else(|| format!("未知网盘类型：{raw}"))
    }
    fn share_ref(&self) -> Option<ShareRef> {
        self.share.as_ref().map(|s| ShareRef {
            provider: ProviderKind::parse(&s.provider).unwrap_or(ProviderKind::Http),
            share_id: s.share_id.clone(),
            pwd: s.pwd.clone(),
            raw: s.share_url.clone(),
        })
    }
}

/// 网盘服务（借用 CacheStore + 链接缓存，随 TaskManager 生命周期）
pub struct NetdiskService<'a> {
    pub(crate) store: &'a CacheStore,
    pub(crate) links: &'a LinkCache,
}

impl<'a> NetdiskService<'a> {
    // ---------- 账号 ----------

    pub fn accounts(&self) -> Result<Vec<NetdiskAccountRow>, String> {
        self.store.list_netdisk_accounts()
    }

    pub fn shares(&self) -> Result<Vec<NetdiskShareRow>, String> {
        self.store.list_netdisk_shares()
    }

    /// 添加账号：归一凭据 → 派生字段 → 轻量校验（列表首页）→ 入库
    pub async fn add_account(
        &self,
        provider_kind: &str,
        name: Option<&str>,
        mut cred: Credentials,
    ) -> Result<(NetdiskAccountRow, NetdiskProbe), String> {
        let kind = ProviderKind::parse(provider_kind)
            .ok_or_else(|| format!("不支持的网盘类型：{provider_kind}"))?;
        let p = provider(kind);

        // 只有 refresh_token 时先换 access_token（阿里云盘 / OneDrive 常见）
        if cred.access_token.is_none() && cred.refresh_token.is_some() {
            cred = p.refresh(&cred).await.map_err(|e| format!("获取登录态失败：{e}"))?;
        }
        // 派生字段（阿里云盘 drive_id 等）——失败不阻断，后续 list 会再报
        if let Ok(true) = p.prepare(&mut cred).await {
            eprintln!("[pf-engine] netdisk prepare 补齐派生字段：{provider_kind}");
        }

        let t0 = Instant::now();
        let probe = match p.verify(&cred).await {
            Ok(()) => NetdiskProbe { ok: true, latency_ms: Some(t0.elapsed().as_millis() as i64), error: None },
            Err(e) => NetdiskProbe { ok: false, latency_ms: None, error: Some(e.clone()) },
        };
        if !probe.ok {
            return Err(format!(
                "{} 授权校验失败：{}",
                p.name(),
                probe.error.clone().unwrap_or_default()
            ));
        }

        let display = name
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| match cred.user_id.as_deref() {
                Some(uid) if !uid.is_empty() => format!("{} · {}", p.name(), &uid[..uid.len().min(8)]),
                _ => p.name().to_string(),
            });
        let row = NetdiskAccountRow {
            id: crate::rand_hex(16),
            provider: kind.as_str().to_string(),
            name: display,
            cred: cred.to_json(),
            status: "ok".to_string(),
            last_error: None,
            expires_at: cred.expires_at,
            created_at: now_ms(),
            last_used_at: Some(now_ms()),
        };
        self.store.insert_netdisk_account(&row)?;
        Ok((row, probe))
    }

    /// 强制刷新登录态（用户点「刷新账号」，或直链 401 兜底）
    pub async fn refresh_account(&self, id: &str) -> Result<NetdiskAccountRow, String> {
        // M3：与 ctx_for 的自动续期共用单飞锁，避免并发刷新导致轮换 token 作废
        let lock = refresh_lock(id);
        let _guard = lock.lock().await;
        let row = self
            .store
            .get_netdisk_account(id)?
            .ok_or_else(|| "网盘账号不存在".to_string())?;
        let kind = ProviderKind::parse(&row.provider).ok_or_else(|| "未知网盘类型".to_string())?;
        let p = provider(kind);
        let cred = Credentials::from_json(&row.cred);
        let mut next = p.refresh(&cred).await.map_err(|e| {
            let _ = self.store.update_netdisk_status(id, "expired", Some(&e));
            e
        })?;
        if let Ok(true) = p.prepare(&mut next).await {
            // drive_id 已补齐
        }
        self.store.update_netdisk_cred(id, &next.to_json(), next.expires_at)?;
        self.store
            .get_netdisk_account(id)?
            .ok_or_else(|| "账号读取失败".to_string())
    }

    pub fn remove_account(&self, id: &str) -> Result<bool, String> {
        // 该账号的直链缓存一并失效（避免删号后仍能播）
        let prefix = format!("a-{id}|");
        self.links.invalidate_prefix(&prefix);
        self.store.delete_netdisk_account(id)
    }

    // ---------- 目录 ----------

    /// 列举目录（账号目录或分享目录），游标式分页
    pub async fn list_dir(
        &self,
        account_id: Option<&str>,
        share_id: Option<&str>,
        dir_id: &str,
        cursor: Option<&str>,
        page_size: Option<u32>,
    ) -> Result<Page, String> {
        let ctx = self.ctx_for(account_id, share_id).await?;
        let p = provider(ctx.kind()?);
        let size = page_size.unwrap_or_else(|| self.store.netdisk_page_size()).clamp(1, 200);
        let page = match ctx.share_ref() {
            Some(share) => p.list_share(&ctx.cred, &share, dir_id, cursor, size).await,
            None => p.list(&ctx.cred, dir_id, cursor, size).await,
        };
        match page {
            Ok(page) => {
                self.store.touch_netdisk_account(&ctx.account.id, now_ms());
                Ok(page)
            }
            Err(e) => {
                self.note_error(&ctx.account.id, &e);
                Err(e)
            }
        }
    }

    // ---------- 播放链接 ----------

    /// 解析播放直链（带缓存；force = 强制换链，403 兜底用）
    pub async fn resolve(
        &self,
        account_id: Option<&str>,
        share_id: Option<&str>,
        file_id: &str,
        force: bool,
    ) -> Result<PlayTarget, String> {
        if file_id.trim().is_empty() {
            return Err("fileId 为空".into());
        }
        // 先按 owner 试缓存（owner 可由参数直接推出，无需查库）
        let owner = match (account_id, share_id) {
            (_, Some(sid)) => format!("s-{sid}"),
            (Some(aid), _) => format!("a-{aid}"),
            _ => return Err("需要 accountId 或 shareId".into()),
        };
        let key = cache_key(&owner, file_id);
        let now = now_ms();
        if !force {
            if let Some(hit) = self.links.get(&key, now) {
                return Ok(hit);
            }
        } else {
            self.links.invalidate(&key);
        }

        let ctx = self.ctx_for(account_id, share_id).await?;
        let p = provider(ctx.kind()?);
        let res = match ctx.share_ref() {
            Some(share) => p.resolve_share(&ctx.cred, &share, file_id).await,
            None => p.resolve(&ctx.cred, file_id).await,
        };
        match res {
            Ok(target) => {
                self.links.put(key, target.clone());
                self.store.touch_netdisk_account(&ctx.account.id, now_ms());
                Ok(target)
            }
            Err(e) => {
                self.note_error(&ctx.account.id, &e);
                Err(e)
            }
        }
    }

    // ---------- 分享 ----------

    /// 添加分享链接：解析 → 绑定账号 → 试浏览首屏 → 入库（同 share_id 幂等）
    pub async fn add_share(
        &self,
        url: &str,
        pwd: Option<&str>,
        account_id: Option<&str>,
    ) -> Result<(NetdiskShareRow, Page), String> {
        let mut share = pf_netdisk::parse_share(url)?;
        if let Some(p) = pwd.map(str::trim).filter(|s| !s.is_empty()) {
            share.pwd = Some(p.to_string());
        }
        let p = provider(share.provider);
        if !p.supports_share() {
            return Err(format!(
                "{} 暂不支持分享链接直接播放（请先转存到自己的网盘，或在「文件」页直接浏览）",
                p.name()
            ));
        }
        if let Some(existing) = self.store.find_netdisk_share_by_sid(share.provider.as_str(), &share.share_id) {
            let ctx = self.ctx_for(existing.account_id.as_deref(), Some(&existing.id)).await?;
            let page = p
                .list_share(&ctx.cred, &share, "", None, 50)
                .await
                .unwrap_or_default();
            return Ok((existing, page));
        }

        // 绑定账号：显式指定 > 同 provider 的首个账号
        let acct = match account_id {
            Some(id) => self.store.get_netdisk_account(id)?,
            None => self
                .store
                .list_netdisk_accounts()?
                .into_iter()
                .find(|a| a.provider == share.provider.as_str()),
        };
        let acct = acct.ok_or_else(|| {
            format!(
                "浏览 {} 分享需要先添加一个 {} 账号（分享内容需要登录态才能解析）",
                p.name(),
                p.name()
            )
        })?;
        let ctx = self.ctx_for(Some(&acct.id), None).await?;

        let page = p
            .list_share(&ctx.cred, &share, "", None, 50)
            .await
            .map_err(|e| format!("分享打开失败：{e}"))?;
        let title = page
            .items
            .first()
            .map(|i| i.name.clone())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| format!("{} 分享", p.name()));

        let row = NetdiskShareRow {
            id: crate::rand_hex(12),
            provider: share.provider.as_str().to_string(),
            account_id: Some(acct.id.clone()),
            share_url: url.trim().to_string(),
            share_id: share.share_id.clone(),
            pwd: share.pwd.clone(),
            title: Some(title),
            created_at: now_ms(),
        };
        self.store.insert_netdisk_share(&row)?;
        Ok((row, page))
    }

    pub fn remove_share(&self, id: &str) -> Result<bool, String> {
        self.links.invalidate_prefix(&format!("s-{id}|"));
        self.store.delete_netdisk_share(id)
    }

    pub fn shim_token(&self) -> String {
        self.store.netdisk_shim_token()
    }

    // ---------- 内部 ----------

    /// 构造调用上下文：加载账号 → 登录态续期（必要时）→ 派生字段补齐
    async fn ctx_for(&self, account_id: Option<&str>, share_id: Option<&str>) -> Result<Ctx, String> {
        let share = match share_id {
            Some(sid) => Some(
                self.store
                    .get_netdisk_share(sid)?
                    .ok_or_else(|| "分享不存在".to_string())?,
            ),
            None => None,
        };
        // 分享未显式绑定账号（或绑定账号被删）→ 用同 provider 的首个账号
        let acct = match (account_id, &share) {
            (Some(aid), _) => self.store.get_netdisk_account(aid)?,
            (None, Some(s)) => {
                let want = s.provider.clone();
                match s.account_id.as_deref().and_then(|id| self.store.get_netdisk_account(id).ok().flatten()) {
                    Some(a) => Some(a),
                    None => self
                        .store
                        .list_netdisk_accounts()?
                        .into_iter()
                        .find(|a| a.provider == want),
                }
            }
            (None, None) => None,
        };
        let acct = acct.ok_or_else(|| {
            if share.is_some() {
                "该分享未绑定网盘账号（请先在「账号」页添加同网盘账号）".to_string()
            } else {
                "网盘账号不存在".to_string()
            }
        })?;

        let kind = ProviderKind::parse(&acct.provider).ok_or_else(|| "未知网盘类型".to_string())?;
        let p = provider(kind);

        // M3：进入按账号单飞锁后再读凭据 + 刷新 + 落库（详见 refresh_lock 注释）
        let lock = refresh_lock(&acct.id);
        let _guard = lock.lock().await;
        // 锁内重读：并发请求可能刚完成刷新并落库，acct.cred 或已过期
        let acct = self
            .store
            .get_netdisk_account(&acct.id)?
            .ok_or_else(|| "网盘账号不存在".to_string())?;
        let mut cred = Credentials::from_json(&acct.cred);
        let mut dirty = false;

        // 登录态续期：到期前 60s 主动刷新（有 refresh_token 才可续）
        let need_refresh = !token_fresh(cred.expires_at, now_ms())
            || (cred.access_token.is_none() && cred.refresh_token.is_some());
        if need_refresh && cred.refresh_token.is_some() {
            match p.refresh(&cred).await {
                Ok(next) => {
                    cred = next;
                    dirty = true;
                }
                Err(e) => {
                    self.store.update_netdisk_status(&acct.id, "expired", Some(&e)).ok();
                    return Err(format!("{} 登录态已失效：{e}", p.name()));
                }
            }
        }
        // 派生字段（如阿里云盘 drive_id）首次使用时补齐并回写
        if let Ok(true) = p.prepare(&mut cred).await {
            dirty = true;
        }
        if dirty {
            self.store.update_netdisk_cred(&acct.id, &cred.to_json(), cred.expires_at)?;
        }
        Ok(Ctx { account: acct, share, cred })
    }

    /// 错误归类：登录态类错误把账号标记为 expired，便于 UI 提示重新授权。
    /// M4：只认**明确的鉴权语义信号**（HTTP 401/403、网盘 errno、OAuth 错误码、
    /// 登录态关键词）——早期按裸 "403"/"token" 子串匹配，错误文本偶然包含
    /// 这两个词（如文件大小、非鉴权参数名）就会把账号误标为已失效。
    fn note_error(&self, account_id: &str, err: &str) {
        let low = err.to_lowercase();
        let auth_related = [
            // HTTP 状态词法（适配器统一 "{op} 失败：HTTP {status}" 格式）
            "http 401",
            "http 403",
            "unauthorized",
            "forbidden",
            // 网盘业务码
            "errno=-6",
            // OAuth / Graph 错误码
            "invalid_grant",
            "invalid_client",
            "invalidauthenticationtoken",
            "accesstokenexpired",
            "expiredtoken",
            "authorization_expired",
            "permission denied",
            // 登录态关键词（适配器中文文案）
            "cookie 已失效",
            "登录态已失效",
            "登录态失效",
            "登录已失效",
            "未登录",
            "token 刷新失败",
            "刷新响应缺少 access_token",
        ]
        .iter()
        .any(|k| low.contains(k));
        if auth_related {
            self.store.update_netdisk_status(account_id, "expired", Some(err)).ok();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp_store(tag: &str) -> CacheStore {
        let dir: PathBuf = std::env::temp_dir()
            .join(format!("pf-netdisk-test-{}-{}", tag, crate::rand_hex(6)));
        std::fs::create_dir_all(&dir).unwrap();
        CacheStore::open(&dir.join("core.db"), dir.join("cache")).unwrap()
    }

    #[test]
    fn account_and_share_crud_roundtrip() {
        let store = tmp_store("crud");
        let row = NetdiskAccountRow {
            id: "acc1".into(),
            provider: "http".into(),
            name: "测试盘".into(),
            cred: "{}".into(),
            status: "ok".into(),
            last_error: None,
            expires_at: None,
            created_at: 1,
            last_used_at: None,
        };
        store.insert_netdisk_account(&row).unwrap();
        let got = store.get_netdisk_account("acc1").unwrap().unwrap();
        assert_eq!(got.name, "测试盘");
        // 凭据回写 + 状态复位
        store.update_netdisk_status("acc1", "expired", Some("401")).unwrap();
        store.update_netdisk_cred("acc1", r#"{"accessToken":"t"}"#, Some(42)).unwrap();
        let got = store.get_netdisk_account("acc1").unwrap().unwrap();
        assert_eq!(got.status, "ok");
        assert!(got.last_error.is_none());
        assert_eq!(got.expires_at, Some(42));

        // 分享 + 去重查询 + 解绑
        let sh = NetdiskShareRow {
            id: "sh1".into(),
            provider: "aliyun".into(),
            account_id: Some("acc1".into()),
            share_url: "https://www.alipan.com/s/x".into(),
            share_id: "x".into(),
            pwd: None,
            title: Some("测试".into()),
            created_at: 2,
        };
        store.insert_netdisk_share(&sh).unwrap();
        assert!(store.find_netdisk_share_by_sid("aliyun", "x").is_some());
        store.delete_netdisk_account("acc1").unwrap();
        let sh = store.get_netdisk_share("sh1").unwrap().unwrap();
        assert!(sh.account_id.is_none(), "删账号应解绑分享而非删分享");
        assert!(store.delete_netdisk_share("sh1").unwrap());
        assert!(store.list_netdisk_shares().unwrap().is_empty());
    }

    #[test]
    fn shim_token_is_stable_and_persisted() {
        let store = tmp_store("shim");
        let t1 = store.netdisk_shim_token();
        assert_eq!(t1.len(), 24);
        // 重新打开同一 DB 仍取到同一个密钥（任务 URL 跨重启可用）
        let dir = store.cache_dir().parent().unwrap().to_path_buf();
        drop(store);
        let store2 = CacheStore::open(&dir.join("core.db"), dir.join("cache")).unwrap();
        assert_eq!(store2.netdisk_shim_token(), t1);
    }
}
