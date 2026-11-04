#!/usr/bin/env node
/**
 * 复现 hls.js manifestLoadError：用真实内核建任务，然后按浏览器口径检查代理响应。
 * 浏览器视角：renderer 页面（dev=http://localhost:5173 / 打包=file:// 即 Origin: null）
 * 与 http://127.0.0.1:<proxy> 不同源 → manifest 必须回 Access-Control-Allow-Origin。
 */
import { spawn } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const URL_ARG = process.argv.find((a) => a.startsWith('http')) ?? 'https://sf1-cdn-tos.huoshanstatic.com/obj/media-fe/xgplayer_doc_video/hls/xgplayer-demo.m3u8'
const ORIGIN = 'http://localhost:5173'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cors-'))
const CORE = path.join('apps', 'core', 'target', 'release', 'pf-core.exe')
const child = spawn(CORE, [], { env: { ...process.env, PF_NO_MPV: '1', LOCALAPPDATA: tmp }, stdio: ['pipe', 'pipe', 'pipe'] })
child.stderr.on('data', () => {})

const boot = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('内核启动超时')), 20000)
  let port = 0
  let token = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', function onData(d) {
    for (const l of String(d).split('\n')) {
      let m = l.match(/^PF_CORE_PORT=(\d+)\s*$/)
      if (m) port = +m[1]
      m = l.match(/^PF_CORE_TOKEN=([0-9a-f]+)\s*$/)
      if (m) token = m[1]
    }
    if (port && token) {
      child.stdout.off('data', onData)
      clearTimeout(t)
      res({ port, token })
    }
  })
})

const sock = net.connect(boot.port, '127.0.0.1')
await new Promise((r) => sock.once('connect', r))
sock.write(`PF_AUTH ${boot.token}\n`)
let buf = ''
const pending = new Map()
sock.on('data', (d) => {
  buf += String(d)
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    try {
      const msg = JSON.parse(line)
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    } catch {}
  }
})
let id = 0
const rpc = (method, params, timeoutMs = 90000) =>
  new Promise((resolve) => {
    const rid = `c${++id}`
    const timer = setTimeout(() => {
      pending.delete(rid)
      resolve({ error: { message: '客户端超时' } })
    }, timeoutMs)
    pending.set(rid, (m) => {
      clearTimeout(timer)
      resolve(m)
    })
    sock.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n')
  })

const r = await rpc('task.create', { url: URL_ARG, cacheMode: 'stream' })
if (r.error) {
  console.log('task.create 失败：', r.error.message)
  child.kill()
  process.exit(1)
}
const t = r.result.task
console.log('task', t.id, t.status)
console.log('playUrl', t.playUrl)
console.log('masterUrl', t.masterUrl)

const show = (label, url) => {
  console.log(`\n--- ${label}\n    ${url}`)
  return fetch(url, { headers: { Origin: ORIGIN, 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) })
    .then(async (res) => {
      const h = res.headers
      console.log(`    status=${res.status} acao=${h.get('access-control-allow-origin') ?? '(缺失)'} ctype=${h.get('content-type')}`)
      const txt = await res.text()
      console.log(`    extinf=${(txt.match(/#EXTINF/g) ?? []).length} bytes=${txt.length}`)
      return txt
    })
    .catch((e) => console.log('    请求失败', e.message))
}

const list = await show('media playlist（hls.js 第一跳）', t.playUrl)
if (t.masterUrl) await show('master playlist（mpv 入口）', t.masterUrl)

// 分片（对比：bytes_response 带 ACAO）
const segLine = (list ?? '').split('\n').find((l) => l.trim().startsWith('http'))
if (segLine) await show('segment（对照）', segLine.trim())
else {
  const rel = (list ?? '').split('\n').find((l) => l.trim().startsWith('/seg/'))
  if (rel) await show('segment（对照）', new URL(rel.trim(), t.playUrl).toString())
}

// 预检（hls.js 若带 Range/自定义头会先发 OPTIONS）
const pre = await fetch(t.playUrl, {
  method: 'OPTIONS',
  headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range' },
  signal: AbortSignal.timeout(10000)
}).catch((e) => ({ status: 0, headers: new Map(), e }))
console.log(`\n--- OPTIONS 预检\n    status=${pre.status} acao=${pre.headers?.get?.('access-control-allow-origin') ?? '(缺失)'} methods=${pre.headers?.get?.('access-control-allow-methods') ?? '(缺失)'} headers=${pre.headers?.get?.('access-control-allow-headers') ?? '(缺失)'}`)

child.kill()
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(0)
