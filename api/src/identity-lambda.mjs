// Production entrypoints for the identity API. Wires the impure edges — the
// pool's JWKS document and Cognito's AdminDeleteUser — into the injectable
// handlers, exactly the way lambda.mjs does it for notes and files.
//
// Env (all set in template.yaml):
//   USER_POOL_ID       — the mattOS pool
//   ENTITLEMENT_TABLE  — DynamoDB table name
//   CLIENT_PRODUCTS    — JSON {"<appClientId>": "<product>"}
//   PRODUCT_PEPPERS    — JSON {"<product>": "<secret>"}   (NoEcho parameter)

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
	CognitoIdentityProviderClient,
	AdminDeleteUserCommand
} from '@aws-sdk/client-cognito-identity-provider';
import { makeEntitlementHandlers } from './entitlement.mjs';
import { makePurchaseHandlers } from './purchase.mjs';
import { createCheckoutSession } from './stripe.mjs';
import { parseMap } from './identity.mjs';

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cognito = new CognitoIdentityProviderClient({});

const REGION = process.env.AWS_REGION;
const POOL = process.env.USER_POOL_ID;
const ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${POOL}`;

// Cached for the life of the container. Cognito rotates signing keys rarely and
// always publishes the new key before using it, so a cold start per rotation is
// the whole cost. A failed fetch is NOT cached — otherwise one bad minute would
// deny every caller until the container died.
let jwksCache = null;
async function getJwks() {
	if (jwksCache) return jwksCache;
	const res = await fetch(`${ISSUER}/.well-known/jwks.json`);
	if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`);
	const doc = await res.json();
	if (!Array.isArray(doc?.keys)) throw new Error('jwks malformed');
	jwksCache = doc;
	return jwksCache;
}

const handlers = makeEntitlementHandlers(doc, {
	getJwks,
	deleteUser: (username) =>
		cognito.send(new AdminDeleteUserCommand({ UserPoolId: POOL, Username: username })),
	issuer: ISSUER,
	clientProducts: process.env.CLIENT_PRODUCTS,
	productPeppers: process.env.PRODUCT_PEPPERS
});

export const { checkEntitlement, deleteAccount } = handlers;

// --- purchase ---------------------------------------------------------------
//
// Wired here rather than in its own entrypoint file so there is one identity
// verifier in the process and one place that reads CLIENT_PRODUCTS. The Stripe
// secrets are read at module scope and never logged, never returned, and never
// put in an error message.
//
// Env (all set in template.yaml):
//   STRIPE_SECRET_KEYS     — JSON {"<product>": "sk_test_…"}   ONE ACCOUNT PER PRODUCT
//   STRIPE_WEBHOOK_SECRETS — JSON {"<product>": "whsec_…"}     that account's secret
//   PRODUCT_PRICES         — JSON {"<product>": "<stripe price id>"}
//   PRODUCT_RETURN_URLS    — JSON {"<product>": {"success": "…", "cancel": "…"}}
//
// Every one of these is a MAP, never a single value. Stripe's branding and
// statement descriptor are account-level, so Cinder has its OWN Stripe account
// and a card statement reads CINDER.INK. A third mattOS domain is a third row in
// each map and no code change.
export const { checkout: startCheckout, webhook: purchaseWebhook } = makePurchaseHandlers(doc, {
	identify: handlers.identify,
	secretKeys: parseMap(process.env.STRIPE_SECRET_KEYS),
	webhookSecrets: parseMap(process.env.STRIPE_WEBHOOK_SECRETS),
	prices: parseMap(process.env.PRODUCT_PRICES),
	urls: parseMap(process.env.PRODUCT_RETURN_URLS),
	createSession: createCheckoutSession
});
