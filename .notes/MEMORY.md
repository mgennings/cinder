# blip — memory index

Read this on every run.

| File | When to load |
| --- | --- |
| `../docs/superpowers/specs/2026-07-01-blip-design.md` | The approved design spec. Load before any implementation. |

## One-liner
blip: zero-knowledge self-destructing note app. SvelteKit static (S3+CloudFront) + AWS SAM (API Gateway + 2 Lambdas + DynamoDB). Burn = atomic DynamoDB DeleteItem w/ ConditionExpression + ReturnValues ALL_OLD. Key lives only in URL fragment. Two-factor passphrase mode (PBKDF2 600k). Android/TWA is a documented fast-follow, not v1.
