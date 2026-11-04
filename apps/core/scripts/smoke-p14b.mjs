/**
 * P14b 弹幕遗留收尾冒烟（无头，全本地，不依赖外网）
 *
 * 覆盖范围：
 *  A. 屏蔽词设置：清洗（trim/去重/超长丢弃）、条数上限、旧配置兼容
 *  B. 本地导入（B 站 XML）：坏条目跳过、屏蔽词命中不导入、重复导入幂等、垃圾内容报错
 *  C. 本地导入（弹弹play JSON）：解析、累计入库
 *  D. 过滤联动：改屏蔽词 → list 重新过滤；清空 → 恢复
 *  E. danmaku.match 无凭据降级（ok:false + candidates:[]，不挂）
 *  F. ASS 导出与屏蔽词一致性
 *
 * 运行：node apps/core/scripts/smoke-p14b.mjs（需先构建 pf-core）
 */
import { spawn } from 'node:child_process'
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
const section = (t) => console.log(`\n${t}`)

// ---------------------------------------------------------------- 内核进程 + RPC

let rpcPort = 0
let coreStderr = ''
let rpcToken = ''

function startCore(envOverride = {}) {
  const bin = binCandidates.find((p) => existsSync(p))
  if (!bin) throw new Error('未找到 pf-core.exe，请先构建')
  const proc = spawn(bin, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...envOverride }
  })
  const ready = new Promise((resolve, reject) => {
    let buf = ''
    let done = false
    const timer = setTimeout(() => reject(new Error('等待 PF_CORE_PORT 超时')), 25000)
    proc.stdout.on('data', (d) => {
      buf += d.toString()
      const t = buf.match(/PF_CORE_TOKEN=([0-9a-f]+)/)
      if (t) rpcToken = t[1]
      const m = buf.match(/PF_CORE_PORT=(\d+)/)
      if (m && rpcToken && !done) {
        done = true
        clearTimeout(timer)
        resolve(Number(m[1]))
      }
    })
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
        if (msg.id === undefined || msg.id !== id) continue
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
      reject(new Error(`${method} 连接错误: ${e.message}`))
    })
    sock.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`${method} 连接被内核关闭\n内核stderr: ${coreStderr.slice(-1200)}`))
    })
  })
}

// ---------------------------------------------------------------- 测试数据

const TITLE = 'P14b测试剧'
const EP = '第1集'

const BILI_XML = `<?xml version="1.0" encoding="UTF-8"?><i><chatserver>chat.example.com</chatserver>
<d p="1.5,1,25,16711680,0,0,0,0">普通弹幕一</d>
<d p="10,5,25,255,0,0,0,0">顶部弹幕二</d>
<d p="20,4,25,16777215,0,0,0,0">底部弹幕三</d>
<d p="30,1,25,16777215,0,0,0,0">前方剧透警告</d>
<d p="bad,1,25,0,0,0,0,0">坏时间戳</d>
</i>`

const DP_JSON = `{"count":2,"comments":[
{"cid":11,"p":"40,1,16777215,u1","m":"JSON弹幕一"},
{"cid":12,"p":"50,5,16711680,u2","m":"JSON弹幕二"}
]}`

async function main() {
  const dataDir = path.join(process.env.TEMP ?? '.', `pf-smoke-p14b-${process.pid}`)
  const core = startCore({ LOCALAPPDATA: dataDir })
  const proc = core.proc
  try {
    rpcPort = await core.ready
    console.log(`${DIM}pf-core ready (port ${rpcPort})${RESET}`)

    // ================= A. 屏蔽词设置 =================
    section('A. 屏蔽词设置')

    const s0 = await rpc('danmaku.settings.get')
    check('A1 旧配置兼容：默认含空 blockedWords', Array.isArray(s0.settings.blockedWords) && s0.settings.blockedWords.length === 0)

    const r1 = await rpc('danmaku.settings.set', {
      settings: { blockedWords: [' 剧透 ', '剧透', '', '   ', 'SPAM'] }
    })
    check('A2 清洗生效（trim+去空+去重）', JSON.stringify(r1.settings.blockedWords) === JSON.stringify(['剧透', 'SPAM']), JSON.stringify(r1.settings.blockedWords))

    const many = Array.from({ length: 300 }, (_, i) => `词${i}`)
    const r2 = await rpc('danmaku.settings.set', { settings: { blockedWords: many } })
    check('A3 条数上限截断到 200', r2.settings.blockedWords.length === 200)

    await rpc('danmaku.settings.set', { settings: { blockedWords: ['剧透'] } })

    // ================= B. 导入 B 站 XML =================
    section('B. 导入 B 站 XML')

    const open = await rpc('danmaku.open', { title: TITLE, episode: EP })
    const cid = open.channelId
    check('B1 频道绑定成功', cid.startsWith('dandanplay-'), cid)

    const imp1 = await rpc('danmaku.import', { channelId: cid, title: TITLE, episode: EP, content: BILI_XML })
    // 导入**不做**屏蔽词过滤：只跳过坏条目（`bad` 时间戳），命中的那条也照常入库。
    // 理由见交付总结 §5：落库时过滤等于把数据删了，清空屏蔽词后找不回来。
    check('B2 XML 导入 4 条（只跳过坏时间戳）', imp1.ok === true && imp1.imported === 4, `imported=${imp1.imported} format=${imp1.format}`)
    check('B3 format=xml', imp1.format === 'xml')
    check('B3b 报告被屏蔽条数', imp1.blocked === 1, `blocked=${imp1.blocked}`)

    const list1 = await rpc('danmaku.list', { channelId: cid })
    check('B4 list 过滤后 count=3', list1.count === 3, `count=${list1.count}`)
    check('B5 屏蔽词条目不存在', !list1.items.some((i) => i.text.includes('剧透')))
    check('B6 其余条目按时间排序', list1.items[0].text === '普通弹幕一' && list1.items[2].text === '底部弹幕三')

    // 关键回归：被屏蔽的条目必须还在库里（只是不返回）
    const st1 = await rpc('danmaku.stats', { channelId: cid })
    check('B6b 被屏蔽条目仍在库（不丢数据）', st1.count === 4, `db=${st1.count}`)

    const imp2 = await rpc('danmaku.import', { channelId: cid, title: TITLE, episode: EP, content: BILI_XML })
    check('B7 重复导入幂等（imported=0）', imp2.ok === true && imp2.imported === 0 && imp2.total === 4, `imported=${imp2.imported} total=${imp2.total}`)

    let garbageErr = ''
    try {
      await rpc('danmaku.import', { channelId: cid, content: 'hello world 不是弹幕' })
    } catch (e) {
      garbageErr = e.message
    }
    check('B8 垃圾内容报错', garbageErr.includes('无法识别'), garbageErr.slice(0, 60))

    let emptyErr = ''
    try {
      await rpc('danmaku.import', { channelId: cid, content: '   ' })
    } catch (e) {
      emptyErr = e.message
    }
    check('B9 空内容报参数错误', emptyErr.length > 0, emptyErr.slice(0, 60))

    // ================= C. 导入弹弹play JSON =================
    section('C. 导入弹弹play JSON')

    const imp3 = await rpc('danmaku.import', { channelId: cid, content: DP_JSON })
    check('C1 JSON 导入 2 条', imp3.ok === true && imp3.imported === 2, `imported=${imp3.imported}`)
    check('C2 format=json', imp3.format === 'json')

    const list2 = await rpc('danmaku.list', { channelId: cid })
    check('C3 累计 count=5', list2.count === 5, `count=${list2.count}`)
    const jsonItem = list2.items.find((i) => i.text === 'JSON弹幕二')
    check('C4 模式/颜色解析（顶部红）', jsonItem && jsonItem.mode === 'top' && jsonItem.color === '#FF0000', JSON.stringify(jsonItem))

    // ================= D. 过滤联动 =================
    // 注意：库中现有 **6 条**（XML 4 条含「前方剧透警告」+ JSON 2 条）。
    // 「前方剧透警告」在第 B 段虽然被当时的屏蔽词挡住，但它是入库的 —— 这正是
    // B6b 要钉住的语义，所以这里的期望值按 6 算而不是 5。
    section('D. 过滤联动')

    await rpc('danmaku.settings.set', { settings: { blockedWords: ['JSON弹幕一'] } })
    const list3 = await rpc('danmaku.list', { channelId: cid })
    check('D1 改屏蔽词后 list 重新过滤 count=5', list3.count === 5, `count=${list3.count}`)
    check('D2 命中条目消失', !list3.items.some((i) => i.text === 'JSON弹幕一'))

    await rpc('danmaku.settings.set', { settings: { blockedWords: [] } })
    const list4 = await rpc('danmaku.list', { channelId: cid })
    check('D3 清空后恢复 count=6', list4.count === 6, `count=${list4.count}`)
    check('D4 早前被屏蔽的条目也回来了', list4.items.some((i) => i.text === '前方剧透警告'))

    // ================= E. match 无凭据降级 =================
    section('E. danmaku.match 无凭据')

    const m = await rpc('danmaku.match', { title: TITLE, episode: EP })
    check('E1 无凭据返回 ok:false + 空候选', m.ok === false && Array.isArray(m.candidates) && m.candidates.length === 0)

    // ================= F. ASS 与屏蔽词一致 =================
    section('F. ASS 导出一致性')

    await rpc('danmaku.settings.set', { settings: { blockedWords: ['JSON弹幕二'] } })
    const ass = await rpc('danmaku.ass', { channelId: cid, width: 1280, height: 720 })
    check('F1 ASS 条数按过滤后计（5 条）', ass.count === 5, `count=${ass.count} path=${ass.path ? 'yes' : 'no'}`)
    const list5 = await rpc('danmaku.list', { channelId: cid })
    check('F2 ASS 与 list 一致', ass.count === list5.count)

    // 清理：删测试频道
    await rpc('danmaku.channel.remove', { channelId: cid })
  } finally {
    proc.kill()
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n===== P14b 弹幕收尾冒烟：${results.length - failed.length}/${results.length} ${failed.length ? RED + 'FAILED' : GREEN + 'ALL PASS'}${RESET} =====`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
