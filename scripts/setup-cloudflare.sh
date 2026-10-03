#!/usr/bin/env bash
# Optional extras that `npm run deploy` can't create on its own. Run once after `npx wrangler login`.
# (The database, KV, R2 buckets and queue are created automatically on deploy.)
set -uo pipefail
cd "$(dirname "$0")/.."
W="npx wrangler"

echo "▶ Vectorize index for 'Recommended' sorting and similar properties (\"already exists\" is fine)"
$W vectorize create gosanchari-properties --dimensions=1024 --metric=cosine 2>&1 | tail -1
$W vectorize create-metadata-index gosanchari-properties --property-name=status --type=string 2>&1 | tail -1

cat <<'NEXT'

✔ Done. Now uncomment the [[vectorize]] block in wrangler.toml, commit, and deploy again.
  AI Search: create "gosanchari-kb" in the dashboard (AI → AI Search, source = R2 bucket gosanchari-kb),
  then uncomment the [[ai_search]] block too.
NEXT
