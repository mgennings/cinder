#!/usr/bin/env bash

set -euo pipefail
cd "$(dirname "$0")"

ACCOUNT="553806908724"
REGION="us-east-1"
ZONE_ID="Z073855230DF25J9RR4B7"
DOMAIN="stats.cinder.ink"
FUNCTION="cinder-stats-api"
ROLE="cinder-stats-lambda-role"
API_NAME="cinder-stats-api"
SURFACE_SECRET_ID="cinder-stats-secrets"
SHARED_SECRET_ID="stats-shared-credential"
NAVIGATION_SECRET_ID="stats-private-navigation"
POLICY_NAME="cinder-stats-aggregate-reader"
DEFAULT_STAGE='$default'
SCRATCH=$(mktemp -d)

cleanup() {
  if [[ -d "$SCRATCH" && ( "$SCRATCH" == /tmp/* || "$SCRATCH" == /var/folders/* ) ]]; then
    find "$SCRATCH" -depth -delete
  fi
}
trap cleanup EXIT

say() { printf '▸ %s\n' "$*"; }

require_function_map() {
  [[ -n "${CINDER_FUNCTION_MAP_JSON:-}" ]] || {
    echo "CINDER_FUNCTION_MAP_JSON must contain all 11 exact deployed Cinder function names" >&2
    exit 1
  }
  CINDER_FUNCTION_MAP="$CINDER_FUNCTION_MAP_JSON" node --input-type=module -e \
    'const { parseFunctionMap } = await import("./index.mjs"); parseFunctionMap();'
}

require_site_distribution() {
  [[ -n "${CINDER_SITE_DISTRIBUTION_ID:-}" ]] || {
    echo "CINDER_SITE_DISTRIBUTION_ID must name Cinder's public CloudFront distribution" >&2
    exit 1
  }
  CINDER_SITE_DISTRIBUTION_ID="$CINDER_SITE_DISTRIBUTION_ID" node --input-type=module -e \
    'const { parseSiteDistributionId } = await import("./index.mjs"); parseSiteDistributionId();'
}

ensure_role() {
  if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
    aws iam create-role \
      --role-name "$ROLE" \
      --assume-role-policy-document file://infra/lambda-trust.json >/dev/null
    sleep 8
  fi

  local attached inline unexpected
  attached=$(aws iam list-attached-role-policies --role-name "$ROLE" --query 'length(AttachedPolicies)' --output text)
  [[ "$attached" == "0" ]] || {
    echo "refusing deployment: the stats role has a managed policy attached" >&2
    exit 1
  }
  inline=$(aws iam list-role-policies --role-name "$ROLE" --query 'PolicyNames' --output text)
  unexpected=$(tr '\t' '\n' <<<"$inline" | grep -v -E "^$|^${POLICY_NAME}$" || true)
  [[ -z "$unexpected" ]] || {
    echo "refusing deployment: the stats role has an unexpected inline policy" >&2
    exit 1
  }
  aws iam put-role-policy \
    --role-name "$ROLE" \
    --policy-name "$POLICY_NAME" \
    --policy-document file://infra/stats-policy.json
}

bundle() {
  npm ci --omit=dev >/dev/null
  cp index.mjs package.json package-lock.json "$SCRATCH/"
  cp -R site "$SCRATCH/site"
  cp -R node_modules "$SCRATCH/node_modules"
  (cd "$SCRATCH" && zip -qr function.zip index.mjs package.json package-lock.json site node_modules)
}

ensure_lambda() {
  local role_arn
  role_arn=$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text)
  jq -n \
    --arg surface "$SURFACE_SECRET_ID" \
    --arg shared "$SHARED_SECRET_ID" \
    --arg navigation "$NAVIGATION_SECRET_ID" \
    --arg audience "$DOMAIN" \
    --arg function_map "$CINDER_FUNCTION_MAP_JSON" \
    --arg site_distribution "$CINDER_SITE_DISTRIBUTION_ID" \
    '{Variables:{STATS_SECRET_ID:$surface,STATS_SHARED_SECRET_ID:$shared,STATS_NAVIGATION_SECRET_ID:$navigation,STATS_AUDIENCE:$audience,CINDER_FUNCTION_MAP:$function_map,CINDER_SITE_DISTRIBUTION_ID:$site_distribution}}' \
    >"$SCRATCH/environment.json"

  if aws lambda get-function --function-name "$FUNCTION" >/dev/null 2>&1; then
    aws lambda update-function-configuration \
      --function-name "$FUNCTION" \
      --environment "file://${SCRATCH}/environment.json" \
      --timeout 20 \
      --memory-size 256 >/dev/null
    aws lambda wait function-updated --function-name "$FUNCTION"
    aws lambda update-function-code \
      --function-name "$FUNCTION" \
      --zip-file "fileb://${SCRATCH}/function.zip" >/dev/null
  else
    aws lambda create-function \
      --function-name "$FUNCTION" \
      --runtime nodejs22.x \
      --handler index.handler \
      --role "$role_arn" \
      --zip-file "fileb://${SCRATCH}/function.zip" \
      --environment "file://${SCRATCH}/environment.json" \
      --timeout 20 \
      --memory-size 256 >/dev/null
  fi
  aws lambda wait function-updated --function-name "$FUNCTION"
}

ensure_api() {
  local api_id function_arn integration_id
  api_id=$(aws apigatewayv2 get-apis \
    --query "Items[?Name=='${API_NAME}'].ApiId | [0]" --output text)
  if [[ -z "$api_id" || "$api_id" == "None" ]]; then
    api_id=$(aws apigatewayv2 create-api \
      --name "$API_NAME" \
      --protocol-type HTTP \
      --query ApiId --output text)
  fi
  function_arn=$(aws lambda get-function --function-name "$FUNCTION" --query Configuration.FunctionArn --output text)
  integration_id=$(aws apigatewayv2 get-integrations --api-id "$api_id" \
    --query "Items[?IntegrationUri=='${function_arn}'].IntegrationId | [0]" --output text)
  if [[ -z "$integration_id" || "$integration_id" == "None" ]]; then
    integration_id=$(aws apigatewayv2 create-integration \
      --api-id "$api_id" \
      --integration-type AWS_PROXY \
      --integration-uri "$function_arn" \
      --payload-format-version 2.0 \
      --query IntegrationId --output text)
  fi
  if ! aws apigatewayv2 get-routes --api-id "$api_id" \
    --query "Items[?RouteKey=='${DEFAULT_STAGE}'].RouteId | [0]" --output text | grep -qv None; then
    aws apigatewayv2 create-route \
      --api-id "$api_id" \
      --route-key "$DEFAULT_STAGE" \
      --target "integrations/${integration_id}" >/dev/null
  fi
  if ! aws apigatewayv2 get-stages --api-id "$api_id" \
    --query "Items[?StageName=='${DEFAULT_STAGE}'].StageName | [0]" --output text | grep -qv None; then
    aws apigatewayv2 create-stage --api-id "$api_id" --stage-name "$DEFAULT_STAGE" --auto-deploy >/dev/null
  fi
  aws apigatewayv2 update-stage \
    --api-id "$api_id" \
    --stage-name "$DEFAULT_STAGE" \
    --default-route-settings ThrottlingBurstLimit=10,ThrottlingRateLimit=5 >/dev/null
  aws lambda add-permission \
    --function-name "$FUNCTION" \
    --statement-id AllowCinderStatsApi \
    --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT}:${api_id}/*" >/dev/null 2>&1 || true
  printf '%s' "$api_id"
}

certificate() {
  local arn validation
  arn=$(aws acm list-certificates --region "$REGION" \
    --query "CertificateSummaryList[?DomainName=='${DOMAIN}'].CertificateArn | [0]" --output text)
  if [[ -z "$arn" || "$arn" == "None" ]]; then
    arn=$(aws acm request-certificate --region "$REGION" \
      --domain-name "$DOMAIN" \
      --validation-method DNS \
      --query CertificateArn --output text)
  fi
  for _ in {1..30}; do
    validation=$(aws acm describe-certificate --region "$REGION" --certificate-arn "$arn" \
      --query 'Certificate.DomainValidationOptions[0].ResourceRecord.Name' --output text)
    [[ "$validation" != "None" ]] && break
    sleep 2
  done
  [[ "$validation" != "None" ]] || { echo "certificate validation record unavailable" >&2; exit 1; }
  printf '%s' "$arn"
}

route53_upsert() {
  local name="$1" type="$2" value="$3" zone="$4"
  local batch="$SCRATCH/change-${type}.json"
  if [[ "$type" == "CNAME" ]]; then
    jq -n --arg name "$name" --arg value "$value" \
      '{Changes:[{Action:"UPSERT",ResourceRecordSet:{Name:$name,Type:"CNAME",TTL:300,ResourceRecords:[{Value:$value}]}}]}' >"$batch"
  else
    jq -n --arg name "$name" --arg type "$type" --arg value "$value" --arg zone "$zone" \
      '{Changes:[{Action:"UPSERT",ResourceRecordSet:{Name:$name,Type:$type,AliasTarget:{DNSName:$value,HostedZoneId:$zone,EvaluateTargetHealth:false}}}]}' >"$batch"
  fi
  aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" --change-batch "file://${batch}" >/dev/null
}

ensure_domain() {
  local api_id="$1" certificate_arn="$2" validation_name validation_value
  local target target_zone
  aws route53 list-resource-record-sets --hosted-zone-id "$ZONE_ID" >"$SCRATCH/records-before.json"

  validation_name=$(aws acm describe-certificate --region "$REGION" --certificate-arn "$certificate_arn" \
    --query 'Certificate.DomainValidationOptions[0].ResourceRecord.Name' --output text)
  validation_value=$(aws acm describe-certificate --region "$REGION" --certificate-arn "$certificate_arn" \
    --query 'Certificate.DomainValidationOptions[0].ResourceRecord.Value' --output text)
  route53_upsert "$validation_name" CNAME "$validation_value" ""
  aws acm wait certificate-validated --region "$REGION" --certificate-arn "$certificate_arn"

  npm ci --omit=dev >/dev/null
  node ensure-dualstack.mjs "$api_id" "$DOMAIN" "$certificate_arn" "$REGION"
  if ! aws apigatewayv2 get-api-mappings --domain-name "$DOMAIN" \
    --query "Items[?ApiId=='${api_id}'].ApiMappingId | [0]" --output text | grep -qv None; then
    aws apigatewayv2 create-api-mapping --domain-name "$DOMAIN" --api-id "$api_id" --stage "$DEFAULT_STAGE" >/dev/null
  fi

  target=$(aws apigatewayv2 get-domain-name --domain-name "$DOMAIN" --query DomainNameConfigurations[0].ApiGatewayDomainName --output text)
  target_zone=$(aws apigatewayv2 get-domain-name --domain-name "$DOMAIN" --query DomainNameConfigurations[0].HostedZoneId --output text)
  route53_upsert "$DOMAIN" A "$target" "$target_zone"
  route53_upsert "$DOMAIN" AAAA "$target" "$target_zone"

  aws route53 list-resource-record-sets --hosted-zone-id "$ZONE_ID" >"$SCRATCH/records-after.json"
  node guard-records.mjs "$SCRATCH/records-before.json" "$SCRATCH/records-after.json" \
    "${validation_name}" "${DOMAIN}."
}

verify_origin() {
  local api_id="$1" origin route status
  origin=$(aws apigatewayv2 get-api --api-id "$api_id" --query ApiEndpoint --output text)
  for route in /api/metrics /api/navigation; do
    status=$(curl -sS -o /dev/null --max-time 15 -w '%{http_code}' "${origin}${route}")
    [[ "$status" == "401" ]] || { echo "anonymous origin gate failed for ${route}: ${status}" >&2; exit 1; }
  done
  status=$(curl -sS -o /dev/null --max-time 15 -w '%{http_code}' \
    -H 'content-type: application/json' -d '{}' "${origin}/api/auth")
  [[ "$status" == "401" ]] || { echo "invalid auth proof failed: ${status}" >&2; exit 1; }
  status=$(curl -sS -o /dev/null --max-time 15 -w '%{http_code}' "${origin}/")
  [[ "$status" == "200" ]] || { echo "public arrival proof failed: ${status}" >&2; exit 1; }
  printf '✓ direct origin gate proved: public arrival 200, protected routes 401\n'
}

# Publishing the shared navigation registry rides along with this surface's
# deploy, which is what has always happened and stays the default. The two are
# not the same artifact, though: the registry is compiled from owner-only files
# under ~/.agents and is shared by all six readers, while everything else here
# is Cinder's own code. Coupling them makes an ORDERED rollout inexpressible --
# there is no way to ship a client fix without also publishing whatever the
# registry currently says, and no way to review the registry from inside this
# repo. STATS_SKIP_NAVIGATION_DEPLOY=1 separates them.
#
# An unrecognized value is a hard failure, never a silent deploy: a typo like
# `STATS_SKIP_NAVIGATION_DEPLOY=true` must not quietly publish the registry
# while its author believes it was held back.
deploy_navigation_registry() {
  case "${STATS_SKIP_NAVIGATION_DEPLOY:-0}" in
    0) python3 ~/.agents/scripts/stats-navigation.py deploy ;;
    1) printf '  ↷ navigation registry held back (STATS_SKIP_NAVIGATION_DEPLOY=1)\n' ;;
    *)
      echo "STATS_SKIP_NAVIGATION_DEPLOY must be 0 or 1, got: ${STATS_SKIP_NAVIGATION_DEPLOY}" >&2
      exit 1
      ;;
  esac
}

deploy_origin() {
  require_function_map
  require_site_distribution

  say "audience-bound authentication"
  python3 provision-auth.py
  deploy_navigation_registry

  say "aggregate-only runtime"
  ensure_role
  bundle
  ensure_lambda

  say "direct origin"
  local api_id
  api_id=$(ensure_api)
  verify_origin "$api_id"
}

deploy_domain() {
  say "custom TLS domain"
  local api_id certificate_arn
  api_id=$(aws apigatewayv2 get-apis \
    --query "Items[?Name=='${API_NAME}'].ApiId | [0]" --output text)
  [[ -n "$api_id" && "$api_id" != "None" ]] || { echo "Cinder stats origin is not deployed" >&2; exit 1; }
  certificate_arn=$(certificate)
  ensure_domain "$api_id" "$certificate_arn"

  printf '✓ https://%s deployed through an audience-authenticated HTTP API\n' "$DOMAIN"
}

case "${1:-all}" in
  origin) deploy_origin ;;
  domain) deploy_domain ;;
  all) deploy_origin; deploy_domain ;;
  *) echo "usage: ./deploy-stats.sh [origin|domain|all]" >&2; exit 1 ;;
esac
