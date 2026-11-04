/**
 * P9/P11 无头冒烟测试：分类浏览 / 追更 / 继续观看 / 地区与热门 / 后台巡检 / TMDB
 *  A. 分类浏览（catalog.category）：ac=detail&pg=N 翻页扇出、更新时间降序、
 *     大类按 type_name 过滤、year 精确匹配、hours 走苹果CMS h 参数、翻页取到第二页
 *  A2. P11 地区筛选（vod_area 包含匹配）+ sort=hot 热门榜（双站聚合 sourceCount 排序）
 *  B. 追更（catalog.favorite.refresh）：收藏快照 2 集 → 源站变 4 集 → added=2
 *     → 再刷一次无新增（幂等）→ 不存在的收藏报错
 *  B2. P11 后台巡检（catalog.favorite.autoscan）：初始状态 → run=true 触发 → 捕获新增
 *  C. 继续观看（catalog.favorite.progress.set / catalog.progress.list）：
 *     写入、覆盖写、JOIN 补片名、删收藏级联清进度
 *  D. 参数校验
 *  E. P11 TMDB（catalog.tmdb.get/set/lookup）：Key 存取 + 未配置时静默降级
 *  G. P13 巡检间隔可配置（intervalHours 设置 / 关闭 / 越界报错）
 *     + 热门榜叠加 TMDB 人气（假 TMDB origin，PF_TMDB_API 环境变量指向本地）
 *
 * 全部使用本地假 CMS origin，不依赖外网。
 * 运行：node apps/core/scripts/smoke-p9.mjs（需先 pnpm core:build）
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import { existsSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const coreRoot = path.resolve(here, '..')
const binCandidates = [
  path.join(coreRoot, 'target/release/pf-core.exe'),
  path.join(coreRoot, 'target/debug/pf-core.exe')
]

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`  ${ok ? GREEN + 'PASS' : RED + 'FAIL'}${RESET} ${name}${detail ? ` ${DIM}(${detail})${RESET}` : ''}`)
}

/**
 * 假 CMS origin（苹果CMS V10）
 * - ac=list                     → 探活
 * - ac=detail&wd=xxx            → 搜索（固定返回「星球A」）
 * - ac=detail&ids=N             → 详情（集数由 state.episodes 控制，供追更测试）
 * - ac=detail&pg=N（无 wd/ids） → 分类/更新流翻页
 */
function startCmsOrigin(opts = {}) {
  const state = { episodes: 2, pageQueries: [] }
  let originPort = 0

  /** 第 1 页 22 条（20 部科幻片 + 2 部国产剧）；第 2 页 3 条。
   *  opts.subset = 热门榜测试的第二站：只返回同名片（星球01–10），vod_time 更旧 */
  const pageItems = (pg) => {
    if (pg === 2) {
      if (opts.subset) return []
      return [
        { vod_id: 201, vod_name: '星球B', type_name: '科幻片', vod_year: '2024', vod_time: '2025-03-02 10:00:00', vod_remarks: 'HD', vod_area: '中国大陆' },
        { vod_id: 202, vod_name: '综艺A', type_name: '大陆综艺', vod_year: '2025', vod_time: '2025-03-01 10:00:00', vod_remarks: '更新至3期', vod_area: '中国大陆' },
        { vod_id: 203, vod_name: '动漫A', type_name: '日韩动漫', vod_year: '2025', vod_time: '2025-02-28 10:00:00', vod_remarks: '更新至5话', vod_area: '日本' }
      ]
    }
    const out = []
    for (let i = 1; i <= 20; i++) {
      out.push({
        vod_id: 100 + i,
        vod_name: `星球${String(i).padStart(2, '0')}`,
        type_name: '科幻片',
        vod_year: i % 2 === 0 ? '2025' : '2024',
        vod_time: `2025-04-${String(i).padStart(2, '0')} 12:00:00`,
        vod_remarks: 'HD中字',
        vod_area: '中国大陆'
      })
    }
    out.push(
      { vod_id: 301, vod_name: '剧A', type_name: '国产剧', vod_year: '2025', vod_time: '2025-04-21 09:00:00', vod_remarks: '更新至12集', vod_area: '中国香港' },
      { vod_id: 302, vod_name: '剧B', type_name: '国产剧', vod_year: '2025', vod_time: '2025-04-20 09:00:00', vod_remarks: '更新至8集', vod_area: '中国大陆' }
    )
    if (opts.subset) {
      return out.filter((v) => /^星球(0[1-9]|10)$/.test(v.vod_name)).map((v) => ({ ...v, vod_time: '2025-03-15 00:00:00' }))
    }
    return out
  }

  const playUrl = () =>
    Array.from({ length: state.episodes }, (_, i) => `第${String(i + 1).padStart(2, '0')}集$http://127.0.0.1:${originPort}/s${i + 1}.m3u8`).join('#')

  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1')
    if (!u.pathname.endsWith('/provide/vod')) {
      res.writeHead(404).end()
      return
    }
    const ac = u.searchParams.get('ac')
    const json = (obj) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }

    if (ac === 'list') {
      json({ code: 1, page: 1, pagecount: 1, total: 1, list: [{ vod_id: 1, vod_name: '样本' }] })
      return
    }
    if (ac === 'detail' && u.searchParams.get('ids')) {
      json({
        code: 1,
        list: [
          {
            vod_id: u.searchParams.get('ids'),
            vod_name: '星球A',
            type_name: '科幻片',
            vod_year: '2025',
            vod_remarks: `更新至${state.episodes}集`,
            vod_time: '2025-04-25 08:00:00',
            vod_actor: '演员甲,演员乙',
            vod_director: '导演丙',
            vod_content: '<p>冒烟简介</p>',
            vod_play_from: 'm3u8',
            vod_play_url: playUrl()
          }
        ]
      })
      return
    }
    if (ac === 'detail' && u.searchParams.get('wd')) {
      json({
        code: 1,
        list: [
          {
            vod_id: 1,
            vod_name: '星球A',
            type_name: '科幻片',
            vod_year: '2025',
            vod_remarks: 'HD中字',
            vod_time: '2025-04-25 08:00:00',
            vod_play_from: 'm3u8',
            vod_play_url: `第01集$http://127.0.0.1:${originPort}/s1.m3u8`
          }
        ]
      })
      return
    }
    if (ac === 'detail') {
      const pg = Number(u.searchParams.get('pg') || '1')
      state.pageQueries.push({ pg, h: u.searchParams.get('h') })
      json({ code: 1, page: pg, pagecount: 9, total: 100, list: pageItems(pg) })
      return
    }
    res.writeHead(404).end()
  })

  return {
    state,
    start: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          originPort = server.address().port
          resolve(`http://127.0.0.1:${originPort}/api.php/provide/vod`)
        })
      }),
    close: () => server.close()
  }
}

function startCore(envOverride = {}) {
  const bin = binCandidates.find((p) => existsSync(p))
  if (!bin) throw new Error('未找到 pf-core.exe，请先执行: pnpm core:build')
  const proc = spawn(bin, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...envOverride, PF_PROXY_ALLOW_PRIVATE: '1' } // M5/L1：本地测试源需放开私网目标
  })
  const portReady = new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error('等待 PF_CORE_PORT 超时')), 20000)
    const onData = (d) => {
      buf += d.toString()
      const m = buf.match(/PF_CORE_PORT=(\d+)/)
      const t = buf.match(/PF_CORE_TOKEN=([0-9a-f]+)/)
      if (t) rpcToken = t[1]

      if (m) {
        clearTimeout(timer)
        proc.stdout.off('data', onData)
        resolve(Number(m[1]))
      }
    }
    proc.stdout.on('data', onData)
    proc.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`内核提前退出 code=${code}`))
    })
  })
  return { proc, portReady }
}

/** P13 假 TMDB origin：/3/search/multi 只对「星球05」返回高人气命中（popularity=500） */
function startTmdbOrigin() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1')
    if (u.pathname !== '/3/search/multi') {
      res.writeHead(404).end()
      return
    }
    const q = u.searchParams.get('query') || ''
    const results = q.includes('星球05')
      ? [{ title: '星球05', release_date: '2024-06-01', popularity: 500, vote_average: 9.1, vote_count: 1234 }]
      : []
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ page: 1, results }))
  })
  return {
    start: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/3`))
      }),
    close: () => server.close()
  }
}

let rpcToken = '' // H2：pf-core stdout 端口发现一并下发的连接鉴权 token
function connectRpc(port) {
  const socket = net.connect(port, '127.0.0.1')
  socket.write('PF_AUTH ' + rpcToken + '\n') // H2 连接鉴权（首行）
  let buf = ''
  let nextId = 1
  const pending = new Map()
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.id !== undefined) {
        const p = pending.get(msg.id)
        if (p) {
          pending.delete(msg.id)
          clearTimeout(p.timer)
          msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
        }
      }
    }
  })
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`超时: ${method}`))
      }, 90000)
      pending.set(id, { resolve, reject, timer })
      socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  return { socket, request }
}

let proc = null
let tmdbHandle = null // P13 假 TMDB origin（try 内赋值，finally 关闭）
const origins = []

try {
  const bin = binCandidates.find((p) => existsSync(p))
  console.log(`${DIM}启动内核: ${bin}${RESET}`)
  tmdbHandle = startTmdbOrigin()
  const tmdbBase = await tmdbHandle.start()
  const core = startCore({
    LOCALAPPDATA: path.join(process.env.TEMP ?? '.', `pf-smoke-p9-${process.pid}`),
    PF_TMDB_API: tmdbBase // P13：TMDB 请求重定向到本地假站
  })
  proc = core.proc
  const port = await core.portReady
  const { request } = connectRpc(port)
  await request('core.hello')

  // 只留本地假站：清掉出厂预设，避免外网依赖与结果污染
  const presetRows = (await request('catalog.source.list')).sources
  for (const s of presetRows) await request('catalog.source.remove', { id: s.id })

  const origin = startCmsOrigin()
  origins.push(origin)
  const api = await origin.start()
  const added = await request('catalog.source.add', { name: '冒烟站P9', api })
  const srcId = added.source.id
  check('假源站入库（详情探测）', !!added.source?.id && added.source.enabled === true)

  // ============ A 分类浏览 / 更新流 ============
  console.log(`\n${DIM}—— A 分类浏览 / 更新流 ——${RESET}`)
  const c1 = await request('catalog.category', { pg: 1 })
  check('分类浏览返回聚合卡片', Array.isArray(c1.cards) && c1.cards.length > 10, `${c1.cards.length} 张`)
  check('page=1 且 hasMore（一页 22 条 ≥ 20）', c1.page === 1 && c1.hasMore === true, JSON.stringify({ page: c1.page, hasMore: c1.hasMore }))
  check(
    '按站内更新时间降序',
    c1.cards[0].updateTime >= c1.cards[c1.cards.length - 1].updateTime,
    `${c1.cards[0].updateTime} … ${c1.cards.at(-1).updateTime}`
  )
  check('卡片带收录站数与条目', c1.cards.every((c) => c.sourceCount >= 1 && c.entries.length >= 1))

  const c2 = await request('catalog.category', { pg: 1, category: '电影' })
  check(
    '大类过滤：电影 → 只剩「…片」',
    c2.cards.length > 0 && c2.cards.every((c) => (c.typeName ?? '').includes('片')),
    `${c2.cards.length} 张，示例 ${c2.cards[0]?.typeName}`
  )

  const c3 = await request('catalog.category', { pg: 1, category: '剧集' })
  check(
    '大类过滤：剧集 → 国产剧命中、科幻片不串门',
    c3.cards.length === 2 && c3.cards.every((c) => (c.typeName ?? '').includes('剧')),
    c3.cards.map((c) => c.name).join('/')
  )

  const c4 = await request('catalog.category', { pg: 1, category: '电影', year: '2025' })
  check(
    '年份精确匹配',
    c4.cards.length > 0 && c4.cards.every((c) => c.year === '2025'),
    `${c4.cards.length} 张`
  )

  const c5 = await request('catalog.category', { pg: 1, hours: 24 })
  const lastQuery = origin.state.pageQueries.at(-1)
  check('更新流：请求带苹果CMS h=24', lastQuery?.h === '24', JSON.stringify(lastQuery))
  check('更新流仍返回卡片', c5.cards.length > 0, `${c5.cards.length} 张`)

  const c6 = await request('catalog.category', { pg: 2 })
  check(
    '翻页取到第二页（含只在第 2 页出现的片）',
    c6.page === 2 && c6.cards.some((c) => c.name === '星球B'),
    c6.cards.slice(0, 3).map((c) => c.name).join('/')
  )

  // ---- A2 P11 地区筛选 + 热门榜 ----
  console.log(`\n${DIM}—— A2 地区筛选 + 热门榜 ——${RESET}`)
  const c7 = await request('catalog.category', { pg: 1, area: '大陆|内地' })
  check(
    '地区过滤：大陆 → 剔除香港剧A',
    c7.cards.length > 0 && !c7.cards.some((c) => c.name === '剧A') && c7.cards.some((c) => c.name === '剧B'),
    c7.cards.map((c) => c.name).filter((n) => n.startsWith('剧')).join('/')
  )
  const c8 = await request('catalog.category', { pg: 1, area: '香港|港' })
  check(
    '地区过滤：香港 → 只剩剧A',
    c8.cards.length === 1 && c8.cards[0].name === '剧A',
    c8.cards.map((c) => c.name).join('/')
  )

  // 热门榜：第二站返回同名片（星球01–10），聚合后这些片 sourceCount=2
  const origin2 = startCmsOrigin({ subset: true })
  origins.push(origin2)
  const api2 = await origin2.start()
  await request('catalog.source.add', { name: '冒烟站P9二号', api: api2 })
  const ch = await request('catalog.category', { pg: 1, sort: 'hot' })
  const topTen = ch.cards.slice(0, 10)
  check(
    '热门榜：双站收录的 10 部排前（sourceCount=2）',
    topTen.length === 10 && topTen.every((c) => c.sourceCount === 2) && ch.cards[10]?.sourceCount === 1,
    `前10: ${topTen[0]?.sourceCount}/${topTen.at(-1)?.sourceCount}，第11: ${ch.cards[10]?.sourceCount}`
  )
  check(
    '热门榜：单站的剧A 排在双站片之后（位次 = 10）',
    ch.cards.findIndex((c) => c.name === '剧A') === 10,
    `剧A 位次 ${ch.cards.findIndex((c) => c.name === '剧A')}`
  )
  await request('catalog.source.remove', { id: (await request('catalog.source.list')).sources.find((s) => s.name === '冒烟站P9二号').id })
  origin2.close()

  // ============ B 追更 ============
  console.log(`\n${DIM}—— B 追更（收藏集数对比）——${RESET}`)
  const det = await request('catalog.detail', { api, vodId: '1', sourceId: srcId })
  check('详情拉取到分组剧集', det.detail?.groups?.[0]?.episodes?.length === 2, `${det.detail?.groups?.[0]?.episodes?.length} 集`)

  const fav = await request('catalog.favorite.add', { detail: det.detail })
  const favId = fav.favorite.id
  check('收藏入库（快照 2 集）', !!favId && fav.favorite.sourceCount === 1)

  const r0 = await request('catalog.favorite.refresh', { id: favId })
  check('源站未变时追更不上报更新', r0.updated.length === 0 && r0.failed.length === 0, JSON.stringify({ up: r0.updated.length, fail: r0.failed.length }))

  origin.state.episodes = 4
  const r1 = await request('catalog.favorite.refresh', { id: favId })
  check(
    '源站更新到 4 集 → added=2',
    r1.updated.length === 1 && r1.updated[0].added === 2 && r1.updated[0].newCount === 4,
    JSON.stringify(r1.updated[0] ?? {})
  )
  const snap = await request('catalog.favorite.sources', { id: favId })
  check('收藏快照已写回 4 集', snap.sources[0]?.episodes?.length === 4, `${snap.sources[0]?.episodes?.length} 集`)

  const r2 = await request('catalog.favorite.refresh', { id: favId })
  check('再次追更幂等（无新增）', r2.updated.length === 0)

  let refreshErr = ''
  try {
    await request('catalog.favorite.refresh', { id: 'not-exist' })
  } catch (e) {
    refreshErr = e.message
  }
  check('不存在的收藏报错', /收藏不存在/.test(refreshErr), refreshErr)

  // ---- B2 P11 后台巡检 ----
  console.log(`\n${DIM}—— B2 后台自动巡检 ——${RESET}`)
  const a0 = await request('catalog.favorite.autoscan', {})
  check('巡检状态初始为空（lastRunMs=null，间隔 6h）', a0.lastRunMs === null && a0.intervalHours === 6, JSON.stringify(a0))
  origin.state.episodes = 6
  const a1 = await request('catalog.favorite.autoscan', { run: true })
  check('手动触发巡检落库 lastRunMs', typeof a1.lastRunMs === 'number' && a1.lastRunMs > 0, `${a1.lastRunMs}`)
  check('巡检捕获新增（+2 集）', a1.lastAdded === 2, `lastAdded=${a1.lastAdded}`)
  const a2 = await request('catalog.favorite.autoscan', { run: true })
  check('巡检幂等（无新增 → lastAdded 归零）', a2.lastAdded === 0, `lastAdded=${a2.lastAdded}`)
  origin.state.episodes = 4

  // ---- G1 P13 巡检间隔可配置 ----
  console.log(`\n${DIM}—— G1 巡检间隔可配置 ——${RESET}`)
  const g1 = await request('catalog.favorite.autoscan', { intervalHours: 12 })
  check('间隔设置为 12h 并回读', g1.intervalHours === 12, `intervalHours=${g1.intervalHours}`)
  const g2 = await request('catalog.favorite.autoscan', { intervalHours: 0 })
  check('间隔设为 0（关闭巡检）', g2.intervalHours === 0, `intervalHours=${g2.intervalHours}`)
  let gErr = ''
  try {
    await request('catalog.favorite.autoscan', { intervalHours: 999 })
  } catch (e) {
    gErr = e.message
  }
  check('越界间隔（>72h）报参数错误', /0–72/.test(gErr), gErr)
  const g3 = await request('catalog.favorite.autoscan', {})
  check('越界设置后间隔保持不变', g3.intervalHours === 0, `intervalHours=${g3.intervalHours}`)
  const g4 = await request('catalog.favorite.autoscan', { intervalHours: 6 })
  check('恢复默认 6h', g4.intervalHours === 6, `intervalHours=${g4.intervalHours}`)

  // ============ C 继续观看进度 ============
  console.log(`\n${DIM}—— C 继续观看（进度读写）——${RESET}`)
  const epUrl = snap.sources[0].episodes[2].url
  const epName = snap.sources[0].episodes[2].name
  const w1 = await request('catalog.favorite.progress.set', {
    favoriteId: favId,
    episodeName: epName,
    episodeUrl: epUrl,
    position: 300,
    duration: 2400
  })
  check('进度写入成功', w1.saved === true)

  const p1 = await request('catalog.progress.list', { limit: 10 })
  const row1 = p1.items.find((i) => i.favoriteId === favId)
  check('继续观看列表含该收藏（JOIN 补片名/海报字段）', !!row1 && row1.favoriteName === '星球A', row1?.favoriteName ?? '缺')
  check('进度字段正确（300s / 2400s）', row1?.positionSec === 300 && row1?.durationSec === 2400, `${row1?.positionSec}/${row1?.durationSec}`)
  check('记录当前集', row1?.episodeName === epName && row1?.episodeUrl === epUrl, row1?.episodeName)

  await request('catalog.favorite.progress.set', {
    favoriteId: favId,
    episodeName: epName,
    episodeUrl: epUrl,
    position: 900,
    duration: 2400
  })
  const p2 = await request('catalog.progress.list', { limit: 10 })
  const row2 = p2.items.find((i) => i.favoriteId === favId)
  check('覆盖写（每收藏一条，位置更新为 900s）', p2.items.filter((i) => i.favoriteId === favId).length === 1 && row2?.positionSec === 900, `${row2?.positionSec}s`)

  const favRow = (await request('catalog.favorite.list')).favorites.find((f) => f.id === favId)
  check('进度上报顺带刷新 lastPlayedAt', typeof favRow?.lastPlayedAt === 'number' && favRow.lastPlayedAt > 0, `${favRow?.lastPlayedAt}`)

  // ============ D 参数校验 ============
  console.log(`\n${DIM}—— D 参数校验 ——${RESET}`)
  let e1 = ''
  try {
    await request('catalog.favorite.progress.set', { favoriteId: favId, episodeName: 'x', position: 1 })
  } catch (e) {
    e1 = e.message
  }
  check('缺 episodeUrl 报参数错误', /episodeUrl required/.test(e1), e1)

  let e2 = ''
  try {
    await request('catalog.favorite.progress.set', {
      favoriteId: 'not-exist',
      episodeName: 'x',
      episodeUrl: 'http://a/1.m3u8',
      position: 1,
      duration: 10
    })
  } catch (e) {
    e2 = e.message
  }
  check('不存在的收藏写进度报错', /收藏不存在/.test(e2), e2)

  // ============ E P11 TMDB 评分增强 ============
  console.log(`\n${DIM}—— E TMDB 评分增强 ——${RESET}`)
  const t0 = await request('catalog.tmdb.get')
  check('TMDB Key 初始为空', t0.key === '', JSON.stringify(t0))
  await request('catalog.tmdb.set', { key: 'smoke-key-123' })
  const t1 = await request('catalog.tmdb.get')
  check('TMDB Key 保存回读', t1.key === 'smoke-key-123', t1.key)
  await request('catalog.tmdb.set', { key: '' })
  const t2 = await request('catalog.tmdb.get')
  check('TMDB Key 传空串清除', t2.key === '')
  const t3 = await request('catalog.tmdb.lookup', { name: '星球A', year: '2025' })
  check('未配置 Key 时 lookup 静默降级（不请求外网）', t3.found === false && t3.reason === 'no-key', JSON.stringify(t3))

  // ---- G2 P13 热门榜叠加 TMDB 人气（PF_TMDB_API 已指向本地假站）----
  console.log(`\n${DIM}—— G2 热门榜叠加 TMDB 人气 ——${RESET}`)
  // 重新挂二号站（subset：星球01–10 双站收录），制造「同分片 + 人气加权」场景
  const origin2b = startCmsOrigin({ subset: true })
  origins.push(origin2b)
  const api2b = await origin2b.start()
  await request('catalog.source.add', { name: '冒烟站P9二号', api: api2b })
  await request('catalog.tmdb.set', { key: 'smoke-key-123' })
  const gh = await request('catalog.category', { pg: 1, sort: 'hot' })
  // 假站只给「星球05」popularity=500 → +20 加权，双站同分片中稳居第一
  check('人气加权：星球05（+20）跃居热门榜第一', gh.cards[0]?.name === '星球05', `top1=${gh.cards[0]?.name}`)
  check(
    '人气条目随卡片下发（popularity=500 / rating=9.1）',
    gh.cards[0]?.tmdb?.popularity === 500 && gh.cards[0]?.tmdb?.rating === 9.1,
    JSON.stringify(gh.cards[0]?.tmdb)
  )
  check('未命中 TMDB 的卡片不带人气字段', gh.cards.every((c) => c.name === '星球05' || !c.tmdb))
  // 二次请求走 24h 缓存（结果一致即可，命中路径无异常）
  const gh2 = await request('catalog.category', { pg: 1, sort: 'hot' })
  check('人气缓存命中：二次请求排序一致', gh2.cards[0]?.name === '星球05', `top1=${gh2.cards[0]?.name}`)
  await request('catalog.tmdb.set', { key: '' })
  const gh3 = await request('catalog.category', { pg: 1, sort: 'hot' })
  check(
    '清除 Key 后热门榜回到纯站数排序（无 tmdb 字段）',
    gh3.cards.every((c) => !c.tmdb) && gh3.cards.findIndex((c) => c.name === '剧A') === 10,
    `剧A 位次 ${gh3.cards.findIndex((c) => c.name === '剧A')}`
  )
  await request('catalog.source.remove', { id: (await request('catalog.source.list')).sources.find((s) => s.name === '冒烟站P9二号').id })
  origin2b.close()

  // ============ F 清理 ============
  console.log(`\n${DIM}—— F 清理 ——${RESET}`)
  await request('catalog.favorite.remove', { id: favId })
  const p3 = await request('catalog.progress.list', { limit: 10 })
  check('删收藏级联清进度', !p3.items.some((i) => i.favoriteId === favId))
  await request('catalog.source.remove', { id: srcId })
  const left = await request('catalog.source.list')
  check('源站已清理', left.sources.filter((s) => s.name === '冒烟站P9').length === 0)
} catch (e) {
  check('未捕获异常', false, e.stack ?? e.message)
} finally {
  for (const o of origins) o.close()
  tmdbHandle?.close()
  if (proc) proc.kill()
  const passed = results.filter((r) => r.ok).length
  const total = results.length
  console.log(`\n${passed === total ? GREEN : RED}P9 冒烟：${passed}/${total}${RESET}\n`)
  process.exit(passed === total ? 0 : 1)
}
