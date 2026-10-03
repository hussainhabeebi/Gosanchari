// Creates (or resets) an admin login in the D1 database.
// Usage: npm run admin:create -- you@example.com "Your Name" [+919XXXXXXXXX]
//        (add --local to use the local dev database instead of the live one)
// The password is asked for interactively and never written to disk.
import { pbkdf2Sync, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
const local = args.includes('--local')
const [email, name = 'Admin', phone = ''] = args.filter((a) => a !== '--local')
if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
  console.error('Usage: npm run admin:create -- you@example.com "Your Name" [+919XXXXXXXXX] [--local]')
  process.exit(1)
}

const rl = createInterface({ input: process.stdin, output: process.stdout })
const password = await new Promise((r) => rl.question('Password (min 8 characters): ', (a) => { rl.close(); r(a) }))
if (password.length < 8) { console.error('Password too short.'); process.exit(1) }

const salt = randomBytes(16)
const hash = `pbkdf2$100000$${salt.toString('base64')}$${pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('base64')}`
const q = (v) => (v ? `'${String(v).replace(/'/g, "''")}'` : 'NULL')
const sql = `INSERT INTO users (role, name, email, phone, password_hash) VALUES ('admin', ${q(name)}, ${q(email.toLowerCase())}, ${q(phone)}, ${q(hash)})
  ON CONFLICT(email) DO UPDATE SET role = 'admin', name = excluded.name, password_hash = excluded.password_hash, active = 1, blocked = 0;`

execFileSync('npx', ['wrangler', 'd1', 'execute', 'gosanchari', ...(local ? ['--local', '-c', 'wrangler.offline.toml'] : ['--remote']), '--command', sql], { stdio: 'inherit' })
console.log(`\n✔ Admin ready: log in at /login → Email tab with ${email}`)
