//! `pf-bt-seed`：开发/测试用做种器。
//!
//! 作用：不依赖公网，把本地文件做成种子并持续做种，供冒烟/E2E 验证
//! 「磁力加入 → 等元数据 → 只下正片 → 落盘 → 播放」整条链路。
//!
//! 用法：
//! ```text
//! pf-bt-seed <文件或目录>
//!   → 打印 PF_BT_SEED_MAGNET=<magnet>
//!          PF_BT_SEED_PEER=<127.0.0.1:port>
//! ```
//! 然后 `magnet.add` 时把 peer 放进 `initialPeers`。
//!
//! 不参与产品功能，只在 smoke/E2E 里被拉起。

use std::path::PathBuf;
use std::time::Duration;

use pf_magnet::Engine;

#[tokio::main]
async fn main() {
    let Some(target) = std::env::args().nth(1) else {
        eprintln!("用法: pf-bt-seed <文件或目录>");
        std::process::exit(2);
    };
    let path = PathBuf::from(&target);
    if !path.exists() {
        eprintln!("路径不存在: {target}");
        std::process::exit(2);
    }

    // 会话的默认输出目录与「被做种的文件」无关，随便给个临时目录
    let dir = std::env::temp_dir().join(format!("pf-bt-seed-{}", std::process::id()));
    let engine = match Engine::new(dir).await {
        Ok(e) => e,
        Err(e) => {
            eprintln!("BT 会话启动失败: {e}");
            std::process::exit(1);
        }
    };

    let (magnet, handle) = match engine.seed_file(&path).await {
        Ok(v) => v,
        Err(e) => {
            eprintln!("做种失败: {e}");
            std::process::exit(1);
        }
    };
    // 必须等到监听就绪，否则调用方拿不到 peer 地址
    let mut peer = None;
    for _ in 0..40 {
        if let Some(a) = engine.listen_addr() {
            peer = Some(a);
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    println!("PF_BT_SEED_MAGNET={magnet}");
    match peer {
        Some(a) => println!("PF_BT_SEED_PEER={a}"),
        None => eprintln!("警告：没拿到监听地址，无法直连（只能靠 DHT）"),
    }
    let name = handle.name().unwrap_or_default();
    println!("PF_BT_SEED_NAME={name}");
    use std::io::Write;
    let _ = std::io::stdout().flush();

    // 持续做种直到被杀
    loop {
        tokio::time::sleep(Duration::from_secs(3600)).await;
    }
}
