/**
 * P37 诊断日志落盘。
 *
 * 背景：播放失败的现场原本只活在两处 —— 渲染层的调试抽屉（内存，关掉即失）
 * 和内核的 stderr（`rpc.ts` 里被直接丢弃）。而代理回源失败（`[pf-proxy] 回源失败`）、
 * 内核 panic、GPU 进程崩溃恰恰只出现在这两处，导致「黑屏」这类问题只能靠猜。
 *
 * 这里做三件事：
 *  1. 内核 stdout/stderr 逐行落盘（按标签 core）；
 *  2. 主进程事件（子进程消失、加载失败、渲染进程崩溃、控制台）落盘；
 *  3. 渲染层通过 `pf:diag-log` 转发的播放器日志落盘。
 *
 * 注意：写入用异步流，绝不能在主进程做同步写（Windows 下管道反压会卡死 UI）。
 */

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/** 单文件上限，超过就滚成 .old（只留一代，避免无界增长） */
const MAX_BYTES = 8 * 1024 * 1024

let stream: fs.WriteStream | null = null
let logPath = ''
let pending = 0

function stamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 23)
}

/** 初始化：`%LOCALAPPDATA%/PolyFrame/logs/app-YYYY-MM-DD.log`，返回路径 */
export function initDiag(): string {
  if (stream) return logPath
  const root = process.env.LOCALAPPDATA || app.getPath('userData')
  const dir = path.join(root, 'PolyFrame', 'logs')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    return ''
  }
  const day = new Date().toISOString().slice(0, 10)
  logPath = path.join(dir, `app-${day}.log`)
  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > MAX_BYTES) {
      fs.renameSync(logPath, `${logPath}.old`)
    }
  } catch {
    // 滚动失败不影响继续写
  }
  try {
    stream = fs.createWriteStream(logPath, { flags: 'a' })
    stream.on('error', () => {
      stream = null
    })
  } catch {
    stream = null
  }
  write(
    'main',
    `==== 启动 v${app.getVersion()} electron=${process.versions.electron} ` +
      `chrome=${process.versions.chrome} packed=${app.isPackaged} pid=${process.pid} ====`
  )
  return logPath
}

/** 写一行（多行按行拆开，去掉空行） */
export function write(tag: string, msg: unknown): void {
  if (!stream) return
  const text = String(msg ?? '').replace(/[\r\n]+$/, '')
  if (!text) return
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    // 反压保护：待写字节过多时丢日志，绝不阻塞主进程
    if (pending > 2 * 1024 * 1024) return
    const buf = `${stamp()} [${tag}] ${line}\n`
    pending += buf.length
    stream.write(buf, () => {
      pending -= buf.length
    })
  }
}

export function logPathOf(): string {
  return logPath
}
