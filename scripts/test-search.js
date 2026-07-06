// 百度：不带 site: 抽取 + 真实 URL 还原（分离变量）
// 用法：node scripts/test-search.js

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-CN,zh;q=0.9' }
  })
  return await res.text()
}

async function resolveBaiduLink(link) {
  try {
    const res = await fetch(link, { method: 'HEAD', redirect: 'manual', headers: { 'User-Agent': UA } })
    const loc = res.headers.get('location')
    if (loc) return loc
    const res2 = await fetch(link, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': UA } })
    return res2.url
  } catch (e) {
    return `[解析失败: ${e.cause?.code || e.message}]`
  }
}

;(async () => {
  // 普通查询，不带 site:
  const q = encodeURIComponent('jetpack compose 状态管理')
  console.log('=== 百度：普通查询抽取 + URL 还原 ===')
  const html = await fetchHtml(`https://www.baidu.com/s?wd=${q}`)
  const re = /<h3[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const items = []
  let m
  while ((m = re.exec(html)) !== null && items.length < 6) {
    const title = m[2].replace(/<[^>]+>/g, '').trim()
    items.push({ title, link: m[1] })
  }
  console.log(`抽到 ${items.length} 条原始结果`)
  for (let i = 0; i < items.length; i++) {
    const real = items[i].link.includes('baidu.com/link')
      ? await resolveBaiduLink(items[i].link)
      : items[i].link
    let host = ''
    try { host = new URL(real).hostname } catch {}
    console.log(`  ${i + 1}. [${host}] ${items[i].title.slice(0, 36)}`)
    console.log(`      -> ${real.slice(0, 90)}`)
  }
})()
