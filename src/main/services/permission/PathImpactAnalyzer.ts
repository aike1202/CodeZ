import * as fs from 'fs/promises'
import * as path from 'path'

export interface PathImpactResult {
  inputPath: string
  resolvedPath: string
  realParentPath: string
  insideWorkspace: boolean
  sensitive: boolean
}

async function nearestExistingParent(target: string): Promise<{ parent: string; suffix: string[] }> {
  const suffix: string[] = []
  let current = target
  while (true) {
    try {
      await fs.lstat(current)
      return { parent: current, suffix: suffix.reverse() }
    } catch {
      const next = path.dirname(current)
      if (next === current) return { parent: current, suffix: suffix.reverse() }
      suffix.push(path.basename(current))
      current = next
    }
  }
}

function normalizeForCompare(value: string): string {
  const normalized = path.resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export class PathImpactAnalyzer {
  async analyze(inputPath: string, workspaceRoot: string, cwd = workspaceRoot): Promise<PathImpactResult> {
    const resolvedPath = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(cwd, inputPath)
    const nearest = await nearestExistingParent(resolvedPath)
    let realParentPath = nearest.parent
    try {
      realParentPath = await fs.realpath(nearest.parent)
    } catch {}
    const canonicalTarget = path.join(realParentPath, ...nearest.suffix)
    let realRoot = path.resolve(workspaceRoot)
    try {
      realRoot = await fs.realpath(workspaceRoot)
    } catch {}
    const relative = path.relative(normalizeForCompare(realRoot), normalizeForCompare(canonicalTarget))
    const insideWorkspace = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
    const normalized = canonicalTarget.replace(/\\/g, '/').toLowerCase()
    const sensitive = /\/(?:\.ssh|\.aws)(?:\/|$)|\/(?:etc|private\/etc)(?:\/|$)|\/(?:\.bashrc|\.zshrc|\.profile)$|\/(?:\.npmrc|\.pypirc|\.netrc)$/.test(normalized)
    return { inputPath, resolvedPath: canonicalTarget, realParentPath, insideWorkspace, sensitive }
  }
}
