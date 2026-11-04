//! 磁力/BT 片源：纯逻辑（链接归一、选片）+ librqbit 会话封装。
//!
//! 设计原则与 P10 解析一致：**不假设资源健康**。磁力链接能解析不代表有种子，
//! 所以引擎层只负责「如实报告」——元数据是否到手、有几个 peer、下了多少。

pub mod engine;
pub mod magnet;

pub use engine::{Engine, FileInfo, TorrentHandle, TorrentStatsView};
pub use magnet::{normalize_magnet, pick_video_file, MagnetInfo};
