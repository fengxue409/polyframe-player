//! CMS 采集站（苹果CMS V10）API 解析（P7）
//!
//! 仅做纯解析与 URL 构造（无网络，全部可单测）：
//! - `parse_vod_list`：ac=list / ac=detail 响应 → `CmsVodItem` 列表（serde 全字段
//!   default + id 弹性解析，站点实现参差缺字段不能炸）
//! - `parse_play_groups`：`vod_play_from` / `vod_play_url` → 剧集分组
//!   （`$$$` 分组、组内 `#` 分集、`名称$URL`，$ 按首个切分容忍 URL 含 $）
//! - `normalize_name` / `aggregate_key`：跨站搜索结果聚合去重键
//! - `search_url` / `detail_url` / `list_url`：接口 URL 构造（wd 表单编码）

use serde::{Deserialize, Serialize};

/// CMS 响应外层（字段全部 default 且弹性类型：部分站把 page/total/code 回成字符串）
#[derive(Debug, Clone, Default, Deserialize)]
pub struct CmsResponse {
    #[serde(default, deserialize_with = "de_flex_i64")]
    pub code: i64,
    #[serde(default, deserialize_with = "de_flex_u32")]
    pub page: u32,
    #[serde(default, deserialize_with = "de_flex_u32")]
    pub pagecount: u32,
    #[serde(default, deserialize_with = "de_flex_u32")]
    pub total: u32,
    #[serde(default, deserialize_with = "de_flex_vec")]
    pub list: Vec<CmsVodItem>,
}

/// CMS 条目（maccms vod 字段子集；全 default 容错）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CmsVodItem {
    /// 站内 id（数字或字符串弹性解析，统一转字符串）
    #[serde(default, deserialize_with = "de_flex_id")]
    pub vod_id: String,
    #[serde(default)]
    pub vod_name: String,
    #[serde(default)]
    pub type_name: String,
    /// 清晰度/更新备注，如「HD中字」「更新至08集」
    #[serde(default)]
    pub vod_remarks: String,
    #[serde(default)]
    pub vod_pic: String,
    #[serde(default)]
    pub vod_year: String,
    #[serde(default)]
    pub vod_area: String,
    /// 豆瓣评分（各站覆盖极不均衡，`0` / `0.0` 一律视为未评分）
    #[serde(default, deserialize_with = "de_flex_id")]
    pub vod_douban_score: String,
    /// 站内用户评分（苹果CMS 自带的 10 分制打分）
    #[serde(default, deserialize_with = "de_flex_id")]
    pub vod_score: String,
    /// 站内播放量（数字或字符串都有）
    #[serde(default, deserialize_with = "de_flex_id")]
    pub vod_hits: String,
    #[serde(default)]
    pub vod_lang: String,
    #[serde(default)]
    pub vod_actor: String,
    #[serde(default)]
    pub vod_director: String,
    /// 简介（常带 HTML 标签，原样保留由前端决定展示方式）
    #[serde(default)]
    pub vod_content: String,
    /// 站内更新时间，如「2024-05-01 12:00:00」
    #[serde(default)]
    pub vod_time: String,
    #[serde(default)]
    pub vod_play_from: String,
    #[serde(default)]
    pub vod_play_url: String,
}

/// 弹性 id：数字 / 字符串 / 数字字符串统一为字符串，异常时空串
fn de_flex_id<'de, D>(d: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = serde_json::Value::deserialize(d)?;
    Ok(match v {
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => s,
        _ => String::new(),
    })
}

/// 弹性 u32：数字 / 数字字符串（不少采集站把 page/total 回成 `"1"`），异常归 0
fn de_flex_u32<'de, D>(d: D) -> Result<u32, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = serde_json::Value::deserialize(d)?;
    Ok(match v {
        serde_json::Value::Number(n) => n.as_u64().unwrap_or(0).min(u32::MAX as u64) as u32,
        serde_json::Value::String(s) => s.trim().parse::<u32>().unwrap_or(0),
        _ => 0,
    })
}

/// 弹性 i64：数字 / 数字字符串，异常归 0
fn de_flex_i64<'de, D>(d: D) -> Result<i64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = serde_json::Value::deserialize(d)?;
    Ok(match v {
        serde_json::Value::Number(n) => n.as_i64().unwrap_or(0),
        serde_json::Value::String(s) => s.trim().parse::<i64>().unwrap_or(0),
        _ => 0,
    })
}

/// 弹性 list：数组取可解析条目（坏条目跳过），null / 非数组 → 空
fn de_flex_vec<'de, D>(d: D) -> Result<Vec<CmsVodItem>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v = serde_json::Value::deserialize(d)?;
    Ok(match v {
        serde_json::Value::Array(arr) => {
            arr.into_iter().filter_map(|x| serde_json::from_value::<CmsVodItem>(x).ok()).collect()
        }
        _ => Vec::new(),
    })
}

/// 解析 ac=list / ac=detail 响应（顶层不是对象或缺 list 视为失败）
pub fn parse_vod_list(json: &str) -> Result<Vec<CmsVodItem>, String> {
    Ok(parse_vod_page(json)?.items)
}

/// 一页采集结果（P43）：除条目外**保留分页元信息**，供翻页终止判断使用。
///
/// 旧实现只返回 `list`，把 `page` / `pagecount` / `total` 丢了 —— 于是调用方
/// 完全没有「这站还有没有下一页」的依据，只能拿「本页聚合出多少条」猜。
#[derive(Debug, Clone, Default)]
pub struct VodPage {
    pub items: Vec<CmsVodItem>,
    /// 站内回显的当前页（部分站不返回，为 0）
    pub page: u32,
    /// 站内总页数（部分站不返回，为 0）
    pub pagecount: u32,
    /// 站内总条目数（部分站不返回，为 0）
    pub total: u32,
}

impl VodPage {
    /// 该站这一页之后还有没有内容。
    /// 顺序：先看条目空不空（最可靠，与 pagecount 是否可信无关），再看 pagecount。
    /// pagecount=0 表示站没给这个字段 —— 此时**不能**判「已到底」，交给调用方用
    /// 「本页是否满额」兜底。
    pub fn has_next(&self, requested_pg: u32) -> Option<bool> {
        if self.items.is_empty() {
            return Some(false);
        }
        if self.pagecount > 0 {
            // 有的站 pagecount 与 pagesize 不联动（忽略 pagesize 时按 20/页算），
            // 但 page >= pagecount 仍是对的终止条件。
            let cur = if self.page > 0 { self.page } else { requested_pg };
            return Some(cur < self.pagecount);
        }
        None
    }
}

/// 解析含分页元信息的响应
pub fn parse_vod_page(json: &str) -> Result<VodPage, String> {
    let resp: CmsResponse =
        serde_json::from_str(json).map_err(|e| format!("cms 响应解析失败: {e}"))?;
    Ok(VodPage {
        items: resp.list,
        page: resp.page,
        pagecount: resp.pagecount,
        total: resp.total,
    })
}

/// 剧集分组
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CmsPlayGroup {
    /// 播放源名（vod_play_from 组名，如 m3u8 / wjm3u8；缺失时「播放」）
    pub from: String,
    /// (集名, URL)
    pub episodes: Vec<(String, String)>,
}

/// vod_play_from / vod_play_url → 分组剧集
///
/// 规则（苹果CMS 约定）：`$$$` 分组且两组数量一一对应；组内 `#` 分集；
/// 每集 `名称$URL`（按首个 $ 切分）；空集跳过；from 缺失时用「播放」兜底。
/// 非媒体直链（HTML 分享页）的集直接剔除：如非凡资源 feifan 组的
/// `https://…/share/<hash>`（返回网页，拿去起播必报错；同片的
/// ffm3u8 等直链组不受影响）。
pub fn parse_play_groups(from: &str, urls: &str) -> Vec<CmsPlayGroup> {
    if urls.trim().is_empty() {
        return Vec::new();
    }
    let from_parts: Vec<&str> = if from.trim().is_empty() {
        vec!["播放"]
    } else {
        from.split("$$$").collect()
    };
    let url_parts: Vec<&str> = urls.split("$$$").collect();

    let mut out = Vec::new();
    let group_count = url_parts.len().max(from_parts.len());
    for i in 0..group_count {
        let from_name = from_parts
            .get(i)
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .unwrap_or("播放")
            .to_string();
        let mut episodes = Vec::new();
        if let Some(part) = url_parts.get(i) {
            for item in part.split('#') {
                let item = item.trim();
                if item.is_empty() {
                    continue;
                }
                let (name, url) = match item.split_once('$') {
                    Some((n, u)) => (n.trim().to_string(), u.trim().to_string()),
                    // 无 $ 的裸 URL：整段当 URL，名字用序号
                    None => (String::new(), item.to_string()),
                };
                if url.is_empty() {
                    continue;
                }
                if is_non_media_page(&url) {
                    continue;
                }
                let name = if name.is_empty() {
                    format!("第{}集", episodes.len() + 1)
                } else {
                    name
                };
                episodes.push((name, url));
            }
        }
        if !episodes.is_empty() {
            out.push(CmsPlayGroup { from: from_name, episodes });
        }
    }
    out
}

/// 明显不是媒体直链的 URL（HTML 分享页等）：
/// 路径含 `/share/`，或以 .html/.htm/.shtml 结尾（query/hash 不参与判断）。
/// 只拦确定性网页链接，无扩展名直链一律保留（部分站直链无后缀但可播）。
fn is_non_media_page(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let path = lower.split(['?', '#']).next().unwrap_or(&lower);
    path.contains("/share/")
        || path.ends_with(".html")
        || path.ends_with(".htm")
        || path.ends_with(".shtml")
}

/// 片名规范化（聚合去重用）：去首尾 + 去全部空白 + 小写（中文不受影响）。
/// 「复仇者 联盟」「复仇者联盟」「复仇者联盟 4K」→ 同键前缀（4K 无年份兜底）
pub fn normalize_name(name: &str) -> String {
    name.chars()
        .filter(|c| !c.is_whitespace() && *c != '\u{3000}')
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// 聚合键：`normalize(name)|year`（year 空则仅名称）
pub fn aggregate_key(name: &str, year: &str) -> String {
    format!("{}|{}", normalize_name(name), year.trim())
}

/// 在 api base 上追加查询参数（容忍 base 已带 ?）
fn with_query(api: &str, query: &str) -> String {
    let sep = if api.contains('?') { '&' } else { '?' };
    format!("{api}{sep}{query}")
}

/// wd 表单编码
fn enc(v: &str) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .append_pair("wd", v)
        .finish()
}

/// 每页请求条数（P43）：苹果CMS v10 支持 `pagesize`，实测 11/15 个预设站生效，
/// 剩下 4 个忽略但它也不报错（仍回默认 20 条）。默认 20/页是「结果偏少」的
/// 直接原因之一 —— 50 条/页把单次覆盖提高 2.5 倍，请求数不变。
pub const PAGE_SIZE: u32 = 50;

/// 搜索 URL：优先 ac=detail（一步拿全 play_url），空结果时调用方回退 ac=videolist
pub fn search_url(api: &str, wd: &str) -> String {
    with_query(api, &format!("ac=detail&{}&pagesize={PAGE_SIZE}", enc(wd)))
}

/// 搜索回退 URL（部分站不支持 ac=detail 搜索）
pub fn search_url_fallback(api: &str, wd: &str) -> String {
    with_query(api, &format!("ac=videolist&{}&pagesize={PAGE_SIZE}", enc(wd)))
}

/// 搜索翻页 URL（P43）。pg<=1 时与 `search_url` 完全一致：少数站对显式 `pg=1`
/// 会返回空列表，第一页沿用旧地址最稳。
pub fn search_url_at(api: &str, wd: &str, pg: u32) -> String {
    if pg <= 1 {
        return search_url(api, wd);
    }
    with_query(api, &format!("ac=detail&{}&pg={pg}&pagesize={PAGE_SIZE}", enc(wd)))
}

/// 详情 URL（按站内 id）
pub fn detail_url(api: &str, ids: &str) -> String {
    with_query(api, &format!("ac=detail&ids={}", ids))
}

/// 列表探测 URL（测速用最小请求）
pub fn list_url(api: &str) -> String {
    with_query(api, "ac=list&pg=1")
}

/// 分类/更新流翻页 URL（P9 吸收 GYING）：ac=detail 翻页；
/// hours = Some(h) 走「最近 h 小时更新」流（苹果CMS h 参数），None 为全量翻页。
/// 分类/年份筛选由调用方按 type_name / vod_year 客户端过滤（t= 站间类型 ID 不互通）。
pub fn page_url(api: &str, pg: u32, hours: Option<u32>) -> String {
    match hours {
        Some(h) => with_query(api, &format!("ac=detail&h={h}&pg={pg}&pagesize={PAGE_SIZE}")),
        None => with_query(api, &format!("ac=detail&pg={pg}&pagesize={PAGE_SIZE}")),
    }
}

/// 大类匹配：站间 type_name 命名参差（「科幻片」「国产剧」「日韩动漫」「大陆综艺」…），
/// 按关键词从具体到宽泛匹配；返回 None 表示无该大类。
/// 顺序敏感：「剧」在「片」前（避免「纪录片」误入剧集），「动漫」最先。
pub fn category_matches(type_name: &str, category: &str) -> bool {
    let t = type_name.trim();
    match category {
        "综艺" => t.contains("综艺"),
        "动漫" => t.contains("动漫"),
        "剧集" => t.contains("剧"),
        "电影" => t.contains("片"),
        _ => false,
    }
}

/// 地区匹配：站间 vod_area 命名参差（「中国大陆」「内地」「大陆」「美国」「美剧」…），
/// 按候选关键词任一包含即命中（如「大陆」同时命中「中国大陆 / 内地 / 大陆」）。
pub fn area_matches(vod_area: &str, area: &str) -> bool {
    let a = vod_area.trim();
    if a.is_empty() || area.trim().is_empty() {
        return false;
    }
    area.split('|').any(|kw| {
        let kw = kw.trim();
        !kw.is_empty() && a.contains(kw)
    })
}

/// 评分解读：`"8.9"` / `8.9` / `"0.0"` 都接，只认 (0, 10] 区间；0 表示「没打分」而非「0 分」
pub fn parse_score(raw: &str) -> Option<f64> {
    let v: f64 = raw.trim().parse().ok()?;
    (v > 0.0 && v <= 10.0).then_some(v)
}

/// 播放量解读：`"12345"` / `12345`，「1.2万」这类文案解析不出就归 0（不猜单位）
pub fn parse_hits(raw: &str) -> u64 {
    raw.trim().parse::<u64>().unwrap_or(0)
}

/// 含糊地区（站方不知道就不填，常见「其它」）——聚合时让位给具体地区
pub fn is_vague_area(raw: &str) -> bool {
    matches!(raw.trim(), "" | "其它" | "其他" | "未知" | "不详" | "暂无")
}

/// 地区归一：把「中国大陆 / 内地 / 大陆」「美剧 / 美国 / 美」收敛成同一个展示名。
///
/// 只用于**展示与本地聚合**；服务端筛选仍走 `area_matches` 的关键词包含，
/// 因为筛选要接受用户给的任意别名。顺序有意义：「中国香港」必须先于「中国」匹配。
pub fn canon_area(raw: &str) -> String {
    let a = raw.trim();
    if a.is_empty() {
        return String::new();
    }
    const MAP: &[(&str, &[&str])] = &[
        ("香港", &["香港"]),
        ("澳门", &["澳门"]),
        ("台湾", &["台湾", "台剧", "台"]),
        ("大陆", &["中国大陆", "内地", "大陆", "中国"]),
        ("美国", &["美国", "美剧"]),
        ("韩国", &["韩国", "韩剧"]),
        ("日本", &["日本", "日剧"]),
        ("英国", &["英国", "英剧"]),
        ("法国", &["法国"]),
        ("泰国", &["泰国", "泰剧"]),
        ("印度", &["印度"]),
    ];
    for (canon, aliases) in MAP {
        if aliases.iter().any(|k| a == *k || a.contains(k)) {
            return (*canon).to_string();
        }
    }
    a.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 实测发现：不少采集站把 code/page/total 回成字符串，list 里还夹坏条目。
    /// P8 起统一弹性解析，避免整站被判失败。
    #[test]
    fn test_parse_response_lenient_types() {
        let json = r#"{"code":"1","page":"1","pagecount":"3","total":"42",
            "list":[{"vod_id":"9","vod_name":"字符串数字站"}, "坏条目", {"vod_id":10,"vod_name":"正常"}]}"#;
        let items = parse_vod_list(json).unwrap();
        assert_eq!(items.len(), 2, "{items:?}");
        assert_eq!(items[0].vod_id, "9");
        assert_eq!(items[1].vod_id, "10");
        assert_eq!(items[1].vod_name, "正常");
        // list 为 null / 非数组 → 空列表而非报错
        assert!(parse_vod_list(r#"{"code":1,"list":null}"#).unwrap().is_empty());
        assert!(parse_vod_list(r#"{"code":1,"list":""}"#).unwrap().is_empty());
        // 顶层不是对象 → 仍视为解析失败
        assert!(parse_vod_list("<html>").is_err());
    }

    #[test]
    fn test_parse_vod_list_detail_shape() {
        let json = r#"{
            "code": 1, "page": 1, "pagecount": 3, "total": 42,
            "list": [
                {
                    "vod_id": 123,
                    "vod_name": "流浪地球",
                    "type_name": "科幻片",
                    "vod_remarks": "HD中字",
                    "vod_pic": "https://img.example/p1.jpg",
                    "vod_year": "2023",
                    "vod_time": "2024-01-02 03:04:05",
                    "vod_play_from": "m3u8$$$xigua",
                    "vod_play_url": "第01集$https://a/1.m3u8#第02集$https://a/2.m3u8$$$第01集$https://b/1.mp4"
                },
                { "vod_id": "abc", "vod_name": "裸条目" }
            ]
        }"#;
        let items = parse_vod_list(json).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].vod_id, "123");
        assert_eq!(items[0].vod_name, "流浪地球");
        assert_eq!(items[0].vod_year, "2023");
        let groups = parse_play_groups(&items[0].vod_play_from, &items[0].vod_play_url);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].from, "m3u8");
        assert_eq!(groups[0].episodes.len(), 2);
        assert_eq!(groups[0].episodes[0].0, "第01集");
        assert_eq!(groups[0].episodes[0].1, "https://a/1.m3u8");
        assert_eq!(groups[1].from, "xigua");
        assert_eq!(groups[1].episodes.len(), 1);
        // 缺字段条目不炸
        assert_eq!(items[1].vod_id, "abc");
        assert_eq!(items[1].vod_year, "");
    }

    #[test]
    fn test_parse_play_groups_edge_cases() {
        // 空 urls → 空
        assert!(parse_play_groups("", "").is_empty());
        // from 缺失 → 「播放」兜底
        let g = parse_play_groups("", "HD$https://a/1.m3u8");
        assert_eq!(g[0].from, "播放");
        assert_eq!(g[0].episodes[0], ("HD".into(), "https://a/1.m3u8".into()));
        // 裸 URL 无 $ → 序号命名
        let g = parse_play_groups("m3u8", "https://a/1.mp4#https://a/2.mp4");
        assert_eq!(g[0].episodes[0].0, "第1集");
        assert_eq!(g[0].episodes[1].0, "第2集");
        // 空集与空 url 跳过；$ 后为空跳过
        let g = parse_play_groups("m3u8", "#第1集$#第2集$https://a/2.m3u8");
        assert_eq!(g[0].episodes.len(), 1);
        // URL 含 $ 按首个切分
        let g = parse_play_groups("m3u8", "第1集$https://a/1$m3u8");
        assert_eq!(g[0].episodes[0].1, "https://a/1$m3u8");
    }

    #[test]
    fn test_parse_play_groups_filters_share_pages() {
        // 非凡资源真实结构：feifan 组是 share 分享页（HTML），ffm3u8 组是直链
        let g = parse_play_groups(
            "feifan$$$ffm3u8",
            "第01集$https://super.ffzy-online6.com/share/344f7ef6#第02集$https://super.ffzy-online6.com/share/4d7061dc\
             $$$第01集$https://super.ffzy-online6.com/20261002/42358_344f7ef6/index.m3u8",
        );
        // share 组被整组剔除
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].from, "ffm3u8");
        assert_eq!(g[0].episodes.len(), 1);
        // .html 结尾同样剔除
        let g = parse_play_groups("播放", "第1集$https://a/1.html#第2集$https://a/2.m3u8");
        assert_eq!(g[0].episodes.len(), 1);
        assert_eq!(g[0].episodes[0].1, "https://a/2.m3u8");
        // query 带参数不影响判断；无扩展名直链保留
        let g = parse_play_groups(
            "播放",
            "第1集$https://a/play?u=https://x/share/1#第2集$https://a/noext",
        );
        assert_eq!(g[0].episodes.len(), 2);
    }

    #[test]
    fn test_aggregate_key() {
        assert_eq!(normalize_name(" 复仇者 联盟 "), normalize_name("复仇者联盟"));
        assert_eq!(normalize_name("Avengers"), normalize_name("avengers"));
        assert_eq!(
            aggregate_key("流浪地球", "2023"),
            format!("{}|2023", normalize_name("流浪地球"))
        );
        assert_ne!(aggregate_key("流浪地球", "2023"), aggregate_key("流浪地球", "2019"));
    }

    #[test]
    fn test_urls() {
        assert_eq!(
            search_url("https://a.com/api.php/provide/vod", "流浪 地球"),
            "https://a.com/api.php/provide/vod?ac=detail&wd=%E6%B5%81%E6%B5%AA+%E5%9C%B0%E7%90%83&pagesize=50"
        );
        assert_eq!(list_url("https://a.com/v?x=1"), "https://a.com/v?x=1&ac=list&pg=1");
        assert_eq!(detail_url("https://a.com/v", "1,2"), "https://a.com/v?ac=detail&ids=1,2");
        assert_eq!(
            search_url_fallback("https://a.com/v", "测试"),
            "https://a.com/v?ac=videolist&wd=%E6%B5%8B%E8%AF%95&pagesize=50"
        );
        // 第一页沿用不显式带 pg 的地址；后续页才追加 pg
        assert_eq!(
            search_url_at("https://a.com/v", "测试", 1),
            "https://a.com/v?ac=detail&wd=%E6%B5%8B%E8%AF%95&pagesize=50"
        );
        assert_eq!(
            search_url_at("https://a.com/v", "测试", 3),
            "https://a.com/v?ac=detail&wd=%E6%B5%8B%E8%AF%95&pg=3&pagesize=50"
        );
    }

    #[test]
    fn test_page_url() {
        assert_eq!(
            page_url("https://a.com/v", 1, None),
            "https://a.com/v?ac=detail&pg=1&pagesize=50"
        );
        assert_eq!(
            page_url("https://a.com/v", 3, Some(24)),
            "https://a.com/v?ac=detail&h=24&pg=3&pagesize=50"
        );
        assert_eq!(
            page_url("https://a.com/v?x=1", 2, None),
            "https://a.com/v?x=1&ac=detail&pg=2&pagesize=50"
        );
    }

    /// P43：分页元信息必须能被调用方读到 —— 终止条件全押在它身上
    #[test]
    fn test_parse_vod_page_meta() {
        let json = r#"{"code":1,"page":"2","pagecount":"7","total":330,
            "list":[{"vod_id":1,"vod_name":"甲"},{"vod_id":2,"vod_name":"乙"}]}"#;
        let p = parse_vod_page(json).unwrap();
        assert_eq!((p.page, p.pagecount, p.total), (2, 7, 330));
        assert_eq!(p.items.len(), 2);
        assert_eq!(p.has_next(2), Some(true));

        // 最后一页：page == pagecount
        let last = r#"{"code":1,"page":7,"pagecount":7,"list":[{"vod_name":"末页"}]}"#;
        assert_eq!(parse_vod_page(last).unwrap().has_next(7), Some(false));

        // 空列表一律视为到底（哪怕站把 pagecount 报错成 9999）
        let empty = r#"{"code":1,"page":1,"pagecount":9999,"list":[]}"#;
        assert_eq!(parse_vod_page(empty).unwrap().has_next(1), Some(false));

        // 站不给 pagecount → None，交给调用方按「本页是否满额」兜底
        let no_pc = r#"{"code":1,"list":[{"vod_name":"甲"}]}"#;
        assert_eq!(parse_vod_page(no_pc).unwrap().has_next(1), None);

        // 站不回显 page（page=0）时用请求页码判断
        let no_page = r#"{"code":1,"pagecount":3,"list":[{"vod_name":"甲"}]}"#;
        assert_eq!(parse_vod_page(no_page).unwrap().has_next(3), Some(false));
        assert_eq!(parse_vod_page(no_page).unwrap().has_next(2), Some(true));
    }

    #[test]
    fn test_area_matches() {
        // 多候选关键词：任一包含即命中
        assert!(area_matches("中国大陆", "大陆"));
        assert!(area_matches("内地", "大陆|内地"));
        assert!(area_matches("韩国", "韩国"));
        assert!(area_matches("美国 / 加拿大", "美国"));
        // 不误伤
        assert!(!area_matches("美国", "大陆"));
        assert!(!area_matches("", "大陆"));
        assert!(!area_matches("中国大陆", ""));
        // 空关键词候选跳过
        assert!(!area_matches("中国大陆", "|"));
    }

    #[test]
    fn test_category_matches() {
        // 电影：xx片（含纪录片）
        assert!(category_matches("科幻片", "电影"));
        assert!(category_matches("动作片", "电影"));
        // 剧集：剧（国产剧/韩剧/美剧/香港剧…）
        assert!(category_matches("国产剧", "剧集"));
        assert!(category_matches("韩国剧", "剧集"));
        // 动漫 / 综艺
        assert!(category_matches("日韩动漫", "动漫"));
        assert!(category_matches("大陆综艺", "综艺"));
        // 大类互不误伤：纪录片不入剧集，动漫片两者皆可（动漫优先匹配）
        assert!(!category_matches("纪录片", "剧集"));
        assert!(!category_matches("科幻片", "剧集"));
        assert!(!category_matches("科幻片", "动漫"));
        assert!(!category_matches("大陆综艺", "电影"));
        // 未知大类一律不匹配
        assert!(!category_matches("科幻片", "纪录片"));
        assert!(!category_matches("", "电影"));
    }

    /// 实测：评分字段三种形态并存（"9.2" / 9.2 / "0.0"），0 表示没打分，不能当「0 分」
    /// 参与排序，否则一整页无评分的片子会把有评分的挤掉。
    #[test]
    fn test_parse_score_and_hits() {
        assert_eq!(parse_score("9.2"), Some(9.2));
        assert_eq!(parse_score(" 8 "), Some(8.0));
        assert_eq!(parse_score("0.0"), None);
        assert_eq!(parse_score("0"), None);
        assert_eq!(parse_score(""), None);
        // 越界（有站把播放量填进评分位）按无效处理
        assert_eq!(parse_score("2534"), None);
        assert_eq!(parse_score("-1"), None);

        assert_eq!(parse_hits("2534"), 2534);
        assert_eq!(parse_hits(" 10395 "), 10395);
        assert_eq!(parse_hits("1.2万"), 0);
        assert_eq!(parse_hits(""), 0);
    }

    #[test]
    fn test_canon_area() {
        // 站间别名收敛到同一个展示名
        assert_eq!(canon_area("中国大陆"), "大陆");
        assert_eq!(canon_area("内地"), "大陆");
        assert_eq!(canon_area("美剧"), "美国");
        assert_eq!(canon_area("美国"), "美国");
        // 「中国香港」不能被「中国」抢先吃掉
        assert_eq!(canon_area("中国香港"), "香港");
        assert_eq!(canon_area("台湾"), "台湾");
        // 认不出的原样保留，不硬猜
        assert_eq!(canon_area("欧美"), "欧美");
        assert_eq!(canon_area(""), "");
        // 含糊值判定
        assert!(is_vague_area("其它"));
        assert!(is_vague_area("其他"));
        assert!(is_vague_area(""));
        assert!(!is_vague_area("日本"));
    }
}
