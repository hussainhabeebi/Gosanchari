/** Fail closed until the policy and GA4 account configuration have been reviewed. */
export const GA4_ID = 'G-J5JVRNNVKL'
export const GA4_READINESS = 'privacy-approved-enhanced-measurement-off'

export function analyticsPage(input: {
  readiness?: string; policy: string; origin: string; path: string
  area: string; authenticated: boolean; noindex?: boolean; embedded?: boolean; status: number
}): string | undefined {
  if (input.readiness !== GA4_READINESS || input.origin !== 'https://gosanchari.com' ||
      input.area !== 'public' || input.authenticated || input.noindex || input.embedded || input.status !== 200) return
  // This is a sanity check, not legal approval. The readiness flag attests to the manual review.
  if (!/Google Analytics|GA4/i.test(input.policy) || !/consent/i.test(input.policy) ||
      /policy is being updated/i.test(input.policy)) return
  const pages: Record<string, string> = {
    '/': 'Home', '/search': 'Find a stay', '/offers': 'Packages', '/about': 'About',
    '/contact': 'Contact', '/policies/privacy': 'Privacy policy',
    '/policies/terms': 'Terms', '/policies/cancellation': 'Cancellation policy',
  }
  // Use a fixed public page category, never a slug, customer token, title or search input.
  if (/^\/stay\/[a-z0-9-]+$/.test(input.path)) return '/stay/property'
  return Object.hasOwn(pages, input.path) ? input.path : undefined
}
