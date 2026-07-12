export function normalizeExecutableName(raw: string): string {
  const unquoted = raw.replace(/^(['"])(.*)\1$/, '$2')
  return unquoted
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.(?:exe|cmd|bat|ps1|sh)$/i, '')
    .toLowerCase() || ''
}
