import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import readline from 'node:readline'
import type { CoreInfo } from '@polyframe/shared'
import { write as diag } from './diag'

export type CoreStatus = 'idle' | 'starting' | 'online' | 'unavailable' | 'error' | 'stopped'

export interface CoreStatusInfo {
  status: CoreStatus
  port?: number
  proxyPort?: number
  info?: CoreInfo
  error?: string
  binPath?: string
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

const START_TIMEOUT_MS = 15_000
/**
 * 单条 RPC 等待上限。P43 从 10s 提到 35s：
 * - 单源请求超时 9s，搜索失败还会回退 videolist（9+9=18s）；
 * - `catalog.category` 的填页循环最多连翻 3 页（窄筛选时 3×9=27s）。
 * 上限压得太低，慢源站会被前端记成「请求超时」，看着又像「结果少」。
 */
const REQUEST_TIMEOUT_MS = 35_000

/**
 * Rust 内核桥接：spawn pf-core → stdout 端口发现 → TCP NDJSON RPC。
 * 内核通知（task.updated / core.log）通过 'event' 事件对外广播。
 */
export class CoreBridge extends EventEmitter {
  private proc: ChildProcess | null = null
  private binPath: string | null = null
  private socket: net.Socket | null = null
  private pending = new Map<number, PendingRequest>()
  private nextId = 1
  private stdoutBuf = ''

  private statusValue: CoreStatus = 'idle'
  private statusError = ''
  private port = 0
  private proxyPort = 0
  private rpcToken = ''
  private info: CoreInfo | null = null

  statusSnapshot(): CoreStatusInfo {
    return {
      status: this.statusValue,
      port: this.port || undefined,
      proxyPort: this.proxyPort || undefined,
      info: this.info ?? undefined,
      error: this.statusError || undefined,
      binPath: this.binPath ?? undefined
    }
  }

  /** 崩溃自动重启：异常退出且非人为 stop 时，1s 后拉起（限 5 次，防崩溃循环） */
  private restartAttempts = 0
  private restartTimer: NodeJS.Timeout | null = null
  private static MAX_RESTARTS = 5

  /** 幂等调度重启：socket close 与 proc exit 都可能触发，只生效一次 */
  private scheduleRestart(reason: string): void {
    if (this.restartTimer) return
    if (this.restartAttempts >= CoreBridge.MAX_RESTARTS) {
      console.error(`[bridge] restart limit reached, give up (${reason})`)
      return
    }
    this.restartAttempts += 1
    const bin = this.binPath
    if (!bin) return
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      console.error(`[bridge] restart tick (${reason}) status=${this.statusValue}`)
      if (this.statusValue !== 'stopped') {
        this.port = 0
        this.proxyPort = 0
        void this.start(bin).then(() =>
          console.error(`[bridge] start() done status=${this.statusValue}`)
        )
      }
    }, 1000)
  }

  private setStatus(status: CoreStatus, error = ''): void {
    diag('core-status', `${this.statusValue} → ${status}${error ? ` (${error})` : ''}`)
    this.statusValue = status
    this.statusError = error
    this.emit('status', this.statusSnapshot())
  }

  /** 启动内核；bin 为 null 表示未找到可执行文件 → unavailable（UI 优雅降级） */
  async start(bin: string | null): Promise<void> {
    this.stop(true)
    if (!bin) {
      this.setStatus('unavailable', '未找到 pf-core.exe（先运行 pnpm core:build 构建 Rust 内核）')
      return
    }
    this.binPath = bin
    this.setStatus('starting')
    this.proc = spawn(bin, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    diag('main', `[bridge] spawned pid=${this.proc.pid} bin=${bin}`)
    console.error(`[bridge] spawned pid=${this.proc.pid}`)

    this.proc.stdout!.setEncoding('utf8')
    this.proc.stdout!.on('data', (chunk: string) => this.consumeStdout(chunk))
    // 内核 stderr 是调试日志（含 `[pf-proxy] 回源失败` 这类唯一故障取证）：
    // 不落盘就永远查不了「黑屏」，但也绝不能同步写（Windows 管道反压）。diag 内部是异步流。
    this.proc.stderr!.setEncoding('utf8')
    this.proc.stderr!.on('data', (chunk: string) => diag('core', chunk))
    this.proc.on('exit', (code) => {
      diag('main', `[bridge] proc exit code=${code} status=${this.statusValue}`)
      console.error(`[bridge] proc exit code=${code} status=${this.statusValue}`)
      this.teardownSocket()
      if (this.statusValue !== 'stopped') {
        this.setStatus('error', `内核进程退出（code=${code ?? 'signal'}）`)
        // 崩溃自动重启（成功上线后计数归零）；Windows 下 exit 事件可能显著延迟，
        // 故 socket close 也会触发 scheduleRestart（幂等），此处为兜底
        this.scheduleRestart('proc exit')
      }
    })

    // 等待端口发现（端口 + 鉴权 token 都就绪才连接）
    const deadline = Date.now() + START_TIMEOUT_MS
    while ((this.port === 0 || !this.rpcToken) && Date.now() < deadline && this.proc.exitCode === null) {
      await new Promise((r) => setTimeout(r, 50))
    }
    if (this.port === 0) {
      this.setStatus('error', '等待 PF_CORE_PORT 超时')
      return
    }
    if (!this.rpcToken) {
      this.setStatus('error', '等待 PF_CORE_TOKEN 超时')
      return
    }

    await this.connect()
  }

  /** 停止内核；silent=true 不向 UI 广播状态变化（用于 start 前重置） */
  stop(silent = false): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.teardownSocket()
    if (this.proc) {
      this.proc.removeAllListeners()
      this.proc.kill()
      this.proc = null
    }
    if (!silent) this.setStatus('stopped')
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuf += chunk
    let idx: number
    while ((idx = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim()
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1)
      const m = line.match(/^PF_CORE_PORT=(\d+)$/)
      if (m) this.port = Number(m[1])
      const pm = line.match(/^PF_PROXY_PORT=(\d+)$/)
      if (pm) this.proxyPort = Number(pm[1])
      // H2：连接鉴权 token（与端口发现同协议经 stdout 传递）
      const tm = line.match(/^PF_CORE_TOKEN=([0-9a-f]+)$/)
      if (tm) this.rpcToken = tm[1]
    }
  }

  private async connect(): Promise<void> {
    const socket = net.connect(this.port, '127.0.0.1')
    this.socket = socket
    socket.setNoDelay(true)

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => {
          cleanup()
          reject(err)
        }
        const onConnect = (): void => {
          cleanup()
          resolve()
        }
        const cleanup = (): void => {
          socket.off('error', onError)
          socket.off('connect', onConnect)
        }
        socket.once('error', onError)
        socket.once('connect', onConnect)
      })
    } catch (err) {
      this.setStatus('error', `连接内核失败: ${(err as Error).message}`)
      return
    }
    if (socket !== this.socket) return // 已被 stop() 清理

    // H2：连接鉴权 —— 首行必须回传 `PF_AUTH <token>`，否则内核直接断开
    socket.write(`PF_AUTH ${this.rpcToken}\n`)

    const rl = readline.createInterface({ input: socket, crlfDelay: Infinity })
    rl.on('line', (line) => this.handleLine(line.trim()))
    socket.on('close', () => {
      if (this.statusValue === 'online' || this.statusValue === 'starting') {
        this.setStatus('error', '与内核的连接已断开')
        // TCP 断开先于进程 exit 可知：立即调度重启（与 exit 兜底去重）
        this.scheduleRestart('socket close')
      }
    })

    // 握手：core.hello（获取内核信息与代理端口）
    try {
      this.info = (await this.request('core.hello')) as CoreInfo
      this.proxyPort = this.info?.proxyPort ?? 0
      this.restartAttempts = 0
      this.setStatus('online')
    } catch (err) {
      this.setStatus('error', `core.hello 失败: ${(err as Error).message}`)
    }
  }

  private teardownSocket(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new Error('core 已停止'))
    }
    this.pending.clear()
    this.socket?.destroy()
    this.socket = null
  }

  /** NDJSON 帧解析：响应按 id 关联，通知广播 */
  private handleLine(line: string): void {
    if (!line) return
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg?.id !== undefined && msg?.id !== null && ('result' in msg || 'error' in msg)) {
      const p = this.pending.get(msg.id)
      if (p) {
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(msg.error.message ?? 'RPC error'))
        else p.resolve(msg.result)
      }
    } else if (typeof msg?.method === 'string') {
      this.emit('event', msg)
    }
  }

  request(method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const socket = this.socket
    if (!socket) return Promise.reject(new Error('内核未连接'))
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RPC 超时: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
}
