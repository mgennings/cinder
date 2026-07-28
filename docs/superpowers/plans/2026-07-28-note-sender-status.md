# Cinder Note Sender Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the creating browser a glanceable `available` or `gone` state for one-time note links without putting status authority in the recipient URL or weakening note burn semantics.

**Architecture:** Extend the existing sender-status capability instead of adding another service. New tokens use a versioned `kind` claim for `note` or `file`; verification continues accepting unexpired v1 file tokens. The existing read-only status Lambda serves both `/files/status` and `/notes/status`, while each route rejects the other kind. The creating browser keeps the note token in local storage and checks once on mount. A recipient browser with only the link makes no status request.

**Tech Stack:** SvelteKit 5, TypeScript, Node.js Lambda, DynamoDB, AWS SAM, Vitest, Node test runner, Playwright

## Global Constraints

- Status means only that Cinder's stored note is currently available or gone. Never label it opened, read, downloaded, or received.
- Repeated sender checks can infer the interval when availability changed. Return no identity or timestamp and say this plainly in the security documentation.
- The status capability never enters `/n/{id}#{key}`, logs, analytics, Disclosure Central, or recipient-visible storage.
- A network or infrastructure failure leaves `Reveal note` enabled. Only an authenticated `gone` response disables it.
- Preserve atomic note burn and the generic gone response. Status reads never mutate DynamoDB.
- Preserve every unexpired v1 file-status token already in a sender browser.
- Reuse `StatusFileFn`, its 14-day log group, and its `dynamodb:GetItem`-only role. Do not add a Lambda, table, dependency, or write permission.
- Do not deploy or push public `main` until the applicable gate is open. Never place secret values in files, argv, shell history, logs, commits, or this plan.

---

### Task 1: Version the Status Capability Without Breaking Existing Files

**Files:**
- Modify: `api/src/status-token.mjs:3-47`
- Modify: `api/test/status-token.test.mjs:1-35`

**Interfaces:**
- `mintStatusToken({ secret, kind, locator, parts?, expiresAt }) -> string`
- `verifyStatusToken(token, { secret, nowEpoch? }) -> { kind, locator, parts?, expiresAt } | null`
- v1 normalization: `{ locator, parts, exp } -> { kind: 'file', locator, parts, expiresAt: exp }`

- [ ] **Step 1: Write failing version and scope tests**

Add cases for a v2 note token with a 22-character note id, a v2 file token, malformed kind-specific claims, cross-kind substitution, expiry, tampering, and unknown keys. Keep a literal v1 file-token fixture signed with the current `cinder-status-v1:` domain and assert it still verifies as `kind: 'file'`.

- [ ] **Step 2: Run the focused test and confirm the new cases fail**

```bash
node --test api/test/status-token.test.mjs
```

- [ ] **Step 3: Implement the smallest compatible verifier**

Use an exact key set per version and kind. Decode only enough untrusted payload to select the allowed v1 or v2 signing domain, then verify the HMAC with `timingSafeEqual` before returning claims.

```js
// New tokens. Existing v1 signatures remain valid through the verifier.
const claims = kind === 'note'
  ? { aud: AUDIENCE, v: 2, kind, locator, exp: expiresAt }
  : { aud: AUDIENCE, v: 2, kind, locator, parts, exp: expiresAt }
```

Reject a note id unless it matches the existing 22-character base64url format. Reject a file locator unless it matches the existing 43-character format and `parts` remains within `1...64`.

- [ ] **Step 4: Run and commit the compatibility seam**

```bash
node --test api/test/status-token.test.mjs
git add api/src/status-token.mjs api/test/status-token.test.mjs
git commit -m "🔐 feat(status): scope sender tokens by artifact" -m "- preserve unexpired v1 file capabilities" -m "- reject cross-kind and malformed status claims"
```

### Task 2: Project Note Availability Through the Existing Read-Only Lambda

**Files:**
- Modify: `api/src/store.mjs:11-40`
- Modify: `api/src/handlers.mjs:88-124`
- Modify: `api/src/handlers.mjs:265-289`
- Modify: `api/src/handlers.mjs:415`
- Modify: `api/src/lambda.mjs:23-31`
- Modify: `api/src/lambda.mjs:109-115`
- Modify: `template.yaml:212-229`
- Modify: `template.yaml:382-407`
- Test: `api/test/store.test.mjs`
- Test: `api/test/handlers.test.mjs:88-147`
- Test: `api/test/handlers.test.mjs:226-254`
- Test: `api/test/status-token.test.mjs:28-35`

**Interfaces:**
- `putNote(...)` writes `kind: 'note'` for newly created notes.
- `noteAvailable(doc, id, nowEpoch) -> boolean` performs one consistent `GetItem` projection.
- `POST /notes` returns `{ id, statusToken }`.
- `POST /notes/status` accepts `{ statusToken }` and returns `{ status: 'available' | 'gone' }`.
- `POST /files/status` keeps its current response contract.

- [ ] **Step 1: Add failing store and handler tests**

Prove that a new note is available, remains available after 100 status reads, becomes gone after the existing atomic burn, and never returns content. Prove malformed, expired, forged, and file-kind tokens all return the identical note `gone` response. Prove a note token sent to `/files/status`, and a file token sent to `/notes/status`, also returns `gone`.

- [ ] **Step 2: Run and confirm failure**

```bash
node --test api/test/store.test.mjs api/test/handlers.test.mjs api/test/status-token.test.mjs
```

- [ ] **Step 3: Add the read-only projection and shared internal handler**

Keep two exported route handlers with one private implementation.

```js
async function statusArtifact(event, expectedKind) {
  const claims = statusTokens.verify(parseStatusToken(event));
  if (!claims || claims.kind !== expectedKind) return statusGone();

  const available = expectedKind === 'note'
    ? await noteAvailable(doc, claims.locator, nowEpoch())
    : await everyFileGrantAvailable(doc, claims, nowEpoch());

  return json(200, { status: available ? 'available' : 'gone' });
}
```

Do not make `burnNote` require `kind: 'note'`; legacy notes created before this release must still burn once. The status projection may require `kind: 'note'` because only new notes receive note-status tokens.

- [ ] **Step 4: Wire one function to two routes with the same least-privilege role**

Add `STATUS_SECRET` to `CreateNoteFn` so it can mint the separate token. Add a `POST /notes/status` event to `StatusFileFn` and export `statusNote` from `api/src/lambda.mjs`. Keep its IAM action list exactly `[dynamodb:GetItem]`. Update the infrastructure test to assert both routes exist and that no DynamoDB write or `s3:` action enters the function block.

- [ ] **Step 5: Validate and commit the server slice**

```bash
node --test api/test/store.test.mjs api/test/handlers.test.mjs api/test/status-token.test.mjs
sam validate --lint
git add api/src api/test template.yaml
git commit -m "✨ feat(notes): add read-only sender availability" -m "- mint a separate note status capability" -m "- reuse the GetItem-only status Lambda"
```

### Task 3: Remember Note Status Only in the Creating Browser

**Files:**
- Modify: `src/lib/api.ts:17-39`
- Modify: `src/lib/api.ts:189-199`
- Modify: `src/lib/api.test.ts:70-86`
- Modify: `src/lib/status-store.ts:1-55`
- Modify: `src/lib/status-store.test.ts:1-28`
- Modify: `src/routes/+page.svelte:123-129`

**Interfaces:**
- `createNote(...) -> Promise<{ id: string; statusToken: string }>`
- `checkNoteStatus(statusToken) -> Promise<'available' | 'gone'>`
- `rememberNoteStatus(id, token) -> void`
- `noteStatusToken(id) -> string | null`

- [ ] **Step 1: Add failing client and local-storage tests**

Assert the note status request contains only `{ statusToken }`, targets `/notes/status`, accepts only the two bounded states, and rejects a malformed response. Assert storage accepts a valid 22-character note id and expiring token, prunes it at expiry, retains existing raw file-locator entries, and caps the combined store at 64 entries.

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm test -- src/lib/api.test.ts src/lib/status-store.test.ts
```

- [ ] **Step 3: Implement the narrow client seam**

Return both fields from `createNote`, remember the token before exposing the link, and key note entries as `n:{id}` inside the existing `cinder.sender-status.v1` document. Keep current raw file-locator keys readable so deployed file sender state is not discarded.

```ts
const grant = await createNote(payload, Number(ttl));
rememberNoteStatus(grant.id, grant.statusToken);
link = buildLink(location.origin, grant.id, fragmentKey);
```

- [ ] **Step 4: Run and commit the creating-browser slice**

```bash
pnpm test -- src/lib/api.test.ts src/lib/status-store.test.ts
pnpm check
git add src/lib/api.ts src/lib/api.test.ts src/lib/status-store.ts src/lib/status-store.test.ts src/routes/+page.svelte
git commit -m "✨ feat(notes): retain sender status on device" -m "- keep the capability out of recipient links" -m "- preserve existing file status entries"
```

### Task 4: Show Gone on Note Arrival Without Consuming Anything

**Files:**
- Modify: `src/routes/n/[id]/+page.svelte:1-69`
- Modify: `tests/e2e/blip.spec.ts:26-49`
- Modify: `tests/live/live.spec.ts:5-23`

**Interfaces:**
- Sender context with local status token: one advisory check on mount.
- Recipient context with only the note link: zero `/notes/status` requests before Reveal.

- [ ] **Step 1: Add failing browser journeys**

In one browser context, create a note and capture its link. In a separate context, assert arrival makes zero note-status calls, Reveal burns once, and plaintext appears. Back in the creating context, reopen the link and assert `This note is gone` is visible immediately and `Reveal note` is absent. Add a routed status-network failure and assert `Reveal note` remains enabled.

- [ ] **Step 2: Run and confirm failure**

```bash
pnpm exec playwright test tests/e2e/blip.spec.ts --grep "note.*sender status"
```

- [ ] **Step 3: Reuse the file route's advisory mount pattern**

Use `onMount`, `noteStatusToken(id)`, and `checkNoteStatus(token)`. Set `view = 'gone'` only after an authenticated `gone`. Catch status errors without changing the gate. Do not call `burnNote` until the existing button action.

- [ ] **Step 4: Verify the complete local journey and commit**

```bash
pnpm test
pnpm check
pnpm exec playwright test --project=e2e
pnpm build
git add src/routes/n tests/e2e/blip.spec.ts tests/live/live.spec.ts
git commit -m "✨ feat(notes): show sender when a note is gone" -m "- keep recipient arrival non-consuming" -m "- leave Reveal available when status is unreachable"
```

### Task 5: Make the Privacy and API Contract Literal

**Files:**
- Modify: `docs/api.md:3-178`
- Modify: `docs/architecture.md:44-115`
- Modify: `docs/security.md:17-31`

- [ ] **Step 1: Update endpoint inventory and response shapes**

Document `POST /notes/status`, the `{ id, statusToken }` create response, v1 file-token compatibility, the shared read-only function, and the exact `available` or `gone` semantics.

- [ ] **Step 2: State the observability cost without overstating it**

Use this boundary: the creating browser can learn that availability changed between two checks. It cannot learn who held the link, whether the note was read, when the change happened, or whether a recipient retained a copy.

- [ ] **Step 3: Run the claim guard and commit**

```bash
pnpm test -- src/lib/claims.test.ts
git diff --check
git add docs/api.md docs/architecture.md docs/security.md
git commit -m "📝 docs(status): define note availability truth" -m "- distinguish gone from opened or read" -m "- disclose sender interval inference"
```

### Task 6: Release and Prove the Live Boundary

**Files:**
- Verify: `template.yaml`
- Verify: `scripts/deploy-frontend.sh`
- Verify: deployed stack `blip`

- [ ] **Step 1: Run the complete release gate**

```bash
pnpm test
pnpm check
pnpm exec playwright test --project=e2e
pnpm build
node --test api/test/*.test.mjs
sam build
sam validate --lint
git diff --check
```

- [ ] **Step 2: Inspect the backend change set without exposing parameters**

Follow the production update procedure in `docs/pro-payments.md` that preserves every current stack parameter with `UsePreviousValue: true`. Never reconstruct or print a secret. Before execution, require the change set to show only the expected Lambda code/configuration and API route updates, with no table replacement, bucket replacement, or IAM widening beyond `CreateNoteFn` reading the existing status secret.

- [ ] **Step 3: Deploy backend and frontend through the existing release paths**

Execute the reviewed CloudFormation change set, wait for `UPDATE_COMPLETE`, then publish the static site and wait for its invalidation.

```bash
./scripts/deploy-frontend.sh
```

- [ ] **Step 4: Prove live sender and recipient behavior**

Create a disposable encrypted note on `https://cinder.ink`. In a clean recipient context, assert zero `/notes/status` calls before Reveal, reveal once, and confirm a second burn returns `410`. In the creating context, reopen the link and assert the gone state appears without Reveal. On a fresh note, block the status endpoint and assert Reveal remains available.

- [ ] **Step 5: Prove IAM, logs, and deployed-source parity**

Confirm the status function has only `dynamodb:GetItem`, no S3 access, no writes, and 14-day logs. Search its live log events for zero field names matching `statusToken|locator|ciphertext|iv|salt|plaintext|recipient|identity`. Diff each changed deployed Lambda module against the release source.

- [ ] **Step 6: Record the release and stop at the push gate**

Record live route, HTTP, browser, IAM, log, and source-parity evidence in the current private release ledger. If `main` or another deploy-wired branch has not been explicitly authorized for push, leave the verified commits local and report the exact ahead count.
