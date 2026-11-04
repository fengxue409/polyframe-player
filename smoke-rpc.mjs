/**
 * smoke-rpc.mjs — pf-core RPC 行为自测（不依赖桌面端）：
 *   T1 core.ping 基线
 *   T2 并发派发：慢 task.create 期间 magnet.list 不被队头阻塞（回归 10s 超时 bug）
 *   T3 挂死源 task.create 返回真实错误（非「等待 playlist 就绪超时」、非 RPC 超时）
 *   T4 真实非凡源 task.create 可成功或返回真实错误
 * 用法：node smoke-rpc.mjs
 */
import { spawn } from 'node:child_process'
import net from 'node:net'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const BIN = fileURLToPath(new URL('./apps/core/target/release/pf-core.exe', import.meta.url))

const proc = spawn(BIN, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
proc.stderr.on('data', () => {}) // 内核调试日志丢弃
proc.on('exit', (c) => console.log(`[core] exited code=${c}`))

// 端口/token 发现
let port = 0, token = '', buf = ''
const ready = new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('等待端口/token 超时')), 15000)
  const onData = (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      let m = line.match(/^PF_CORE_PORT=(\d+)$/); if (m) port = +m[1]
      m = line.match(/^PF_PROXY_PORT=(\d+)$/); if (m) {}
      m = line.match(/^PF_CORE_TOKEN=([0-9a-f]+)$/); if (m) token = m[1]
      if (port && token) { clearTimeout(t); proc.stdout.off('data', onData); resolve() }
    }
  }
  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', onData)
})

await ready
console.log(`[core] port=${port} token=${token.slice(0, 8)}…`)

const socket = net.connect(port, '127.0.0.1')
await new Promise((res, rej) => { socket.once('connect', res); socket.once('error', rej) })
socket.write(`PF_AUTH ${token}\n`)

const pending = new Map()
let nextId = 1
const rl = readline.createInterface({ input: socket, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg; try { msg = JSON.parse(line) } catch { return }
  if (msg?.id != null && ('result' in msg || 'error' in msg)) {
    const p = pending.get(msg.id)
    if (p) { pending.delete(msg.id); clearTimeout(p.timer) }
    if (!p) return
    if (msg.error) p.reject(new Error(msg.error.message ?? 'RPC error'))
    else p.resolve(msg.result)
  }
})

function rpc(method, params, timeoutMs = 10000) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC 超时: ${method}`)) }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

let pass = 0, fail = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
  ok ? pass++ : fail++
}

// ---- T1: ping ----
{
  const t0 = Date.now()
  const r = await rpc('core.ping', {}, 5000)
  check('T1 core.ping', r?.pong === true, `${Date.now() - t0}ms`)
}

// ---- T2/T3: 黑洞源（accept 后永不响应）----
const bh = net.createServer(() => {}) // accept 后什么都不做
const bhPort = await new Promise((res) => bh.listen(0, '127.0.0.1', () => res(bh.address().port)))
const hangUrl = `http://127.0.0.1:${bhPort}/x.m3u8`

{
  const createP = rpc('task.create', { url: hangUrl, title: 'smoke-hang' }, 120000)
  await new Promise((r) => setTimeout(r, 300)) // 让 create 先进入内核

  const latencies = []
  let t2ok = true
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now()
    try {
      await rpc('magnet.list', {}, 10000)
      latencies.push(Date.now() - t0)
    } catch (e) {
      t2ok = false
      latencies.push(-1)
      console.log(`   magnet.list#${i} 失败: ${e.message}`)
    }
  }
  check('T2 慢 create 期间 magnet.list 不被队头阻塞', t2ok && latencies.every((l) => l >= 0 && l < 3000),
    `耗时 ${latencies.join('/')}ms`)

  const t0 = Date.now()
  try {
    await createP
    check('T3 挂死源 create 结果', false, '竟成功了？')
  } catch (e) {
    const msg = e.message
    const real = !msg.includes('等待 playlist 就绪超时') && !msg.includes('RPC 超时')
    check('T3 挂死源返回真实错误（非笼统超时）', real, `${Date.now() - t0}ms: ${msg.slice(0, 120)}`)
  }
}
bh.close()

// ---- T4: 真实非凡源 ----
{
  const url = 'https://vip.ffzy-plays.com/20260903/57773_22a8e2e4/index.m3u8'
  const t0 = Date.now()
  try {
    const r = await rpc('task.create', { url, title: 'smoke-ffzy' }, 90000)
    const ok = !!r?.task?.playUrl
    check('T4 非凡源起播任务创建', ok, `${Date.now() - t0}ms playUrl=${String(r?.task?.playUrl).slice(0, 60)}`)
    if (ok) {
      // 清理测试任务
      await rpc('task.remove', { taskId: r.task.id }, 10000).catch(() => {})
    }
  } catch (e) {
    const real = !e.message.includes('RPC 超时') && !e.message.includes('等待 playlist 就绪超时')
    check('T4 非凡源返回真实错误（源失效时）', real, `${Date.now() - t0}ms: ${e.message.slice(0, 140)}`)
  }
}

// ---- 收尾：再验证连接健康 ----
{
  const r = await rpc('core.ping', {}, 5000).catch(() => null)
  check('收尾 core.ping 连接健康', r?.pong === true)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
proc.kill()
socket.destroy()
process.exit(fail ? 1 : 0)
