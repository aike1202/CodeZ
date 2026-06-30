import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { GitContextService } from '../main/services/GitContextService'

describe('GitContextService', () => {
  const repoRoot = path.resolve(__dirname, '..', '..')

  it('should return empty string for non-existent directory', () => {
    const result = GitContextService.getSnapshot('Z:\\nonexistent\\path')
    expect(result).toBe('')
  })

  it('should return git snapshot for the project repo', () => {
    const result = GitContextService.getSnapshot(repoRoot)
    // This test runs in the CodeZ repo, so it should return content
    expect(result).toBeTruthy()
    expect(result).toContain('Current branch:')
    expect(result).toContain('Git user:')
    expect(result).toContain('Recent commits:')
  })

  it('should contain porcelain status section', () => {
    const result = GitContextService.getSnapshot(repoRoot)
    expect(result).toContain('Status:')
  })
})
