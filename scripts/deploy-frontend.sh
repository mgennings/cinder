#!/usr/bin/env bash
# Build the static site and publish it to S3 + CloudFront.
set -euo pipefail
cd "$(dirname "$0")/.."

BUCKET="blip-site-553806908724"
DIST_ID="E2TB140HKYS6AA"

echo "Building…"
pnpm build

echo "Syncing to s3://$BUCKET …"
aws s3 sync build/ "s3://$BUCKET" --delete --region us-east-1

echo "Invalidating CloudFront…"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths '/*' \
	--region us-east-1 --no-cli-pager --query 'Invalidation.Id' --output text

echo "Done → https://d1v6mxepibwneb.cloudfront.net"
