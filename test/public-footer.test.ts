import { expect, it } from 'vitest'
import { Layout } from '../src/views/layout'
import { DEFAULT_SETTINGS } from '../src/lib/settings'

it('shows the named footer contact while preserving configured business details', () => {
  const settings = { ...DEFAULT_SETTINGS, business: { ...DEFAULT_SETTINGS.business, phone: '+91 12345 67890', email: 'contact@example.com', address: 'Configured business address' } }
  const html = Layout({ title: 'Home', settings, user: null, perms: null, flash: {}, turnstileSiteKey: '', siteUrl: 'https://gosanchari.com' })!.toString()
  const footer = html.slice(html.indexOf('<footer'), html.indexOf('</footer>'))
  expect(footer).toContain('<h4>Contact</h4><p><strong>Manish C Vijayan</strong><br/>')
  expect(footer).toContain(settings.business.phone)
  expect(footer).toContain('href="mailto:contact@example.com"')
  expect(footer).toContain(settings.business.address)
  expect(footer).toContain(settings.business.name)
})
