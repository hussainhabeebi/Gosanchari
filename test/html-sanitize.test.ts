import { describe, expect, it } from 'vitest'
import { htmlToText, safeUrl, sanitizeHtml } from '../src/lib/sanitize'

const s = (h: string) => sanitizeHtml(h, { siteUrl: 'https://gosanchari.com' })

describe('blog HTML sanitizer (stored XSS protection)', () => {
  it('keeps the editor formatting', () => {
    const html = '<h2>Munnar</h2><p>Tea <strong>hills</strong>, <em>mist</em> and <u>views</u>.</p><ul><li>One</li><li>Two</li></ul><ol><li>A</li></ol><blockquote>Quote</blockquote><h3>Sub</h3><p>Line<br>break</p><hr>'
    expect(s(html)).toBe(html)
    expect(s('<b>b</b><i>i</i><div>block</div><h1>Big</h1>')).toBe('<strong>b</strong><em>i</em><p>block</p><h2>Big</h2>')
  })

  it.each([
    ['<script>alert(1)</script><p>ok</p>', '<p>ok</p>'],
    ['<SCRIPT SRC=//x.example/x.js></SCRIPT>ok', 'ok'],
    ['<img src=x onerror=alert(1)>', ''],
    ['<img src="/media/blog/a.png" onerror="alert(1)" alt="A">', '<img src="/media/blog/a.png" alt="A">'],
    ['<p onclick="alert(1)" style="color:red" class="x">t</p>', '<p>t</p>'],
    ['<a href="javascript:alert(1)">x</a>', '<a>x</a>'],
    ['<a href="JaVaScRiPt:alert(1)">x</a>', '<a>x</a>'],
    ['<a href="jav&#x61;script:alert(1)">x</a>', '<a>x</a>'],
    ['<a href="java\tscript:alert(1)">x</a>', '<a>x</a>'],
    ['<a href="&#106;avascript&colon;alert(1)">x</a>', '<a>x</a>'],
    ['<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>', '<a>x</a>'],
    ['<a href="vbscript:msgbox(1)">x</a>', '<a>x</a>'],
    ['<a href="//evil.example/x">x</a>', '<a>x</a>'],
    ['<img src="data:image/svg+xml;base64,PHN2Zz4=">', ''],
    ['<img src="http://insecure.example/a.png">', ''],
    ['<iframe src="https://evil.example"></iframe>ok', 'ok'],
    ['<svg><script>alert(1)</script></svg>ok', 'ok'],
    ['<math><mi xlink:href="javascript:alert(1)">x</mi></math>ok', 'ok'],
    ['<style>body{display:none}</style>ok', 'ok'],
    ['<object data="x"></object><embed src="x">ok', 'ok'],
    ['<input onfocus=alert(1) autofocus><link rel=import href=x>ok', 'ok'],
    ['<form action="https://evil"><input name=a></form>ok', 'ok'],
    ['<!-- <script>alert(1)</script> -->ok', 'ok'],
    ['<scr<script>ipt>alert(1)</script>', 'ipt&gt;alert(1)'],
    ['<p title="a&quot; onmouseover=&quot;alert(1)">t</p>', '<p>t</p>'],
    ['<a title=\'" onmouseover="alert(1)\' href="/x">t</a>', '<a title="&quot; onmouseover=&quot;alert(1)" href="/x">t</a>'],
    ['<img src=/media/a.png alt="x" <script>', '<img src="/media/a.png" alt="x">'],
    ['&lt;script&gt;alert(1)&lt;/script&gt;', '&lt;script&gt;alert(1)&lt;/script&gt;'],
    ['<meta http-equiv="refresh" content="0;url=https://evil">ok', 'ok'],
    ['<base href="https://evil/">ok', 'ok'],
    ['<p>unclosed <strong>bold', '<p>unclosed <strong>bold</strong></p>'],
    ['</p></div></strong>stray', 'stray'],
    ['1 < 2 and 3 > 2', '1 &lt; 2 and 3 &gt; 2'],
  ])('neutralises %s', (input, expected) => {
    const out = s(input)
    expect(out).toBe(expected)
    expect(out).not.toMatch(/<(script|iframe|svg|style|object|embed|form|meta|base)\b|\son\w+=(?!&quot;)|["=]javascript:/i)
  })

  it('fixes block elements nested in paragraphs, as browsers produce them', () => {
    expect(s('<p>Intro</p><p><ul><li>Tea</li></ul></p><p>End</p>')).toBe('<p>Intro</p><ul><li>Tea</li></ul><p>End</p>')
    expect(s('<p>Text<h2>Head</h2>more</p>')).toBe('<p>Text</p><h2>Head</h2>more')
    expect(s('<p>a<hr>b</p>')).toBe('<p>a</p><hr>b')
    expect(s('<p></p><p><br></p><p>&nbsp;</p><p>x</p>')).toBe('<p>x</p>')
  })

  it('makes external links safe and leaves own links alone', () => {
    expect(s('<a href="https://example.com/x">e</a>')).toBe('<a href="https://example.com/x" rel="noopener noreferrer nofollow" target="_blank">e</a>')
    expect(s('<a href="https://gosanchari.com/stay/x">own</a>')).toBe('<a href="https://gosanchari.com/stay/x">own</a>')
    expect(s('<a href="/blog/x">rel</a><a href="mailto:a@b.c">m</a><a href="tel:+911">t</a>')).toBe('<a href="/blog/x">rel</a><a href="mailto:a@b.c">m</a><a href="tel:+911">t</a>')
    expect(s('<a href="/x"><a href="/y">nested</a></a>')).toBe('<a href="/x">nested</a>')
  })

  it('is stable when run again on its own output (sanitized again on display)', () => {
    for (const html of ['<p>A &amp; B &lt;tag&gt; “quotes”</p>', '<a href="https://example.com/?a=1&amp;b=2">x</a>', '<img src="/media/blog/a.png" alt="Tom &amp; Jerry">']) {
      expect(s(s(html))).toBe(s(html))
    }
  })

  it('validates URLs and extracts plain text', () => {
    expect(safeUrl('https://a.example/x', 'src')).toBe('https://a.example/x')
    expect(safeUrl('/media/blog/a.png', 'src')).toBe('/media/blog/a.png')
    expect(safeUrl('/admin/x', 'src')).toBeNull()
    expect(safeUrl('https:/\\evil', 'href')).toBeNull()
    expect(htmlToText('<h2>Title</h2><p>One &amp; two</p>')).toBe('Title One & two')
  })
})
