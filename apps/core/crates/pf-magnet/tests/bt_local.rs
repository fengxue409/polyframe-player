//! BT 链路集成测试：**完全离线**验证「做种 → 磁力下载 → 落盘」。
//!
//! 不依赖公网 DHT：seeder 与 leecher 都是本机会话，leecher 用 `initial_peers`
//! 直连 seeder 的监听端口。这样测试结果是确定的，不会因为网络抖动变成 flaky。

use std::path::PathBuf;
use std::time::Duration;

use pf_magnet::Engine;

fn tmp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("pf-magnet-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn test_local_seed_and_download_roundtrip() {
    let root = tmp_dir("rt");

    // ---- 造一个「视频」文件（内容随机，避免全零被特殊优化） ----
    let payload_dir = root.join("payload");
    std::fs::create_dir_all(&payload_dir).unwrap();
    let payload = payload_dir.join("movie.mp4");
    let data: Vec<u8> = (0..512 * 1024u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(&payload, &data).unwrap();

    // ---- seeder ----
    let seeder = Engine::new(root.join("seed-out")).await.unwrap();
    let (magnet, _seed_handle) = seeder.seed_file(&payload_dir).await.unwrap();
    assert!(magnet.starts_with("magnet:?xt=urn:btih:"), "magnet={magnet}");
    let peer = seeder.listen_addr().expect("seeder 必须有监听地址");

    // ---- leecher ----
    let leecher = Engine::new(root.join("leech-out")).await.unwrap();
    let handle = leecher
        .add_with_peers(&magnet, vec![peer], None)
        .await
        .unwrap();

    leecher
        .wait_metadata(&handle, Duration::from_secs(20))
        .await
        .expect("应能通过直连 peer 拿到元数据");

    let files = leecher.files(&handle);
    assert!(!files.is_empty(), "元数据到手后应有文件列表");
    let video = files.iter().find(|f| f.is_video).expect("应能挑出正片");

    leecher
        .select_files(&handle, vec![video.index])
        .await
        .unwrap();
    leecher
        .wait_done(&handle, Duration::from_secs(60))
        .await
        .expect("应能在本地 peer 上完成下载");

    // ---- 校验落盘内容 ----
    let path = leecher.file_path(&handle, video.index).expect("应能定位文件");
    let got = std::fs::read(&path).unwrap_or_else(|e| panic!("读不到 {path:?}: {e}"));
    assert_eq!(got.len(), data.len(), "文件长度应一致");
    assert_eq!(got, data, "文件内容应一致");

    // 进度快照字段应有值
    let st = leecher.stats(&handle, Some(video.index));
    assert!(st.finished, "stats.finished 应为 true: {st:?}");
    assert_eq!(st.total_bytes, data.len() as u64);

    let _ = std::fs::remove_dir_all(&root);
}
