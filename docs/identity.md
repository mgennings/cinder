# mattOS identity

A portable identity layer whose first consumer is Cinder Pro. It exists to hold
one fact about a person — that they bought something — and it is built so that
holding that fact reveals nothing else.

## What it stores, exactly

One DynamoDB item per (product, person):

```
pk        "cinder#<base64 hmac>"
entitled  true
grantedAt "2026-07-27T00:00:00.000Z"
```

That is the whole record. The line that writes it is `grantEntitlement` in
`api/src/entitlement-store.mjs`. There is no other write path to this table.

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

## Sign out, expiry, revocation, deletion

- **Sign out** revokes the refresh token at Cognito's `/oauth2/revoke` and clears
  `sessionStorage`. The ID token already issued cannot be recalled; it expires
  within five minutes, which is Cognito's floor and the reason it is set there.
- **Expiry** is checked in `verifyIdToken` with a 60-second skew allowance, which
  is the only tolerance in the system.
- **A revoked Apple private relay** changes nothing. Cinder never asked for the
  relay address, so there is no address to stop forwarding. Revoking the app in
  Apple's settings breaks the sign-in itself, and the person simply cannot sign
  in again — the entitlement row remains until deleted, unreachable but also
  unreadable.
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
   - *Domains and Subdomains*: `mattos-identity.auth.us-east-1.amazoncognito.com`
   - *Return URLs*: `https://mattos-identity.auth.us-east-1.amazoncognito.com/oauth2/idpresponse`

   Both values come from the `IdentityHostedUi` stack output. Apple rejects a
   domain it cannot verify, so the pool domain must exist first — deploy the
   stack once with placeholder Apple values, or create the domain by hand.
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

1. **OAuth consent screen** — External, app name `Cinder`, support email, and no
   scopes beyond the non-sensitive `openid`. An app requesting only `openid` does
   not require verification.
2. **Credentials → Create credentials → OAuth client ID → Web application**:
   - *Authorized JavaScript origins*: `https://mattos-identity.auth.us-east-1.amazoncognito.com`
   - *Authorized redirect URIs*: `https://mattos-identity.auth.us-east-1.amazoncognito.com/oauth2/idpresponse`
3. The **Client ID** → `GoogleClientId`; the **Client secret** → `GoogleClientSecret`.

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
curl -s -X POST "$IDENTITY_API/entitlement"                      # {"entitled":false}
curl -s -X POST "$IDENTITY_API/entitlement" -H 'authorization: Bearer forged.token.here'
```

Then sign in at `/account` and confirm in the Cognito console that the created
user has **no** email, name, or phone attribute. If any attribute is populated,
an `AttributeMapping` or a scope is wrong and the promise on `/account` is false.
