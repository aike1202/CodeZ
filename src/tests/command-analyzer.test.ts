import { describe, expect, it } from 'vitest'
import { CommandAnalyzer } from '../main/services/CommandAnalyzer'

describe('CommandAnalyzer detailed analysis', () => {
  it('classifies common read-only commands across shells', () => {
    const commands = [
      'Get-ChildItem -Force',
      'Get-Content package.json -Raw',
      'Select-String -Path src/*.ts -Pattern TODO',
      'Test-Path package.json',
      'Get-Item package.json',
      'Get-Process node',
      'Get-Service',
      '$PSVersionTable.PSVersion',
      '$PWD.Path',
      '$env:PATH',
      '[byte[]]$bytes = @(0x00,0x01)',
      '[System.IO.File]::ReadAllBytes("src-tauri/icons/icon.ico")',
      '(Get-Command node).Source',
      'Resolve-Path .',
      'Join-Path src main',
      'Split-Path src/main/index.ts',
      'Get-ChildItem -Recurse',
      'Get-ChildItem -Recurse -File',
      'git status --short',
      'git diff -- src/main.ts',
      'git branch --show-current',
      'git branch',
      'git branch -a',
      'git config --get user.name',
      'git remote get-url origin',
      'git rev-parse --show-toplevel',
      'git ls-files src',
      'git blame src/main/index.ts',
      'npm view react version',
      'rg "TODO|FIXME" src',
      'Select-String -Path src/*.ts -Pattern "error|warn"',
      'python --version',
      'where node',
      'whoami',
      'hostname',
      'date',
      'Get-Date',
      'Get-Location; git status --short',
      'Get-ChildItem -Force | Select-Object Name,Mode,Length,LastWriteTime | Format-Table -AutoSize',
      'Get-Content package.json | ConvertFrom-Json',
      'Get-Process node | Select-Object Id,ProcessName | ConvertTo-Json',
      'Get-ChildItem src | Where-Object { $_.Name -like "*.ts" }',
      'if (Test-Path package.json) { Get-Content package.json -Raw }',
      "if (Test-Path .git) { 'has .git' } else { 'no .git' }; if (Test-Path package.json) { Get-Content package.json -Raw } else { 'no package.json' }"
    ]

    for (const command of commands) {
      expect(CommandAnalyzer.analyzeDetailed(command).risk, command).toBe('safe')
    }
  })

  it('classifies common write commands without treating them as destructive', () => {
    const commands = [
      'Set-Content -Encoding UTF8 file.txt value',
      'Add-Content log.txt line',
      'Out-File out.txt',
      'New-Item -ItemType Directory tmp',
      'New-Item -ItemType Directory -Force -Path docs/superpowers/specs | Out-Null',
      '$null = New-Item -ItemType Directory -Force -Path docs/superpowers/plans',
      '[System.IO.File]::WriteAllBytes("src-tauri/icons/icon.ico", $bytes)',
      '[System.IO.File]::WriteAllText("out.txt", "hello")',
      '[System.IO.File]::AppendAllText("out.txt", "hello")',
      '[System.IO.Directory]::CreateDirectory("src-tauri/icons")',
      `New-Item -ItemType Directory -Force src-tauri/icons | Out-Null
[byte[]]$bytes = @(
  0x00,0x00,0x01,0x00,
  0x7C,0x3A,0x10,0xFF
)
[System.IO.File]::WriteAllBytes('src-tauri/icons/icon.ico', $bytes)`,
      'if (-not (Test-Path docs)) { New-Item -ItemType Directory docs }',
      'Copy-Item a b',
      'Move-Item a b',
      'git add src',
      'git commit -m test',
      'git branch feature/foo',
      'git checkout -b feature/foo',
      'npm run build',
      'python script.py'
    ]

    for (const command of commands) {
      expect(CommandAnalyzer.analyzeDetailed(command).risk, command).toBe('write')
    }
  })

  it('classifies package managers and external access as network', () => {
    const commands = [
      'npm ci',
      'yarn install',
      'pnpm install',
      'pip install rapidocr',
      'python -m pip install rapidocr',
      'Invoke-RestMethod https://example.com',
      'git pull --rebase',
      'gh pr create',
      'docker pull alpine'
    ]

    for (const command of commands) {
      expect(CommandAnalyzer.analyzeDetailed(command).risk, command).toBe('network')
    }
  })

  it('classifies destructive filesystem, git, process, and system commands', () => {
    const commands = [
      'Remove-Item -Recurse -Force dist',
      'Remove-Item file.txt',
      'rm -rf dist',
      'del file.txt',
      'git reset --hard HEAD',
      'git clean -fd',
      'git push --force-with-lease',
      'Stop-Process -Id 1234',
      'taskkill /PID 1234 /F',
      'docker rm container',
      'kubectl delete pod x',
      '[System.IO.File]::Delete("out.txt")',
      '[System.IO.Directory]::Delete("dist", $true)',
      'chmod -R 777 .'
    ]

    for (const command of commands) {
      expect(CommandAnalyzer.analyzeDetailed(command).risk, command).toBe('destructive')
    }
  })

  it('generates broad rules only from analyzed non-destructive command categories', () => {
    expect(CommandAnalyzer.analyzeDetailed('git status').ruleOptions).toEqual([
      { id: 'exact', label: '仅此完整命令', rule: 'git status', description: '只允许当前这条完整命令。' },
      { id: 'git-read', label: 'Git 只读命令', rule: 'git status *', description: '仅允许同类 Git 查询命令，不能覆盖写入或强制操作。' }
    ])

    expect(CommandAnalyzer.analyzeDetailed('npm install lodash').ruleOptions).toEqual([
      { id: 'exact', label: '仅此完整命令', rule: 'npm install lodash', description: '只允许当前这条完整命令。' },
      { id: 'package-manager', label: '同类安装命令', rule: 'npm install *', description: '允许同类依赖安装命令，但不会覆盖命令链或删除操作。' }
    ])

    expect(CommandAnalyzer.analyzeDetailed('rm -rf dist').ruleOptions).toEqual([
      { id: 'exact', label: '仅此完整命令', rule: 'rm -rf dist', description: '只允许当前这条完整命令。' }
    ])
  })

  it('treats command chaining and redirection as destructive', () => {
    expect(CommandAnalyzer.analyzeDetailed('git status | Remove-Item a.txt').risk).toBe('destructive')
    expect(CommandAnalyzer.analyzeDetailed("if (Test-Path .git) { Remove-Item .git -Recurse } else { 'no .git' }").risk).toBe('destructive')
    expect(CommandAnalyzer.analyzeDetailed('Get-ChildItem > out.txt').risk).toBe('destructive')
    expect(CommandAnalyzer.analyzeDetailed('$env:FOO="bar"; Get-ChildItem').risk).toBe('destructive')
    expect(CommandAnalyzer.analyzeDetailed('Write-Output $(Remove-Item a.txt)').risk).toBe('destructive')
  })
})
