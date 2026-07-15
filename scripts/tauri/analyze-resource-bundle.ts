import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { spawnSync } from 'child_process'

interface TauriConfig {
  bundle?: {
    resources?: Record<string, string>
  }
}

interface FileRecord {
  path: string
  bytes: number
  sha256: string
}

const workspaceRoot = process.cwd()
const tauriRoot = path.join(workspaceRoot, 'src-tauri')
const outputPath = path.join(workspaceRoot, 'docs', 'migration', 'generated', 'resource-bundle-inputs.json')

function readConfig(fileName: string): TauriConfig {
  return JSON.parse(fs.readFileSync(path.join(tauriRoot, fileName), 'utf8')) as TauriConfig
}

function sha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function filesIn(root: string): FileRecord[] {
  const output: FileRecord[] = []
  const visit = (directory: string): void => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Bundled resources cannot contain symlinks: ${fullPath}`)
      if (entry.isDirectory()) visit(fullPath)
      else if (entry.isFile()) {
        output.push({
          path: path.relative(root, fullPath).replaceAll('\\', '/'),
          bytes: fs.statSync(fullPath).size,
          sha256: sha256(fullPath)
        })
      }
    }
  }
  visit(root)
  return output
}

function resourceMap(): Record<string, string> {
  const base = readConfig('tauri.conf.json').bundle?.resources || {}
  const platformConfig = process.platform === 'win32'
    ? readConfig('tauri.windows.conf.json').bundle?.resources || {}
    : {}
  return { ...base, ...platformConfig }
}

function resolveSource(source: string): string {
  return path.resolve(tauriRoot, source)
}

function main(): void {
  const resources = resourceMap()
  const skillsSource = Object.entries(resources)
    .find(([, target]) => target === 'builtin-skills/')?.[0]
  if (!skillsSource) throw new Error('Tauri resources must map builtin-skills/.')
  const skillsRoot = resolveSource(skillsSource)
  const skills = filesIn(skillsRoot)
  for (const required of ['find-skills/SKILL.md', 'rule-creator/SKILL.md', 'skill-creator/SKILL.md']) {
    if (!skills.some((file) => file.path === required)) {
      throw new Error(`Required built-in skill is missing: ${required}`)
    }
  }

  const ripgrepSource = Object.entries(resources)
    .find(([, target]) => target === (process.platform === 'win32' ? 'tools/rg.exe' : 'tools/rg'))?.[0]
  if (!ripgrepSource) throw new Error(`No ripgrep resource mapping exists for ${process.platform}-${process.arch}.`)
  const ripgrepPath = resolveSource(ripgrepSource)
  const ripgrep = spawnSync(ripgrepPath, ['--version'], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true
  })
  if (ripgrep.error) throw ripgrep.error
  if (ripgrep.status !== 0) throw new Error(`Bundled ripgrep failed with exit code ${ripgrep.status}.`)

  const report = {
    platform: process.platform,
    architecture: process.arch,
    installedPaths: {
      builtinSkills: 'builtin-skills/',
      ripgrep: process.platform === 'win32' ? 'tools/rg.exe' : 'tools/rg'
    },
    builtinSkills: {
      files: skills.length,
      bytes: skills.reduce((sum, file) => sum + file.bytes, 0),
      entries: skills
    },
    ripgrep: {
      sourcePackage: '@vscode/ripgrep-win32-x64',
      bytes: fs.statSync(ripgrepPath).size,
      sha256: sha256(ripgrepPath),
      version: ripgrep.stdout.split(/\r?\n/, 1)[0]
    },
    compiledParsers: {
      treeSitter: '0.25.10',
      bash: '0.25.0',
      powershell: '0.25.10'
    }
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({
    platform: report.platform,
    architecture: report.architecture,
    builtinSkillFiles: report.builtinSkills.files,
    builtinSkillBytes: report.builtinSkills.bytes,
    ripgrepBytes: report.ripgrep.bytes,
    ripgrepVersion: report.ripgrep.version
  }, null, 2))
}

main()
