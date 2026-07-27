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
│                                        │        │            (ciphertext + grants)   │
│  file create   ──encrypt──►  ciphertext├───────►│  presigned PUT ─┐                  │
│  file reader   ──decrypt──◄  ciphertext│◄───────┤  claimFile ────►│  private S3      │
│                                        │        │   (claim, delete, verify, return)  │
│  static assets  ◄──────────────────────┼────────┤  CloudFront ──► S3 (site)          │
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
| API client | Talk to the five endpoints; map wire names to crypto names | `src/lib/api.ts` |
| Link helpers | Build `/n/{id}#{key}` links; parse the fragment | `src/lib/link.ts` |
| createNote Lambda | Validate, clamp TTL, store ciphertext, return an ID | `api/src/handlers.mjs` |
| readNote Lambda | Atomically burn the note and return it, or 410 | `api/src/handlers.mjs` |
| File crypto | Encrypt one file plus its name and type into one envelope | `src/lib/crypto/file-crypto.ts` |
| createFile Lambda | Reserve a transfer, issue a constrained one-use upload | `api/src/handlers.mjs` |
| finalizeFile Lambda | Inspect the stored object itself, then mark it ready | `api/src/handlers.mjs` |
| claimFile Lambda | The one delivery attempt: claim, delete, verify, return | `api/src/handlers.mjs` |
| S3 port | Five narrow verbs, so each role's IAM policy stays legible | `api/src/lambda.mjs` |
| S3 error reading | The two opposite readings of "is this object there?" | `api/src/s3-errors.mjs` |
| Store | The DynamoDB operations, isolated for testing | `api/src/store.mjs` |
| Infrastructure | The whole AWS stack as one template | `template.yaml` |

### Front end (SvelteKit, static)

The app is built with `@sveltejs/adapter-static` and ships as plain HTML, CSS, and JavaScript to S3. There is no server-side rendering for the note routes — they are client-only, because all the interesting work (encryption, decryption, reading the fragment) can only happen in the browser.

Dynamic note URLs like `/n/abc123` are handled by the SPA fallback: CloudFront serves the app shell (`200.html`) for any unresolved path, and the client-side router figures out the note ID. This is why no per-note page is prerendered — the server never needs to know a note ID exists.

The landing and security pages are the exception: they carry no secrets, so they are prerendered and indexable for speed and discoverability.

### API (five Lambdas behind API Gateway)

The API is intentionally five endpoints and nothing more:

- `POST /notes` → `createNote` — stores a ciphertext blob, returns an ID.
- `POST /notes/{id}/burn` → `readNote` — atomically deletes and returns the note.
- `POST /files` → `createFile` — reserves a transfer, issues a constrained one-use upload.
- `POST /files/finalize` → `finalizeFile` — inspects the stored object, then marks it ready.
- `POST /files/claim` → `claimFile` — the one delivery attempt.

All five are AWS Lambda functions (Node.js 22, ARM64) fronted by an API Gateway HTTP API. The handlers take the DynamoDB client as an argument (`makeHandlers(doc)`), which is what lets the tests run them against a local DynamoDB with no mocking. See [the API reference](api.md) for exact request and response shapes.

### Storage (DynamoDB)

One table, `blip-notes`, with a single partition key `pk`. A note item is keyed by the note ID and holds `{ pk, ciphertext, iv, salt?, expiresAt }`. A file grant shares the table under `sha256(locator)` and holds `{ pk, kind, state, objectKey, uploadCapabilityHash, ciphertextBytes, ciphertextSha256, createdAt, expiresAt }` — hashes only, never a raw capability. Time-to-live is enabled on `expiresAt` so expired notes are eventually reaped automatically.

The reason DynamoDB was chosen over anything else is covered in [design decisions](#design-decisions) — in short, its conditional `DeleteItem` *is* the atomic burn, so the hardest correctness requirement in the whole app becomes a single API call.

## Request lifecycle

### Creating a note

1. You type a note. If you add a passphrase, the create page turns on two-factor mode.
2. The browser generates a random AES-256 key and a random IV, then encrypts the note. In two-factor mode, a passphrase-derived key is mixed into the random key first.
3. The browser sends `{ ciphertext, iv, salt?, ttlSeconds }` to `POST /notes`. **The key is never in this request.**
4. `createNote` validates the payload, clamps the TTL to a maximum, generates a random ID, and stores the item.
5. The browser receives the ID and assembles the link: `https://cinder.ink/n/{id}#{key}`. The key is appended as the fragment — the part browsers keep local.

### Reading (and burning) a note

1. You open a note link. The reader page reads the fragment (the key) but **fetches nothing yet**. This is deliberate — see [bot defense](#bot-defense).
2. You click "Reveal." Only now does the browser call `POST /notes/{id}/burn`.
3. `readNote` runs a single conditional `DeleteItem`: delete the item *if it still exists and has not expired*, and return what was deleted.
   - If it succeeds, the note is gone and its ciphertext comes back in the same response.
   - If the condition fails (already read, or expired), the API returns `410 Gone`.
4. The browser decrypts the returned ciphertext with the key from the fragment and shows the note. In two-factor mode, it asks for the passphrase first.

## File transfer

A file link makes one promise, and it is narrower than it first sounds: **exactly one server delivery attempt.** Not one recipient, not one successful download. Cinder controls its own stored copy and the single moment it hands that copy over, and it does not control networks, browsers, or what anyone does with the bytes afterward.

Files use their own route (`/f/{locator}#{key}`) because the reader page has to know which protocol to speak before it fetches anything. Asking the server "is this a note or a file?" would be a request on link arrival, which is exactly what the preview-bot defense forbids.

### Creating a transfer

1. The browser encrypts the file, its name, and its MIME type into one AES-256-GCM envelope. Name and type live *inside* the encrypted region, not beside it — "severance-agreement.pdf" is often the whole story, and authenticating a filename while leaving it readable would protect the wrong half.
2. `POST /files` reserves the transfer. The server generates three independent secrets: a **locator** (what the link carries), an **upload capability** (which never leaves the sender), and a random **object key**. DynamoDB stores only `sha256(locator)` and `sha256(uploadCapability)`, so a dump of the table cannot be replayed against the API.
3. The response carries a presigned `PUT` signed against that exact key, byte length, and checksum, valid for five minutes. S3 itself refuses a substituted, resized, or corrupted body.
4. The browser uploads ciphertext straight to the private bucket. It never passes through a Lambda.
5. `POST /files/finalize` is where the server stops trusting the client. It asks S3 what it actually holds and compares size and checksum against what it authorized, then flips `uploading → ready` in a single conditional write. A client that uploads nothing and calls finalize gets the same refusal as a client that uploads the wrong thing.

Finalize asks for `GetObjectAttributes` — size and checksum rather than the body. Worth being precise about what that does and does not buy: AWS requires `s3:GetObject` alongside `s3:GetObjectAttributes`, so the finalize role *can* read a stored object, and no S3 permission set can express "metadata but never the body." What the split does achieve is that finalize holds no `s3:DeleteObject` and no `s3:ListBucket`: it cannot destroy anything, and it cannot discover a key it was not handed.

### The one delivery attempt

Opening a file link fetches nothing. Only the explicit reveal starts the destructive path, and that path runs in exactly this order:

1. **Claim.** A conditional `DeleteItem` on the grant, returning what it deleted. Exactly one concurrent caller wins; the grant is now gone.
2. **Open.** Read the ciphertext from the private bucket.
3. **Delete.** Remove the S3 object.
4. **Verify absence.** `HeadObject` must report 404. S3 has been strongly read-after-write consistent for deletes since 2020, so this is a real answer and not a race we hope to win.
5. **Only then** does a response body exist.

Every failure after step 1 is permanent, and that is the design rather than a gap in it. The grant is already deleted and is never restored: a crash, a timeout, an S3 failure, a disconnect at byte zero, or a disconnect midstream all consume the transfer. `api/test/handlers.test.mjs` breaks each of those seams in turn and asserts the same two things every time — no response byte ever existed, and a later attempt still gets 410.

Losers of the race, expired grants, malformed locators, and links that never existed all receive a byte-identical `410`. Distinguishing them would turn the endpoint into an oracle that confirms a link once existed.

### Why the delete-before-delivery guarantee actually holds

The interesting claim here is "no byte leaves before the deletion is verified," and it deserves more than a promise that the code is written in the right order. It holds because of the shape of the transport, which was verified against the deployed stack rather than assumed:

| Property | Measured value | Why it matters |
| --- | --- | --- |
| Integration type | `AWS_PROXY`, payload format 2.0 | Fully buffered. The handler returns a complete response object; API Gateway cannot send a byte of a response it has not yet received. |
| Lambda Function URLs | None on any function in the stack | Response streaming is only reachable through a Function URL or a direct streaming invoke. Neither exists, so there is no code path that *could* flush early. |
| CloudFront in the API path | None — the distribution's only origin is the site bucket | No CDN buffering, caching, or reordering sits between the claim Lambda and the recipient. |
| API Gateway integration timeout | 30,000 ms | Comfortably above the claim function's own 15 s ceiling, so the Lambda's timeout is what governs. |
| Response payload ceiling | 6 MB (AWS hard limit, base64 on the wire) | This is what sets the file size ceiling. See below. |
| Retry on failure | None. API Gateway does not retry a proxy integration, and Lambda does not retry synchronous invocations. | A failed delivery is not silently attempted twice. |

That first row is the whole argument. In a buffered integration the guarantee is **structural**: the response object is constructed after the absence check, on the last line of the function, and there is no earlier exit. A future contributor cannot accidentally weaken it by reordering statements, because there is nothing to reorder — no stream handle exists to write to.

Response streaming would have raised the ceiling to 200 MB, and it was rejected. It trades a structural guarantee for a behavioral one: with a writable stream in scope, "nothing flushed early" becomes a property of how carefully the handler is written, and a single stray `write()` in a future change would break the promise silently. It is also a worse product. Past the first 6 MB, AWS meters streamed responses at 2 MB/s, which would stretch the window in which a dropped connection permanently destroys someone's file from roughly a second to roughly a minute. Cinder took the smaller number.

### Where the file size ceiling comes from

The ceiling is derived, not chosen. The buffered response is capped at 6 MB — 6,291,456 bytes — and binary comes back base64, costing 4 bytes for every 3:

```
4 MiB plaintext + 255-byte filename + envelope + GCM tag ≈ 4,194,674 ciphertext bytes
base64 → 5,592,900 bytes, leaving ~698 KB (11%) under the hard limit
```

So the advertised ceiling is **4 MiB per object**, enforced in the browser before a byte is read (`src/lib/crypto/file-crypto.ts`) and independently re-checked by the server (`api/src/handlers.mjs`). Raising it means changing the transport, and changing the transport means re-proving the guarantee above. Do not raise it in one place alone. `api/test/chunked.test.mjs` asserts the constant's exact expression and fails if anyone edits it, and separately asserts that no streaming symbol has appeared in the handler.

### Larger files: more envelopes, never a bigger one

The ceiling is a property of **one** buffered response, so the way past it is more responses. Above 4 MiB a file is cut into parts of at most `PART_BYTES`, each sealed as its own independent AES-256-GCM envelope, stored under its own random object key, finalized on its own, and claimed by its own atomic conditional delete.

This is not a second protocol running alongside the first. `POST /files` accepts a `parts` array and writes N ordinary grants; `finalizeFile` and `claimFile` were not modified at all. The guarantee at 256 MiB is the same rows in the same table hit by the same conditional writes as the guarantee at 3 MiB — which is the only sense of "identical" worth claiming.

**One locator, N parts.** The link still carries a single locator. Part *i*'s locator is derived from it as `base64url(sha256("<locator>:part:<i>"))`, computed independently by the browser (`src/lib/link.ts`) and the server (`api/src/id.mjs`). Holding the link yields every part, which is correct — it is one link to one recipient. Holding one part's locator yields nothing else, because inverting SHA-256 is the work. Carrying 64 capabilities in the fragment instead would produce a ~2.8 KB URL, and a chat client that truncates a Cinder link destroys a file.

The part count rides in the fragment (`#<key>.<n>`), so the reveal gate can state the cost before anything is claimed without a request on link arrival — the same constraint that put the transfer kind in the path. It is a hint, not an authority: part zero's authenticated header carries the real count and the reader refuses on a mismatch.

**Position is authenticated.** Each part decrypts on its own, so a hostile server could otherwise reorder parts, drop the tail, or replay part 3 in part 5's place and every individual GCM tag would still verify. The part index and the total are fed in as GCM additional authenticated data, so an envelope is valid only at the exact position it was sealed for, in a transfer of exactly that length.

**The filename is encrypted once**, into part zero's header, rather than repeated per part — repeating it would hand an observer N copies of the same plaintext under one key at a known offset, and would make the name's length visible in every object's size.

### Partial failure, and why there is no resume

Parts are claimed strictly in order, one at a time. If part 7 of 12 fails, parts 1 through 7 are already irreversibly destroyed and the file cannot be assembled. Cinder does not continue, does not offer a retry, and does not offer a resume — a resume would require a second delivery attempt for an object it has already deleted, which is the one thing the product exists to make impossible.

The parts that were never claimed remain claimable until they expire, and they are abandoned to the same S3 lifecycle sweep that already collects a cancelled upload's orphan. That is the truthful state rather than a tidy one: Cinder cannot un-destroy parts 1 through 7, so there is no honest way to make the survivors into a file.

Two consequences the interface is required to carry, and does:

- The reveal gate states the part count and the total-loss cost **before** the button, in the same register as the single-file warning.
- A **busy** part is retried with backoff, up to four attempts, and this is not an exception to the rule. `TransferBusyError` is raised only when API Gateway or Lambda concurrency shed the request before the function ran, so the atomic claim provably did not happen. Retrying a request that did not happen is not retrying a claim. Without it, one shed request in a 64-part transfer would destroy a file over something that was never a failure.

`api/test/chunked.test.mjs` proves the per-part guarantee by execution rather than argument: a twelve-part transfer emits twelve identical `claim, open, delete, absence, first-byte` sequences; twenty simultaneous claims on one part yield exactly one winner while its siblings stay untouched; twenty-four concurrent claims across eight parts yield exactly eight bodies; and a broken part 7 emits six response-first-byte events, none for the seventh, with parts 0 through 6 permanently consumed.

## Bot defense

Messaging apps (iMessage, Slack, WhatsApp, Signal) fetch links to render preview cards. With a naive "burn on fetch" design, that preview bot becomes the first reader and the note is destroyed before the human ever clicks. Cinder defends against this in two layers:

1. **No auto-fetch.** Opening a note link fetches nothing. A human must click "Reveal" to trigger the burn.
2. **Burn is POST-only.** Preview bots issue GET requests, which the burn endpoint does not answer.

## Design decisions

The interesting choices, and why they went the way they did.

### Why the key goes in the URL fragment

The fragment (`#…`) is the only part of a URL that browsers never transmit to a server — not in the request line, not in headers. Putting the key there means the key reaches the recipient's browser (they have the whole link) but never reaches Cinder's servers. This is the mechanism behind the zero-knowledge claim, and it is the same technique PrivateBin and other credible tools use.

### Why DynamoDB, specifically

The core requirement — exactly one successful server retrieval — is a concurrency problem. Two people (or a person and a retrying network) could hit the burn endpoint at the same moment. DynamoDB's conditional `DeleteItem` with `ReturnValues: ALL_OLD` solves this in a single, strongly-consistent, atomic operation: the delete either happens (and returns the item) or fails the condition. Exactly one caller can win. No locks, no transactions, no read-then-delete race window. A SQL database or an object store would have required extra machinery to get the same guarantee.

### Why TTL is a backstop, not the burn

DynamoDB TTL deletion is best-effort — items are removed within roughly two days of expiry, not instantly, and *expired-but-unreaped items are still returned by reads*. So TTL alone would occasionally serve an expired note. The real expiry enforcement is a guard inside the burn condition (`expiresAt > :now`); TTL just keeps the table clean over time.

### Why the file promise is "one delivery attempt"

The tempting phrasing is "one download" or "one recipient." Both would be lies. Cinder cannot tell who is holding a link, and it cannot know whether bytes it sent ever arrived — a connection can drop at 99%, and no server anywhere can distinguish that from a completed transfer without the client saying so, which is a claim the client could fake.

What Cinder *can* enforce is narrow and completely true: one atomic claim, and its own stored copy deleted and verified gone before the response body exists. So that is what the copy says. The cost is real and stated plainly on the reveal screen — if the delivery fails, the file is permanently unavailable, and nobody can undo that. A weaker promise that always held beats a stronger one that usually did.

### Why serverless

A self-destructing-note service is bursty and low-volume for personal use. Serverless means there is no server running (and costing money) when nobody is sending notes, and it scales to any burst without capacity planning. The whole thing sits inside the AWS free tier at realistic volumes.

### Why so little code

For a privacy tool, every line shipped to the browser is a line a security-conscious user has to trust. SvelteKit compiles its own framework away, Cinder uses the browser's native Web Crypto rather than a third-party crypto library, and the API is five small functions. Less code is less attack surface and less to audit — that minimalism is a feature, not a shortcut.

## Related documents

- [Crypto](crypto.md) — the exact encryption scheme and parameters
- [Security & threat model](security.md) — what this protects, and what it cannot
- [API reference](api.md) — endpoint contracts
- [Deployment](deployment.md) — how the AWS stack is provisioned
