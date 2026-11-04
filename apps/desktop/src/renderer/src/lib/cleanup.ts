/**
 * P35 清理规则（媒体库 / 任务页共用）。
 *
 * 这里只放**纯函数**：给定一份任务 / 收藏快照，算出「这一条规则会选中什么」。
 * 视图层只负责把选中结果渲染出来、弹确认、发批量 RPC。
 *
 * 为什么不把判定写在两个视图里：
 * 任务页按行、媒体库按视频组，同一部剧在两边是「N 集」和「1 张卡」，
 * 但「已完成 / 失败 / 空记录」的语义必须完全一致 —— 否则用户会看到
 * 任务页说「已完成 3 个」而媒体库说「已完成 2 部」，谁也不信。
 */

import type { Favorite, FavoriteSource, Task } from '@polyframe/shared'

// ---------- 任务规则 ----------

export type TaskRuleKey = 'done' | 'failed' | 'empty' | 'all'

export interface CleanupRule<K extends string> {
  key: K
  label: string
  /** 下拉里的一行说明：写清「删什么、不删什么」 */
  hint: string
  /** 破坏性更强的一档（全部清空）用红色确认按钮 */
  danger?: boolean
}

/**
 * 清理菜单项：规则 + 当前会选中多少条 / 能释放多少。
 *
 * 放在这里而不是 SFC 里，是因为 `<script setup>` 不能有 ES 导出，
 * 视图与菜单组件需要一个共同的类型来源。
 */
export interface CleanupMenuItem {
  key: string
  label: string
  hint: string
  count: number
  bytes?: number
  danger?: boolean
}

export const TASK_RULES: CleanupRule<TaskRuleKey>[] = [
  {
    key: 'done',
    label: '清理已完成',
    hint: '已下完的任务，连缓存一起删；正在下载的不会被选中'
  },
  { key: 'failed', label: '清理失败', hint: '失败任务与其残留分片' },
  {
    key: 'empty',
    label: '清理空记录',
    hint: '没有任何缓存的记录（不影响收藏与播放历史）'
  },
  { key: 'all', label: '清空全部任务', hint: '全部任务与缓存，不可恢复', danger: true }
]

/** 任务已缓存字节（列表里由 segments 聚合而来，缺省按 0 算） */
export function taskBytes(t: Task): number {
  return t.bytesDone ?? 0
}

/**
 * 「已完成」= 分片全下完（暂停在最后一帧的也算），或状态 ready 且确有缓存。
 *
 * 两个刻意的排除：
 * - 在途状态（下载/等待/解析）一律不算，哪怕分片数已经追平总数；
 * - `ready` 但缓存已被清空的记录不算 —— 那是「空记录」，归另一条规则。
 *   否则「清理已完成」会把空壳记录也算进去，两条规则的计数互相重叠。
 */
export function isFinishedTask(t: Task): boolean {
  if (t.status === 'downloading' || t.status === 'pending' || t.status === 'probing') return false
  const total = t.segTotal ?? 0
  const done = t.segDone ?? 0
  if (total > 0) return done >= total
  return t.status === 'ready' && taskBytes(t) > 0
}

/**
 * 「空记录」= 没有缓存字节也没有已落盘分片。
 *
 * 必须排除在途状态：刚创建的任务分片表还没建，bytes=0 是正常的，
 * 按空记录删掉就等于「新建即被清理」—— 这是最容易被写错的一条规则。
 */
export function isEmptyTask(t: Task): boolean {
  if (t.status === 'downloading' || t.status === 'pending' || t.status === 'probing') return false
  return (t.segDone ?? 0) === 0 && taskBytes(t) === 0
}

export function isFailedTask(t: Task): boolean {
  return t.status === 'failed'
}

/** 按规则挑任务（规则与界面文案一一对应，新增规则必须同步 TASK_RULES） */
export function tasksByRule(tasks: Task[], rule: TaskRuleKey): Task[] {
  switch (rule) {
    case 'done':
      return tasks.filter(isFinishedTask)
    case 'failed':
      return tasks.filter(isFailedTask)
    case 'empty':
      return tasks.filter(isEmptyTask)
    case 'all':
      return [...tasks]
  }
}

// ---------- 统计 ----------

export interface CleanupStat {
  /** 任务条数（媒体库里等于集数） */
  count: number
  /** 缓存字节合计 */
  bytes: number
}

export function summarizeTasks(tasks: Task[]): CleanupStat {
  let bytes = 0
  for (const t of tasks) bytes += taskBytes(t)
  return { count: tasks.length, bytes }
}

/** 体积文案：清理确认框里必须能一眼看出「能腾出多少」 */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${Math.round(n)} B`
}

/** 预览名单：只列前几条，剩下的折成「等 N 项」 */
export function previewNames(names: string[], max = 6): { shown: string[]; rest: number } {
  const shown = names.slice(0, max)
  return { shown, rest: Math.max(0, names.length - shown.length) }
}

// ---------- 收藏规则 ----------

export type FavoriteRuleKey = 'no-source' | 'no-episode' | 'duplicate'

export const FAVORITE_RULES: CleanupRule<FavoriteRuleKey>[] = [
  {
    key: 'no-source',
    label: '清理无片源收藏',
    hint: '收藏了但一条片源都没有，打开也播不了'
  },
  {
    key: 'no-episode',
    label: '清理无剧集收藏',
    hint: '所有片源都取不到剧集（多半是站方下架）'
  },
  {
    key: 'duplicate',
    label: '清理重复收藏',
    hint: '同名收藏只保留最新一条，其余取消收藏'
  }
]

/** 名称归一：去掉首尾空白、全角空格与内部所有空白后小写比较 */
export function normalizeFavoriteName(name: string): string {
  return (name || '')
    .replace(/[\s\u3000]+/g, '')
    .trim()
    .toLowerCase()
}

/**
 * 按规则挑收藏。
 *
 * `sourcesByFav` 只包含**已经拉过片源**的收藏（见 catalog.loadAllFavoriteSources）。
 * 没拉过的（键不存在）一律跳过 —— 把「还不知道」当成「没有片源」会误删用户刚收藏的条目。
 */
export function favoritesByRule(
  favorites: Favorite[],
  sourcesByFav: Record<string, FavoriteSource[]>,
  rule: FavoriteRuleKey
): Favorite[] {
  if (rule === 'no-source') {
    return favorites.filter((f) => {
      const list = sourcesByFav[f.id]
      return Array.isArray(list) && list.length === 0
    })
  }
  if (rule === 'no-episode') {
    return favorites.filter((f) => {
      const list = sourcesByFav[f.id]
      return Array.isArray(list) && list.length > 0 && list.every((s) => !s.episodes?.length)
    })
  }
  // duplicate：同名分组里保留 createdAt 最新的一条（ISO 字符串可直接比较）
  const groups = new Map<string, Favorite[]>()
  for (const f of favorites) {
    const k = normalizeFavoriteName(f.name)
    if (!k) continue
    const arr = groups.get(k)
    if (arr) arr.push(f)
    else groups.set(k, [f])
  }
  const drop: Favorite[] = []
  for (const arr of groups.values()) {
    if (arr.length < 2) continue
    const keep = arr.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b))
    for (const f of arr) if (f.id !== keep.id) drop.push(f)
  }
  return drop
}
