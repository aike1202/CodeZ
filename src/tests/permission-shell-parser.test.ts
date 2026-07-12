import { describe, expect, it } from 'vitest'
import { ShellAnalysisService } from '../main/services/permission/ShellAnalysisService'
import { CmdCommandParser } from '../main/services/permission/CmdCommandParser'

describe('permission shell parsers', () => {
  it('finds every Bash command in a compound expression', async () => {
    const graph = await new ShellAnalysisService().parse('bash', 'git status && npm test | tee result.txt')
    expect(graph.operations.map((item) => item.executable)).toEqual(['git', 'npm', 'tee'])
    expect(graph.operators).toEqual(expect.arrayContaining(['&&', '|']))
  })

  it('finds PowerShell commands inside script blocks', async () => {
    const graph = await new ShellAnalysisService().parse(
      'powershell',
      'if (Test-Path a) { Get-Content a } else { Remove-Item a -Recurse }'
    )
    expect(graph.operations.map((item) => item.executable.toLowerCase())).toEqual(
      expect.arrayContaining(['test-path', 'get-content', 'remove-item'])
    )
  })

  it('parses native PowerShell commands with an option terminator and slash paths', async () => {
    const command = 'git status --short -- src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/error.rs src-tauri/src/database src-tauri/src/todo src-tauri/tests/database.rs src-tauri/src/lib.rs'
    const graph = await new ShellAnalysisService().parse('powershell', command)

    expect(graph.diagnostics).toEqual([])
    expect(graph.operations).toHaveLength(1)
    expect(graph.operations[0]).toMatchObject({
      executable: 'git',
      argv: ['git', 'status', '--short', '--', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/src/error.rs', 'src-tauri/src/database', 'src-tauri/src/todo', 'src-tauri/tests/database.rs', 'src-tauri/src/lib.rs']
    })
  })

  it('does not hide genuinely incomplete PowerShell syntax', async () => {
    const graph = await new ShellAnalysisService().parse('powershell', 'git status -- "src-tauri/Cargo.toml')

    expect(graph.diagnostics).not.toEqual([])
  })

  it.each([
    'cargo fmt --manifest-path src-tauri/Cargo.toml -- --check; if (-not $?) { exit 1 }; cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings; if (-not $?) { exit 1 }; cargo test --manifest-path src-tauri/Cargo.toml',
    'cargo fmt --manifest-path src-tauri/Cargo.toml; if (-not $?) { exit 1 }; cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings; if (-not $?) { exit 1 }; cargo test --manifest-path src-tauri/Cargo.toml'
  ])('parses native Cargo arguments around PowerShell failure guards', async (command) => {
    const graph = await new ShellAnalysisService().parse('powershell', command)

    expect(graph.diagnostics).toEqual([])
    expect(graph.operations.map((operation) => operation.executable)).toEqual(['cargo', 'cargo', 'cargo'])
    expect(graph.operations.some((operation) => operation.argv.includes('--'))).toBe(true)
  })

  it('marks dynamic shell-wrapper bodies as dynamic after native fallback', async () => {
    const graph = await new ShellAnalysisService().parse(
      'powershell',
      'cmd /c "$env:ComSpec /c del C:/tmp/x & rem" -- src/a/b'
    )

    expect(graph.diagnostics).toEqual([])
    expect(graph.operations.some((operation) => operation.dynamic)).toBe(true)
  })

  it('parses compact relative path lists in Get-ChildItem arguments', async () => {
    const command = "Select-String -Path (Get-ChildItem -Path docs,.codez -Recurse -Include '*.md','*.json' -File -ErrorAction SilentlyContinue).FullName -Pattern 'runtime status changed|RuntimeStatusChanged|CHAT_RUNTIME_STATUS_CHANGED|version.*runtime|runtime.*version' -Encoding UTF8 -Context 2,4"
    const graph = await new ShellAnalysisService().parse('powershell', command)

    expect(graph.diagnostics).toEqual([])
    expect(graph.operations.map((operation) => operation.executable.toLowerCase())).toEqual([
      'select-string',
      'get-childitem'
    ])
    expect(graph.operations[1].source).toContain('docs,.codez')
  })

  it.each([
    'New-Item -ItemType Directory -Force src/types, src/lib, src/components',
    'New-Item -ItemType Directory -Force docs, docs\\superpowers, docs\\superpowers\\plans | Out-Null',
    'New-Item -ItemType Directory -Force -Path src/main,src/preload,src/renderer | Out-Null',
    'New-Item -ItemType Directory -Force -Path src/main,src/renderer/types | Out-Null',
    'Get-ChildItem -Force | Format-Table -AutoSize Name,Mode,Length,LastWriteTime',
    'Get-ChildItem -Force | Select-Object Name,Mode,Length,LastWriteTime | Format-Table -AutoSize'
  ])('parses PowerShell cmdlet argument lists from conversation history', async (command) => {
    const graph = await new ShellAnalysisService().parse('powershell', command)

    expect(graph.diagnostics).toEqual([])
  })

  it.each([
    'Get-TimeZone | Format-List Id,DisplayName,BaseUtcOffset,SupportsDaylightSavingTime',
    'Get-Process WeChat*,Weixin* -ErrorAction SilentlyContinue | Select-Object ProcessName,Id,Path,StartTime | Format-List',
    'Stop-Process -Name Weixin,WeChatAppEx -Force -ErrorAction SilentlyContinue',
    'Get-Command handle.exe,handle64.exe,openfiles.exe -ErrorAction SilentlyContinue | Select-Object Name,Source'
  ])('parses standard cmdlet argument arrays from external tool history', async (command) => {
    const graph = await new ShellAnalysisService().parse('powershell', command)

    expect(graph.diagnostics).toEqual([])
  })

  it.each([
    'git status --short --untracked-files=all',
    "git diff --no-ext-diff --unified=40 -- 'src/shared/types/provider.ts'",
    'npm.cmd test -- --testTimeout=20000',
    "rg -n --glob '*.ts' 'ReadTool' src/main",
    'npx.cmd vitest run --testTimeout=30000'
  ])('parses native long options emitted by external coding tools', async (command) => {
    const graph = await new ShellAnalysisService().parse('powershell', command)

    expect(graph.diagnostics).toEqual([])
  })

  it.each([
    'git diff -U8 -- src/main/index.ts',
    'git apply --cached --whitespace=nowarn -',
    '& "F:\\miniconda\\python.exe" script.py --mode full --apply',
    'npm.cmd run build -w @ai-grader/workstation-ui'
  ])('parses static native invocation forms emitted by Codex', async (command) => {
    const graph = await new ShellAnalysisService().parse('powershell', command)

    expect(graph.diagnostics).toEqual([])
    expect(graph.operations.every((operation) => operation.executable !== '&')).toBe(true)
  })

  it('marks dynamic PowerShell invocation operators as dynamic', async () => {
    const graph = await new ShellAnalysisService().parse('powershell', '& $command --mode full')

    expect(graph.diagnostics).toEqual([])
    expect(graph.operations.some((operation) => operation.dynamic)).toBe(true)
  })

  it.runIf(process.platform === 'win32')('uses the native PowerShell AST for valid complex scripts', async () => {
    const command = "$data = Get-Content -Raw sessions.json | ConvertFrom-Json; $data.sessions | Sort-Object { [double]($_.id -replace '_.*$','') } -Descending | Select-Object -First 10 id,summary,@{n='messages';e={$_.messages.Count}},runtime | Format-List"
    const graph = await new ShellAnalysisService().parse('powershell', command)

    expect(graph.diagnostics).toEqual([])
    expect(graph.operations.map((operation) => operation.executable.toLowerCase())).toEqual(
      expect.arrayContaining(['get-content', 'convertfrom-json', 'sort-object', 'select-object', 'format-list'])
    )
  })

  it('parses Windows executable paths after Bash environment assignments', async () => {
    const graph = await new ShellAnalysisService().parse(
      'bash',
      'PYTHONPATH=. F:/miniconda/python.exe -m pytest tests/test_onvif_schemas.py -v'
    )

    expect(graph.diagnostics).toEqual([])
    expect(graph.operations[0]).toMatchObject({
      executable: 'F:/miniconda/python.exe',
      argv: ['F:/miniconda/python.exe', '-m', 'pytest', 'tests/test_onvif_schemas.py', '-v']
    })
  })

  it.each([
    ['powershell', '.\\mvnw.cmd -pl :app -am verify -DskipTests=false --batch-mode'],
    ['powershell', '.\\gradlew.bat clean test --no-daemon --stacktrace -Penv=ci -Dorg.gradle.jvmargs=-Xmx2g -x integrationTest'],
    ['powershell', 'msbuild.exe app.sln /t:Build /p:Configuration=Release /m'],
    ['powershell', 'bazelisk.exe test //... --keep_going --test_output=errors'],
    ['bash', './mvnw -pl :app -am verify -DskipTests=false --batch-mode'],
    ['bash', './gradlew clean test --no-daemon --stacktrace -Penv=ci -x integrationTest'],
    ['bash', 'composer install --no-interaction --prefer-dist'],
    ['bash', 'terraform plan -out=tfplan']
  ] as const)('parses build-tool wrapper arguments across shells: %s', async (shell, command) => {
    const graph = await new ShellAnalysisService().parse(shell, command)

    expect(graph.diagnostics).toEqual([])
    expect(graph.operations[0].argv.length).toBeGreaterThan(1)
  })

  it('does not hide a trailing PowerShell argument-list comma', async () => {
    const graph = await new ShellAnalysisService().parse('powershell', 'New-Item -Path src/main,')

    expect(graph.diagnostics).not.toEqual([])
  })

  it('splits cmd chains without splitting quoted metacharacters', () => {
    const graph = new CmdCommandParser().parse('echo "a&b" && del /q build\\*')
    expect(graph.operations.map((item) => item.executable.toLowerCase())).toEqual(['echo', 'del'])
    expect(graph.operators).toContain('&&')
  })

  it('splits commands on batch-file line boundaries', () => {
    const graph = new CmdCommandParser().parse('@echo off\r\necho preparing\r\ndel /s /q C:\\Users\\*')

    expect(graph.operations.map((operation) => operation.executable.toLowerCase())).toEqual([
      '@echo',
      'echo',
      'del'
    ])
  })

  it.each(['de^\r\nl /s /q C:\\Users\\*', 'de^\nl /s /q C:\\Users\\*'])(
    'collapses cmd caret line continuations before parsing: %j',
    (command) => {
      const graph = new CmdCommandParser().parse(command)

      expect(graph.operations).toHaveLength(1)
      expect(graph.operations[0]).toMatchObject({ executable: 'del' })
    }
  )

  it('keeps a cmd line boundary after an even caret run', () => {
    const graph = new CmdCommandParser().parse('de^^\r\nl /s /q C:\\Users\\*')

    expect(graph.operations).toHaveLength(2)
    expect(graph.operations.map((operation) => operation.executable)).not.toContain('del')
  })
})
