// src/main/tools/ripgrepPath.ts
import * as fs from 'fs'
import * as path from 'path'

/**
 * @vscode/ripgrep 的平台子包名映射。
 * 平台子包只含二进制（无 JS 主模块），require.resolve 其 package.json 是 CJS 安全的。
 */
const PLATFORM_PACKAGES: Record<string, string> = {
  'win32-x64': '@vscode/ripgrep-win32-x64',
  'darwin-x64': '@vscode/ripgrep-darwin-x64',
  'darwin-arm64': '@vscode/ripgrep-darwin-arm64',
  'linux-x64': '@vscode/ripgrep-linux-x64',
  'linux-arm64': '@vscode/ripgrep-linux-arm64',
}

/**
 * 解析 ripgrep 可执行文件路径。
 *
 * 优先级：
 * 1. `CODEZ_RG_PATH` 环境变量（测试覆盖用，指向不存在的路径可强制触发回退/报错）。
 * 2. `@vscode/ripgrep` 的平台子包二进制——运行期 Electron main 进程为 CJS，
 *    `require('@vscode/ripgrep')`（ESM-only）会抛 ERR_REQUIRE_ESM；这里只
 *    `require.resolve` 平台子包的 package.json 取目录，不执行其代码，规避 ESM 问题。
 * 3. `require('@vscode/ripgrep').rgPath`——vitest/Node 经 SSR 可处理 ESM require，作为回退。
 */
export function resolveRgPath(): string | null {
  if (process.env.CODEZ_RG_PATH) return process.env.CODEZ_RG_PATH

  const key = `${process.platform}-${process.arch}`
  const pkg = PLATFORM_PACKAGES[key]
  if (pkg) {
    try {
      const pkgJsonPath = require.resolve(`${pkg}/package.json`)
      const binName = process.platform === 'win32' ? 'rg.exe' : 'rg'
      const bin = path.join(path.dirname(pkgJsonPath), 'bin', binName)
      if (fs.existsSync(bin)) return bin
    } catch {
      // 平台子包未安装，继续回退
    }
  }

  try {
    const mod = require('@vscode/ripgrep')
    if (mod && mod.rgPath) return mod.rgPath
  } catch {
    // ESM require 在 Electron CJS 运行期失败，忽略
  }
  return null
}
