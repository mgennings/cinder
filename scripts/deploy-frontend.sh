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
# exactly the pages that need this the most. `index.html` is skipped at every
# depth, not just the root, since it never owns a route of its own and
# aliasing one would collide with its directory's own extensionless key.
echo "Publishing extensionless aliases for prerendered pages…"
while IFS= read -r -d '' f; do
	rel="${f#build/}"
	base="$(basename "$rel")"
	base="${base%.html}"
	[ "$base" = "index" ] && continue
	[ "$base" = "200" ] && continue
	key="${rel%.html}"
	aws s3 cp "$f" "s3://$BUCKET/$key" --content-type "text/html" \
		--cache-control "public,max-age=300" --region us-east-1 --only-show-errors
	echo "  /$key"
done < <(find build -type f -name '*.html' -print0)

echo "Invalidating CloudFront…"
INVALIDATION_ID="$(aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths '/*' \
	--region us-east-1 --no-cli-pager --query 'Invalidation.Id' --output text)"
aws cloudfront wait invalidation-completed --distribution-id "$DIST_ID" \
	--id "$INVALIDATION_ID" --region us-east-1

echo "Done → https://cinder.ink"
