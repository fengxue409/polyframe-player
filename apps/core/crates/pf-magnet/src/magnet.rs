//! 磁力链接归一与选片策略（纯逻辑，无网络，可单测）。
//!
//! 磁力链接在真实世界里的形态非常杂：`xt=urn:btih:` 后面可能是 40 位 hex，
//! 也可能是 32 位 base32；用户还可能直接贴一个裸 info hash，或者贴 .torrent 地址。
//! 这一层把三种输入统一成规范化的 magnet URI，其余层只处理一种形态。

use thiserror::Error;

/// 磁力链接错误（文案直接给用户看，不要堆砌内部细节）
#[derive(Debug, Error, PartialEq, Eq)]
pub enum MagnetError {
    #[error("地址为空")]
    Empty,
    #[error("看不懂这个链接：既不是磁力链接，也不是 .torrent 地址或 info hash")]
    Unrecognized,
    #[error("磁力链接缺少 xt=urn:btih: 段")]
    MissingHash,
    #[error("info hash 长度不对（应为 40 位 hex 或 32 位 base32）")]
    BadHash,
}

/// 解析后的磁力信息
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MagnetInfo {
    /// 40 位小写 hex
    pub info_hash: String,
    /// `dn` 字段（显示名，可能没有）
    pub name: Option<String>,
    /// `tr` 字段（tracker 列表，可能为空 —— 纯 DHT 也能跑）
    pub trackers: Vec<String>,
    /// 规范化后的 magnet URI（可直接喂给引擎）
    pub canonical: String,
}

/// 视频扩展名白名单（按 BT 片源的实际情况排序）
const VIDEO_EXTS: &[&str] = &[
    "mp4", "mkv", "avi", "rmvb", "wmv", "flv", "mov", "m4v", "ts", "m2ts", "webm", "mpg", "mpeg",
];

/// 明显不是正片的文件名片段（样片、预告、花絮、字幕、说明）
const JUNK_MARKERS: &[&str] = &[
    "sample", "trailer", "teaser", "预告", "花絮", "样片", "字幕", "subtitle", "readme", "说明",
];

/// 小于这个体积的「视频」基本是样片或广告（10MB）
const MIN_VIDEO_BYTES: u64 = 10 * 1024 * 1024;

/// 把各种输入归一成规范 magnet URI。
///
/// 支持：
/// - `magnet:?xt=urn:btih:...`（hex / base32 均可，参数顺序任意）
/// - 裸 40 位 hex info hash / 32 位 base32
/// - `http(s)://.../x.torrent`（透传，交给引擎下载元数据）
pub fn normalize_magnet(input: &str) -> Result<MagnetInfo, MagnetError> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err(MagnetError::Empty);
    }

    // .torrent 地址：透传（info_hash 留空，等元数据到手再填）
    if raw.starts_with("http://") || raw.starts_with("https://") {
        if raw.to_ascii_lowercase().contains(".torrent") {
            return Ok(MagnetInfo {
                info_hash: String::new(),
                name: None,
                trackers: Vec::new(),
                canonical: raw.to_string(),
            });
        }
        return Err(MagnetError::Unrecognized);
    }

    if let Some(query) = raw.strip_prefix("magnet:?") {
        return parse_magnet_query(query);
    }
    if raw.starts_with("magnet:") {
        // `magnet:xt=...` 这种缺问号的写法也见过
        return parse_magnet_query(&raw[7..]);
    }

    // 裸 hash
    if let Some(hex) = hash_to_hex(raw) {
        return Ok(MagnetInfo {
            info_hash: hex.clone(),
            name: None,
            trackers: Vec::new(),
            canonical: format!("magnet:?xt=urn:btih:{hex}"),
        });
    }

    Err(MagnetError::Unrecognized)
}

/// 解析 `magnet:?` 之后的查询串
fn parse_magnet_query(query: &str) -> Result<MagnetInfo, MagnetError> {
    let mut hash: Option<String> = None;
    let mut name: Option<String> = None;
    let mut trackers: Vec<String> = Vec::new();

    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = match pair.split_once('=') {
            Some((k, v)) => (k, v),
            None => continue,
        };
        let value = percent_decode(v);
        match k {
            "xt" => {
                // 取 btih 段；urn:btmh（v2）暂不支持
                if let Some(rest) = value
                    .strip_prefix("urn:btih:")
                    .or_else(|| value.strip_prefix("URN:BTIH:"))
                {
                    hash = hash_to_hex(rest);
                }
            }
            "dn" => {
                if !value.is_empty() {
                    name = Some(value);
                }
            }
            "tr" => {
                if !value.is_empty() && !trackers.contains(&value) {
                    trackers.push(value);
                }
            }
            _ => {}
        }
    }

    let hex = hash.ok_or_else(|| {
        if query.contains("xt=") {
            MagnetError::BadHash
        } else {
            MagnetError::MissingHash
        }
    })?;

    let mut canonical = format!("magnet:?xt=urn:btih:{hex}");
    if let Some(n) = &name {
        canonical.push_str("&dn=");
        canonical.push_str(&percent_encode(n));
    }
    for t in &trackers {
        canonical.push_str("&tr=");
        canonical.push_str(&percent_encode(t));
    }

    Ok(MagnetInfo {
        info_hash: hex,
        name,
        trackers,
        canonical,
    })
}

/// 20 字节 info hash 的两种文本形态 → 小写 hex
fn hash_to_hex(s: &str) -> Option<String> {
    let s = s.trim();
    if s.len() == 40 && s.chars().all(|c| c.is_ascii_hexdigit()) {
        return Some(s.to_ascii_lowercase());
    }
    if s.len() == 32 {
        let bytes = base32_decode_upper(s)?;
        if bytes.len() == 20 {
            return Some(bytes.iter().map(|b| format!("{b:02x}")).collect());
        }
    }
    None
}

/// RFC 4648 base32（无填充）解码；只接受 A-Z2-7
fn base32_decode_upper(s: &str) -> Option<Vec<u8>> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut out = Vec::with_capacity(s.len() * 5 / 8);
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;
    for ch in s.bytes() {
        let up = ch.to_ascii_uppercase();
        let idx = ALPHABET.iter().position(|c| *c == up)? as u32;
        buf = (buf << 5) | idx;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// 最小 percent 解码（磁力里的 dn/tr 常带 %XX 与 `+`）
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                match (hi, lo) {
                    (Some(h), Some(l)) => {
                        out.push((h * 16 + l) as u8);
                        i += 3;
                    }
                    _ => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 最小 percent 编码：只转义会破坏 query 结构的字符与所有非 ASCII 字节。
///
/// 逐字节处理（而不是逐 char），这样 UTF-8 多字节字符会被正确转义成 %E4%BD%A0 这类形式。
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'&' | b'=' | b'#' | b'?' | b'+' | b'%' | b' ' => out.push_str(&format!("%{b:02X}")),
            0x21..=0x7e => out.push(*b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// 从种子文件列表里挑正片。
///
/// 规则（按优先级）：排除样片/字幕/说明 → 只留视频扩展名 → 体积 ≥ 10MB（若没有则放宽）→ 取最大。
/// 返回文件在种子里的下标（即 `only_files` 需要的 id）。
pub fn pick_video_file(files: &[(usize, String, u64)]) -> Option<usize> {
    let is_video = |name: &str| -> bool {
        let lower = name.to_ascii_lowercase();
        let ext = lower.rsplit('.').next().unwrap_or("");
        VIDEO_EXTS.contains(&ext)
    };
    let is_junk = |name: &str| -> bool {
        let lower = name.to_ascii_lowercase();
        JUNK_MARKERS.iter().any(|m| lower.contains(m))
    };

    let candidates: Vec<&(usize, String, u64)> = files
        .iter()
        .filter(|(_, name, _)| is_video(name) && !is_junk(name))
        .collect();
    if candidates.is_empty() {
        return None;
    }

    // 优先挑体积够大的；全都太小时退回全体里最大的
    let big: Vec<&&(usize, String, u64)> = candidates
        .iter()
        .filter(|(_, _, len)| *len >= MIN_VIDEO_BYTES)
        .collect();
    let pool: Vec<&&(usize, String, u64)> = if big.is_empty() { candidates.iter().collect() } else { big };

    pool.into_iter()
        .max_by_key(|(_, _, len)| *len)
        .map(|(idx, _, _)| *idx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_hex_magnet() {
        let m = normalize_magnet(
            "magnet:?xt=urn:btih:CAB507494D02EBB1178B38F2E9D7BE299C86B862&dn=Test%20Movie&tr=udp%3A%2F%2Ftracker.example%3A80",
        )
        .unwrap();
        assert_eq!(m.info_hash, "cab507494d02ebb1178b38f2e9d7be299c86b862");
        assert_eq!(m.name.as_deref(), Some("Test Movie"));
        assert_eq!(m.trackers, vec!["udp://tracker.example:80"]);
        assert!(m.canonical.starts_with("magnet:?xt=urn:btih:cab507494d02ebb1178b38f2e9d7be299c86b862"));
        // 空格在 query 里必须转义，否则重建的 magnet 会被截断
        assert!(m.canonical.contains("dn=Test%20Movie"));
        // tracker 原样保留（':' 与 '/' 在 query 里合法，转了反而不利于某些客户端识别）
        assert!(m.canonical.contains("tr=udp://tracker.example:80"));
    }

    #[test]
    fn test_normalize_keeps_chinese_name() {
        let m = normalize_magnet(
            "magnet:?xt=urn:btih:cab507494d02ebb1178b38f2e9d7be299c86b862&dn=%E5%BA%86%E4%BD%99%E5%B9%B4",
        )
        .unwrap();
        assert_eq!(m.name.as_deref(), Some("庆余年"));
        // 重建时应按 UTF-8 逐字节转义，不能塞回裸中文（浏览器/种子端解析差异大）
        assert!(m.canonical.contains("dn=%E5%BA%86%E4%BD%99%E5%B9%B4"));
    }

    #[test]
    fn test_normalize_base32_magnet() {
        // 同一 info hash 的 base32 形态（20 字节 → 32 字符）
        let hex = "cab507494d02ebb1178b38f2e9d7be299c86b862";
        let b32 = base32_encode_hex(hex);
        let m = normalize_magnet(&format!("magnet:?xt=urn:btih:{b32}")).unwrap();
        assert_eq!(m.info_hash, hex);
    }

    #[test]
    fn test_normalize_bare_hash() {
        let hex = "cab507494d02ebb1178b38f2e9d7be299c86b862";
        let m = normalize_magnet(hex).unwrap();
        assert_eq!(m.info_hash, hex);
        assert_eq!(m.canonical, format!("magnet:?xt=urn:btih:{hex}"));
        // 大写也认
        let up = normalize_magnet(&hex.to_uppercase()).unwrap();
        assert_eq!(up.info_hash, hex);
    }

    #[test]
    fn test_normalize_torrent_url_passthrough() {
        let m = normalize_magnet("https://example.com/a/b.torrent?x=1").unwrap();
        assert_eq!(m.canonical, "https://example.com/a/b.torrent?x=1");
        assert!(m.info_hash.is_empty());
    }

    #[test]
    fn test_normalize_rejects_garbage() {
        assert_eq!(normalize_magnet("   ").unwrap_err(), MagnetError::Empty);
        assert_eq!(normalize_magnet("庆余年").unwrap_err(), MagnetError::Unrecognized);
        assert_eq!(
            normalize_magnet("magnet:?dn=x").unwrap_err(),
            MagnetError::MissingHash
        );
        assert_eq!(
            normalize_magnet("magnet:?xt=urn:btih:123").unwrap_err(),
            MagnetError::BadHash
        );
        assert_eq!(
            normalize_magnet("https://example.com/page.html").unwrap_err(),
            MagnetError::Unrecognized
        );
    }

    #[test]
    fn test_pick_video_file_prefers_largest() {
        let files = vec![
            (0, "Readme.txt".to_string(), 1024),
            (1, "movie.sample.mp4".to_string(), 30 * 1024 * 1024),
            (2, "movie.2024.1080p.mkv".to_string(), 3 * 1024 * 1024 * 1024),
            (3, "subs.ass".to_string(), 4096),
        ];
        assert_eq!(pick_video_file(&files), Some(2));
    }

    #[test]
    fn test_pick_video_file_falls_back_to_small() {
        // 全都小于 10MB 时不应返回 None
        let files = vec![
            (0, "clip.mp4".to_string(), 5 * 1024 * 1024),
            (1, "cover.jpg".to_string(), 2048),
        ];
        assert_eq!(pick_video_file(&files), Some(0));
    }

    #[test]
    fn test_pick_video_file_none_when_no_video() {
        let files = vec![(0, "a.txt".to_string(), 10), (1, "b.nfo".to_string(), 10)];
        assert_eq!(pick_video_file(&files), None);
    }

    /// 测试辅助：hex → base32（无填充）
    fn base32_encode_hex(hex: &str) -> String {
        const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        let bytes: Vec<u8> = (0..hex.len() / 2)
            .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap())
            .collect();
        let mut out = String::new();
        let mut buf: u32 = 0;
        let mut bits: u32 = 0;
        for b in bytes {
            buf = (buf << 8) | b as u32;
            bits += 8;
            while bits >= 5 {
                bits -= 5;
                out.push(ALPHABET[((buf >> bits) & 0x1f) as usize] as char);
            }
        }
        if bits > 0 {
            out.push(ALPHABET[((buf << (5 - bits)) & 0x1f) as usize] as char);
        }
        out
    }
}
