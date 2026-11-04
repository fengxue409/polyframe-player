//! P9b 网盘视频源 RPC（DESIGN §4.7）
//!
//! 职责：把 `pf-engine::NetdiskService` 的能力包装成 `netdisk.*` 方法与 camelCase 出参。
//!
//! 关键点：
//!  - **凭据永不外泄**：账号出参只给状态/过期时刻，不下发 Cookie / token；
//!  - **播放地址统一走 shim**：`/nd/{secret}/{owner}/{fileId}/v.mp4` 由 pf-proxy
//!    注入 provider 请求头并处理直链续期，播放器（hls.js / mpv / 引擎分块管线）
//!    完全无感知；
//!  - shim URL 以 `.mp4` 结尾 → `pf_parser::detect` 判定为 MP4 直链 →
//!    复用既有「虚拟文件 + 4MiB 分块 + 缓存三档 + 水位调度」管线（零改造）。

use std::sync::Arc;

use pf_engine::{CacheMode, ProxyInfo, TaskManager};
use pf_netdisk::{provider, Credentials, ProviderKind};
use serde_json::{json, Value};

use crate::{error_response, ok_response};

/// 账号出参（脱敏：不含 cred 字段）
fn account_view(row: &pf_engine::NetdiskAccountRow) -> Value {
    let kind = ProviderKind::parse(&row.provider);
    json!({
        "id": row.id,
        "provider": row.provider,
        "providerName": kind.map(|k| provider(k).name()).unwrap_or("未知"),
        "name": row.name,
        "status": row.status,
        "lastError": row.last_error,
        "expiresAt": row.expires_at,
        "createdAt": row.created_at,
        "lastUsedAt": row.last_used_at,
        // UI 用：该账号是否需要重新授权
        "needReauth": row.status == "expired",
    })
}

fn share_view(row: &pf_engine::NetdiskShareRow) -> Value {
    json!({
        "id": row.id,
        "provider": row.provider,
        "accountId": row.account_id,
        "shareUrl": row.share_url,
        "shareId": row.share_id,
        "pwd": row.pwd,
        "title": row.title,
        "createdAt": row.created_at,
    })
}

fn str_param<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

fn num_param(params: &Value, key: &str) -> Option<u32> {
    params.get(key).and_then(Value::as_u64).map(|n| n as u32)
}

/// 路径段编码（fileId 可能含 `!` `$` 等字符；`/` 必须转义）
fn encode_seg(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'!' | b'$' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// 剧集显示名：去扩展名 + trim（「第01集.mp4」→「第01集」）
fn clean_episode_name(file_name: &str) -> String {
    let base = file_name.rsplit_once('.').map(|(b, _)| b).unwrap_or(file_name);
    base.trim().to_string()
}

/// 目录 → 剧集快照（翻页收集全部视频文件，cap 20 页 = 4000 项）。
/// favorite.add 与追更刷新共用同一口径，保证集名/URL 形态一致。
async fn collect_dir_episodes(
    svc: &pf_engine::NetdiskService<'_>,
    proxy: &ProxyInfo,
    owner: &str,
    account_id: Option<&str>,
    share_id: Option<&str>,
    dir_id: &str,
) -> Result<Vec<Value>, String> {
    let nd_token = svc.shim_token();
    let mut episodes: Vec<Value> = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..20 {
        let page = svc
            .list_dir(account_id, share_id, dir_id, cursor.as_deref(), Some(200))
            .await?;
        for it in page.items.iter().filter(|i| i.playable()) {
            episodes.push(json!({
                "name": clean_episode_name(&it.name),
                "url": shim_url(proxy, &nd_token, owner, &it.id),
            }));
        }
        match page.next_cursor {
            Some(c) => cursor = Some(c),
            None => break,
        }
    }
    Ok(episodes)
}

/// owner 段反解：`a-{accountId}` / `s-{shareId}`（与 owner_of 互逆）
pub(crate) fn split_owner_ids(owner: &str) -> Result<(Option<String>, Option<String>), String> {
    if let Some(id) = owner.strip_prefix("a-") {
        Ok((Some(id.to_string()), None))
    } else if let Some(id) = owner.strip_prefix("s-") {
        Ok((None, Some(id.to_string())))
    } else {
        Err(format!("非法网盘 owner 段：{owner}"))
    }
}

/// P16 追更：重新列目录生成剧集快照（favorite.refresh 对 netdisk: 片源回拉）
pub(crate) async fn refresh_netdisk_episodes(
    engine: &Arc<TaskManager>,
    proxy: &ProxyInfo,
    owner: &str,
    dir_id: &str,
) -> Result<Vec<Value>, String> {
    let svc = engine.netdisk();
    let (account_id, share_id) = split_owner_ids(owner)?;
    collect_dir_episodes(&svc, proxy, owner, account_id.as_deref(), share_id.as_deref(), dir_id).await
}

/// 构造稳定 shim URL（proxy token 轮换不影响；secret 落库不变）
fn shim_url(proxy: &ProxyInfo, nd_token: &str, owner: &str, file_id: &str) -> String {
    format!(
        "http://127.0.0.1:{}/nd/{}/{}/{}/v.mp4",
        proxy.port,
        nd_token,
        owner,
        encode_seg(file_id)
    )
}

/// owner 段：分享优先（分享 id 已隐式绑定账号）
fn owner_of(account_id: Option<&str>, share_id: Option<&str>) -> Result<String, String> {
    if let Some(sid) = share_id {
        return Ok(format!("s-{sid}"));
    }
    if let Some(aid) = account_id {
        return Ok(format!("a-{aid}"));
    }
    Err("需要 accountId 或 shareId".into())
}

/// 从参数里取 (accountId, shareId)
fn ids(params: &Value) -> (Option<String>, Option<String>) {
    (
        str_param(params, "accountId").map(str::to_string),
        str_param(params, "shareId").map(str::to_string),
    )
}

/// netdisk.* 方法处理（rest = 去掉 "netdisk." 前缀）
pub async fn handle(
    rest: &str,
    params: &Value,
    id: Value,
    engine: &Arc<TaskManager>,
    proxy: &ProxyInfo,
) -> Option<String> {
    let svc = engine.netdisk();
    let result: Result<Value, (i32, String)> = match rest {
        // ---------- 适配器能力（UI 渲染授权表单） ----------
        "providers" => Ok(json!({ "providers": pf_netdisk::provider_infos() })),

        // ---------- 账号 ----------
        "account.list" => svc
            .accounts()
            .map(|rows| json!({ "accounts": rows.iter().map(account_view).collect::<Vec<_>>() }))
            .map_err(|e| (-32000, e)),

        "account.add" => {
            let Some(kind) = str_param(params, "provider").map(str::to_string) else {
                return Some(error_response(id, -32602, "invalid params: provider required"));
            };
            let mut cred = Credentials {
                access_token: str_param(params, "accessToken").map(str::to_string),
                refresh_token: str_param(params, "refreshToken").map(str::to_string),
                cookie: str_param(params, "cookie").map(str::to_string),
                base_url: str_param(params, "baseUrl").map(str::to_string),
                client_id: str_param(params, "clientId").map(str::to_string),
                ..Default::default()
            };
            // HTTP 目录网关：baseUrl 必填，token 兼作 access_token
            if ProviderKind::parse(&kind) == Some(ProviderKind::Http) {
                if cred.base_url.is_none() {
                    return Some(error_response(id, -32602, "invalid params: baseUrl required（网关地址）"));
                }
                if cred.access_token.is_none() {
                    cred.access_token = cred.refresh_token.clone();
                }
            }
            if cred.cookie.is_none() && cred.access_token.is_none() && cred.refresh_token.is_none() {
                return Some(error_response(
                    id,
                    -32602,
                    "invalid params: cookie / accessToken / refreshToken 至少一项",
                ));
            }
            let name = str_param(params, "name");
            match svc.add_account(&kind, name, cred).await {
                Ok((row, probe)) => Ok(json!({
                    "account": account_view(&row),
                    "probe": {
                        "ok": probe.ok,
                        "latencyMs": probe.latency_ms,
                        "error": probe.error,
                    }
                })),
                Err(e) => Err((-32000, e)),
            }
        }

        "account.refresh" => {
            let Some(aid) = str_param(params, "id") else {
                return Some(error_response(id, -32602, "invalid params: id required"));
            };
            match svc.refresh_account(aid).await {
                Ok(row) => Ok(json!({ "account": account_view(&row) })),
                Err(e) => Err((-32000, e)),
            }
        }

        "account.remove" => {
            let Some(aid) = str_param(params, "id") else {
                return Some(error_response(id, -32602, "invalid params: id required"));
            };
            svc.remove_account(aid).map(|removed| json!({ "removed": removed })).map_err(|e| (-32000, e))
        }

        // ---------- 设备码授权（OneDrive / HTTP 网关） ----------
        "auth.begin" => {
            let Some(kind) = str_param(params, "provider").and_then(ProviderKind::parse) else {
                return Some(error_response(id, -32602, "invalid params: provider required"));
            };
            let client_id = str_param(params, "clientId").unwrap_or_default().to_string();
            match provider(kind).device_auth(&client_id).await {
                Ok(ch) => Ok(json!({
                    "deviceCode": ch.device_code,
                    "userCode": ch.user_code,
                    "verificationUri": ch.verification_uri,
                    "intervalSecs": ch.interval_secs,
                    "expiresIn": ch.expires_in,
                    "message": ch.message,
                })),
                Err(e) => Err((-32000, e)),
            }
        }

        "auth.poll" => {
            let Some(kind) = str_param(params, "provider").and_then(ProviderKind::parse) else {
                return Some(error_response(id, -32602, "invalid params: provider required"));
            };
            let Some(device_code) = str_param(params, "deviceCode").map(str::to_string) else {
                return Some(error_response(id, -32602, "invalid params: deviceCode required"));
            };
            let client_id = str_param(params, "clientId").unwrap_or_default().to_string();
            match provider(kind).poll_device_auth(&client_id, &device_code).await {
                Ok(out) if out.pending => Ok(json!({ "pending": true, "message": out.message })),
                Ok(out) => {
                    let Some(cred) = out.cred else {
                        return Some(error_response(id, -32000, "授权完成但未取得凭据"));
                    };
                    // 授权完成即入库（名称可后续重命名）
                    match svc.add_account(kind.as_str(), str_param(params, "name"), cred).await {
                        Ok((row, _)) => Ok(json!({ "pending": false, "account": account_view(&row) })),
                        Err(e) => Err((-32000, format!("授权成功但账号写入失败：{e}"))),
                    }
                }
                Err(e) => Err((-32000, e)),
            }
        }

        // ---------- 目录浏览（分页） ----------
        "list" => {
            let (account_id, share_id) = ids(params);
            let dir = str_param(params, "dirId").unwrap_or("");
            let cursor = str_param(params, "cursor");
            match svc
                .list_dir(account_id.as_deref(), share_id.as_deref(), dir, cursor, num_param(params, "pageSize"))
                .await
            {
                Ok(page) => Ok(json!({
                    "items": page.items,
                    "nextCursor": page.next_cursor,
                    "total": page.total,
                    "dirId": dir,
                })),
                Err(e) => Err((-32000, e)),
            }
        }

        // ---------- 播放地址 ----------
        // resolve：返回 shim URL + 直链剩余有效期（UI 展示「链接已就绪，X 分钟后自动续期」）
        "resolve" | "playUrl" => {
            let (account_id, share_id) = ids(params);
            let Some(file_id) = str_param(params, "fileId").map(str::to_string) else {
                return Some(error_response(id, -32602, "invalid params: fileId required"));
            };
            let owner = match owner_of(account_id.as_deref(), share_id.as_deref()) {
                Ok(o) => o,
                Err(e) => return Some(error_response(id, -32602, &e)),
            };
            // 先真实解析一次：把鉴权/失效问题在 RPC 层暴露，而不是等播放器 502
            match svc.resolve(account_id.as_deref(), share_id.as_deref(), &file_id, false).await {
                Ok(target) => {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as i64;
                    Ok(json!({
                        "url": shim_url(proxy, &svc.shim_token(), &owner, &file_id),
                        "expiresAt": target.expires_at,
                        "expiresInSecs": target.expires_at.map(|e| ((e - now) / 1000).max(0)),
                        "headerCount": target.headers.len(),
                        "ext": target.ext,
                        // 直链主机（仅供诊断展示，不含签名参数）
                        "host": target.url.split('/').nth(2).unwrap_or_default(),
                    }))
                }
                Err(e) => Err((-32000, e)),
            }
        }

        // play：加入任务（走引擎分块/缓存管线），返回 task
        "play" => {
            let (account_id, share_id) = ids(params);
            let Some(file_id) = str_param(params, "fileId").map(str::to_string) else {
                return Some(error_response(id, -32602, "invalid params: fileId required"));
            };
            let owner = match owner_of(account_id.as_deref(), share_id.as_deref()) {
                Ok(o) => o,
                Err(e) => return Some(error_response(id, -32602, &e)),
            };
            // 预解析：确认文件可播（下载/转码受限时提前报错）
            if let Err(e) = svc.resolve(account_id.as_deref(), share_id.as_deref(), &file_id, false).await {
                return Some(error_response(id, -32000, &format!("该文件暂不可播放：{e}")));
            }
            let url = shim_url(proxy, &svc.shim_token(), &owner, &file_id);
            let title = str_param(params, "name").map(str::to_string);
            let cache_mode = params
                .get("cacheMode")
                .and_then(Value::as_str)
                .and_then(CacheMode::from_str)
                .unwrap_or_default();
            match engine.create_task(&url, title, Vec::new(), cache_mode, proxy).await {
                Ok(task) => Ok(json!({ "task": task })),
                Err(e) => Err((-32000, format!("加入任务失败：{e}"))),
            }
        }

        // ---------- 收藏打通（P16）：目录=剧集 / 文件=电影，并入 favorites 体系 ----------
        // 剧集快照 URL 用稳定 shim URL（nd_token 落库跨重启不变、proxy 端自动换链），
        // 因此连播/进度/继续观看/追更全套复用收藏管线，零特殊分支。
        // 同名（normalize(name)+同年份）经 find_favorite_by_key 归并 —— 多账号/多源
        // 的同名目录自动合并为同一条收藏下的不同片源（origin=netdisk）。
        "favorite.add" => {
            let (account_id, share_id) = ids(params);
            let owner = match owner_of(account_id.as_deref(), share_id.as_deref()) {
                Ok(o) => o,
                Err(e) => return Some(error_response(id, -32602, &e)),
            };
            let file_id = str_param(params, "fileId");
            let dir_id = str_param(params, "dirId");
            let (target_id, is_dir) = match (file_id, dir_id) {
                (Some(f), _) => (f.to_string(), false),
                (None, Some(d)) => (d.to_string(), true),
                _ => return Some(error_response(id, -32602, "invalid params: fileId / dirId 二选一")),
            };
            let Some(raw_name) = str_param(params, "name").map(str::trim).filter(|s| !s.is_empty()) else {
                return Some(error_response(id, -32602, "invalid params: name required"));
            };
            // 显示名：视频文件去扩展名，目录原名
            let name = if !is_dir {
                raw_name.rsplit_once('.').map(|(b, _)| b).unwrap_or(raw_name).trim()
            } else {
                raw_name
            };
            if name.is_empty() {
                return Some(error_response(id, -32602, "invalid params: name 不能为空"));
            }

            // 片源标识：site_name（媒体库展示）与 api 引用（追更回拉用）
            let provider_kind = if let Some(aid) = account_id.as_deref() {
                svc.accounts()
                    .ok()
                    .and_then(|rows| rows.into_iter().find(|r| r.id == aid).map(|r| r.provider))
            } else {
                svc.shares()
                    .ok()
                    .and_then(|rows| rows.into_iter().find(|r| r.id == share_id.as_deref().unwrap_or("")).map(|r| r.provider))
            };
            let label = if let Some(aid) = account_id.as_deref() {
                svc.accounts()
                    .ok()
                    .and_then(|rows| rows.into_iter().find(|r| r.id == aid).map(|r| r.name))
            } else {
                svc.shares().ok().and_then(|rows| {
                    rows.into_iter()
                        .find(|r| r.id == share_id.as_deref().unwrap_or(""))
                        .and_then(|r| r.title)
                })
            }
            .unwrap_or_else(|| "未命名".into());
            let provider_name = provider_kind
                .as_deref()
                .and_then(ProviderKind::parse)
                .map(|k| provider(k).name().to_string())
                .unwrap_or_else(|| "网盘".into());
            let site_name = format!("网盘·{provider_name}·{label}");
            let api_ref = format!("netdisk:{owner}:{target_id}");
            let remarks = format!("{provider_name}·{label}");

            // 目录：翻页收集全部视频文件为剧集快照
            let mut episodes: Vec<Value> = Vec::new();
            if is_dir {
                match collect_dir_episodes(&svc, proxy, &owner, account_id.as_deref(), share_id.as_deref(), &target_id)
                    .await
                {
                    Ok(eps) => episodes = eps,
                    Err(e) => return Some(error_response(id, -32000, &format!("读取目录失败：{e}"))),
                }
                if episodes.is_empty() {
                    return Some(error_response(id, -32000, "该目录下没有可播放的视频文件"));
                }
            } else {
                // 单文件：先真实解析一次，提前暴露鉴权/失效问题
                if let Err(e) = svc.resolve(account_id.as_deref(), share_id.as_deref(), &target_id, false).await {
                    return Some(error_response(id, -32000, &format!("该文件暂不可播放：{e}")));
                }
                episodes.push(json!({
                    "name": name,
                    "url": shim_url(proxy, &svc.shim_token(), &owner, &target_id),
                }));
            }
            let episodes_json = serde_json::to_string(&episodes).unwrap_or_else(|_| "[]".into());

            // 同名归并：已有关联收藏（normalize(name)+year 一致）直接挂新片源
            let store = engine.store();
            let fav_id = match store.find_favorite_by_key(name, "") {
                Ok(Some(f)) => f.id,
                Ok(None) => {
                    let fid = pf_engine::rand_hex(16);
                    if let Err(e) = store.insert_favorite(&fid, name, None, Some("网盘"), Some(&remarks), None, None) {
                        return Some(error_response(id, -32000, &e));
                    }
                    fid
                }
                Err(e) => return Some(error_response(id, -32000, &e)),
            };
            // 幂等 + 写入：复用 catalog 的 upsert（同收藏 + 同 api + 同 vodId 去重）
            if let Err(e) = crate::catalog::upsert_fav_source(
                store,
                &fav_id,
                &site_name,
                Some(&api_ref),
                Some(&target_id),
                &episodes_json,
                Some(&remarks),
                None,
                "netdisk",
            ) {
                return Some(error_response(id, -32000, &e));
            }
            match store.get_favorite(&fav_id) {
                Ok(Some(f)) => Ok(json!({ "favorite": crate::catalog::fav_row_json(f) })),
                _ => Err((-32000, "收藏写入失败".into())),
            }
        }

        // ---------- 分享链接 ----------
        "share.list" => svc
            .shares()
            .map(|rows| json!({ "shares": rows.iter().map(share_view).collect::<Vec<_>>() }))
            .map_err(|e| (-32000, e)),

        "share.parse" => {
            let Some(url) = str_param(params, "url") else {
                return Some(error_response(id, -32602, "invalid params: url required"));
            };
            match pf_netdisk::parse_share(url) {
                Ok(s) => {
                    let p = provider(s.provider);
                    Ok(json!({
                        "provider": s.provider.as_str(),
                        "providerName": p.name(),
                        "shareId": s.share_id,
                        "pwd": s.pwd,
                        "canBrowse": p.supports_share(),
                    }))
                }
                Err(e) => Err((-32602, e)),
            }
        }

        "share.add" => {
            let Some(url) = str_param(params, "url").map(str::to_string) else {
                return Some(error_response(id, -32602, "invalid params: url required"));
            };
            let pwd = str_param(params, "pwd");
            let account_id = str_param(params, "accountId");
            match svc.add_share(&url, pwd, account_id).await {
                Ok((row, page)) => Ok(json!({
                    "share": share_view(&row),
                    "items": page.items,
                    "nextCursor": page.next_cursor,
                })),
                Err(e) => Err((-32000, e)),
            }
        }

        "share.remove" => {
            let Some(sid) = str_param(params, "id") else {
                return Some(error_response(id, -32602, "invalid params: id required"));
            };
            svc.remove_share(sid).map(|removed| json!({ "removed": removed })).map_err(|e| (-32000, e))
        }

        _ => return None,
    };

    Some(match result {
        Ok(v) => ok_response(id, v),
        Err((code, msg)) => error_response(id, code, &msg),
    })
}
