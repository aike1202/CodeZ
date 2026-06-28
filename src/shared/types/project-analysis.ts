export interface ProjectSnapshot {
  rootName: string
  rootPath: string
  projectType: string
  packageManager: string
  scripts: Record<string, string>
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  configFiles: string[]
  entrypoints: string[]
  recommendedFiles: string[]
  tree: string
  docsTree: string
  fromCache: boolean
  updatedAt: string
}

export interface ProjectSnapshotOptions {
  dirPath?: string
  dirPaths?: string[]
  maxDepth?: number
  includeFiles?: boolean
  forceRefresh?: boolean
}

export interface ReadManyFilesOptions {
  filePaths: string[]
  maxCharsPerFile?: number
}

export interface ReadManyFilesResult {
  files: Array<{
    path: string
    content: string
    truncated: boolean
    totalLines: number
    error?: string
  }>
}

export interface SearchCodeOptions {
  query: string
  dirPath?: string
  includeGlobs?: string[]
  maxResults?: number
  contextLines?: number
}

export interface CodeSearchResult {
  matches: Array<{
    path: string
    line: number
    text: string
    before?: string[]
    after?: string[]
  }>
  truncated: boolean
}

export interface SymbolMapOptions {
  dirPath?: string
  maxResults?: number
}

export interface SymbolMapResult {
  symbols: Array<{
    name: string
    kind: string
    path: string
    line: number
  }>
  truncated: boolean
}
