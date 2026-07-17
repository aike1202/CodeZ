import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

type CargoDependency = {
  name: string
  kind: 'dev' | 'build' | null
}

type CargoPackage = {
  name: string
  dependencies: CargoDependency[]
}

type CargoMetadata = {
  packages: CargoPackage[]
  workspace_members: string[]
}

const metadata = JSON.parse(
  execFileSync('cargo', ['metadata', '--no-deps', '--format-version', '1'], {
    encoding: 'utf8'
  })
) as CargoMetadata

const internalPackages = new Set(metadata.packages.map((pkg) => pkg.name))
const allowedInternalDependencies: Record<string, Set<string>> = {
  'codez-core': new Set(),
  'codez-contracts': new Set(['codez-core']),
  'codez-runtime': new Set(['codez-core']),
  'codez-platform': new Set(['codez-core']),
  'codez-providers': new Set(['codez-core']),
  'codez-mcp': new Set(['codez-core']),
  'codez-storage': new Set(['codez-core'])
}
const allowedInternalDevDependencies: Record<string, Set<string>> = {
  'codez-runtime': new Set(['codez-storage'])
}
const tauriForbidden = new Set(Object.keys(allowedInternalDependencies))
const violations: string[] = []

function rustFilesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return rustFilesBelow(path)
    return entry.isFile() && entry.name.endsWith('.rs') ? [path] : []
  })
}

for (const pkg of metadata.packages) {
  const allowed = allowedInternalDependencies[pkg.name]
  if (allowed) {
    for (const dependency of pkg.dependencies) {
      const allowedForKind = dependency.kind === 'dev'
        ? allowedInternalDevDependencies[pkg.name] ?? new Set<string>()
        : allowed
      if (internalPackages.has(dependency.name) && !allowedForKind.has(dependency.name)) {
        const kind = dependency.kind === 'dev' ? 'dev-depend on' : 'depend on'
        violations.push(`${pkg.name} must not ${kind} ${dependency.name}`)
      }
    }
  }
  if (tauriForbidden.has(pkg.name) && pkg.dependencies.some((dependency) => dependency.name === 'tauri')) {
    violations.push(`${pkg.name} must not depend on Tauri`)
  }
}

const storageSource = resolve('crates/codez-storage/src')
const legacyBase64Reader = resolve(storageSource, 'migration/legacy_safe_storage.rs')
for (const sourcePath of rustFilesBelow(storageSource)) {
  if (sourcePath !== legacyBase64Reader && readFileSync(sourcePath, 'utf8').includes('base64::')) {
    violations.push(
      `codez-storage Base64 is migration-only but was imported by ${relative(process.cwd(), sourcePath)}`
    )
  }
}

if (violations.length > 0) {
  console.error('Rust dependency direction violations:')
  for (const violation of violations) console.error(`- ${violation}`)
  process.exitCode = 1
} else {
  console.log(
    `Rust dependency directions and credential fallback boundaries are valid across ${metadata.workspace_members.length} workspace packages.`
  )
}
