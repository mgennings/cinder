#!/usr/bin/env bash
# Clear the resources a FAILED FIRST DEPLOY leaves behind, so the next attempt
# is not blocked by the wreckage of the last one.
#
# Why this exists, measured on 2026-07-28 across three consecutive rollbacks:
#
#   MattosUserPool carries DeletionProtection: ACTIVE, so CloudFormation's
#   rollback CANNOT delete it. The rollback reports "One or more resources could
#   not be deleted", drops the pool from the stack, and leaves it live. The next
#   deploy then fails AWS::EarlyValidation::ResourceExistenceCheck before it
#   creates anything, because the hosted-UI domain name is globally unique.
#
#   EntitlementTable carries DeletionPolicy: Retain, which is CORRECT once it
#   holds real purchases and wrong on a first create that fails: rollback
#   SKIPS the delete, the table survives unmanaged, and the next create collides
#   with it. Retain stays. This script handles the first-create case instead.
#
# Both are safe to remove ONLY while they are empty, so this refuses otherwise.
# A pool with users or a table with rows is somebody's account and somebody's
# purchase, and no convenience is worth guessing about that.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
POOL_NAME="${1:-mattos-identity}"
TABLE_NAME="${2:-mattos-entitlements}"

echo "clearing orphans from a failed deploy (region $REGION)"

pool_id="$(aws cognito-idp list-user-pools --max-results 60 --region "$REGION" \
  --query "UserPools[?Name=='$POOL_NAME'].Id | [0]" --output text 2>/dev/null || true)"

if [ -n "$pool_id" ] && [ "$pool_id" != "None" ]; then
	users="$(aws cognito-idp list-users --user-pool-id "$pool_id" --region "$REGION" \
	  --query 'length(Users)' --output text 2>/dev/null || echo 0)"
	if [ "$users" != "0" ]; then
		echo "REFUSING: user pool $pool_id has $users users. That is somebody's account." >&2
		exit 1
	fi
	echo "  user pool $pool_id (0 users) — disabling deletion protection, deleting"
	aws cognito-idp update-user-pool --user-pool-id "$pool_id" --region "$REGION" \
	  --deletion-protection INACTIVE >/dev/null
	aws cognito-idp delete-user-pool --user-pool-id "$pool_id" --region "$REGION"
else
	echo "  no orphaned user pool"
fi

items="$(aws dynamodb describe-table --table-name "$TABLE_NAME" --region "$REGION" \
  --query 'Table.ItemCount' --output text 2>/dev/null || echo MISSING)"

if [ "$items" = "MISSING" ]; then
	echo "  no orphaned entitlement table"
elif [ "$items" != "0" ]; then
	echo "REFUSING: $TABLE_NAME holds $items rows. Every row is a purchase." >&2
	exit 1
else
	echo "  table $TABLE_NAME (0 items) — deleting"
	aws dynamodb delete-table --table-name "$TABLE_NAME" --region "$REGION" >/dev/null
fi

echo "done. retry the deploy."
