export function matchPermissionPattern(value: string, pattern: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`).test(value)
}
