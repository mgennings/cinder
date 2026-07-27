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

## Running the tests

Cinder has 113 tests across three layers.

| Command | Layer | Needs DynamoDB Local? |
| --- | --- | --- |
| `pnpm vitest run` | Unit (crypto, codec, links) | No |
| `cd api && node --test test/*.mjs` | API (store + handlers) | Yes |
| `pnpm exec playwright test` | End-to-end (real browser) | Yes (plus the dev API) |

> **Note:** The unit tests use Node's global Web Crypto, so they run without any services. The API and e2e tests need DynamoDB Local running on port 8000 first.

For the e2e tests, the Playwright config starts the front end for you; you only need DynamoDB Local and the dev API already running.

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
| Port 8000 or 4000 in use | A previous run is still alive | Kill the old process, or change the port |

## Related documents

- [Architecture](architecture.md) — how the local pieces mirror production
- [Deployment](deployment.md) — taking it to AWS
