import type { CoreInfo, RpcNotification } from '@polyframe/shared'

/** 内核连接状态（与 main 进程 CoreStatusInfo 同构） */
export type CoreStatus = 'idle' | 'starting' | 'online' | 'unavailable' | 'error' | 'stopped'

export interface CoreStatusPayload {
  status: CoreStatus
  port?: number
  proxyPort?: number
  info?: CoreInfo
  error?: string
  binPath?: string
}

/** preload 暴露的受控 API（window.polyframe；浏览器调试模式下不存在） */
declare global {
  interface Window {
    polyframe?: {
      status(): Promise<CoreStatusPayload>
      rpc(method: string, params?: unknown): Promise<unknown>
      /** 主窗口 HWND（10 进制；0 = 不可用） */
      nativeHwnd(): Promise<number>
      /** P6 合并导出：保存对话框 + 分片 concat */
      exportTask(taskId: string): Promise<{
        canceled: boolean
        path?: string
        bytes?: number
        segments?: number
        done?: number
        total?: number
        error?: string
      }>
      onEvent(cb: (ev: RpcNotification) => void): () => void
      onStatus(cb: (st: CoreStatusPayload) => void): () => void
      /** P10 嗅探：隐藏窗口实跑播放页，返回抓到的媒体直链候选 */
      sniffMedia?(
        url: string,
        timeoutMs?: number
      ): Promise<{ ok: boolean; playUrl?: string; candidates: string[]; ms: number; error?: string }>
      /** P10 用独立窗口打开播放页（嗅探失败兜底 / 需登录点播） */
      openParseWindow?(url: string): Promise<{ ok: boolean }>
      /** P37 诊断：把渲染层的 warn/error 转进主进程日志文件（只写不回传） */
      diag?(tag: string, msg: string): void
      /** P37 诊断：当前日志文件路径 */
      diagPath?(): Promise<string>
      /** P37 诊断：资源管理器定位日志文件 */
      openLog?(): Promise<boolean>
    }
  }
}

export {}
