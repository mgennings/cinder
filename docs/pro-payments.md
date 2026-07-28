# Cinder Pro — the payment path

**$4.94 buys 10 large sends.** One credit sends one file over 4 MiB. Stripe processes the purchase. There is no subscription, no renewal, and no plan — credits sit on the account until they are spent, and anything under 4 MiB stays free forever with no account at all.

This document is the audit trail for the money side: what grants an entitlement, what each sentence on the pay point is standing on, what the fee actually costs, and how to run the whole thing in Stripe test mode.

## The shape of it

```
browser                identity API                 Stripe                DynamoDB
   │                        │                          │                      │
   ├─ POST /purchase/checkout (Bearer ID token)        │                      │
   │                        ├─ mint nonce ─────────────┼─────────────────────►│  purchase#<sha256(nonce)>
   │                        ├─ create Checkout Session ►│                      │   {product, pairwise}
   │◄─ { url } ─────────────┤                          │                      │
   ├─ navigate ─────────────┼─────────────────────────►│  (card + email live here, not here)
   │                        │◄─ POST /purchase/webhook ─┤                      │
   │                        ├─ verify signature        │                      │
   │                        ├─ read pending row ───────┼─────────────────────►│
   │                        ├─ CLAIM the pending row ──┼─────────────────────►│  (conditional delete)
   │                        ├─ credits += 10 ──────────┼─────────────────────►│  cinder#<pairwise>
   │◄─ redirect to /pro/done                           │                      │
   └─ poll /entitlement until credits > 0              │                      │
```

**Checkout Session, not Payment Intent.** A Payment Intent means rendering card fields on cinder.ink, which means the card touches this origin, which means the pay-point copy could no longer say it does not. A hosted Checkout Session keeps the fields on `checkout.stripe.com` and reduces Cinder's job to a redirect. It is also the shape undertext's Grace Pro already proved.

**Cinder has its own Stripe account.** Branding, the statement descriptor, receipts, and dispute history are all account-level in Stripe, never per-product. A charge for Cinder has to read `CINDER.INK` on a card statement, and it cannot if the account is shared with another product. So every Stripe credential in this stack is a **per-product map** rather than a constant — `STRIPE_SECRET_KEYS`, `STRIPE_WEBHOOK_SECRETS`, `PRODUCT_PRICES`, `PRODUCT_RETURN_URLS`. A third mattOS domain is a third account and a third row in each map, with no code change.

That has one consequence worth stating, because it is not obvious: several accounts' webhooks arrive at one URL, and the request does not say which account sent it until the signature is checked. So `webhook` in `api/src/purchase.mjs` **discovers** the account by finding which configured secret verifies the delivery, and then requires that the pending row's product match it. Without that cross-check, anyone holding one product's webhook secret could grant every product — the exact containment separate accounts are meant to buy.

**Why not undertext's static Payment Link.** Grace has no accounts, so it keys the entitlement on the Stripe session id and consumes it once. Cinder has accounts (the identity lane), so a purchase can attach to a person and stay attached. That means the session has to be created server-side to carry a reference, which a static Payment Link cannot do.

### The nonce, and why the extra row

`client_reference_id` could have carried the buyer's pairwise subject directly and saved a write. It does not, on purpose.

If it did, Stripe's records would hold `{pairwise subject ↔ card ↔ email}` indefinitely, and Cinder's table holds `{pairwise subject ↔ entitled}`. Two databases that individually say nothing become, on a breach or a subpoena of either, one database that names the buyer. The nonce breaks the join: Stripe stores a random 256-bit string, and the only thing that could ever translate it is a row that expires in an hour and is deleted the instant the grant lands.

## From a purchase to a capability

A row in the entitlement table does nothing on its own. The transfer API cannot read it — different API, different access log, no Authorization header admitted at CORS — and that is the whole point. What crosses the gap is a **capability grant**: a short-lived signed string that says what may be done and nothing about who is doing it.

```
browser                identity API                    transfer API
   │                        │                                │
   ├─ POST /capability (Bearer ID token, {capability}) ──────►│
   │                        ├─ verify token                  │
   │                        ├─ read entitlement row          │
   │                        ├─ sign a grant                  │
   │◄─ { grant, expiresIn } ┤                                │
   │                                                          │
   ├─ POST /files { parts, capabilityGrant } ────────────────►│
   │                                        verify HMAC, expiry,
   │                                        capability, limits
   │◄─ 201, or 402 ───────────────────────────────────────────┤
```

**The format** (`api/src/capability-grant.mjs`):

```
base64url(JSON{ cap, limits, exp, nonce }) . base64url(HMAC-SHA256(secret, that))
```

**Verification, in order** (`api/src/entitlement-provider.mjs`):

1. Two segments, bounded length, both present. A three-segment string is a JWT and is refused rather than tolerated.
2. HMAC-SHA256 over the payload segment **as sent**, compared in constant time. Never over a re-serialization of the parsed object, which is how a signature check gets made to pass on bytes nobody received.
3. The payload is exactly the four keys `cap`, `limits`, `exp`, `nonce`. Any other key — `sub`, `email`, a balance — fails the whole grant.
4. `cap` equals the capability being asked for.
5. `exp` is in the future, with no skew allowance.
6. Every value in `limits` is a positive integer.

Every failure is the same silent `null`, which the transport turns into the same `402` an anonymous caller gets.

**What the transfer API learns:** that someone entitled to `transfer.multipart` sent this, and their part ceiling. **What it cannot learn:** who. It does not call the identity API, does not read the entitlement table, and is not handed the request event.

**Two honest consequences, stated rather than hidden:**

- **A grant cannot be recalled.** Deleting an account closes the mint immediately, but a grant already issued keeps working until it expires. Fifteen minutes is the whole exposure and it buys the holder more transfers and nothing else. Closing it would mean the transfer API consulting the entitlement table on every send, which is exactly the link this design exists to prevent. This is the same trade a stateless ID token makes — see [identity](identity.md), "What sign-out actually does".
- **A grant is not single-use.** A create retried after a dropped connection must not fail for the person who paid. That was free under a one-time unlock; under credits it had to be designed rather than assumed, which is the next section.

## Credits, and the retry that must not double-charge

Cinder Pro is prepaid credits: **$4.94 for 10 large sends**, because the fixed 30¢ is 92% of the fee damage at $0.94 and a bundle takes the fee share from 34.8% to about 9%.

None of the chain above changed shape. The grant format, the gate, the transfer API, and the client are all unaware of which pricing model is in force. What changed is what the entitlement row holds and what the mint does with it. **This is built.** The row is a counter, the mint spends one, and the webhook adds ten.

### When a credit is consumed: at the mint

Three candidates, and only one of them is honest.

| Point | Why not |
| --- | --- |
| At **claim** | The recipient triggers it, not the sender. A file nobody opens would be free, and a sender's balance would move days later for reasons they cannot see. |
| At **finalize** | Splits the charge across N parts of one transfer and charges for uploads that were abandoned halfway. |
| At **create** | The transfer API has no subject and must never acquire one. It could only spend against the grant's nonce, which means a second table and a second write on the unlinkable path. |
| At **mint** ✅ | The only point that is authenticated, already reads the entitlement row, is already idempotent per grant, and happens **before any bytes are stored**. |

So: **one grant is one prepaid send.** Minting spends a credit; the grant is the receipt.

The spend is a single conditional `UpdateItem`, never a read followed by a write:

```
UpdateExpression:   SET credits = credits - :one
ConditionExpression: attribute_exists(pk) AND credits >= :one
:one = 1
```

The check and the decrement are the same call, evaluated under the partition's own lock, so N mints racing against a balance of M hand out exactly M grants and the loser gets `ConditionalCheckFailedException` rather than a negative balance. `credits >= :one` on a row with no `credits` attribute does not match — a comparison against a missing attribute is false — so someone who never bought anything is refused by the same expression, with no second read and no extra branch.

`api/test/credits.test.mjs` fires 40 spends at a balance of 7 against DynamoDB Local and asserts exactly 7 succeed. **That test was then falsified**: replacing the conditional update with a read-then-write made 40 of 40 succeed against 7 credits, and the test caught it. Worth knowing, because it is the trap in writing this test at all — the *floor* assertion alone (25 spends against a balance of 1, never negative) still PASSED with atomicity removed, since every racing writer computes `1 - 1 = 0`. Only the N-against-M count catches it.

### Why a retry is free, and what the idempotency key is

The idempotency key is the **grant's nonce** — 256 bits minted once and carried in the payload.

The client caches a grant for its lifetime (`src/lib/entitlement.ts`), so a create that is retried after a dropped connection presents the *identical* string, with the identical nonce. The gate verifies it again and grants again — it is deliberately not single-use — and the mint is never reached, so no second credit moves. A retry is free because the retry never touches the thing that charges.

This is asserted by three executed tests:

- `api/test/capability-grant.test.mjs` — "the same grant verifies repeatedly: it is NOT single-use".
- `tests/journey/full-journey.spec.ts` — "a second send in the same session reuses one grant and mints nothing new": two multipart creates in one page load present a byte-identical grant and the identity API mints exactly once.

- `tests/journey/full-journey.spec.ts` then reads `/account` and asserts the heading says **9 credits left** after those two sends: one mint, one charge, two files.

The second and third are the load-bearing assertions. If a future change makes `capabilityGrant()` fetch per send, they fail — and that would have been a silent double charge.

### The duplicate delivery, which is now a money bug

Stripe guarantees at-least-once delivery. Under the boolean, a duplicate was free: the grant was a PUT of a fixed item, so five deliveries wrote the identical row. Credits accumulate, so the same five deliveries would have bought fifty.

The dedupe therefore lives on the only artifact that is unique per purchase — the pending row — and it is a **conditional delete with `ReturnValues: ALL_OLD`**, so the claim and the answer are one call and two racing deliveries cannot both win. The order inverted with it: the boolean credited then cleared, credits **claim then credit**.

That inversion opens exactly one hole, and it is handled rather than hidden: a claim that succeeds followed by a credit that fails would leave a paying customer with nothing. So the row is put back with its **original** deadline — not a fresh hour, which would quietly extend the window in which Stripe's reference is still translatable to a person — and the handler answers non-2xx so Stripe retries into it.

Executed proof, all against DynamoDB Local:

- `api/test/purchase.test.mjs` — the same event five times buys exactly one bundle, and the out-of-order async settlement pair credits once.
- `api/test/credits.test.mjs` — ten *simultaneous* deliveries of one payment add one bundle; two separate purchases accumulate to twenty; a replayed first delivery after a second purchase adds nothing.

**Falsified as well.** Reverting the webhook to the old credit-then-clear order made ten concurrent deliveries award 100 credits instead of 10, two purchases award 40 instead of 20, the five-times duplicate award 50 instead of 10, and it also broke the pre-existing replay and out-of-order attacks — 5 failures across the two files, all reverted.

The grant TTL is therefore also the **retry window**: fifteen minutes. Longer and one credit buys unbounded sends; shorter and a slow upload on a bad connection could strand a paid send.

### A destroyed transfer spends the credit

A partial delivery destroys the pieces already handed over and the file can never be assembled. The sender paid, the recipient got nothing.

**The credit is spent, and it is not returned.** The alternative would mean the identity API learning that a specific transfer failed — which is precisely the link between an account and a transfer that everything here exists to prevent. Cinder cannot refund what it structurally cannot observe.

That is a real cost and the interface has to say so **before** the sender commits, in the same breath as the piece count, not in a footnote afterward. The pay point and the send screen must never imply a refund the code does not perform. The wording to ship with the counter:

> a credit is spent when cinder hands you the link, not when the file arrives. if the delivery breaks partway, the pieces are destroyed and the credit is gone — cinder has no way to see which transfer failed, which is the same reason it can never see who you sent it to.

### A zero balance is a state, not a fault

Running out is the expected end of a purchase and must never read as a broken product. Three rules:

1. **Say it before the work, not after.** The send screen already states the piece count on file selection; the balance belongs in the same sentence. Encrypting 200 MB and *then* refusing is the failure mode to avoid.
2. **Nothing about the free path changes.** Under 4 MiB keeps working, forever, with no account. A zero balance is "top up to send large files again", never a lock on the product.
3. **The refusal copy is the same shape as today's** — the `402` already says Pro adds size and does not change the promise. Zero credits says the same thing with a different number.

### The balance never enters the grant

A remaining-credit count is a small integer that changes on every send, and a rare value is a usable fingerprint across transfers that are otherwise unlinkable. "The sender with 3 left" is a smaller anonymity set than "a sender".

So the grant carries `cap`, `limits`, `exp`, `nonce` and nothing else, and `api/src/capability-grant.mjs` **refuses to verify a payload with any other key** — including `credits`. That is asserted in `api/test/capability-grant.test.mjs`. The balance lives on the identity API, where it is already linkable to the account it belongs to and where the person can actually see it.

### What the conversion touches

| File | Change | Size |
| --- | --- | --- |
| `api/src/entitlement-store.mjs` | `isEntitled`/`grantEntitlement` became `readCredits`/`spendCredit`/`addCredits` | done |
| `api/src/purchase-store.mjs` | `clearPendingPurchase` became `claimPendingPurchase`, a conditional delete returning `ALL_OLD` | done |
| `api/src/entitlement.mjs` | `mintCapability` spends a credit before signing; `checkEntitlement` answers with a count as well as a boolean | done |
| `api/src/purchase.mjs` | `checkout` stops refusing a buyer who already has credits (topping up is the point); the webhook claims, then adds | done |
| `api/src/identity-lambda.mjs`, `template.yaml` | `PRODUCT_CREDITS` / `CinderProCredits`; the mint's IAM widens from `GetItem` to `UpdateItem` | done |
| `src/lib/pro.ts` (new) | The price and the bundle size, written once | done |
| `src/lib/auth.ts` + `/account` + `/pro` + `/pro/done` | Show and top up a balance | done |
| `src/routes/+page.svelte` | State the cost with the piece count, before encrypting | done |

Nothing in `capabilities.mjs`, `capability-grant.mjs`, `entitlement-provider.mjs`, `handlers.mjs`, or `src/lib/api.ts` changed. **None of it is on the unlinkable path** — which is what the seam was shaped for.

**One honest widening.** `MintCapabilityFn` needed `dynamodb:UpdateItem`, so the Stripe webhook is no longer the only role in the account that can write the entitlement table. DynamoDB cannot constrain an IAM principal to a particular `UpdateExpression`, so what remains is in the code rather than the policy: `spendCredit` only ever subtracts, under a condition that refuses to go below zero, and the mint never calls `addCredits`. The privacy boundary did not move — that role still cannot read a note, cannot see a transfer, and writes nothing but a number on a row that is already its caller's.

## Every clause of the pay-point copy, and the line that makes it true

The copy lives in `src/routes/pro/+page.svelte`. If a change makes one of these false, the code is the thing to fix.

| The sentence | What it rests on |
| --- | --- |
| "cinder still never sees your file, its name, or your key" | `src/lib/crypto/file-crypto.ts` — the filename and MIME type are encrypted *inside* the GCM region, and the key lives in the URL fragment, which is never sent to a server. Nothing on the payment path touches either. |
| "you type your card on stripe's own page, not on cinder's" | `src/lib/auth.ts` → `startCheckout` returns a URL that `src/routes/pro/+page.svelte` passes to `location.assign`. It is never fetched, framed, or proxied. The CloudFront CSP in `template.yaml` sets `form-action 'none'` and names no `frame-src`. |
| "cinder never asks stripe for your card or your email" | `api/src/stripe.mjs` sends `mode`, `line_items`, `client_reference_id`, and the two URLs. No `customer`, no `customer_email`, no `expand`. In `payment` mode Stripe's default `customer_creation` is `if_required`, so no Customer object is created. |
| "never reads them, and never writes them down" | `api/src/purchase.mjs` → `webhook` reads exactly three fields out of the event: `type`, `data.object.payment_status`, and `data.object.client_reference_id` (`purchaseReference` in `entitlement-logic.mjs`). Nothing logs. The Lambda's log group holds Lambda's own START/END/REPORT lines and nothing else. |
| "what we keep is one line: this account has this many sends left, and the date it last bought some" | `api/src/entitlement-store.mjs` → `addCredits` writes `credits` and `grantedAt` on a row keyed by the pairwise subject. `{pk, credits, grantedAt}` is the complete item. |
| "a credit is spent when cinder hands you the link, not when the file arrives … the credit is gone" | `api/src/entitlement.mjs` → `mintCapability` calls `spendCredit` before `mintCapabilityGrant`, and no code path anywhere returns a credit. The sentence is on `/pro` **and** on the send screen at file selection, before any encryption starts. |
| "a payment is never linked to a note" | Notes and file transfers carry no identity to link to — see `api/src/handlers.mjs` and `api/src/store.mjs`. Separate table (`mattos-entitlements` vs `blip-notes`), separate HTTP API, separate access log. |
| "stripe is told only a random one-time reference that we delete as soon as your purchase lands" | `api/src/purchase-store.mjs` — the nonce is `randomBytes(32)`, stored only as a SHA-256, TTL one hour; `purchase.mjs` calls `clearPendingPurchase` immediately after the grant. Proven by the test *"the pending row never stores the nonce in the clear"*. |

### The sentence that was rewritten

The brief said the copy should state that Stripe sees the card and email and **"Cinder does not receive them."**

Cinder does not receive the card — true, the fields never exist on this origin. But the `checkout.session.completed` payload Stripe posts to the webhook carries `customer_details.email` whether we want it or not, so "does not receive" would have been false at the HTTP layer even though no line of code reads that field. The shipped sentence is therefore **"cinder never asks stripe for your card or your email, never reads them, and never writes them down"** — which the code does honor, line by line, in the table above.

## The attack surface, and what was actually run

`api/test/purchase.test.mjs`. Every row was executed; the totals are at the bottom.

| # | Attack | Result | Verdict |
| --- | --- | --- | --- |
| 1 | Forged signature, HMAC computed with the attacker's own secret | 400, nothing granted | PASS |
| 2 | No `Stripe-Signature` header at all | 400, nothing granted | PASS |
| 3 | Malformed headers (no `=`, junk, empty `v1`, non-numeric `t`) | all rejected | PASS |
| 4 | Replay of a genuine captured request, 301s old | rejected; 299s still accepted, so the boundary is real | PASS |
| 5 | Timestamp 301s in the future | rejected | PASS |
| 6 | Body tampered after signing (`unpaid` → `paid`) | 400, nothing granted | PASS |
| 7 | A valid signature lifted from a different body | 400, nothing granted | PASS |
| 8 | Secret rotation: two `v1` values, ours first and ours second | both accepted; neither-ours rejected | PASS |
| 9 | `v0` signature only, no `v1` | rejected | PASS |
| 10 | Signature of the wrong length (2 chars, 500 chars) | rejected, no throw | PASS |
| 11 | Empty or undefined webhook secret | never verifies anything | PASS |
| 12 | Grant attempted without a completed payment (`payment_status: unpaid`) | 200, nothing granted, pending row survives | PASS |
| 13 | Async settlement: unpaid completed, then `async_payment_succeeded` | granted exactly once | PASS |
| 14 | Out-of-order delivery: `async_payment_succeeded` before `completed` | granted once; the later-arriving earlier event is a no-op | PASS |
| 15 | Duplicate delivery, same event five times | exactly one entitlement row, pending row cleared | PASS |
| 16 | A genuine, correctly signed, genuinely paid event for a session this server never created (another product in the same Stripe account) | 200, nothing written at all | PASS |
| 17 | Event types that settle nothing (`payment_intent.succeeded`, `charge.succeeded`, `invoice.paid`, `checkout.session.expired`) | 200, nothing granted | PASS |
| 18 | Replay of a genuine event after its reference was cleared | cannot re-establish the grant | PASS |
| 19 | Oversized / non-string / null `client_reference_id` | resolves to null | PASS |
| 20 | Malformed event bodies with valid signatures | no grant, no crash | PASS |
| 21 | Checkout without a token | no Stripe call, no pending row | PASS |
| 22 | Checkout by someone already entitled | refused, not charged again | PASS |
| 23 | Checkout for a product with no configured price | fails closed | PASS |
| 24 | Does the pairwise subject reach Stripe? | it does not; nonces differ per checkout | PASS |
| 25 | Is the nonce recoverable from a table dump? | no, only its SHA-256 is stored | PASS |
| 26 | Base64-encoded body (API Gateway's binary path) | verified against the decoded bytes | PASS |
| 27 | Another product's Stripe account, correctly signed and genuinely paid, granting Cinder | 200, nothing granted | PASS |
| 28 | Each product's own account granting its own product | granted, and the buyer is not entitled to the other | PASS |
| 29 | Checkout bills the calling product's own account key and price | correct account, correct price | PASS |
| 30 | A product with a price but no Stripe account key | fails closed, never bills another account | PASS |
| 31 | No webhook secret configured at all | 400, grants nothing | PASS |

**The tests were then attacked themselves.** Six mutations were introduced into the source and the suite re-run, because a suite that passes on the first try has not yet proven it can fail:

| Mutation | Tests that caught it |
| --- | --- |
| `verifyStripeSignature` always returns true | 11 |
| Replay window removed | 2 |
| `isPaidSession` accepts anything | 2 |
| Grant without a pending row | 2 |
| Keep only the last `v1` (undertext's behavior) | 1 |
| No already-entitled check | 1 |
| Cross-account check removed | 1 |
| Missing account key falls through to another account | 1 |

All eight were caught and all eight were reverted.

## What it actually nets

Stripe's published US rate for standard online card payments, read from [stripe.com/pricing](https://stripe.com/pricing) on 2026-07-27: **2.9% + $0.30 per successful transaction.**

| | |
| --- | --- |
| Charge | $4.9400 |
| Stripe fee | $0.1433 + $0.3000 = **$0.4433** |
| Net | **$4.4967** |
| Fee as a share of the charge | **9.0%** |
| Net per send, at 10 sends | **$0.45** |

For comparison, the $0.94 single unlock this replaced: a $0.3273 fee, $0.6127 net, **34.8%** to Stripe. The fixed 30¢ was doing 92% of that damage, and bundling ten sends into one charge is the entire reason the fee share fell to 9%. That is the whole argument for credits, and it is arithmetic rather than taste.

Two things worth knowing before deciding the price is fine:

- **A refund does not return the fee.** Refunding a $4.94 purchase costs $0.4433 out of pocket, so a refunded sale is a $0.44 loss rather than a wash — and it refunds the whole bundle, including credits already spent, because Stripe is the only party that can see the payment at all.
- **A dispute costs $15.00.** One chargeback wipes out the net on roughly 3.3 sales.

Stripe does have micropayment pricing, but it is not published and is not self-serve — Stripe's own guidance is that availability [varies by market and has to be requested from Support](https://support.stripe.com/questions/accepting-microtransactions-on-stripe). No rate is quoted here because none was observed. A bundle is the answer that needs nobody's permission, which is why it is the one that shipped.

## Test-mode runbook

**Nothing below has been run, and no Stripe account state was observed.** No test credential exists on this machine. The only Stripe key present anywhere is a **live** secret belonging to undertext, in `undertext/www/.env.local` — it was never read, never used, and never copied, and it is not Cinder's account in any case.

So the suite runs against an injected `createSession` mock and against Stripe's documented API and signature shapes. **The mock and the real client take identical arguments** (`api/src/stripe.mjs` versus the stub in `api/test/purchase.test.mjs`), which is the point: moving from mocked to real sandbox test mode is a configuration change and not a code change. When Matt pastes sandbox keys in, the same handlers run end to end untouched.

### 0. Create the sandbox first

In the Stripe Dashboard, create a **new account for Cinder** — not a sandbox inside undertext's account. Set the business name so the statement descriptor reads `CINDER.INK`. Then work inside that account's **Sandboxes** / test mode for everything below. No live key is created, entered, or needed at any point in this runbook.

### 1. The product and price (test mode)

Dashboard → toggle **Test mode** on, top right. Or with the CLI:

```bash
stripe login                      # authorizes the CLI against the account
stripe products create \
  --name="Cinder Pro" \
  --description="10 large sends. One credit sends one file over 4 MiB."

stripe prices create \
  --product=prod_XXXX \
  --unit-amount=494 \
  --currency=usd
```

`unit_amount` is in cents. **494, not 4.94** — a decimal here is the classic way to charge a hundredth of the intended price.

Keep the resulting `price_...`. It is the `CinderProPriceId` stack parameter, and `CinderProCredits` (default 10) is what that price buys. Those two have to agree: the Price is only what it costs, the parameter is what it *is*. `src/lib/pro.ts` holds the same pair for the copy.

### 2. The webhook, locally

```bash
stripe listen --forward-to http://localhost:4000/purchase/webhook
```

It prints a `whsec_...` on the first line. That is `STRIPE_WEBHOOK_SECRET` for local runs, and it is **different from the deployed endpoint's secret** — a locally-working webhook that fails in the stack is almost always this.

Fire a settled payment without touching a card:

```bash
stripe trigger checkout.session.completed
```

That event has no `client_reference_id`, so the handler will correctly ignore it — that is attack #16 above, running for real. To test a grant end to end, use a real test checkout instead: click through `/pro` in the app and pay with card **4242 4242 4242 4242**, any future expiry, any CVC.

### 3. Test cards worth running

| Card | What it proves |
| --- | --- |
| `4242 4242 4242 4242` | The happy path grants exactly once |
| `4000 0000 0000 9995` | Decline. No webhook, no grant, and `/pro/done` must not claim failure it cannot know |
| `4000 0000 0000 3220` | 3D Secure. The redirect returns before settlement, which is precisely the race `/pro/done` polls through |

### 4. Deployed test mode

```bash
sam deploy \
  --parameter-overrides \
    CinderStripeSecretKey=sk_test_… \
    CinderStripeWebhookSecret=whsec_… \
    CinderProPriceId=price_…
```

Then, in the Dashboard (still test mode) → Developers → Webhooks → add endpoint:

- URL: `https://<IdentityApi>.execute-api.<region>.amazonaws.com/purchase/webhook` (the `IdentityApiUrl` stack output)
- Events: `checkout.session.completed` and `checkout.session.async_payment_succeeded`

Copy that endpoint's signing secret into `StripeWebhookSecret` and deploy again. To confirm which secret a deployed function is actually holding without printing it, `secretFingerprint` in `api/src/purchase.mjs` returns the first eight hex characters of its SHA-256.

### 5. Before live mode — the gates

- [ ] Every parameter is `sk_test_` / a sandbox `price_`, and it belongs to **Cinder's own Stripe account**, not undertext's. **No live key has ever been in this repository, this stack, or this session.**
- [ ] The statement descriptor on that account reads `CINDER.INK`.
- [x] `entitlement-provider.mjs` exports the real gate, wired at `lambda.mjs:22,104`. It verifies a signed grant and denies on signature, expiry, capability mismatch, unknown payload key, or a missing secret.
- [ ] The whole grant path has been run once against a real test-mode Stripe, not only against the suite.
- [ ] Matt has decided whether $4.50 net per bundle — about 45¢ a send — is the number he wants.
- [ ] The Stripe Price (`494`) and `CinderProCredits` (`10`) agree with each other and with `src/lib/pro.ts`.
- [x] **The EULA describes credits.** uxuiai, v1.3 effective 2026-07-27. v1.2 added credits; v1.3 corrected what a credit buys, because a grant is a time-limited send permission rather than one transfer.

## Where the seam is, and what a second product costs

**Portable — a second mattOS product reuses these unchanged:**

- `api/src/entitlement-logic.mjs` — signature verification, the settled-payment gate, reference extraction. Knows nothing about Cinder.
- `api/src/stripe.mjs` — session creation. Knows nothing about Cinder.
- `api/src/purchase-store.mjs` — the pending-purchase row. `product` and `pairwise` are opaque strings.
- `api/src/purchase.mjs` — both routes. The product comes from the token's audience via the identity lane, and the price from configuration.

**Configuration, not code.** A second product is a row in `CLIENT_PRODUCTS`, a row in `PRODUCT_PRICES`, a row in `PRODUCT_RETURN_URLS`, and its own pepper. No handler changes.

**Genuinely Cinder-specific:**

- The pay-point copy in `src/routes/pro/+page.svelte`. Every sentence is a claim about Cinder's architecture; another product's claims are its own.
- The `$4.94` price, the 10-credit bundle, the 4 MiB free ceiling, and Cinder's Stripe account.
- The capability being bought (`transfer.multipart`) and its `maxParts` limit, which are transport facts about this product.
