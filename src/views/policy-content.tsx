import type { Child } from 'hono/jsx'

/** Small plain-text formatter: stored HTML is always escaped, never executed. */
function links(text: string): Child[] {
  const parts: Child[] = []
  const matches = /https?:\/\/[^\s<>"']+|[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+/gi
  let from = 0
  for (const match of text.matchAll(matches)) {
    parts.push(text.slice(from, match.index))
    let label = match[0]
    let suffix = ''
    if (/^https?:\/\//i.test(label)) {
      while (/[.,;:!?]$/.test(label) || (label.endsWith(')') && (label.match(/\)/g)?.length ?? 0) > (label.match(/\(/g)?.length ?? 0))) {
        suffix = label.slice(-1) + suffix
        label = label.slice(0, -1)
      }
      try {
        const url = new URL(label)
        if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw Error('Unsafe URL')
        parts.push(<a href={url.href} target="_blank" rel="noopener noreferrer">{label}</a>)
      } catch { parts.push(label) }
    } else {
      // Encode mailbox punctuation so text cannot inject mail headers/query parameters.
      parts.push(<a href={`mailto:${encodeURIComponent(label).replace('%40', '@')}`}>{label}</a>)
    }
    parts.push(suffix)
    from = match.index + match[0].length
  }
  parts.push(text.slice(from))
  return parts
}

export function PolicyContent({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Child[] = []
  const bullet = (line: string) => line.match(/^\s*[-*•]\s+(.+)$/)
  const ordered = (line: string) => line.match(/^\s*(\d+)[.)]\s+(.+)$/)
  function heading(index: number): { level: 2 | 3; text: string } | undefined {
    const line = lines[index].trim()
    const markdown = line.match(/^(#{1,3})\s+(.+)$/)
    if (markdown) return { level: markdown[1].length === 3 ? 3 : 2, text: markdown[2] }
    if (/^[A-Z][.)]\s+\S/.test(line) && line.length <= 120 && !/[.!?]$/.test(line)) return { level: 3, text: line }
    if (/^\d+[.)]\s+\S/.test(line) && line.length <= 120 && !/[.!?]$/.test(line)) {
      const title = line.replace(/^\d+[.)]\s+/, '')
      const uppercase = /[A-Z]/.test(title) && title === title.toUpperCase()
      const isolated = (index === 0 || !lines[index - 1].trim()) && (index === lines.length - 1 || !lines[index + 1].trim())
      if (uppercase || isolated) return { level: 2, text: line }
    }
  }
  for (let i = 0; i < lines.length;) {
    if (!lines[i].trim()) { i++; continue }
    const title = heading(i)
    if (title) {
      blocks.push(title.level === 2 ? <h2>{links(title.text)}</h2> : <h3>{links(title.text)}</h3>)
      i++; continue
    }
    const firstBullet = bullet(lines[i]), firstOrdered = ordered(lines[i])
    if (firstBullet || firstOrdered) {
      const items: Child[] = []
      const start = firstOrdered ? Number(firstOrdered[1]) : 1
      while (i < lines.length && !heading(i)) {
        const item = firstBullet ? bullet(lines[i]) : ordered(lines[i])
        if (!item) break
        items.push(<li {...(firstOrdered ? { value: Number(item[1]) } : {})}>{links(item[firstBullet ? 1 : 2])}</li>)
        i++
      }
      blocks.push(firstBullet ? <ul>{items}</ul> : <ol start={start}>{items}</ol>)
      continue
    }
    const paragraph: Child[] = []
    do {
      if (paragraph.length) paragraph.push(<br />)
      paragraph.push(...links(lines[i].trim()))
      i++
    } while (i < lines.length && lines[i].trim() && !heading(i) && !bullet(lines[i]) && !ordered(lines[i]))
    blocks.push(<p>{paragraph}</p>)
  }
  return <div class="policy-content">{blocks}</div>
}
