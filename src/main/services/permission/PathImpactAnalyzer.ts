import * as fs from 'fs/promises'
import * as fsSync from 'fs'
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

export function samePathIdentity(left: string, right: string): boolean {
  return normalizeForCompare(left) === normalizeForCompare(right)
}

/** Rechecks the physical target after asynchronous lock waits and before I/O. */
export function assertStableWorkspacePathSync(
  inputPath: string,
  workspaceRoot: string,
  expectedResolvedPath: string
): string {
  const current = analyzePathImpactSync(inputPath, workspaceRoot)
  if (!current.insideWorkspace || !samePathIdentity(current.resolvedPath, expectedResolvedPath)) {
    throw new Error('Workspace path identity changed after validation. Retry the operation.')
  }
  return current.resolvedPath
}

/** Synchronous counterpart for tool-scope checks that must fail before execution. */
export function analyzePathImpactSync(
  inputPath: string,
  workspaceRoot: string,
  cwd = workspaceRoot
): PathImpactResult {
  const requestedPath = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(cwd, inputPath)
  const suffix: string[] = []
  let nearestParent = requestedPath
  while (true) {
    try {
      fsSync.lstatSync(nearestParent)
      break
    } catch {
      const next = path.dirname(nearestParent)
      if (next === nearestParent) break
      suffix.push(path.basename(nearestParent))
      nearestParent = next
    }
  }

  let realParentPath = nearestParent
  try {
    realParentPath = fsSync.realpathSync.native(nearestParent)
  } catch {}
  const canonicalTarget = path.join(realParentPath, ...suffix.reverse())
  let realRoot = path.resolve(workspaceRoot)
  try {
    realRoot = fsSync.realpathSync.native(workspaceRoot)
  } catch {}
  const relative = path.relative(normalizeForCompare(realRoot), normalizeForCompare(canonicalTarget))
  const insideWorkspace = relative === '' || (
    relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  )
  const normalized = canonicalTarget.replace(/\\/g, '/').toLowerCase()
  const sensitive = /\/(?:\.ssh|\.aws)(?:\/|$)|\/(?:etc|private\/etc)(?:\/|$)|\/(?:\.bashrc|\.zshrc|\.profile)$|\/(?:\.npmrc|\.pypirc|\.netrc)$|\/codez\/(?:permission-rules|workspace-permissions)\.json$/.test(normalized)
  return {
    inputPath,
    resolvedPath: canonicalTarget,
    realParentPath,
    insideWorkspace,
    sensitive
  }
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
    const insideWorkspace = relative === '' || (
      relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    )
    const normalized = canonicalTarget.replace(/\\/g, '/').toLowerCase()
    const sensitive = /\/(?:\.ssh|\.aws)(?:\/|$)|\/(?:etc|private\/etc)(?:\/|$)|\/(?:\.bashrc|\.zshrc|\.profile)$|\/(?:\.npmrc|\.pypirc|\.netrc)$|\/codez\/(?:permission-rules|workspace-permissions)\.json$/.test(normalized)
    return { inputPath, resolvedPath: canonicalTarget, realParentPath, insideWorkspace, sensitive }
  }
}
