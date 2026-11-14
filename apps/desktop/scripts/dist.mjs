#!/usr/bin/env node
// 打包流水线：electron-vite build → electron-builder，产物直接落 release/<version>/。
//
// 背景：electron-builder 的 directories.output 只能给静态目录（不支持 ${version} 插值），
// 之前产物全堆在 release/ 根下，版本目录形同虚设。这里在命令行用
// `-c.directories.output=release/<version>` 覆盖配置，一次打包到位。
//
// 用法：
//   pnpm dist                 # 完整打包（产物在 release/<version>/）
//   node scripts/dist.mjs --dry-run   # 只校验版本号并打印将执行的命令
//
// 注意：打包前先改 apps/desktop/package.json 的 version（产物命名与目录都取自它）。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')

function fail(msg) {
  console.error(`[dist] ${msg}`)
  process.exit(1)
}

// 1. 版本号（与 electron-builder 产物命名同源）
const pkgPath = path.join(appRoot, 'package.json')
if (!existsSync(pkgPath)) fail(`找不到 ${pkgPath}`)
let version
try {
  version = JSON.parse(readFileSync(pkgPath, 'utf8')).version
} catch (e) {
  fail(`package.json 解析失败：${e.message}`)
}
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
if (!version || !SEMVER_RE.test(version)) fail(`版本号异常："${version}"（期望 主.次.修订，先改 package.json 再打包）`)

// 2. 版本目录：相对路径（cwd=appRoot），避免含空格的绝对路径在 shell 层被拆断
const outRel = `release/${version}`
const outDir = path.join(appRoot, outRel)
mkdirSync(outDir, { recursive: true })

const steps = [
  ['pnpm', ['exec', 'electron-vite', 'build']],
  // 用空目录打包：上次打包遗留的旧产物不混进本轮（builder-debug.yml 等由 builder 自行覆盖）
  ['pnpm', ['exec', 'electron-builder', '--win', '--x64', `-c.directories.output=${outRel}`]]
]

console.log(`[dist] version=${version} → ${outDir}`)
if (dryRun) {
  for (const [cmd, args] of steps) console.log(`[dry-run] ${cmd} ${args.join(' ')}`)
  process.exit(0)
}

// 3. 清空版本目录里的旧产物（半截包比没有包更危险）
for (const f of readdirSync(outDir)) {
  rmSync(path.join(outDir, f), { recursive: true, force: true })
}

// 4. 顺序执行；任一步非 0 退出码即终止。
// NO_UPDATE_NOTIFIER：electron-builder 启动时会查 npm registry 看有没有新版，
// 本机直连 registry 经常卡住 6 分钟+（还可能连累主流程），直接关掉。
for (const [cmd, args] of steps) {
  const r = spawnSync(cmd, args, {
    cwd: appRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32', // Windows 下解析 pnpm.cmd
    env: { ...process.env, NO_UPDATE_NOTIFIER: '1' }
  })
  if (r.status !== 0) fail(`${cmd} ${args[0]} 失败（exit ${r.status}）`)
}

console.log(`[dist] 完成，产物目录：${outDir}`)
