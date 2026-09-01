// Local identity API — the SAME handler code that runs in production, behind a
// tiny Node HTTP server, with exactly two external services replaced.
//
// WHAT IS REAL HERE, and it is nearly everything:
//   api/src/identity.mjs        token verification, pairwise subjects
//   api/src/entitlement.mjs     /entitlement, /capability, /account/delete
//   api/src/purchase.mjs        /purchase/checkout, /purchase/webhook
//   api/src/entitlement-logic.mjs   the Stripe signature check, unmodified
//   api/src/capability-grant.mjs    minting, verified later by the real gate
//   DynamoDB Local              the real store code against a real database
//
// WHAT IS REPLACED, and ONLY these two, both of them services we do not own:
//   Cognito  — a locally generated RSA key publishes a real JWKS and signs real
//              RS256 ID tokens. verifyIdToken is not modified, not stubbed, and
//              not told it is in a test: it fetches the JWKS, finds the kid,
//              checks the signature, the issuer, the audience, token_use, and
//              the expiry, exactly as it does against the real pool.
//   Stripe   — createSession returns a local URL instead of a hosted checkout
//              page, and visiting that URL produces a real-shaped
//              checkout.session.completed event signed with a real HMAC under a
//              real whsec_ secret. The webhook that receives it is the shipped
//              one, and it verifies that signature itself.
//
// NOTHING of Cinder's own logic is stubbed. If a check below could be moved into
// api/src/ and still be true, it belongs there instead of here.
//
// NEVER DEPLOYED. This file mints tokens for anyone who asks.

import { createServer } from 'node:http';
import {
	generateKeyPairSync,
	createPublicKey,
	createSign,
	createHash,
	createHmac,
	randomUUID,
	randomBytes
} from 'node:crypto';
import {
	DynamoDBClient,
	CreateTableCommand,
	DescribeTableCommand
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { makeEntitlementHandlers } from '../api/src/entitlement.mjs';
import { makePurchaseHandlers } from '../api/src/purchase.mjs';
import { createCheckoutSession } from '../api/src/stripe.mjs';

const PORT = Number(process.env.DEV_IDENTITY_PORT || 4100);
// 127.0.0.1 for the same reason everything else local is: `localhost` and
// 127.0.0.1 are different origins to a browser and can resolve to different
// address families. See the header of scripts/dev-api.mjs.
const HOST = process.env.DEV_IDENTITY_HOST || '127.0.0.1';
// The advertised origin, which is not always the bound one. Reviewing the paid
// flow on a phone means the checkout URL this hands the browser has to name an
// address that phone can reach; 127.0.0.1 there is the phone itself. Same
// reason and same shape as DEV_API_PUBLIC_ORIGIN in scripts/dev-api.mjs.
const ORIGIN = process.env.DEV_IDENTITY_PUBLIC_ORIGIN || `http://${HOST}:${PORT}`;

const CLIENT_ID = 'dev-cinder-client';
const PRODUCT = 'cinder';
// Shared with scripts/dev-api.mjs through the environment. The mint signs with
// it here; the real gate in api/src/entitlement-provider.mjs verifies with it
// over there. Two processes, one secret, no other coupling — which is the
// production topology.
const CAPABILITY_SECRET = process.env.CAPABILITY_SECRET || 'dev-capability-secret';
const DEVELOPMENT_ENTITLEMENT_BYPASS = process.env.CINDER_DEV_ENTITLEMENT_BYPASS === '1';
const DEVELOPMENT_INSTANT_SESSION = process.env.CINDER_DEV_INSTANT_SESSION === '1';

// Two modes, and which one is running is printed at startup so it is never a
// guess. DOUBLE is the default: a local stand-in for the hosted checkout page,
// with every signature and status check done by the shipped handler for real.
// LIVE-TEST points at Stripe's actual test mode, which is the only way to
// exercise Stripe's own signatures, its retry behavior, and a real card.
//
// Set all three or none. A real key with a fake price fails at Stripe with a
// message nobody expects, which is worse than not running at all.
const REAL_STRIPE =
	Boolean(process.env.STRIPE_SECRET_KEY) &&
	Boolean(process.env.STRIPE_PRICE_ID) &&
	Boolean(process.env.STRIPE_WEBHOOK_SECRET);

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_dev_local_only';
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dev_local_only';
const PRICE_ID = process.env.STRIPE_PRICE_ID || 'price_dev_local_only';

if (STRIPE_KEY.startsWith('sk_live_')) {
	throw new Error('refusing to run the dev harness against a LIVE Stripe key');
}

process.env.ENTITLEMENT_TABLE = process.env.ENTITLEMENT_TABLE || 'mattos-entitlements';

const raw = new DynamoDBClient({
	region: 'us-east-1',
	endpoint: 'http://localhost:8000',
	credentials: { accessKeyId: 'x', secretAccessKey: 'x' }
});
const doc = DynamoDBDocumentClient.from(raw);

// --- the Cognito double -----------------------------------------------------

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = randomUUID();
const JWKS = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }] };

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

// A real RS256 JWT with the claim set Cognito produces, signed by the key the
// JWKS above publishes. api/src/identity.mjs verifies it unmodified.
function idToken(sub) {
	const now = Math.floor(Date.now() / 1000);
	const head = b64url({ alg: 'RS256', kid: KID, typ: 'JWT' });
	const body = b64url({
		sub,
		'cognito:username': `dev_${sub}`,
		token_use: 'id',
		iss: ORIGIN,
		aud: CLIENT_ID,
		iat: now,
		exp: now + 300
	});
	const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey);
	return `${head}.${body}.${sig.toString('base64url')}`;
}

// Authorization codes and refresh tokens. In memory, because a dev identity
// provider that survived a restart would be a database nobody asked for.
const codes = new Map(); // code -> { challenge, sub }
const sessions = new Map(); // refresh token -> sub
const deleted = new Set(); // subs whose "pool record" is gone

const newSession = (sub = randomUUID()) => {
	const refresh = randomBytes(24).toString('base64url');
	sessions.set(refresh, sub);
	return { id_token: idToken(sub), refresh_token: refresh };
};

const s256 = (v) => createHash('sha256').update(v, 'utf8').digest('base64url');

const WEB_ORIGIN = process.env.DEV_WEB_ORIGIN || 'http://127.0.0.1:5179';

// --- the Stripe double ------------------------------------------------------

// Stands in for the hosted checkout page's URL only. Everything the webhook
// then checks — the signature, the timestamp window, the payment status, the
// client_reference_id — is produced here for real and verified by the shipped
// handler.
async function createSession({ secretKey, price, reference, successUrl, cancelUrl }) {
	// The real client would fail on a wrong key; so does this, so a
	// misconfigured product map is as visible locally as it is in production.
	if (secretKey !== STRIPE_KEY) throw new Error('stripe checkout failed: 401');
	if (!price || !successUrl || !cancelUrl) throw new Error('stripe checkout failed: 400');
	const u = new URL('/stripe-checkout', ORIGIN);
	u.search = new URLSearchParams({ ref: reference, success: successUrl, cancel: cancelUrl }).toString();
	return u.toString();
}

// The delivery Stripe would make: a real event body, signed the way Stripe signs
// it, posted into the real webhook handler.
async function deliverPaidEvent(reference) {
	const body = JSON.stringify({
		id: `evt_${randomBytes(8).toString('hex')}`,
		type: 'checkout.session.completed',
		data: {
			object: {
				id: `cs_test_${randomBytes(8).toString('hex')}`,
				object: 'checkout.session',
				mode: 'payment',
				payment_status: 'paid',
				client_reference_id: reference
			}
		}
	});
	const t = Math.floor(Date.now() / 1000);
	const v1 = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${body}`, 'utf8').digest('hex');
	return purchaseWebhook({ body, headers: { 'stripe-signature': `t=${t},v1=${v1}` } });
}

// --- the real handlers ------------------------------------------------------

const handlers = makeEntitlementHandlers(doc, {
	getJwks: async () => JWKS,
	deleteUser: async (username) => deleted.add(username.replace(/^dev_/, '')),
	issuer: ORIGIN,
	clientProducts: { [CLIENT_ID]: PRODUCT },
	productPeppers: { [PRODUCT]: 'dev-pepper' },
	capabilitySecret: CAPABILITY_SECRET,
	// Parity with api/src/identity-lambda.mjs, on purpose: the journey suite
	// exists to prove the REAL mint refuses the unpaid, and a capability absent
	// here would make that refusal a config accident instead of a proof. Every
	// video number is Matt's pricing gate (docs/ephemeral-video-design.md).
	capabilityLimits: {
		[PRODUCT]: {
			'transfer.multipart': { maxParts: 64 },
			'video.send': { maxSegments: 128 },
			'video.extend': { extensions: 1 }
		}
	},
	capabilityCosts: {
		[PRODUCT]: {
			'video.send': { credits: 2, prepaidExtensionCredits: 1 },
			'video.extend': { credits: 1 }
		}
	},
	// This switch exists only in the local identity harness. The production
	// Lambda never reads this environment variable or passes this option.
	developmentBypass: DEVELOPMENT_ENTITLEMENT_BYPASS
});

const { checkout: startCheckout, webhook: purchaseWebhook } = makePurchaseHandlers(doc, {
	identify: handlers.identify,
	secretKeys: { [PRODUCT]: STRIPE_KEY },
	webhookSecrets: { [PRODUCT]: WEBHOOK_SECRET },
	prices: { [PRODUCT]: PRICE_ID },
	urls: { [PRODUCT]: { success: `${WEB_ORIGIN}/pro/done`, cancel: `${WEB_ORIGIN}/pro` } },
	// In LIVE-TEST the shipped Stripe client runs, so the session is created by
	// the same code production uses and the browser is sent to Stripe's own
	// hosted page. The double is only ever the stand-in for that page.
	createSession: REAL_STRIPE ? createCheckoutSession : createSession
});

// --- transport --------------------------------------------------------------

const cors = {
	'access-control-allow-origin': '*',
	'access-control-allow-methods': 'GET, POST, OPTIONS',
	'access-control-allow-headers': 'content-type, authorization'
};

const readBody = (req) =>
	new Promise((resolve) => {
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => resolve(Buffer.concat(chunks).toString()));
	});

const send = (res, status, headers, body) => {
	res.writeHead(status, { ...cors, ...headers });
	res.end(body);
};

const server = createServer(async (req, res) => {
	if (req.method === 'OPTIONS') return send(res, 204, {}, '');

	const url = new URL(req.url, ORIGIN);
	const path = url.pathname;

	try {
		if (req.method === 'GET' && path === '/.well-known/jwks.json') {
			return send(res, 200, { 'content-type': 'application/json' }, JSON.stringify(JWKS));
		}

		// Deliberately absent unless the local harness was started in review mode.
		// This issues a normal signed dev token; every capability still crosses the
		// shipped verifier before the entitlement bypass can skip a credit spend.
		if (req.method === 'POST' && path === '/dev/session' && DEVELOPMENT_INSTANT_SESSION) {
			return send(
				res,
				200,
				{ 'content-type': 'application/json' },
				JSON.stringify(newSession())
			);
		}

		// The hosted UI's authorize step. A real one shows Apple or Google; this
		// one allocates a fresh account and comes straight back, so every run of
		// the journey starts from an account that has never paid.
		if (req.method === 'GET' && path === '/oauth2/authorize') {
			const code = randomBytes(16).toString('base64url');
			codes.set(code, {
				challenge: url.searchParams.get('code_challenge'),
				sub: randomUUID()
			});
			const back = new URL(url.searchParams.get('redirect_uri'));
			back.searchParams.set('code', code);
			return send(res, 302, { location: back.toString() }, '');
		}

		if (req.method === 'POST' && path === '/oauth2/token') {
			const form = new URLSearchParams(await readBody(req));
			if (form.get('grant_type') === 'authorization_code') {
				const entry = codes.get(form.get('code'));
				// One use, and PKCE is verified for real: a wrong verifier fails here
				// exactly as it would at Cognito.
				codes.delete(form.get('code'));
				if (!entry || entry.challenge !== s256(form.get('code_verifier') || '')) {
					return send(res, 400, {}, '{"error":"invalid_grant"}');
				}
				return send(
					res,
					200,
					{ 'content-type': 'application/json' },
					JSON.stringify(newSession(entry.sub))
				);
			}

			const sub = sessions.get(form.get('refresh_token'));
			if (!sub || deleted.has(sub)) return send(res, 400, {}, '{"error":"invalid_grant"}');
			return send(
				res,
				200,
				{ 'content-type': 'application/json' },
				JSON.stringify({ id_token: idToken(sub) })
			);
		}

		if (req.method === 'POST' && path === '/oauth2/revoke') {
			sessions.delete(new URLSearchParams(await readBody(req)).get('token'));
			return send(res, 200, {}, '');
		}

		// Stripe's hosted page, compressed to a redirect. Paying is arriving here.
		if (req.method === 'GET' && path === '/stripe-checkout') {
			await deliverPaidEvent(url.searchParams.get('ref'));
			return send(res, 302, { location: url.searchParams.get('success') }, '');
		}

		const routes = {
			'/entitlement': handlers.checkEntitlement,
			'/capability': handlers.mintCapability,
			'/account/delete': handlers.deleteAccount,
			'/purchase/checkout': startCheckout,
			'/purchase/webhook': purchaseWebhook
		};
		const handler = routes[path];
		if (req.method === 'POST' && handler) {
			const result = await handler({ body: await readBody(req), headers: req.headers });
			return send(res, result.statusCode, result.headers || {}, result.body);
		}

		return send(res, 404, {}, '{"error":"not found"}');
	} catch (e) {
		return send(res, 500, {}, JSON.stringify({ error: String(e?.message || e) }));
	}
});

async function ensureTable() {
	try {
		await raw.send(new DescribeTableCommand({ TableName: process.env.ENTITLEMENT_TABLE }));
	} catch {
		await raw.send(
			new CreateTableCommand({
				TableName: process.env.ENTITLEMENT_TABLE,
				AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
				KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
				BillingMode: 'PAY_PER_REQUEST'
			})
		);
	}
}

await ensureTable();
server.listen(PORT, HOST, () => {
	console.log(
		`dev-identity on ${ORIGIN}  stripe=${REAL_STRIPE ? `LIVE-TEST (${PRICE_ID})` : 'DOUBLE'}  entitlement-bypass=${DEVELOPMENT_ENTITLEMENT_BYPASS ? 'ON' : 'off'}  instant-session=${DEVELOPMENT_INSTANT_SESSION ? 'ON' : 'off'}`
	);
	if (DEVELOPMENT_INSTANT_SESSION) {
		console.warn('DEVELOPMENT INSTANT SESSION ACTIVE: this local server signs a session on request');
	}
	if (DEVELOPMENT_ENTITLEMENT_BYPASS) {
		console.warn(
			'DEVELOPMENT ENTITLEMENT BYPASS ACTIVE: authenticated capability mints do not read or spend credits'
		);
	}
});
