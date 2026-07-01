# blip — memory index

Read this on every run.

| File | When to load |
| --- | --- |
| `../docs/superpowers/specs/2026-07-01-blip-design.md` | The approved design spec. |
| `../docs/superpowers/plans/2026-07-01-blip.md` | The implementation plan (Tasks 0–9). |
| `TIMELINE.md` | What happened when, and what's next. |

## One-liner
blip: zero-knowledge self-destructing note app. SvelteKit static (S3+CloudFront) + AWS SAM (API Gateway + 2 Lambdas + DynamoDB). Burn = atomic DynamoDB DeleteItem w/ ConditionExpression + ReturnValues ALL_OLD. Key lives only in URL fragment. Two-factor passphrase mode (PBKDF2 600k). Android/TWA is a documented fast-follow, not v1.

## Local dev / test
- `./scripts/dynamodb-local.sh` — DynamoDB Local on :8000 (standalone jar, no Docker).
- `node scripts/dev-api.mjs` — real handlers over HTTP on :4000, backed by DDB local.
- `pnpm vitest run` — unit (codec, crypto, link).
- `cd api && node --test test/*.mjs` — store + handler tests (needs DDB local).
- `VITE_API_BASE=http://localhost:4000 pnpm exec playwright test` — e2e (needs DDB local + dev-api).
- `sam validate --lint` / `sam build` — infra. Deploy: `sam deploy` (backend), then `scripts/deploy-frontend.sh`.

## Status
Tasks 0–9 built, 25 tests green. Next: live AWS deploy.
