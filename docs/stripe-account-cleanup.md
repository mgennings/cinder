# Stripe cleanup, before Cinder becomes the second product

The Stripe account was stood up for one thing: Grace Pro on undertext.org. It
still describes itself that way. Cinder is about to be the second product
charging through it, and a few of the things that were fine for one product are
actively wrong for two.

This is the plan. It changes nothing on its own — every item below is a
dashboard action Matt takes, and the ones that can bite are marked.

## What access this was written from

Read this part first, because it determines how much of the rest to trust.

- **No live account read was performed.** There is no Stripe MCP connector in
  this workspace, and the only Stripe credential on the machine is a **live
  secret key** in undertext's `www/.env.local`. Using a live key to read a live
  account is not a gate anyone should walk through casually, so it was not used.
  No restricted read-only key exists.
- **The Stripe CLI is now installed** (`brew install stripe/stripe-cli/stripe`,
  v1.44.0). It is **not authenticated** — `stripe login` is interactive and is
  Matt's action, not an agent's.
- Everything marked **OBSERVED** below comes from undertext's own audit at
  `undertext/.notes/audit/stripe-checkout-audit-2026-06-23.md`, which *did* read
  the live account on 2026-06-23. It is a month old. Treat it as a strong prior,
  not as current truth, and re-confirm before acting.
- Everything marked **INFERRED** was read out of undertext's source today. It
  says what the code expects, which is not the same as what the account has.
- Object ids (account, product, price, payment link, webhook) are deliberately
  not copied into this file. They live in that audit note.

## The one decision that comes before the checklist

**Stripe branding is per account, not per product.** One icon, one logo, one
brand color, one accent, one statement descriptor, for every Checkout session
the account ever renders.
([Stripe: multiple separate accounts](https://docs.stripe.com/get-started/account/multiple-accounts),
[Stripe: branding](https://docs.stripe.com/get-started/account/branding))

So there are exactly two shapes this can take, and picking one is a fork only
Matt can settle:

1. **One account, one house brand.** The checkout for both undertext and Cinder
   says `experience Architects` (or `uxuiai.org`), with a neutral mark. Nobody
   sees a Cinder logo on the Cinder checkout, and nobody sees an undertext logo
   on the undertext checkout. Cheapest, one KYC, one payout, one dashboard.
2. **A second Stripe account for Cinder.** Cinder's checkout carries Cinder's
   mark, its own descriptor (`CINDER.INK`), its own webhook, its own payouts.
   Stripe explicitly supports this and recommends it when the businesses are
   independent. Costs a second onboarding, and reporting splits.

The brand assets in `static/brand/` are built for option 2, and they are equally
usable as the icon for a Cinder-only account. Nothing below assumes the choice.

---

## Cleanup items

### 1. The account still calls itself the consultancy — OBSERVED

Display name is `ux-ui.ai` and the statement descriptor is `UX-UI.AI`. Both
products are **uxuiai.org** products. Cinder would inherit the same descriptor.

> `ux-ui.ai` is the consultancy. `uxuiai.org` is the org that ships products.
> A card statement reading `UX-UI.AI` for a Cinder subscription attributes a
> product to the consultancy. That is the defect the constellation rule exists
> to prevent.

- **Do:** in the Dashboard, set the public business name to
  `experience Architects`, the product URL to the product's own domain, and the
  statement descriptor to something the buyer will recognize on a statement.
- **Breaks if wrong:** a descriptor nobody recognizes is a chargeback engine.
  Change it once, deliberately, and keep it under 22 characters.
- **Reversible:** yes, but a descriptor change only affects *future* charges, so
  a wrong one lives on old statements forever.
- **Blocked before:** the API refused it — "You cannot use this method on your
  own account: you may only use it on connected accounts." It is Dashboard-only.

### 2. Business type is `individual` — OBSERVED

Stripe reports `business_type=individual`.

- **Do:** nothing yet.
- **Why:** flipping legal entity or tax identity without the LLC/EIN paperwork
  ready can trigger KYC review or a payout hold. This is the one item on the
  list that can stop money from arriving.
- **Reversible:** effectively no, not without support and delay.

### 3. Webhook subscribes to events nothing acts on — OBSERVED + INFERRED

The live endpoint is subscribed to four events (OBSERVED): `completed`,
`async_payment_succeeded`, `async_payment_failed`, `expired`.

The Lambda acts on exactly two of them (INFERRED, from
`undertext/deploy/grace-pro/lambda/index.mjs`): `checkout.session.completed`
and `checkout.session.async_payment_succeeded`. Everything else falls through
to `return ok({ received: true, ignored: payload.type })`.

- **Do:** drop `async_payment_failed` and `expired` from the subscription, or
  leave them and accept that they are noise. Prefer dropping — an event list
  that matches the handler is documentation that cannot rot.
- **Breaks if wrong:** nothing. Both are currently no-ops.
- **Reversible:** yes, instantly.

### 4. The deploy script tells you to subscribe an event that is not subscribed and not handled — INFERRED

`undertext/deploy/grace-pro/deploy.sh` prints, as a required manual step:

> events: `checkout.session.completed`, `customer.subscription.deleted`

`customer.subscription.deleted` is not in the live subscription (OBSERVED) and
the Lambda has no revocation branch for it (INFERRED). The script is instructing
a future operator to wire an event into a handler that will silently ignore it.

- **Do:** fix the script's printed instructions to match the handler. This is an
  undertext change and is **out of Cinder's write scope** — file it there.
- **Breaks if wrong:** nothing today. It is a trap for the next person.
- **Reversible:** yes.

### 5. There is no revocation path at all — INFERRED

The entitlement is a single-use row keyed on the checkout session id, with a
TTL. A cancellation, a refund, or a dispute never revokes access. The code says
so plainly in a comment, so this is a known limit, not a surprise.

- **Do:** decide *before* Cinder ships a subscription whether Cinder needs
  revocation. If Cinder sells one-time or credit-style purchases, it does not
  and should not inherit this shape. If it sells a subscription, build the
  customer→token index first, not after.
- **Breaks if wrong:** paying-customer-shaped access that survives cancellation.
  Cheap at current volume, expensive later.
- **Reversible:** yes, it is additive.

### 6. A live secret key is deployed to a Lambda that does not use it — INFERRED

`deploy.sh` writes `STRIPE_SECRET_KEY` into the Lambda's environment, and
`index.mjs` documents it as "reserved; not needed for the webhook→verify path."
The webhook verifies with the signing secret; the secret key has no consumer.

- **Do:** stop deploying it until something needs it. If something will need it,
  make it a **restricted key** with only the scopes that thing uses.
- **Breaks if wrong:** nothing — removing an unused variable removes nothing.
- **Reversible:** yes.
- **Why it matters for Cinder:** whatever Cinder's money path is, it should ask
  for a restricted key from day one rather than inheriting `sk_live_` by habit.

### 7. There is no test key anywhere — INFERRED

`www/.env.local` carries `STRIPE_SECRET_KEY=sk_live_…` and
`STRIPE_WEBHOOK_SECRET=whsec_…`, and nothing else. There is no sandbox
credential on this machine.

- **Good news:** no test-versus-live drift is possible, because there is no test
  side to drift.
- **Bad news:** the only way to exercise the money path today is a live charge.
  Adding a second product doubles the surface being changed with no rehearsal.
- **Do:** create a Stripe **sandbox**, put its keys in a `.env.test`, and use the
  now-installed CLI (`stripe listen --forward-to …`) to replay webhooks locally.
  This is the single highest-value item on the list for Cinder specifically.
- **Reversible:** entirely — a sandbox is disposable.

### 8. Payment links exist that no surface points at — OBSERVED + INFERRED

Five links exist (OBSERVED): monthly, yearly, founders, a 7-day family trial,
and support. The web app references two (INFERRED,
`undertext/www/src/features/grace-pro/grace-pro.constants.ts`): monthly and
yearly, and the yearly one is a **hardcoded fallback** — no
`VITE_GRACE_PRO_CHECKOUT_ANNUAL_URL` is set in `www/.env.local`, so the constant
in source is what ships.

Founders and the family trial are reachable by anyone who has the URL and are
surfaced nowhere.

- **Do:** for each of founders and family-trial, either point a surface at it or
  deactivate it. An indefinitely-live discounted link with no owner is the
  orphan to clean up before a second product multiplies them.
- **Breaks if wrong:** deactivating a link Mark Daniel or a family member has
  bookmarked breaks their signup. Confirm who holds each one first.
- **Reversible:** yes — deactivating a payment link is reversible, and existing
  subscriptions created through it are unaffected.

### 9. No coupons or promotion codes — OBSERVED

Comps are currently done by minting bespoke payment links. That does not scale
to two products.

- **Do:** create real coupons/promotion codes before Cinder needs its first comp.
- **Reversible:** yes.

### 10. Automatic tax is off, price `tax_behavior` mostly `unspecified` — OBSERVED

Acceptable at current volume. Revisit before meaningful paid volume, and note
that changing `tax_behavior` on an existing price is not possible — it requires
a new price.

- **Reversible:** no, not in place. Plan it, don't patch it.

---

## What Cinder needs created (not cleanup — new work)

Cinder's own money path is being built in `api/src/stripe.mjs` and
`api/src/purchase.mjs` in this repo, in Checkout `payment` mode with its own
webhook and its own signature verification. It does not share undertext's Lambda
and should not share its secrets. The list below is what that code needs to
exist on the Stripe side, whichever account shape wins:

1. A product named `Cinder`, with the product URL `https://cinder.ink`, an image,
   and metadata following undertext's existing convention: `app=cinder`,
   `product=<name>`, `surface=<where the buyer was>`.
2. Its own webhook endpoint at Cinder's own domain, subscribed only to the
   events Cinder's handler actually branches on.
3. Its own signing secret, in Cinder's own environment. Never share undertext's.
4. A restricted API key, not `sk_live_`, scoped to what Cinder's handler does.
5. Branding uploaded from `static/brand/` — see below.

## Branding assets, ready to upload

Stripe's branding settings take **JPG or PNG, under 512 KB, at least
128×128px**, for two slots: a square **Icon** (used in emails, Checkout and
Payment Links, the customer portal, hosted invoices, invoice PDFs) and a
non-square **Logo** that overrides the icon in Checkout and invoice PDFs.
Source: [Stripe: branding](https://docs.stripe.com/get-started/account/branding).

Stripe Checkout renders on **white**, so upload the light variants.

| Slot | File | Size |
| --- | --- | --- |
| Icon | `static/brand/cinder-icon-light-512.png` | 512×512 |
| Logo | `static/brand/cinder-logo-256.png` | wide lockup, 256 tall |

Brand color: `#e8502a` (`--color-ember`, light theme). Accent: `#c23d1a`
(`--color-ember-ink`) — both measured against white before being recommended.

The dark-surface versions (`cinder-icon-512.png`, `cinder-lockup.svg`) exist for
Cinder's own surfaces, not for Stripe.

---

## The exact commands Matt runs

Nothing here mutates the account.

```bash
# authenticate the CLI (interactive; opens a browser, asks you to confirm a code)
stripe login

# confirm which account the CLI is pointed at
stripe config --list

# read-only inventory, live mode, so you can diff it against the OBSERVED
# claims above before changing anything
stripe products list --limit 100
stripe prices list --limit 100
stripe payment_links list --limit 100
stripe webhook_endpoints list
stripe coupons list

# a sandbox to rehearse Cinder's money path in (item 7)
stripe login --project-name cinder-sandbox
stripe listen --forward-to localhost:5173/api/stripe/webhook
```

Everything in "Cleanup items" is a Dashboard action after that diff, not a CLI
action. Items 1 and 2 are Dashboard-only regardless — Stripe's API refuses
public-profile writes on your own account.
