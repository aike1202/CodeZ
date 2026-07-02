import * as path from 'path'
import {
  DEFAULT_IGNORED_DIRS,
  DEFAULT_IGNORED_EXTENSIONS,
  BINARY_EXTENSIONS
} from '../../../shared/constants/ignored'
import type { ProjectSnapshot, ProjectSnapshotOptions } from '../../../shared/types/project-analysis'

export interface PackageJsonShape {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  main?: string
}

export interface SnapshotCacheEntry {
  rootPath: string
  packageJsonHash?: string
  lockfileHash?: string
  options?: ProjectSnapshotOptions
  snapshot: ProjectSnapshot
}

export interface SnapshotCacheFile {
  entries: Record<string, SnapshotCacheEntry>
}

export function isSameOptions(
  opt1?: ProjectSnapshotOptions,
  opt2?: ProjectSnapshotOptions
): boolean {
  if (!opt1 || !opt2) return opt1 === opt2
  const paths1 = Array.isArray(opt1.dirPaths)
    ? opt1.dirPaths.slice().sort().join(',')
    : opt1.dirPath || '.'
  const paths2 = Array.isArray(opt2.dirPaths)
    ? opt2.dirPaths.slice().sort().join(',')
    : opt2.dirPath || '.'
  return (
    paths1 === paths2 &&
    (opt1.maxDepth ?? 3) === (opt2.maxDepth ?? 3) &&
    (opt1.includeFiles !== false) === (opt2.includeFiles !== false)
  )
}

export function isPathSafe(workspaceRoot: string, targetPath: string): boolean {
  const resolvedRoot = path.resolve(workspaceRoot)
  const resolvedTarget = path.resolve(targetPath)
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep)
}

export function toPosixPath(value: string): string {
  return value.split(path.sep).join('/')
}

export function shouldIgnoreName(name: string): boolean {
  return DEFAULT_IGNORED_DIRS.includes(name) || name === '.continue' || name.startsWith('.git')
}

export function isIgnoredFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return DEFAULT_IGNORED_EXTENSIONS.includes(ext) || BINARY_EXTENSIONS.includes(ext)
}

export function isTextLikeFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  if (!ext) return false
  return !isIgnoredFile(filePath)
}

export function stableRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {}
  return value as Record<string, string>
}
