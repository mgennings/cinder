# Cinder Pro — the payment path

A one-time **$0.94** unlocks sending more than 4 MiB. Stripe processes it. There is no subscription, no renewal, and no plan.

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
   │                        ├─ grant ──────────────────┼─────────────────────►│  cinder#<pairwise>
   │                        ├─ delete pending row ─────┼─────────────────────►│
   │◄─ redirect to /pro/done                           │                      │
   └─ poll /entitlement until true                     │                      │
```

**Checkout Session, not Payment Intent.** A Payment Intent means rendering card fields on cinder.ink, which means the card touches this origin, which means the pay-point copy could no longer say it does not. A hosted Checkout Session keeps the fields on `checkout.stripe.com` and reduces Cinder's job to a redirect. It is also the shape undertext's Grace Pro already proved.

**Cinder has its own Stripe account.** Branding, the statement descriptor, receipts, and dispute history are all account-level in Stripe, never per-product. A charge for Cinder has to read `CINDER.INK` on a card statement, and it cannot if the account is shared with another product. So every Stripe credential in this stack is a **per-product map** rather than a constant — `STRIPE_SECRET_KEYS`, `STRIPE_WEBHOOK_SECRETS`, `PRODUCT_PRICES`, `PRODUCT_RETURN_URLS`. A third mattOS domain is a third account and a third row in each map, with no code change.

That has one consequence worth stating, because it is not obvious: several accounts' webhooks arrive at one URL, and the request does not say which account sent it until the signature is checked. So `webhook` in `api/src/purchase.mjs` **discovers** the account by finding which configured secret verifies the delivery, and then requires that the pending row's product match it. Without that cross-check, anyone holding one product's webhook secret could grant every product — the exact containment separate accounts are meant to buy.

**Why not undertext's static Payment Link.** Grace has no accounts, so it keys the entitlement on the Stripe session id and consumes it once. Cinder has accounts (the identity lane), so a purchase can attach to a person and stay attached. That means the session has to be created server-side to carry a reference, which a static Payment Link cannot do.

### The nonce, and why the extra row

`client_reference_id` could have carried the buyer's pairwise subject directly and saved a write. It does not, on purpose.

If it did, Stripe's records would hold `{pairwise subject ↔ card ↔ email}` indefinitely, and Cinder's table holds `{pairwise subject ↔ entitled}`. Two databases that individually say nothing become, on a breach or a subpoena of either, one database that names the buyer. The nonce breaks the join: Stripe stores a random 256-bit string, and the only thing that could ever translate it is a row that expires in an hour and is deleted the instant the grant lands.

## Every clause of the pay-point copy, and the line that makes it true

The copy lives in `src/routes/pro/+page.svelte`. If a change makes one of these false, the code is the thing to fix.

| The sentence | What it rests on |
| --- | --- |
| "cinder still never sees your file, its name, or your key" | `src/lib/crypto/file-crypto.ts` — the filename and MIME type are encrypted *inside* the GCM region, and the key lives in the URL fragment, which is never sent to a server. Nothing on the payment path touches either. |
| "you type your card on stripe's own page, not on cinder's" | `src/lib/auth.ts` → `startCheckout` returns a URL that `src/routes/pro/+page.svelte` passes to `location.assign`. It is never fetched, framed, or proxied. The CloudFront CSP in `template.yaml` sets `form-action 'none'` and names no `frame-src`. |
| "cinder never asks stripe for your card or your email" | `api/src/stripe.mjs` sends `mode`, `line_items`, `client_reference_id`, and the two URLs. No `customer`, no `customer_email`, no `expand`. In `payment` mode Stripe's default `customer_creation` is `if_required`, so no Customer object is created. |
| "never reads them, and never writes them down" | `api/src/purchase.mjs` → `webhook` reads exactly three fields out of the event: `type`, `data.object.payment_status`, and `data.object.client_reference_id` (`purchaseReference` in `entitlement-logic.mjs`). Nothing logs. The Lambda's log group holds Lambda's own START/END/REPORT lines and nothing else. |
| "what we keep is one line: this account bought pro, on this date" | `api/src/entitlement-store.mjs` → `grantEntitlement` writes `{pk, entitled, grantedAt}`. That is the complete item. |
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
| Charge | $0.9400 |
| Stripe fee | $0.0273 + $0.3000 = **$0.3273** |
| Net | **$0.6127** |
| Fee as a share of the charge | **34.8%** |

The fixed 30¢ is doing 92% of the damage. At this price the fee share is dominated entirely by it: at $1.94 the fee share would be 18.9%, at $4.94 it would be 8.9%.

Two things worth knowing before deciding the price is fine:

- **A refund does not return the fee.** Refunding a $0.94 purchase costs $0.3273 out of pocket, so a refunded sale is a $0.33 loss rather than a wash.
- **A dispute costs $15.00.** One chargeback wipes out the net on roughly 24 sales.

Stripe does have micropayment pricing, but it is not published and is not self-serve — Stripe's own guidance is that availability [varies by market and has to be requested from Support](https://support.stripe.com/questions/accepting-microtransactions-on-stripe). No rate is quoted here because none was observed. If $0.94 is the intended price long term, that request is worth making before volume matters.

None of this is an argument against the price. $0.94 is a deliberate number and 61¢ of it arrives. It is here so the number is known rather than discovered.

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
  --description="A one-time unlock for sending larger files."

stripe prices create \
  --product=prod_XXXX \
  --unit-amount=94 \
  --currency=usd
```

`unit_amount` is in cents. **94, not 0.94** — a decimal here is the classic way to charge a hundredth of the intended price.

Keep the resulting `price_...`. It is the `CinderProPriceId` stack parameter.

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
- [ ] `entitlement-provider.mjs` still exports `denyAll`, so nothing paid actually unlocks anything yet. That file belongs to the identity lane and is the last wire to connect.
- [ ] The whole grant path has been run once against a real test-mode Stripe, not only against the suite.
- [ ] Matt has decided whether 61¢ net is the number he wants.

## Where the seam is, and what a second product costs

**Portable — a second mattOS product reuses these unchanged:**

- `api/src/entitlement-logic.mjs` — signature verification, the settled-payment gate, reference extraction. Knows nothing about Cinder.
- `api/src/stripe.mjs` — session creation. Knows nothing about Cinder.
- `api/src/purchase-store.mjs` — the pending-purchase row. `product` and `pairwise` are opaque strings.
- `api/src/purchase.mjs` — both routes. The product comes from the token's audience via the identity lane, and the price from configuration.

**Configuration, not code.** A second product is a row in `CLIENT_PRODUCTS`, a row in `PRODUCT_PRICES`, a row in `PRODUCT_RETURN_URLS`, and its own pepper. No handler changes.

**Genuinely Cinder-specific:**

- The pay-point copy in `src/routes/pro/+page.svelte`. Every sentence is a claim about Cinder's architecture; another product's claims are its own.
- The `$0.94` price, the 4 MiB free ceiling, and Cinder's Stripe account.
- The capability being bought (`transfer.multipart`) and its `maxParts` limit, which are transport facts about this product.
