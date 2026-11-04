/**
 * P10 无头冒烟测试：视频云解析（解析接口管理 / 三段式解析 / 失效识别）
 *  A. 预设播种：新装即有 7 个接口（含 direct:// 内置嗅探哨兵）
 *  B. 增删改：新增即测活、重复接口拒绝、停用、删除
 *  C. 三段式解析之一：JSON 接口直接给直链 → kind=direct / via=json
 *  D. 三段式解析之二：HTML 里转义内嵌的 m3u8 → kind=direct / via=html
 *  E. 三段式解析之三：HTML 播放页无直链 → kind=page + frameable 判定
 *  F. 失效识别：关停公告页 → 明确报「接口已关停」而不是「解析失败」
 *  G. 输入即直链 / 非法地址 / 直连嗅探（direct://）
 *  H. 拿到直链后建任务（走本地代理），playUrl 可用
 *
 * 全部使用本地假 origin，不依赖外网。
 * 运行：node apps/core/scripts/smoke-p10.mjs（需先 pnpm core:build）
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
 * 假解析站点：
 *  /json?url=  → JSON 直链
 *  /html?url=  → HTML 里内嵌转义 m3u8（模拟页面 JS 写死源）
 *  /page?url=  → 有播放器、但直链在 JS 里动态请求（无直链，且禁 iframe）
 *  /dead?url=  → 关停公告页
 *  /media/ep.m3u8 → 可播的最小 playlist（用于建任务验证）
 */
function startParseOrigin() {
  const hits = { json: 0, html: 0, page: 0, dead: 0, media: 0 }
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1')
    const base = `http://127.0.0.1:${server.address().port}`
    if (u.pathname === '/json') {
      hits.json++
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(
        JSON.stringify({
          code: 200,
          msg: 'ok',
          data: { url: `${base}/media/ep.m3u8?token=abc`, poster: `${base}/pic.jpg` }
        })
      )
      return
    }
    if (u.pathname === '/html') {
      hits.html++
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      // 真实接口常见形态：JSON 转义 + 二次编码混排
      res.end(`<html><body><script>
        var cfg = {"url":"http:\\/\\/${base.replace('http://', '')}\\/media\\/ep.m3u8?src=html"};
      </script></body></html>`)
      return
    }
    if (u.pathname === '/page') {
      hits.page++
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Frame-Options': 'SAMEORIGIN'
      })
      res.end(`<html><head><title>播放器</title></head><body>
        <div id="player"></div>
        <script src="/static/dplayer.min.js"></script>
        <script>new Player({container:'#player', url: 'about:blank'})</script>
      </body></html>`)
      return
    }
    if (u.pathname === '/dead') {
      hits.dead++
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><body><h1>江湖路远，后会无期</h1></body></html>')
      return
    }
    if (u.pathname === '/media/ep.m3u8') {
      hits.media++
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' })
      res.end(
        [
          '#EXTM3U',
          '#EXT-X-VERSION:3',
          '#EXT-X-TARGETDURATION:4',
          '#EXT-X-MEDIA-SEQUENCE:0',
          '#EXTINF:4.0,',
          'seg0.ts',
          '#EXT-X-ENDLIST',
          ''
        ].join('\n')
      )
      return
    }
    if (u.pathname === '/media/seg0.ts') {
      hits.media++
      res.writeHead(200, { 'Content-Type': 'video/mp2t' })
      res.end(Buffer.alloc(188 * 20))
      return
    }
    res.writeHead(404).end()
  })
  let origin = ''
  return {
    hits,
    start: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          origin = `http://127.0.0.1:${server.address().port}`
          resolve(origin)
        })
      }),
    get origin() {
      return origin
    },
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
      }, 60000)
      pending.set(id, { resolve, reject, timer })
      socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  return { socket, request }
}

let proc = null
const origins = []

try {
  const bin = binCandidates.find((p) => existsSync(p))
  console.log(`${DIM}启动内核: ${bin}${RESET}`)
  const first = startCore({ LOCALAPPDATA: path.join(process.env.TEMP ?? '.', `pf-smoke-p10-${process.pid}`) })
  proc = first.proc
  const port = await first.portReady
  const { request } = connectRpc(port)
  await request('core.hello')

  const origin = startParseOrigin()
  origins.push(origin)
  const base = await origin.start()

  // ============ A 预设播种 ============
  console.log(`\n${DIM}—— A 预设播种 ——${RESET}`)
  const list0 = await request('parse.service.list')
  check('新装播种预置接口', list0.services.length >= 6, `${list0.services.length} 个`)
  check('含 direct:// 内置嗅探哨兵', list0.services.some((s) => s.api === 'direct://'))
  check('出参带 presetsVersion', typeof list0.presetsVersion === 'number', `v${list0.presetsVersion}`)
  const pre = await request('parse.service.presets')
  check(
    '预设列表 installed 标记与库一致',
    pre.presets.every((p) => typeof p.installed === 'boolean') &&
      pre.presets.filter((p) => p.installed).length === list0.services.length,
    `${pre.presets.filter((p) => p.installed).length}/${pre.presets.length}`
  )

  // ============ B 增删改 ============
  console.log(`\n${DIM}—— B 接口增删改 ——${RESET}`)
  const addJson = await request('parse.service.add', { name: '冒烟JSON', api: `${base}/json?url=` })
  check('新增即测活通过', addJson.probe.ok === true && addJson.probe.latencyMs >= 0, JSON.stringify(addJson.probe))
  const jsonId = addJson.service.id
  check('测活延迟已回写', addJson.service.lastOkAt !== null)

  let dupErr = ''
  try {
    await request('parse.service.add', { name: '重复', api: `${base}/json?url=` })
  } catch (e) {
    dupErr = e.message
  }
  check('同地址重复添加被拒', dupErr.includes('已存在'), dupErr)

  const bad = await request('parse.service.add', { name: '坏接口', api: `${base}/dead?url=` })
  check('关停接口：入库但测活失败并说明原因', bad.probe.ok === false && /关停/.test(bad.probe.error ?? ''), bad.probe.error)
  const deadId = bad.service.id

  // ============ C JSON 直链 ============
  console.log(`\n${DIM}—— C 解析：JSON 直链 ——${RESET}`)
  const page = 'https://v.qq.com/x/cover/smoke.html'
  const rJson = await request('parse.resolve', { url: page, serviceId: jsonId })
  check('kind=direct', rJson.kind === 'direct', rJson.kind)
  check('via=json（识别为 JSON 接口）', rJson.via === 'json', rJson.via)
  check('直链指向假 m3u8', (rJson.playUrl ?? '').includes('/media/ep.m3u8'), rJson.playUrl)
  check('候选里不含图片', !(rJson.candidates ?? []).some((u) => u.endsWith('.jpg')), JSON.stringify(rJson.candidates))
  check('接口地址已正确编码页面', (rJson.parseUrl ?? '').includes(encodeURIComponent(page)), rJson.parseUrl)
  check('回显耗时', typeof rJson.latencyMs === 'number')
  check('假接口被真正请求', origin.hits.json > 0, `${origin.hits.json} 次`)

  // ============ D HTML 内嵌直链 ============
  console.log(`\n${DIM}—— D 解析：HTML 转义直链 ——${RESET}`)
  await request('parse.service.add', { name: '冒烟HTML', api: `${base}/html?url=` })
  const list1 = await request('parse.service.list')
  const htmlId = list1.services.find((s) => s.name === '冒烟HTML').id
  const rHtml = await request('parse.resolve', { url: page, serviceId: htmlId })
  check('kind=direct', rHtml.kind === 'direct', rHtml.kind)
  check('via=html', rHtml.via === 'html', rHtml.via)
  check('反斜杠转义已还原', (rHtml.playUrl ?? '').includes('/media/ep.m3u8'), rHtml.playUrl)

  // ============ E HTML 播放页（无直链 + 禁内嵌） ============
  console.log(`\n${DIM}—— E 解析：播放页（禁内嵌） ——${RESET}`)
  await request('parse.service.add', { name: '冒烟PAGE', api: `${base}/page?url=` })
  const list2 = await request('parse.service.list')
  const pageId = list2.services.find((s) => s.name === '冒烟PAGE').id
  const rPage = await request('parse.resolve', { url: page, serviceId: pageId })
  check('kind=page', rPage.kind === 'page', rPage.kind)
  check('识别 X-Frame-Options: SAMEORIGIN → 不可内嵌', rPage.frameable === false, String(rPage.frameable))
  check('识别出页面有播放器', rPage.playerLike === true, String(rPage.playerLike))
  check('给出可读说明', typeof rPage.note === 'string' && rPage.note.length > 0, rPage.note)

  // ============ F 关停识别 ============
  console.log(`\n${DIM}—— F 失效识别 ——${RESET}`)
  let deadErr = ''
  try {
    await request('parse.resolve', { url: page, serviceId: deadId })
  } catch (e) {
    deadErr = e.message
  }
  check('关停接口报「已关停」而非「解析失败」', /已关停/.test(deadErr), deadErr)
  check('错误信息带特征串', /江湖路远/.test(deadErr), deadErr)

  // ============ G 输入即直链 / 非法地址 / 直连嗅探 ============
  console.log(`\n${DIM}—— G 边界 ——${RESET}`)
  const rDirect = await request('parse.resolve', {
    url: `${base}/media/ep.m3u8?token=1`,
    serviceId: jsonId
  })
  check('输入即直链：via=input 且不打接口', rDirect.via === 'input', rDirect.via)
  const hitsBefore = origin.hits.json
  check('未触发接口请求', origin.hits.json === hitsBefore)

  let badErr = ''
  try {
    await request('parse.resolve', { url: '庆余年' })
  } catch (e) {
    badErr = e.message
  }
  check('非法地址被拒', /合法/.test(badErr), badErr)

  const rSniff = await request('parse.resolve', { url: page })
  check('未选接口 → 直连嗅探模式（kind=page 且不拼接口）', rSniff.kind === 'page' && !rSniff.parseUrl, JSON.stringify({ k: rSniff.kind, p: rSniff.parseUrl }))

  // ============ H 直链 → 任务（本地代理） ============
  console.log(`\n${DIM}—— H 直链起播 ——${RESET}`)
  const mediaUrl = `${base}/media/ep.m3u8`
  const created = await request('task.create', { url: mediaUrl, title: '冒烟解析', cacheMode: 'online' })
  check('任务创建成功', !!created.task?.id, created.task?.id)
  check('playUrl 指向本地代理', (created.task?.playUrl ?? '').includes('/m3u8/'), created.task?.playUrl)
  await new Promise((r) => setTimeout(r, 1200))
  check('代理已回源播放列表', origin.hits.media > 0, `${origin.hits.media} 次媒体请求`)
  await request('task.delete', { taskId: created.task.id }).catch(() => {})

  // ============ 清理 ============
  for (const s of [jsonId, deadId, htmlId, pageId]) {
    await request('parse.service.remove', { id: s }).catch(() => {})
  }
  const listEnd = await request('parse.service.list')
  check(
    '清理后只剩预设接口',
    listEnd.services.every((s) => s.builtin),
    `${listEnd.services.length} 个`
  )
} catch (e) {
  check('未捕获异常', false, e.message)
} finally {
  for (const o of origins) o.close()
  if (proc) proc.kill()
  const passed = results.filter((r) => r.ok).length
  const total = results.length
  console.log(`\n${passed === total ? GREEN : RED}P10 冒烟：${passed}/${total}${RESET}\n`)
  process.exit(passed === total ? 0 : 1)
}
