/**
 * P14 弹幕冒烟测试（无头，全部本地假 origin，不依赖外网）
 *
 * 覆盖范围：
 *  A. 设置读写与区间夹取（越界值、局部更新、缺失字段兼容）
 *  B. 凭据保存 + 弹弹play 签名正确性（服务端用 node crypto 独立验算）
 *  C. 频道绑定 / 拉取 / 缓存命中 / 强制重拉去重
 *  D. 第三方数据解析（模式码、十进制颜色、脏条目过滤、时间精度）
 *  E. 本地发送的限流与去重（重复内容、连点、空、超长、边界长度）
 *  F. 频道清理与删除
 *  G. ASS 导出（libmpv 内核渲染路径）
 *  H. 异常场景（无凭据 / 网络失败 / 搜索无结果 / 鉴权失败）不得挂死
 *  I. 并发与高密度（20 并发拉取 + 9000 条入库）
 *
 * 运行：node apps/core/scripts/smoke-p14.mjs（需先 pnpm core:build）
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import http from 'node:http'
import { existsSync } from 'node:fs'
import fs from 'node:fs'
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
const section = (t) => console.log(`\n${t}`)

const APP_ID = 'pf-smoke-app'
const APP_SECRET = 'pf-smoke-secret'

// ---------------------------------------------------------------- 假弹弹play origin

/**
 * 模拟 dandanplay v2：
 *  - /api/v2/search/episodes   搜索（可按 state.searchMode 切换 ok/empty/auth/500）
 *  - /api/v2/comment/{id}      拉弹幕
 * 并用 node crypto **独立验算** X-Signature，用来验证 Rust 侧签名实现是否符合
 * `Base64(SHA256(AppId + Timestamp + Path + AppSecret))`。
 */
function startDpOrigin(opts = {}) {
  const state = {
    searchMode: 'ok',
    searchCalls: 0,
    commentCalls: 0,
    signChecked: 0,
    signFailures: [],
    /** 每次 comment 请求的 episodeId */
    commentIds: [],
    /** 每次搜索请求的 anime / episode 参数（验证 match 的 query 覆盖） */
    searchQueries: [],
    searchEpisodes: [],
    /** 拉取到的弹幕（可被测试改写） */
    comments: opts.comments ?? [
      { cid: 1, p: '1.5,1,16777215,abc', m: '第一条' },
      { cid: 2, p: '10,5,16711680,abc', m: '顶部红色' },
      { cid: 3, p: '20,4,255,abc', m: '底部蓝色' }
    ],
    /** 让 comment 接口延迟返回（并发测试用） */
    commentDelayMs: opts.commentDelayMs ?? 0,
    episodeId: opts.episodeId ?? 1001
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${server.address().port}`)
    const send = (code, body, extra = {}) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...extra })
      res.end(JSON.stringify(body))
    }

    // ---- 签名校验（每次请求都验）----
    const appId = req.headers['x-appid']
    const ts = req.headers['x-timestamp']
    const sig = req.headers['x-signature']
    if (!appId || !ts || !sig) {
      state.signFailures.push(`missing headers on ${url.pathname}`)
      return send(401, { success: false, errorCode: 401, errorMessage: 'unauthorized' })
    }
    const expected = crypto
      .createHash('sha256')
      .update(`${appId}${ts}${url.pathname}${APP_SECRET}`)
      .digest('base64')
    state.signChecked++
    if (appId !== APP_ID || expected !== sig) {
      state.signFailures.push(`bad signature on ${url.pathname}`)
      return send(401, { success: false, errorCode: 401, errorMessage: 'unauthorized' })
    }

    if (url.pathname === '/api/v2/search/episodes') {
      state.searchCalls++
      state.searchQueries.push(url.searchParams.get('anime') ?? '')
      state.searchEpisodes.push(url.searchParams.get('episode') ?? '')
      if (state.searchMode === 'auth') return send(403, { success: false, errorCode: 403 })
      if (state.searchMode === 'boom') return send(500, { success: false })
      if (state.searchMode === 'empty') {
        return send(200, { success: true, hasMore: false, animes: [] })
      }
      return send(200, {
        success: true,
        hasMore: false,
        animes: [
          {
            animeId: 9,
            animeTitle: '测试番剧',
            type: 'tvseries',
            typeDescription: 'TV动画',
            episodes: [{ episodeId: state.episodeId, episodeTitle: '第1话' }]
          }
        ]
      })
    }

    const m = url.pathname.match(/^\/api\/v2\/comment\/(\d+)$/)
    if (m) {
      state.commentCalls++
      state.commentIds.push(Number(m[1]))
      const body = { count: state.comments.length, comments: state.comments }
      if (state.commentDelayMs > 0) {
        setTimeout(() => send(200, body), state.commentDelayMs)
        return
      }
      return send(200, body)
    }

    send(404, { success: false })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({
        port,
        base: `http://127.0.0.1:${port}`,
        state,
        close: () => new Promise((r) => server.close(r))
      })
    })
  })
}

// ---------------------------------------------------------------- 内核进程 + RPC

let rpcPort = 0
/** 内核 stderr（panic / 连接错误诊断用） */
let coreStderr = ''
/** 内核 stdout 一并下发的连接鉴权 token（首行 PF_AUTH 用） */
let rpcToken = ''

function startCore(envOverride = {}) {
  const bin = binCandidates.find((p) => existsSync(p))
  if (!bin) throw new Error('未找到 pf-core.exe，请先执行 pnpm core:build')
  const proc = spawn(bin, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...envOverride }
  })
  const ready = new Promise((resolve, reject) => {
    let buf = ''
    let done = false
    const timer = setTimeout(() => reject(new Error('等待 PF_CORE_PORT 超时')), 25000)
    const onData = (d) => {
      buf += d.toString()
      const t = buf.match(/PF_CORE_TOKEN=([0-9a-f]+)/)
      if (t) rpcToken = t[1]
      const m = buf.match(/PF_CORE_PORT=(\d+)/)
      // 必须等 PORT 与 TOKEN 都到齐：两者是三条独立 println，
      // 只等 PORT 会在分包时丢掉 TOKEN，随后所有请求都因未鉴权而超时
      if (m && rpcToken && !done) {
        done = true
        clearTimeout(timer)
        resolve(Number(m[1]))
      }
    }
    // 持续消费 stdout：提前 off('data') 会让管道写满，内核随后任何输出都会阻塞
    proc.stdout.on('data', onData)
    proc.stderr.on('data', (d) => (coreStderr += d.toString()))
  })
  return { proc, ready }
}

let rpcSeq = 0
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++rpcSeq
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
    const sock = net.connect(rpcPort, '127.0.0.1')
    let buf = ''
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      sock.destroy()
      reject(new Error(`RPC 超时: ${method}\n内核stderr: ${coreStderr.slice(-1200)}`))
    }, 30000)
    sock.on('connect', () => {
      // 首行连接鉴权（内核对未鉴权连接不响应请求，会表现为超时）
      if (rpcToken) sock.write(`PF_AUTH ${rpcToken}\n`)
      sock.write(payload)
    })
    sock.on('data', (d) => {
      buf += d.toString()
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        // 跳过通知（无 id）
        if (msg.id === undefined) continue
        if (msg.id !== id) continue
        if (settled) return
        settled = true
        clearTimeout(timer)
        sock.destroy()
        if (msg.error) reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }))
        else resolve(msg.result)
        return
      }
    })
    sock.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`${method} 连接错误: ${e.message}\n内核stderr: ${coreStderr.slice(-1200)}`))
    })
    // 连接被内核关闭（未回包）= 服务端异常，必须显式失败而不是干等超时
    sock.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`${method} 连接被内核关闭（疑似 dispatch panic）\n内核stderr: ${coreStderr.slice(-1200)}`))
    })
  })
}

/** 取 <video> 的时长无关；这里用固定 1500s 模拟正片 */
const DURATION = 1500

async function main() {
  const dataDir = path.join(process.env.TEMP ?? '.', `pf-smoke-p14-${process.pid}`)
  const origin = await startDpOrigin()
  const core = startCore({
    LOCALAPPDATA: dataDir,
    PF_DANDANPLAY_BASE: origin.base
  })

  let proc = core.proc
  try {
    rpcPort = await core.ready

    // ============================================================ A. 设置
    section('A. 设置读写与区间夹取')
    {
      const r = await rpc('danmaku.settings.get')
      check('settings.get 返回默认设置', r.settings.enabled === true && r.settings.provider === 'dandanplay')
      check('未配置凭据时 hasCredentials=false', r.hasCredentials === false)
      check('appIdMasked 为空', r.appIdMasked === null)

      const r2 = await rpc('danmaku.settings.set', { settings: { opacity: 0.5 } })
      check('settings.set 生效', Math.abs(r2.settings.opacity - 0.5) < 1e-9, `opacity=${r2.settings.opacity}`)
      check('局部更新不影响其他字段', r2.settings.fontScale === 1 && r2.settings.provider === 'dandanplay')

      const r3 = await rpc('danmaku.settings.set', { opacity: 5 })
      check('越界值被夹到 1.0', r3.settings.opacity === 1, `opacity=${r3.settings.opacity}`)

      const r4 = await rpc('danmaku.settings.set', { settings: { fontScale: 0 } })
      check('字号下界夹取 0.6', r4.settings.fontScale === 0.6)

      const r5 = await rpc('danmaku.settings.set', { settings: { provider: 'bogus' } })
      check('非法 provider 回落 dandanplay', r5.settings.provider === 'dandanplay')
    }

    // ============================================================ B. 凭据 + 签名
    section('B. 凭据与弹弹play 签名')
    {
      const r = await rpc('danmaku.credentials.set', { appId: APP_ID, appSecret: APP_SECRET })
      check('凭据保存成功', r.saved === true)
      check('AppId 脱敏展示', r.appIdMasked.startsWith('pf-s'), r.appIdMasked)

      const t = await rpc('danmaku.credentials.test')
      check('连通性自检通过', t.ok === true, `${t.message} | searches=${origin.state.searchCalls} signFails=${origin.state.signFailures.length}`)
      check('服务端已验签且全部通过', origin.state.signChecked > 0 && origin.state.signFailures.length === 0,
        `checked=${origin.state.signChecked} failures=${origin.state.signFailures.join(',') || 'none'}`)

      const g = await rpc('danmaku.settings.get')
      check('settings.get 反映已配置', g.hasCredentials === true)
    }

    // ============================================================ C. 频道 + 拉取
    section('C. 频道绑定 / 拉取 / 缓存')
    let channelId = ''
    {
      const a = await rpc('danmaku.open', { title: '测试番剧', episode: '第1集' })
      const b = await rpc('danmaku.open', { title: '  测试番剧 ', episode: '第1集 ' })
      channelId = a.channelId
      check('open 返回 channelId', typeof channelId === 'string' && channelId.length > 5, channelId)
      check('channelId 对首尾空格不敏感', a.channelId === b.channelId)
      check('open 不联网（初始 count=0）', a.count === 0)

      const f1 = await rpc('danmaku.fetch', { title: '测试番剧', episode: '第1集', duration: DURATION })
      check('首次拉取成功', f1.error === null, JSON.stringify(f1.error))
      check('首次拉取非缓存', f1.cached === false)
      check('首次拉取有新增', f1.added > 0, `added=${f1.added}`)
      check('拉取条数与源一致', f1.count === 3, `count=${f1.count}`)
      check('channelId 与 open 一致', f1.channelId === channelId)
      check('返回时间升序', f1.items.every((it, i) => i === 0 || it.time >= f1.items[i - 1].time))

      const searchCallsAfterFirst = origin.state.searchCalls
      const commentCallsAfterFirst = origin.state.commentCalls

      const f2 = await rpc('danmaku.fetch', { title: '测试番剧', episode: '第1集', duration: DURATION })
      check('二次拉取命中缓存', f2.cached === true)
      check('缓存命中不再打搜索接口', origin.state.searchCalls === searchCallsAfterFirst,
        `searchCalls=${origin.state.searchCalls}`)
      check('缓存命中不再打弹幕接口', origin.state.commentCalls === commentCallsAfterFirst)
      check('缓存条数一致', f2.count === f1.count)

      const f3 = await rpc('danmaku.fetch', {
        title: '测试番剧', episode: '第1集', duration: DURATION, force: true
      })
      check('force 重拉会重新请求', origin.state.commentCalls > commentCallsAfterFirst)
      check('重拉去重后无新增', f3.added === 0, `added=${f3.added}`)
      check('重拉后总数不变', f3.count === f1.count, `count=${f3.count}`)

      const other = await rpc('danmaku.open', { title: '测试番剧', episode: '第2集' })
      check('换集产生新频道', other.channelId !== channelId)

      const localOpen = await rpc('danmaku.open', { title: '测试番剧', episode: '第1集', provider: 'local' })
      check('换 provider 产生新频道', localOpen.channelId !== channelId)
    }

    // ============================================================ D. 数据解析
    section('D. 第三方数据解析')
    {
      const f = await rpc('danmaku.list', { channelId })
      const byText = Object.fromEntries(f.items.map((i) => [i.text, i]))
      check('滚动弹幕模式正确', byText['第一条']?.mode === 'scroll')
      check('模式码 5 → 顶部', byText['顶部红色']?.mode === 'top')
      check('模式码 4 → 底部', byText['底部蓝色']?.mode === 'bottom')
      check('十进制颜色转 #RRGGBB', byText['顶部红色']?.color === '#FF0000', byText['顶部红色']?.color)
      check('短格式颜色 255 → #0000FF', byText['底部蓝色']?.color === '#0000FF', byText['底部蓝色']?.color)
      check('小数时间保留精度', Math.abs((byText['第一条']?.time ?? 0) - 1.5) < 1e-9, String(byText['第一条']?.time))

      // 灌入脏数据 + 大量弹幕，验证过滤与容量
      origin.state.comments = [
        { cid: 101, p: '5,1,16777215,', m: '正常' },
        { cid: 0, p: '6,1,16777215,', m: '' },
        { cid: 0, p: 'notanumber,1,0,', m: '坏时间' },
        { cid: 0, p: '-3,1,0,', m: '负时间' },
        { cid: 0, p: '7,1,0,', m: '   ' },
        { cid: 0, p: '8,1,0,', m: '带\n换行' }
      ]
      const dirty = await rpc('danmaku.open', { title: '脏数据番', episode: '第1集' })
      const fd = await rpc('danmaku.fetch', {
        title: '脏数据番', episode: '第1集', duration: DURATION, force: true
      })
      const texts = fd.items.map((i) => i.text)
      check('空文本条目被过滤', !texts.includes(''), `texts=${JSON.stringify(texts)}`)
      check('非法时间条目被过滤', !texts.some((t) => t.includes('坏时间') || t.includes('负时间')))
      check('换行被压平为空格', texts.includes('带 换行'), JSON.stringify(texts))
      check('脏数据频道仍可用', fd.channelId === dirty.channelId)
    }

    // ============================================================ E. 本地发送
    section('E. 本地发送的限流与去重')
    {
      const s1 = await rpc('danmaku.send', {
        channelId, time: 100, text: '第一条本地弹幕'
      })
      check('发送成功', s1.ok === true, JSON.stringify(s1))
      check('入库成功', s1.persisted === true)

      const s2 = await rpc('danmaku.send', { channelId, time: 100, text: '第一条本地弹幕' })
      check('10s 内重复内容被拒（duplicate）', s2.ok === false && s2.kind === 'duplicate', JSON.stringify(s2))

      const s3 = await rpc('danmaku.send', { channelId, time: 101, text: '另一条内容' })
      check('1.5s 内连发被拒（too_fast）', s3.ok === false && s3.kind === 'too_fast', JSON.stringify(s3))

      // 等过限流窗口
      await new Promise((r) => setTimeout(r, 1600))
      const s4 = await rpc('danmaku.send', { channelId, time: 102, text: '另一条内容' })
      check('超过间隔后可以发送', s4.ok === true, JSON.stringify(s4))

      await new Promise((r) => setTimeout(r, 1600))
      const s5 = await rpc('danmaku.send', { channelId, time: 103, text: '   ' })
      check('空内容被拒（empty）', s5.ok === false && s5.kind === 'empty', JSON.stringify(s5))

      const s6 = await rpc('danmaku.send', { channelId, time: 104, text: '字'.repeat(101) })
      check('超长被拒（too_long）', s6.ok === false && s6.kind === 'too_long', JSON.stringify(s6))

      await new Promise((r) => setTimeout(r, 1600))
      const s7 = await rpc('danmaku.send', { channelId, time: 105, text: '字'.repeat(100) })
      check('恰好 100 字可通过', s7.ok === true, JSON.stringify(s7))

      await new Promise((r) => setTimeout(r, 1600))
      const s8 = await rpc('danmaku.send', { channelId, time: 106, text: '  前后空格  ' })
      check('发送前自动 trim', s8.ok === true && s8.item.text === '前后空格', s8.item?.text)

      const list = await rpc('danmaku.list', { channelId })
      const hasLocal = list.items.some((i) => i.text === '第一条本地弹幕' && i.source === 'local')
      check('发送后 list 能读到', hasLocal)

      const bad = await rpc('danmaku.send', { channelId: '', time: 1, text: 'x' }).catch((e) => e)
      check('缺 channelId 报参数错误', bad.code === -32602, `${bad.code}`)
    }

    // ============================================================ F. 频道管理
    section('F. 频道清理与删除')
    {
      const chs = await rpc('danmaku.channels')
      check('channels 列出已缓存频道', Array.isArray(chs.channels) && chs.channels.length >= 2,
        `n=${chs.channels?.length}`)

      const cleared = await rpc('danmaku.channel.clear', { channelId })
      check('clear 清空条目', cleared.cleared > 0, `cleared=${cleared.cleared}`)
      const afterClear = await rpc('danmaku.list', { channelId })
      check('clear 后条目为 0', afterClear.count === 0)
      const chs2 = await rpc('danmaku.channels')
      check('clear 保留频道绑定', chs2.channels.some((c) => c.id === channelId))

      const removed = await rpc('danmaku.channel.remove', { channelId })
      check('remove 删除频道', removed.removed >= 0)
      const chs3 = await rpc('danmaku.channels')
      check('remove 后频道消失', !chs3.channels.some((c) => c.id === channelId))
    }

    // ============================================================ G. ASS 导出
    section('G. ASS 导出（libmpv 渲染路径）')
    {
      // 还原成含顶/底模式的样本（D 段为测脏数据过滤把源数据全换成了滚动模式）
      origin.state.comments = [
        { cid: 1, p: '1.5,1,16777215,abc', m: '第一条' },
        { cid: 2, p: '10,5,16711680,abc', m: '顶部红色' },
        { cid: 3, p: '20,4,255,abc', m: '底部蓝色' }
      ]
      const ch = await rpc('danmaku.open', { title: '测试番剧', episode: '第1集' })
      await rpc('danmaku.fetch', { title: '测试番剧', episode: '第1集', duration: DURATION, force: true })

      const ass = await rpc('danmaku.ass', { channelId: ch.channelId, width: 1920, height: 1080 })
      check('ASS 文件已生成', typeof ass.path === 'string' && existsSync(ass.path), ass.path ?? 'null')
      if (ass.path) {
        const text = fs.readFileSync(ass.path, 'utf8')
        check('ASS 含 [Script Info]', text.includes('[Script Info]'))
        check('ASS 含 PlayRes', /PlayResX:\s*1920/.test(text))
        check('ASS 含 Events 段', text.includes('[Events]'))
        check('ASS 对话行数正确', (text.match(/^Dialogue:/gm) ?? []).length === ass.count,
          `dialogue=${(text.match(/^Dialogue:/gm) ?? []).length} count=${ass.count}`)
        check('ASS 含滚动移动标签', text.includes('\\move('))
        check('ASS 含顶/底定位标签', text.includes('\\an8') || text.includes('\\an2'))

        // 屏蔽滚动后应只剩顶/底两条
        await rpc('danmaku.settings.set', { settings: { blockScroll: true } })
        const ass2 = await rpc('danmaku.ass', { channelId: ch.channelId })
        check('屏蔽滚动后条数减少', ass2.count < ass.count, `${ass2.count} < ${ass.count}`)
        await rpc('danmaku.settings.set', { settings: { blockScroll: false } })
      }

      const emptyAss = await rpc('danmaku.ass', { channelId: 'nope-0000' })
      check('空频道返回 path=null + reason', emptyAss.path === null && emptyAss.reason === 'empty',
        JSON.stringify(emptyAss))
    }

    // ============================================================ H. 异常场景
    section('H. 异常场景（不得挂死）')
    {
      // H1 无凭据
      await rpc('danmaku.credentials.clear')
      const noCred = await rpc('danmaku.fetch', {
        title: '无凭据番', episode: '第1集', duration: DURATION
      })
      check('无凭据降级不报错', noCred.error?.kind === 'no_credentials', JSON.stringify(noCred.error))
      check('无凭据仍返回空 items 而不是抛错', Array.isArray(noCred.items))

      await rpc('danmaku.credentials.set', { appId: APP_ID, appSecret: APP_SECRET })

      // H2 搜索无结果
      origin.state.searchMode = 'empty'
      const noMatch = await rpc('danmaku.fetch', { title: '查无此片', episode: '第1集', duration: DURATION })
      check('搜索无结果 → no_match', noMatch.error?.kind === 'no_match', JSON.stringify(noMatch.error))

      // H3 鉴权失败
      origin.state.searchMode = 'auth'
      const authFail = await rpc('danmaku.fetch', { title: '鉴权失败番', episode: '第1集', duration: DURATION })
      check('403 → auth', authFail.error?.kind === 'auth', JSON.stringify(authFail.error))

      // H4 服务端 500
      origin.state.searchMode = 'boom'
      const boom = await rpc('danmaku.fetch', { title: '服务器炸了番', episode: '第1集', duration: DURATION })
      check('500 → http', boom.error?.kind === 'http', JSON.stringify(boom.error))
      origin.state.searchMode = 'ok'

      // H5 内核仍存活
      const ping = await rpc('core.ping')
      check('异常后内核仍可响应', ping.pong === true)

      // H6 未识别方法
      const unknown = await rpc('danmaku.nonexistent').catch((e) => e)
      check('未识别方法返回 -32601', unknown.code === -32601, String(unknown.code))
    }

    // ============================================================ I. 并发与高密度
    section('I. 并发与高密度')
    {
      // 9000 条弹幕：验证批量事务 + 截断策略
      const many = []
      for (let i = 0; i < 9000; i++) {
        many.push({
          cid: 10000 + i,
          p: `${(i * 0.1).toFixed(2)}${i % 7 === 0 ? ',5' : ',1'},${i % 2 ? 16777215 : 255},u`,
          m: `高并发弹幕 #${i}`
        })
      }
      origin.state.comments = many
      const dense = await rpc('danmaku.fetch', {
        title: '高密度番', episode: '第1集', duration: DURATION, force: true
      })
      check('高密度拉取未失败', dense.error === null, JSON.stringify(dense.error))
      check('拉取条数被限制在 8000 以内', dense.items.length <= 8000, `items=${dense.items.length}`)
      check('入库条数 > 5000', dense.count > 5000, `count=${dense.count}`)

      const st = await rpc('danmaku.stats', { channelId: dense.channelId })
      check('stats 报告频道条数', st.count === dense.count, `stats=${st.count}`)

      // 20 个并发 fetch（同一频道，全部强制重拉）
      const t0 = Date.now()
      const tasks = Array.from({ length: 20 }, () =>
        rpc('danmaku.fetch', {
          title: '高密度番', episode: '第1集', duration: DURATION, force: true
        }).then(
          (r) => ({ ok: true, count: r.count }),
          (e) => ({ ok: false, msg: e.message })
        )
      )
      const settled = await Promise.all(tasks)
      const elapsed = Date.now() - t0
      const allOk = settled.every((s) => s.ok)
      check('20 并发拉取全部成功（无死锁）', allOk, `elapsed=${elapsed}ms`)
      const countsOk = settled.every((s) => s.ok && s.count === dense.count)
      check('并发后条数一致（无重复写入）', countsOk, `counts=${settled.map((s) => s.count).join(',')}`)
      check('并发耗时在可接受范围（<20s）', elapsed < 20000, `${elapsed}ms`)

      // 并发发送：只有前一条能过，其余被限流（验证 SendGuard 线程安全）
      const sends = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          rpc('danmaku.send', {
            channelId: dense.channelId,
            time: 50,
            text: `并发发送-${i}`
          }).then((r) => r.ok, () => false)
        )
      )
      const accepted = sends.filter(Boolean).length
      check('20 并发发送只放行 1 条', accepted === 1, `accepted=${accepted}`)
    }

    // ============================================================ J. P15：导入 / 屏蔽词 / 临时文件
    section('J. 本地导入 / 屏蔽词 / 临时文件治理')
    {
      // ---- J1 B站 XML 导入 ----
      const ch = await rpc('danmaku.open', { title: '导入测试番', episode: '第1集' })
      const xml = [
        '<?xml version="1.0" encoding="UTF-8"?><i><chatid>1</chatid>',
        '<d p="1.5,1,25,16777215,0,0,a,1">XML 滚动</d>',
        '<d p="2.5,5,25,16711680,0,0,a,2">XML 顶部 &amp; 实体</d>',
        '<d p="bad,1,25,0,0,a,3">坏时间</d>',
        '<d p="4.5,1,25,0,0,a,4">   </d>',
        '</i>'
      ].join('\n')
      const imp = await rpc('danmaku.import', { channelId: ch.channelId, content: xml })
      check('XML 导入成功', imp.ok === true, JSON.stringify(imp))
      check('格式识别为 xml', imp.format === 'xml', imp.format)
      check('脏数据被跳过只入有效条目', imp.imported === 2, `imported=${imp.imported}`)

      const list1 = await rpc('danmaku.list', { channelId: ch.channelId })
      const texts1 = list1.items.map((i) => i.text)
      check('导入内容可读回', texts1.includes('XML 滚动'), JSON.stringify(texts1))
      check('XML 实体已反转义', texts1.includes('XML 顶部 & 实体'), JSON.stringify(texts1))
      check('导入条目 source=import', list1.items.every((i) => i.source === 'import'))
      const topItem = list1.items.find((i) => i.text.startsWith('XML 顶部'))
      check('导入保留顶部模式', topItem?.mode === 'top', topItem?.mode)
      check('导入保留十进制颜色', topItem?.color === '#FF0000', topItem?.color)

      // ---- J2 重复导入靠唯一约束去重 ----
      const imp2 = await rpc('danmaku.import', { channelId: ch.channelId, content: xml })
      check('重复导入不产生重复条目', imp2.imported === 0, `imported=${imp2.imported}`)

      // ---- J3 弹弹play JSON + 顶层数组 ----
      const dpJson = JSON.stringify({
        count: 2,
        comments: [
          { cid: 11, p: '6,1,16777215,u', m: 'JSON 甲' },
          { cid: 12, p: '7,4,255,u', m: 'JSON 乙' }
        ]
      })
      const imp3 = await rpc('danmaku.import', { channelId: ch.channelId, content: dpJson })
      check('弹弹play JSON 导入成功', imp3.ok === true && imp3.format === 'json', JSON.stringify(imp3))

      const arrJson = JSON.stringify([
        { time: 8, text: '数组丙' },
        { time: '9', text: '数组丁', mode: 'top' }
      ])
      const imp4 = await rpc('danmaku.import', { channelId: ch.channelId, content: arrJson })
      check('顶层数组 JSON 被识别', imp4.ok === true && imp4.imported === 2, JSON.stringify(imp4))
      const list2 = await rpc('danmaku.list', { channelId: ch.channelId })
      check('字符串时间被解析', list2.items.some((i) => i.text === '数组丁' && Math.abs(i.time - 9) < 1e-9))

      // ---- J4 多字节边界不 panic（旧实现会 `&content[..8192]` 直接崩内核）----
      const bigXml = `<i>${'a'.repeat(8188)}中<d p="10,1,25,0,0,a,9">跨字节边界</d></i>`
      const impBig = await rpc('danmaku.import', { channelId: ch.channelId, content: bigXml })
      check('8192 字节落在汉字中间不崩（回归）', impBig.ok === true, JSON.stringify(impBig))
      const pingAfter = await rpc('core.ping')
      check('大文件导入后内核存活', pingAfter.pong === true)

      // ---- J5 屏蔽词：只影响展示，不删数据 ----
      const totalInDb = (await rpc('danmaku.stats', { channelId: ch.channelId })).count
      await rpc('danmaku.settings.set', { settings: { blockedWords: ['XML'] } })
      const filtered = await rpc('danmaku.list', { channelId: ch.channelId })
      check('屏蔽词生效（返回条数减少）', filtered.count < totalInDb, `${filtered.count} < ${totalInDb}`)
      check('命中屏蔽词的条目不返回', !filtered.items.some((i) => i.text.includes('XML')))
      const dbAfter = (await rpc('danmaku.stats', { channelId: ch.channelId })).count
      check('被屏蔽条目仍在库（未删数据）', dbAfter === totalInDb, `db=${dbAfter} 原始=${totalInDb}`)

      await rpc('danmaku.settings.set', { settings: { blockedWords: [] } })
      const back = await rpc('danmaku.list', { channelId: ch.channelId })
      check('清空屏蔽词后条目恢复', back.count === totalInDb, `${back.count} vs ${totalInDb}`)

      // ---- J6 屏蔽词输入清洗 + 大小写不敏感 ----
      const s6 = await rpc('danmaku.settings.set', { settings: { blockedWords: ['  json  ', 'json', ''] } })
      check(
        '屏蔽词 trim/去重/去空',
        JSON.stringify(s6.settings.blockedWords) === JSON.stringify(['json']),
        JSON.stringify(s6.settings.blockedWords)
      )
      const lower = await rpc('danmaku.list', { channelId: ch.channelId })
      check('屏蔽词大小写不敏感', !lower.items.some((i) => /json/i.test(i.text)), JSON.stringify(lower.items.map((i) => i.text)))
      await rpc('danmaku.settings.set', { settings: { blockedWords: [] } })

      // ---- J7 导入也走屏蔽词？不：入库全量（J5 已证），但 ASS 出口要过滤 ----
      await rpc('danmaku.settings.set', { settings: { blockedWords: ['XML'] } })
      const assBlocked = await rpc('danmaku.ass', { channelId: ch.channelId })
      check('ASS 出口同样应用屏蔽词', assBlocked.count <= totalInDb - 2, `count=${assBlocked.count}`)
      await rpc('danmaku.settings.set', { settings: { blockedWords: [] } })

      // ---- J8 ASS 占用统计与清理 ----
      const a1 = await rpc('danmaku.ass', { channelId: ch.channelId })
      check('导入数据也能生成 ASS', typeof a1.path === 'string' && existsSync(a1.path), a1.path ?? 'null')
      const st1 = await rpc('danmaku.stats', { channelId: ch.channelId })
      check('stats 暴露 ASS 占用', st1.assCache?.files >= 1 && st1.assCache?.bytes > 0, JSON.stringify(st1.assCache))
      const cleaned = await rpc('danmaku.cache.clean', { keep: 0 })
      check('cache.clean 清空临时文件', cleaned.removed >= 1 && cleaned.files === 0, JSON.stringify(cleaned))
      check('清理后文件确实不在磁盘上', !existsSync(a1.path))

      // ---- J9 keep 限额（多频道各生成一个，只留 2 个）----
      for (const t of ['甲', '乙', '丙', '丁']) {
        const c = await rpc('danmaku.open', { title: `清理测试${t}`, episode: '第1集' })
        await rpc('danmaku.import', { channelId: c.channelId, content: `<i><d p="1,1,25,0,0,a,1">${t}</d></i>` })
        await rpc('danmaku.ass', { channelId: c.channelId })
      }
      const keep2 = await rpc('danmaku.cache.clean', { keep: 2 })
      check('keep=2 只保留 2 个文件', keep2.files === 2, JSON.stringify(keep2))
      await rpc('danmaku.cache.clean', { keep: 0 })

      // ---- J10 match 的 query 覆盖 + 集数显式指定 ----
      origin.state.searchQueries.length = 0
      origin.state.searchEpisodes.length = 0
      const m1 = await rpc('danmaku.match', { title: '测试番剧 第1集【某字幕组】', query: '自定义关键词' })
      check('match 用传入的 query 搜索', origin.state.searchQueries[0] === '自定义关键词',
        `sent=${JSON.stringify(origin.state.searchQueries)}`)
      check('match 返回候选', m1.ok === true && m1.candidates.length === 1, JSON.stringify(m1.candidates?.length))
      check('候选带番剧名与集名', !!m1.candidates[0]?.animeTitle && !!m1.candidates[0]?.episodeTitle)

      origin.state.searchEpisodes.length = 0
      await rpc('danmaku.match', { title: '测试番剧', query: '测试番剧', episodeNo: 7 })
      check('match 支持显式 episodeNo', origin.state.searchEpisodes[0] === '7',
        `sent=${JSON.stringify(origin.state.searchEpisodes)}`)

      // ---- J11 关闭弹幕时 fetch 直接读库不联网 ----
      await rpc('danmaku.settings.set', { settings: { provider: 'off' } })
      const callsBefore = origin.state.commentCalls
      const off = await rpc('danmaku.fetch', { title: '测试番剧', episode: '第1集' })
      check('provider=off 不联网', origin.state.commentCalls === callsBefore && off.cached === true)
      await rpc('danmaku.settings.set', { settings: { provider: 'dandanplay' } })
    }
  } finally {
    try {
      proc.kill()
    } catch {
      /* ignore */
    }
    await origin.close()
    // 清理临时数据目录
    try {
      fs.rmSync(dataDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }

  const failed = results.filter((r) => !r.ok)
  console.log(
    `\n${failed.length === 0 ? GREEN : RED}${results.length - failed.length}/${results.length} 通过${RESET}`
  )
  if (failed.length) {
    console.log(`${RED}失败项：${RESET}`)
    for (const f of failed) console.log(`  - ${f.name}`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(`${RED}冒烟脚本异常：${RESET}`, e)
  process.exit(1)
})
