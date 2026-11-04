//! P7 影视发现与片源聚合（DESIGN §4.7）
//!
//! 职责：CMS 采集站（苹果CMS V10 API）的源站管理、聚合搜索、单站详情、
//! 收藏合并与手动补充片源。纯解析在 pf-parser::cms，持久化在 pf-engine
//! 的 catalog_store；本模块只做网络编排 + 出参序列化（camelCase 与
//! packages/shared 同构）。
//!
//! 热度口径（零 key 聚合统计）：卡片 sourceCount = 收录站数；
//! 收藏 sourceCount = 片源数；最近播放取 favorites.last_played_at。

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;

use futures_util::future::join_all;
use pf_engine::{CacheStore, PlayHistoryRecord, ProxyInfo, SrcCachePolicy, TaskManager};
use pf_parser::cms::{self, CmsVodItem};
use pf_parser::sourcelist;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::srccache::{
    fetch_text_cached, peek_fresh, peek_stale, remember, CacheSummary, Mark, KIND_CATEGORY,
    KIND_DETAIL, KIND_SEARCH, KIND_TMDB,
};
use crate::{error_response, ok_response};

/// 单源单请求超时（搜索最坏 = detail+videolist 两连发 ≈ 18s，RPC 客户端需放宽到 25s）
/// 源站单次请求超时。P43 从 4s 提到 9s：`ac=detail` 一页带 play_url，实测
/// 0.6–2.0s 属常态，冷启动（DNS+TLS+50 条）能到 4.8s —— 4s 会把「慢但能用」的
/// 源站整页判失败，用户看到的就是「源站少、结果少」。
const SOURCE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(9);

/// 一次 `catalog.category` 调用内最多往后翻几页（P43 填页循环上限）。
/// 常见情况（无筛/宽筛选）第一页就够，只有窄条件才会用满。
const CAT_PAGE_WINDOW: u32 = 3;

/// 收藏聚合时最多为几张卡片条目拉取详情（防收藏请求过重）
const FAVORITE_DETAIL_CAP: usize = 3;

/// 出厂预置源站：见 `presets.rs`（P8 实测筛选，随缘可用；表空时播种，可禁用/删除）
use crate::presets;

/// 目录请求客户端：http1 + 连接超时（请求级超时单独挂）
fn client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("PolyFrame/0.1")
            .http1_only()
            .connect_timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap_or_default()
    })
}

fn rand_id() -> String {
    use rand::Rng;
    let b: [u8; 16] = rand::thread_rng().gen();
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn nonempty(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() { None } else { Some(t.to_string()) }
}

/// 出厂源站播种：仅当 catalog_sources 表为空时（用户删光后不被强制复活）
pub fn ensure_builtin_sources(store: &pf_engine::CacheStore) {
    let Ok(existing) = store.list_catalog_sources() else { return };
    if !existing.is_empty() {
        return;
    }
    for (name, api) in presets::PRESETS {
        let _ = store.insert_catalog_source(&rand_id(), name, api, true, true);
    }
}

// ---------- 出参结构（与 packages/shared 同构） ----------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Probe {
    ok: bool,
    latency_ms: Option<i64>,
    samples: Option<u32>,
    error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntryRef {
    #[serde(default)]
    source_id: Option<String>,
    site_name: String,
    vod_id: String,
    api: String,
    #[serde(default)]
    remarks: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Card {
    key: String,
    name: String,
    #[serde(default)]
    year: Option<String>,
    #[serde(default)]
    type_name: Option<String>,
    #[serde(default)]
    remarks: Option<String>,
    #[serde(default)]
    poster: Option<String>,
    /// 站内最近更新时间（category 更新流排序用；搜索结果为空）
    #[serde(default)]
    update_time: Option<String>,
    /// 热门榜人气（category sort=hot 且配置 TMDB Key 时命中才带）
    #[serde(skip_serializing_if = "Option::is_none")]
    tmdb: Option<TmdbPop>,
    /// 归一后的地区（`中国香港` / `内地` → 香港 / 大陆）；站方没填则为 None
    #[serde(default, skip_serializing_if = "Option::is_none")]
    area: Option<String>,
    /// 豆瓣评分（多站取最高；全程无评分则 None，不能序列化成 0）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    score: Option<f64>,
    /// 站内评分（多站取最高）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    site_score: Option<f64>,
    /// 跨站播放量合计（各站 vod_hits 之和，只作热度参考）
    #[serde(default)]
    hits: u64,
    source_count: u32,
    entries: Vec<EntryRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Episode {
    name: String,
    url: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EpisodeGroup {
    from: String,
    episodes: Vec<Episode>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Detail {
    api: String,
    site_name: String,
    vod_id: String,
    name: String,
    #[serde(default)]
    year: Option<String>,
    #[serde(default)]
    type_name: Option<String>,
    #[serde(default)]
    remarks: Option<String>,
    #[serde(default)]
    poster: Option<String>,
    #[serde(default)]
    actor: Option<String>,
    #[serde(default)]
    director: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    update_time: Option<String>,
    groups: Vec<EpisodeGroup>,
}

// ---------- 网络原语 ----------

async fn fetch_text(url: &str) -> Result<String, String> {
    let resp = client()
        .get(url)
        .timeout(SOURCE_TIMEOUT)
        .header("Accept", "application/json,text/plain,*/*")
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    resp.text().await.map_err(|e| format!("读取失败: {e}"))
}

/// 源站探测/测速：ac=list 最小请求 + 计时
async fn probe_source(api: &str) -> Probe {
    let url = cms::list_url(api);
    let t0 = Instant::now();
    match fetch_text(&url).await {
        Ok(body) => match cms::parse_vod_list(&body) {
            Ok(list) => Probe {
                ok: true,
                latency_ms: Some(t0.elapsed().as_millis() as i64),
                samples: Some(list.len() as u32),
                error: None,
            },
            Err(e) => Probe { ok: false, latency_ms: None, samples: None, error: Some(e) },
        },
        Err(e) => Probe { ok: false, latency_ms: None, samples: None, error: Some(e) },
    }
}

/// 单站搜索：ac=detail 一步拿全（含 play_url），空/失败回退 ac=videolist。
///
/// P19：结果按 `api|q` 落盘复用 —— 搜索是最高频、最贵的操作（一次全站扇出），
/// TTL 内翻回同一个词必然零回源；源站挂了还能给出上次的结果（`stale`）。
async fn search_one(
    store: &CacheStore,
    policy: &SrcCachePolicy,
    api: &str,
    q: &str,
    pg: u32,
) -> Result<(cms::VodPage, Mark), String> {
    // P43：页码进缓存键 —— 否则第 2 页会命中第 1 页的缓存，翻页等于原地踏步
    let key = format!("{api}|{q}|{pg}");
    // 1) 新鲜命中：直接解析缓存体（解析不出来说明缓存脏了，清掉重来）
    if let Some((body, mark)) = peek_fresh(store, KIND_SEARCH, &key) {
        match cms::parse_vod_page(&body) {
            Ok(p) if !p.items.is_empty() => return Ok((p, mark)),
            _ => store.src_cache_invalidate(KIND_SEARCH, &key),
        }
    }
    // 2) 回源：detail 优先，空则回退 videolist
    let mut fetched: Option<String> = None;
    if let Ok(body) = fetch_text(&cms::search_url_at(api, q, pg)).await {
        if cms::parse_vod_page(&body).map(|p| !p.items.is_empty()).unwrap_or(false) {
            fetched = Some(body);
        }
    }
    if fetched.is_none() {
        match fetch_text(&cms::search_url_fallback(api, q)).await {
            Ok(body) => {
                if cms::parse_vod_page(&body).map(|p| !p.items.is_empty()).unwrap_or(false) {
                    fetched = Some(body);
                }
            }
            Err(e) => {
                // 3) 全站失败：允许回退时给旧值（界面上标注 stale）
                if policy.offline_fallback {
                    if let Some((body, mark)) = peek_stale(store, KIND_SEARCH, &key) {
                        if let Ok(p) = cms::parse_vod_page(&body) {
                            if !p.items.is_empty() {
                                return Ok((p, mark));
                            }
                        }
                    }
                }
                return Err(e);
            }
        }
    }
    let Some(body) = fetched else {
        // 两种取法都没拿到可用列表：不写缓存（避免把空结果固化一个 TTL）
        return Err("无数据".to_string());
    };
    let page = cms::parse_vod_page(&body)?;
    if !page.items.is_empty() {
        remember(store, policy, KIND_SEARCH, &key, &body);
    }
    Ok((page, Mark::default()))
}

/// 这一页之后还有没有内容（P43 统一终止判断）。
/// 有 `pagecount` 就信它；站没给（=0）时退回「本页是否满额」——满额大概率还有下一页，
/// 不满额就当作到底，避免对不支持的站无限翻页。
fn page_has_more(page: &cms::VodPage, requested_pg: u32) -> bool {
    page.has_next(requested_pg)
        .unwrap_or(page.items.len() >= cms::PAGE_SIZE as usize)
}

/// 抓一页分类/更新流（带 P19 页缓存）。key 里必须带 pagesize：
/// 换了每页条数后，旧缓存里的 `page` 语义就对不上了。
async fn fetch_cms_page(
    store: &CacheStore,
    policy: &SrcCachePolicy,
    api: &str,
    pg: u32,
    hours: Option<u32>,
) -> Result<(cms::VodPage, Mark), String> {
    let key = format!("{api}|{pg}|{}|{}", hours.unwrap_or(0), cms::PAGE_SIZE);
    let url = cms::page_url(api, pg, hours);
    match fetch_text_cached(store, policy, KIND_CATEGORY, &key, async { fetch_text(&url).await })
        .await
    {
        Ok((body, mark)) => match cms::parse_vod_page(&body) {
            Ok(p) => Ok((p, mark)),
            Err(e) => {
                // 缓存体解析失败 = 脏缓存：当场失效，别让它继续毒一个 TTL
                store.src_cache_invalidate(KIND_CATEGORY, &key);
                Err(e)
            }
        },
        Err(e) => Err(e),
    }
}

/// 单站详情：ac=detail&ids=（P19 按 `api|vodId` 缓存，追更巡检也走这里）
async fn detail_one(
    store: &CacheStore,
    policy: &SrcCachePolicy,
    api: &str,
    vod_id: &str,
) -> Result<(CmsVodItem, Mark), String> {
    let key = format!("{api}|{vod_id}");
    let (body, mark) = fetch_text_cached(store, policy, KIND_DETAIL, &key, async {
        fetch_text(&cms::detail_url(api, vod_id)).await
    })
    .await?;
    let items = match cms::parse_vod_list(&body) {
        Ok(v) => v,
        Err(e) => {
            store.src_cache_invalidate(KIND_DETAIL, &key);
            return Err(e);
        }
    };
    let item = items
        .iter()
        .find(|i| i.vod_id == vod_id)
        .cloned()
        .or_else(|| items.into_iter().next())
        .ok_or_else(|| "详情无数据".to_string())?;
    Ok((item, mark))
}

fn item_to_detail(item: &CmsVodItem, api: &str, site_name: &str) -> Detail {
    let groups = cms::parse_play_groups(&item.vod_play_from, &item.vod_play_url)
        .into_iter()
        .map(|g| EpisodeGroup {
            from: g.from,
            episodes: g
                .episodes
                .into_iter()
                .map(|(name, url)| Episode { name, url })
                .collect(),
        })
        .collect();
    Detail {
        api: api.to_string(),
        site_name: site_name.to_string(),
        vod_id: item.vod_id.clone(),
        name: item.vod_name.clone(),
        year: nonempty(&item.vod_year),
        type_name: nonempty(&item.type_name),
        remarks: nonempty(&item.vod_remarks),
        poster: nonempty(&item.vod_pic),
        actor: nonempty(&item.vod_actor),
        director: nonempty(&item.vod_director),
        content: nonempty(&item.vod_content),
        update_time: nonempty(&item.vod_time),
        groups,
    }
}

fn api_host(api: &str) -> String {
    api.split("//").nth(1).unwrap_or(api).split('/').next().unwrap_or(api).to_string()
}

/// FavoriteSourceRow → 出参 JSON（episodes 快照 JSON 字符串还原为数组）
fn fav_source_json(row: pf_engine::FavoriteSourceRow) -> Value {
    let episodes: Value = serde_json::from_str(&row.episodes).unwrap_or_else(|_| json!([]));
    json!({
        "id": row.id,
        "favoriteId": row.favorite_id,
        "siteName": row.site_name,
        "api": row.api,
        "vodId": row.vod_id,
        "episodes": episodes,
        "remarks": row.remarks,
        "poster": row.poster,
        "origin": row.origin,
        "addedAt": row.added_at,
    })
}

pub(crate) fn fav_row_json(f: pf_engine::FavoriteRow) -> Value {
    serde_json::to_value(f).unwrap_or_else(|_| json!(null))
}

// ---------- 收藏合并 ----------

/// 站点详情快照写入收藏（去重：同收藏 + 同 api + 同 vodId）
pub(crate) fn upsert_fav_source(
    store: &pf_engine::CacheStore,
    fav_id: &str,
    site_name: &str,
    api: Option<&str>,
    vod_id: Option<&str>,
    episodes_json: &str,
    remarks: Option<&str>,
    poster: Option<&str>,
    origin: &str,
) -> Result<(), String> {
    if let (Some(api), Some(vod_id)) = (api, vod_id) {
        if let Some(existing) = store.find_favorite_source_by_site(fav_id, api, vod_id)? {
            // 已有快照且新快照为空剧集 → 保留旧快照
            let new_eps: Value = serde_json::from_str(episodes_json).unwrap_or(json!([]));
            if new_eps.as_array().map(|a| a.is_empty()).unwrap_or(true) {
                return Ok(());
            }
            return store.update_favorite_source_episodes(&existing.id, episodes_json, remarks, poster);
        }
    }
    store.insert_favorite_source(
        &rand_id(),
        fav_id,
        site_name,
        api,
        vod_id,
        episodes_json,
        remarks,
        poster,
        origin,
    )
}

/// Detail → 收藏（新建或归并同名同年级），返回收藏行
fn favorite_from_detail(
    store: &pf_engine::CacheStore,
    d: &Detail,
) -> Result<pf_engine::FavoriteRow, String> {
    let fav_id = match store.find_favorite_by_key(&d.name, d.year.as_deref().unwrap_or(""))? {
        Some(f) => f.id,
        None => {
            let id = rand_id();
            store.insert_favorite(
                &id,
                &d.name,
                d.year.as_deref(),
                d.type_name.as_deref(),
                d.remarks.as_deref(),
                d.poster.as_deref(),
                d.content.as_deref(),
            )?;
            id
        }
    };
    // 首个剧集组作为快照（通常 m3u8 组最优）；空则拍平全部组
    let episodes: Vec<Episode> = match d.groups.iter().find(|g| !g.episodes.is_empty()) {
        Some(g) => g.episodes.clone(),
        None => d.groups.iter().flat_map(|g| g.episodes.clone()).collect(),
    };
    let episodes_json = serde_json::to_string(&episodes).unwrap_or_else(|_| "[]".into());
    upsert_fav_source(
        store,
        &fav_id,
        &d.site_name,
        Some(&d.api),
        Some(&d.vod_id),
        &episodes_json,
        d.remarks.as_deref(),
        d.poster.as_deref(),
        "search",
    )?;
    store.update_favorite_meta(
        &fav_id,
        d.type_name.as_deref(),
        d.remarks.as_deref(),
        d.poster.as_deref(),
        d.content.as_deref(),
    )?;
    store
        .get_favorite(&fav_id)?
        .ok_or_else(|| "收藏写入失败".to_string())
}

// ---------- 聚合累积（search / category 共用，P9 抽取） ----------

/// 同名影片聚合累积器：normalize(name)+year → 卡片
struct Acc {
    name: String,
    year: Option<String>,
    type_name: Option<String>,
    remarks: Option<String>,
    poster: Option<String>,
    /// 站内最近更新时间（category 更新流排序用；vod_time 字符串可直接字典序比较）
    vod_time: String,
    /// 归一地区：含糊值（其它/未知）会被后到的具体值覆盖
    area: Option<String>,
    /// 豆瓣评分：多站取最高（同一部片不同站打分不同，不该被低分站拖低）
    score: Option<f64>,
    /// 站内评分：同上
    site_score: Option<f64>,
    /// 跨站播放量合计
    hits: u64,
    entries: Vec<EntryRef>,
}

/// 服务端筛选条件（维度之间是「与」，每个维度内部单选；地区支持别名 OR）
#[derive(Default, Clone)]
struct Filters {
    category: String,
    /// 精确年份（「2026」）
    year: String,
    /// 年份上限（不含）：用于「更早」，y < year_before 才命中
    year_before: Option<u32>,
    /// 地区关键词，`|` 分隔候选别名
    area: String,
}

impl Filters {
    fn is_empty(&self) -> bool {
        self.category.is_empty()
            && self.year.is_empty()
            && self.year_before.is_none()
            && self.area.is_empty()
    }
}

/// 把单站条目累积进聚合表（可选过滤：大类关键词 / 年份精确 / 年份上限 / 地区包含匹配）
fn accumulate(
    map: &mut std::collections::BTreeMap<String, Acc>,
    source_id: &str,
    site_name: &str,
    api: &str,
    items: Vec<CmsVodItem>,
    f: &Filters,
) {
    for item in items {
        if item.vod_name.trim().is_empty() {
            continue;
        }
        if !f.category.is_empty() && !cms::category_matches(&item.type_name, &f.category) {
            continue;
        }
        if !f.year.is_empty() && item.vod_year.trim() != f.year {
            continue;
        }
        // 「更早」：年份解析不出的一律不命中（宁可少给，也不把无年份条目混进来）
        if let Some(before) = f.year_before {
            match item.vod_year.trim().parse::<u32>() {
                Ok(y) if y < before => {}
                _ => continue,
            }
        }
        if !f.area.is_empty() && !cms::area_matches(&item.vod_area, &f.area) {
            continue;
        }
        let year = nonempty(&item.vod_year);
        let key = cms::aggregate_key(&item.vod_name, item.vod_year.trim());
        let acc = map.entry(key.clone()).or_insert_with(|| Acc {
            name: item.vod_name.clone(),
            year: year.clone(),
            type_name: nonempty(&item.type_name),
            remarks: nonempty(&item.vod_remarks),
            poster: nonempty(&item.vod_pic),
            vod_time: item.vod_time.clone(),
            area: None,
            score: None,
            site_score: None,
            hits: 0,
            entries: Vec::new(),
        });
        if acc.poster.is_none() {
            if let Some(p) = nonempty(&item.vod_pic) {
                acc.poster = Some(p);
            }
        }
        // 地区：先到先得，但含糊值（其它/未知）让位给后到的具体值
        let raw_area = item.vod_area.trim();
        if !raw_area.is_empty() {
            let kept_concrete = acc
                .area
                .as_deref()
                .map(|cur| !cms::is_vague_area(cur) && !cur.is_empty())
                .unwrap_or(false);
            if !kept_concrete {
                acc.area = nonempty(&cms::canon_area(raw_area));
            }
        }
        if let Some(s) = cms::parse_score(&item.vod_douban_score) {
            acc.score = Some(acc.score.map_or(s, |cur| cur.max(s)));
        }
        if let Some(s) = cms::parse_score(&item.vod_score) {
            acc.site_score = Some(acc.site_score.map_or(s, |cur| cur.max(s)));
        }
        acc.hits = acc.hits.saturating_add(cms::parse_hits(&item.vod_hits));
        if item.vod_time > acc.vod_time {
            acc.vod_time = item.vod_time.clone();
        }
        // P43：同站同片只记一次。翻页重叠（站内排序抖动 / 忽略 pg）与同页重复
        // 都会让同一部片被算成「多个收录站」，热门榜随之虚高。
        let dup = !item.vod_id.is_empty()
            && acc
                .entries
                .iter()
                .any(|e| e.source_id.as_deref() == Some(source_id) && e.vod_id == item.vod_id);
        if !dup {
            acc.entries.push(EntryRef {
                source_id: Some(source_id.to_string()),
                site_name: site_name.to_string(),
                vod_id: item.vod_id.clone(),
                api: api.to_string(),
                remarks: nonempty(&item.vod_remarks),
            });
        }
    }
}

fn acc_to_card(key: String, a: Acc) -> Card {
    Card {
        key,
        name: a.name,
        year: a.year,
        type_name: a.type_name,
        remarks: a.remarks,
        poster: a.poster,
        update_time: nonempty(&a.vod_time),
        tmdb: None,
        area: a.area,
        score: a.score,
        site_score: a.site_score,
        hits: a.hits,
        source_count: a.entries.len() as u32,
        entries: a.entries,
    }
}

// ---------- RPC 入口 ----------

/// catalog.* 方法处理（rest = method 去掉 "catalog." 前缀）
/// 返回 None 表示方法未识别（由 main.rs 报 -32601）
pub async fn handle(
    rest: &str,
    params: &Value,
    id: Value,
    engine: &Arc<TaskManager>,
    proxy: &ProxyInfo,
) -> Option<String> {
    let store = engine.store();
    // P19：本轮请求的缓存策略快照（TTL/容量/回退开关），一次读取贯穿整个 RPC
    let policy = SrcCachePolicy::load(store);
    let result: Result<Value, (i32, String)> = match rest {
        "source.list" => store
            .list_catalog_sources()
            .map(|rows| json!({ "sources": rows }))
            .map_err(|e| (-32000, e)),

        "source.add" => {
            let name = str_param(params, "name").unwrap_or_default();
            let api = normalize_api(str_param(params, "api").unwrap_or_default());
            if name.is_empty() || api.is_empty() {
                Err((-32602, "invalid params: name / api required".into()))
            } else if store.get_catalog_source_by_api(&api).ok().flatten().is_some() {
                Err((-32000, "该 API 源站已存在".into()))
            } else {
                let probe = probe_source(&api).await;
                if !probe.ok {
                    Err((-32000, format!("源站探测失败：{}", probe.error.unwrap_or_default())))
                } else {
                    let sid = rand_id();
                    if let Err(e) = store.insert_catalog_source(&sid, &name, &api, true, false) {
                        return Some(error_response(id, -32000, &e));
                    }
                    // 探测已成功，回写延迟/时间戳
                    let row = match store.update_catalog_source(&sid, None, None, None, probe.latency_ms, true) {
                        Ok(r) => r,
                        Err(e) => return Some(error_response(id, -32000, &e)),
                    };
                    Ok(json!({ "source": row, "probe": probe }))
                }
            }
        }

        "source.update" => {
            let Some(sid) = str_param(params, "id").map(str::to_string) else {
                return Some(error_response(id, -32602, "invalid params: id required"));
            };
            let enabled = params.get("enabled").and_then(|v| v.as_bool());
            let name = str_param(params, "name").map(str::to_string);
            let api = str_param(params, "api").map(normalize_api);
            store
                .update_catalog_source(&sid, name.as_deref(), api.as_deref(), enabled, None, false)
                .map(|row| json!({ "source": row }))
                .map_err(|e| (-32000, e))
        }

        "source.remove" => {
            let Some(sid) = str_param(params, "id").map(str::to_string) else {
                return Some(error_response(id, -32602, "invalid params: id required"));
            };
            // P19：删源站时连带失效其名下缓存（search/category/detail 的 key 都以 `api|` 开头）
            if let Ok(Some(row)) = store.get_catalog_source(sid.as_str()) {
                let prefix = format!("{}|", row.api);
                for kind in [KIND_SEARCH, KIND_CATEGORY, KIND_DETAIL] {
                    store.src_cache_invalidate_prefix(kind, &prefix);
                }
            }
            store.delete_catalog_source(&sid).map(|removed| json!({ "removed": removed })).map_err(|e| (-32000, e))
        }

        "source.test" => {
            let api = str_param(params, "api").map(normalize_api);
            let probe = if let Some(api) = api.filter(|s| !s.is_empty()) {
                probe_source(&api).await
            } else if let Some(sid) = str_param(params, "id") {
                match store.get_catalog_source(sid) {
                    Ok(Some(row)) => {
                        let p = probe_source(&row.api).await;
                        if p.ok {
                            let _ = store.update_catalog_source(sid, None, None, None, p.latency_ms, true);
                        }
                        p
                    }
                    _ => Probe { ok: false, latency_ms: None, samples: None, error: Some("源站不存在".into()) },
                }
            } else {
                return Some(error_response(id, -32602, "invalid params: id / api required"));
            };
            Ok(json!({ "probe": probe }))
        }

        // 内置预设库：返回全量预设 + 是否已存在于本机（供「同步预设库」判断缺口）
        "source.presets" => {
            let rows = match store.list_catalog_sources() {
                Ok(v) => v,
                Err(e) => return Some(error_response(id, -32000, &e)),
            };
            let have: HashSet<String> = rows.iter().map(|s| s.api.to_lowercase()).collect();
            let total = presets::PRESETS.len();
            let mut installed = 0usize;
            let list: Vec<Value> = presets::PRESETS
                .iter()
                .map(|(name, api)| {
                    let api = normalize_api(api);
                    let has = have.contains(&api.to_lowercase());
                    if has {
                        installed += 1;
                    }
                    json!({ "name": name, "api": api, "installed": has })
                })
                .collect();
            Ok(json!({
                "version": presets::PRESET_VERSION,
                "total": total,
                "installed": installed,
                "presets": list,
            }))
        }

        // 批量导入源站：粘贴文本 / 订阅 URL（LibreTV JSON、MoonTV/LunaTV Base58 均支持）
        "source.import" => {
            let probe_on = params.get("probe").and_then(Value::as_bool).unwrap_or(true);
            let enabled = params.get("enabled").and_then(Value::as_bool).unwrap_or(true);
            let builtin = params.get("builtin").and_then(Value::as_bool).unwrap_or(false);
            let mut text = str_param(params, "text").unwrap_or("").to_string();
            if let Some(url) = str_param(params, "url").map(str::trim).filter(|s| !s.is_empty()) {
                match fetch_subscription(url).await {
                    Ok(body) => {
                        if !text.is_empty() {
                            text.push('\n');
                        }
                        text.push_str(&body);
                    }
                    Err(e) => return Some(error_response(id, -32000, &format!("订阅拉取失败：{e}"))),
                }
            }
            if text.trim().is_empty() {
                return Some(error_response(id, -32602, "invalid params: text / url required"));
            }
            let mut cands = sourcelist::parse_sources(&text);
            if cands.is_empty() {
                return Some(error_response(
                    id,
                    -32602,
                    "未解析出源站（支持每行「名称$URL」或 JSON / Base58 订阅内容）",
                ));
            }
            // 成人向条目一律不入库（清单自带 isAdult 标记）
            let adult_dropped = cands.iter().filter(|c| c.adult).count();
            cands.retain(|c| !c.adult);
            cands.truncate(sourcelist::MAX_CANDIDATES);

            let existing = store.list_catalog_sources().unwrap_or_default();
            let have: HashSet<String> = existing.iter().map(|s| s.api.to_lowercase()).collect();
            let mut skipped = 0usize;
            let mut pending: Vec<sourcelist::SourceCandidate> = Vec::new();
            for c in cands {
                if have.contains(&c.api.to_lowercase()) {
                    skipped += 1;
                } else {
                    pending.push(c);
                }
            }

            let mut imported: Vec<Value> = Vec::new();
            let mut failed: Vec<Value> = Vec::new();
            for chunk in pending.chunks(IMPORT_CONCURRENCY) {
                if probe_on {
                    let mut handles = Vec::new();
                    for c in chunk.iter().cloned() {
                        handles.push(tokio::spawn(async move {
                            let p = probe_source(&c.api).await;
                            (c, p)
                        }));
                    }
                    for h in join_all(handles).await {
                        let Ok((c, p)) = h else { continue };
                        if !p.ok {
                            failed.push(json!({
                                "name": c.name, "api": c.api,
                                "error": p.error.unwrap_or_else(|| "探测失败".into()),
                            }));
                            continue;
                        }
                        match insert_imported(store, &c, enabled, builtin, p.latency_ms) {
                            Ok(v) => imported.push(v),
                            Err(e) => failed.push(json!({ "name": c.name, "api": c.api, "error": e })),
                        }
                    }
                } else {
                    for c in chunk {
                        match insert_imported(store, &c, enabled, builtin, None) {
                            Ok(v) => imported.push(v),
                            Err(e) => failed.push(json!({ "name": c.name, "api": c.api, "error": e })),
                        }
                    }
                }
            }
            let (imported_count, failed_count) = (imported.len(), failed.len());
            Ok(json!({
                "imported": imported,
                "importedCount": imported_count,
                "skipped": skipped,
                "failed": failed,
                "failedCount": failed_count,
                "adultDropped": adult_dropped,
            }))
        }

        // 全量测速：并发探测所有（或指定）源站，成功即回写延迟/最近成功时间
        "source.probe_all" => {
            let rows = match store.list_catalog_sources() {
                Ok(v) => v,
                Err(e) => return Some(error_response(id, -32000, &e)),
            };
            let filter: Option<HashSet<String>> = params.get("ids").and_then(Value::as_array).map(|a| {
                a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()
            });
            let targets: Vec<_> =
                rows.into_iter().filter(|s| filter.as_ref().map_or(true, |f| f.contains(&s.id))).collect();
            let mut results: Vec<Value> = Vec::new();
            let (mut ok_n, mut fail_n) = (0u32, 0u32);
            for chunk in targets.chunks(IMPORT_CONCURRENCY) {
                let mut handles = Vec::new();
                for s in chunk.iter() {
                    let api = s.api.clone();
                    handles.push(tokio::spawn(async move { probe_source(&api).await }));
                }
                for (s, h) in chunk.iter().zip(join_all(handles).await) {
                    let p = h.unwrap_or(Probe {
                        ok: false,
                        latency_ms: None,
                        samples: None,
                        error: Some("探测任务异常".into()),
                    });
                    if p.ok {
                        ok_n += 1;
                        let _ = store.update_catalog_source(&s.id, None, None, None, p.latency_ms, true);
                    } else {
                        fail_n += 1;
                    }
                    results.push(json!({
                        "id": s.id,
                        "name": s.name,
                        "api": s.api,
                        "ok": p.ok,
                        "latencyMs": p.latency_ms,
                        "samples": p.samples,
                        "error": p.error,
                    }));
                }
            }
            Ok(json!({ "ok": ok_n, "fail": fail_n, "results": results }))
        }

        "search" => {
            let Some(q) = str_param(params, "q").map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) else {
                return Some(error_response(id, -32602, "invalid params: q required"));
            };
            let sources = match store.list_catalog_sources() {
                Ok(v) => v.into_iter().filter(|s| s.enabled).collect::<Vec<_>>(),
                Err(e) => return Some(error_response(id, -32000, &e)),
            };
            // M7：并发上限 —— 分批扇出（每批 IMPORT_CONCURRENCY 路），
            // 源站很多时不再一次性 spawn 全量请求（导入 500 源后一次搜索曾达千级并发）
            // P19：缓存要拿 &CacheStore，改用借用型 join_all（并发语义不变，省掉 'static）
            // P43：搜索也要能翻页。实测「爱」在非凡站有 1195 条 / 60 页，旧实现只取
            // 第一页（默认 20 条）再聚合截断，等于漏掉 98% 的结果。
            let pg = params.get("pg").and_then(Value::as_u64).unwrap_or(1).clamp(1, 200) as u32;
            let limit =
                params.get("limit").and_then(Value::as_u64).unwrap_or(60).clamp(12, 120) as usize;
            let mut results = Vec::new();
            for chunk in sources.chunks(IMPORT_CONCURRENCY) {
                let futs = chunk.iter().map(|s| {
                    let api = s.api.clone();
                    let q = q.clone();
                    let pol = policy.clone();
                    async move {
                        let t0 = Instant::now();
                        let r = search_one(store, &pol, &api, &q, pg).await;
                        (r, t0.elapsed().as_millis() as i64)
                    }
                });
                for (s, (r, ms)) in chunk.iter().zip(join_all(futs).await) {
                    results.push((s.clone(), r, ms));
                }
            }
            let mut map: std::collections::BTreeMap<String, Acc> = Default::default();
            let mut failures = Vec::new();
            let mut summary = CacheSummary::default();
            let mut has_more = false;
            for (s, r, ms) in results {
                match r {
                    Ok((vp, mark)) if !vp.items.is_empty() => {
                        summary.record(mark);
                        let _ = store.update_catalog_source(&s.id, None, None, None, Some(ms), true);
                        // 任一源站还有下一页 ⇒ 全局还有更多（多站聚合是并集）
                        if page_has_more(&vp, pg) {
                            has_more = true;
                        }
                        accumulate(&mut map, &s.id, &s.name, &s.api, vp.items, &Filters::default());
                    }
                    _ => failures.push(s.name.clone()),
                }
            }
            let mut cards: Vec<Card> =
                map.into_iter().map(|(key, a)| acc_to_card(key, a)).collect();
            // 热度排序：收录站数多者优先，其次名称
            cards.sort_by(|a, b| b.source_count.cmp(&a.source_count).then(a.name.cmp(&b.name)));
            cards.truncate(limit);
            let failed = failures.len();
            Ok(json!({
                "cards": cards,
                "failures": failures,
                "page": pg,
                "hasMore": has_more,
                "cache": summary.to_json(failed),
            }))
        }

        // P9 分类浏览 / 更新流（吸收 GYING）：ac=detail&pg=N 翻页扇出，
        // 大类按 type_name 关键词客户端过滤（t= 站间类型 ID 不互通），年份精确匹配，
        // 地区按 vod_area 包含匹配。sort=hot 按收录站数排序（热门榜），默认更新时间降序。
        // hours=Some(h) 走「最近 h 小时更新」流（苹果CMS h 参数）。
        "category" => {
            let pg = params.get("pg").and_then(Value::as_u64).unwrap_or(1).clamp(1, 500) as u32;
            let hours =
                params.get("hours").and_then(Value::as_u64).map(|h| h.clamp(1, 720) as u32);
            let f = Filters {
                category: str_param(params, "category").unwrap_or("").trim().to_string(),
                year: str_param(params, "year").unwrap_or("").trim().to_string(),
                year_before: params
                    .get("yearBefore")
                    .and_then(Value::as_u64)
                    .map(|y| y.clamp(1900, 2200) as u32),
                area: str_param(params, "area").unwrap_or("").trim().to_string(),
            };
            // sort: hot = 收录站数（默认热门榜）；score = 豆瓣评分；hits = 站内播放量；time = 更新时间
            let sort = str_param(params, "sort").unwrap_or("").trim().to_string();
            let sort_hot = sort == "hot";
            let sort_score = sort == "score";
            let sort_hits = sort == "hits";
            // 评分门槛：0 表示不筛；scoreSource 决定看豆瓣还是站内评分
            let min_score = params.get("minScore").and_then(Value::as_f64).filter(|m| *m > 0.0);
            let score_source = str_param(params, "scoreSource").unwrap_or("douban");
            let min_sources = params.get("minSources").and_then(Value::as_u64).map(|n| n as u32);
            // P43：输出条数上限（客户端可调）与「本次要凑多少候选」
            let limit =
                params.get("limit").and_then(Value::as_u64).unwrap_or(60).clamp(12, 120) as usize;
            // 强过滤（评分门槛/收录站数）会在聚合之后再过一轮，得多攒些候选，
            // 否则筛完不足一页，看起来又像「只有这么点内容」
            let need = if min_score.is_some() || min_sources.is_some() {
                limit.saturating_mul(3)
            } else {
                // 跨站去重会损耗一批（同片多站合成一条），留 10 条余量
                limit + 10
            };
            let sources = match store.list_catalog_sources() {
                Ok(v) => v.into_iter().filter(|s| s.enabled).collect::<Vec<_>>(),
                Err(e) => return Some(error_response(id, -32000, &e)),
            };
            if sources.is_empty() {
                return Some(error_response(id, -32000, "无启用的源站，请先在源站管理中添加"));
            }
            // M7：并发上限 —— 与 search 同样分批扇出
            // P19：按 `api|pg|hours|pagesize` 缓存整页 JSON（大类/年份/地区是本地过滤，不影响 key）
            // P43：**填页循环**。旧实现只拉 `pg` 这一页就返回，而分类/年份/地区都在本地
            // 过滤 —— 窄条件（综艺 + 日本）一页 18×50 条筛完可能只剩 3 条；更糟的是
            // hasMore 原来按「筛后条数 >= 20」猜，于是「加载更多」直接消失。
            // 现在：凑不满一页就继续往后翻（上限 CAT_PAGE_WINDOW 页），
            // 终止条件交给站内 pagecount / 空列表。
            let mut map: std::collections::BTreeMap<String, Acc> = Default::default();
            let mut failures: Vec<String> = Vec::new();
            let mut summary = CacheSummary::default();
            // 每站是否已到底（下标与 sources 对齐）
            let mut done = vec![false; sources.len()];
            let mut got_any = false;
            let mut pg_cur = pg;
            let mut pages_fetched = 0u32;
            while pages_fetched < CAT_PAGE_WINDOW && map.len() < need && done.iter().any(|d| !d) {
                let active: Vec<usize> = (0..sources.len()).filter(|i| !done[*i]).collect();
                let mut batch = Vec::with_capacity(active.len());
                for chunk in active.chunks(IMPORT_CONCURRENCY) {
                    let futs = chunk.iter().map(|&i| {
                        let api = sources[i].api.clone();
                        let pol = policy.clone();
                        async move {
                            let t0 = Instant::now();
                            let r = fetch_cms_page(store, &pol, &api, pg_cur, hours).await;
                            (r, t0.elapsed().as_millis() as i64)
                        }
                    });
                    for (&i, (r, ms)) in chunk.iter().zip(join_all(futs).await) {
                        batch.push((i, r, ms));
                    }
                }
                for (i, r, ms) in batch {
                    let s = &sources[i];
                    match r {
                        Ok((vp, mark)) => {
                            got_any = true;
                            summary.record(mark);
                            let _ = store.update_catalog_source(&s.id, None, None, None, Some(ms), true);
                            if !page_has_more(&vp, pg_cur) {
                                done[i] = true;
                            }
                            accumulate(&mut map, &s.id, &s.name, &s.api, vp.items, &f);
                        }
                        Err(_) => {
                            // 单站失败不中断整轮翻页：本页跳过，下一个窗口再试；名字只记一次
                            if !failures.iter().any(|n| n == &s.name) {
                                failures.push(s.name.clone());
                            }
                        }
                    }
                }
                pages_fetched += 1;
                pg_cur += 1;
            }
            let mut cards: Vec<Card> =
                map.into_iter().map(|(key, a)| acc_to_card(key, a)).collect();
            // 覆盖率统计在**评分/收录站数过滤前**算：UI 要据此提示「本批只有 12 部有豆瓣评分」，
            // 否则用户按评分筛出 0 条会以为功能坏了。
            // 注意 total 是「已按类型/地区/年份聚合出来的候选数」——这三个维度在 accumulate
            // 阶段就过滤掉了，所以它们无交集时 total=0 是对的，不是统计丢失。
            let total = cards.len();
            let douban_scored = cards.iter().filter(|c| c.score.is_some()).count();
            let site_scored = cards.iter().filter(|c| c.site_score.is_some()).count();
            if let Some(m) = min_score {
                cards.retain(|c| {
                    let v = if score_source == "site" { c.site_score } else { c.score };
                    // 无评分不参与「N 分以上」：宁可漏掉，也不能把没评分的当 0 分混进来
                    v.map(|x| x + 1e-9 >= m).unwrap_or(false)
                });
            }
            if let Some(n) = min_sources {
                cards.retain(|c| c.source_count >= n);
            }
            if sort_score {
                // 豆瓣评分降序；同分看收录站数，再看更新时间（无评分的沉底）
                cards.sort_by(|a, b| {
                    let (sa, sb) = (a.score.unwrap_or(-1.0), b.score.unwrap_or(-1.0));
                    sb.partial_cmp(&sa)
                        .unwrap_or(std::cmp::Ordering::Equal)
                        .then(b.source_count.cmp(&a.source_count))
                        .then_with(|| {
                            b.update_time
                                .as_deref()
                                .unwrap_or("")
                                .cmp(a.update_time.as_deref().unwrap_or(""))
                        })
                });
            } else if sort_hits {
                // 跨站播放量合计降序；不同站量级差异大，只作热度参考
                cards.sort_by(|a, b| {
                    b.hits.cmp(&a.hits).then(b.source_count.cmp(&a.source_count))
                });
            } else if sort_hot {
                // 热门榜：先按站数粗排截候选（人气查询只对前排做，避免全量打 TMDB）
                cards.sort_by(|a, b| {
                    b.source_count.cmp(&a.source_count).then_with(|| {
                        b.update_time.as_deref().unwrap_or("").cmp(a.update_time.as_deref().unwrap_or(""))
                    })
                });
                // P13 热门榜叠加 TMDB 人气：配置了 Key 时对前 30 名查 popularity，
                // 加权排序 score = source_count + min(popularity/10, 20)；未命中/无 Key 纯站数排序。
                if let Some(key) = store.setting_get(SET_TMDB_KEY).filter(|k| !k.is_empty()) {
                    let candidate_n = cards.len().min(30);
                    enrich_hot_cards(store, &policy, &key, &mut cards[..candidate_n]).await;
                    cards.sort_by(|a, b| {
                        let sa = a.source_count as f64 + a.tmdb.and_then(|t| t.popularity).map(|p| (p / 10.0).min(20.0)).unwrap_or(0.0);
                        let sb = b.source_count as f64 + b.tmdb.and_then(|t| t.popularity).map(|p| (p / 10.0).min(20.0)).unwrap_or(0.0);
                        sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
                    });
                }
            } else {
                // 更新流排序：站内更新时间新者优先（vod_time 字符串字典序 = 时间序）
                cards.sort_by(|a, b| {
                    b.update_time.as_deref().unwrap_or("").cmp(a.update_time.as_deref().unwrap_or(""))
                });
            }
            // 终止条件来自站内 pagecount：只要还有一个站没到底，就还能继续翻。
            // got_any 兜住「全部源站失败」—— 否则 hasMore 会一直为真，前端无限点「加载更多」。
            let has_more = got_any && done.iter().any(|d| !d);
            cards.truncate(limit);
            let failed = failures.len();
            Ok(json!({
                "cards": cards,
                "failures": failures,
                // 本次消费到的最后一页（客户端用 page+1 续翻，多页填充时不会跳页）
                "page": pg_cur.saturating_sub(1),
                "pages": pages_fetched,
                "hasMore": has_more,
                "cache": summary.to_json(failed),
                // 本批（过滤前）的评分覆盖情况，供前端提示「评分数据不全」
                "stats": {
                    "total": total,
                    "doubanScored": douban_scored,
                    "siteScored": site_scored,
                    "matched": cards.len(),
                    "filtered": !f.is_empty() || min_score.is_some() || min_sources.is_some(),
                },
            }))
        }

        "detail" => {
            let (Some(api), Some(vod_id)) = (
                str_param(params, "api").map(normalize_api),
                str_param(params, "vodId").map(str::to_string),
            ) else {
                return Some(error_response(id, -32602, "invalid params: api / vodId required"));
            };
            if api.is_empty() || vod_id.is_empty() {
                return Some(error_response(id, -32602, "invalid params: api / vodId required"));
            }
            let site_name = str_param(params, "sourceId")
                .and_then(|sid| store.get_catalog_source(sid).ok().flatten())
                .map(|s| s.name)
                .unwrap_or_else(|| api_host(&api));
            match detail_one(store, &policy, &api, &vod_id).await {
                Ok((item, mark)) => {
                    let detail = item_to_detail(&item, &api, &site_name);
                    Ok(json!({
                        "detail": detail,
                        "cache": {
                            "fromCache": if mark.cached { 1 } else { 0 },
                            "stale": if mark.stale { 1 } else { 0 },
                            "total": 1,
                            "failed": 0,
                            "oldestMs": if mark.cached { Some(mark.stored_at_ms) } else { None },
                        },
                    }))
                }
                Err(e) => Err((-32000, format!("详情拉取失败：{e}"))),
            }
        }

        "favorite.list" => store
            .list_favorites()
            .map(|rows| json!({ "favorites": rows }))
            .map_err(|e| (-32000, e)),

        "favorite.add" => {
            if let Some(d) = params.get("detail") {
                let detail: Detail = match serde_json::from_value(d.clone()) {
                    Ok(v) => v,
                    Err(e) => return Some(error_response(id, -32602, &format!("invalid detail: {e}"))),
                };
                if detail.name.trim().is_empty() {
                    return Some(error_response(id, -32602, "invalid detail: name required"));
                }
                return match favorite_from_detail(store, &detail) {
                    Ok(f) => Some(ok_response(id, json!({ "favorite": fav_row_json(f) }))),
                    Err(e) => Some(error_response(id, -32000, &e)),
                };
            }
            if let Some(c) = params.get("card") {
                let card: Card = match serde_json::from_value(c.clone()) {
                    Ok(v) => v,
                    Err(e) => return Some(error_response(id, -32602, &format!("invalid card: {e}"))),
                };
                if card.name.trim().is_empty() || card.entries.is_empty() {
                    return Some(error_response(id, -32602, "invalid card: name / entries required"));
                }
                let fav_id = match store.find_favorite_by_key(&card.name, card.year.as_deref().unwrap_or("")) {
                    Ok(Some(f)) => f.id,
                    Ok(None) => {
                        let fid = rand_id();
                        if let Err(e) = store.insert_favorite(
                            &fid,
                            &card.name,
                            card.year.as_deref(),
                            card.type_name.as_deref(),
                            card.remarks.as_deref(),
                            card.poster.as_deref(),
                            None,
                        ) {
                            return Some(error_response(id, -32000, &e));
                        }
                        fid
                    }
                    Err(e) => return Some(error_response(id, -32000, &e)),
                };
                // 并发拉取各站详情快照（cap 3），失败站点跳过（卡片 entries 仍可重试）
                let fetches = card.entries.iter().take(FAVORITE_DETAIL_CAP).map(|e| {
                    let api = e.api.clone();
                    let vod_id = e.vod_id.clone();
                    let site_name = e.site_name.clone();
                    let pol = policy.clone();
                    async move {
                        detail_one(store, &pol, &api, &vod_id)
                            .await
                            .map(|(it, _)| (it, api, vod_id, site_name))
                    }
                });
                for r in join_all(fetches).await {
                    if let Ok((item, api, _vod_id, site_name)) = r {
                        let detail = item_to_detail(&item, &api, &site_name);
                        if let Err(e) = favorite_from_detail(store, &detail) {
                            eprintln!("[pf-core] favorite detail merge 失败: {e}");
                        }
                    }
                }
                let f = match store.get_favorite(&fav_id) {
                    Ok(Some(f)) => f,
                    _ => return Some(error_response(id, -32000, "收藏写入失败")),
                };
                return Some(ok_response(id, json!({ "favorite": fav_row_json(f) })));
            }
            Err((-32602, "invalid params: card / detail required".into()))
        }

        "favorite.remove" => {
            let Some(fid) = str_param(params, "id").map(str::to_string) else {
                return Some(error_response(id, -32602, "invalid params: id required"));
            };
            store.delete_favorite(&fid).map(|removed| json!({ "removed": removed })).map_err(|e| (-32000, e))
        }

        // P35 收藏清理：批量取消收藏（媒体库收藏 tab 的多选 / 规则清理）
        // 逐条删但只回一次包：单条失败只记进 failed，不中断其余 —— 清理场景里
        // 「某条收藏已经被别处删掉」是正常竞态，不该让整批回滚。
        "favorite.remove_many" => {
            let ids: Vec<String> = params
                .get("ids")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            if ids.is_empty() {
                Err((-32602, "invalid params: ids required".into()))
            } else {
                let mut removed = 0usize;
                let mut failed: Vec<Value> = Vec::new();
                for fid in &ids {
                    match store.delete_favorite(fid) {
                        Ok(true) => removed += 1,
                        Ok(false) => {}
                        Err(e) => failed.push(json!({ "id": fid, "error": e })),
                    }
                }
                Ok(json!({ "removed": removed, "failed": failed }))
            }
        }

        "favorite.sources" => {
            let Some(fid) = str_param(params, "id").map(str::to_string) else {
                return Some(error_response(id, -32602, "invalid params: id required"));
            };
            match store.list_favorite_sources(&fid) {
                Ok(rows) => {
                    let sources: Vec<Value> = rows.into_iter().map(fav_source_json).collect();
                    Ok(json!({ "sources": sources }))
                }
                Err(e) => Err((-32000, e)),
            }
        }

        "favorite.source.add" => {
            let Some(fid) = str_param(params, "favoriteId").map(str::to_string) else {
                return Some(error_response(id, -32602, "invalid params: favoriteId required"));
            };
            let Some(urls) = str_param(params, "urls").map(str::to_string) else {
                return Some(error_response(id, -32602, "invalid params: urls required"));
            };
            if store.get_favorite(&fid).ok().flatten().is_none() {
                return Some(error_response(id, -32000, "收藏不存在"));
            }
            // 手动输入归一：换行 → #，复用 CMS play_url 解析（名称$URL 或裸 URL）
            let normalized = urls.replace("\r\n", "#").replace('\n', "#");
            let episodes: Vec<Episode> = cms::parse_play_groups("", &normalized)
                .into_iter()
                .flat_map(|g| g.episodes.into_iter().map(|(name, url)| Episode { name, url }))
                .collect();
            if episodes.is_empty() {
                return Some(error_response(id, -32602, "未解析出有效 URL（支持 名称$URL#名称$URL 或每行一个链接）"));
            }
            let episodes_json = serde_json::to_string(&episodes).unwrap_or_else(|_| "[]".into());
            let site_name = str_param(params, "label")
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "手动补充".to_string());
            let sid = rand_id();
            if let Err(e) =
                store.insert_favorite_source(&sid, &fid, &site_name, None, None, &episodes_json, None, None, "manual")
            {
                return Some(error_response(id, -32000, &e));
            }
            let row = match store.list_favorite_sources(&fid) {
                Ok(rows) => rows.into_iter().find(|r| r.id == sid),
                Err(e) => return Some(error_response(id, -32000, &e)),
            };
            match row {
                Some(r) => Ok(json!({ "source": fav_source_json(r) })),
                None => Err((-32000, "片源写入失败".into())),
            }
        }

        "favorite.source.remove" => {
            let Some(sid) = str_param(params, "sourceId").map(str::to_string) else {
                return Some(error_response(id, -32602, "invalid params: sourceId required"));
            };
            store.delete_favorite_source(&sid).map(|removed| json!({ "removed": removed })).map_err(|e| (-32000, e))
        }

        "favorite.touch" => {
            let Some(fid) = str_param(params, "id").map(str::to_string) else {
                return Some(error_response(id, -32602, "invalid params: id required"));
            };
            store.touch_favorite_played(&fid).map(|_| json!({ "touched": true })).map_err(|e| (-32000, e))
        }

        // P9 追更（吸收 GYING）：回拉收藏片源详情对比集数，快照变多即更新。
        // id 缺省 = 全部收藏；手动补充片源（无 api/vodId）跳过。
        "favorite.refresh" => {
            let favs = match str_param(params, "id") {
                Some(fid) => match store.get_favorite(fid) {
                    Ok(Some(f)) => vec![f],
                    Ok(None) => return Some(error_response(id, -32000, "收藏不存在")),
                    Err(e) => return Some(error_response(id, -32000, &e)),
                },
                None => match store.list_favorites() {
                    Ok(v) => v,
                    Err(e) => return Some(error_response(id, -32000, &e)),
                },
            };
            Ok(refresh_favorite_sources(engine, store, proxy, &favs).await)
        }

        // P11 追更后台巡检（P13 增加间隔可配置）：params.intervalHours 可配置间隔
        //（0 = 关闭，1–72 小时）；params.run=true 时同步手动触发一轮
        // （与 main.rs 的定时任务共用 autoscan_once，落库 lastRunMs / lastAdded；
        // 间隔落库后 main.rs 的 5 分钟 tick 下一轮生效）
        "favorite.autoscan" => {
            if let Some(h) = params.get("intervalHours").and_then(Value::as_u64) {
                if let Err(e) = set_autoscan_interval_hours(engine, h) {
                    return Some(error_response(id, -32602, &e));
                }
            }
            if params.get("run").and_then(Value::as_bool).unwrap_or(false) {
                autoscan_once(engine, proxy).await;
            }
            let last_run_ms = store
                .setting_get(SET_AUTOSCAN_LAST_RUN)
                .and_then(|s| s.parse::<i64>().ok());
            let last_added = store
                .setting_get(SET_AUTOSCAN_LAST_ADDED)
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or(0);
            Ok(json!({
                "lastRunMs": last_run_ms,
                "lastAdded": last_added,
                "intervalHours": autoscan_interval_hours(engine),
            }))
        }

        // P9 继续观看：记录收藏内剧集播放进度（每收藏一条，覆盖写）
        "favorite.progress.set" => {
            let Some(fid) = str_param(params, "favoriteId").map(str::to_string) else {
                return Some(error_response(id, -32602, "invalid params: favoriteId required"));
            };
            let Some(ep_name) = str_param(params, "episodeName").map(str::to_string) else {
                return Some(error_response(id, -32602, "invalid params: episodeName required"));
            };
            let Some(ep_url) = str_param(params, "episodeUrl").map(str::to_string) else {
                return Some(error_response(id, -32602, "invalid params: episodeUrl required"));
            };
            let position = params.get("position").and_then(Value::as_f64).unwrap_or(0.0);
            let duration = params.get("duration").and_then(Value::as_f64).unwrap_or(0.0);
            if store.get_favorite(&fid).ok().flatten().is_none() {
                return Some(error_response(id, -32000, "收藏不存在"));
            }
            if let Err(e) = store.set_watch_progress(&fid, &ep_name, &ep_url, position, duration) {
                return Some(error_response(id, -32000, &e));
            }
            let _ = store.touch_favorite_played(&fid);
            Ok(json!({ "saved": true }))
        }

        // P9 继续观看列表：最近更新的收藏进度（JOIN favorites）
        "progress.list" => {
            let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(20).clamp(1, 50) as u32;
            match store.list_watch_progress(limit) {
                Ok(rows) => {
                    let items: Vec<Value> =
                        rows.into_iter().map(|r| serde_json::to_value(r).unwrap_or(json!(null))).collect();
                    Ok(json!({ "items": items }))
                }
                Err(e) => Err((-32000, e)),
            }
        }

        // P26 历史播放记录：起播/换集写一条（按片去重，同一影片只留最近一集）
        "history.record" => {
            let title = str_param(params, "title").map(str::trim).unwrap_or("").to_string();
            let episode_url = str_param(params, "episodeUrl")
                .map(str::trim)
                .unwrap_or("")
                .to_string();
            if title.is_empty() || episode_url.is_empty() {
                return Some(error_response(
                    id,
                    -32602,
                    "invalid params: title / episodeUrl required",
                ));
            }
            let key = history_key(params);
            let prev = store.get_play_history(&key).ok().flatten();
            let mut rec = PlayHistoryRecord {
                key,
                title,
                episode_name: str_param(params, "episodeName")
                    .unwrap_or("")
                    .trim()
                    .to_string(),
                episode_url,
                site_name: nonempty(str_param(params, "siteName").unwrap_or("")),
                api: nonempty(str_param(params, "api").unwrap_or("")),
                vod_id: nonempty(str_param(params, "vodId").unwrap_or("")),
                poster: nonempty(str_param(params, "poster").unwrap_or("")),
                groups: history_groups_json(params).unwrap_or_else(|| "[]".to_string()),
                group_index: params
                    .get("groupIndex")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
                    .max(0),
                position_sec: None,
                duration_sec: None,
            };
            // 换集（同片不同集）从 0 开始；同一集重播保留旧进度（用户可能是来续播的）
            let same_episode = match prev.as_ref() {
                Some(p) if !rec.episode_name.is_empty() => p.episode_name == rec.episode_name,
                Some(p) => p.episode_url == rec.episode_url,
                None => false,
            };
            if !same_episode {
                rec.position_sec = Some(0.0);
                rec.duration_sec = Some(0.0);
            }
            match store.upsert_play_history(&rec) {
                Ok(row) => Ok(json!({ "item": row })),
                Err(e) => Err((-32000, e)),
            }
        }

        // 进度上报（5s 节流调用）：只刷位置与 played_at，不重复写元数据
        "history.progress" => {
            let Some(key) = str_param(params, "key").map(str::to_string) else {
                return Some(error_response(id, -32602, "invalid params: key required"));
            };
            let position = params.get("position").and_then(Value::as_f64).unwrap_or(0.0).max(0.0);
            let duration = params.get("duration").and_then(Value::as_f64).unwrap_or(0.0).max(0.0);
            match store.update_play_history_progress(&key, position, duration) {
                // 行已被用户删掉时静默忽略，不要打断播放
                Ok(Some(_)) => Ok(json!({ "saved": true })),
                Ok(None) => Ok(json!({ "saved": false })),
                Err(e) => Err((-32000, e)),
            }
        }

        // 历史列表（最近播放倒序，分页）
        "history.list" => {
            let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(60).clamp(1, 200) as u32;
            let offset = params.get("offset").and_then(Value::as_u64).unwrap_or(0) as u32;
            match store.list_play_history(limit, offset) {
                Ok((rows, total)) => {
                    let items: Vec<Value> =
                        rows.into_iter().map(|r| serde_json::to_value(r).unwrap_or(json!(null))).collect();
                    Ok(json!({ "items": items, "total": total }))
                }
                Err(e) => Err((-32000, e)),
            }
        }

        "history.delete" => {
            let Some(key) = str_param(params, "key").map(str::to_string) else {
                return Some(error_response(id, -32602, "invalid params: key required"));
            };
            match store.delete_play_history(&key) {
                Ok(removed) => Ok(json!({ "removed": removed })),
                Err(e) => Err((-32000, e)),
            }
        }

        "history.clear" => match store.clear_play_history() {
            Ok(cleared) => Ok(json!({ "cleared": cleared })),
            Err(e) => Err((-32000, e)),
        },

        // P11 TMDB 评分增强：Key 存 settings 表（空 = 未配置）；
        // lookup 按 name+year 搜 multi（电影/剧集），失败静默降级 found:false。
        "tmdb.get" => {
            Ok(json!({ "key": store.setting_get(SET_TMDB_KEY).unwrap_or_default() }))
        }

        "tmdb.set" => {
            let key = str_param(params, "key").map(str::trim).unwrap_or("").to_string();
            if key.len() > 128 {
                return Some(error_response(id, -32602, "invalid params: key too long"));
            }
            match store.setting_set(SET_TMDB_KEY, &key) {
                Ok(_) => Ok(json!({ "saved": true, "key": key })),
                Err(e) => Err((-32000, e)),
            }
        }

        "tmdb.lookup" => {
            let Some(name) = str_param(params, "name").map(str::trim).filter(|s| !s.is_empty()) else {
                return Some(error_response(id, -32602, "invalid params: name required"));
            };
            let year = str_param(params, "year").map(str::trim).unwrap_or("");
            match store.setting_get(SET_TMDB_KEY).filter(|k| !k.is_empty()) {
                None => Ok(json!({ "found": false, "reason": "no-key" })),
                Some(key) => match tmdb_lookup(store, &policy, &key, name, year).await {
                    Ok(info) => Ok(serde_json::to_value(info).unwrap_or_else(|_| json!({ "found": false }))),
                    Err(e) => Ok(json!({ "found": false, "reason": e })),
                },
            }
        }

        _ => return None,
    };

    Some(match result {
        Ok(v) => ok_response(id, v),
        Err((code, msg)) => error_response(id, code, &msg),
    })
}

fn str_param<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params.get(key).and_then(|v| v.as_str())
}

/// P26 历史去重键：有来源站 + vodId 时按「片」（同一影片换集不新增行），
/// 否则按归一化 URL（去 query/fragment，host 小写）。
fn history_key(params: &Value) -> String {
    let api = str_param(params, "api").unwrap_or("").trim().to_lowercase();
    let vod = str_param(params, "vodId").unwrap_or("").trim().to_string();
    if !api.is_empty() && !vod.is_empty() {
        return format!("vod|{}|{}", api.trim_end_matches('/'), vod);
    }
    normalize_url_key(str_param(params, "episodeUrl").unwrap_or(""))
}

fn normalize_url_key(raw: &str) -> String {
    let no_frag = raw.split('#').next().unwrap_or(raw);
    let no_q = no_frag.split('?').next().unwrap_or(no_frag);
    let t = no_q.trim().trim_end_matches('/');
    if t.is_empty() {
        return String::new();
    }
    // 按字节切片是安全的：偏移来自 find，必落在 char boundary
    match t.find("://") {
        Some(i) => {
            let scheme = &t[..i + 3];
            let rest = &t[i + 3..];
            let (host, path) = match rest.find('/') {
                Some(j) => rest.split_at(j),
                None => (rest, ""),
            };
            format!("url|{}{}{}", scheme.to_lowercase(), host.to_lowercase(), path)
        }
        None => format!("url|{t}"),
    }
}

/// 剧集快照入库前收敛：≤20 组、每组 ≤300 集，坏条目直接丢（防脏数据撑爆行）
fn history_groups_json(params: &Value) -> Option<String> {
    let arr = params.get("groups")?.as_array()?;
    let mut out: Vec<Value> = Vec::new();
    for g in arr.iter().take(20) {
        let from = g.get("from").and_then(Value::as_str).unwrap_or("").to_string();
        let eps: Vec<Value> = g
            .get("episodes")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .take(300)
                    .filter_map(|e| {
                        let name = e.get("name").and_then(Value::as_str)?;
                        let url = e.get("url").and_then(Value::as_str)?;
                        Some(json!({ "name": name, "url": url }))
                    })
                    .collect()
            })
            .unwrap_or_default();
        if !eps.is_empty() {
            out.push(json!({ "from": from, "episodes": eps }));
        }
    }
    if out.is_empty() {
        None
    } else {
        serde_json::to_string(&out).ok()
    }
}

/// api 归一：去首尾空白 + 去尾部 `/`；必须 http(s) 开头
fn normalize_api(api: &str) -> String {
    let t = api.trim().trim_end_matches('/');
    if t.starts_with("http://") || t.starts_with("https://") {
        t.to_string()
    } else {
        String::new()
    }
}

// ---------- P8：批量导入 / 全量测速 ----------

/// 批量导入与全量测速的并发度（同时探测的源站数）
const IMPORT_CONCURRENCY: usize = 12;

/// 订阅拉取：放宽超时（15s）并限制体积（1MB，订阅文本通常 < 200KB）
async fn fetch_subscription(url: &str) -> Result<String, String> {
    let resp = client()
        .get(url)
        .timeout(std::time::Duration::from_secs(15))
        .header("Accept", "application/json,text/plain,*/*")
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("读取失败: {e}"))?;
    if bytes.len() > 1024 * 1024 {
        return Err("订阅内容超过 1MB".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// 写入单条导入源站并返回行 JSON（已探测成功时附带延迟与最近成功时间）
fn insert_imported(
    store: &pf_engine::CacheStore,
    c: &sourcelist::SourceCandidate,
    enabled: bool,
    builtin: bool,
    latency: Option<i64>,
) -> Result<Value, String> {
    let sid = rand_id();
    store.insert_catalog_source(&sid, &c.name, &c.api, enabled, builtin)?;
    let row = store.update_catalog_source(&sid, None, None, None, latency, latency.is_some())?;
    serde_json::to_value(row).map_err(|e| e.to_string())
}

// ---------- P11：追更共用刷新 / 后台巡检 ----------

/// 后台自动巡检默认间隔（小时）；可在 settings 覆盖（`SET_AUTOSCAN_INTERVAL`，0 = 关闭）
pub const DEFAULT_AUTOSCAN_INTERVAL_HOURS: u64 = 6;
/// 巡检间隔上下限（小时）：0 关闭，最多 72
pub const AUTOSCAN_INTERVAL_MAX_HOURS: u64 = 72;
/// 启动后首跑延迟（秒）
pub const AUTOSCAN_START_DELAY_SECS: u64 = 300;

const SET_AUTOSCAN_INTERVAL: &str = "catalog.autoscan.interval_hours";
const SET_AUTOSCAN_LAST_RUN: &str = "catalog.autoscan.last_run_ms";
const SET_AUTOSCAN_LAST_ADDED: &str = "catalog.autoscan.last_added";
const SET_TMDB_KEY: &str = "catalog.tmdb.key";

/// 读取巡检间隔（小时）：settings 缺省/非法时回退默认；0 = 关闭；>72 截断为 72
pub fn autoscan_interval_hours(engine: &Arc<TaskManager>) -> u64 {
    let store = engine.store();
    match store.setting_get(SET_AUTOSCAN_INTERVAL) {
        Some(s) => s.trim().parse::<u64>().unwrap_or(DEFAULT_AUTOSCAN_INTERVAL_HOURS).min(AUTOSCAN_INTERVAL_MAX_HOURS),
        None => DEFAULT_AUTOSCAN_INTERVAL_HOURS,
    }
}

/// 保存巡检间隔（小时）；0 = 关闭；非法输入报错
fn set_autoscan_interval_hours(engine: &Arc<TaskManager>, hours: u64) -> Result<(), String> {
    if hours > AUTOSCAN_INTERVAL_MAX_HOURS {
        return Err(format!("巡检间隔需在 0–{AUTOSCAN_INTERVAL_MAX_HOURS} 小时之间"));
    }
    engine.store().setting_set(SET_AUTOSCAN_INTERVAL, &hours.to_string())
}

/// 回拉收藏片源详情对比集数（RPC favorite.refresh 与后台巡检共用）。
/// 口径与 favorite_from_detail 一致：首个非空剧集组，否则拍平全部组；
/// 新快照集数不增则不动快照；手动补充片源（无 api/vodId）跳过。
/// P16：api 以 `netdisk:` 开头的片源走网盘目录回拉（重新列目录对比集数）。
async fn refresh_favorite_sources(
    engine: &Arc<TaskManager>,
    store: &pf_engine::CacheStore,
    proxy: &ProxyInfo,
    favs: &[pf_engine::FavoriteRow],
) -> Value {
    struct Job {
        fav_id: String,
        fav_name: String,
        source_id: String,
        site_name: String,
        api: String,
        vod_id: String,
        old_count: usize,
    }
    let mut jobs: Vec<Job> = Vec::new();
    // P16：网盘片源（api = netdisk:{owner}:{dirId}）单独队列 —— 走网盘目录回拉，
    // 与 CMS 详情回拉口径不同，且 NetdiskService 借用 engine 不便跨 spawn 持有
    struct NetJob {
        fav_id: String,
        fav_name: String,
        source_id: String,
        site_name: String,
        owner: String,
        dir_id: String,
        old_count: usize,
    }
    let mut net_jobs: Vec<NetJob> = Vec::new();
    for f in favs {
        let Ok(rows) = store.list_favorite_sources(&f.id) else { continue };
        for r in rows {
            let (Some(api), Some(vod_id)) = (r.api.clone(), r.vod_id.clone()) else {
                continue;
            };
            if api.is_empty() || vod_id.is_empty() {
                continue;
            }
            let old_count = serde_json::from_str::<Value>(&r.episodes)
                .ok()
                .and_then(|v| v.as_array().cloned())
                .map(|a| a.len())
                .unwrap_or(0);
            // 网盘片源：netdisk:{owner}:{dirId}，dirId 记录在 vod_id
            if let Some(rest) = api.strip_prefix("netdisk:") {
                if let Some((owner, target)) = rest.rsplit_once(':') {
                    if target == vod_id {
                        net_jobs.push(NetJob {
                            fav_id: f.id.clone(),
                            fav_name: f.name.clone(),
                            source_id: r.id,
                            site_name: r.site_name.clone(),
                            owner: owner.to_string(),
                            dir_id: vod_id,
                            old_count,
                        });
                        continue;
                    }
                }
            }
            jobs.push(Job {
                fav_id: f.id.clone(),
                fav_name: f.name.clone(),
                source_id: r.id,
                site_name: r.site_name.clone(),
                api,
                vod_id,
                old_count,
            });
        }
    }
    let mut updated: Vec<Value> = Vec::new();
    let mut failed: Vec<Value> = Vec::new();
    if !jobs.is_empty() {
        // M7：并发上限 —— 追更巡检（每 6h 一次）与手动刷新分批扇出，
        // 收藏的多片源不再一次性 spawn 全量详情请求
        let mut results = Vec::new();
        let policy = SrcCachePolicy::load(store);
        while !jobs.is_empty() {
            let take = jobs.len().min(IMPORT_CONCURRENCY);
            let batch: Vec<_> = jobs.drain(..take).collect();
            let futs = batch.iter().map(|j| {
                let api = j.api.clone();
                let vod_id = j.vod_id.clone();
                let pol = policy.clone();
                async move { detail_one(store, &pol, &api, &vod_id).await.map(|(it, _)| it) }
            });
            let done = join_all(futs).await;
            for (j, r) in batch.into_iter().zip(done) {
                results.push((j, r));
            }
        }
        for (j, r) in results {
            let item = match r {
                Ok(it) => it,
                Err(e) => {
                    failed.push(json!({ "favoriteId": j.fav_id, "siteName": j.site_name, "error": e }));
                    continue;
                }
            };
            let groups = cms::parse_play_groups(&item.vod_play_from, &item.vod_play_url);
            let episodes: Vec<Episode> = match groups.iter().find(|g| !g.episodes.is_empty()) {
                Some(g) => g.episodes.iter().cloned().map(|(n, u)| Episode { name: n, url: u }).collect(),
                None => groups
                    .iter()
                    .flat_map(|g| g.episodes.iter().cloned().map(|(n, u)| Episode { name: n, url: u }))
                    .collect(),
            };
            if episodes.len() <= j.old_count {
                continue; // 无新增
            }
            let added = episodes.len() - j.old_count;
            let episodes_json = serde_json::to_string(&episodes).unwrap_or_else(|_| "[]".into());
            if let Err(e) =
                store.update_favorite_source_episodes(
                &j.source_id,
                &episodes_json,
                nonempty(&item.vod_remarks).as_deref(),
                nonempty(&item.vod_pic).as_deref(),
            )
            {
                failed.push(json!({ "favoriteId": j.fav_id, "siteName": j.site_name, "error": e }));
                continue;
            }
            updated.push(json!({
                "favoriteId": j.fav_id,
                "name": j.fav_name,
                "siteName": j.site_name,
                "oldCount": j.old_count,
                "newCount": episodes.len(),
                "added": added,
            }));
        }
    }
    // P16：网盘片源追更 —— 重新列目录生成剧集快照，集数有增才回写
    for j in net_jobs {
        match crate::netdisk::refresh_netdisk_episodes(engine, proxy, &j.owner, &j.dir_id).await {
            Ok(eps) => {
                if eps.len() <= j.old_count {
                    continue; // 无新增
                }
                let episodes_json = serde_json::to_string(&eps).unwrap_or_else(|_| "[]".into());
                if let Err(e) = store.update_favorite_source_episodes(&j.source_id, &episodes_json, None, None) {
                    failed.push(json!({ "favoriteId": j.fav_id, "siteName": j.site_name, "error": e }));
                    continue;
                }
                updated.push(json!({
                    "favoriteId": j.fav_id,
                    "name": j.fav_name,
                    "siteName": j.site_name,
                    "oldCount": j.old_count,
                    "newCount": eps.len(),
                    "added": eps.len() - j.old_count,
                }));
            }
            Err(e) => {
                failed.push(json!({ "favoriteId": j.fav_id, "siteName": j.site_name, "error": e }));
            }
        }
    }
    json!({ "checked": favs.len(), "updated": updated, "failed": failed })
}

fn unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 后台自动巡检一轮：全部收藏追更 + 落库状态（main.rs 定时任务 / autoscan RPC 共用）。
/// 收藏为空时也记录 lastRunMs（避免状态一直显示「未巡检」）。
pub async fn autoscan_once(engine: &Arc<TaskManager>, proxy: &ProxyInfo) {
    let store = engine.store();
    let favs = match store.list_favorites() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[pf-core] 收藏自动巡检失败: {e}");
            return;
        }
    };
    let result = refresh_favorite_sources(engine, store, proxy, &favs).await;
    let added: u32 = result["updated"]
        .as_array()
        .map(|a| a.iter().filter_map(|u| u["added"].as_u64()).sum::<u64>() as u32)
        .unwrap_or(0);
    let updated_n = result["updated"].as_array().map(|a| a.len()).unwrap_or(0);
    let _ = store.setting_set(SET_AUTOSCAN_LAST_RUN, &unix_ms().to_string());
    let _ = store.setting_set(SET_AUTOSCAN_LAST_ADDED, &added.to_string());
    if updated_n > 0 {
        eprintln!("[pf-core] 收藏自动巡检：checked={} updated={} +{}集", favs.len(), updated_n, added);
    }
}

// ---------- P11：TMDB 评分增强 ----------

/// TMDB lookup 出参（found=false 时仅 reason）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TmdbInfo {
    found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rating: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    votes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    year: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    poster: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    overview: Option<String>,
}

/// 热门榜人气条目（category sort=hot 时附加到卡片）
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct TmdbPop {
    rating: Option<f64>,
    popularity: Option<f64>,
}

/// TMDB API 基址：环境变量 PF_TMDB_API 可覆盖（冒烟测试用本地假站）
fn tmdb_api_base() -> String {
    std::env::var("PF_TMDB_API").unwrap_or_else(|_| "https://api.themoviedb.org/3".into())
}

/// 按 name(+year) 搜 TMDB multi（电影+剧集），取第一条（TMDB 按相关度排序）。
/// year 匹配 movie.release_date / tv.first_air_date 前缀；无命中年份则回退第一条。
/// 返回命中的原始 result 对象（调用方自行挑字段），无命中返回 None。
async fn tmdb_search(key: &str, name: &str, year: &str) -> Result<Option<Value>, String> {
    let year = year.trim().chars().take(4).collect::<String>();
    let mut req = client()
        .get(format!("{}/search/multi", tmdb_api_base()))
        .query(&[("api_key", key), ("query", name), ("language", "zh-CN")]);
    if !year.is_empty() {
        req = req.query(&[("year", &year)]);
    }
    let resp = req
        .timeout(std::time::Duration::from_secs(8))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("request: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("http-{}", resp.status().as_u16()));
    }
    let v: Value = resp.json().await.map_err(|e| format!("json: {e}"))?;
    let results = v["results"].as_array().cloned().unwrap_or_default();
    if results.is_empty() {
        return Ok(None);
    }
    // year 匹配优先：movie 用 release_date，tv 用 first_air_date
    Ok(Some(
        results
            .iter()
            .find(|r| {
                !year.is_empty()
                    && [r["release_date"].as_str(), r["first_air_date"].as_str()]
                        .iter()
                        .flatten()
                        .any(|d| d.starts_with(&year))
            })
            .unwrap_or(&results[0])
            .clone(),
    ))
}

/// search/multi 命中 → 卡片人气条目（rating + popularity）
fn picked_to_pop(pick: &Value) -> TmdbPop {
    TmdbPop {
        rating: pick["vote_average"].as_f64().filter(|r| *r > 0.0),
        popularity: pick["popularity"].as_f64(),
    }
}

/// TMDB 命中对象缓存（key = name|year）。
///
/// P19 之前这是**进程内** HashMap：内核一退，热门榜下次又要重打 30 次 TMDB。
/// 现在落 `src_cache`，跨重启复用；无命中仍不缓存（片库会更新，下次该重试）。
async fn tmdb_pick(
    store: &CacheStore,
    policy: &SrcCachePolicy,
    api_key: &str,
    name: &str,
    year: &str,
) -> Result<Option<Value>, String> {
    let ck = format!("{name}|{year}");
    if let Some((body, _)) = peek_fresh(store, KIND_TMDB, &ck) {
        match serde_json::from_str::<Value>(&body) {
            Ok(v) => return Ok(Some(v)),
            Err(_) => store.src_cache_invalidate(KIND_TMDB, &ck),
        }
    }
    match tmdb_search(api_key, name, year).await {
        Ok(Some(pick)) => {
            if let Ok(s) = serde_json::to_string(&pick) {
                remember(store, policy, KIND_TMDB, &ck, &s);
            }
            Ok(Some(pick))
        }
        Ok(None) => Ok(None),
        Err(e) => {
            if policy.offline_fallback {
                if let Some((body, _)) = peek_stale(store, KIND_TMDB, &ck) {
                    if let Ok(v) = serde_json::from_str::<Value>(&body) {
                        return Ok(Some(v));
                    }
                }
            }
            Err(e)
        }
    }
}

/// 批量查人气：命中缓存的不发请求，未命中的并发（每批 12）补查。
/// 网络/解析失败按未命中处理（静默降级为纯站数排序）。
async fn enrich_hot_cards(
    store: &CacheStore,
    policy: &SrcCachePolicy,
    api_key: &str,
    cards: &mut [Card],
) {
    #[derive(Clone)]
    struct Job {
        idx: usize,
        name: String,
        year: String,
    }
    let mut jobs: Vec<Job> = Vec::new();
    // 全部交给 tmdb_pick：命中缓存时它不发请求（一次查表），命中/未命中各只记一次账，
    // 不在这里额外预查（预查会让同一张卡片贡献一次 hit + 一次 miss，把命中率搅浑）
    for (i, c) in cards.iter_mut().enumerate() {
        jobs.push(Job { idx: i, name: c.name.clone(), year: c.year.clone().unwrap_or_default() });
    }
    for chunk in jobs.chunks(IMPORT_CONCURRENCY) {
        let futs = chunk.iter().map(|j| {
            let pol = policy.clone();
            async move {
                let r = tmdb_pick(store, &pol, api_key, &j.name, &j.year).await;
                (j.idx, r)
            }
        });
        for (idx, r) in join_all(futs).await {
            let Ok(Some(pick)) = r else { continue };
            if let Some(c) = cards.get_mut(idx) {
                c.tmdb = Some(picked_to_pop(&pick));
            }
        }
    }
}

/// TMDB lookup 出参组装（search/multi 命中 → TmdbInfo）
fn picked_to_info(pick: &Value) -> TmdbInfo {
    let title = pick["title"]
        .as_str()
        .or_else(|| pick["name"].as_str())
        .map(str::to_string);
    let date = pick["release_date"]
        .as_str()
        .or_else(|| pick["first_air_date"].as_str())
        .unwrap_or("");
    TmdbInfo {
        found: true,
        reason: None,
        rating: pick["vote_average"].as_f64().filter(|r| *r > 0.0),
        votes: pick["vote_count"].as_u64(),
        title,
        year: nonempty(date).map(|d| d.chars().take(4).collect()),
        poster: pick["poster_path"]
            .as_str()
            .filter(|p| !p.is_empty())
            .map(|p| format!("https://image.tmdb.org/t/p/w500{p}")),
        overview: pick["overview"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
    }
}

/// 按 name(+year) 搜 TMDB 出 TmdbInfo（tmdb.lookup RPC 用；P19 走落盘缓存）
async fn tmdb_lookup(
    store: &CacheStore,
    policy: &SrcCachePolicy,
    key: &str,
    name: &str,
    year: &str,
) -> Result<TmdbInfo, String> {
    match tmdb_pick(store, policy, key, name, year).await? {
        Some(pick) => Ok(picked_to_info(&pick)),
        None => Ok(TmdbInfo {
            found: false,
            reason: Some("empty".into()),
            rating: None,
            votes: None,
            title: None,
            year: None,
            poster: None,
            overview: None,
        }),
    }
}
