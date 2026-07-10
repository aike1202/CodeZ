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

  it('splits cmd chains without splitting quoted metacharacters', () => {
    const graph = new CmdCommandParser().parse('echo "a&b" && del /q build\\*')
    expect(graph.operations.map((item) => item.executable.toLowerCase())).toEqual(['echo', 'del'])
    expect(graph.operators).toContain('&&')
  })
})
