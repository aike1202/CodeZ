import * as fs from 'fs'
import * as path from 'path'

const FILES = {
  runtime: ['web-tree-sitter', 'tree-sitter.wasm'],
  bash: ['tree-sitter-bash', 'tree-sitter-bash.wasm'],
  powershell: ['tree-sitter-powershell', 'tree-sitter-powershell.wasm']
} as const

export function resolveParserAsset(kind: keyof typeof FILES): string {
  const [pkg, file] = FILES[kind]
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, 'permission-parsers', file)
    if (fs.existsSync(packaged)) return packaged
  }
  return require.resolve(`${pkg}/${file}`)
}
