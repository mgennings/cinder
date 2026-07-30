# Cinder Multimedia Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one Cinder link carry a message and a file together, render URLs inside a revealed message as real links, and preview a delivered PDF in the recipient's own browser, without changing a single line of the delivery, destruction, or ceiling guarantees.

**Architecture:** No new endpoint, no new table attribute, no new IAM action, no new Lambda, no `template.yaml` change. A message that travels with a file becomes one more field in part zero's already-encrypted, already-authenticated JSON header inside the AES-256-GCM region, so a combined artifact is exactly one locator, one grant, one atomic claim, one delete, and one delivery attempt. The rendering work is entirely client-side: plaintext is parsed into text runs and validated link runs and handed to Svelte's escaping interpolation rather than to `innerHTML`, and a PDF preview is a same-origin blob typed by Cinder from sniffed magic bytes rather than by the sender's string.

**Tech Stack:** SvelteKit 5, TypeScript, Web Crypto, Vitest, Playwright

## What this amendment supersedes

Two shipped statements become false the day this ships and must be corrected in the same release, not after it:

- `docs/api.md:177` says "**No presigned GET, Range, retry, resume, or preview.**" The prohibition it means is still true and must stay: nothing previews server-side, nothing re-fetches, no second body ever leaves the bucket. What changes is that the recipient's own browser may render bytes it already holds. Reword to name the boundary rather than delete the line.
- `src/routes/f/[locator]/+page.svelte:108-109` says "An inert download: a Blob the browser saves. Never a preview, never a server round trip, never anything that executes what was sent." Two of those three clauses stay true forever. The comment must be rewritten to say exactly which one moved and why the other two did not.

The one-attempt plan's Global Constraint "No presigned GET, redirect, Range, retry, resume, preview, account, gallery, analytics, or third-party script" (`2026-07-27-cinder-one-attempt-transfer.md:18`) is amended in one word: **preview** now means *no server-side preview and no second retrieval*. Every other term in that list is unchanged and still binding.

## The promises this amendment must not weaken, and the line that enforces each

An implementer may not touch any of these. A reviewer should read each cited line before accepting a claim that it survived.

| Promise | Enforced at | Why this amendment cannot reach it |
| --- | --- | --- |
| Exactly one server delivery attempt, never one recipient and never a guaranteed download | `api/src/store.mjs:172-196` (`claimFileGrant`: conditional `DeleteCommand` with `ReturnValues: 'ALL_OLD'`), `api/src/store.mjs:21-40` (`burnNote`) | A combined artifact is one grant row. Adding a field inside the GCM region does not add a row, a request, or a claim. |
| Delete-before-delivery is structural, not sequenced | `api/src/handlers.mjs:346-357` (the comment stating the buffered AWS_PROXY integration is the enforcement) and `358-413` (claim, `s3-open`, `s3-delete`, `s3-head-404`, `response-first-byte`, single `return`) | Nothing here changes the Lambda, its integration type, its response shape, or CloudFront's single site-bucket origin. No Function URL is introduced. Do not propose response streaming for a preview; a stream converts this into an ordering claim. |
| Read-once destruction cannot be undone | `template.yaml:420-440`. `ClaimFileFn` is granted `dynamodb:DeleteItem`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket` and nothing else. It holds no `s3:PutObject` and no `dynamodb:PutItem`, so IAM's default deny makes recreating a destroyed grant or object impossible. | This plan adds no policy statement. If a diff in this release touches an `Action:` list, it is out of scope and must be rejected. |
| 4 MiB is derived, not chosen | `api/src/handlers.mjs:30-36` (`MAX_CIPHERTEXT_BYTES = 4 * 1024 * 1024 + 4096`), `src/lib/crypto/file-crypto.ts:31-44` (`MAX_FILE_BYTES`) | The message shares this budget. See the boundary arithmetic below. No constant in either file may increase. |
| No locator, capability, object key, recipient, sender, or payload in any log or response | `api/src/handlers.mjs:71` (one identical `GONE()` for every unavailable reason), `api/src/store.mjs:100-101` and `82-98` (projections that return no object key or recipient data), `api/src/capabilities.mjs` (a gate receives only `{ grant, capability }`, never the event) | All work is client-side. Nothing new is sent to any server. The message never leaves the browser unencrypted. |
| CSP is first-party only, `frame-ancestors 'none'`, plus HSTS and Permissions-Policy on all four aliases | `vite.config.ts:74-90` (meta policy: `default-src 'none'`), `template.yaml:528-556` (edge policy: `frame-ancestors 'none'; base-uri 'none'; form-action 'none'`, HSTS 63072000 preload, Permissions-Policy) | `template.yaml` is not edited. At most one directive is added to the meta policy, and only if Task 6 earns it. `frame-ancestors` is never touched. |

**Verified live on 2026-07-28.** `curl -sSI https://cinder.ink/` returns `Content-Security-Policy: frame-ancestors 'none'; base-uri 'none'; form-action 'none'`, `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`. The document's own meta policy begins `default-src 'none'`, which means `frame-src`, `object-src`, `media-src`, and `child-src` all currently resolve to `'none'` by fallback. **An `<iframe>`, `<object>`, or `<embed>` is blocked today.** That is the fact Task 6 exists to work with.

## The shared budget, and exactly what happens at the boundary

A combined message-and-file artifact spends one envelope. The arithmetic, all of it derived from constants already in the tree:

```
MAX_CIPHERTEXT_BYTES  = 4 * 1024 * 1024 + 4096 = 4,198,400   api/src/handlers.mjs:36
MAX_FILE_BYTES        = 4 * 1024 * 1024        = 4,194,304   src/lib/crypto/file-crypto.ts:44
envelope framing      = 2 (version+saltLen) + 16 (salt) + 12 (iv) + 4 (headerLen) + 16 (GCM tag) = 50

part-zero ciphertext  = 50 + headerBytes + sliceBytes
base64 on the wire    = ceil(4,198,400 / 3) * 4 = 5,597,868 chars, 693,588 under the 6,291,456 cap (11.0%)
```

With a full 4 MiB slice, the header has **4,046 bytes** of headroom (`4,198,400 - 50 - 4,194,304`), and the existing `{name, type, parts}` JSON already spends part of it. A message competes for what is left.

**The authoritative refusal is measured, never estimated.** `file-crypto.ts` computes the framed ciphertext length after the header bytes exist and before `crypto.subtle.encrypt` runs, and throws when it would exceed `MAX_CIPHERTEXT_BYTES`. Measuring the encoded header means JSON escaping, a Unicode filename, and salt presence are all already counted, which no byte-count heuristic can honestly claim.

**The composer's pre-flight is advisory and exists only to disable the button early.** For a one-part send it refuses when `utf8Length(message) + file.size > MAX_FILE_BYTES`. For a multipart send it refuses when `utf8Length(message) > 2048`, a deliberately conservative number labeled as advisory in the source. When a pre-flight passes and the measured predicate refuses, the person is shown the exact byte overflow.

At the boundary, precisely:

- A 4 MiB file plus one byte of message is refused in the browser, from metadata alone, before a byte of the file is read and before any request reaches the server.
- A 4,194,104-byte file plus a 300-byte message is refused the same way, naming both sizes.
- A multipart send whose part-zero header would exceed 4,046 bytes is refused by the measured predicate before `POST /files` is called, so no grant is created and no credit is spent.
- Nothing raises `MAX_CIPHERTEXT_BYTES`, `MAX_FILE_BYTES`, `PART_BYTES`, `MAX_PARTS`, or `MAX_TRANSFER_BYTES`. The server's independent check in `readPart` (`api/src/handlers.mjs:79-86`) is unchanged and remains the authority. The client checks exist to fail early, not to be trusted.

## The security surface this opens, named honestly

Three previously inert things become live. Each gets a structural answer, not a promise of care.

**1. Rendering a message as anything but plain text.** Today `src/routes/n/[id]/+page.svelte:128-129` renders `<pre>{plaintext}</pre>`, and Svelte's `{}` interpolation escapes it. That is a guarantee by construction. **No implementation step in this plan may assign untrusted content to `innerHTML`, `{@html}`, `insertAdjacentHTML`, `document.write`, or a `Function`/`eval` sink.** The message is parsed into an array of `{ text }` and `{ text, href }` runs by a pure function with no DOM access, and rendered with `{#each}` plus `{#if}`, so Svelte escapes every text node and attribute-escapes every href. This needs no sanitizer and no new dependency, and it is strictly safer than one.

**2. Autolinking.** The parser matches only a literal `https://` or `http://` prefix, so `javascript:`, `data:`, `blob:`, `file:`, and `vbscript:` are never candidates. Each candidate is then validated as **the exact string that will become the href** and rejected unless `new URL(candidate)` yields `protocol` of `http:` or `https:`, an empty `username`, an empty `password`, and a non-empty `hostname`. Credential-bearing URLs are rendered as plain text, not as links. A candidate containing any codepoint in `\u0000-\u0020`, `\u007F`, `\u202A-\u202E`, or `\u2066-\u2069` is rendered as plain text, because the URL parser strips tab, LF, and CR before it resolves and bidi controls can make the visible text disagree with the destination. This is the same lesson `.notes/GOTCHAS.md` records twice: *"A path allowlist that checks characters loses to the URL parser"* and *"Validating the input and returning something else is not validation."* Assert the property on the output. The href and the visible label are the identical string, which is the cheapest anti-spoof available.

**3. Previewing a PDF.** The whole risk is one field. `src/lib/crypto/file-crypto.ts:409-411` reads `type` out of the decrypted JSON header with nothing but a `typeof meta.type === 'string'` check, and `src/routes/f/[locator]/+page.svelte:110-120` feeds it straight into `new Blob([...], { type: f.type })`. Today that is inert, because the anchor carries a `download` attribute and the browser saves rather than renders. **The moment that same sender-controlled string types a blob that is framed or navigated to, `text/html` becomes script execution at `blob:https://cinder.ink/...`, which inherits cinder.ink's origin and can read the `cinder.sender-status.v1` local storage entries.** The rule, without exception: **a preview blob's type is a literal chosen by Cinder from a one-entry allowlist, and it is created only after the decrypted bytes are sniffed and found to begin with `%PDF-`.** The sender's `type` string may be displayed as escaped text and may continue to type the download blob. It may never type a rendered blob.

`frame-ancestors 'none'` is never relaxed. It governs who may frame Cinder and has nothing to do with what Cinder frames. No external origin is added to any directive.

## The download-mode ruling

**Ruling: the automatic save attempt stays for every file-bearing transfer, a prominent user-driven Save control becomes the primary post-delivery action alongside the preview, and no autonomous or testing download mode is introduced.**

The claim already destroyed Cinder's only stored copy before the first pixel rendered, so the bytes exist solely in that tab and a reload is permanent loss; making the save purely user-driven moves the moment the recipient actually holds the file to after a decision they can simply fail to make, which converts a UX annoyance into data loss the product cannot undo. A separate autonomous auto-download mode is refused because Playwright already exercises the real path by clicking the real control (`tests/e2e/blip.spec.ts:98-104` waits on a `download` event from a button click), so the mode would buy nothing and would ship a second production behavior behind a flag, which is exactly the divergence this repo refuses everywhere else.

The part of Matt's ask that is honored in full: the preview is added, a message-only reveal downloads nothing at all, and the explicit Save control is the durable path rather than a hidden one. The part that also earns its keep on iOS Safari, where a download issued after several `await`s may fall outside the user activation window and be blocked silently, is precisely the visible Save control, so this ruling makes the product more reliable there rather than less.

## Global Constraints

- Do not edit `api/`, `template.yaml`, `samconfig.toml`, or any IAM policy. If a task appears to need one, stop and report instead.
- Never assign untrusted content to `innerHTML`, `{@html}`, `insertAdjacentHTML`, `document.write`, `eval`, or `new Function`.
- A rendered blob's MIME type is a literal from Cinder's allowlist, decided by sniffed magic bytes. The sender's `type` string never types a rendered blob.
- Preserve `frame-ancestors 'none'`, `default-src 'none'`, `script-src 'self'`, and the exact `connect-src` origin list. At most one directive may be added to the meta policy, and only with Task 6's evidence.
- Preserve `APPROVED_REVEAL_WARNING` byte for byte in `src/lib/ui/organisms/RevealGate.svelte`. `src/lib/claims.test.ts:56-61` pins that single-file string and `81` asserts it is present in that exact component. New combined-transfer copy is additive; it may not replace, reword, or relocate the pinned sentence.
- Copy shipped anywhere under `src/**/*.svelte`, `static/**`, `docs/**/*.md`, or `README.md` is scanned by `src/lib/claims.test.ts`. Do not write "gone forever", "impossible to recover", "deleted from everywhere", "can be retried", or any affirmative promise of one recipient, one download, one reader, or a successful delivery. This plan file lives under `docs/superpowers/**`, which that glob excludes, which is why it may quote them.
- Preserve the arrival contract: `/n/` and `/f/` pages fetch nothing until a human presses reveal. A preview renders only bytes already delivered. It never issues a request.
- Measure, never eyeball. Contrast comes from rendered pixels via the two-screenshot plate technique, because `.record` and its siblings carry the grid as a background image that `getComputedStyle().backgroundColor` cannot see (`.notes/GOTCHAS.md`). Wait ~200ms after `.focus()` before reading a focus ring, or it measures as transparent.
- Run Playwright through the repo's own config on its dedicated port. Do not hand-drive a browser to verify CSS; two consecutive hand readings have already been wrong in different directions.
- Do not deploy, do not push a deploy-wired branch, and do not run `sam deploy`. This amendment touches no backend, so its release is a frontend publish and it still waits for the applicable gate.

---

### Task 1: Parse a Message Into Text and Validated Link Runs

**Files:**
- Create: `src/lib/ui/linkify.ts`
- Create: `src/lib/ui/linkify.test.ts`

**Interfaces:**
- `type Run = { text: string; href?: string }`
- `linkify(plaintext: string) -> Run[]`
- `stripBidi(s: string) -> string`

- [ ] **Step 1: Write the failing property test before the parser**

Assert the invariant on the OUTPUT, not a list of expected answers, so a spelling nobody thought of still fails. For every run that carries an `href`: `new URL(run.href)` has `protocol` in `{'http:', 'https:'}`, empty `username`, empty `password`, non-empty `hostname`, and `run.href === run.text`.

Feed a payload list that must all come back as plain text with no `href`: `javascript:alert(1)`, `JavaScript:alert(1)`, `data:text/html,<script>`, `blob:https://cinder.ink/x`, `file:///etc/passwd`, `vbscript:msgbox`, `https://user:pass@evil.example`, `https://user@evil.example`, `https://\tevil.example`, `https://\nevil.example`, `https://\revil.example`, `https://\u202Eexample.evil`, `https://exa\u2066mple.com`, `//evil.example`, `https://` alone, and `https://.`.

Assert positively that `https://cinder.ink/n/abc#key`, `http://localhost:5178/f/x`, and a URL followed by prose punctuation (`see https://cinder.ink.`) each produce one link run whose text excludes the trailing sentence period. Assert that a plain message with no URL produces exactly one text run equal to the input, and that concatenating every run's `text` reproduces the input exactly for every fixture, so the parser can never drop or duplicate a character.

Assert `stripBidi` removes `\u202A-\u202E` and `\u2066-\u2069` and leaves every other codepoint untouched, including emoji and CJK.

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm test -- src/lib/ui/linkify.test.ts
```

- [ ] **Step 3: Implement the pure parser**

No DOM, no `document`, no dependency. Match only a literal `https?://` prefix; trim trailing `.,;:!?)]}'"` from a candidate; refuse a candidate containing `[\u0000-\u0020\u007F\u202A-\u202E\u2066-\u2069]`; then validate the exact candidate string with `new URL` and return it as both `text` and `href`. Anything that fails any check is emitted as ordinary text, never dropped.

```ts
// The href and the visible label are the SAME string. Validating the input and
// returning something else is how safePath was broken twice (.notes/GOTCHAS.md);
// here there is nothing else to return.
const ok = (candidate: string) => {
  if (/[\u0000-\u0020\u007F\u202A-\u202E\u2066-\u2069]/.test(candidate)) return false;
  try {
    const u = new URL(candidate);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password && !!u.hostname;
  } catch {
    return false;
  }
};
```

- [ ] **Step 4: Run and commit the parser**

```bash
pnpm test -- src/lib/ui/linkify.test.ts
pnpm check
git add src/lib/ui/linkify.ts src/lib/ui/linkify.test.ts
git commit -m "🔐 feat(notes): parse messages into safe text and link runs" -m "- match only literal http and https prefixes" -m "- validate the exact string that becomes the href"
```

### Task 2: Render a Message Without innerHTML

**Files:**
- Create: `src/lib/ui/molecules/MessageBody.svelte`
- Modify: `src/routes/n/[id]/+page.svelte:122-130`
- Modify: `tests/e2e/blip.spec.ts` (add cases beside the existing note tests)

**Interfaces:**
- `<MessageBody text={string} />` renders preformatted, wrapped text with validated links.

- [ ] **Step 1: Add failing browser cases**

Create a note whose body contains `visit https://cinder.ink/security for the threat model` and assert the rendered anchor's `href` is exactly `https://cinder.ink/security`, its accessible name is the same string, and it carries `rel` containing `noopener`, `noreferrer`, `nofollow`, and `ugc`, plus `target="_blank"`.

Create a note whose body is `<img src=x onerror=alert(1)> and javascript:alert(2)` and assert the page contains zero `img` elements inside the message region, zero anchors, and the literal text is visible. Assert `document.querySelectorAll('script')` count inside the message region is zero and no console error mentioning CSP was raised by the message itself.

Assert the revealed message preserves newlines and wraps long unbroken strings without producing horizontal document overflow at a 320px viewport.

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm exec playwright test tests/e2e/blip.spec.ts --project=e2e --grep "message"
```

- [ ] **Step 3: Implement the molecule and swap the note route onto it**

Keep the existing `<pre class="field whitespace-pre-wrap break-words ...">` presentation so the surface does not visually regress; only the children change from one interpolation to a run loop.

```svelte
<pre class="field whitespace-pre-wrap break-words px-4 py-4 text-base leading-relaxed">{#each runs as run}{#if run.href}<a
  href={run.href}
  target="_blank"
  rel="noopener noreferrer nofollow ugc"
  class="underline underline-offset-2 decoration-ember-ink/60 hover:decoration-ember-ink"
>{run.text}</a>{:else}{run.text}{/if}{/each}</pre>
```

Write the `{#each}` on one source line where whitespace matters. Svelte preserves whitespace inside `<pre>`, and a newline introduced by pretty-printing the template becomes a newline in the rendered message.

- [ ] **Step 4: Run and commit the note surface**

```bash
pnpm test
pnpm check
pnpm exec playwright test tests/e2e/blip.spec.ts --project=e2e
git add src/lib/ui/molecules/MessageBody.svelte src/routes/n/'[id]'/+page.svelte tests/e2e/blip.spec.ts
git commit -m "✨ feat(notes): make links in a revealed message clickable" -m "- render runs through escaping interpolation, never innerHTML" -m "- open links in a new tab with no referrer and no opener"
```

### Task 3: Carry a Message Inside the File Envelope

**Files:**
- Modify: `src/lib/crypto/file-crypto.ts:196-255` (`encryptFileParts`), `359-385` (`encryptFile`), `275-306` (`decryptPart`), `387-412` (`decryptFile`)
- Modify: `src/lib/crypto/file-crypto.test.ts`
- Modify: `src/lib/crypto/chunked-crypto.test.ts`

**Interfaces:**
- `encryptFile(file, passphrase?, message?) -> FileEnvelope`
- `encryptFileParts(file, passphrase?, message?) -> TransferEnvelope`
- `DecryptedFile` and part-zero `meta` gain an optional `text: string`
- `class MessageTooLargeError extends Error { readonly over: number }`

- [ ] **Step 1: Add failing envelope tests**

Round-trip a file with a message and assert the message returns byte-identical, including newlines, emoji, and a message containing `"` and `\`. Assert a file with no message returns `meta.text` absent rather than an empty string, so an old link and a new one are distinguishable without a version bump. Assert a v1 envelope produced before this change still decrypts and yields no `text`.

Assert tampering: flip one byte of the ciphertext and require a thrown GCM failure, not a message with altered text. Assert the message is present nowhere in the framed bytes as plaintext by searching the ciphertext for the UTF-8 encoding of a distinctive message string.

Assert the measured refusal. Build a header large enough that `50 + headerBytes + sliceBytes > MAX_CIPHERTEXT_BYTES` and require `MessageTooLargeError` with an `over` value equal to the exact overflow, thrown **before** `crypto.subtle.encrypt` is reached. Cover both the single-file path and part zero of a multipart transfer. Assert a message that fits by one byte succeeds.

Assert only part zero carries `text`, matching how `name` and `type` already work, so a 64-part transfer does not repeat the message under one key at a known offset.

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm test -- src/lib/crypto/file-crypto.test.ts src/lib/crypto/chunked-crypto.test.ts
```

- [ ] **Step 3: Add the field and the measured predicate**

Add `text` to the part-zero header JSON only when a message is present. Add one predicate used by both encryption paths, placed after the header bytes exist and before the encrypt call.

```ts
// Measured, not estimated: JSON escaping, a Unicode filename, and salt presence
// are all already counted here in a way no byte-count heuristic can claim.
// MAX_CIPHERTEXT_BYTES lives in api/src/handlers.mjs and is the server's own
// independent check. This one exists to fail before a byte is uploaded.
const framed = 2 + (salt ? SALT_BYTES : 0) + IV_BYTES + HEADER_LEN_BYTES + header.length + slice.length + TAG_BYTES;
if (framed > MAX_CIPHERTEXT_BYTES) throw new MessageTooLargeError(framed - MAX_CIPHERTEXT_BYTES);
```

Export `MAX_CIPHERTEXT_BYTES` from `file-crypto.ts` as a local constant with a comment naming `api/src/handlers.mjs:36` as its twin, in the same style the file already uses for `MAX_PARTS`. Do not import across the api boundary.

On decrypt, read `text` with the same defensive shape the neighboring fields use: accept it only when `typeof meta.text === 'string'`, and never default it to a placeholder.

- [ ] **Step 4: Run and commit the crypto slice**

```bash
pnpm test -- src/lib/crypto
pnpm check
git add src/lib/crypto
git commit -m "✨ feat(media): carry a message inside the file envelope" -m "- encrypt and authenticate the message with the bytes" -m "- refuse an oversized envelope from measured length before encrypting"
```

### Task 4: Make the Composer Multimedia by Default

**Files:**
- Modify: `src/routes/+page.svelte:40-176`
- Modify: `src/lib/ui/organisms/SendComposer.svelte:31-160`
- Modify: `tests/e2e/blip.spec.ts` (the `sendFile` helper at lines 11-24 checks a radio that will no longer exist)

**Interfaces:**
- One form: an always-present message field and an always-present file input, either or both filled.
- `ready = text.trim().length > 0 || file !== null`
- Routing: text only goes to `POST /notes`; anything with a file goes to `POST /files` and carries the message in the envelope.

- [ ] **Step 1: Add failing composer journeys**

Assert the mode radio group is gone and both inputs are reachable on first paint with no mode selection. Assert a message-only send still produces a `/n/` link and still issues zero `/files` requests. Assert a file-only send still produces a `/f/` link. Assert a message-plus-file send produces exactly one `/f/` link, issues exactly one `POST /files`, and issues zero `POST /notes`.

Assert the shared budget. Choose a 4 MiB file, type one character, and require a visible refusal naming both the file size and the message size, with zero requests to `**/files` and zero to `**/notes`, proving the refusal happened from metadata before any byte was read. Extend the existing 4 MiB boundary test (`tests/e2e/blip.spec.ts:161-190`) rather than replacing it; its assertion that choosing a file reaches the server zero times is the one that catches a pre-flight accidentally moved after an upload.

Assert the existing multipart piece-count copy still appears when a file exceeds the free ceiling, and that the Pro credit sentence is unchanged.

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm exec playwright test tests/e2e/blip.spec.ts --project=e2e
```

- [ ] **Step 3: Remove the mode and add the pre-flight**

Delete the `SegmentedChoice` usage and the `mode` state. `SegmentedChoice.svelte` stays in the tree only if another surface uses it; if this was its only caller, delete the component in the same commit rather than leaving an orphan.

Keep both fields visible and label them for what they now are. The message field's placeholder must stop implying it is the only thing being sent.

Add the advisory pre-flight beside the existing `pickFile` size check, so it fires the moment either input changes:

```ts
// Advisory only. The measured refusal in file-crypto.ts is the guarantee; this
// exists to disable the button before anyone waits on an encrypt.
// 2048 is deliberately conservative for the multipart case, where part zero
// already spends 4 MiB of the 4,198,400-byte envelope.
const overBudget = $derived.by(() => {
  if (!file) return false;
  return parts > 1 ? utf8Length(text) > 2048 : utf8Length(text) + file.size > MAX_FILE_BYTES;
});
```

- [ ] **Step 4: Run and commit the composer**

```bash
pnpm test
pnpm check
pnpm exec playwright test --project=e2e
git add src/routes/+page.svelte src/lib/ui/organisms tests/e2e/blip.spec.ts
git commit -m "✨ feat(send): send a message and a file on one link" -m "- replace the note-or-file choice with one composer" -m "- refuse a combined payload over the shared envelope budget"
```

### Task 5: Deliver the Message and the File Together

**Files:**
- Modify: `src/routes/f/[locator]/+page.svelte:108-120` (`save` and its now-false comment), `158-217` (`revealChunked` returns `text`), `227-324` (`reveal`), `367-386` (the delivered branch)
- Modify: `src/lib/ui/organisms/TransferRecord.svelte`
- Modify: `tests/e2e/blip.spec.ts`

**Interfaces:**
- `DecryptedFile` carries optional `text`; the delivered view renders `<MessageBody>` above the record when present.
- The delivered view's primary control is an explicit Save; the automatic save attempt still runs first.

- [ ] **Step 1: Add failing delivery journeys**

Assert a message-plus-file link delivers both: the message text is visible, its embedded URL is a real anchor, and the file downloads with byte-identical SHA-256 to what was sent, matching the existing hash assertion at `tests/e2e/blip.spec.ts:105-111`.

Assert the automatic save still fires exactly once on the file path, and that a message-only reveal on `/n/` triggers zero download events. Assert the delivered view exposes a control whose accessible name states saving plainly, that activating it saves again from the copy in the tab, and that it takes focus after the view change the way `headingEl` already does.

Assert the record still reports `Deleted, absence verified` and that the announcement names the file, its size, and that the message is included. Assert a filename containing `\u202E` renders with the control stripped in both the record row and the `download` attribute.

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm exec playwright test tests/e2e/blip.spec.ts --project=e2e --grep "message and file"
```

- [ ] **Step 3: Thread the message through and correct the false comment**

Return `text` from `revealChunked` and from the single-file path, render it with `MessageBody` above `TransferRecord`, and pass filenames through `stripBidi` at both display and `download` sinks.

Rewrite the comment at `src/routes/f/[locator]/+page.svelte:108-109`. Two of its three clauses are still true and the third moved:

```ts
// The download is still inert and still local: a Blob the browser saves, never
// a server round trip, never anything that executes what was sent. What changed
// is that a delivered PDF may also be RENDERED, and that path never uses the
// blob below. See previewBlob(), which types its blob from sniffed magic bytes
// rather than from the sender's `type` string.
```

Do not touch `RevealGate.svelte`'s pinned warning. If combined transfers need a sentence before the button, add it as a separate element; the pinned string must remain present, byte for byte, in that same file.

- [ ] **Step 4: Run and commit the delivery surface**

```bash
pnpm test
pnpm check
pnpm exec playwright test --project=e2e
git add src/routes/f src/lib/ui tests/e2e/blip.spec.ts
git commit -m "✨ feat(media): deliver the message beside the file" -m "- keep the automatic save and add an explicit save control" -m "- strip bidi controls from every filename sink"
```

### Task 6: Decide the PDF Isolation Empirically

**Files:**
- Create: `tests/e2e/pdf-preview-spike.spec.ts` (deleted at the end of this task; it is evidence, not a suite)
- Verify: `vite.config.ts:74-90`

**Interfaces:**
- Produces: a written verdict naming one isolation, or a decision to drop the in-page preview.

This task exists because the answer cannot be reasoned into being. `default-src 'none'` blocks framing today; Chrome partitions blob URL fetches by storage key, so a sandboxed frame with an opaque origin may be unable to load a parent-created blob at all; and Chrome's PDF viewer is a mime-handler that may itself require scripting in the frame. Every one of those is a measurement, and this repo has already paid for assuming a directive took (`.notes/GOTCHAS.md`, the presigner's `signableHeaders`).

- [ ] **Step 1: Try the candidates in strict preference order and stop at the first that renders**

Generate a minimal valid PDF at runtime; commit no binary fixture. For each candidate, assert a PDF page actually rendered, not merely that an element exists.

1. `<iframe src={blobUrl} sandbox="allow-same-origin">` with the meta policy gaining `'frame-src': ['blob:']`. This is the target: the frame can fetch the blob, and without `allow-scripts` nothing in it can execute even if the bytes were something else.
2. `<iframe src={blobUrl} sandbox="allow-same-origin allow-scripts">`, same directive. **Record this as a real reduction if it is needed.** Those two tokens together let a frame reach out and remove its own sandbox attribute, so the sandbox stops being the boundary and the MIME allowlist becomes the only one. It is acceptable only because the blob's type is a Cinder literal gated on `%PDF-` magic bytes and the frame inherits `script-src 'self'` with no `unsafe-inline` and no `unsafe-eval`.
3. Drop the in-page frame. Ship the fallback from Task 7 alone, which needs **no CSP change at all**, because a top-level navigation is governed by neither `frame-src` nor `object-src`.

Do not evaluate `<object>` or `<embed>`; neither accepts `sandbox`, and `object-src` would have to be opened for a strictly weaker result.

- [ ] **Step 2: Run the spike on all three engines**

```bash
pnpm exec playwright test tests/e2e/pdf-preview-spike.spec.ts --project=e2e --browser=all
```

- [ ] **Step 3: Write the verdict into this plan file and delete the spike**

Append a short "PDF isolation verdict" section here recording which candidate won on Chromium, Firefox, and WebKit, the exact CSP directive string if one is needed, and the date. If candidate 1 wins anywhere and loses elsewhere, ship candidate 1 where it works and the Task 7 fallback where it does not; never widen the sandbox to make one engine match another.

```bash
rm tests/e2e/pdf-preview-spike.spec.ts
git add docs/superpowers/plans/2026-07-28-cinder-multimedia-notes.md
git commit -m "📝 docs(media): record the measured PDF isolation verdict" -m "- name the exact directive the preview requires" -m "- keep the no-CSP-change fallback as the floor"
```

### Task 7: Preview a Delivered PDF From Bytes Already Held

**Files:**
- Create: `src/lib/ui/molecules/PdfPreview.svelte`
- Modify: `src/routes/f/[locator]/+page.svelte` (delivered branch)
- Modify: `vite.config.ts:74-90` (only if Task 6 chose candidate 1 or 2)
- Modify: `tests/e2e/blip.spec.ts`

**Interfaces:**
- `looksLikePdf(bytes: Uint8Array) -> boolean` is true only when the first five bytes are `%PDF-`
- `<PdfPreview bytes={Uint8Array} name={string} onsave={() => void} />`

- [ ] **Step 1: Add failing preview and refusal tests**

Assert a delivered PDF renders a preview and that the frame's `src` is a `blob:` URL on Cinder's own origin. Assert the blob's type is exactly `application/pdf` regardless of what the sender declared: send a file whose declared MIME type is `text/html` but whose bytes begin `%PDF-` and assert the preview still types it `application/pdf`; send a file whose declared type is `application/pdf` but whose bytes are `<html><script>` and assert **no preview element is created at all** and the download path still works.

Assert no request leaves the page when the preview mounts, using the request counter pattern already at `tests/e2e/blip.spec.ts:80-90`. Assert the object URL is not revoked while the preview is mounted, and is revoked when the view unmounts. Assert a non-PDF delivery renders no preview and no empty container.

Assert the preview is reachable without a mouse: a keyboard-only path from the delivered heading to the Save control and to the "open in your browser's PDF viewer" control, with a visible focus ring on each.

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm exec playwright test tests/e2e/blip.spec.ts --project=e2e --grep "pdf"
```

- [ ] **Step 3: Implement the sniff, the literal type, and the lifecycle**

```ts
// The sender's `type` string decides NOTHING here. It reaches this component as
// escaped display text only. A rendered blob is typed from bytes we read, because
// a blob typed text/html renders at blob:https://cinder.ink/..., which is the same origin,
// same local storage, same API reach.
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const looksLikePdf = (b: Uint8Array) => b.length >= 5 && PDF_MAGIC.every((c, i) => b[i] === c);
```

Create the object URL in `$effect` and revoke it in the effect's teardown, never synchronously after use. `save()` at `src/routes/f/[locator]/+page.svelte:110-120` revokes immediately, which is correct for a click-triggered download and fatal for a mounted frame; keep them as two separate object URLs with two separate lifetimes rather than sharing one.

Always render the "open in your browser's PDF viewer" control, whichever candidate Task 6 chose. It is a user-gesture `window.open` on the same blob URL, it needs no CSP directive, and it is the floor that keeps the feature working where the frame does not.

- [ ] **Step 4: Add the directive, if Task 6 earned it**

Add exactly `'frame-src': ['blob:']` to the meta policy in `vite.config.ts`. Add nothing else. `blob:` is a scheme source that only same-origin script can mint via `URL.createObjectURL`, so it grants no network reach and names no external origin; a script that could abuse it already has strictly more power than framing bytes it constructed itself. Leave `default-src 'none'`, `script-src ['self']`, `connect-src`, `object-src` (absent, therefore `'none'`), `base-uri`, and `form-action` untouched, and do not open `template.yaml`.

- [ ] **Step 5: Prove the built policy actually changed and commit**

Do not trust that the directive took. Read it out of the built HTML.

```bash
pnpm build
grep -o 'content="[^"]*"' build/index.html | grep -o "default-src[^\"]*"
pnpm test
pnpm check
pnpm exec playwright test --project=e2e
git add src/lib/ui/molecules/PdfPreview.svelte src/routes/f vite.config.ts tests/e2e/blip.spec.ts
git commit -m "✨ feat(media): preview a delivered PDF in the browser" -m "- type the rendered blob from sniffed magic bytes, never the sender" -m "- keep frame-ancestors, script-src, and connect-src unchanged"
```

### Task 8: Prove the New Surfaces Are Reachable and Legible

**Files:**
- Modify: `tests/e2e/blip.spec.ts` or a sibling spec under `tests/e2e/`
- Verify: `src/app.css:32-130` (the two token sets)

**Interfaces:**
- Produces: measured numbers for every assertion below, in both color schemes, recorded in the release evidence.

Each of these is a test that passes or fails, not a goal.

- [ ] **Step 1: Assert contrast from rendered pixels in both schemes**

Every new text surface meets WCAG AA measured from pixels: message body text, link text in its rest and hover states, the delivered heading, the Save control's label, the preview's caption, and every refusal message. Run under `colorScheme: 'dark'` and `colorScheme: 'light'`. Read the background from a plate: screenshot twice, the second time with `color` and `-webkit-text-fill-color` forced transparent, because `.record` and its siblings carry the grid as a background image that `getComputedStyle().backgroundColor` does not report.

A link must be distinguishable from surrounding text by something other than color alone. The underline in Task 2 satisfies this; assert it is present rather than assuming the utility class applied.

- [ ] **Step 2: Assert no horizontal overflow and 200% text**

At 320, 375, 440, 768, and 1440 CSS pixels, assert `document.documentElement.scrollWidth <= clientWidth` on the composer with both fields filled, on a revealed message containing a 400-character unbroken URL, and on the delivered view with a preview mounted. At 320 with text scaled to 200%, assert the same, and assert the Save control and the preview's open control are both fully inside the viewport, since `overflow-hidden` on `main` has already made an off-screen qualifier unreachable once in this repo.

A PDF preview frame may scroll inside its own container; the document body may not.

- [ ] **Step 3: Assert targets, focus, motion, and forced colors**

Every new interactive control has a hit target of at least 48 by 48 CSS pixels, measured from its bounding box. (The repo's existing floor is 44; new controls take the higher number and existing controls must not regress below their current size.)

Every new control shows a visible focus ring. Wait at least 200ms after `.focus()` before reading the computed style or screenshotting, because `.btn` and `.field` transition `box-shadow` over `--dur-fast` and the first frame reads as fully transparent with every length zeroed.

Under `prefers-reduced-motion: reduce`, assert every new transition resolves to a zero duration. Svelte transitions are WAAPI animations that no CSS rule reaches, so they must go through the existing `dur()` helper.

Under `forced-colors: active`, assert the message region, the link runs, the Save control, and the preview container all remain visible and distinguishable.

- [ ] **Step 4: Assert the screen-reader equivalent of everything a sighted user gets**

A PDF preview is invisible to a screen reader by nature, so the page must carry the same facts in text: the filename, the file type, the byte size, and a reachable Save control, all present in the accessibility tree with the preview mounted. Assert the preview frame carries a `title` naming the file, that the delivered announcement in the existing `LiveRegion` names the message and the file, and that the announcement region stays outside the view branches so it survives the change it is announcing.

Assert an anchor inside a message has an accessible name equal to its visible URL, so a screen-reader user hears the destination rather than "link".

- [ ] **Step 5: Run and commit the experience gate**

```bash
pnpm exec playwright test --project=e2e
git add tests/e2e
git commit -m "♿ test(media): pin contrast, reflow, focus, and equivalents" -m "- measure both schemes from rendered pixels, not stylesheets" -m "- give the PDF preview a text equivalent that carries the same facts"
```

### Task 9: Make Every Claim Literal Again

**Files:**
- Modify: `docs/api.md:177`
- Modify: `docs/security.md:13-46`
- Modify: `docs/architecture.md`
- Modify: `static/llms.txt`
- Modify: `src/routes/security/+page.svelte`
- Modify: `README.md`

- [ ] **Step 1: Correct the two statements this amendment falsifies**

Reword `docs/api.md:177` so the prohibition it actually means survives: no presigned `GET`, no Range, no retry, no resume, and no server-side preview. The only way ciphertext leaves the bucket is the claim path, and a recipient rendering bytes they already hold is not a second retrieval.

Rewrite the "An inert download" comment as specified in Task 5 Step 3 if it has not already been done.

- [ ] **Step 2: State the new surface plainly in the threat model**

Add to `docs/security.md`, in the voice of the surrounding sections: a message traveling with a file is encrypted and authenticated inside the same envelope as the bytes and shares its 4 MiB budget; a revealed message renders as escaped text with links validated to `http`/`https` with no credentials; a PDF preview renders bytes the recipient already holds, in a blob typed by Cinder from sniffed magic bytes and never by the sender's declared type; and the exact CSP directive the preview requires, if any, with the sentence that `frame-ancestors 'none'` is unchanged.

Say the residual honestly: a preview is a rendering surface where there was none, and the defense is that the type is a Cinder literal rather than that the parser is trusted.

- [ ] **Step 3: Update the size sentence without changing the number**

`docs/security.md` currently says "4 MiB per object, derived from the transport rather than chosen." Keep the number and the derivation, and add that a message shares it, so a full-size file leaves no room for one and the browser refuses the combination before reading a byte.

- [ ] **Step 4: Run the claim guard and commit**

```bash
pnpm test -- src/lib/claims.test.ts
git diff --check
git add docs static/llms.txt README.md src/routes/security
git commit -m "📝 docs(media): describe the multimedia surface exactly" -m "- scope the preview prohibition to the server" -m "- state the shared envelope budget and the rendering defense"
```

### Task 10: Run the Release Gate and Stop

**Files:**
- Verify: the full tree

- [ ] **Step 1: Run the complete local gate**

```bash
pnpm test
pnpm check
pnpm exec playwright test --project=e2e
pnpm exec playwright test --project=journey
pnpm build
node --test api/test/*.test.mjs
sam validate --lint
git diff --check
```

`node --test` and `sam validate` are here to prove a negative: this amendment touched no backend, so both must pass unchanged, and `git diff --stat origin/main -- api template.yaml` must be empty.

- [ ] **Step 2: Read the shipped policy out of the artifact**

```bash
grep -o "default-src[^\"]*" build/index.html
grep -c "frame-ancestors" template.yaml
```

The first must show `default-src 'none'`, `script-src 'self'` with a hash and nothing else, the unchanged `connect-src` origin list, and at most the one added `frame-src blob:`. The second must be unchanged from `main`.

- [ ] **Step 3: Report and stop at the gate**

Report local commits, the exact test counts, the Task 6 verdict with its per-engine results, the measured accessibility numbers, and the diff stat against `origin/main` for `api/` and `template.yaml`. Do not publish the frontend, do not push a deploy-wired branch, and do not run `sam deploy` without Matt's explicit authorization or an independent `DEPLOY` verdict covering this exact lane.

---

## Marlin decision request

Return `DEPLOY`, `HOLD`, or `ROLLBACK` on the multimedia lane. Marlin did not implement it and must not accept the implementer's summary in place of the artifacts below. Demand each one by name.

**Refuse to certify without:**

1. `git diff --stat origin/main -- api/ template.yaml samconfig.toml` returning empty output. Any byte of backend or infrastructure change puts this lane outside its declared scope.
2. The built CSP, read out of `build/index.html`, showing `default-src 'none'` and `script-src 'self' 'sha256-…'` intact, the `connect-src` origin list unchanged from `main`, and at most one added directive, exactly `frame-src blob:`. Plus `curl -sSI https://cinder.ink/` still returning `frame-ancestors 'none'`, HSTS with `preload`, and the Permissions-Policy line, on all four aliases.
3. A grep proving no untrusted-content sink was introduced: zero hits for `{@html`, `innerHTML`, `insertAdjacentHTML`, `document.write`, and `new Function` across `src/`. A single hit is a `HOLD`, regardless of what surrounds it.
4. The two adversarial preview tests, green and named: bytes beginning `%PDF-` with a declared type of `text/html` still preview as `application/pdf`; bytes beginning `<html><script>` with a declared type of `application/pdf` produce no preview element at all.
5. The linkify property test asserting the invariant on the OUTPUT over the payload list, including `https://user:pass@evil.example`, a tab inside the authority, and a bidi override. A test asserting a list of expected answers instead of the property is a `HOLD`; that exact substitution is how `safePath` shipped broken twice.
6. Proof the shared budget refuses at the boundary from metadata alone: a 4 MiB file plus one character produces a visible refusal with zero `POST /files` and zero `POST /notes` requests.
7. `src/lib/claims.test.ts` green, with `APPROVED_REVEAL_WARNING` still present byte for byte in `src/lib/ui/organisms/RevealGate.svelte`.
8. Contrast ratios measured from rendered pixels via the plate technique, in **both** color schemes, for every new text surface, with the numbers printed. A ratio read from `getComputedStyle` is not evidence here and must be rejected on sight.
9. Zero horizontal document overflow at 320, 375, 440, 768, and 1440, plus 320 at 200% text, with the Save control and the preview's open control inside the viewport.
10. Task 6's verdict recorded in this file with per-engine results. If the verdict is candidate 2, Marlin must weigh the `allow-same-origin allow-scripts` reduction explicitly rather than inheriting it, and may reasonably return `HOLD` in favor of candidate 3, which needs no CSP change.
11. The existing one-attempt evidence re-run unchanged: `node --test api/test/*.test.mjs` green, and the e2e transfer suite still asserting exactly one claim per reveal and `Deleted, absence verified` on the record.

**Return `ROLLBACK` if any of these is true:**

- Ciphertext can leave the media bucket by any path other than `POST /files/claim`.
- A preview or a download can be produced without a claim having already destroyed the stored copy.
- `ClaimFileFn` gained any action, or any role gained `s3:PutObject` or `dynamodb:PutItem`.
- The preview blob's type can be influenced by the sender's declared MIME string.
- A locator, capability, object key, filename, message, or MIME type appears in any log line or any response body that did not already carry it.

**This lane's release is a frontend publish only.** There is no CloudFormation change set to review and no `sam deploy` to run. That narrows the blast radius to the static site and the invalidation, and it should narrow the evidence Marlin demands to exactly the artifacts above rather than a stack diff that will be empty.
