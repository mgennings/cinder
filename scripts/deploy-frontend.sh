#!/usr/bin/env bash
# Build the static site and publish it to S3 + CloudFront.
set -euo pipefail
cd "$(dirname "$0")/.."

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="blip-site-${ACCOUNT_ID}"
DIST_ID="E2TB140HKYS6AA"

echo "Building…"
pnpm build

echo "Syncing to s3://$BUCKET …"
aws s3 sync build/ "s3://$BUCKET" --delete --exclude '.DS_Store' --region us-east-1

# Prerendered pages land as `security.html`, `field-notes.html`,
# `field-notes/the-vote-to-stay-blind.html`, and so on at any depth, but
# CloudFront always requests the extensionless key. Without an alias at every
# depth, a nested route like `/field-notes/the-vote-to-stay-blind` misses its
# S3 key, CloudFront's custom error response turns that miss into an HTTP 200
# with the empty SPA shell, and every crawler or RSS reader that does not run
# JavaScript sees nothing while curl and every human still see 200. The walk
# has to be recursive, not a top-level glob, because nested routes are
# exactly the pages that need this the most.
#
# `index.html` is skipped at every depth because `${rel%.html}` only strips
# the extension, so it would turn a nested `field-notes/index.html` into the
# junk key `field-notes/index`, not the directory key a route would need.
# This is correct only while `trailingSlash` is unset (vite.config.ts): with
# it unset, adapter-static emits flat files (`field-notes.html`), never a
# per-directory `index.html`. Set `trailingSlash: 'always'` and this skip
# would silently drop the alias for every nested route again; derive the key
# from the directory instead if that ever changes.
#
# `200.html` is skipped only at the ROOT: it is the SPA fallback CloudFront
# serves for every miss (template.yaml CustomErrorResponses), not a route. A
# nested `200.html` would be a real page and must still get its alias.
echo "Publishing extensionless aliases for prerendered pages…"

# find's exit status disappears once its output feeds a process substitution:
# a failing find (bad path, permissions) leaves the loop silently empty and
# the script still exits 0. Route through a file so `set -e` can see find's
# own failure before the loop ever starts.
HTML_LIST="$(mktemp)"
trap 'rm -f "$HTML_LIST"' EXIT
find build -type f -name '*.html' -print0 > "$HTML_LIST"

while IFS= read -r -d '' f; do
	rel="${f#build/}"
	base="${rel##*/}"
	base="${base%.html}"
	[ "$base" = "index" ] && continue
	[ "$rel" = "200.html" ] && continue
	key="${rel%.html}"
	aws s3 cp "$f" "s3://$BUCKET/$key" --content-type "text/html" \
		--cache-control "public,max-age=300" --region us-east-1 --only-show-errors
	echo "  /$key"
done < "$HTML_LIST"

echo "Invalidating CloudFront…"
INVALIDATION_ID="$(aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths '/*' \
	--region us-east-1 --no-cli-pager --query 'Invalidation.Id' --output text)"
aws cloudfront wait invalidation-completed --distribution-id "$DIST_ID" \
	--id "$INVALIDATION_ID" --region us-east-1

echo "Done → https://cinder.ink"
