# Local development

This guide gets Cinder running end-to-end on your machine — real encryption, real note creation, real burn — with no AWS account and no Docker.

## Prerequisites

| Tool | Version | Used for |
| --- | --- | --- |
| [Node.js](https://nodejs.org) | 22+ | The app and the API |
| [pnpm](https://pnpm.io) | 11+ | Package management |
| [Java](https://adoptium.net) | 17+ | Running DynamoDB Local (a standalone jar) |

> **Note:** DynamoDB Local runs as a plain Java process, so you do not need Docker. The download happens automatically the first time you run the script.

## Front end only

If you just want to see the UI (note creation will fail without the API, but the pages render):

```bash
pnpm install
pnpm dev
```

The app is at `http://localhost:5173`.

## Full stack

To exercise the whole flow — create a note, get a link, reveal it, watch it burn — you need three processes: DynamoDB Local, the dev API, and the front end.

### 1. Start DynamoDB Local

```bash
./scripts/dynamodb-local.sh
```

This downloads DynamoDB Local (first run only) and serves it on port 8000, in-memory.

### 2. Start the dev API

In a second terminal:

```bash
node scripts/dev-api.mjs
```

This mounts the real Lambda handlers behind a small HTTP server on port 4000, backed by DynamoDB Local. It is the same handler code that runs in production — only the transport and the database endpoint differ. It creates the `blip-notes` table automatically if it does not exist.

### 3. Start the front end, pointed at the dev API

In a third terminal:

```bash
VITE_API_BASE=http://localhost:4000 pnpm dev --port 5173
```

Open `http://localhost:5173`, write a note, copy the link, open it in a new tab, and reveal it. Open it again — it is gone.

## Complete local review

One command starts DynamoDB Local, the transfer API, the local identity API, and the web app:

```bash
pnpm review:local
```

Open `http://127.0.0.1:5190/#video=on`. Cinder captures that hidden fragment into this tab's session and removes it from the address bar immediately. Video remains available in that tab, while ordinary sessions continue to show only Note and File.

Use the normal sign-up or sign-in journey. This review command starts the local identity server with an explicit development-only entitlement bypass, so a verified local identity can mint real capability grants without a Stripe purchase and without manufacturing or spending credits. The identity server prints a loud warning while the bypass is active. The production Lambda has no environment switch or code path that enables it.

Press Ctrl-C once to stop every process the command started. The command refuses to start when one of its review ports is already occupied, so it never kills or shadows another local stack.

## Accounts, payment, and Cinder Pro, locally

Sending a large file needs a capability grant, and a grant needs an account and a purchase. `scripts/dev-identity.mjs` stands the whole of that up on port 4100 without an AWS account and without a Stripe key.

```bash
node scripts/dev-identity.mjs
```

It mounts the **real** identity and purchase handlers and replaces exactly two things, both of them services we do not own:

| Replaced | With | What stays real |
| --- | --- | --- |
| Cognito | A locally generated RSA key that publishes a real JWKS and signs real RS256 ID tokens | `verifyIdToken` is unmodified — signature, issuer, audience, `token_use`, and expiry are all genuinely checked |
| Stripe | A local URL instead of a hosted checkout page | The `checkout.session.completed` event is real-shaped and signed with a real HMAC under a real `whsec_` secret; the shipped webhook verifies it |

Nothing of Cinder's own logic is stubbed. The capability grant the mint issues is verified by `api/src/entitlement-provider.mjs` — the same gate `lambda.mjs` wires in production.

The two dev servers share `CAPABILITY_SECRET`, and both default to the same literal, so running them plainly just works. If you set it on one, set it on both: a mismatch means the mint signs grants the transfer API refuses, which looks exactly like a broken product.

Point the front end at both:

```bash
VITE_API_BASE=http://127.0.0.1:4000 \
VITE_IDENTITY_API_BASE=http://127.0.0.1:4100 \
VITE_IDENTITY_HOSTED_UI=http://127.0.0.1:4100 \
VITE_IDENTITY_CLIENT_ID=dev-cinder-client \
pnpm dev --port 5179 --host 127.0.0.1
```

Every `/oauth2/authorize` allocates a brand-new account, so each sign-in starts from someone who has never paid.

## Running the tests

Cinder has 221 tests across four layers.

| Command | Layer | Needs DynamoDB Local? |
| --- | --- | --- |
| `pnpm vitest run` | Unit (crypto, codec, links) | No |
| `node --test 'api/test/*.test.mjs'` | API (store, handlers, identity, purchase, capability) | Yes |
| `pnpm exec playwright test --project=e2e` | End-to-end (real browser) | Yes (plus the dev API) |
| `pnpm exec playwright test --project=journey` | The full chain: sign in, pay, mint, send 9 MiB, receive, burn | Yes (plus the dev API **and** the dev identity API) |

> **Note:** The unit tests use Node's global Web Crypto, so they run without any services. Everything else needs DynamoDB Local running on port 8000 first.

Playwright starts the front ends for you — two of them, on 5178 and 5179, because they are configured differently and the difference is the point. The `e2e` server carries a dev capability grant so the transport can be exercised with no identity server at all; the `journey` server carries none, so every capability it gets is minted and verified for real. A dev grant on the journey server would let the whole chain succeed while unpaid, which is precisely the failure that suite exists to catch.

## Project layout

| Path | What lives there |
| --- | --- |
| `src/routes/` | The three pages: create (`+page.svelte`), reader (`n/[id]/`), security |
| `src/lib/crypto/` | Encryption core and the base64 codec |
| `src/lib/` | API client, link helpers, UI components |
| `api/src/` | Lambda handlers, DynamoDB store, ID generation |
| `api/test/` | Store and handler tests (Node's built-in test runner) |
| `scripts/` | DynamoDB Local runner, dev API, front-end deploy |
| `template.yaml` | The entire AWS stack |
| `docs/` | These documents |

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| API tests fail to connect | DynamoDB Local not running | Run `./scripts/dynamodb-local.sh` first |
| Note creation fails in the browser | `VITE_API_BASE` not set, or dev API down | Restart the front end with `VITE_API_BASE=http://localhost:4000` |
| "java: command not found" | No JDK | Install a JDK 17+ from [Adoptium](https://adoptium.net) |
| Port 8000, 4000, or 4100 in use | A previous run is still alive | Kill the old process, or change the port |
| A paid send still gets 402 | `CAPABILITY_SECRET` differs between the two dev servers | Unset it on both and let them use their shared default |
| Sign-in does nothing | The front end has no `VITE_IDENTITY_*` values | Restart it with the four variables above |

## Related documents

- [Architecture](architecture.md) — how the local pieces mirror production
- [Deployment](deployment.md) — taking it to AWS
