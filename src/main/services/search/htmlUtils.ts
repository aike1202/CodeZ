// src/main/services/search/htmlUtils.ts
// 轻量 HTML 处理工具：解码实体、剥离标签、按标签块切分。
// 不引入 cheerio/jsdom，用正则处理搜索结果页（结构相对稳定）。

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#34': '"',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  mdash: '—',
  ndash: '–'
}

/** 解码 HTML 实体（命名 + 数字）。 */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X'
      const code = parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10)
      if (Number.isFinite(code)) return String.fromCodePoint(code)
      return match
    }
    const named = NAMED_ENTITIES[entity] ?? NAMED_ENTITIES[entity.toLowerCase()]
    return named ?? match
  })
}

/** 剥离所有 HTML 标签并解码实体，折叠多余空白。 */
export function stripTags(html: string): string {
  const noTags = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
  return decodeEntities(noTags).replace(/\s+/g, ' ').trim()
}

/** 提取某个属性值，如 href="..."。返回第一个匹配。 */
export function extractAttr(tag: string, attr: string): string | null {
  const re = new RegExp(`${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  const m = tag.match(re)
  if (!m) return null
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? '')
}
