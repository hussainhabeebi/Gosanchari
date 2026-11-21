import type { Child } from 'hono/jsx'
import { DEFAULT_ABOUT } from '../lib/settings'

/** Only plain text and single-asterisk emphasis; stored HTML is never executed. */
function emphasis(text: string): Child[] {
  return text.split(/(\*[^*\n]+\*)/g).map(part => part.startsWith('*') && part.endsWith('*') && part.length > 2
    ? <strong>{part.slice(1, -1)}</strong> : part)
}

export function AboutContent({ text }: { text: string }) {
  const paragraphs = text.replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/).filter(Boolean)
  const approved = text.trim() === DEFAULT_ABOUT
  return <div class="about-copy">
    {paragraphs.map((paragraph, index) => approved && index === 0
      ? <h2 class="about-tagline">{emphasis(paragraph)}</h2>
      : <p class={approved && index === paragraphs.length - 2 ? 'about-motto' : approved && index === paragraphs.length - 1 ? 'about-signoff' : undefined}>{paragraph.split('\n').map((line, i) => <>{i > 0 && <br />}{emphasis(line)}</>)}</p>)}
  </div>
}
