#!/usr/bin/env bash
# One-time setup: creates the Cloudflare resources Go Sanchari needs and writes their IDs
# into wrangler.toml / wrangler.offline.toml. Safe to run again (existing resources are reused).
# Needs: `npx wrangler login` first (or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID set).
set -uo pipefail
cd "$(dirname "$0")/.."
W="npx wrangler"

echo "▶ D1 database"
$W d1 create gosanchari >/dev/null 2>&1 || true
D1_ID=$($W d1 list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).find(x=>x.name==="gosanchari");console.log(r?r.uuid:"")})')
[ -z "$D1_ID" ] && { echo "✘ Could not create or find D1 database 'gosanchari'"; exit 1; }
echo "  id $D1_ID"

echo "▶ KV namespace"
$W kv namespace create gosanchari-kv >/dev/null 2>&1 || true
KV_ID=$($W kv namespace list 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s.slice(s.indexOf("[")));const r=j.find(x=>x.title==="gosanchari-kv");console.log(r?r.id:"")})')
[ -z "$KV_ID" ] && { echo "✘ Could not create or find KV namespace 'gosanchari-kv'"; exit 1; }
echo "  id $KV_ID"

echo "▶ R2 buckets, queue, Vectorize index (\"already exists\" messages are fine)"
$W r2 bucket create gosanchari-media 2>&1 | tail -1
$W r2 bucket create gosanchari-kb 2>&1 | tail -1
$W queues create gosanchari-jobs 2>&1 | tail -1
$W vectorize create gosanchari-properties --dimensions=1024 --metric=cosine 2>&1 | tail -1
$W vectorize create-metadata-index gosanchari-properties --property-name=status --type=string 2>&1 | tail -1

echo "▶ Writing IDs into wrangler.toml and wrangler.offline.toml"
for f in wrangler.toml wrangler.offline.toml; do
  sed -i.bak -E "s/^database_id = \".*\"/database_id = \"$D1_ID\"/; s/^id = \"(REPLACE_WITH_KV_NAMESPACE_ID|[0-9a-f]{32})\"/id = \"$KV_ID\"/" "$f" && rm -f "$f.bak"
done

echo "▶ Applying database migrations"
$W d1 migrations apply gosanchari --remote

cat <<'NEXT'

✔ Resources ready. Next:
  1. Edit SITE_URL in wrangler.toml to your site address.
  2. Set a session secret:   npx wrangler secret put SESSION_SECRET
  3. Deploy:                 npm run deploy
  4. Create your admin login (or load demo data with: npm run db:seed:remote)
  Optional: AI Gateway "gosanchari", AI Search "gosanchari-kb", Turnstile, WhatsApp, email — see README.
NEXT
