/**
 * P40 任务状态分组（任务页展示 + 下载槽策略唯一真相）。
 *
 * 为什么单独成文件：分组同时决定「徽章写什么」「这一行能点哪些按钮」
 * 「谁允许下载」。三处各写一遍必然漂移——库里是 `paused`、徽章却按
 * `ready` 显示「就绪」，用户就看不出它其实在等手动启动。
 *
 * 硬约束：**互斥且穷尽**。六个分组必须覆盖 `TaskStatus` 全部取值，
 * 且任一任务只落进一个组；`taskGroupOf` 的判定顺序即优先级，不要随意调换。
 */

import type { Task } from '@polyframe/shared'

export type TaskGroupKey = 'playing' | 'downloading' | 'preparing' | 'paused' | 'done' | 'failed'

export interface TaskGroupDef {
  key: TaskGroupKey
  label: string
  /** 判定规则（原样展示给用户，省得猜「为什么它在这一组」） */
  rule: string
  /** 该组是否允许下载：同一时刻只有「播放中」或「下载中」能占下载槽 */
  runnable: boolean
}

/** 展示顺序 = 优先级：正在播的永远在最上面，需要动手的（失败）压在最下面 */
export const TASK_GROUPS: TaskGroupDef[] = [
  {
    key: 'playing',
    label: '播放中',
    rule: '正在播放的那个任务（playing=true 且 id=当前任务）',
    runnable: true
  },
  {
    key: 'downloading',
    label: '下载中',
    rule: '手动「启动」的任务；同一时刻只允许一个，起播时让位给播放任务',
    runnable: true
  },
  {
    key: 'preparing',
    label: '准备中',
    rule: 'pending / probing，或 ready 但还没登记分片：正在解析源站清单',
    runnable: false
  },
  {
    key: 'paused',
    label: '已暂停',
    rule: 'paused / ready 但分片没下完（job 已收尾）。不会自动恢复，需点「启动」',
    runnable: false
  },
  {
    key: 'done',
    label: '已完成',
    rule: '分片已全部缓存（segDone ≥ segTotal），或 online 档无缓存需求',
    runnable: false
  },
  {
    key: 'failed',
    label: '失败',
    rule: 'failed：解析或首个分片仍失败，可点「启动」重试',
    runnable: false
  }
]

/** 分片是否已全部落盘（online 档没有分片，恒为 false，单独按档位判定） */
export function isTaskComplete(t: Task): boolean {
  const total = t.segTotal ?? 0
  return total > 0 && (t.segDone ?? 0) >= total
}

/**
 * 判定一个任务属于哪个分组。
 *
 * `playingTaskId` 由调用方传入（`player.playingTaskId`），不在这里读 store：
 * 纯函数才能在任务页、测试、脚本里共用同一份语义。
 */
export function taskGroupOf(t: Task, playingTaskId: string): TaskGroupKey {
  // 1) 在跑的任务先分：downloading 是唯一「内核 job 在跑」的状态
  if (t.status === 'downloading') return t.id === playingTaskId ? 'playing' : 'downloading'
  if (t.status === 'failed') return 'failed'
  if (t.status === 'pending' || t.status === 'probing') return 'preparing'
  // 2) online 档没有分片可下，落到「已完成」而不是「已暂停」（它本来就不该有下载）
  if (t.cacheMode === 'online') return 'done'
  // 3) 一条分片都没登记：ready 说明清单还在解析（给了「启动」也无处下手），
  //    paused 才是真的停在这儿等启动
  const total = t.segTotal ?? 0
  if (total === 0) return t.status === 'ready' ? 'preparing' : 'paused'
  // 4) 分片齐 = 已完成（paused 但下完也算，别让人以为还要操作）
  if ((t.segDone ?? 0) >= total) return 'done'
  // 5) paused，或 finish_job 收尾时写成 ready 但没下完 —— 两者都只能手动启动
  return 'paused'
}

/**
 * 该行是否该给「启动」按钮：只有「还能继续下」的组才有意义。
 *
 * `playingTaskId` 非空且不是本任务时一律不给：下载槽已被播放任务占住，
 * 点下去也只会被下一次收敛立刻停掉（按钮看起来像坏的）。
 */
export function canStartTask(t: Task, group: TaskGroupKey): boolean {
  if (t.cacheMode === 'online') return false
  // 注意：不要把「别的任务正在播」算进来。那是**临时不可用**，按钮要留着并禁用
  // 加一句原因；直接返回 false 会让按钮消失，用户以为功能没了。
  return group === 'paused' || group === 'failed'
}

/** 该行是否该给「暂停」按钮 */
export function canPauseTask(t: Task): boolean {
  return t.status === 'downloading'
}

/**
 * 状态徽章文案：**跟随分组而不是原始 status**。
 *
 * `ready` 但没下完的任务在库里是 ready，分组却是「已暂停」；
 * 徽章若照抄 status 就会出现「已暂停组里的行写着就绪」的自相矛盾。
 */
export function statusTextOf(t: Task, group: TaskGroupKey): string {
  switch (group) {
    case 'playing':
      return '播放中'
    case 'downloading':
      return '下载中'
    case 'preparing':
      return t.status === 'probing' ? '解析中' : '等待'
    case 'paused':
      return t.status === 'paused' ? '已暂停' : '未下完'
    case 'done':
      return t.cacheMode === 'online' && !isTaskComplete(t) ? '在线' : '已完成'
    case 'failed':
      return '失败'
  }
}
