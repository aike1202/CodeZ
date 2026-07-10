export type PermissionShellKind = 'bash' | 'powershell' | 'cmd'

export interface NormalizedOperation {
  shell: PermissionShellKind
  source: string
  executable: string
  argv: string[]
  dynamic: boolean
  children: NormalizedOperation[]
}

export interface NormalizedRedirect {
  operator: '<' | '>' | '>>'
  target: string
}

export interface NormalizedOperationGraph {
  shell: PermissionShellKind
  source: string
  operations: NormalizedOperation[]
  operators: string[]
  redirects: NormalizedRedirect[]
  diagnostics: string[]
}
