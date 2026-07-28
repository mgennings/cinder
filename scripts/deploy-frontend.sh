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

# Prerendered pages land as `security.html`, `field-notes.html`, etc., but
# CloudFront requests the extensionless key. Without this, `/field-notes` 404s
# into the SPA shell and every crawler that does not run JavaScript sees an
# empty page — which defeats the point of prerendering it at all.
echo "Publishing extensionless aliases for prerendered pages…"
for f in build/*.html; do
	name="$(basename "$f" .html)"
	[ "$name" = "index" ] && continue
	[ "$name" = "200" ] && continue
	aws s3 cp "$f" "s3://$BUCKET/$name" --content-type "text/html" \
		--cache-control "public,max-age=300" --region us-east-1 --only-show-errors
	echo "  /$name"
done

echo "Invalidating CloudFront…"
INVALIDATION_ID="$(aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths '/*' \
	--region us-east-1 --no-cli-pager --query 'Invalidation.Id' --output text)"
aws cloudfront wait invalidation-completed --distribution-id "$DIST_ID" \
	--id "$INVALIDATION_ID" --region us-east-1

echo "Done → https://cinder.ink"
