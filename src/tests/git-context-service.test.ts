import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { GitContextService } from '../main/services/GitContextService'

describe('GitContextService', () => {
  const repoRoot = path.resolve(__dirname, '..', '..')

  it('should return empty string for non-existent directory', async () => {
    const result = await GitContextService.getSnapshot('Z:\\nonexistent\\path')
    expect(result).toBe('')
  })

  it('should return git snapshot for the project repo', async () => {
    const result = await GitContextService.getSnapshot(repoRoot)
    // This test runs in the CodeZ repo, so it should return content
    expect(result).toBeTruthy()
    expect(result).toContain('Branch:')
    expect(result).toContain('Working tree:')
  })

  it('should summarize the working tree without recent commit history', async () => {
    const result = await GitContextService.getSnapshot(repoRoot)
    expect(result).not.toContain('Recent commits:')
  })
})
