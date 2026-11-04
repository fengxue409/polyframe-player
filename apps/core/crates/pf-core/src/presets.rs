//! 出厂视频源预设库（P8）
//!
//! 数据来源：公开社区流传的采集站接口清单（mac-cms 汇总页、MoonTV/LunaTV 公共配置等），
//! 已在本机逐个实测两道门槛 —— `?ac=list&pg=1` 返回 JSON 且 `?ac=detail&wd=` 真实搜得到片子
//! 并带 m3u8 播放地址；仅保留非成人向站点。域名随时可能失效，因此：
//!  - 新装用户：`ensure_builtin_sources` 按此表播种；
//!  - 老用户：『发现页 → 源站 → 同步预设库』补齐缺失项（已存在的同 API 不重复、不覆盖用户改名）。
//!
//! 维护约定：只增删「实测可用」的行；`PRESET_VERSION` 随表变化递增。
//! 已知剔除：飘零资源（p2100.net，curl 可用但 rustls 握手被拒）、卧龙/天涯/索尼
//! （域名出售 / 禁搜索 / CF 拦截）、豆瓣与茅台（API 禁关键词搜索）。

/// 预设库版本（表内容变化时 +1，便于前端提示「有新版预设」）
pub const PRESET_VERSION: u32 = 2;

/// (显示名, MacCMS V10 采集接口)
///
/// 排序按实测搜索命中量与延迟综合，靠前更适合作为主力源。
pub const PRESETS: &[(&str, &str)] = &[
    ("非凡资源", "https://cj.ffzyapi.com/api.php/provide/vod"),
    ("暴风资源", "https://bfzyapi.com/api.php/provide/vod"),
    ("极速资源", "https://jszyapi.com/api.php/provide/vod"),
    ("光速资源", "https://api.guangsuapi.com/api.php/provide/vod"),
    ("红牛资源", "https://www.hongniuzy2.com/api.php/provide/vod"),
    ("豪华资源", "https://hhzyapi.com/api.php/provide/vod"),
    ("无尽资源", "https://api.wujinapi.com/api.php/provide/vod"),
    ("速播资源", "https://subocaiji.com/api.php/provide/vod"),
    ("金鹰点播", "https://jyzyapi.com/provide/vod/from/jinyingyun/at/json"),
    ("电影天堂资源", "http://caiji.dyttzyapi.com/api.php/provide/vod"),
    ("最大资源", "https://api.zuidapi.com/api.php/provide/vod"),
    ("量子资源", "http://cj.lziapi.com/api.php/provide/vod"),
    ("魔都资源", "https://caiji.moduapi.cc/api.php/provide/vod"),
    ("360资源", "https://360zy.com/api.php/provide/vod"),
    ("U酷影视", "https://api.ukuapi88.com/api.php/provide/vod"),
    ("百度资源", "https://api.apibdzy.com/api.php/provide/vod"),
    ("爱奇艺资源", "https://iqiyizyapi.com/api.php/provide/vod"),
    ("猫眼资源", "https://api.maoyanapi.top/api.php/provide/vod"),
];
