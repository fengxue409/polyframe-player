//! 分享链接解析：把各家网盘的分享 URL 归一成 [`ShareRef`]（纯逻辑，无网络）

use serde::{Deserialize, Serialize};

use crate::ProviderKind;

/// 归一后的分享引用
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShareRef {
    pub provider: ProviderKind,
    /// 网盘侧分享标识（百度 surl / 阿里 share_id / OneDrive 原始 URL）
    pub share_id: String,
    /// 提取码（可空）
    pub pwd: Option<String>,
    /// 用户录入的原始链接
    pub raw: String,
}

/// 解析分享链接；不认识的形态返回错误（含可读提示）
pub fn parse_share(raw: &str) -> Result<ShareRef, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("分享链接为空".into());
    }
    // 允许用户直接粘贴「链接 提取码」「链接?pwd=xxxx」等形态
    let (url_part, inline_pwd) = split_inline_pwd(raw);
    let lower = url_part.to_ascii_lowercase();

    // ---------- 百度网盘 ----------
    if lower.contains("pan.baidu.com") || lower.contains("yun.baidu.com") {
        let share_id = baidu_share_id(&url_part).ok_or_else(|| {
            "未识别百度分享 ID（支持 pan.baidu.com/s/xxxx 或 ?surl=xxxx 形态）".to_string()
        })?;
        let pwd = query_param(&url_part, "pwd")
            .or_else(|| query_param(&url_part, "password"))
            .or(inline_pwd);
        return Ok(ShareRef { provider: ProviderKind::Baidu, share_id, pwd, raw: raw.to_string() });
    }

    // ---------- 阿里云盘 / 阿里云盘（alipan 新域名） ----------
    if lower.contains("aliyundrive.com") || lower.contains("alipan.com") {
        let share_id = path_after(&url_part, "/s/").ok_or_else(|| {
            "未识别阿里云盘分享 ID（支持 aliyundrive.com/s/xxxx 或 alipan.com/s/xxxx）".to_string()
        })?;
        let pwd = query_param(&url_part, "pwd").or(inline_pwd);
        return Ok(ShareRef { provider: ProviderKind::Aliyun, share_id, pwd, raw: raw.to_string() });
    }

    // ---------- OneDrive / SharePoint（Graph shares API 直接吃完整 URL） ----------
    if lower.contains("1drv.ms")
        || lower.contains("onedrive.live.com")
        || lower.contains("sharepoint.com")
        || lower.contains("1drv.com")
    {
        return Ok(ShareRef {
            provider: ProviderKind::OneDrive,
            share_id: encode_share_url(&url_part),
            pwd: None,
            raw: raw.to_string(),
        });
    }

    Err("暂不支持该分享链接（支持：百度网盘 / 阿里云盘 / OneDrive）".into())
}

/// OneDrive Graph shares API 的 share id 形态：`u!` + base64url(URL)
pub fn encode_share_url(url: &str) -> String {
    format!("u!{}", base64url(url.as_bytes()))
}

/// 链接 + 提取码混排拆分：「链接 提取码: abcd」「链接（提取码：abcd）」等
fn split_inline_pwd(raw: &str) -> (String, Option<String>) {
    // 先切掉中文/英文提示语，只保留首个 URL token
    let mut url_end = raw.len();
    for (i, ch) in raw.char_indices() {
        if ch.is_whitespace() || ch == '，' || ch == ',' || ch == '（' || ch == '(' {
            url_end = i;
            break;
        }
    }
    let url = raw[..url_end].to_string();
    let rest = &raw[url_end..];
    // 提取码：4 位字母数字（百度）/ 阿里 4 位
    let pwd = rest
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| s.len() == 4 && s.chars().all(|c| c.is_ascii_alphanumeric()))
        .last()
        .map(|s| s.to_string());
    (url, pwd)
}

fn baidu_share_id(url: &str) -> Option<String> {
    if let Some(id) = path_after(url, "/s/") {
        // /s/1AbCdEf 形态（可能带尾部 query 已被 split 掉）
        let id = id.split(['?', '#', '/']).next().unwrap_or("").to_string();
        if !id.is_empty() {
            return Some(id);
        }
    }
    if let Some(surl) = query_param(url, "surl") {
        // ?surl=abcd → 补上百度 1 前缀
        return Some(if surl.starts_with('1') { surl } else { format!("1{surl}") });
    }
    None
}

/// 取 path 中 marker 之后到下一个 `/` 的片段
fn path_after(url: &str, marker: &str) -> Option<String> {
    let idx = url.find(marker)? + marker.len();
    let rest = &url[idx..];
    let seg = rest.split(['?', '#', '/']).next().unwrap_or("");
    if seg.is_empty() {
        None
    } else {
        Some(seg.to_string())
    }
}

fn query_param(url: &str, key: &str) -> Option<String> {
    let q = url.split_once('?')?.1.split('#').next().unwrap_or("");
    q.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        if k.eq_ignore_ascii_case(key) && !v.is_empty() {
            Some(v.to_string())
        } else {
            None
        }
    })
}

/// 标准 base64url（无填充）：OneDrive 分享链接编码
pub fn base64url(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(input.len() * 4 / 3 + 4);
    for chunk in input.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(T[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(T[n as usize & 63] as char);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_baidu_share() {
        let s = parse_share("https://pan.baidu.com/s/1AbCdEfGh?pwd=xy12").unwrap();
        assert_eq!(s.provider, ProviderKind::Baidu);
        assert_eq!(s.share_id, "1AbCdEfGh");
        assert_eq!(s.pwd.as_deref(), Some("xy12"));
        // 混排「链接 提取码: abcd」
        let s2 = parse_share("https://pan.baidu.com/s/1AbCdEfGh 提取码: k9m2").unwrap();
        assert_eq!(s2.pwd.as_deref(), Some("k9m2"));
        // surl 形态补 1 前缀
        let s3 = parse_share("https://pan.baidu.com/share/init?surl=AbCdEf").unwrap();
        assert_eq!(s3.share_id, "1AbCdEf");
    }

    #[test]
    fn parse_aliyun_share() {
        let s = parse_share("https://www.alipan.com/s/abcdEFGH123").unwrap();
        assert_eq!(s.provider, ProviderKind::Aliyun);
        assert_eq!(s.share_id, "abcdEFGH123");
        let s2 = parse_share("https://www.aliyundrive.com/s/xyz987?pwd=4f2a").unwrap();
        assert_eq!(s2.provider, ProviderKind::Aliyun);
        assert_eq!(s2.pwd.as_deref(), Some("4f2a"));
    }

    #[test]
    fn parse_onedrive_share_encodes_url() {
        let s = parse_share("https://1drv.ms/u/s!Ap1234567890").unwrap();
        assert_eq!(s.provider, ProviderKind::OneDrive);
        assert!(s.share_id.starts_with("u!"));
        // base64url 无填充且不含 +/
        assert!(!s.share_id.contains('+') && !s.share_id.contains('/') && !s.share_id.contains('='));
        // 解码可还原原始 URL
        let enc = s.share_id.trim_start_matches("u!");
        assert!(decode_for_test(enc).contains("1drv.ms/u/s!Ap1234567890"));
    }

    #[test]
    fn reject_unknown_share() {
        assert!(parse_share("https://example.com/abc").is_err());
        assert!(parse_share("").is_err());
    }

    fn decode_for_test(s: &str) -> String {
        const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut bits = Vec::new();
        for c in s.bytes() {
            let v = T.iter().position(|&x| x == c).unwrap() as u32;
            bits.push(v);
        }
        let mut out = Vec::new();
        let mut acc: u32 = 0;
        let mut nbits = 0;
        for v in bits {
            acc = (acc << 6) | v;
            nbits += 6;
            if nbits >= 8 {
                nbits -= 8;
                out.push(((acc >> nbits) & 0xFF) as u8);
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }
}
