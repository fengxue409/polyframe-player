#!/usr/bin/env node
/**
 * 界面快照：用项目自带 Electron 当浏览器，把每个页面按多档视口截图。
 *
 * 为什么不用 playwright：渲染层是普通 Vue 应用，`window.polyframe` 缺失时
 * store 会自动退化到 browser 模式（首页回落演示库、其余页面走空态），
 * 所以直接加载构建产物 out/renderer 就能看到真实布局，不需要拉起内核。
 *
 * 用法：
 *   node ui-snapshot.mjs                 # 默认两组视口
 *   node ui-snapshot.mjs 1440x900        # 只跑一组
 *   PF_UITEST=1 node ui-snapshot.mjs     # 额外抓详情弹层 / 磁力任务行（喂假数据，
 *                                        依赖 main.ts 的 ?uitest 钩子）
 *   PF_THEME=light node ui-snapshot.mjs  # 截亮色皮肤，产物落 <视口>-light 目录
 *
 * 产物：.screenshots/ui/<视口>/<route>.png（外加 modal.png / modal-loading.png / magnet-tasks.png）
 *
 * 踩过的坑（与 e2e-cors.mjs 同源）：
 *   · ELECTRON_RUN_AS_NODE 不清掉，Electron 会退化成纯 Node；
 *   · electron.exe 必须用相对路径 spawn；
 *   · 入口用「目录 + package.json」，不要直接给 .cjs；
 *   · 窗口比屏幕宽会被 clamp，所以按实测 innerWidth 命名并记录到 meta.json。
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const RENDERER = path.join(ROOT, 'apps/desktop/out/renderer')
const ELECTRON = 'apps/desktop/node_modules/electron/dist/electron.exe'
const APP_DIR = path.join(ROOT, '.uishop-app')
const OUT_DIR = path.join(ROOT, '.screenshots/ui')
/** PF_THEME=light 时改截亮色皮肤，产物落到 <视口>-light 目录 */
const THEME = process.env.PF_THEME === 'light' ? 'light' : 'dark'

const ROUTES = ['home', 'discover', 'player', 'parse', 'netdisk', 'magnet', 'library', 'history', 'tasks', 'settings']
const arg = process.argv.find((a) => /^\d+x\d+$/.test(a))
const VIEWPORTS = arg
  ? [arg.split('x').map(Number)]
  : [
      [1440, 900],
      [820, 620]
    ]

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.pem': 'application/x-pem-file'
}

if (!fs.existsSync(path.join(RENDERER, 'index.html'))) {
  console.error(`找不到构建产物：${RENDERER}/index.html\n先跑 pnpm --filter @polyframe/desktop build`)
  process.exit(1)
}

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname)
  const file = path.join(RENDERER, p === '/' ? 'index.html' : p)
  if (!file.startsWith(RENDERER) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

fs.mkdirSync(APP_DIR, { recursive: true })
fs.writeFileSync(path.join(APP_DIR, 'package.json'), JSON.stringify({ name: 'pf-ui-shop', main: 'main.cjs' }))

fs.writeFileSync(
  path.join(APP_DIR, 'main.cjs'),
  `const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'args.json'), 'utf8'))
const dump = (o) => { try { fs.writeFileSync(cfg.outFile, JSON.stringify(o, null, 2)) } catch {} }
process.on('uncaughtException', (e) => dump({ error: String((e && e.stack) || e).slice(0, 800) }))
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {}) // 别让窗口销毁把 app 退掉
app.whenReady().then(async () => {
  const [w, h] = cfg.viewport
  const win = new BrowserWindow({
    width: w, height: h, show: false, backgroundColor: cfg.theme === 'light' ? '#f2f4f9' : '#0b0e14',
    webPreferences: { backgroundThrottling: false, paintWhenInitiallyHidden: true }
  })
  const meta = { viewport: cfg.viewport, actual: null, shots: [], errors: [] }
  win.webContents.on('console-message', (...a) => {
    const d = a[0] && typeof a[0] === 'object' && 'message' in a[0] ? a[0] : { level: a[1], message: a[2] }
    if (d.level === 'error' || d.level === 3) meta.errors.push(String(d.message).slice(0, 300))
  })
  await win.loadURL(cfg.pageUrl)
  // P34：亮色皮肤靠 localStorage 驱动，必须在导航前写入再重载，否则截到的是暗色。
  // 直接改 data-theme 没用：设置页的分段控件读的是 store，会和画面不一致。
  if (cfg.theme === 'light') {
    const reloaded = new Promise((res) => win.webContents.once('did-finish-load', res))
    await win.webContents
      .executeJavaScript("try{localStorage.setItem('pf.theme','light')}catch(e){}")
      .catch(() => {})
    win.webContents.reload()
    await reloaded
  }
  // 等应用挂载（导航按钮出现）
  for (let i = 0; i < 50; i++) {
    const ok = await win.webContents.executeJavaScript('!!document.querySelector(".nav-item")').catch(() => false)
    if (ok) break
    await new Promise((r) => setTimeout(r, 200))
  }
  meta.actual = await win.webContents.executeJavaScript('({ w: innerWidth, h: innerHeight })')
  for (const route of cfg.routes) {
    const label = cfg.labels[route]
    // P53：发现已并入首页 —— nav 里没有「发现」时，先点首页 nav 再点 view-seg 里的同名 tab
    const clicked = await win.webContents.executeJavaScript(
      \`(() => {
        const label = \${JSON.stringify(label)};
        const nav = [...document.querySelectorAll('.nav-item')];
        const b = nav.find(x => (x.getAttribute('title')||'').trim() === label);
        if (b) { b.click(); return 'nav' }
        const tab = [...document.querySelectorAll('.view-seg button')].find(x => (x.textContent||'').trim() === label);
        if (tab) {
          const home = nav.find(x => (x.getAttribute('title')||'').trim() === '首页');
          if (home) home.click();
          tab.click();
          return 'tab'
        }
        return false
      })()\`
    ).catch(() => false)
    await new Promise((r) => setTimeout(r, cfg.wait))
    // 强制两帧：隐藏窗口下 capturePage 容易拿到上一帧（切页后会串页）
    const state = await win.webContents.executeJavaScript(\`new Promise((res) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const act = document.querySelector('.nav-item.active');
        const view = [...document.querySelectorAll('.content > *')].find(el => getComputedStyle(el).display !== 'none');
        // 横向溢出体检：视图内部不该出现超出容器的元素（宽表除外，它有 .table-wrap 兜着）
        const ovf = [];
        for (const el of document.querySelectorAll('.content *')) {
          if (el.closest('.table-wrap')) continue;
          if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX === 'visible') {
            ovf.push(el.tagName.toLowerCase() + '.' + String(el.className).split(' ').filter(Boolean).slice(0, 2).join('.') + ':' + el.scrollWidth + '/' + el.clientWidth);
          }
        }
        const rect = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { w: Math.round(r.width), h: Math.round(r.height), t: Math.round(r.top), l: Math.round(r.left) };
        };
        res({
          active: act ? (act.getAttribute('title')||'') : '',
          view: view ? view.className : '',
          h: document.documentElement.scrollHeight,
          docOvf: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ovf: ovf.slice(0, 6),
          box: {
            video: rect('.video-wrap'),
            card: rect('.card.player'),
            side: rect('.info-side'),
            debug: rect('.card.debug')
          }
        });
      }))
    })\`).catch(() => ({}))
    await win.webContents.capturePage() // 丢弃首帧
    await new Promise((r) => setTimeout(r, 140))
    const img = await win.webContents.capturePage()
    const file = path.join(cfg.outDir, route + '.png')
    fs.writeFileSync(file, img.toPNG())
    meta.shots.push({ route, clicked, ...state, file, w: img.getSize().width, h: img.getSize().height })
  }
  // 详情弹层单独抓一张：回首页点第一张卡片（弹层是全局单例，不属于任何 route）
  if (cfg.modalSel) {
    await win.webContents.executeJavaScript(\`(() => { const b = [...document.querySelectorAll('.nav-item')].find(x => (x.getAttribute('title')||'').trim() === '首页'); if (b) b.click() })()\`).catch(() => {})
    await new Promise((r) => setTimeout(r, 900))
    const opened = await win.webContents.executeJavaScript(
      \`(() => {
        const c = window.__pfCatalog;
        if (c) {
          c.$patch(\${JSON.stringify(cfg.fakeDetail)});
          return 'patched';
        }
        const el = document.querySelector(\${JSON.stringify(cfg.modalSel)});
        if (!el) return 'no-card';
        el.click();
        return 'clicked';
      })()\`
    ).catch(() => false)
    await new Promise((r) => setTimeout(r, 1800))
    // 同 route 的坑：隐藏窗口下首帧可能是旧的，先丢一次再截
    await win.webContents.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))').catch(() => {})
    await win.webContents.capturePage()
    await new Promise((r) => setTimeout(r, 200))
    const info = await win.webContents.executeJavaScript(\`(() => {
      const m = document.querySelector('.modal.detail-modal');
      if (!m) return { mounted: false, toast: (document.querySelector('.toast') || {}).textContent || '' };
      const r = m.getBoundingClientRect();
      return {
        mounted: true,
        w: Math.round(r.width), h: Math.round(r.height), t: Math.round(r.top),
        scrollH: m.scrollHeight, clientH: m.clientHeight,
        title: (m.querySelector('h2') || {}).textContent || '',
        eps: m.querySelectorAll('.ep-btn').length,
        sources: m.querySelectorAll('.src-chips .chip').length
      };
    })()\`).catch((e) => ({ err: String(e) }))
    const img2 = await win.webContents.capturePage()
    fs.writeFileSync(path.join(cfg.outDir, 'modal.png'), img2.toPNG())
    meta.modal = { opened, ...info }

    // 首屏骨架：把 detail 清空、detailLoading 置真，验证骨架与真实内容同构
    await win.webContents.executeJavaScript(\`(() => { const c = window.__pfCatalog; if (c) c.$patch({ detail: null, detailLoading: true }) })()\`).catch(() => {})
    await new Promise((r) => setTimeout(r, 400))
    await win.webContents.capturePage()
    await new Promise((r) => setTimeout(r, 160))
    const img3 = await win.webContents.capturePage()
    fs.writeFileSync(path.join(cfg.outDir, 'modal-loading.png'), img3.toPNG())
  }

  // 磁力页任务行：真实行样式只在有任务时出现，这里喂一份覆盖全状态的假数据
  if (cfg.fakeMagnet) {
    await win.webContents.executeJavaScript(
      \`(() => { const b = [...document.querySelectorAll('.nav-item')].find(x => (x.getAttribute('title')||'').trim() === '磁力'); if (b) b.click() })()\`
    ).catch(() => {})
    await new Promise((r) => setTimeout(r, 800))
    // 先把上一段留下的详情弹层关掉，别让它盖住磁力列表
    await win.webContents.executeJavaScript(\`(() => { const c = window.__pfCatalog; if (c) c.$patch({ detail: null, detailLoading: false }) })()\`).catch(() => {})
    await win.webContents.executeJavaScript(\`(() => { const m = window.__pfMagnet; if (m) m.$patch(\${JSON.stringify(cfg.fakeMagnet)}) })()\`).catch(() => {})
    await new Promise((r) => setTimeout(r, 500))
    await win.webContents.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))').catch(() => {})
    await win.webContents.capturePage()
    await new Promise((r) => setTimeout(r, 180))
    const img4 = await win.webContents.capturePage()
    fs.writeFileSync(path.join(cfg.outDir, 'magnet-tasks.png'), img4.toPNG())
    const rows = await win.webContents.executeJavaScript('document.querySelectorAll(".task").length').catch(() => 0)
    meta.magnetRows = rows
  }
  // 调试抽屉：P30 起面板是 fixed 底部 dock，需要一张展开态截图（含假多源 + 日志）
  if (cfg.fakePlayer) {
    await win.webContents.executeJavaScript(
      \`(() => { const b = [...document.querySelectorAll('.nav-item')].find(x => (x.getAttribute('title')||'').trim() === '播放'); if (b) b.click() })()\`
    ).catch(() => {})
    await new Promise((r) => setTimeout(r, 700))
    await win.webContents.executeJavaScript(
      \`(() => { const p = window.__pfPlayer; if (p) p.$patch(\${JSON.stringify(cfg.fakePlayer)}); return !!p })()\`
    ).catch(() => {})
    await new Promise((r) => setTimeout(r, 300))
    const opened = await win.webContents.executeJavaScript(
      \`(() => { const b = document.querySelector('.dock-pill'); if (!b) return false; b.click(); return true })()\`
    ).catch(() => false)
    await new Promise((r) => setTimeout(r, 520))
    await win.webContents.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))').catch(() => {})
    await win.webContents.capturePage()
    await new Promise((r) => setTimeout(r, 180))
    const img5 = await win.webContents.capturePage()
    fs.writeFileSync(path.join(cfg.outDir, 'debug-dock.png'), img5.toPNG())
    const dockInfo = await win.webContents.executeJavaScript(\`(() => {
      const d = document.querySelector('.dock');
      if (!d) return { mounted: false };
      const r = d.getBoundingClientRect();
      const card = document.querySelector('.card.player');
      const p = card.getBoundingClientRect();
      const v = document.querySelector('.video-wrap').getBoundingClientRect();
      const view = document.querySelector('.player-view');
      const cs = getComputedStyle(view);
      const body = d.querySelector('.dock-body');
      return {
        mounted: true,
        vh: innerHeight,
        dockTop: Math.round(r.top), dockH: Math.round(r.height),
        dockBottom: Math.round(innerHeight - r.bottom),
        playerTop: Math.round(p.top), playerBottom: Math.round(p.bottom), playerH: Math.round(p.height),
        videoW: Math.round(v.width), videoH: Math.round(v.height),
        overlap: Math.max(0, Math.round(p.bottom - r.top)),
        room: cs.getPropertyValue('--pf-card-room').trim(),
        dockVar: cs.getPropertyValue('--pf-dock-h').trim(),
        chrome: cs.getPropertyValue('--pf-card-chrome').trim(),
        cardPos: getComputedStyle(card).position,
        sources: d.querySelectorAll('.src-row').length,
        logs: d.querySelectorAll('.log li').length,
        bodyScroll: body ? body.scrollHeight - body.clientHeight : 0
      };
    })()\`).catch((e) => ({ err: String(e) }))
    meta.dock = { opened, ...dockInfo }
  }

  // 播放历史：浏览器模式下永远空列表，喂一份覆盖今天/昨天/前天的假数据才能验分组与卡片
  if (cfg.fakeHistory) {
    await win.webContents.executeJavaScript(
      \`(() => { const b = [...document.querySelectorAll('.nav-item')].find(x => (x.getAttribute('title')||'').trim() === '历史'); if (b) b.click() })()\`
    ).catch(() => {})
    await new Promise((r) => setTimeout(r, 750))
    await win.webContents.executeJavaScript(
      \`(() => { const h = window.__pfHistory; if (h) h.$patch(\${JSON.stringify(cfg.fakeHistory)}) })()\`
    ).catch(() => {})
    await new Promise((r) => setTimeout(r, 450))
    await win.webContents.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))').catch(() => {})
    await win.webContents.capturePage()
    await new Promise((r) => setTimeout(r, 170))
    const img6 = await win.webContents.capturePage()
    fs.writeFileSync(path.join(cfg.outDir, 'history-cards.png'), img6.toPNG())
    const hist = await win.webContents.executeJavaScript(\`(() => {
      const groups = [...document.querySelectorAll('.hist-group')];
      const cards = [...document.querySelectorAll('.hist-group .grid > .item')];
      const hs = cards.map((c) => Math.round(c.getBoundingClientRect().height));
      const th = cards[0] ? cards[0].querySelector('.thumb') : null;
      const tb = th ? th.getBoundingClientRect() : null;
      return {
        groups: groups.map((g) => ({
          label: (g.querySelector('.group-head h3') || {}).textContent || '',
          n: g.querySelectorAll('.grid > .item').length
        })),
        cards: cards.length,
        cardH: hs.length ? { min: Math.min.apply(null, hs), max: Math.max.apply(null, hs) } : null,
        thumbAR: tb ? +(tb.width / tb.height).toFixed(3) : 0
      };
    })()\`).catch((e) => ({ err: String(e) }))
    meta.history = hist
  }

  dump(meta)
  app.exit(0)
}).catch((e) => { dump({ error: String((e && e.stack) || e) }); app.exit(1) })`
)

/** 详情弹层用的假数据：浏览器调试模式没有内核，点卡片起播必然失败，只能直接喂状态 */
const FAKE_DETAIL = {
  detailLoading: false,
  detail: {
    name: '示例影片标题（用于弹层排版检查）',
    api: 'demo',
    vodId: '1',
    poster: '',
    year: '2025',
    typeName: '剧情片',
    remarks: '更新至 24 集',
    updateTime: '2026-03-18 12:00:00',
    director: '某某导演',
    actor: '张三 / 李四 / 王五 / 赵六 / 孙七 / 周八 / 吴九 / 郑十 / 冯十一 / 陈十二',
    siteName: '演示站A',
    tmdb: { rating: 8.4, votes: 2314 },
    content: '这是一段用于检查排版的中文简介，长度足够触发折叠。'.repeat(8),
    groups: [
      { from: '线路一', episodes: Array.from({ length: 24 }, (_, i) => ({ name: '第' + (i + 1) + '集', url: 'u' + i })) },
      { from: '线路二（高清）', episodes: Array.from({ length: 8 }, (_, i) => ({ name: '第' + (i + 1) + '集', url: 'v' + i })) }
    ]
  },
  detailCard: {
    entries: [
      { api: 'demo', vodId: '1', siteName: '演示站A', remarks: '更新至 24 集' },
      { api: 'demo2', vodId: '2', siteName: '演示站B', remarks: 'HD' },
      { api: 'demo3', vodId: '3', siteName: '演示站C', remarks: '' }
    ]
  }
}

/** 磁力任务行：覆盖 待元数据/下载中/暂停/完成/失败 五种状态 + 多集展开 */
const FAKE_MAGNET = {
  tasks: [
    {
      id: 'a', url: 'magnet:?xt=urn:btih:aaa', infoHash: 'aaa', name: '示例影片 A · 2160p HDR 内封字幕', saveDir: '', status: 'downloading',
      totalBytes: 24 * 1024 ** 3, doneBytes: 11.6 * 1024 ** 3, fileIndex: 0, fileName: 'Example.Movie.2025.2160p.HDR.mkv',
      filePath: 'D:/magnet/example.mkv', files: [
        { index: 0, name: 'Example.Movie.2025.2160p.HDR.mkv', len: 23 * 1024 ** 3, isVideo: true },
        { index: 1, name: 'Example.Movie.2025.1080p.mkv', len: 8 * 1024 ** 3, isVideo: true },
        { index: 2, name: 'making-of.mkv', len: 1 * 1024 ** 3, isVideo: true }
      ],
      createdAt: '2026-03-18 10:00:00', updatedAt: 0
    },
    {
      id: 'b', url: 'magnet:?xt=urn:btih:bbb', infoHash: 'bbb', name: '示例影片 B · 1080p', saveDir: '', status: 'adding',
      totalBytes: 0, doneBytes: 0, files: [], createdAt: '2026-03-18 10:05:00', updatedAt: 0
    },
    {
      id: 'c', url: 'magnet:?xt=urn:btih:ccc', infoHash: 'ccc', name: '示例影片 C · 剧集合集（12 集全）', saveDir: '', status: 'done',
      totalBytes: 42 * 1024 ** 3, doneBytes: 42 * 1024 ** 3, fileIndex: 3, fileName: 'S01E03.mkv', filePath: 'D:/magnet/c/S01E03.mkv',
      files: Array.from({ length: 12 }, (_, i) => ({ index: i, name: 'S01E' + String(i + 1).padStart(2, '0') + '.mkv', len: 3.5 * 1024 ** 3, isVideo: true })),
      createdAt: '2026-03-18 09:00:00', updatedAt: 0
    },
    {
      id: 'd', url: 'magnet:?xt=urn:btih:ddd', infoHash: 'ddd', name: '', saveDir: '', status: 'paused',
      totalBytes: 9 * 1024 ** 3, doneBytes: 2.1 * 1024 ** 3, files: [], createdAt: '2026-03-18 08:00:00', updatedAt: 0
    },
    {
      id: 'e', url: 'magnet:?xt=urn:btih:eee', infoHash: 'eee', name: '死种示例：已无人做种', saveDir: '', status: 'error',
      error: '获取元数据超时（120s）：没有可用 peer，可能是死种或 DHT 未就绪', totalBytes: 0, doneBytes: 0, files: [],
      createdAt: '2026-03-18 07:00:00', updatedAt: 0
    }
  ],
  expanded: 'c',
  busyId: ''
}

/**
 * 播放历史：覆盖 有海报/无海报、看完/看到一半、超长标题、未记录计时 + 跨天分组。
 * 时间戳按运行时刻生成（今天 / 昨天 / 前天），否则「今天/昨天」分组没法验证。
 */
function makeFakeHistory() {
  const now = Date.now()
  const DAY = 86_400_000
  const at = (dAgo, hh, mm) => {
    const d = new Date(now - dAgo * DAY)
    d.setHours(hh, mm, 0, 0)
    return d.getTime()
  }
  // 内联 SVG 海报：不依赖外网（本机带代理，外链海报会假超时）
  const poster = (label, from, to) =>
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450">` +
        `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
        `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>` +
        `</linearGradient></defs>` +
        `<rect width="300" height="450" fill="url(#g)"/>` +
        `<circle cx="150" cy="160" r="56" fill="rgba(255,255,255,.13)"/>` +
        `<text x="150" y="320" fill="rgba(255,255,255,.88)" font-size="28" ` +
        `font-family="sans-serif" text-anchor="middle">${label}</text></svg>`
    )
  const item = (key, title, extra) => ({
    key,
    title,
    episodeName: '',
    episodeUrl: 'https://example.com/' + key,
    siteName: '',
    groups: '[]',
    groupIndex: 0,
    positionSec: 0,
    durationSec: 0,
    playedAt: now,
    poster: '',
    ...extra
  })
  return {
    loading: false,
    error: '',
    total: 9,
    items: [
      item('k1', '漫长的季节', {
        poster: poster('漫长的季节', '#2b3f6b', '#101725'),
        episodeName: '第 8 集', siteName: '演示站A',
        positionSec: 754, durationSec: 2710, playedAt: at(0, 22, 31)
      }),
      item('k2', '奥本海默', {
        poster: poster('奥本海默', '#5a3520', '#14100c'),
        episodeName: '正片', siteName: '演示站B',
        positionSec: 10800, durationSec: 10800, playedAt: at(0, 21, 5)
      }),
      item('k3', '三体', {
        poster: poster('三体', '#1d4a4a', '#0d1a1f'),
        episodeName: '第 14 集', siteName: '阿里云盘',
        positionSec: 1800, durationSec: 2700, playedAt: at(0, 19, 40)
      }),
      item('k4', '这是一个非常非常长的影片标题，用来验证单行省略号是否正确截断而不会把卡片撑宽', {
        episodeName: '第 1 集', siteName: '夸克网盘',
        positionSec: 300, durationSec: 600, playedAt: at(0, 9, 12)
      }),
      item('k5', '狂飙', {
        poster: poster('狂飙', '#4a2030', '#150d14'),
        episodeName: '第 26 集', siteName: '演示站C',
        positionSec: 302, durationSec: 2760, playedAt: at(1, 23, 48)
      }),
      item('k6', '沙丘 2', {
        siteName: '直链解析',
        positionSec: 0, durationSec: 0, playedAt: at(1, 20, 15)
      }),
      item('k7', '繁花', {
        poster: poster('繁花', '#3d2a4f', '#120e18'),
        episodeName: '第 3 集', siteName: '演示站A',
        positionSec: 2460, durationSec: 2460, playedAt: at(1, 11, 2)
      }),
      item('k8', '流浪地球 3', {
        poster: poster('流浪地球 3', '#23405e', '#0c1219'),
        episodeName: '第 12 集', siteName: '演示站B',
        positionSec: 120, durationSec: 1680, playedAt: at(2, 21, 30)
      }),
      item('k9', '隐秘的角落', {
        poster: poster('隐秘的角落', '#3a3320', '#12110c'),
        episodeName: '第 1 集', siteName: '演示站C',
        positionSec: 2400, durationSec: 2400, playedAt: at(2, 19, 0)
      })
    ]
  }
}

/** 调试抽屉：覆盖 正常 / 半开 / 熔断 三种源状态 + 多级别日志，验证新 dock 排版 */
const FAKE_PLAYER = {
  // 桌面端才是真实布局：browser 模式下会多出「浏览器调试模式」与「弹幕未配置」两条提示，
  // 把卡片撑高近 100px，测出来的视频压缩比例不具代表性
  mode: 'desktop',
  sources: [
    { idx: 0, url: 'https://cdn-a.example.com/2026/03/18/vod/index.m3u8', state: 'active', throughputEwma: 1.24e6, latencyEwma: 0.12, successRate: 0.996, score: 1.42, requests: 128, failures: 1 },
    { idx: 1, url: 'https://mirror-b.example.com/vod/index.m3u8', state: 'half_open', throughputEwma: 6.1e5, latencyEwma: 0.38, successRate: 0.92, score: 0.71, requests: 64, failures: 5 },
    { idx: 2, url: 'https://mirror-c.example.com/vod/index.m3u8', state: 'circuit_open', throughputEwma: 0, latencyEwma: 0.9, successRate: 0.41, score: 0.08, requests: 33, failures: 19, circuitRemainingSecs: 24 }
  ],
  proxyStats: { cacheHits: 412, originFetches: 37 },
  logs: [
    { ts: Date.parse('2026-03-18T12:05:00'), level: 'error', message: '分片 1024 回源失败：403（WAF），已切换镜像' },
    { ts: Date.parse('2026-03-18T12:04:52'), level: 'warn', message: '源 mirror-b 熔断半开，试探请求中' },
    { ts: Date.parse('2026-03-18T12:04:31'), level: 'info', message: '清单 /master.m3u8 已就绪（4 档清晰度）' },
    { ts: Date.parse('2026-03-18T12:04:30'), level: 'debug', message: '调度分重算：主 1.42 / 镜1 0.71 / 镜2 0.08' },
    { ts: Date.parse('2026-03-18T12:04:12'), level: 'info', message: '任务已创建 #4821，缓存模式 precache' },
    { ts: Date.parse('2026-03-18T12:04:09'), level: 'debug', message: 'HEAD 探测完成，Content-Length 214.6 MB' },
    { ts: Date.parse('2026-03-18T12:04:02'), level: 'info', message: '起播：第 3 集 · 线路一' },
    { ts: Date.parse('2026-03-18T12:03:58'), level: 'debug', message: '弹幕通道已连接，历史 428 条' },
    { ts: Date.parse('2026-03-18T12:03:55'), level: 'warn', message: '首帧耗时 2.8s，超过 2s 阈值' },
    { ts: Date.parse('2026-03-18T12:03:40'), level: 'info', message: '内核 pf-core 握手成功' },
    { ts: Date.parse('2026-03-18T12:03:38'), level: 'debug', message: '渲染进程注入 polyframe 桥接对象' },
    { ts: Date.parse('2026-03-18T12:03:31'), level: 'info', message: '代理服务启动于 127.0.0.1:41237' }
  ]
}

const LABELS = {
  home: '首页',  discover: '发现',
  player: '播放',
  parse: '解析',
  netdisk: '网盘',
  magnet: '磁力',
  library: '媒体库',
  history: '历史',
  tasks: '任务',
  settings: '设置'
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0

for (const [w, h] of VIEWPORTS) {
  const dir = path.join(OUT_DIR, `${w}x${h}${THEME === 'light' ? '-light' : ''}`)
  fs.mkdirSync(dir, { recursive: true })
  const outFile = path.join(dir, 'meta.json')
  fs.rmSync(outFile, { force: true })
  fs.writeFileSync(
    path.join(APP_DIR, 'args.json'),
    JSON.stringify({
      viewport: [w, h],
      theme: THEME,
      pageUrl: `http://127.0.0.1:${port}/index.html${process.env.PF_UITEST === '1' ? '?uitest=1' : ''}`,
      outDir: dir,
      outFile,
      wait: 700,
      routes: ROUTES,
      labels: LABELS,
      modalSel: '.v-card',
      fakeDetail: FAKE_DETAIL,
      fakeMagnet: FAKE_MAGNET,
      fakePlayer: FAKE_PLAYER,
      // 历史卡片墙只在有记录时渲染，浏览器模式下永远空 —— 仅 UITEST 时喂数据
      fakeHistory: process.env.PF_UITEST === '1' ? makeFakeHistory() : null
    })
  )
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const p = spawn(ELECTRON, [APP_DIR], { stdio: ['ignore', 'pipe', 'pipe'], env })
  let err = ''
  p.stderr.setEncoding('utf8')
  p.stderr.on('data', (d) => (err += d))
  await new Promise((resolve) => {
    const t = setTimeout(() => p.kill(), 120000)
    p.on('exit', () => {
      clearTimeout(t)
      resolve()
    })
  })
  let meta = null
  try {
    meta = JSON.parse(fs.readFileSync(outFile, 'utf8'))
  } catch {
    /* 下面统一报错 */
  }
  if (!meta || meta.error) {
    failed++
    console.log(`✗ ${w}x${h} 失败：${meta?.error ?? (err.slice(-400) || '无输出')}`)
    continue
  }
  const real = meta.actual
  console.log(`✓ ${w}x${h}（实测 ${real.w}x${real.h}）→ ${meta.shots.length} 张`)
  for (const s of meta.shots) {
    const flags = []
    if (s.docOvf > 0) flags.push(`文档横向溢出 ${s.docOvf}px`)
    if (s.ovf?.length) flags.push(`溢出元素 ${s.ovf.length}`)
    if (flags.length) console.log(`  ! ${s.route}：${flags.join(' / ')} → ${(s.ovf || []).join(', ')}`)
  }
  if (meta.modal) console.log('  弹层：', JSON.stringify(meta.modal))
  if (meta.errors.length) {
    console.log(`  renderer 报错 ${meta.errors.length} 条：`)
    for (const e of [...new Set(meta.errors)].slice(0, 6)) console.log('   ·', e)
  }
}

server.close()
if (process.env.PF_KEEP !== "1") fs.rmSync(APP_DIR, { recursive: true, force: true })
await sleep(50)
console.log(failed ? `\n有 ${failed} 组失败` : `\n全部完成：${path.join(OUT_DIR, '<视口>/<route>.png')}`)
process.exit(failed ? 1 : 0)
