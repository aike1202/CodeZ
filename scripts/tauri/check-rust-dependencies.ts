import { execFileSync } from 'node:child_process'

type CargoDependency = {
  name: string
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
const tauriForbidden = new Set(Object.keys(allowedInternalDependencies))
const violations: string[] = []

for (const pkg of metadata.packages) {
  const allowed = allowedInternalDependencies[pkg.name]
  if (allowed) {
    for (const dependency of pkg.dependencies) {
      if (internalPackages.has(dependency.name) && !allowed.has(dependency.name)) {
        violations.push(`${pkg.name} must not depend on ${dependency.name}`)
      }
    }
  }
  if (tauriForbidden.has(pkg.name) && pkg.dependencies.some((dependency) => dependency.name === 'tauri')) {
    violations.push(`${pkg.name} must not depend on Tauri`)
  }
}

if (violations.length > 0) {
  console.error('Rust dependency direction violations:')
  for (const violation of violations) console.error(`- ${violation}`)
  process.exitCode = 1
} else {
  console.log(`Rust dependency directions are valid across ${metadata.workspace_members.length} workspace packages.`)
}
