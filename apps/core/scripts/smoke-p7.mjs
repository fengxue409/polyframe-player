/**
 * P7 无头冒烟测试：影视发现与片源聚合（CMS 采集站）
 *  A. 源站管理：core.hello 带 proxyToken / 出厂内置 5 源 / add 探测入库 / 重复拒绝
 *     / 测速回写 / 启停 / 删除
 *  B. 聚合搜索：双 CMS origin 同名影片聚合 sourceCount=2（normalize+year）；
 *     仅支持 videolist 的站走 fallback；不可达站进 failures
 *  C. 详情：ac=detail&ids → 分组剧集（m3u8 / xigua 两组）
 *  D. 收藏：card 聚合收藏（≤3 站详情合并）→ 二站 detail 归并同收藏
 *     → sources 快照 → 手动补充（名称$URL#… + 裸 URL 混合）→ touch 最近播放
 *     → 移除片源 / 移除收藏
 *  E. /pic 海报透传：token 门禁 + 字节一致 + Referer 同源防盗链
 *
 * 运行：node apps/core/scripts/smoke-p7.mjs（需先 pnpm core:build）
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import crypto from 'node:crypto'
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

const httpGet = (url, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = http.get(url, { headers, timeout: 15000 }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }))
    })
    req.on('timeout', () => req.destroy(new Error('http 超时')))
    req.on('error', reject)
  })

/** 假 CMS origin（苹果CMS V10 API）
 *  mode: 'full'（detail+videolist 均支持）| 'fallback-only'（detail&wd 空，走 videolist）
 */
function startCmsOrigin(name, mode) {
  const state = { probeHits: 0, searchHits: 0, fallbackHits: 0, detailHits: 0, picHits: 0, picReferer: '' }
  const poster = Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082',
    'hex'
  )
  const item = (vodId) => ({
    vod_id: vodId,
    vod_name: '流浪地球',
    type_name: '科幻片',
    vod_remarks: 'HD中字',
    vod_pic: '',
    vod_year: '2023',
    vod_actor: '吴京,刘德华',
    vod_director: '郭帆',
    vod_content: '<p>太阳即将毁灭，人类启动流浪地球计划。</p>',
    vod_time: '2024-05-01 12:00:00'
  })
  const origin = http.createServer((req, res) => {
    const u = new URL(req.url || '/', `http://127.0.0.1`)
    if (u.pathname === '/p1.jpg') {
      state.picHits++
      state.picReferer = req.headers.referer ?? ''
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': poster.length })
      res.end(poster)
      return
    }
    if (!u.pathname.endsWith('/provide/vod')) {
      res.writeHead(404).end()
      return
    }
    const ac = u.searchParams.get('ac')
    const vodId = name === '站点A' ? '9' : '77'
    if (ac === 'list') {
      state.probeHits++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 1, page: 1, pagecount: 1, total: 1, list: [{ vod_id: 1, vod_name: '样本' }] }))
      return
    }
    if (ac === 'detail' && u.searchParams.get('wd')) {
      state.searchHits++
      if (mode === 'fallback-only') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 1, list: [] }))
        return
      }
      const it = item(vodId)
      it.vod_pic = `http://127.0.0.1:${originPort}/p1.jpg`
      it.vod_play_from = 'm3u8$$$xigua'
      it.vod_play_url =
        `第01集$http://127.0.0.1:${originPort}/s1.m3u8#第02集$http://127.0.0.1:${originPort}/s2.m3u8$$$第01集$http://127.0.0.1:${originPort}/x1.mp4`
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 1, list: [it] }))
      return
    }
    if (ac === 'videolist' && u.searchParams.get('wd')) {
      state.fallbackHits++
      const it = item(vodId)
      it.vod_pic = `http://127.0.0.1:${originPort}/p1.jpg`
      it.vod_play_from = 'm3u8'
      it.vod_play_url = `第01集$http://127.0.0.1:${originPort}/f1.m3u8`
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 1, list: [it] }))
      return
    }
    if (ac === 'detail' && u.searchParams.get('ids')) {
      state.detailHits++
      const it = item(vodId)
      it.vod_pic = `http://127.0.0.1:${originPort}/p1.jpg`
      it.vod_play_from = 'm3u8$$$xigua'
      it.vod_play_url =
        `第01集$http://127.0.0.1:${originPort}/s1.m3u8#第02集$http://127.0.0.1:${originPort}/s2.m3u8$$$第01集$http://127.0.0.1:${originPort}/x1.mp4`
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 1, list: [it] }))
      return
    }
    res.writeHead(404).end()
  })
  let originPort = 0
  return {
    state,
    start: () =>
      new Promise((resolve) => {
        origin.listen(0, '127.0.0.1', () => {
          originPort = origin.address().port
          resolve({ url: `http://127.0.0.1:${originPort}/api.php/provide/vod`, port: originPort })
        })
      }),
    close: () => origin.close()
  }
}

/** 启动内核并等待端口发现 */
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
    const timer = setTimeout(() => reject(new Error('等待 PF_CORE_PORT 超时')), 15000)
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

let rpcToken = '' // H2：pf-core stdout 端口发现一并下发的连接鉴权 token
async function connectRpc(port) {
  const socket = net.connect(port, '127.0.0.1')
  socket.write('PF_AUTH ' + rpcToken + '\n') // H2 连接鉴权（首行）
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  socket.setNoDelay(true)
  const pending = new Map()
  let lineBuf = ''
  let nextId = 1
  socket.on('data', (d) => {
    lineBuf += d.toString()
    let idx
    while ((idx = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, idx).trim()
      lineBuf = lineBuf.slice(idx + 1)
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
      }, 60000)
      pending.set(id, { resolve, reject, timer })
      socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  return { socket, request }
}

let proc = null
const extra = []
let request = null

try {
  const bin = binCandidates.find((p) => existsSync(p))
  console.log(`${DIM}启动内核: ${bin}${RESET}`)
  const first = startCore({ LOCALAPPDATA: path.join(process.env.TEMP ?? '.', `pf-smoke-p7-${process.pid}`) })
  proc = first.proc
  const port = await first.portReady
  ;({ request } = await connectRpc(port))

  // ================= A 轮：源站管理 =================
  console.log(`\n${DIM}—— A 轮：源站管理 ——${RESET}`)

  const hello = await request('core.hello')
  check(
    'core.hello 带 proxyToken + proxyPort',
    typeof hello?.proxyToken === 'string' && hello.proxyToken.length >= 8 && hello.proxyPort > 0,
    `token=${String(hello?.proxyToken).slice(0, 6)}… port=${hello?.proxyPort}`
  )
  const proxyPort = hello.proxyPort
  const token = hello.proxyToken

  const list0 = await request('catalog.source.list')
  check(
    '出厂内置预设源播种（builtin=true）',
    list0?.sources?.length >= 5 && list0.sources.every((s) => s.builtin),
    `count=${list0?.sources?.length}`
  )

  // 停用内置源（隔离真实网络）
  for (const s of list0.sources) {
    await request('catalog.source.update', { id: s.id, enabled: false })
  }

  const cmsA = startCmsOrigin('站点A', 'full')
  const cmsB = startCmsOrigin('站点B', 'fallback-only')
  const a = await cmsA.start()
  const b = await cmsB.start()
  extra.push(cmsA, cmsB)

  const addA = await request('catalog.source.add', { name: '站点A', api: a.url })
  check(
    'catalog.source.add 探测成功入库（latency 回写）',
    addA?.source?.id && addA?.source?.builtin === false && addA?.probe?.ok === true && addA?.probe?.samples === 1,
    `latency=${addA?.probe?.latencyMs}ms samples=${addA?.probe?.samples}`
  )
  const idA = addA.source.id
  const addB = await request('catalog.source.add', { name: '站点B', api: b.url })
  const idB = addB.source.id

  let dupRejected = false
  try {
    await request('catalog.source.add', { name: '重复站', api: a.url })
  } catch (e) {
    dupRejected = String(e.message).includes('已存在')
  }
  check('重复 API 拒绝', dupRejected)

  const badRejected = await request('catalog.source.add', { name: '坏站', api: 'http://127.0.0.1:1/api.php/provide/vod' }).then(
    () => false,
    (e) => String(e.message).includes('探测失败')
  )
  check('不可达源站探测失败拒绝入库', badRejected === true)

  const test1 = await request('catalog.source.test', { id: idA })
  check(
    'catalog.source.test 计时回写',
    test1?.probe?.ok === true && test1.probe.latencyMs >= 0,
    `${test1?.probe?.latencyMs}ms`
  )
  const listAfterTest = await request('catalog.source.list')
  const rowA = listAfterTest.sources.find((s) => s.id === idA)
  check('测速后 latencyMs/lastOkAt 落库', rowA?.latencyMs != null && rowA?.lastOkAt != null)

  // ================= B 轮：聚合搜索 =================
  console.log(`\n${DIM}—— B 轮：聚合搜索 ——${RESET}`)

  const search1 = await request('catalog.search', { q: '流浪地球' })
  const card = search1?.cards?.[0]
  check(
    '聚合搜索：双站同名影片归并 sourceCount=2',
    search1?.cards?.length === 1 &&
      card?.sourceCount === 2 &&
      card?.entries?.length === 2 &&
      card.key === '流浪地球|2023',
    `cards=${search1?.cards?.length} sources=${card?.sourceCount}`
  )
  check(
    '卡片字段完整（name/year/typeName/remarks/poster）',
    card?.name === '流浪地球' && card.year === '2023' && card.typeName === '科幻片' && card.remarks === 'HD中字' && !!card.poster,
    `poster=${String(card?.poster).slice(0, 40)}…`
  )
  check(
    '站点B ac=detail 空 → ac=videolist fallback 生效',
    cmsB.state.fallbackHits >= 1,
    `fallbackHits=${cmsB.state.fallbackHits}`
  )
  check(
    '不可达源站进 failures（内置 5 停用不参与，坏站已拒绝入库 → failures 为空）',
    Array.isArray(search1?.failures) && search1.failures.length === 0,
    `failures=${JSON.stringify(search1?.failures)}`
  )
  const search2 = await request('catalog.search', { q: '  流浪  地球  ' })
  check('搜索词空白归一仍命中同一聚合键', search2?.cards?.[0]?.key === '流浪地球|2023')

  // ================= C 轮：详情 =================
  console.log(`\n${DIM}—— C 轮：单站详情 ——${RESET}`)
  const det = await request('catalog.detail', { api: a.url, vodId: '9', sourceId: idA })
  const d = det?.detail
  check(
    '详情分组剧集（m3u8 两集 + xigua 一集）',
    d?.groups?.length === 2 &&
      d.groups[0].from === 'm3u8' &&
      d.groups[0].episodes.length === 2 &&
      d.groups[1].from === 'xigua' &&
      d.groups[1].episodes.length === 1,
    `groups=${d?.groups?.length}`
  )
  check(
    '详情元数据（year/actor/director/content/updateTime）',
    d?.year === '2023' && d.actor?.includes('吴京') && d.director === '郭帆' && d.content?.includes('流浪') && d.updateTime === '2024-05-01 12:00:00'
  )

  // ================= D 轮：收藏合并 + 手动补充 =================
  console.log(`\n${DIM}—— D 轮：收藏合并 + 手动补充 ——${RESET}`)

  const fav1 = await request('catalog.favorite.add', { card })
  check(
    'card 收藏：聚合详情并入（sourceCount≥2）',
    fav1?.favorite?.id && fav1.favorite.name === '流浪地球' && fav1.favorite.sourceCount >= 2,
    `sourceCount=${fav1?.favorite?.sourceCount}`
  )
  const favId = fav1.favorite.id

  // 同名同年级再收一站详情 → 站点B 已随 card 聚合入库（CAP=3 拉了 2 站），
  // 重复 detail 归并应触发同站去重（sourceCount 不变）
  const detB = await request('catalog.detail', { api: b.url, vodId: '77' })
  const fav2 = await request('catalog.favorite.add', { detail: detB.detail })
  check(
    '二站 detail 收藏归并同收藏（同站同 vodId 去重不重复插入）',
    fav2?.favorite?.id === favId && fav2.favorite.sourceCount === fav1.favorite.sourceCount,
    `sourceCount=${fav2?.favorite?.sourceCount}`
  )

  const srcs = await request('catalog.favorite.sources', { id: favId })
  check(
    '片源快照（episodes JSON 还原 + origin=search）',
    srcs?.sources?.length === fav2.favorite.sourceCount &&
      srcs.sources.every((s) => Array.isArray(s.episodes) && s.episodes.length > 0 && s.origin === 'search'),
    `count=${srcs?.sources?.length}`
  )

  const manual = await request('catalog.favorite.source.add', {
    favoriteId: favId,
    urls: `第01集$http://127.0.0.1:1/m1.m3u8#第02集$http://127.0.0.1:1/m2.m3u8\nhttp://127.0.0.1:1/m3.mp4`,
    label: '手动补充'
  })
  check(
    '手动补充：名称$URL#… + 裸 URL 混合解析 3 集（origin=manual）',
    manual?.source?.id &&
      manual.source.episodes?.length === 3 &&
      manual.source.episodes[2].name === '第3集' &&
      manual.source.origin === 'manual',
    `eps=${manual?.source?.episodes?.length}`
  )

  await request('catalog.favorite.touch', { id: favId })
  const favList = await request('catalog.favorite.list')
  check(
    'touch 后 lastPlayedAt 落库且列表置顶',
    favList?.favorites?.[0]?.id === favId && favList.favorites[0].lastPlayedAt > 0
  )

  const rmSrc = await request('catalog.favorite.source.remove', { sourceId: manual.source.id })
  const srcsAfter = await request('catalog.favorite.sources', { id: favId })
  check(
    '移除手动片源',
    rmSrc?.removed === true && srcsAfter?.sources?.length === fav2.favorite.sourceCount
  )

  // ================= E 轮：/pic 海报透传 =================
  console.log(`\n${DIM}—— E 轮：/pic 海报透传 ——${RESET}`)
  const posterUrl = `http://127.0.0.1:${a.port}/p1.jpg`
  const pic = await httpGet(`http://127.0.0.1:${proxyPort}/pic/${token}?u=${encodeURIComponent(posterUrl)}`)
  check(
    '/pic 透传 200 + 字节一致 + content-type',
    pic.status === 200 && pic.body.length > 0 && pic.headers['content-type'] === 'image/png',
    `${pic.body.length}B ct=${pic.headers['content-type']}`
  )
  const noToken = await httpGet(`http://127.0.0.1:${proxyPort}/pic/wrongtoken?u=${encodeURIComponent(posterUrl)}`)
  check('/pic token 门禁（错误 token 403）', noToken.status === 403)
  check(
    'Referer 同源防盗链（pic client 注入源站 host）',
    cmsA.state.picReferer === `http://127.0.0.1:${a.port}/`,
    `referer=${cmsA.state.picReferer}`
  )

  // ================= 收尾：删除收藏 / 删除源站 =================
  const rmFav = await request('catalog.favorite.remove', { id: favId })
  const favEmpty = await request('catalog.favorite.list')
  const rmSrc2 = await request('catalog.source.remove', { id: idA })
  const listEnd = await request('catalog.source.list')
  check(
    '收藏/源站级联删除',
    rmFav?.removed === true &&
      favEmpty?.favorites?.length === 0 &&
      rmSrc2?.removed === true &&
      // 基线（出厂预设数）+1：A 已删，B 仍在
      listEnd.sources.length === list0.sources.length + 1,
    `sources=${listEnd?.sources?.length}`
  )
} catch (e) {
  console.error(`\n${RED}冒烟异常中断: ${e.message}${RESET}`)
  results.push({ name: '无异常中断', ok: false })
} finally {
  try {
    proc?.kill()
  } catch {}
  for (const x of extra) {
    try {
      x.close?.()
    } catch {}
  }
}

const pass = results.filter((r) => r.ok).length
console.log(`\n${DIM}———————${RESET}`)
console.log(`  ${GREEN}${pass} 通过${RESET} / ${RED}${results.length - pass} 失败${RESET} / 共 ${results.length} 项`)
process.exit(pass === results.length ? 0 : 1)
