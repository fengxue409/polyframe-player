#!/usr/bin/env node
// 确保 release 目录下存在以当前版本号命名的子文件夹（幂等）。
// 版本号来源：apps/desktop/package.json 的 "version" 字段
// （electron-builder 以它命名打包产物，如 "PolyFrame Player Setup 0.1.1.exe"）。
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = path.join(appRoot, 'package.json')
const releaseDir = path.join(appRoot, 'release')

function fail(msg) {
  console.error(`[ensure-release-dir] ${msg}`)
  process.exit(1)
}

// 1. 读取 package.json
if (!existsSync(pkgPath)) fail(`找不到 ${pkgPath}，无法确定版本号`)
let pkg
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
} catch (e) {
  fail(`package.json 解析失败：${e.message}`)
}

// 2. 校验版本号存在且格式合法（宽松 semver：主.次.修订[-预发布][+构建]）
const version = pkg.version
if (!version || typeof version !== 'string') fail('package.json 缺少 "version" 字段')
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
if (!SEMVER_RE.test(version)) fail(`版本号格式异常："${version}"（期望 主.次.修订，如 0.1.1）`)

// 3. 确保 release 目录存在（含打包前手动清理的场景）
mkdirSync(releaseDir, { recursive: true })

// 4. 版本子目录：已存在则跳过，不存在则创建（幂等）
const versionDir = path.join(releaseDir, version)
if (existsSync(versionDir)) {
  console.log(`[ensure-release-dir] 已存在，跳过：${versionDir}`)
} else {
  mkdirSync(versionDir)
  console.log(`[ensure-release-dir] 已创建：${versionDir}`)
}
