//! HLS AES-128 本地解密（RFC 8216 §4.3.2.4 / §5.2）
//!
//! 分片下载后解密再落盘，播放器全程只见明文（重写 playlist 输出 METHOD=NONE）。
//! IV 规则：KEY 显式 IV（0x 前缀 hex）优先；缺省用媒体序列号 big-endian 128 位。

use cbc::cipher::{BlockDecryptMut, KeyIvInit, block_padding::Pkcs7};

type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

/// AES-128-CBC + PKCS7 解密
pub fn decrypt_aes128(ciphertext: &[u8], key: &[u8; 16], iv: &[u8; 16]) -> Result<Vec<u8>, String> {
    if ciphertext.is_empty() || ciphertext.len() % 16 != 0 {
        return Err(format!("密文长度非法: {}（须为 16 的倍数）", ciphertext.len()));
    }
    let mut buf = ciphertext.to_vec();
    let dec = Aes128CbcDec::new_from_slices(key, iv).map_err(|e| format!("key/iv 非法: {e}"))?;
    dec.decrypt_padded_vec_mut::<Pkcs7>(&mut buf)
        .map_err(|e| format!("解密失败（PKCS7 校验不过）: {e:?}"))
}

/// IV 解析：显式 hex（0x 可选）或媒体序列号派生（u128 big-endian）
pub fn iv_from(spec: Option<&str>, media_seq: u64) -> Result<[u8; 16], String> {
    match spec {
        Some(s) => parse_hex_iv(s),
        None => Ok(u128::from(media_seq).to_be_bytes()),
    }
}

/// hex → [u8;16]（0x 前缀可选；按 128 位无符号整数右对齐，容忍省略前导零）
pub fn parse_hex_iv(s: &str) -> Result<[u8; 16], String> {
    let s = s.trim().trim_start_matches("0x").trim_start_matches("0X");
    if s.is_empty() || s.len() > 32 || !s.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("IV hex 非法: {s}"));
    }
    let v = u128::from_str_radix(s, 16).map_err(|e| format!("IV hex 溢出/非法: {e}"))?;
    Ok(v.to_be_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use cbc::cipher::{BlockEncryptMut, KeyIvInit as _, block_padding::Pkcs7 as P7};
    type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;

    fn encrypt(plain: &[u8], key: &[u8; 16], iv: &[u8; 16]) -> Vec<u8> {
        Aes128CbcEnc::new(key.into(), iv.into()).encrypt_padded_vec_mut::<P7>(plain)
    }

    #[test]
    fn roundtrip_with_padding() {
        let key = [7u8; 16];
        let iv = [9u8; 16];
        for len in [1usize, 15, 16, 17, 188] {
            let plain: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
            let ct = encrypt(&plain, &key, &iv);
            assert_eq!(ct.len(), (len / 16 + 1) * 16);
            let pt = decrypt_aes128(&ct, &key, &iv).unwrap();
            assert_eq!(pt, plain, "len={len}");
        }
    }

    #[test]
    fn wrong_key_fails() {
        let ct = encrypt(b"hello world pad!!", &[1u8; 16], &[2u8; 16]);
        assert!(decrypt_aes128(&ct, &[3u8; 16], &[2u8; 16]).is_err());
    }

    #[test]
    fn iv_parsing() {
        let iv = parse_hex_iv("0x10ef8f758ca555115584bb5b3c687f52").unwrap();
        assert_eq!(iv[0], 0x10);
        assert_eq!(iv[15], 0x52);
        // 无前缀 / 短 hex 右对齐（128 位整数语义）
        assert_eq!(parse_hex_iv("10ef8f758ca555115584bb5b3c687f52").unwrap(), iv);
        let short = parse_hex_iv("0x1ef").unwrap();
        assert_eq!(short[14], 0x01);
        assert_eq!(short[15], 0xef);
        // 缺省：媒体序列号 big-endian
        assert_eq!(iv_from(None, 5).unwrap(), {
            let mut v = [0u8; 16];
            v[15] = 5;
            v
        });
        assert!(parse_hex_iv("zz").is_err());
        assert!(parse_hex_iv("").is_err());
        assert!(parse_hex_iv("0x").is_err());
    }
}
