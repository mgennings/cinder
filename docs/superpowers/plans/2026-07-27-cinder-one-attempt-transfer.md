# Cinder One-Attempt File Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add browser-encrypted file transport with exactly one server delivery attempt and verified deletion of Cinder's stored ciphertext before the first response byte.

**Architecture:** Leave the existing note protocol unchanged. Files use browser AES-256-GCM, a private non-versioned S3 object, a hashed DynamoDB grant, constrained upload/finalize endpoints, and one server-owned claim-open-delete-verify-stream path. The product ceiling is empirical, not fixed.

**Tech Stack:** SvelteKit, TypeScript, Web Crypto, Node.js Lambda, DynamoDB, private S3, AWS SAM, Playwright

## Global Constraints

- Promise one server delivery attempt, never one recipient or guaranteed download.
- Encrypt bytes, filename, and MIME type in the browser; keep the key in the URL fragment.
- Link arrival never claims or fetches ciphertext.
- Any failure after claim permanently consumes the transfer.
- No presigned GET, redirect, Range, retry, resume, preview, account, gallery, analytics, or third-party script.
- Ship only the largest payload repeatedly proven on real iPhone Safari; do not invent chunked cryptography.
- No production infrastructure apply, deploy, or deploy-wired push without Matt's explicit authorization.

---

### Task 1: Prove Whole-Object Browser Encryption

**Files:**
- Create: `src/lib/crypto/file-crypto.ts`
- Create: `src/lib/crypto/file-crypto.test.ts`
- Modify: `src/lib/link.ts`
- Test: `src/lib/link.test.ts`

**Interfaces:**
- Consumes: `File`, optional passphrase, configured plaintext ceiling
- Produces: authenticated ciphertext envelope and fragment-only decryption material

- [ ] **Step 1: Write failing round-trip and tamper tests**

Cover 0 bytes, 1 byte, deterministic binary content, Unicode filename, absent MIME type, wrong key, changed ciphertext, and changed metadata. Assert the fragment key never appears in a request URL.

- [ ] **Step 2: Run and verify failure**

```bash
pnpm test -- src/lib/crypto/file-crypto.test.ts src/lib/link.test.ts
```

- [ ] **Step 3: Implement the minimal Web Crypto extension**

Reuse the existing AES-GCM and link primitives. Authenticate file metadata with the ciphertext. Keep note and file envelopes versioned and distinct without a new abstraction layer.

- [ ] **Step 4: Add a configurable conservative ceiling**

Reject one byte above the current proven ceiling before encryption or upload. Do not name 100 MiB in shipped copy.

- [ ] **Step 5: Run and commit**

```bash
pnpm test -- src/lib/crypto/file-crypto.test.ts src/lib/link.test.ts
pnpm check
git add src/lib/crypto/file-crypto.ts src/lib/crypto/file-crypto.test.ts src/lib/link.ts src/lib/link.test.ts
git commit -m "🔐 feat(crypto): encrypt one file in browser" -m "- authenticate bytes, filename, and MIME metadata" -m "- keep decryption material in the URL fragment"
```

### Task 2: Add Private Upload Grants and Finalization

**Files:**
- Modify: `api/src/store.mjs`
- Modify: `api/src/handlers.mjs`
- Modify: `api/src/lambda.mjs`
- Modify: `api/test/store.test.mjs`
- Modify: `api/test/handlers.test.mjs`
- Modify: `template.yaml`

**Interfaces:**
- Consumes: ciphertext byte length, ciphertext checksum, expiry
- Produces: independent locator and upload capabilities plus one constrained private upload

- [ ] **Step 1: Add failing state-machine tests**

Cover conditional create, key substitution, overwrite, missing object, wrong stored size, wrong checksum, expired capability, duplicate finalize, and `uploading -> ready` only.

- [ ] **Step 2: Run and verify failure**

```bash
node --test api/test/store.test.mjs api/test/handlers.test.mjs
```

- [ ] **Step 3: Implement hashed capabilities and stored-object verification**

Generate independent secrets with the platform CSPRNG, store hashes only, constrain upload to one random object key, and use `HeadObject` during finalize. Trust no client completion claim.

- [ ] **Step 4: Harden the bucket and roles**

Configure private non-versioned S3, Block Public Access, BucketOwnerEnforced ownership, TLS-only policy, no website/replication/Object Lock, short orphan lifecycle, exact CORS origins, and separate roles without `ListBucket`.

- [ ] **Step 5: Validate and commit**

```bash
node --test api/test/store.test.mjs api/test/handlers.test.mjs
sam validate --lint
git add api/src api/test template.yaml
git commit -m "🏗️ feat(media): add constrained ciphertext uploads" -m "- verify stored objects before finalization" -m "- isolate private storage and least-privilege roles"
```

### Task 3: Prove the Exact Streaming Primitive

**Files:**
- Modify: `api/src/lambda.mjs`
- Modify: `api/test/handlers.test.mjs`
- Modify: `template.yaml`
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes: one ready grant and exact object key
- Produces: a response path whose headers and first body byte cannot flush before verified absence

- [ ] **Step 1: Write an event-order failure test**

Require exactly `claim`, `s3-open`, `s3-delete`, `s3-head-404`, `response-first-byte`. Inject failure at every seam and assert zero response bytes before the final event.

- [ ] **Step 2: Verify current infrastructure cannot satisfy the test by assumption**

Document the exact Lambda/API integration, response-streaming mode, timeout, payload ceiling, buffering, retry, and CloudFront behavior from deployed-equivalent evidence.

- [ ] **Step 3: Implement only if the transport can prove the invariant**

Use the smallest AWS primitive that guarantees no header or body flush before verified absence. If API Gateway or an intermediary prevents proof, stop this plan with a hold instead of weakening copy or tests.

- [ ] **Step 4: Run failure injection and SAM validation**

```bash
node --test api/test/handlers.test.mjs
sam validate --lint
```

- [ ] **Step 5: Commit the proven transport or report HOLD**

```bash
git add api/src/lambda.mjs api/test/handlers.test.mjs template.yaml docs/architecture.md
git commit -m "🔐 feat(media): prove delete-before-delivery transport" -m "- block response bytes until S3 absence is verified" -m "- document exact AWS streaming boundaries"
```

### Task 4: Enforce One Atomic Delivery Attempt

**Files:**
- Modify: `api/src/store.mjs`
- Modify: `api/src/handlers.mjs`
- Test: `api/test/store.test.mjs`
- Test: `api/test/handlers.test.mjs`

**Interfaces:**
- Consumes: hashed locator for a ready, unexpired grant
- Produces: exactly one server-owned retrieval authority

- [ ] **Step 1: Add the 20-claim race test**

Assert one winner, nineteen identical unavailable results, one S3 open, one delete, one absence check, and one response path.

- [ ] **Step 2: Add permanent-loss tests**

Cover crash, timeout, S3 open failure, delete failure, absence-check failure, disconnect at byte zero, disconnect midstream, Lambda retry, HEAD, Range, conditional request, and duplicate invocation. None restores eligibility.

- [ ] **Step 3: Implement atomic claim and generic denial**

Reuse DynamoDB conditional delete with `ALL_OLD`. Reject expired grants in the condition rather than relying on asynchronous TTL.

- [ ] **Step 4: Run and commit**

```bash
node --test api/test/store.test.mjs api/test/handlers.test.mjs
git add api/src/store.mjs api/src/handlers.mjs api/test/store.test.mjs api/test/handlers.test.mjs
git commit -m "🔥 feat(media): consume one delivery attempt" -m "- allow exactly one atomic retrieval authority" -m "- make every post-claim failure permanent"
```

### Task 5: Build the File Creation and Reveal Journeys

**Files:**
- Modify: `src/lib/api.ts`
- Modify: `src/routes/+page.svelte`
- Modify: `src/routes/n/[id]/+page.svelte`
- Modify: `src/app.css`
- Modify: `src/service-worker.ts`
- Test: `tests/e2e/blip.spec.ts`

**Interfaces:**
- Consumes: browser-encrypted file envelope and strict retrieval response
- Produces: one-file creation, explicit reveal, local decrypt, and inert download

- [ ] **Step 1: Add failing journey tests**

Assert native file input, one note-or-file choice, no claim on page load or bot unfurl, no service-worker cache, explicit reveal, no double activation, exact permanent-loss copy, local download, and generic gone state.

- [ ] **Step 2: Implement minimal creation states**

Use note/file radio semantics, selected file summary, semantic progress, cancel before finalize, and copy/share link. Do not add previews or galleries.

- [ ] **Step 3: Implement minimal retrieval states**

Use the exact action “Reveal and destroy Cinder's stored copy” and the approved warning from the design spec. Decrypt locally and save with the browser download path.

- [ ] **Step 4: Prove accessibility and caching boundaries**

Verify 320 CSS pixels at 200% zoom, 44-pixel controls, keyboard, screen reader announcements, Reduced Motion, forced colors, both schemes, WCAG AA, no third-party requests, no protected service-worker cache, and `no-store` responses.

- [ ] **Step 5: Run and commit**

```bash
pnpm test
pnpm check
pnpm exec playwright test tests/e2e/blip.spec.ts
pnpm build
git add src tests/e2e/blip.spec.ts
git commit -m "✨ feat(media): add one-attempt file journey" -m "- require explicit irreversible reveal" -m "- decrypt and save only on the recipient device"
```

### Task 6: Establish the Empirical Product Ceiling

**Files:**
- Modify: the existing file-size constant and its test
- Modify: `src/routes/security/+page.svelte`
- Modify: `docs/security.md`
- Modify: `docs/api.md`
- Test: `tests/live/live.spec.ts`

**Interfaces:**
- Consumes: repeated real-iPhone Safari measurements
- Produces: one truthful advertised maximum below the largest reliably passing payload

- [ ] **Step 1: Generate deterministic fixtures at runtime**

Do not commit binary blobs. Test increasing sizes under realistic memory pressure through encrypt, upload, retrieve, delete proof, download, decrypt, and exact SHA-256 comparison.

- [ ] **Step 2: Run repeated real-device trials**

Record tab survival, peak browser memory when available, elapsed time, decrypted hash, second-read denial, and storage absence. The maximum must pass repeatedly with margin.

- [ ] **Step 3: Set the ceiling below the proven boundary**

Lower code, tests, and copy together. Never preserve 100 MiB by weakening proof or adding unaudited chunking.

- [ ] **Step 4: Make every security claim literal**

Document one server delivery attempt, Cinder's stored encrypted copy, permanent post-claim loss, asynchronous orphan cleanup, exact streaming infrastructure, CORS, CSP, throttling, and log redaction.

- [ ] **Step 5: Run the complete local gate and commit**

```bash
pnpm test
pnpm check
pnpm build
node --test api/test/store.test.mjs api/test/handlers.test.mjs
sam validate --lint
git diff --check
git add src tests docs
git commit -m "📝 docs(media): publish the proven transfer ceiling" -m "- align limits and copy with real-device evidence" -m "- state permanent-loss and storage boundaries plainly"
```

### Task 7: Stop at Production Gates

- [ ] Report local commits, exact test results, exact streaming proof, the proven file ceiling, accessibility results, log-redaction results, and remaining gates.
- [ ] Do not run `sam deploy`, frontend deployment, a deploy-wired push, or production canary without Matt's explicit authorization.
- [ ] If strict delete-before-first-byte remains unproven, report HOLD and do not expose file creation in the UI.
