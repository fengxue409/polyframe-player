//! P2.5 缓存清理器（DESIGN §4.6 清理策略）：
//! 播完 TTL / 未播完 LRU / 容量 LRU / 启动孤儿清扫。
//! sweep() 为纯同步函数（now 注入），CacheStore 全部同步 API → 可直接单测。

use std::collections::HashSet;
use std::path::Path;

use super::CacheStore;

/// 清理参数（P2.5 为常量默认值；设置页可配留待后续阶段）
#[derive(Debug, Clone, Copy)]
pub struct CleanupConfig {
    /// 播完 TTL 保留天数（负数 = 永久）
    pub retain_days: f64,
    /// 未播完 LRU 天数
    pub unfinished_days: f64,
    /// 容量上限（字节），超限按最久未播放清理
    pub capacity_bytes: u64,
    /// 「正在播放」保护窗口（最近播放活跃的 ms 窗口）
    pub playing_window_ms: i64,
}

/// 单轮清理报告
#[derive(Debug, Default, Clone)]
pub struct CleanupReport {
    pub deleted_tasks: usize,
    pub deleted_segments: u64,
    pub freed_bytes: u64,
    pub orphan_files: u64,
    pub orphan_bytes: u64,
    /// 被删任务 id（调用方同步内存任务表）
    pub removed_ids: Vec<String>,
}

/// 单轮清理。`protected`：正在下载/播放的任务（容量 LRU 不碰）。
pub fn sweep(
    store: &CacheStore,
    cache_dir: &Path,
    cfg: &CleanupConfig,
    protected: &HashSet<String>,
    now_ms: i64,
) -> CleanupReport {
    let mut report = CleanupReport::default();

    // 1) 播完 TTL：retain_until 到期且最近无播放活跃
    for id in store.expired_finished_tasks(now_ms, cfg.playing_window_ms) {
        let (done, _total, bytes) = store.progress(&id);
        store.delete_task_cascade(&id);
        report.deleted_tasks += 1;
        report.deleted_segments += done;
        report.freed_bytes += bytes;
        report.removed_ids.push(id);
    }

    // 2) 未播完 LRU：长期未动的半截任务
    let ttl_ms = (cfg.unfinished_days * 86_400_000.0) as i64;
    for id in store.stale_unfinished_tasks(now_ms, ttl_ms) {
        let (done, _total, bytes) = store.progress(&id);
        store.delete_task_cascade(&id);
        report.deleted_tasks += 1;
        report.deleted_segments += done;
        report.freed_bytes += bytes;
        report.removed_ids.push(id);
    }

    // 3) 容量 LRU：超限按「最久未播放」优先（正在播放/预取中受保护）
    let mut rows = store.task_bytes_by_activity();
    rows.sort_by_key(|(_, _, activity)| *activity); // 最久未活跃在前
    let total: u64 = rows.iter().map(|(_, b, _)| *b).sum();
    let mut over = total.saturating_sub(cfg.capacity_bytes);
    if over > 0 {
        for (id, bytes, _act) in rows.iter() {
            if over == 0 {
                break;
            }
            if protected.contains(id) || *bytes == 0 {
                continue; // 保护中 / 无缓存可释放
            }
            let (done, _t, _b) = store.progress(id);
            store.delete_task_cascade(id);
            over = over.saturating_sub(*bytes);
            report.deleted_tasks += 1;
            report.deleted_segments += done;
            report.freed_bytes += *bytes;
            report.removed_ids.push(id.clone());
        }
    }

    // 4) 孤儿清扫：缓存目录里无索引记录的 .bin
    let done = store.done_pairs();
    if let Ok(entries) = std::fs::read_dir(cache_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let task_dir = entry.path();
            if !task_dir.is_dir() {
                continue;
            }
            let task_id = task_dir
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if let Ok(files) = std::fs::read_dir(&task_dir) {
                for f in files.filter_map(|e| e.ok()) {
                    let p = f.path();
                    if p.extension().map(|e| e != "bin").unwrap_or(true) {
                        continue; // .part 临时文件由下载侧管理
                    }
                    let seq: Option<u64> = p
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .and_then(|s| s.parse().ok());
                    let indexed = seq
                        .map(|s| done.contains(&(task_id.clone(), s)))
                        .unwrap_or(false);
                    if !indexed {
                        let bytes = f.metadata().map(|m| m.len()).unwrap_or(0);
                        if std::fs::remove_file(&p).is_ok() {
                            report.orphan_files += 1;
                            report.orphan_bytes += bytes;
                        }
                    }
                }
            }
            // 任务目录空且任务已不存在 → 移除空目录
            if !store.task_exists(&task_id) {
                if let Ok(mut it) = std::fs::read_dir(&task_dir) {
                    if it.next().is_none() {
                        let _ = std::fs::remove_dir(&task_dir);
                    }
                }
            }
        }
    }

    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use pf_parser::Segment;
    use std::path::PathBuf;

    fn temp_store(tag: &str) -> (CacheStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!("pf-cleanup-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store =
            CacheStore::open(&dir.join("core.db"), dir.join("cache")).expect("open store");
        (store, dir)
    }

    fn seg(seq: u64) -> Segment {
        Segment {
            seq,
            duration: 4.0,
            uri: format!("https://a/{seq}.ts"),
            byterange: None,
            key: None,
        }
    }

    /// 建任务 + done 分片 + 磁盘文件，模拟已缓存内容
    fn seed_task(store: &CacheStore, id: &str, url: &str, seqs: &[u64], bytes_per: u64) {
        store
            .upsert_task(id, url, None, "hls", "ready", false, None, "stream", &crate::iso_now())
            .unwrap();
        let all: Vec<Segment> = (0..4).map(seg).collect();
        store.upsert_segments(id, &all).unwrap();
        for &s in seqs {
            let p = store.segment_path(id, s);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, vec![0u8; bytes_per as usize]).unwrap();
            store.mark_segment(id, s, "done", Some(bytes_per), Some("p"), 0);
        }
    }

    #[test]
    fn finished_ttl_sweep() {
        let (store, dir) = temp_store("ttl");
        let now: i64 = 1_800_000_000_000;
        // t-exp：播完且已过保留期 → 删（含磁盘文件）
        seed_task(&store, "t-exp", "u1", &[0, 1], 100);
        store.mark_finished("t-exp", now - 86_400_000, Some(now - 1000));
        // t-keep：播完未到期 → 留
        seed_task(&store, "t-keep", "u2", &[0, 1], 100);
        store.mark_finished("t-keep", now, Some(now + 86_400_000));
        // t-play：已过期但 10 分钟内播放活跃 → 留
        seed_task(&store, "t-play", "u3", &[0, 1], 100);
        store.mark_finished("t-play", now - 86_400_000, Some(now - 1000));
        store.touch_played("t-play", now - 60_000);

        let report = sweep(
            &store,
            &dir.join("cache"),
            &cfg(),
            &HashSet::new(),
            now,
        );
        assert_eq!(report.deleted_tasks, 1);
        assert_eq!(report.deleted_segments, 2);
        assert_eq!(report.freed_bytes, 200);
        assert_eq!(report.removed_ids, vec!["t-exp".to_string()]);
        assert!(store.find_task_id_by_url("u1").unwrap().is_none());
        assert!(store.find_task_id_by_url("u2").unwrap().is_some());
        assert!(store.find_task_id_by_url("u3").unwrap().is_some());
        assert!(!dir.join("cache").join("t-exp").join("00000000.bin").exists());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn capacity_lru_sweep() {
        let (store, dir) = temp_store("cap");
        let now: i64 = 1_800_000_000_000;
        // 三任务各 1000B（1 片 × 1000），上限 2500B → 总 3000 超限 500 → 删最久未活跃
        seed_task(&store, "t-old", "u1", &[0], 1000);
        store.touch_played("t-old", now - 10 * 86_400_000);
        seed_task(&store, "t-mid", "u2", &[0], 1000);
        store.touch_played("t-mid", now - 86_400_000);
        seed_task(&store, "t-new", "u3", &[0], 1000);
        store.touch_played("t-new", now - 1000);

        let report = sweep(
            &store,
            &dir.join("cache"),
            &CleanupConfig {
                capacity_bytes: 2500,
                ..cfg()
            },
            &HashSet::new(),
            now,
        );
        assert_eq!(report.deleted_tasks, 1);
        assert_eq!(report.freed_bytes, 1000);
        assert_eq!(report.removed_ids, vec!["t-old".to_string()]);
        assert!(store.find_task_id_by_url("u1").unwrap().is_none());
        assert!(store.find_task_id_by_url("u2").unwrap().is_some());
        assert!(store.find_task_id_by_url("u3").unwrap().is_some());

        // 保护集：再注入超限，t-mid 受保护 → 删次旧的 t-old2
        seed_task(&store, "t-old2", "u4", &[0], 1000);
        store.touch_played("t-old2", now - 10 * 86_400_000);
        let mut prot = HashSet::new();
        prot.insert("t-mid".to_string());
        let report = sweep(
            &store,
            &dir.join("cache"),
            &CleanupConfig {
                capacity_bytes: 2500,
                ..cfg()
            },
            &prot,
            now,
        );
        assert_eq!(report.removed_ids, vec!["t-old2".to_string()]);
        assert!(store.find_task_id_by_url("u2").unwrap().is_some());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn orphan_file_sweep() {
        let (store, dir) = temp_store("orphan");
        let now: i64 = 1_800_000_000_000;
        seed_task(&store, "t1", "u1", &[0], 100);
        // 孤儿：无索引记录的 .bin + 未知任务目录 + .part（不动）
        let cache = dir.join("cache");
        let stray = cache.join("t1").join("00000009.bin");
        std::fs::write(&stray, vec![0u8; 55]).unwrap();
        let part = cache.join("t1").join("00000008.part");
        std::fs::write(&part, vec![0u8; 10]).unwrap();
        std::fs::create_dir_all(cache.join("ghost")).unwrap();
        std::fs::write(cache.join("ghost").join("00000000.bin"), vec![0u8; 30]).unwrap();

        let report = sweep(&store, &cache, &cfg(), &HashSet::new(), now);
        assert_eq!(report.orphan_files, 2); // t1/00000009.bin + ghost/00000000.bin
        assert_eq!(report.orphan_bytes, 85);
        assert!(!stray.exists());
        assert!(part.exists()); // .part 不归清扫管
        assert!(!cache.join("ghost").exists()); // 空目录被移除
        assert!(cache.join("t1").join("00000000.bin").exists()); // 索引内分片保留
        std::fs::remove_dir_all(dir).ok();
    }

    fn cfg() -> CleanupConfig {
        CleanupConfig {
            retain_days: 1.0,
            unfinished_days: 14.0,
            capacity_bytes: 20 * 1024 * 1024 * 1024,
            playing_window_ms: 10 * 60 * 1000,
        }
    }
}
