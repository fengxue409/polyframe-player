/**
 * 首页数据源（P8：中国视频资源为主）。
 * 播放地址均为公开演示/测试流，2026-10-27 经 HEAD 验证可达：
 * · 阿里云 player.alicdn.com（官方宣传演示 MP4）
 * · 腾讯云点播 200024424.vod.myqcloud.com（官方演示 MP4）
 * · 西瓜播放器 sf1-cdn-tos.huoshanstatic.com（官方演示 360p/720p/HLS）
 * · DCloud qiniu-web-assets（uni-app 官方两分钟演示 MP4）
 * 另保留少量国际参考流（Mux/Apple/Akamai）保证分类丰富度。
 * 封面为内嵌 SVG data URI（中文文案 + 渐变），无外链防盗链问题；
 * 播放量/日期为演示热度数据（确定性伪随机），不影响播放。
 */

export interface VideoItem {
  id: string
  title: string
  cat: string
  channel: string
  chColor: string
  /** 真实可播地址（HLS m3u8 或 MP4 直链），经内核代理起播 */
  src: string
  views: number
  date: string
  duration: string
  isLive?: boolean
  /** 封面图（SVG data URI）；加载失败自动回落渐变封面 */
  poster: string
  grad: [string, string]
}

/** 与全局 token 呼应的封面渐变（蓝紫为主） */
const GRADS: [string, string][] = [
  ['#3d6ae0', '#8f6cff'],
  ['#2a9d8f', '#43c6ac'],
  ['#4d79f0', '#38bdf8'],
  ['#7c3aed', '#db2777'],
  ['#0ea5e9', '#6366f1'],
  ['#059669', '#34d399'],
  ['#6d28d9', '#4f46e5'],
  ['#155e75', '#0891b2']
]

/** 渐变色池（HomeView 真实卡片兜底底色复用） */
export const COVER_GRADS: [string, string][] = GRADS

/** 内嵌 SVG 封面：渐变底 + 分区图标 + 中文文案（系统字体，无外部依赖） */
function svgCover(grad: [string, string], icon: string, label: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${grad[0]}"/><stop offset="1" stop-color="${grad[1]}"/>` +
    `</linearGradient></defs>` +
    `<rect width="640" height="360" fill="url(#g)"/>` +
    `<circle cx="320" cy="150" r="56" fill="rgba(255,255,255,.14)"/>` +
    `<text x="320" y="172" font-size="56" text-anchor="middle">${icon}</text>` +
    `<text x="320" y="272" font-size="34" font-family="'Microsoft YaHei','PingFang SC',sans-serif" font-weight="600" fill="rgba(255,255,255,.92)" text-anchor="middle">${label}</text>` +
    `</svg>`
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
}

interface RawItem extends Omit<VideoItem, 'views' | 'date' | 'chColor' | 'grad' | 'poster'> {
  icon: string
}

const RAW: RawItem[] = [
  // ---- 科技（国内） ----
  {
    id: 'aliyun-media',
    title: '阿里云 · 云计算官方宣传演示视频',
    cat: '科技',
    channel: '阿里云',
    icon: '☁️',
    src: 'https://player.alicdn.com/video/aliyunmedia.mp4',
    duration: '—'
  },
  {
    id: 'uniapp-demo',
    title: 'uni-app · 官方两分钟快速上手演示',
    cat: '科技',
    channel: 'DCloud',
    icon: '📱',
    src: 'https://qiniu-web-assets.dcloud.net.cn/unidoc/zh/2minute-demo.mp4',
    duration: '—'
  },
  // ---- 综合（国内） ----
  {
    id: 'xgplayer-720',
    title: '西瓜播放器 · 官方高清演示视频（720P）',
    cat: '综合',
    channel: '西瓜播放器',
    icon: '🍉',
    src: 'https://sf1-cdn-tos.huoshanstatic.com/obj/media-fe/xgplayer_doc_video/mp4/xgplayer-demo-720p.mp4',
    duration: '—'
  },
  {
    id: 'xgplayer-360',
    title: '西瓜播放器 · 官方流畅演示视频（360P）',
    cat: '综合',
    channel: '西瓜播放器',
    icon: '🍉',
    src: 'https://sf1-cdn-tos.huoshanstatic.com/obj/media-fe/xgplayer_doc_video/mp4/xgplayer-demo-360p.mp4',
    duration: '—'
  },
  {
    id: 'xgplayer-hls',
    title: '西瓜播放器 · 官方 HLS 直播演示流',
    cat: '综合',
    channel: '西瓜播放器',
    icon: '🍉',
    src: 'https://sf1-cdn-tos.huoshanstatic.com/obj/media-fe/xgplayer_doc_video/hls/xgplayer-demo.m3u8',
    duration: '—'
  },
  {
    id: 'tencent-vod',
    title: '腾讯云 · 点播与超清转码演示视频',
    cat: '综合',
    channel: '腾讯云',
    icon: '🐧',
    src: 'https://200024424.vod.myqcloud.com/200024424_709ae516bdf811e6ad39991f76a4df69.f20.mp4',
    duration: '—'
  },
  // ---- 动画（国际开源电影，中文标题） ----
  {
    id: 'bbb-hls',
    title: '大雄兔 · 开源动画电影（HLS 自适应）',
    cat: '动画',
    channel: 'Mux 测试流',
    icon: '🐰',
    src: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
    duration: '10:34'
  },
  {
    id: 'bbb-1080',
    title: '大雄兔 · 1080P 高清测试片段',
    cat: '动画',
    channel: 'Test-Videos',
    icon: '🐰',
    src: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_1MB.mp4',
    duration: '0:10'
  },
  {
    id: 'sintel-1080',
    title: 'Sintel · 1080P 高清测试片段',
    cat: '动画',
    channel: 'Test-Videos',
    icon: '🐉',
    src: 'https://test-videos.co.uk/vids/sintel/mp4/h264/1080/Sintel_1080_10s_1MB.mp4',
    duration: '0:10'
  },
  // ---- 科技（国际参考流） ----
  {
    id: 'tos-mux',
    title: '钢铁之泪 · 开源科幻短片（多字幕 HLS）',
    cat: '科技',
    channel: 'Mux 测试流',
    icon: '🤖',
    src: 'https://test-streams.mux.dev/tos_ismc/main.m3u8',
    duration: '12:14'
  },
  // ---- 直播 ----
  {
    id: 'akamai-live',
    title: '全球直播测试流 · 24 小时不间断',
    cat: '直播',
    channel: 'Akamai 测试台',
    icon: '🔴',
    src: 'https://cph-p2p-msl.akamaized.net/hls/live/2000341/test/master.m3u8',
    duration: '直播',
    isLive: true
  }
]

/** 确定性伪随机演示热度/日期（mulberry32） */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const REAL_VIDEOS: VideoItem[] = RAW.map((r, i) => {
  const rnd = mulberry32(20261027 + i * 13)
  const grad = GRADS[i % GRADS.length]
  const { icon, ...item } = r
  return {
    ...item,
    views: Math.floor(rnd() * 9600000) + 80000,
    date: new Date(2026, 9, 27 - Math.floor(rnd() * 45)).toISOString().slice(0, 10),
    chColor: grad[0],
    grad,
    poster: svgCover(grad, icon, r.channel)
  }
})

export function formatViews(v: number): string {
  if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, '') + ' 万'
  return String(v)
}

/** 侧边栏分区（与片库实际内容对齐） */
export const CHANNEL_CATS = ['推荐', '热门', '最新', '订阅'] as const
export const ZONE_CATS = ['科技', '综合', '动画', '直播'] as const

function byCat(cat: string): VideoItem[] {
  return REAL_VIDEOS.filter((v) => v.cat === cat)
}

/** 分类 → 视频列表 */
export const VIDEO_DB: Record<string, VideoItem[]> = {
  推荐: [...REAL_VIDEOS].sort((a, b) => b.views - a.views).slice(0, 9),
  热门: [...REAL_VIDEOS].sort((a, b) => b.views - a.views),
  最新: [...REAL_VIDEOS].sort((a, b) => b.date.localeCompare(a.date)),
  订阅: [...REAL_VIDEOS].filter((_, i) => i % 3 === 0),
  科技: byCat('科技'),
  综合: byCat('综合'),
  动画: byCat('动画'),
  直播: byCat('直播')
}

/** 轮播横幅：热门前 4 */
export const BANNERS: VideoItem[] = VIDEO_DB['热门'].slice(0, 4)
