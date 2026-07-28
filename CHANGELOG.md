# Changelog

All notable changes to Cinder are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

Files larger than 4 MiB, with the guarantee untouched.

### Added

- **Cinder Pro is prepaid credits: $4.94 for 10 large sends.** One credit sends one file over 4 MiB. Not a subscription and not an unlock — the balance sits on the account until it is spent, buying again adds to it rather than being refused, and everything under 4 MiB stays free forever with no account. The reason is arithmetic: Stripe's fixed 30¢ was 92% of the fee damage on the old $0.94 unlock, taking 34.8% of the money; a bundle takes 9%.
- **A credit is spent at the mint, and the cost is on screen before the sender commits.** The send screen names the piece count *and* the price at file selection, before a byte is encrypted, and says plainly that a delivery which breaks partway destroys the pieces and spends the credit anyway — Cinder cannot see which transfer failed, which is the same reason it can never see who a file went to. No surface implies a refund the code does not perform.
- **Transfers up to 256 MiB, in pieces.** A large file is split into parts of at most 4 MiB, each sealed as its own AES-256-GCM envelope, stored under its own random object key, and claimed by its own atomic delete-and-verify. This is not a second protocol: `POST /files` writes N ordinary grants and the finalize and claim handlers were not modified at all. The per-object promise at 256 MiB is the same rows in the same table hit by the same conditional writes as the promise at 3 MiB.
- **A stated cost before the recipient commits.** The reveal gate names the number of pieces and says plainly that if any piece fails, every piece already delivered is permanently destroyed, the file cannot be assembled, and there is no retry and no resume. The sender is told the same thing when they choose the file.
- **One short link for any number of pieces.** Part *i* is addressed at `sha256("<locator>:part:<i>")`, derived independently by the browser and the server, so the link carries one locator instead of 64 capabilities. The part count rides in the fragment, which is how the gate can state the cost with no request on link arrival.
- **Position-authenticated envelopes.** Each part's index and the transfer's total are fed into AES-GCM as additional authenticated data, so a part cannot be reordered, replayed at another position, or have the tail dropped — each of those fails the tag rather than producing a plausible partial file.
- **A capability gate on the create path.** A caller without a grant for `transfer.multipart` gets `402` and cannot create a multi-part transfer. The gate is never consulted on finalize or claim: a recipient never needs an account to receive what a sender already paid to send.
- **Capability grants, minted and honored.** `POST /capability` on the identity API turns a verified session and a checked entitlement into a short-lived signed grant — `base64url({cap, limits, exp, nonce}) . HMAC-SHA256`, carrying **no subject** — and the transfer API verifies it offline against a shared HMAC key. The transfer API never calls the identity API and never reads the entitlement table, so an account still cannot be linked to a transfer. The verifier refuses any payload key beyond those four, so a future change that smuggles an identifier in breaks loudly rather than quietly.
- **The whole chain, proven in one run.** `tests/journey/full-journey.spec.ts` drives a real browser through: a 9 MiB send refused anonymously, refused again while signed in but unpaid, then delivered after a purchase — three pieces, SHA-256 identical, burned so a second reader gets nothing. The order of the refusals is asserted, because a chain that succeeds but would also have succeeded unpaid is the failure the test exists to catch. Cognito and Stripe are replaced at the service boundary only; every line of Cinder's own verification, signature, entitlement, capability, and transport code is the real code under test.

### Changed

- **The entitlement row is a counter, not a boolean.** `{pk, credits, grantedAt}` is the complete item. The mint spends one credit with a single conditional `UpdateItem` (`SET credits = credits - :one` under `attribute_exists(pk) AND credits >= :one`), so the check and the decrement are one call: 40 simultaneous sends against a balance of 7 hand out exactly 7 grants and the balance never goes negative. A zero balance is a state, not a fault, and it is the same silent refusal an anonymous caller gets.
- **A duplicate Stripe delivery can no longer buy a second bundle.** Credits accumulate, so at-least-once delivery would have become at-least-once billing. The webhook now takes an exclusive claim on the pending row — a conditional delete returning `ALL_OLD` — before crediting, and puts the row back with its original deadline if the credit write then fails. Ten simultaneous deliveries of one payment add ten credits, not a hundred.
- **A retried send still costs nothing.** The client presents its cached grant byte for byte, so the mint is never reached twice; two sends behind one grant leave 9 of 10 credits, asserted through the account page in the journey suite.
- **`/account` shows the balance, `/pro` sells a top-up.** The account page leads with credits remaining and always offers more; the pay point states the balance before the button, and there is no "already owned" dead end because there is nothing to own.
- **The filename is encrypted once per transfer** rather than once per part, so a multi-piece transfer does not repeat the same plaintext under one key at a known offset in every object, and does not leak the name's length into every object's size.
- **The presign window scales with part count**, to a one-hour ceiling. Safe because every presigned `PUT` is signed against an exact key, length, and SHA-256, so a leaked URL authorizes writing only the bytes it was already going to receive.
- **`/security` and the threat model** now cover the piece-wise delivery, the total-loss cost of a partial failure, and what paying does and does not change about what Cinder can see.

### Notes

- **Response streaming is still rejected, and now there is a test that says so.** Chunking is what made a larger file possible without touching the 4 MiB per-object ceiling that the buffered transport entitles. `api/test/chunked.test.mjs` asserts the constant's exact expression and fails if any streaming symbol appears in the handler, so a future attempt to raise the ceiling by trading the structural guarantee for a behavioral one breaks the build first.
- **256 MiB is memory-bound, not transport-bound** — the one number here that is a judgment rather than a derivation. A recipient holds every part in one tab while reassembling, and a tab killed mid-delivery is a permanently destroyed file rather than an inconvenience.
- **The gate still fails closed by construction.** With no `CAPABILITY_SECRET` configured it denies everything, and a forged, expired, wrong-capability, wrong-secret, or subject-bearing grant is the same silent refusal as no grant at all.
- **A grant cannot be recalled.** Deleting an account closes the mint immediately, but a grant already issued works until it expires — fifteen minutes, the same trade a stateless ID token makes. Closing that window would mean the transfer API reading the entitlement table on every send, which is the link this design exists to prevent.
- **Not deployed.** No AWS resource was created and no Stripe key was used. `CinderCapabilitySecret` is a new stack parameter; the stack has to be redeployed with it before any of this is reachable in production.
- **Not deployed, and the price and bundle are new stack parameters.** `CinderProCredits` (default 10) joins `CinderProPriceId`, and the Stripe Price must be recreated at `494` cents. No AWS resource was created and no Stripe key was used.

## [0.2.0] — 2026-07-27

Encrypted file transfer, with one promise Cinder can actually keep.

### Added

- **One-file transfer, up to 4 MiB.** Choose a file instead of a note. The bytes, the filename, and the MIME type are encrypted together in the browser as one AES-256-GCM envelope, so a stored object reveals its approximate size and nothing else.
- **Exactly one server delivery attempt.** A single atomic claim. Cinder deletes its own stored encrypted copy and verifies with S3 that the object is absent *before* any response byte exists — so receiving the bytes is itself proof the deletion already happened. Twenty simultaneous claims yield one body and nineteen byte-identical refusals.
- **An explicit, irreversible reveal.** The recipient sees exactly what pressing the button costs before they press it, including that a failed delivery is permanent and cannot be retried.
- **A transfer record on delivery.** A technical readout of what the server actually did. Every row is entailed by the response; none of it is decorative.
- **Constrained uploads.** Ciphertext goes straight to a private, non-versioned bucket through a five-minute presigned `PUT` signed against one random object key, an exact byte length, and an exact SHA-256. Finalize then inspects the stored object itself rather than trusting any client claim.
- **Separated least-privilege roles.** Create can write but not read, finalize can read but not delete or list, and only the claim function can delete.

### Changed

- **API CORS is now exact-origin** rather than `*`, and the stage throttles at 20 rps with a burst of 40.
- **The `/security` page and threat model** now cover the file promise, its permanent-loss cost, and what it still cannot control.

- **A strict Content-Security-Policy, HSTS, and framing headers** on every alias. Scripts may load only from Cinder's own origin, and the only two places the page may send anything are the API and the private media bucket.
- **The whole journey is now reachable without a mouse or a screen.** Every outcome is announced, focus follows the view change, and the ambient glow no longer scrolls the page sideways.

### Fixed

- **The delete-before-delivery proof was corrected before release.** Without `s3:ListBucket`, S3 answers a request for a missing object with `403` rather than `404`, which would have made the post-delete absence check unable to distinguish "the object is gone" from "I am not allowed to look."
- **A false privacy claim was removed.** Draft documentation said the finalize function could not read a stored object. AWS requires `s3:GetObject` alongside `s3:GetObjectAttributes`, so it can, and no S3 permission set can express otherwise. The claim was corrected rather than quietly dropped.
- **A timing oracle on finalize.** A wrong upload capability used to cost one more round trip than an unknown locator — about 72 ms, with non-overlapping distributions — which let anyone holding a link poll to learn whether it was still live, and when the recipient opened it. The capability is now checked before any storage call, so both paths cost the same.
- **The claim path delivered bytes it never checked.** It held the exact length and checksum verified at finalize and ignored both, so anyone who could write to the bucket could spend a recipient's single delivery attempt on tampered bytes. It now refuses to deliver anything that does not match.
- **Two accessibility failures that broke the promise outright.** The primary button's label measured 2.57:1 against its own gradient in light mode, and the passphrase prompt appeared in total silence *after* the stored copy was already deleted — while still displaying a warning that said the delivery "can begin." Both are fixed and measured.
- **A Subresource Integrity claim that was never true.** The threat model offered SRI as a mitigation for a compromised server. It was not deployed, and it would not have helped: SRI protects against a third-party CDN, and Cinder serves its own bundles.

### Notes

- The 4 MiB ceiling is derived from the transport, not chosen: the buffered Lambda response is capped at 6 MB and travels base64, leaving about 11% headroom at that size. Response streaming would allow 200 MB but trades a structural guarantee for a behavioral one, so Cinder took the smaller number.

## [0.1.0] — 2026-07-01

The first working release: a zero-knowledge, self-destructing note service, live on AWS.

### Added

- **Zero-knowledge encryption.** Notes are encrypted in the browser with AES-256-GCM. The key lives only in the URL fragment and never reaches the server.
- **Atomic burn-on-read.** A single conditional DynamoDB `DeleteItem` guarantees exactly one successful server retrieval per note, with no race window. Expired notes are never served.
- **Two-factor passphrase mode.** An optional passphrase (PBKDF2-HMAC-SHA256, 600,000 iterations) layers on top of the link key, so a leaked link alone cannot open the note.
- **Bot-safe reveal.** The reader page fetches nothing until a human clicks, and the burn endpoint is POST-only, so link-preview crawlers cannot destroy a note.
- **Honest security page.** An in-app `/security` page and a companion doc state plainly what the tool protects and what it cannot.
- **AWS serverless stack.** API Gateway, two Lambdas, DynamoDB with TTL, and S3 + CloudFront, all defined in one AWS SAM template.
- **Custom domain.** Live at [cinder.ink](https://cinder.ink) over HTTPS.
- **Full documentation.** Architecture, crypto, security, API reference, local-development, and deployment guides.
- **25 tests** across unit, API, and end-to-end browser layers.

### Notes

- The product is branded **Cinder**; `blip` remains the repository slug and the parking subdomain for now.
