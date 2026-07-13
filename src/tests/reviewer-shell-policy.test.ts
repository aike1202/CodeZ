import { describe, expect, it } from 'vitest'
import { checkReviewerShellCommand } from '../main/agent/ReviewerShellPolicy'

describe('Reviewer verification shell policy', () => {
  it('allows read-only inspection and verification commands', async () => {
    await expect(checkReviewerShellCommand('Bash', { command: 'git diff -- src/main.ts' }))
      .resolves.toBeNull()
    await expect(checkReviewerShellCommand('Bash', { command: 'npm test -- --run src/main.test.ts' }))
      .resolves.toBeNull()
    await expect(checkReviewerShellCommand('PowerShell', { command: 'npm.cmd run typecheck' }))
      .resolves.toBeNull()
    await expect(checkReviewerShellCommand('PowerShell', { command: 'Get-Content -Encoding UTF8 src/main.ts' }))
      .resolves.toBeNull()
    await expect(checkReviewerShellCommand('PowerShell', {
      command: [
        '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)',
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
        '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
        'chcp 65001 > $null',
        'npm.cmd test -- --run src/main.test.ts',
      ].join('; '),
    })).resolves.toBeNull()
  })

  it('denies direct file mutation, write redirection, and Git writes', async () => {
    await expect(checkReviewerShellCommand('Bash', { command: 'rm src/main.ts' }))
      .resolves.toContain('modify project files')
    await expect(checkReviewerShellCommand('Bash', { command: 'echo changed > src/main.ts' }))
      .resolves.toContain('redirection')
    await expect(checkReviewerShellCommand('PowerShell', { command: "Set-Content -Path src/main.ts -Value 'changed'" }))
      .resolves.toContain('modify project files')
    await expect(checkReviewerShellCommand('PowerShell', { command: 'git checkout -- src/main.ts' }))
      .resolves.toContain('not read-only')
    await expect(checkReviewerShellCommand('Bash', { command: 'git diff --output=review.patch' }))
      .resolves.toContain('output or external-command')
  })

  it('denies mutating formatter flags, package changes, and dynamic execution', async () => {
    await expect(checkReviewerShellCommand('Bash', { command: 'npm run lint -- --fix' }))
      .resolves.toContain('mutating')
    await expect(checkReviewerShellCommand('Bash', { command: 'npm run lint -- --fix=true' }))
      .resolves.toContain('mutating')
    await expect(checkReviewerShellCommand('Bash', { command: 'npm run lint:fix' }))
      .resolves.toContain('mutating workflow')
    await expect(checkReviewerShellCommand('Bash', { command: 'npm test -- -u' }))
      .resolves.toContain('may not update test snapshots')
    await expect(checkReviewerShellCommand('Bash', { command: 'npm test -- --updateSnapshot=true' }))
      .resolves.toContain('may not update test snapshots')
    await expect(checkReviewerShellCommand('Bash', { command: 'npm test -- --update' }))
      .resolves.toContain('may not update test snapshots')
    await expect(checkReviewerShellCommand('Bash', { command: 'vitest --update' }))
      .resolves.toContain('mutating')
    await expect(checkReviewerShellCommand('Bash', { command: 'eslint --output-file src/victim.ts .' }))
      .resolves.toContain('file-output')
    await expect(checkReviewerShellCommand('Bash', { command: 'vitest --reporter=json --outputFile=src/victim.ts' }))
      .resolves.toContain('file-output')
    await expect(checkReviewerShellCommand('Bash', { command: 'tsc --outFile src/victim.ts' }))
      .resolves.toContain('file-output')
    await expect(checkReviewerShellCommand('Bash', { command: 'npm test -- --outputFile=src/victim.ts' }))
      .resolves.toContain('file-output')
    await expect(checkReviewerShellCommand('Bash', { command: 'playwright test --update-snapshots=all' }))
      .resolves.toContain('mutating')
    await expect(checkReviewerShellCommand('Bash', { command: 'npm install left-pad' }))
      .resolves.toContain('not an approved')
    await expect(checkReviewerShellCommand('Bash', { command: "node -e 'require(\"fs\").writeFileSync(\"x\", \"y\")'" }))
      .resolves.toContain('inline evaluation')
    await expect(checkReviewerShellCommand('Bash', { command: 'node mutate.js' }))
      .resolves.toContain('not in the Reviewer verification allowlist')
    await expect(checkReviewerShellCommand('Bash', { command: 'python mutate.py' }))
      .resolves.toContain('not in the Reviewer verification allowlist')
    await expect(checkReviewerShellCommand('PowerShell', { command: '& $command' }))
      .resolves.toContain('dynamic')
    await expect(checkReviewerShellCommand('Bash', { command: 'wget https://example.com/review.patch' }))
      .resolves.toContain('only with --spider')
    await expect(checkReviewerShellCommand('Bash', { command: 'wget -Oreview.patch https://example.com' }))
      .resolves.toContain('file output flags')
    await expect(checkReviewerShellCommand('Bash', { command: 'wget --output-document review.patch https://example.com' }))
      .resolves.toContain('file output flags')
    await expect(checkReviewerShellCommand('Bash', { command: 'curl -oreview.patch https://example.com' }))
      .resolves.toContain('file output')
    await expect(checkReviewerShellCommand('Bash', { command: 'curl -Dheaders.txt https://example.com' }))
      .resolves.toContain('file output')
    await expect(checkReviewerShellCommand('Bash', { command: 'curl -sSLo review.patch https://example.com' }))
      .resolves.toContain('file output')
    await expect(checkReviewerShellCommand('Bash', { command: 'curl --remote-name-all https://example.com/review.patch' }))
      .resolves.toContain('file output')
    await expect(checkReviewerShellCommand('PowerShell', {
      command: 'Invoke-WebRequest https://example.com/review.patch -OutF review.patch',
    })).resolves.toContain('-OutFile is not allowed')
    await expect(checkReviewerShellCommand('PowerShell', {
      command: "Write-Output ([System.IO.File]::WriteAllText('src/victim.ts','changed'))",
    })).resolves.toContain('not allowed in review verification')
    await expect(checkReviewerShellCommand('PowerShell', {
      command: "Select-Object @{Name='x';Expression={[System.IO.File]::WriteAllText('src/victim.ts','changed')}}",
    })).resolves.toContain('not allowed in review verification')
    await expect(checkReviewerShellCommand('Bash', { command: 'wget -qO- https://example.com' }))
      .resolves.toBeNull()
  })
})
