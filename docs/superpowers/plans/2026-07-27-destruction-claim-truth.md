# Cinder Destruction Claim Truth Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Load experience-craft for user-facing copy review.

**Goal:** Replace Cinder's unprovable “permanently, from everywhere” claim with a precise statement of its verified atomic server-deletion guarantee and unavoidable recipient/capture limits.

**Architecture:** Copy-only truth repair. The DynamoDB conditional delete, client-side encryption, bot-safe reveal, API, UI, deployment, and product boundaries do not change.

**Tech Stack:** Markdown, existing Svelte/Vitest/Playwright checks.

**Global constraints:** Do not add Compass, analytics, accounts, profiles, shared context, or dependencies. Preserve Cinder's direct voice. State what the server guarantees and what no software can guarantee.

## Task 1: Establish the proof boundary

**Files:**

- Read: `README.md`
- Read: `docs/security.md`
- Read: `docs/architecture.md`
- Read: `docs/api.md`
- Read: `api/src/store.mjs`
- Read: `tests/e2e/blip.spec.ts`

- [ ] Trace create, preview-safe hold, explicit reveal, atomic delete-and-return, and post-read denial.
- [ ] Confirm the server deletes its stored DynamoDB item exactly once.
- [ ] Confirm the server cannot prevent a sender, recipient, intermediary, browser, screenshot, clipboard, or prior ciphertext capture from retaining a copy.
- [ ] Confirm `docs/security.md` already states this limit and use it as the truth source.
- [ ] Record no new claim that depends on live AWS state unless the live test proves it.

## Task 2: Add a claim regression check

**Files:**

- Create: `src/lib/claims.test.ts`
- Modify: `package.json`

- [ ] Write one small test that reads `README.md` and rejects `permanently, from everywhere` and equivalent universal-deletion language.
- [ ] Assert the README names the server-side atomic deletion boundary and the possibility of copies outside Cinder.
- [ ] Run the test before the copy change and observe failure.
- [ ] Add `"test": "vitest run"` to `package.json`; the current package has Vitest installed but no root test script.

## Task 3: Correct the README

**Files:**

- Modify: `README.md:16`

- [ ] Replace the universal sentence with direct wording: the first successful reader atomically removes Cinder's stored copy; Cinder cannot erase copies someone already captured.
- [ ] Preserve the surrounding zero-knowledge and client-side encryption claims only where supported by the code and security document.
- [ ] Avoid “gone forever,” “everywhere,” “impossible to recover,” or any claim about recipient behavior.
- [ ] Keep the paragraph readable as product truth, not legal fine print.

## Task 4: Check every public and technical surface

**Files:**

- Verify: `src/routes/+page.svelte`
- Verify: `src/routes/n/[id]/+page.svelte`
- Verify: `src/routes/security/+page.svelte`
- Verify: `static/llms.txt`
- Verify: `docs/security.md`
- Verify: `docs/architecture.md`
- Verify: `docs/api.md`

- [ ] Search for universal destruction synonyms across tracked files.
- [ ] Keep “destroyed” where it clearly means the server-stored note was atomically deleted.
- [ ] Qualify any surface that could reasonably be read as erasing recipient or intermediary copies.
- [ ] Preserve the one-reader concurrency guarantee where the atomic operation proves it.
- [ ] Preserve bot-safe wording only where the POST-only reveal flow proves it.
- [ ] Do not broaden this task into a product redesign.

## Task 5: Verify and commit

- [ ] Run the claim regression test.
- [ ] Run `npm run check`.
- [ ] Run `npm test` and confirm it executes `vitest run`.
- [ ] Run `npx playwright test tests/e2e/blip.spec.ts` if local services required by that suite are available; otherwise record the exact missing runtime rather than claiming the journey passed.
- [ ] Run `npm run build` and `git diff --check`.
- [ ] Review the rendered README and security page for consistent language.
- [ ] Commit only this truth repair with `📝 docs(cinder): narrow the destruction guarantee`.
- [ ] Do not push the public or deploy-wired branch without Matt's confirmation.

## Definition of done

- No tracked public claim says Cinder deletes copies outside its controlled server storage.
- The verified atomic delete-and-return guarantee remains clear.
- The unavoidable capture limit is understandable before a person relies on the product.
- The regression check prevents the universal claim from returning.
- Existing checks pass and no runtime behavior changes.
