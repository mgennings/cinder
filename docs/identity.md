# mattOS identity

A portable identity layer whose first consumer is Cinder Pro. It exists to hold
one fact about a person — how many prepaid large sends they have left — and it is
built so that holding that fact reveals nothing else.

## What it stores, exactly

One DynamoDB item per (product, person):

```
pk        "cinder#<base64 hmac>"
credits   7
grantedAt "2026-07-27T00:00:00.000Z"
```

That is the whole record. `credits` is a counter rather than a flag because
Cinder Pro is prepaid credits: a purchase adds a bundle, a large send spends one.
Two lines write it, and only two — `addCredits`, whose only caller is the Stripe
webhook, and `spendCredit`, whose only caller is the mint. `spendCredit` is a
conditional `UpdateItem` that refuses to go below zero, so it can subtract and
can never add.

Cognito holds the account itself: an opaque subject, the federated link to Apple
or Google, and the timestamps Cognito creates on its own. No email, no name, no
phone — `AttributeMapping` maps `username: sub` and nothing else, the pool has no
`Schema` block, and both identity providers are asked for the narrowest scope
each one allows (`''` for Apple, `openid` for Google).

## The portable line

| Portable | Cinder-specific |
| --- | --- |
| The user pool, its two identity providers, and the hosted-UI domain | The `CinderAppClient` app client and its callback URLs |
| `api/src/identity.mjs` — token verification and pairwise subjects | The `cinder` entry in `CLIENT_PRODUCTS` and `PRODUCT_PEPPERS` |
| `api/src/entitlement.mjs`, `entitlement-store.mjs`, `identity-lambda.mjs` | `src/routes/account/+page.svelte` — Cinder's copy and visual language |
| The `IdentityApi`, `EntitlementTable`, and both functions | `src/lib/auth.ts` (portable in shape, Cinder's env vars) |

Adding a second product means: a second `AWS::Cognito::UserPoolClient` with its
own callback URLs, one more entry in each of the two JSON maps, and a redeploy of
the two functions. Nothing else changes.

## One pool, and what that costs

One pool is right because the human-gated setup — an Apple Services ID, an Apple
signing key, a Google OAuth client, and the single redirect URI all three are
pinned to — is done once and then serves every domain.

The cost is real and worth stating: one pool means **one Cognito subject per
person across every product**. That is a cross-domain correlation risk, and it is
answered in code rather than by policy. No product stores the subject. Each
stores `HMAC-SHA256(its own pepper, "product:subject")`, so two products'
entitlement rows for one human cannot be joined without both peppers.

What this does **not** defend against: whoever holds the AWS account holds both
peppers and the pool, and could correlate. Nothing built inside that account can
prevent that, and claiming otherwise would be the kind of lie this product exists
not to tell. What it does prevent is a leaked database becoming a cross-product
profile, and it prevents the products drifting into a shared one by accident.

## The mint — `POST /capability`

The last place identity exists in the chain. It takes a Bearer ID token and
`{ capability }`, verifies the token, **spends one credit**, and returns a
short-lived signed grant:

```
{ "grant": "<base64url payload>.<base64url hmac>", "expiresIn": 900 }
```

Every refusal — no token, a forged token, an unconfigured product, an unknown
capability name, no credits left — answers `200` with `{ "grant": null,
"expiresIn": null }`. One answer, so the route is never an oracle for which of
them happened, and running out looks exactly like never having bought.

The spend is atomic: N mints racing against a balance of M hand out exactly M
grants and the balance never goes negative, proven in `api/test/credits.test.mjs`
against DynamoDB Local. The balance itself never enters the grant — a rare
remaining count is a fingerprint across otherwise unlinkable transfers — so it is
readable only at `POST /entitlement`, by the signed-in person, about their own
account. Why the charge lands here and not at create, claim, or finalize is in
[Cinder Pro](pro-payments.md), "When a credit is consumed".

The grant carries `cap`, `limits`, `exp`, and `nonce`, **and no subject**. That
is enforced rather than intended: `api/src/capability-grant.mjs` refuses to
verify a payload with any other key, so a change that adds one breaks the chain
loudly instead of quietly making every transfer linkable to an account. The
nonce is 256 random bits, never derived from the subject — a derived nonce would
make two grants for the same person recognizable as such, which is the exact
join the pairwise subject exists to break.

The verifying half lives on the **other** API and is offline: it holds the same
HMAC key and nothing else. The transfer API never calls this one. See
[Cinder Pro](pro-payments.md), "From a purchase to a capability".

## Sign out, expiry, revocation, deletion

- **Sign out** revokes the refresh token at Cognito's `/oauth2/revoke` and clears
  `sessionStorage`. The ID token already issued cannot be recalled; it expires
  within five minutes, which is Cognito's floor and the reason it is set there.
- **Expiry** is checked in `verifyIdToken` with a 60-second skew allowance, which
  is the only tolerance in the system.
- **A revoked Apple private relay** changes nothing. Cinder never asked for the
  relay address, so there is no address to stop forwarding. Revoking the app in
  Apple's settings breaks the sign-in itself, and the person simply cannot sign
  in again — the entitlement row and its credits remain until deleted, unreachable but also
  unreadable.
- **A capability grant cannot be recalled either**, and for the same reason a
  stateless ID token cannot. Deleting an account or signing out closes the mint
  immediately, but a grant already issued keeps working for up to fifteen
  minutes. It buys the holder more large transfers and nothing else — it names
  no one, reads nothing, and expires on its own. Closing that window would mean
  the transfer API consulting the entitlement table on every send, which is the
  link this whole design exists to prevent.
- **Deletion** (`POST /account/delete`) removes the entitlement rows first, then
  calls `AdminDeleteUser`. Cognito has no soft delete: the pool record and the
  federated link go with it. Rows first is deliberate — the row key is an HMAC of
  the subject, so once the user is gone the key cannot be computed again.
- **Deleting is unrecoverable.** No email is stored, so there is no way to find a
  person afterward and no way to restore a purchase. `/account` says this in
  those words before the confirm step.

## Console runbook

Nothing below can be done from this repository. Each step is Matt's gate.

### 1. Apple — Sign in with Apple

In the [Apple Developer portal](https://developer.apple.com/account/resources):

1. **Identifiers → App IDs** — the existing `org.uxuiai.*` App ID, or a new one.
   Enable the **Sign in with Apple** capability. Note the **Team ID** (top right
   of the portal) → template parameter `AppleTeamId`.
2. **Identifiers → Services IDs → +** — description `Cinder sign in`, identifier
   `org.uxuiai.cinder.signin` → template parameter `AppleServicesId`.
3. Configure that Services ID → **Sign in with Apple**:
   - *Primary App ID*: the App ID from step 1.
   - *Domains and Subdomains*: `auth.cinder.ink`
   - *Return URLs*: `https://auth.cinder.ink/oauth2/idpresponse`

   Both values come from the `IdentityHostedUi` stack output. Apple rejects a
   domain it cannot verify, so the pool domain must exist first — deploy the
   stack once with placeholder Apple values, or create the domain by hand.

   Apple accepts several domains and several return URLs at once. During the
   cutover in section 6, the old `mattos-identity.auth.us-east-1.amazoncognito.com`
   pair stays listed alongside these until the new one is proven.
4. **Keys → +** — name `mattOS Sign in with Apple`, enable **Sign in with Apple**,
   configure it against the App ID from step 1, then **Download** the `.p8`.
   Apple lets you download it exactly once.
   - The **Key ID** → `AppleKeyId`.
   - The file contents, including the `-----BEGIN PRIVATE KEY-----` lines →
     `ApplePrivateKey`.

Do **not** enable any scope. Cinder requests none, and Apple's consent screen
correctly shows nothing being shared.

### 2. Google — OAuth client

In the [Google Cloud console](https://console.cloud.google.com/apis/credentials):

1. **OAuth consent screen → Branding** — these are the fields that decide what a
   person reads on the Google consent screen, and none of them is settable by
   any API. There is no public Google Cloud API for consent-screen branding;
   `gcloud`, the IAM API, and the OAuth2 API all expose the client, never the
   brand. This step is console-only, every time.
   - *App name*: `Cinder`
   - *User support email*: Matt's address
   - *App logo*: upload `static/brand/cinder-icon-512.png` — square, PNG, under
     1 MB. Google downsamples it to 120×120, so the 512 is the right source.
   - *Application home page*: `https://cinder.ink`
   - *Privacy policy* and *Terms of service*: the cinder.ink pages
   - *Authorized domains*: `cinder.ink`
   - *Developer contact*: Matt's address

   Uploading a logo puts the brand into Google's verification queue. The app
   itself still needs no verification, because it requests only the
   non-sensitive `openid` scope. Sign-in keeps working while the logo review is
   pending; only the logo waits.
2. **OAuth consent screen → Audience** — External.
3. **Credentials → Create credentials → OAuth client ID → Web application**:
   - *Authorized JavaScript origins*: `https://auth.cinder.ink`
   - *Authorized redirect URIs*: `https://auth.cinder.ink/oauth2/idpresponse`

   Google accepts several of each. During the cutover in section 6, the old
   `mattos-identity.auth.us-east-1.amazoncognito.com` origin and redirect URI
   stay listed alongside the new ones until the new one is proven.
4. The **Client ID** → `GoogleClientId`; the **Client secret** → `GoogleClientSecret`.

### 3. The pepper

Generate once, store in a password manager, and never rotate:

```bash
openssl rand -base64 32   # → CinderPepper
```

Rotating it orphans every existing entitlement. See `.notes/GOTCHAS.md`.

### 4. Deploy, then wire the front end

```bash
sam build && sam deploy --guided   # Matt's gate: this creates real resources
```

Take three stack outputs into `.env.production`:

```
VITE_IDENTITY_HOSTED_UI=<IdentityHostedUi>
VITE_IDENTITY_CLIENT_ID=<CinderClientId>
VITE_IDENTITY_API_BASE=<IdentityApiUrl>
```

Until all three are set, `identityConfigured()` is false and `/account` says
accounts are not available — which is true, rather than a broken button.

### 5. Verify at the real boundary

```bash
# Anonymous must be denied by the deployed function, not just by the unit test.
curl -s -X POST "$IDENTITY_API/entitlement"        # {"entitled":false,"credits":0}
curl -s -X POST "$IDENTITY_API/entitlement" -H 'authorization: Bearer forged.token.here'
```

Then sign in at `/account` and confirm in the Cognito console that the created
user has **no** email, name, or phone attribute. If any attribute is populated,
an `AttributeMapping` or a scope is wrong and the promise on `/account` is false.

### 6. Cutover to auth.cinder.ink

Google and Apple both show the domain the OAuth flow runs on. Before this
cutover a person handing over an identity read
`mattos-identity.auth.us-east-1.amazoncognito.com` on Google's consent screen,
which is a trust defect on the one screen where trust is the whole product.

The cutover is additive at every step, so live sign-in never stops. A user pool
may carry a prefix domain and a custom domain simultaneously — AWS: "You can set
up a user pool with both a custom domain and a prefix domain that's owned by
AWS." Both serve `/oauth2/authorize` and `/oauth2/idpresponse` independently.
Only the OIDC discovery endpoint differs, and Cinder does not use it.

Already done, in AWS, verified:

- ACM certificate for `auth.cinder.ink` in us-east-1, DNS-validated, `ISSUED`:
  `arn:aws:acm:us-east-1:553806908724:certificate/a703e418-e876-4f30-be20-2312ba89f07a`
  (the existing four-name cert does not cover an auth subdomain and ACM cannot
  gain a SAN after issue, so this is a second certificate, not an edit).
- Parent-domain precondition: `cinder.ink` has an A ALIAS to
  `d1v6mxepibwneb.cloudfront.net` and resolves. Cognito refuses a custom domain
  whose parent does not resolve, and an SOA record does not count.
- `auth.cinder.ink` itself has no record yet, which is what Cognito requires.

Run in this order. Do not reorder steps 2 and 3.

1. **Deploy the stack.** `MattosUserPoolCustomDomain` is new; nothing else in the
   identity block changes. This creates a CloudFront distribution and takes a
   few minutes. The prefix domain is untouched and sign-in keeps working.

2. **Point DNS at it.** Take `IdentityCustomDomainAliasTarget` from the stack
   outputs and create the A ALIAS. `Z2FDTNDATAQYW2` is CloudFront's fixed
   hosted-zone id, not a value to look up:

   ```bash
   ALIAS=$(aws cloudformation describe-stacks --stack-name blip --region us-east-1 \
     --query "Stacks[0].Outputs[?OutputKey=='IdentityCustomDomainAliasTarget'].OutputValue" --output text)
   aws route53 change-resource-record-sets --hosted-zone-id Z073855230DF25J9RR4B7 \
     --change-batch "{\"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{
       \"Name\":\"auth.cinder.ink.\",\"Type\":\"A\",
       \"AliasTarget\":{\"HostedZoneId\":\"Z2FDTNDATAQYW2\",\"DNSName\":\"$ALIAS\",
       \"EvaluateTargetHealth\":false}}}]}"
   ```

   A brand-new custom domain can take up to an hour to propagate. Wait for a
   `302` before going further:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' \
     "https://auth.cinder.ink/login?client_id=$CLIENT_ID&response_type=code&scope=openid&redirect_uri=https://cinder.ink/account"
   ```

3. **Add the new URLs in both provider consoles. Add, never replace.** The old
   entries stay until step 6, and that is what makes this reversible.

   Apple — [developer.apple.com/account/resources](https://developer.apple.com/account/resources)
   → Identifiers → Services IDs → `org.uxuiai.cinder.signin` → Configure:
   - *Domains and Subdomains*: add `auth.cinder.ink`
   - *Return URLs*: add `https://auth.cinder.ink/oauth2/idpresponse`
   - Save. Apple verifies the domain resolves, which is why step 2 comes first.

   Google — [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials)
   → the Cinder web OAuth client:
   - *Authorized JavaScript origins*: add `https://auth.cinder.ink`
   - *Authorized redirect URIs*: add `https://auth.cinder.ink/oauth2/idpresponse`
   - Save. Google's change can take a few minutes to take effect.

   Same visit, OAuth consent screen → Branding: set *App name* to `Cinder`,
   upload `static/brand/cinder-icon-512.png`, and set *Authorized domains* to
   `cinder.ink`. Console-only; see section 2.

4. **Flip the front end.** `.env.production`:

   ```
   VITE_IDENTITY_HOSTED_UI=https://auth.cinder.ink
   ```

   Rebuild and deploy the site. `vite.config.ts` derives the connect-src CSP
   entry from this value, so a stale build blocks the new origin.

5. **Verify by signing in, with Google, on a phone.** The consent screen must
   read "to continue to cinder.ink" rather than an amazoncognito.com host. Then
   confirm the created user still has no email, name, or phone attribute.

6. **Retire the prefix domain — later, and only after step 5 passes twice.**
   Remove the old origin and redirect URI from Google, the old domain and return
   URL from Apple, then delete `MattosUserPoolDomain` from the template. Until
   then it is the rollback: point `VITE_IDENTITY_HOSTED_UI` back at the prefix
   host, rebuild, and sign-in is exactly what it was tonight.

**Rollback at any step before 6** is that one environment variable and a
redeploy. Nothing above deletes anything.

---

# The web journey: doors, destinations, and every state

## The surfaces

| URL | What it is |
| --- | --- |
| `/signin` | A door. Also the single retry surface for any failed sign-in. |
| `/signup` | The same door, worded for somebody who has never been here. |
| `/account` | The account page **and** the OAuth callback. Both, on purpose. |
| `/pro` | Signs in inline, because leaving the pay point to sign in loses the sale and the context. |

`/signin` and `/signup` are both `src/lib/ui/AuthDoor.svelte` with different
copy. Neither is indexable; they are steps in a journey, not pages with
something to say.

## The callback stays `/account`, and that is a deliberate constraint

The Cognito app client lists exactly four `CallbackURLs`, each of them
`…/account` (`template.yaml`). A provider will redirect to nothing else, so the
doors send people out and `/account` catches them and forwards them on.

**No `template.yaml` change was needed for any of this and none should be made
for it.** Moving the callback to `/signin` would buy a marginally tidier URL bar
during a redirect that lasts under a second, and it would cost a window where
the deployed pool and the deployed site disagree — during which every sign-in
fails at Cognito with an error page the person cannot act on and we cannot see.

## Where the person comes back to

`startSignIn(provider, returnTo)` writes a **same-origin path** to
`sessionStorage` under `cinder.returnto`, and `/account` consumes it after a
successful exchange. Somebody who pressed sign in on `/pro` lands back on `/pro`
with the buy button, not on an account page they never asked for.

- **Only a path.** Never an absolute URL, not even this site's own. `//host`,
  `https://…`, `javascript:`, and `/\host` are all refused, in `safePath` in
  `src/lib/auth.ts`, with `src/lib/auth.test.ts` pinning each one.
- **Not the OAuth `state` parameter.** The PKCE verifier already lives in this
  tab's `sessionStorage` and already binds the round trip to this tab; `state`
  would be a second copy of a guarantee that is already made, and a second thing
  to get wrong. If `sessionStorage` did not survive, the exchange would fail on
  the missing verifier first.

## Every state, and where it renders

| State | Surface | What is said |
| --- | --- | --- |
| loading | all | "Checking this browser…" |
| signed out | door, `/account`, `/pro` | the two buttons |
| signed in | all | the balance, or "already signed in" on a door |
| **sign-in failed** | `/signin` | the reason, per `signInFailureMessage` |
| **provider refused** | `/signin` | "refused before it finished. Nothing was created." |
| **session expired** | `/account`, `/pro`, doors | "That session ended" — never "Signed out" |
| **offline** | wherever the button is | refused *before* leaving, naming the provider |
| leaving | wherever the button is | buttons disabled, "Handing you over…" |
| signing out | `/account` | announced, then "no longer holds a token" |
| deleted | `/account` | the confirm step, then "The account is deleted" |
| unavailable | all | accounts not configured in this build |

The failure states are the ones that had no coverage, so they are the ones
`tests/journey/auth-journey.spec.ts` is mostly about.

**`sessionState()` is why 'expired' can exist at all.** `signedIn()` reads
storage and only ever says "a token was written here once." `sessionState()`
asks the origin. A refresh token revoked on another device, aged out, or
belonging to a deleted account used to render as the ordinary signed-out page,
so somebody who was looking at a balance a second earlier was shown the screen
of somebody who never had one.

## Email and password: the decision, and why

**Not implemented, and it should not be.** Matt asked for it; this is the
honest answer rather than a stall.

The pool is built so that no address exists to store: no `Schema`, no
`AutoVerifiedAttributes`, no `EmailConfiguration`, `authorize_scopes: ''` at
Apple, `AttributeMapping: {username: sub}` at both providers, and
`AllowAdminCreateUserOnly: true`. `/account` publishes "Email address — Not
requested, not stored," and the uxuiai EULA v1.3 says the same. Adding
email/password would make both of those sentences false the day it shipped, and
a shipped string may not claim a privacy property the code no longer has.

It would also need an address for the one thing a password always needs — reset
— which is precisely the mailbox the pool refuses to have. A password with no
reset path is worse than no password.

**Passkeys (WebAuthn) are the right third door and they are still not a web-lane
change.** Cognito supports them, they need no email, and they preserve every
published claim. What they need first, all in `template.yaml`, all requiring a
pool deploy Matt gates:

1. `UserPoolTier: ESSENTIALS` — passkey sign-in is not on `LITE`.
2. Managed login **branding version 2**. The classic hosted UI this flow uses
   today does not offer a passkey step, so the domain's login experience
   changes for Apple and Google too.
3. `ExplicitAuthFlows` gains `ALLOW_USER_AUTH`, and the client needs
   `AllowedOAuthScopes` to include `aws.cognito.signin.user.admin` for
   `StartWebAuthnRegistration` — which today's template refuses **by name**,
   because that scope lets a browser token read and write user attributes.
4. Self-service sign-up, which `AllowAdminCreateUserOnly: true` currently
   forbids, plus a generated username that is not derived from anything about
   the person.

Item 3 is the real cost: it trades a documented capability restriction for a
convenience. It is a decision about the threat model, not about the sign-in
page, and it belongs to whoever owns `template.yaml` and the deploy.

**If email/password is ever added anyway**, two things must change in the same
commit or the product starts lying:

- the `stored` table in `src/routes/account/+page.svelte` becomes **per method**,
  because "Email address — Not requested, not stored" would only remain true of
  the Apple and Google doors; and
- in the **uxuiai** repository (not this one), EULA v1.3's sentence stating that
  no email address is requested or stored has to be scoped to the providers
  rather than to the product. That is a legal-copy change in a repo this lane
  does not touch, and it must land before the feature ships, not after.

## What a second product copies, and what it configures

The seam is deliberate: nothing in the two lower files knows the word "Cinder."

| File | Second product |
| --- | --- |
| `src/lib/ui/ProviderButtons.svelte` | **Copy unchanged.** Brand marks, brand palettes, Apple-first ordering. |
| `src/lib/ui/SignInPanel.svelte` | **Copy unchanged.** Offline refusal, leaving state, failure slot, `returnTo`. |
| `src/lib/auth.ts` | **Copy, change four constants** — the storage key prefix and the three `VITE_IDENTITY_*` values. The PKCE flow, the failure taxonomy, `sessionState`, and `safePath` are product-neutral. |
| `src/lib/ui/AuthDoor.svelte` | **Copy, replace the layout and the shell.** The state machine is the reusable part; `.card`, `.bench`, and the wordmark are Cinder's. |
| `.btn-provider` / `.btn-apple` / `.btn-google` in `src/app.css` | **Copy unchanged.** The literal hex values are Apple's and Google's, not a theme. Only `--focus-ring`'s inner spacer references a local token. |
| `/signin`, `/signup`, `/account`, `/pro` pages | **Rewrite.** All the copy, every claim, the stored-data table, the balance. |

The rule that keeps the seam honest: a sentence about accounts, credits,
privacy, or money lives in a **route**, never in `src/lib/ui/`. If a component
in that directory ever needs a product-specific word, the word belongs in a prop.
