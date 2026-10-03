// 7. Login / sign up: phone OTP (main), email + password, Google. One screen for every role.

import { Hono } from 'hono'
import type { AppEnv } from '../env'
import { page } from '../views/layout'
import { Field, Turnstile } from '../views/components'
import { createOtp, createSession, destroySession, hashPassword, homeFor, rateLimit, verifyOtp, verifyPassword } from '../lib/auth'
import { first, insertId, logActivity, run } from '../lib/db'
import { fillTemplate, sendEmail, sendWhatsApp, verifyTurnstile, whatsappConfigured } from '../lib/integrations'
import { getSettings } from '../lib/settings'
import type { Role } from '../lib/permissions'
import { normalizePhone, randomToken, sha256Hex, str, timingSafeEqual } from '../lib/util'
import { clientIp, form, redirectMsg, safeNext } from './helpers'

export const authRoutes = new Hono<AppEnv>()

interface UserRow { id: number; role: Role; password_hash: string | null; active: number; blocked: number; merged_into: number | null }

authRoutes.get('/login', async (c) => {
  if (c.get('user')) return c.redirect(safeNext(c.req.query('next'), homeFor(c.get('user')!.role)))
  const next = safeNext(c.req.query('next'), '')
  const step = c.req.query('step')
  const phone = c.req.query('phone') ?? ''
  const devCode = c.req.query('dev')
  const tab = c.req.query('tab') ?? 'phone'
  return page(c, { title: 'Log in', noindex: true }, (
    <div class="wrap narrow section">
      <div class="card auth-card">
        <h1>Log in or sign up</h1>
        <nav class="tabs">
          <a href={`/login?tab=phone&next=${encodeURIComponent(next)}`} class={tab === 'phone' ? 'active' : ''}>Phone</a>
          <a href={`/login?tab=email&next=${encodeURIComponent(next)}`} class={tab === 'email' ? 'active' : ''}>Email</a>
        </nav>
        {tab === 'phone' && step !== 'code' && (
          <form method="post" action="/login/otp/send" class="stack">
            <Field label="Mobile number" hint="We'll send a 6-digit code on WhatsApp.">
              <input name="phone" inputmode="tel" autocomplete="tel" required placeholder="98765 43210" value={phone} />
            </Field>
            <input type="hidden" name="next" value={next} />
            <Turnstile siteKey={c.env.TURNSTILE_SITE_KEY} />
            <button class="btn btn-lg">Send code</button>
          </form>
        )}
        {tab === 'phone' && step === 'code' && (
          <form method="post" action="/login/otp/verify" class="stack">
            <p>Enter the code sent to <strong>{phone}</strong>. <a href={`/login?next=${encodeURIComponent(next)}`}>Change</a></p>
            {devCode && <p class="flash">Development mode: your code is <strong>{devCode}</strong></p>}
            <Field label="6-digit code"><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="\d{6}" maxlength={6} required autofocus /></Field>
            <Field label="Your name (new accounts)"><input name="name" maxlength={80} autocomplete="name" /></Field>
            <input type="hidden" name="phone" value={phone} />
            <input type="hidden" name="next" value={next} />
            <button class="btn btn-lg">Verify and continue</button>
          </form>
        )}
        {tab === 'email' && (
          <form method="post" action="/login/password" class="stack">
            <Field label="Email"><input type="email" name="email" required autocomplete="email" /></Field>
            <Field label="Password"><input type="password" name="password" required autocomplete="current-password" /></Field>
            <input type="hidden" name="next" value={next} />
            <Turnstile siteKey={c.env.TURNSTILE_SITE_KEY} />
            <button class="btn btn-lg">Log in</button>
            <div class="row-between small"><a href="/forgot">Forgot password?</a><a href={`/signup?next=${encodeURIComponent(next)}`}>Create an account</a></div>
          </form>
        )}
        {c.env.GOOGLE_CLIENT_ID && (
          <>
            <div class="or">or</div>
            <a class="btn btn-outline btn-block" href={`/auth/google?next=${encodeURIComponent(next)}`}>Continue with Google</a>
          </>
        )}
      </div>
    </div>
  ))
})

authRoutes.post('/login/otp/send', async (c) => {
  const f = await form(c)
  const next = safeNext(f.next, '')
  if (!(await verifyTurnstile(c.env, f['cf-turnstile-response'], clientIp(c)))) return redirectMsg(c, `/login?next=${encodeURIComponent(next)}`, { err: 'Please complete the bot check.' })
  if (!(await rateLimit(c.env, `otp-ip:${clientIp(c)}`, 20, 3600))) return redirectMsg(c, '/login', { err: 'Too many attempts. Try again later.' })
  const phone = normalizePhone(f.phone)
  if (!phone) return redirectMsg(c, `/login?next=${encodeURIComponent(next)}`, { err: 'Please enter a valid mobile number.' })
  const r = await createOtp(c.env, phone)
  if ('error' in r) return redirectMsg(c, `/login?next=${encodeURIComponent(next)}`, { err: r.error })
  const s = await getSettings(c.env)
  const text = fillTemplate(s.whatsapp_templates.otp, { code: r.code })
  // OTPs must arrive fast, so they are sent directly (not via the queue). Authentication templates
  // are the WhatsApp-approved way to send codes; configure one named "otp" in Meta.
  const sent = await sendWhatsApp(c.env, phone, text, whatsappConfigured(c.env) ? { name: 'otp', params: [r.code] } : undefined)
  const params = new URLSearchParams({ step: 'code', phone, next })
  if (!whatsappConfigured(c.env) && c.env.ENVIRONMENT !== 'production') params.set('dev', r.code)
  if (!sent.ok) return redirectMsg(c, `/login?next=${encodeURIComponent(next)}`, { err: 'Could not send the code. Please try email login or contact us.' })
  return c.redirect('/login?' + params.toString(), 303)
})

authRoutes.post('/login/otp/verify', async (c) => {
  const f = await form(c)
  const next = safeNext(f.next, '')
  const phone = normalizePhone(f.phone)
  if (!phone || !(await verifyOtp(c.env, phone, f.code ?? ''))) {
    return redirectMsg(c, `/login?${new URLSearchParams({ step: 'code', phone: phone ?? '', next })}`, { err: 'That code is not right or has expired.' })
  }
  let u = await first<UserRow>(c.env, 'SELECT id, role, password_hash, active, blocked, merged_into FROM users WHERE phone = ?', phone)
  if (u?.merged_into) u = await first<UserRow>(c.env, 'SELECT id, role, password_hash, active, blocked, merged_into FROM users WHERE id = ?', u.merged_into)
  if (u && (!u.active || u.blocked)) return redirectMsg(c, '/login', { err: 'This account is not active. Please contact us.' })
  if (!u) {
    const id = await insertId(c.env, "INSERT INTO users (role, name, phone) VALUES ('guest', ?, ?)", str(f.name, 80) || 'Guest', phone)
    u = { id, role: 'guest', password_hash: null, active: 1, blocked: 0, merged_into: null }
  } else if (f.name) {
    await run(c.env, "UPDATE users SET name = ? WHERE id = ? AND (name = '' OR name = 'Guest')", str(f.name, 80), u.id)
  }
  // Link enquiries made before signing up.
  await run(c.env, 'UPDATE enquiries SET user_id = ? WHERE phone = ? AND user_id IS NULL', u.id, phone)
  await createSession(c, u.id, u.role)
  await logActivity(c.env, u.id, 'login.otp', 'user', u.id)
  return c.redirect(next || homeFor(u.role), 303)
})

authRoutes.post('/login/password', async (c) => {
  const f = await form(c)
  const next = safeNext(f.next, '')
  const back = `/login?tab=email&next=${encodeURIComponent(next)}`
  if (!(await verifyTurnstile(c.env, f['cf-turnstile-response'], clientIp(c)))) return redirectMsg(c, back, { err: 'Please complete the bot check.' })
  const email = str(f.email, 120).toLowerCase()
  if (!(await rateLimit(c.env, `pw:${email}`, 10, 900))) return redirectMsg(c, back, { err: 'Too many attempts. Try again in 15 minutes.' })
  const u = await first<UserRow>(c.env, 'SELECT id, role, password_hash, active, blocked, merged_into FROM users WHERE email = ?', email)
  if (!u || !(await verifyPassword(f.password ?? '', u.password_hash)) || !u.active || u.blocked || u.merged_into) return redirectMsg(c, back, { err: 'Email or password is incorrect.' })
  await createSession(c, u.id, u.role)
  await logActivity(c.env, u.id, 'login.password', 'user', u.id)
  return c.redirect(next || homeFor(u.role), 303)
})

authRoutes.get('/signup', (c) =>
  page(c, { title: 'Create account', noindex: true }, (
    <div class="wrap narrow section">
      <form method="post" action="/signup" class="card auth-card stack">
        <h1>Create an account</h1>
        <p class="muted small">Prefer your phone? <a href="/login">Log in with a code</a> — it creates an account automatically.</p>
        <Field label="Name"><input name="name" required maxlength={80} autocomplete="name" /></Field>
        <Field label="Email"><input type="email" name="email" required autocomplete="email" /></Field>
        <Field label="Mobile (optional)"><input name="phone" inputmode="tel" autocomplete="tel" /></Field>
        <Field label="Password" hint="At least 8 characters."><input type="password" name="password" minlength={8} required autocomplete="new-password" /></Field>
        <input type="hidden" name="next" value={safeNext(c.req.query('next'), '')} />
        <Turnstile siteKey={c.env.TURNSTILE_SITE_KEY} />
        <button class="btn btn-lg">Create account</button>
      </form>
    </div>
  )),
)

authRoutes.post('/signup', async (c) => {
  const f = await form(c)
  if (!(await verifyTurnstile(c.env, f['cf-turnstile-response'], clientIp(c)))) return redirectMsg(c, '/signup', { err: 'Please complete the bot check.' })
  const email = str(f.email, 120).toLowerCase()
  const password = f.password ?? ''
  if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8) return redirectMsg(c, '/signup', { err: 'Enter a valid email and a password of at least 8 characters.' })
  if (await first(c.env, 'SELECT 1 FROM users WHERE email = ?', email)) return redirectMsg(c, '/login?tab=email', { err: 'An account with this email exists. Please log in.' })
  // A phone number on sign-up is stored only if no account already owns it (phone ownership is proven by OTP).
  const phone = normalizePhone(f.phone)
  const phoneFree = phone && !(await first(c.env, 'SELECT 1 FROM users WHERE phone = ?', phone))
  const id = await insertId(c.env, "INSERT INTO users (role, name, email, phone, password_hash) VALUES ('guest', ?, ?, ?, ?)", str(f.name, 80), email, phoneFree ? phone : null, await hashPassword(password))
  await createSession(c, id, 'guest')
  return c.redirect(safeNext(f.next, '/my'), 303)
})

// ---- Google ----
authRoutes.get('/auth/google', async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID) return c.redirect('/login')
  const state = randomToken(16)
  await c.env.KV.put(`gstate:${state}`, safeNext(c.req.query('next'), ''), { expirationTtl: 600 })
  const p = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID, redirect_uri: `${c.env.SITE_URL}/auth/google/callback`, response_type: 'code',
    scope: 'openid email profile', state, prompt: 'select_account',
  })
  return c.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + p)
})

authRoutes.get('/auth/google/callback', async (c) => {
  const state = c.req.query('state') ?? ''
  const next = await c.env.KV.get(`gstate:${state}`)
  if (next === null || !c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) return redirectMsg(c, '/login', { err: 'Google login expired, please try again.' })
  await c.env.KV.delete(`gstate:${state}`)
  const tok = (await (await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: c.req.query('code') ?? '', client_id: c.env.GOOGLE_CLIENT_ID, client_secret: c.env.GOOGLE_CLIENT_SECRET, redirect_uri: `${c.env.SITE_URL}/auth/google/callback`, grant_type: 'authorization_code' }),
  })).json()) as { id_token?: string }
  if (!tok.id_token) return redirectMsg(c, '/login', { err: 'Google login failed.' })
  const info = (await (await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(tok.id_token))).json()) as { sub?: string; email?: string; email_verified?: string; name?: string; aud?: string }
  if (!info.sub || info.aud !== c.env.GOOGLE_CLIENT_ID) return redirectMsg(c, '/login', { err: 'Google login failed.' })
  const email = info.email_verified === 'true' ? info.email?.toLowerCase() ?? null : null
  let u = await first<UserRow>(c.env, 'SELECT id, role, password_hash, active, blocked, merged_into FROM users WHERE google_sub = ?', info.sub)
  if (!u && email) {
    u = await first<UserRow>(c.env, 'SELECT id, role, password_hash, active, blocked, merged_into FROM users WHERE email = ?', email)
    if (u) await run(c.env, 'UPDATE users SET google_sub = ? WHERE id = ?', info.sub, u.id)
  }
  if (!u) {
    const id = await insertId(c.env, "INSERT INTO users (role, name, email, google_sub) VALUES ('guest', ?, ?, ?)", info.name ?? '', email, info.sub)
    u = { id, role: 'guest', password_hash: null, active: 1, blocked: 0, merged_into: null }
  }
  if (!u.active || u.blocked || u.merged_into) return redirectMsg(c, '/login', { err: 'This account is not active.' })
  await createSession(c, u.id, u.role)
  return c.redirect(next || homeFor(u.role))
})

// ---- Forgot / reset password ----
authRoutes.get('/forgot', (c) =>
  page(c, { title: 'Forgot password', noindex: true }, (
    <div class="wrap narrow section">
      <form method="post" action="/forgot" class="card auth-card stack">
        <h1>Reset your password</h1>
        <Field label="Email"><input type="email" name="email" required /></Field>
        <Turnstile siteKey={c.env.TURNSTILE_SITE_KEY} />
        <button class="btn">Send reset link</button>
        <p class="small muted">Or <a href="/login">log in with a phone code</a>.</p>
      </form>
    </div>
  )),
)

authRoutes.post('/forgot', async (c) => {
  const f = await form(c)
  if (!(await verifyTurnstile(c.env, f['cf-turnstile-response'], clientIp(c)))) return redirectMsg(c, '/forgot', { err: 'Please complete the bot check.' })
  const email = str(f.email, 120).toLowerCase()
  const u = await first<{ id: number }>(c.env, 'SELECT id FROM users WHERE email = ? AND active = 1', email)
  if (u && (await rateLimit(c.env, `forgot:${email}`, 3, 3600))) {
    const token = randomToken(32)
    await c.env.KV.put(`reset:${await sha256Hex(token)}`, String(u.id), { expirationTtl: 3600 })
    await sendEmail(c.env, email, 'Reset your Go Sanchari password', `<p>Click to set a new password (valid for 1 hour):</p><p><a href="${c.env.SITE_URL}/reset/${token}">Reset password</a></p>`)
  }
  return redirectMsg(c, '/login?tab=email', { ok: 'If that email has an account, a reset link is on its way.' })
})

authRoutes.get('/reset/:token', (c) =>
  page(c, { title: 'Set new password', noindex: true }, (
    <div class="wrap narrow section">
      <form method="post" action={`/reset/${c.req.param('token')}`} class="card auth-card stack">
        <h1>Set a new password</h1>
        <Field label="New password"><input type="password" name="password" minlength={8} required autocomplete="new-password" /></Field>
        <button class="btn">Save password</button>
      </form>
    </div>
  )),
)

authRoutes.post('/reset/:token', async (c) => {
  const key = `reset:${await sha256Hex(c.req.param('token'))}`
  const uid = await c.env.KV.get(key)
  const f = await form(c)
  if (!uid) return redirectMsg(c, '/forgot', { err: 'This link has expired.' })
  if ((f.password ?? '').length < 8) return redirectMsg(c, `/reset/${c.req.param('token')}`, { err: 'Use at least 8 characters.' })
  await run(c.env, 'UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(f.password), Number(uid))
  await c.env.KV.delete(key)
  await logActivity(c.env, Number(uid), 'password.reset', 'user', uid)
  return redirectMsg(c, '/login?tab=email', { ok: 'Password updated. Please log in.' })
})

authRoutes.post('/logout', async (c) => {
  await destroySession(c)
  return c.redirect('/', 303)
})

// ---- First-run setup: create the first admin from the browser ----
// Works only while no active admin exists, and only with the SETUP_CODE secret set in Cloudflare.

async function hasAdmin(env: AppEnv['Bindings']): Promise<boolean> {
  return !!(await first(env, "SELECT 1 FROM users WHERE role = 'admin' AND active = 1 AND blocked = 0 AND merged_into IS NULL LIMIT 1"))
}

authRoutes.get('/setup', async (c) => {
  if (await hasAdmin(c.env)) return c.notFound()
  return page(c, { title: 'First-time setup', noindex: true }, (
    <div class="wrap narrow section">
      <div class="card auth-card stack">
        <h1>Create the first admin</h1>
        {!c.env.SETUP_CODE ? (
          <>
            <p>To protect this page, first add a setup code in Cloudflare:</p>
            <ol>
              <li>Cloudflare dashboard → <strong>Workers &amp; Pages → gosanchari → Settings → Variables and Secrets</strong></li>
              <li><strong>Add</strong> → Type: <strong>Secret</strong>, Name: <code>SETUP_CODE</code>, Value: any private word or number you choose</li>
              <li>Click <strong>Deploy</strong>, then reload this page</li>
            </ol>
          </>
        ) : (
          <form method="post" action="/setup" class="stack">
            <Field label="Setup code" hint="The SETUP_CODE value you added in Cloudflare."><input type="password" name="code" required autocomplete="off" /></Field>
            <Field label="Your name"><input name="name" required maxlength={80} autocomplete="name" /></Field>
            <Field label="Email (you log in with this)"><input type="email" name="email" required autocomplete="email" /></Field>
            <Field label="Mobile (optional, for WhatsApp login and alerts)"><input name="phone" inputmode="tel" autocomplete="tel" /></Field>
            <Field label="Password" hint="At least 8 characters."><input type="password" name="password" minlength={8} required autocomplete="new-password" /></Field>
            <button class="btn btn-lg">Create admin and log in</button>
          </form>
        )}
        <p class="muted small">This page switches itself off as soon as an admin exists.</p>
      </div>
    </div>
  ))
})

authRoutes.post('/setup', async (c) => {
  if (await hasAdmin(c.env)) return c.notFound()
  if (!c.env.SETUP_CODE) return c.redirect('/setup', 303)
  if (!(await rateLimit(c.env, `setup:${clientIp(c)}`, 5, 3600))) return redirectMsg(c, '/setup', { err: 'Too many attempts. Try again in an hour.' })
  const f = await form(c)
  if (!timingSafeEqual(await sha256Hex(f.code ?? ''), await sha256Hex(c.env.SETUP_CODE))) return redirectMsg(c, '/setup', { err: 'Setup code is not correct.' })
  const email = str(f.email, 120).toLowerCase()
  const name = str(f.name, 80)
  const password = f.password ?? ''
  if (!name || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8) return redirectMsg(c, '/setup', { err: 'Enter your name, a valid email and a password of at least 8 characters.' })
  const phone = normalizePhone(f.phone)
  const hash = await hashPassword(password)
  // Re-use an existing account with this email or phone (e.g. you sent an enquiry before), otherwise create one.
  const existing = await first<{ id: number }>(c.env, 'SELECT id FROM users WHERE email = ? OR (phone = ? AND ? IS NOT NULL) ORDER BY id LIMIT 1', email, phone, phone)
  let id: number
  if (existing) {
    id = existing.id
    await run(c.env, "UPDATE users SET role = 'admin', name = ?, email = ?, password_hash = ?, active = 1, blocked = 0, merged_into = NULL WHERE id = ?", name, email, hash, id)
    if (phone) await run(c.env, 'UPDATE users SET phone = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM users WHERE phone = ? AND id != ?)', phone, id, phone, id)
  } else {
    id = await insertId(c.env, "INSERT INTO users (role, name, email, phone, password_hash) VALUES ('admin', ?, ?, ?, ?)", name, email, phone, hash)
  }
  await logActivity(c.env, id, 'setup.first_admin', 'user', id, { email })
  await createSession(c, id, 'admin')
  return redirectMsg(c, '/admin', { ok: 'Welcome! Your admin account is ready. You can now delete SETUP_CODE in Cloudflare.' })
})
