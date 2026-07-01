# Architecture

This document explains how Cinder is put together — every component, how a note flows through the system, and why each significant decision was made. If you want the encryption specifics, see [Crypto](crypto.md). If you want to run or deploy it, see [Local development](local-development.md) and [Deployment](deployment.md).

## Overview

Cinder is a static single-page app backed by a small serverless API. There is deliberately very little to it — a privacy tool earns trust by being small enough to reason about.

The one idea that makes everything else work: **encryption happens in the browser, and the key lives only in the URL fragment.** The server stores ciphertext it cannot decrypt, so "the server can't read your note" is a property of the design, not a promise.

```
┌─ Browser (SvelteKit SPA) ─────────────┐        ┌─ AWS (SAM stack) ──────────────────┐
│                                        │        │                                    │
│  create page   ──encrypt──►  ciphertext├───────►│  API Gateway ──► createNote Lambda │
│  reader page   ──decrypt──◄  ciphertext│◄───────┤  API Gateway ──► readNote Lambda   │
│                                        │        │                        │           │
│  key stays in the URL fragment (#…)    │        │                        ▼           │
│  and never crosses this line ──────────┼────────┤                   DynamoDB         │
│                                        │        │                  (ciphertext only) │
│  static assets  ◄──────────────────────┼────────┤  CloudFront ──► S3                 │
└────────────────────────────────────────┘        └────────────────────────────────────┘
```

## Components

Each component has one job. The table is the fastest way to see the whole system; the sections below add the detail.

| Component | Responsibility | Source |
| --- | --- | --- |
| Create page | Encrypt a note, request a note ID, build the shareable link | `src/routes/+page.svelte` |
| Reader page | Human-gated reveal: burn the note, then decrypt it | `src/routes/n/[id]/+page.svelte` |
| Crypto core | AES-256-GCM encrypt/decrypt, two-factor passphrase derivation | `src/lib/crypto/note-crypto.ts` |
| Codec | base64 / base64url conversion with a fallback for older browsers | `src/lib/crypto/codec.ts` |
| API client | Talk to the two endpoints; map wire names to crypto names | `src/lib/api.ts` |
| Link helpers | Build `/n/{id}#{key}` links; parse the fragment | `src/lib/link.ts` |
| createNote Lambda | Validate, clamp TTL, store ciphertext, return an ID | `api/src/handlers.mjs` |
| readNote Lambda | Atomically burn the note and return it, or 410 | `api/src/handlers.mjs` |
| Store | The DynamoDB operations, isolated for testing | `api/src/store.mjs` |
| Infrastructure | The whole AWS stack as one template | `template.yaml` |

### Front end (SvelteKit, static)

The app is built with `@sveltejs/adapter-static` and ships as plain HTML, CSS, and JavaScript to S3. There is no server-side rendering for the note routes — they are client-only, because all the interesting work (encryption, decryption, reading the fragment) can only happen in the browser.

Dynamic note URLs like `/n/abc123` are handled by the SPA fallback: CloudFront serves the app shell (`200.html`) for any unresolved path, and the client-side router figures out the note ID. This is why no per-note page is prerendered — the server never needs to know a note ID exists.

The landing and security pages are the exception: they carry no secrets, so they are prerendered and indexable for speed and discoverability.

### API (two Lambdas behind API Gateway)

The API is intentionally two endpoints and nothing more:

- `POST /notes` → `createNote` — stores a ciphertext blob, returns an ID.
- `POST /notes/{id}/burn` → `readNote` — atomically deletes and returns the note.

Both are AWS Lambda functions (Node.js 22, ARM64) fronted by an API Gateway HTTP API. The handlers take the DynamoDB client as an argument (`makeHandlers(doc)`), which is what lets the tests run them against a local DynamoDB with no mocking. See [the API reference](api.md) for exact request and response shapes.

### Storage (DynamoDB)

One table, `blip-notes`, with a single partition key `pk` (the note ID). Each item is `{ pk, ciphertext, iv, salt?, expiresAt }`. Time-to-live is enabled on `expiresAt` so expired notes are eventually reaped automatically.

The reason DynamoDB was chosen over anything else is covered in [design decisions](#design-decisions) — in short, its conditional `DeleteItem` *is* the atomic burn, so the hardest correctness requirement in the whole app becomes a single API call.

## Request lifecycle

### Creating a note

1. You type a note. If you add a passphrase, the create page turns on two-factor mode.
2. The browser generates a random AES-256 key and a random IV, then encrypts the note. In two-factor mode, a passphrase-derived key is mixed into the random key first.
3. The browser sends `{ ciphertext, iv, salt?, ttlSeconds }` to `POST /notes`. **The key is never in this request.**
4. `createNote` validates the payload, clamps the TTL to a maximum, generates a random ID, and stores the item.
5. The browser receives the ID and assembles the link: `https://blip.uxuiai.org/n/{id}#{key}`. The key is appended as the fragment — the part browsers keep local.

### Reading (and burning) a note

1. You open a note link. The reader page reads the fragment (the key) but **fetches nothing yet**. This is deliberate — see [bot defense](#bot-defense).
2. You click "Reveal." Only now does the browser call `POST /notes/{id}/burn`.
3. `readNote` runs a single conditional `DeleteItem`: delete the item *if it still exists and has not expired*, and return what was deleted.
   - If it succeeds, the note is gone and its ciphertext comes back in the same response.
   - If the condition fails (already read, or expired), the API returns `410 Gone`.
4. The browser decrypts the returned ciphertext with the key from the fragment and shows the note. In two-factor mode, it asks for the passphrase first.

## Bot defense

Messaging apps (iMessage, Slack, WhatsApp, Signal) fetch links to render preview cards. With a naive "burn on fetch" design, that preview bot becomes the first reader and the note is destroyed before the human ever clicks. Cinder defends against this in two layers:

1. **No auto-fetch.** Opening a note link fetches nothing. A human must click "Reveal" to trigger the burn.
2. **Burn is POST-only.** Preview bots issue GET requests, which the burn endpoint does not answer.

## Design decisions

The interesting choices, and why they went the way they did.

### Why the key goes in the URL fragment

The fragment (`#…`) is the only part of a URL that browsers never transmit to a server — not in the request line, not in headers. Putting the key there means the key reaches the recipient's browser (they have the whole link) but never reaches Cinder's servers. This is the mechanism behind the zero-knowledge claim, and it is the same technique PrivateBin and other credible tools use.

### Why DynamoDB, specifically

The core requirement — "exactly one reader, ever" — is a concurrency problem. Two people (or a person and a retrying network) could hit the burn endpoint at the same moment. DynamoDB's conditional `DeleteItem` with `ReturnValues: ALL_OLD` solves this in a single, strongly-consistent, atomic operation: the delete either happens (and returns the item) or fails the condition. Exactly one caller can win. No locks, no transactions, no read-then-delete race window. A SQL database or an object store would have required extra machinery to get the same guarantee.

### Why TTL is a backstop, not the burn

DynamoDB TTL deletion is best-effort — items are removed within roughly two days of expiry, not instantly, and *expired-but-unreaped items are still returned by reads*. So TTL alone would occasionally serve an expired note. The real expiry enforcement is a guard inside the burn condition (`expiresAt > :now`); TTL just keeps the table clean over time.

### Why serverless

A self-destructing-note service is bursty and low-volume for personal use. Serverless means there is no server running (and costing money) when nobody is sending notes, and it scales to any burst without capacity planning. The whole thing sits inside the AWS free tier at realistic volumes.

### Why so little code

For a privacy tool, every line shipped to the browser is a line a security-conscious user has to trust. SvelteKit compiles its own framework away, Cinder uses the browser's native Web Crypto rather than a third-party crypto library, and the API is two small functions. Less code is less attack surface and less to audit — that minimalism is a feature, not a shortcut.

## Related documents

- [Crypto](crypto.md) — the exact encryption scheme and parameters
- [Security & threat model](security.md) — what this protects, and what it cannot
- [API reference](api.md) — endpoint contracts
- [Deployment](deployment.md) — how the AWS stack is provisioned
