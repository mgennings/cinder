# blip — a self-destructing note app

Design spec · 2026-07-01

## What we're building

blip is a zero-knowledge, self-destructing note service. You write a note, blip encrypts it in your browser, and hands you a single link. The first person to open that link reads the note once — and then it's gone, permanently, from everywhere. The server that stores the note can never read it. That last property is the whole point: this is a genuine privacy tool, not a demo that merely feels private.

The bar is "the best one out there." Concretely that means we clear the bar the respected tools (PrivateBin, modern Privnote) clear — client-side encryption with the key held only in the URL fragment — and we do it on real AWS infrastructure with an atomic, race-proof burn, wrapped in an Apple-grade UI.

## Core guarantees

1. **Zero-knowledge.** The decryption key is generated in the sender's browser and travels only in the URL fragment (`#...`), which browsers never transmit in HTTP requests. The server stores ciphertext it is mathematically unable to decrypt.
2. **Read-once, atomically.** The note self-destructs on first read via a single atomic DynamoDB operation. Exactly one reader wins; everyone else gets "already read." There is no read-then-delete race window.
3. **Nothing lingers.** Every note also carries a hard TTL. Even if a note is never read, it is gone after its expiry. TTL is a backstop, not the primary burn mechanism.
4. **Honest about limits.** We state plainly, in the product and in this doc, what the scheme does not protect against. A privacy tool that oversells itself is worse than one that's honest.

## Architecture (approach A: serverless + DynamoDB atomic burn)

```
┌─ SENDER's browser ──────────────┐                    ┌─ AWS ──────────────────────────────┐
│ 1. write note                   │                    │                                    │
│ 2. generate AES-256-GCM key     │                    │  CloudFront ──► S3 (SvelteKit       │
│ 3. optional passphrase (2FA)    │                    │    │          static build)          │
│ 4. encrypt → ciphertext + iv    │                    │    │                                 │
│ 5. POST {ciphertext,iv,salt?,   │                    │    │                                 │
│         ttl} ───────────────────┼──► API Gateway ──► Lambda:createNote ──► DynamoDB         │
│ 6. receive {id}                 │                    │        (stores ciphertext only)     │
│ 7. build link:                  │                    │                                    │
│      blip.site/n/{id}#{key}     │                    │                                    │
│      └ key NEVER leaves client  │                    │                                    │
└─────────────────────────────────┘                    │                                    │
                                                        │                                    │
┌─ READER's browser ──────────────┐                    │                                    │
│ opens /n/{id}#{key}             │                    │                                    │
│ ── wrapper page, NO auto-fetch ─┼── (defeats preview bots)                                 │
│ human clicks "Reveal note" ─────┼──► API Gateway ──► Lambda:readNote ──► DynamoDB          │
│                                 │                    │   atomic DeleteItem +               │
│ ◄── {ciphertext,iv,salt?} ──────┼──── (burned)       │   ConditionExpression +             │
│ decrypt with key from #frag     │                    │   ReturnValues: ALL_OLD             │
│ show note — then it's gone      │                    │                                    │
└─────────────────────────────────┘                    └────────────────────────────────────┘
```

Everything is stateless except DynamoDB. Lambdas hold no state; S3 and CloudFront serve static files. Idle cost is effectively zero, and every piece sits comfortably inside the AWS free tier at any realistic personal volume.

## The crypto scheme

All values below are verified against current MDN and OWASP guidance (2026-07-01).

**Default mode (random key):**

- Generate an AES-GCM 256-bit key client-side: `crypto.subtle.generateKey({name:'AES-GCM', length:256}, true, ['encrypt','decrypt'])`.
- Generate a fresh 96-bit (12-byte) IV per note via `crypto.getRandomValues`. The IV is unique per encryption and is not secret; it travels with the ciphertext.
- Encrypt the note text. AES-GCM is authenticated encryption: the ciphertext carries a 128-bit auth tag, so any tampering with the stored blob causes decryption to throw rather than return garbage. This protects note integrity even against a malicious server.
- Export the key with `exportKey('raw')`, base64url-encode it (no padding), and place it in the URL fragment. It is the entire secret and it never reaches AWS.

**Two-factor passphrase mode (optional, in v1):**

- The sender may add a passphrase. When they do, the note is protected by *both* the random fragment key *and* the passphrase — an attacker needs the link and the passphrase.
- The passphrase is stretched with PBKDF2-HMAC-SHA256 at 600,000 iterations (OWASP-current) over a random 16-byte salt. The salt is stored alongside the ciphertext (it is not secret and must be reproduced at decrypt time).
- Two-factor is strictly stronger than either factor alone and is the recommended default posture for "someone forwarded my link" scenarios.

**Encoding:**

- Prefer native `Uint8Array.prototype.toBase64()` / `Uint8Array.fromBase64()` with `{alphabet:'base64url'}` for the fragment and standard base64 for JSON transport.
- These methods are Baseline 2025 (available since Sept 2025). Feature-detect and fall back to a `btoa`/`atob` binary-string bridge (with manual base64url character substitution) for older browsers. Notes are short text, so the fallback's chunking concern is moot.

## API contract

Two endpoints behind an API Gateway HTTP API.

**`POST /notes` → createNote Lambda**

- Request body: `{ ciphertext, iv, salt?, ttlSeconds }` — all binary fields base64-encoded; `salt` present only in passphrase mode.
- The Lambda generates a random URL-safe `id`, computes `expiresAt = now + ttlSeconds`, writes the item, and returns `{ id }`.
- The server never sees the key or the plaintext. It enforces a maximum ciphertext size (reject oversized payloads) and caps `ttlSeconds` at a maximum (e.g. 7 days).

**`POST /notes/{id}/burn` → readNote Lambda**

Deliberately POST, not GET, so link-preview crawlers (which issue GETs) cannot trigger a burn.

```js
DeleteCommand({
  TableName: "blip-notes",
  Key: { pk: id },
  ConditionExpression: "attribute_exists(pk) AND expiresAt > :now",
  ExpressionAttributeValues: { ":now": epochNow },
  ReturnValues: "ALL_OLD",
  ReturnValuesOnConditionCheckFailure: "ALL_OLD",
})
```

- **Winner:** the delete succeeds, `.Attributes` holds the item, and the Lambda returns `{ ciphertext, iv, salt? }`. The note is now gone for everyone.
- **Loser / already-read / expired:** the condition fails with `ConditionalCheckFailedException`, and the Lambda returns `410 Gone` with a friendly "This note has already been read or has expired."
- The `expiresAt > :now` guard is mandatory. DynamoDB TTL deletion is best-effort ("within ~2 days"), and expired-but-unreaped items still show up in reads — so we must guard on expiry at read time, not rely on TTL to hide expired data.

The delete is a strongly-consistent single atomic write serialized on the item's key, which is exactly why the race resolves to one winner. (One cost note: a failed conditional write still consumes ~1 WCU; negligible at personal volume.)

## Bot-defense (two layers)

1. **No auto-fetch on load.** The reader link opens a lightweight wrapper page that fetches nothing. A human must click "Reveal note" to issue the burn. This means pasting a blip link into iMessage, Slack, WhatsApp, or Signal — all of which unfurl links — does not silently burn the note before the human arrives.
2. **Burn is POST-only.** Unfurlers issue GET requests, which cannot trigger the burn endpoint.

## Infrastructure (AWS SAM)

Defined in a single `template.yaml` and deployed with `sam deploy`.

- **DynamoDB table** `blip-notes`: partition key `pk` (string), `expiresAt` (number, epoch seconds) registered as the TTL attribute, on-demand (pay-per-request) billing.
- **Two Lambdas** (Node 22, ARM/Graviton for cost): `createNote` and `readNote`. IAM is least-privilege — `createNote` gets only `dynamodb:PutItem`, `readNote` gets only `dynamodb:DeleteItem`, each scoped to the table ARN.
- **API Gateway** HTTP API fronting the two Lambdas, with CORS configured for the site origin and basic throttling.
- **S3 + CloudFront** for the static SvelteKit build, HTTPS via the default CloudFront cert (custom domain optional later).

**Local development** uses `sam local start-api` plus DynamoDB Local so the entire flow — create, link, reveal, burn — is provable on the machine before any real AWS resource is touched.

## Front end (SvelteKit, static)

Verified current versions: SvelteKit 2.68, Svelte 5.56 (runes), `@sveltejs/adapter-static` 3.0.10.

- `adapter-static` with `fallback: '200.html'` so any `/n/<random-id>` URL boots the SPA and resolves the id client-side (no per-id prerendering).
- `export const ssr = false` for the note routes (pure client-side crypto — nothing to render server-side), while the landing and about pages are individually prerendered (`prerender = true`, `ssr = true`) so they stay fast and indexable.
- Tailwind for the visual layer; Svelte's built-in `transition:` directives for the "note burns away on reveal" motion — no extra animation dependency.

The app is small on purpose. For a crypto tool, less shipped code is less attack surface and a smaller thing to audit — that minimalism is itself a privacy virtue.

## Android / Play Store (documented fast-follow, not in v1)

The static build is intentionally PWA-ready so this stays a wrap, not a rewrite.

- `@vite-pwa/sveltekit` adds the manifest + service worker (installability criteria: `name`, `icons`, `start_url`, `display: standalone`, registered service worker, offline HTTP 200).
- Google's Bubblewrap (`@bubblewrap/cli` 1.24.1) wraps the PWA into a Trusted Web Activity and produces the `.aab` for the Play Console. Needs Node 14.15+, JDK 17, Android SDK tools, and a one-time $25 Play Console account.
- **Critical infra guard:** `/.well-known/assetlinks.json` must be served as real `application/json` with the Play App Signing SHA-256 fingerprint, and it must resolve *before* the SPA fallback rule. A CloudFront catch-all that rewrites 403/404 → `index.html` will otherwise return the SPA shell for that path, which silently downgrades the TWA to a browser-chrome Custom Tab with no error. This is the single most likely silent break and is called out here so we guard against it from the start.

## Honest threat model

What blip protects against:

- **Server-side plaintext exposure.** Encryption and decryption happen only in the browser. The server stores ciphertext, IV, and (in passphrase mode) salt — never the key or plaintext.
- **Ciphertext tampering.** AES-GCM's auth tag means any modification to the stored blob makes decryption fail rather than yield altered content.
- **A leaked stored blob.** Without the fragment key, the stored payload is useless.

What blip does not, and cannot, protect against — stated without hedging:

- **A malicious or compromised server serving backdoored JavaScript.** Because the same server that stores the note also ships the crypto code, it could at any time serve a modified script that exfiltrates the plaintext or key. "Zero-knowledge" holds only while the server ships honest JS, and no web app can cryptographically prove to a user that it did. This is the fundamental, unavoidable limitation of browser-delivered crypto. Subresource Integrity and code review mitigate but do not eliminate it.
- **Anyone who obtains the link.** The fragment key is the whole secret. Whoever holds the full URL can read the note. The link must be sent over a channel the sender trusts.
- **Link exposure in intermediaries.** The full URL (fragment included) can land in browser history, browser sync, clipboard managers, chat backups, or any client-side script that reads `location.href`. We ship no third-party analytics on the note routes for exactly this reason.
- **Metadata.** blip hides note contents, not the existence of a note, its approximate size, or timestamps.
- **Weak passphrases.** PBKDF2 at 600k iterations slows offline guessing; it does not make a weak passphrase safe.
- **Endpoint compromise.** Malware, a malicious extension, or a shared machine sees the plaintext at decrypt time. Out of scope for any web app.
- **"Self-destruct" is a server-side promise, not a cryptographic one.** Deletion depends on the backend actually deleting and never having logged or replicated the ciphertext. Anyone who captured the ciphertext and link before the burn can still decrypt.

## Testing strategy

- **Crypto unit tests:** round-trip encrypt/decrypt (random-key and passphrase modes), tamper-detection (a flipped ciphertext byte must fail to decrypt), base64url encode/decode including the fallback path.
- **Burn semantics tests (against DynamoDB Local):** first read returns the note; second read returns 410; concurrent reads yield exactly one winner; an expired note is never served even before TTL reaps it.
- **API contract tests:** oversized payload rejected, TTL cap enforced, malformed body handled.
- **End-to-end (local):** create a note in the browser, copy the link, open it in a second context, reveal, confirm the note shows and the second reveal fails.
- Coverage gates come from the apple-repo-conventions tooling (Husky, commitlint, ESLint, Prettier, EditorConfig, coverage thresholds), run on this repo before the first feature commit.

## v1 scope

In scope: the full web app (SvelteKit + client crypto + both modes), the SAM stack, local end-to-end proof, and deployment to the real AWS account behind CloudFront — a live, working private note service.

Deferred (documented fast-follow): the Bubblewrap TWA / Play Store packaging, and a custom domain.

The final "point the public at this production URL" step is gated on explicit sign-off; building and deploying the stack is not.

## Naming

Working name: **blip** — a note that appears, is read, and vanishes. Short, ownable, matches the ephemerality. Open to change before we lock the package name / domain.
