import type { Settings } from './settings'

/** Only numeric IDs are interpolated; conversion payloads contain no guest details. */
export function metaPixelScript(config: Settings['meta_pixel'], conversion?: 'Lead' | 'BookNow'): string {
  if (!config.enabled || !/^\d{5,25}$/.test(config.pixel_id)) return ''
  const event = conversion === 'Lead' && config.lead ? "fbq('track','Lead');" : conversion === 'BookNow' && config.book_now ? "fbq('trackCustom','BookNow');" : ''
  return `!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=true;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=true;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${config.pixel_id}');fbq('set','autoConfig',false,'${config.pixel_id}');fbq('track','PageView');${event}`
}
