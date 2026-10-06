// "Moods of a solo traveller": every public page opens with a hero scene of the same traveller in a different
// moment of the trip — resting at sunset, reading the map in the tea-hill mist, paddling the backwaters, by a
// campfire under the stars, walking through monsoon rain, strolling a beach at dusk.
// Scenes are drawn as SVG (no image downloads). An admin can upload a photo for any mood in Website content; the
// photo then replaces the drawing.

import type { FC } from 'hono/jsx'
import { raw } from 'hono/html'

export type Mood = 'sunset' | 'mist' | 'backwater' | 'stars' | 'monsoon' | 'beach'

export const MOODS: Record<Mood, { label: string; text: 'dark' | 'light' }> = {
  sunset: { label: 'Sunset rest on the hills (home)', text: 'dark' },
  mist: { label: 'Misty morning with the map (stays, login)', text: 'dark' },
  backwater: { label: 'Paddling the backwaters (offers, enquiry)', text: 'dark' },
  stars: { label: 'Campfire under the stars (about, 404)', text: 'light' },
  monsoon: { label: 'Walking in the monsoon rain (contact, help)', text: 'light' },
  beach: { label: 'Beach walk at dusk (my trips, policies)', text: 'dark' },
}

// Deterministic "random" so every render draws the same hills.
function rng(seed: number) {
  let s = seed
  return () => ((s = (s * 9301 + 49297) % 233280) / 233280)
}

/** A smooth ridge line across the 1600-wide scene, closed to the bottom. */
function ridge(base: number, amp: number, seed: number, peaks = 6) {
  const r = rng(seed)
  const pts: [number, number][] = []
  for (let i = 0; i <= peaks * 2; i++) {
    const x = (1600 / (peaks * 2)) * i
    const up = i % 2 === 1
    pts.push([x + (r() - 0.5) * (1600 / peaks / 2.2), base - (up ? amp * (0.35 + r() * 0.85) : amp * r() * 0.35)])
  }
  let d = `M -20 ${pts[0][1]}`
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]
    const [x1, y1] = pts[i]
    const mx = (x0 + x1) / 2
    d += ` C ${mx} ${y0}, ${mx} ${y1}, ${x1} ${y1}`
  }
  return d + ' L 1620 620 L -20 620 Z'
}

const palm = (x: number, y: number, h: number, lean: number, fill: string) => {
  const tx = x + lean
  const ty = y - h
  const fronds = [-150, -115, -80, -45, -15, 20].map((a) => {
    const rad = (a * Math.PI) / 180
    const ex = tx + Math.cos(rad) * h * 0.42
    const ey = ty + Math.sin(rad) * h * 0.28 + h * 0.1
    return `<path d="M${tx} ${ty} Q ${(tx + ex) / 2} ${ty - h * 0.12}, ${ex} ${ey}" stroke="${fill}" stroke-width="${h * 0.035}" fill="none" stroke-linecap="round"/>`
  })
  return `<path d="M${x} ${y} Q ${x + lean * 0.3} ${y - h * 0.5}, ${tx} ${ty}" stroke="${fill}" stroke-width="${h * 0.045}" fill="none" stroke-linecap="round"/>${fronds.join('')}`
}

// ---- The traveller (same person: cap, backpack) in different poses. Drawn around (0,0) = feet / seat. ----
const T = '#2b1d16'
const traveller: Record<Mood, string> = {
  // Sitting on the slope, one hand on his head — tired after the climb.
  sunset: `
    <g fill="${T}">
      <ellipse cx="-58" cy="-30" rx="30" ry="40"/>
      <rect x="-80" y="-66" width="44" height="14" rx="6"/>
      <path d="M-30 -10 C -34 -60, -28 -96, -6 -104 C 14 -110, 26 -92, 22 -62 L 18 -12 Z"/>
      <circle cx="6" cy="-122" r="17"/>
      <path d="M-12 -132 Q 6 -150 24 -132 L 30 -128 L -14 -128 Z"/>
      <path d="M14 -96 C 34 -104, 38 -124, 22 -134" stroke="${T}" stroke-width="11" fill="none" stroke-linecap="round"/>
      <path d="M-4 -12 L 52 -40 L 70 4" stroke="${T}" stroke-width="17" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M8 -6 L 60 -22 L 84 6" stroke="${T}" stroke-width="16" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M-6 -78 C 18 -70, 34 -56, 46 -44" stroke="${T}" stroke-width="10" fill="none" stroke-linecap="round"/>
    </g>`,
  // Standing, studying a map.
  mist: `
    <g fill="${T}">
      <rect x="-40" y="-118" width="30" height="62" rx="10"/>
      <path d="M-18 -128 C 0 -134, 18 -124, 20 -96 L 18 -54 L -22 -54 L -24 -100 Z"/>
      <circle cx="0" cy="-146" r="15"/>
      <path d="M-16 -154 Q 0 -170 16 -154 L 24 -150 L -18 -150 Z"/>
      <path d="M-14 -56 L -18 0 M 12 -56 L 20 0" stroke="${T}" stroke-width="14" stroke-linecap="round"/>
      <path d="M14 -110 L 40 -98 M -10 -108 L 30 -92" stroke="${T}" stroke-width="9" stroke-linecap="round"/>
      <path d="M30 -112 L 64 -104 L 60 -78 L 26 -86 Z" fill="#f4ead2" stroke="${T}" stroke-width="3"/>
      <path d="M42 -106 L 40 -82 M 52 -104 L 50 -80" stroke="#c9b48a" stroke-width="2"/>
    </g>`,
  // Paddling a canoe.
  backwater: `
    <g fill="${T}">
      <path d="M-140 -6 Q 0 26 150 -10 Q 120 10 0 14 Q -110 12 -140 -6 Z"/>
      <path d="M-14 -6 C -18 -40, -10 -62, 6 -66 C 22 -68, 28 -50, 24 -10 Z"/>
      <circle cx="10" cy="-84" r="14"/>
      <path d="M-4 -92 Q 10 -106 24 -92 L 30 -88 L -6 -88 Z"/>
      <rect x="-40" y="-48" width="26" height="40" rx="8"/>
      <path d="M-30 -110 L 70 30" stroke="${T}" stroke-width="6" stroke-linecap="round"/>
      <ellipse cx="74" cy="36" rx="16" ry="7" transform="rotate(54 74 36)"/>
      <path d="M8 -54 L 28 -64 L 40 -40" stroke="${T}" stroke-width="9" fill="none" stroke-linecap="round"/>
    </g>`,
  // Sitting on a log by the campfire.
  stars: `
    <g>
      <rect x="-90" y="-16" width="130" height="18" rx="9" fill="#1a110c"/>
      <g fill="#120c09">
        <rect x="-74" y="-92" width="26" height="54" rx="9"/>
        <path d="M-52 -18 C -58 -64, -46 -96, -26 -100 C -6 -102, 4 -80, 0 -20 Z"/>
        <circle cx="-22" cy="-118" r="15"/>
        <path d="M-38 -126 Q -22 -142 -6 -126 L 2 -122 L -40 -122 Z"/>
        <path d="M-10 -20 L 30 -40 L 46 0" stroke="#120c09" stroke-width="15" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M-6 -78 C 18 -74, 34 -64, 50 -58" stroke="#120c09" stroke-width="9" fill="none" stroke-linecap="round"/>
      </g>
      <ellipse cx="96" cy="0" rx="120" ry="40" fill="url(#fireglow)"/>
      <path d="M82 0 L 110 0 M 76 4 L 116 -6" stroke="#3a2416" stroke-width="7" stroke-linecap="round"/>
      <path d="M96 -4 C 80 -26, 92 -44, 98 -62 C 104 -40, 120 -32, 106 -4 Z" fill="#ff9d2e"/>
      <path d="M97 -4 C 90 -18, 96 -30, 99 -40 C 104 -26, 110 -20, 103 -4 Z" fill="#ffe08a"/>
    </g>`,
  // Walking with an umbrella in the rain.
  monsoon: `
    <g fill="#14100e">
      <rect x="-34" y="-112" width="28" height="56" rx="9"/>
      <path d="M-12 -122 C 6 -128, 22 -116, 22 -90 L 18 -54 L -18 -54 L -20 -96 Z"/>
      <circle cx="4" cy="-138" r="14"/>
      <path d="M-10 -56 L -34 0 M 12 -56 L 34 -2" stroke="#14100e" stroke-width="14" stroke-linecap="round"/>
      <path d="M16 -104 L 40 -130" stroke="#14100e" stroke-width="8" stroke-linecap="round"/>
      <path d="M40 -130 L 40 -186" stroke="#14100e" stroke-width="4"/>
      <path d="M-26 -176 Q 40 -246 106 -176 Q 90 -184 73 -176 Q 57 -186 40 -176 Q 23 -186 7 -176 Q -10 -184 -26 -176 Z" fill="#c6402a"/>
    </g>`,
  // Walking on the beach, sandals in hand.
  beach: `
    <g fill="${T}">
      <rect x="-36" y="-114" width="28" height="58" rx="9"/>
      <path d="M-14 -124 C 4 -130, 20 -118, 20 -92 L 16 -54 L -20 -54 L -22 -98 Z"/>
      <circle cx="2" cy="-140" r="14"/>
      <path d="M-12 -148 Q 2 -162 16 -148 L 24 -144 L -14 -144 Z"/>
      <path d="M-12 -56 L -30 -2 M 10 -56 L 30 0" stroke="${T}" stroke-width="14" stroke-linecap="round"/>
      <path d="M16 -104 L 34 -72" stroke="${T}" stroke-width="8" stroke-linecap="round"/>
      <path d="M30 -70 l 10 4 M 32 -64 l 10 4" stroke="${T}" stroke-width="5" stroke-linecap="round"/>
    </g>`,
}

interface Palette { sky: [string, string, string]; sun: string; glow: string; far: string; mid: string; near: string; ground: string; water?: string }
const PAL: Record<Mood, Palette> = {
  sunset: { sky: ['#f3b35a', '#f08a3c', '#c8522a'], sun: '#ffe3a0', glow: '#ffb357', far: '#d98252', mid: '#a9542f', near: '#7a3a20', ground: '#5a2a17' },
  mist: { sky: ['#dfe9e6', '#cfe0d8', '#b9d0c4'], sun: '#fffaf0', glow: '#ffffff', far: '#a9c3b5', mid: '#7fa594', near: '#4f7d62', ground: '#3e6a4e' },
  backwater: { sky: ['#ffd9a8', '#f7b98a', '#e79a7a'], sun: '#fff1c9', glow: '#ffd29a', far: '#9aa98e', mid: '#5f7c5a', near: '#2f4d33', ground: '#2f4d33', water: '#d99a7a' },
  stars: { sky: ['#0d1630', '#1b2550', '#33305c'], sun: '#f6f0d6', glow: '#7c86c9', far: '#262a4f', mid: '#1b1d3a', near: '#121327', ground: '#0e0f1f' },
  monsoon: { sky: ['#4b5d63', '#61767a', '#7d9292'], sun: '#e8eeee', glow: '#9fb3b3', far: '#4f6b62', mid: '#36564a', near: '#243f34', ground: '#1d332a' },
  beach: { sky: ['#f9c9a0', '#f2a27d', '#c9727a'], sun: '#ffe6b8', glow: '#ffc58f', far: '#8c7a8e', mid: '#5b5470', near: '#e8c49a', ground: '#d9ad80', water: '#7f8fb3' },
}

/** The full scene as an SVG string (1600×600, sliced to cover). */
export function sceneSvg(mood: Mood): string {
  const p = PAL[mood]
  const r = rng(mood.length * 97)
  const sunPos = mood === 'stars' ? [1240, 120] : mood === 'mist' ? [1180, 150] : [1260, 300]
  const stars = mood === 'stars' ? Array.from({ length: 90 }, () => `<circle cx="${(r() * 1600).toFixed(0)}" cy="${(r() * 300).toFixed(0)}" r="${(r() * 1.6 + 0.4).toFixed(1)}" fill="#fff" opacity="${(r() * 0.6 + 0.3).toFixed(2)}"/>`).join('') : ''
  const rain = mood === 'monsoon' ? `<g stroke="#dfe8e8" stroke-width="1.6" opacity=".45">${Array.from({ length: 160 }, () => { const x = r() * 1700 - 50, y = r() * 600; return `<line x1="${x.toFixed(0)}" y1="${y.toFixed(0)}" x2="${(x - 14).toFixed(0)}" y2="${(y + 34).toFixed(0)}"/>` }).join('')}</g>` : ''
  const mist = mood === 'mist' ? `<rect x="0" y="250" width="1600" height="90" fill="#fff" opacity=".35"/><rect x="0" y="330" width="1600" height="60" fill="#fff" opacity=".25"/>` : ''
  const tea = mood === 'mist' ? `<g stroke="#3b6b4f" stroke-width="5" opacity=".55" fill="none">${Array.from({ length: 9 }, (_, i) => `<path d="M ${-40 + i * 10} ${470 + i * 18} Q 700 ${430 + i * 18} 1640 ${480 + i * 16}"/>`).join('')}</g>` : ''
  const water = p.water ? `<rect x="0" y="470" width="1600" height="140" fill="${p.water}"/><g stroke="#fff" opacity=".35" stroke-width="2">${Array.from({ length: 26 }, () => { const x = r() * 1600, y = 485 + r() * 110; return `<line x1="${x.toFixed(0)}" y1="${y.toFixed(0)}" x2="${(x + 30 + r() * 60).toFixed(0)}" y2="${y.toFixed(0)}"/>` }).join('')}</g><ellipse cx="${sunPos[0]}" cy="${mood === 'beach' ? 500 : 520}" rx="90" ry="${mood === 'beach' ? 14 : 50}" fill="url(#glow-${mood})" opacity=".8"/>` : ''
  const palms = mood === 'backwater'
    ? palm(120, 478, 230, 40, '#22381f') + palm(210, 480, 180, -30, '#22381f') + palm(1480, 476, 210, -40, '#22381f') + palm(1390, 478, 160, 25, '#22381f')
    : mood === 'beach' ? palm(1460, 520, 260, -60, '#3d2f3f') + palm(1380, 524, 190, 30, '#3d2f3f') : ''
  const land = mood === 'backwater' ? `<path d="M -20 470 Q 300 440 700 468 T 1620 466 L 1620 482 L -20 482 Z" fill="${p.near}"/>` : ''
  const ground = mood === 'beach'
    ? `<path d="M -20 520 Q 600 500 1620 530 L 1620 620 L -20 620 Z" fill="${p.ground}"/><path d="M -20 520 Q 600 500 1620 530" stroke="#fff" stroke-width="3" opacity=".6" fill="none"/>`
    : mood === 'backwater' ? '' : `<path d="M -20 500 C 200 420, 520 440, 780 520 S 1250 590 1620 585 L 1620 620 L -20 620 Z" fill="${p.ground}"/>`
  const where = mood === 'backwater' ? 'translate(430 522) scale(.85)' : mood === 'beach' ? 'translate(430 548) scale(.9)' : mood === 'monsoon' ? 'translate(400 540) scale(.9)' : mood === 'stars' ? 'translate(360 520) scale(.95)' : mood === 'mist' ? 'translate(360 492) scale(.95)' : 'translate(360 492) scale(.95)'
  const moon = mood === 'stars' ? `<circle cx="${sunPos[0] + 16}" cy="${sunPos[1] - 10}" r="38" fill="${p.sky[0]}"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 600" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
<defs>
  <linearGradient id="sky-${mood}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.sky[0]}"/><stop offset=".6" stop-color="${p.sky[1]}"/><stop offset="1" stop-color="${p.sky[2]}"/></linearGradient>
  <radialGradient id="glow-${mood}"><stop offset="0" stop-color="${p.glow}" stop-opacity=".9"/><stop offset="1" stop-color="${p.glow}" stop-opacity="0"/></radialGradient>
  <radialGradient id="fireglow"><stop offset="0" stop-color="#ffb347" stop-opacity=".7"/><stop offset="1" stop-color="#ffb347" stop-opacity="0"/></radialGradient>
</defs>
<rect width="1600" height="600" fill="url(#sky-${mood})"/>
${stars}
<circle cx="${sunPos[0]}" cy="${sunPos[1]}" r="260" fill="url(#glow-${mood})"/>
<circle cx="${sunPos[0]}" cy="${sunPos[1]}" r="${mood === 'stars' ? 40 : 70}" fill="${p.sun}" opacity="${mood === 'monsoon' ? 0.25 : 0.95}"/>
${moon}
<path d="${ridge(330, 160, 11, 7)}" fill="${p.far}" opacity=".75"/>
${mist}
<path d="${ridge(410, 120, 23, 9)}" fill="${p.mid}" opacity=".9"/>
${mood === 'backwater' || mood === 'beach' ? '' : `<path d="${ridge(480, 90, 37, 4)}" fill="${p.near}"/>`}
${tea}
${water}
${land}
${palms}
${ground}
<g transform="${where}">${traveller[mood]}</g>
${rain}
</svg>`
}

export interface HeroProps {
  mood: Mood
  /** Uploaded photo for this mood (replaces the drawing). */
  photo?: string | null
  kicker?: string
  title: string
  /** Word(s) set in the handwritten script under the title, e.g. "Your Way". */
  script?: string
  subtitle?: string
  /** 'home' = tall with search; 'page' = shorter. */
  size?: 'home' | 'page' | 'strip'
  children?: unknown
}

/** Page-top hero: the mood scene (or photo), kicker, serif title with script accent, and an optional slot. */
export const PageHero: FC<HeroProps> = ({ mood, photo, kicker, title, script, subtitle, size = 'page', children }) => (
  <section class={`mood-hero mood-${mood} mood-text-${photo ? 'dark' : MOODS[mood].text} mood-${size}`}>
    <div class="mood-bg">{photo ? <img src={photo} alt="" fetchpriority="high" /> : raw(sceneSvg(mood))}</div>
    <div class="mood-shade"></div>
    <div class="wrap mood-in">
      <div class="mood-copy">
        {kicker && <div class="mood-kicker">{kicker}</div>}
        <h1 class="mood-title">{title}{script && <span class="mood-script">{script}</span>}</h1>
        {subtitle && <p class="mood-sub">{subtitle}</p>}
      </div>
      {children as never}
    </div>
    <svg class="mood-edge" viewBox="0 0 1600 60" preserveAspectRatio="none" aria-hidden="true">
      <path d="M0 34 L40 28 L95 38 L150 24 L210 36 L270 22 L330 34 L400 26 L470 38 L540 24 L600 34 L670 20 L740 36 L810 26 L880 38 L950 22 L1020 34 L1090 24 L1160 38 L1230 26 L1300 36 L1370 22 L1440 34 L1510 26 L1600 32 L1600 60 L0 60 Z" />
    </svg>
  </section>
)
