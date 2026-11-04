/**
 * P17 弹幕高级特效 无头冒烟测试（全本地，不联网）
 *
 *  A. 设置：fxOverlay 往返读写（局部更新不重置其他字段）
 *  B. 发送：fx=glow / gradient 落库 + list 回读
 *  C. 非法 fx 归普通（不报错）
 *  D. 缺省 fx（旧客户端形态）不出字段
 *  E. 导入路径不受影响（fx 缺省）
 *
 * 运行：node apps/core/scripts/smoke-p17.mjs（需先 cargo build --release -p pf-core）
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
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

const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'pf-p17-'))

function startCore() {
  const bin = binCandidates.find((p) => existsSync(p))
  if (!bin) throw new Error('未找到 pf-core.exe，请先构建')
  const proc = spawn(bin, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, PF_PROXY_ALLOW_PRIVATE: '1', LOCALAPPDATA: dataRoot }
  })
  const portsReady = new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error('等待端口发现超时')), 25000)
    const onData = (d) => {
      buf += d.toString()
      const core = buf.match(/PF_CORE_PORT=(\d+)/)
      const proxy = buf.match(/PF_PROXY_PORT=(\d+)/)
      const t = buf.match(/PF_CORE_TOKEN=([0-9a-f]+)/)
      if (t) rpcToken = t[1]
      if (core && proxy) {
        clearTimeout(timer)
        proc.stdout.off('data', onData)
        resolve({ core: Number(core[1]), proxy: Number(proxy[1]) })
      }
    }
    proc.stdout.on('data', onData)
    proc.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`内核提前退出 code=${code}`))
    })
  })
  return { proc, portsReady }
}

let rpcToken = ''
function connectRpc(port) {
  const socket = net.connect(port, '127.0.0.1')
  socket.write('PF_AUTH ' + rpcToken + '\n')
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
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
        else resolve(msg.result)
      }
    }
  })
  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`RPC 超时: ${method}`))
        }
      }, 20000)
    })
  const close = () => socket.destroy()
  return { rpc, close }
}

// ================= 主流程 =================
const core = startCore()
const { core: corePort } = await core.portsReady
const { rpc, close } = connectRpc(corePort)

try {
  console.log('\n[A] fxOverlay 设置往返')
  const s0 = (await rpc('danmaku.settings.get')).settings
  check('旧数据缺 fxOverlay 平滑落到 false', s0.fxOverlay === false)
  const s1 = (await rpc('danmaku.settings.set', { settings: { fxOverlay: true } })).settings
  check('fxOverlay 可开启', s1.fxOverlay === true)
  // 局部更新不重置其他字段
  const s2 = (await rpc('danmaku.settings.set', { settings: { opacity: 0.5 } })).settings
  check('局部更新后 fxOverlay 保持开启', s2.fxOverlay === true)
  check('其他字段正常更新', Math.abs(s2.opacity - 0.5) < 1e-9)
  await rpc('danmaku.settings.set', { settings: { fxOverlay: false, opacity: 0.9 } })

  console.log('\n[B] fx 发送与回读')
  const open = await rpc('danmaku.open', { title: 'P17 特效测试', episode: '第1集' })
  const cid = open.channelId
  // SendGuard：同频道两条间隔 ≥1.5s，节流是业务规则，测试必须真实间隔
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  await wait(1600)
  const g = await rpc('danmaku.send', { channelId: cid, time: 1, text: '发光弹幕', mode: 'scroll', color: '#FF0000', fx: 'glow' })
  check('fx=glow 返回并保留', g.ok === true && g.item?.fx === 'glow', JSON.stringify(g.item?.fx))
  await wait(1600)
  const gr = await rpc('danmaku.send', { channelId: cid, time: 2, text: '渐变弹幕', mode: 'scroll', color: '#00FF66', fx: 'gradient' })
  check('fx=gradient 返回并保留', gr.ok === true && gr.item?.fx === 'gradient')
  await wait(1600)
  const pl = await rpc('danmaku.send', { channelId: cid, time: 3, text: '普通弹幕', mode: 'scroll', color: '#FFFFFF' })
  check('缺省 fx 不出字段（旧客户端兼容）', pl.ok === true && pl.item?.fx === undefined, JSON.stringify(pl.item?.fx))
  const list = await rpc('danmaku.list', { channelId: cid })
  const byText = Object.fromEntries((list.items ?? []).map((i) => [i.text, i.fx ?? null]))
  check('list 回读 fx=glow', byText['发光弹幕'] === 'glow')
  check('list 回读 fx=gradient', byText['渐变弹幕'] === 'gradient')
  check('普通条目 fx 为空', byText['普通弹幕'] == null)

  console.log('\n[C] 非法 fx 归普通')
  await wait(1600)
  const bad = await rpc('danmaku.send', { channelId: cid, time: 4, text: '脏值弹幕', mode: 'scroll', color: '#FFFFFF', fx: 'DROP TABLE' })
  check('非法 fx 不报错且归 None', bad.ok === true && bad.item?.fx === undefined, JSON.stringify(bad.item?.fx))
  await wait(1600)
  const bad2 = await rpc('danmaku.send', { channelId: cid, time: 5, text: '数字fx', mode: 'scroll', color: '#FFFFFF', fx: 123 })
  check('非字符串 fx 不报错且归 None', bad2.ok === true && bad2.item?.fx === undefined)

  console.log('\n[D] 导入路径不受影响')
  const imp = await rpc('danmaku.import', {
    channelId: cid,
    content:
      '<i><d p="10,1,25,16777215,0,0,a,1">导入甲</d><d p="11,1,25,16777215,0,0,a,2">导入乙</d></i>'
  })
  check('导入成功', imp.ok === true && imp.imported === 2, JSON.stringify(imp))
  const list2 = await rpc('danmaku.list', { channelId: cid })
  const impItems = (list2.items ?? []).filter((i) => i.source === 'import')
  check('导入条目 fx 缺省', impItems.length === 2 && impItems.every((i) => i.fx === undefined))

  console.log('\n[E] fx 不影响去重与 ASS 导出')
  // 同频道同内容重发被 SendGuard 拒（重复是**业务结果** ok:false + kind，不是 RPC 错误）
  const dup = await rpc('danmaku.send', { channelId: cid, time: 1, text: '发光弹幕', mode: 'scroll', color: '#FF0000', fx: 'gradient' })
  check('同内容重发被去重拒绝（ok:false + duplicate）', dup.ok === false && dup.kind === 'duplicate', JSON.stringify(dup))
  const ass = await rpc('danmaku.ass', { channelId: cid })
  check('ASS 导出正常（fx 不影响 mpv 兜底路径）', typeof ass.path === 'string' && ass.count >= 5, `count=${ass.count}`)
  const stats = await rpc('danmaku.stats', { channelId: cid })
  check('stats 可读', typeof stats.count === 'number' && stats.count >= 5, `count=${stats.count}`)
} finally {
  close()
  try {
    core.proc.kill()
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 300))
  try {
    rmSync(dataRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length === 0 ? GREEN : RED}${results.length - failed.length}/${results.length} 通过${RESET}`)
if (failed.length) {
  console.log(`${RED}失败项：${RESET}`)
  for (const f of failed) console.log(`  - ${f.name}`)
  process.exit(1)
}
