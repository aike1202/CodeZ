// src/main/tools/builtin/NotebookUtils.ts
export interface NbCell {
  cell_type: string
  source: string | string[]
  outputs?: any[]
  metadata?: Record<string, any>
  id?: string
  execution_count?: any
}

export interface NbFormat {
  cells: NbCell[]
  metadata: Record<string, any>
  nbformat: number
  nbformat_minor: number
}

export function parseNotebook(text: string): NbFormat {
  const nb = JSON.parse(text)
  if (!Array.isArray(nb.cells)) throw new Error('Invalid notebook: missing cells array.')
  return nb as NbFormat
}

export function writeNotebook(nb: NbFormat): string {
  return JSON.stringify(nb, null, 1)
}

export function cellIdOf(cell: NbCell, index: number): string {
  return cell.id || `cell-${index}`
}

export function sourceToString(src: string | string[]): string {
  return Array.isArray(src) ? src.join('') : src
}

export function stringToSource(s: string): string[] {
  if (s === '') return []
  const lines = s.split('\n')
  return lines.map((l, i) => (i < lines.length - 1 ? l + '\n' : l))
}

export function renderNotebook(nb: NbFormat): string {
  const blocks: string[] = []
  nb.cells.forEach((cell, i) => {
    const id = cellIdOf(cell, i)
    const type = cell.cell_type || 'code'
    const lines: string[] = [`<cell id="${id}" type="${type}">`]
    lines.push(sourceToString(cell.source))
    if (type === 'code' && Array.isArray(cell.outputs) && cell.outputs.length > 0) {
      lines.push('<outputs>')
      lines.push(JSON.stringify(cell.outputs, null, 1))
      lines.push('</outputs>')
    }
    lines.push('</cell>')
    blocks.push(lines.join('\n'))
  })
  return blocks.join('\n\n')
}
