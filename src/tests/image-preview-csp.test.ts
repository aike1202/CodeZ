import { readFile } from 'fs/promises'
import path from 'path'
import { describe, expect, it } from 'vitest'

describe('image preview content security policy', () => {
  it('allows renderer-owned Blob URLs for attachment previews', async () => {
    const html = await readFile(path.resolve('src/renderer/tauri.html'), 'utf8')
    expect(html).toMatch(/img-src[^;]*\bblob:/)
  })
})
