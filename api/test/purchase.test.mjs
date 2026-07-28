// The adversarial suite for the purchase path.
//
// Every test below is an attack, not a feature. The question this file answers
// is not "does paying work" — it is "what does someone who never paid have to
// hold in order to become entitled?" The answer has to be: the webhook secret.
//
// Needs DynamoDB Local on :8000 (./scripts/dynamodb-local.sh).

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import {
	DynamoDBClient,
	CreateTableCommand,
	DeleteTableCommand,
	ScanCommand
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { makePurchaseHandlers } from '../src/purchase.mjs';
import { verifyStripeSignature, purchaseReference } from '../src/entitlement-logic.mjs';
import { readCredits, addCredits } from '../src/entitlement-store.mjs';
import { readPendingPurchase } from '../src/purchase-store.mjs';

const TABLE = 'mattos-entitlements-p';
process.env.ENTITLEMENT_TABLE = TABLE;

const cfg = {
	region: 'us-east-1',
	endpoint: 'http://localhost:8000',
	credentials: { accessKeyId: 'x', secretAccessKey: 'x' }
};
const raw = new DynamoDBClient(cfg);
const doc = DynamoDBDocumentClient.from(raw);

const WEBHOOK_SECRET = 'whsec_test_only_never_a_real_secret';
const PRICE = 'price_test_cinder_pro';
const PRODUCT = 'cinder';
const PAIRWISE = 'aGVsbG8gdGhlcmUgdGhpcyBpcyBhIHRlc3QgaG1hYyB2YWx1ZQ==';

// A second mattOS product, with its OWN Stripe account, whose webhook endpoint
// points at this same URL. It exists in this suite only so the cross-account
// attack has something to attack with.
const OTHER_PRODUCT = 'someotherproduct';
const OTHER_WEBHOOK_SECRET = 'whsec_a_completely_different_stripe_account';

// --- helpers ----------------------------------------------------------------

// Sign a body the way Stripe does, so the suite can produce genuine signatures
// as well as forged ones. `secret` and `t` are parameters precisely so the
// attacks can vary them.
function sign(body, { secret = WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000) } = {}) {
	const v1 = createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest('hex');
	return `t=${t},v1=${v1}`;
}

const sessionEvent = (reference, { type = 'checkout.session.completed', status = 'paid' } = {}) =>
	JSON.stringify({
		id: `evt_${randomBytes(8).toString('hex')}`,
		type,
		data: { object: { id: `cs_test_${randomBytes(8).toString('hex')}`, payment_status: status, client_reference_id: reference } }
	});

// "Did this person end up able to send?" — the question every attack below is
// really asking. It is a balance now rather than a flag, so the count itself is
// asserted wherever the count is the point.
const hasCredits = async (product = PRODUCT) =>
	(await readCredits(doc, product, PAIRWISE)) > 0;

const post = (body, sigHeader) => ({ body, headers: { 'stripe-signature': sigHeader } });

// A stand-in for the identity lane. Returns whoever the test says is calling.
let caller = null;
const identify = async () => caller;

// A Stripe that never gets called for real. Recorded so the suite can assert
// what WOULD have been sent, and assert that it was not sent at all.
let sessionsCreated = [];
const createSession = async (args) => {
	sessionsCreated.push(args);
	return `https://checkout.stripe.test/${args.reference}`;
};

const handlers = makePurchaseHandlers(doc, {
	identify,
	// Per-product maps, not constants: Cinder has its own Stripe account so a
	// card statement reads CINDER.INK. OTHER_PRODUCT below is a second account
	// configured at the same webhook URL, which is the whole point of the maps
	// and the source of one of the attacks.
	secretKeys: { [PRODUCT]: 'sk_test_never_real', [OTHER_PRODUCT]: 'sk_test_also_never_real' },
	webhookSecrets: { [PRODUCT]: WEBHOOK_SECRET, [OTHER_PRODUCT]: OTHER_WEBHOOK_SECRET },
	prices: { [PRODUCT]: PRICE, [OTHER_PRODUCT]: 'price_test_other' },
	urls: {
		[PRODUCT]: { success: 'https://cinder.ink/pro/done', cancel: 'https://cinder.ink/pro' },
		[OTHER_PRODUCT]: { success: 'https://elsewhere.test/done', cancel: 'https://elsewhere.test/' }
	},
	createSession
});

const body = (res) => JSON.parse(res.body);

// Mint a pending purchase the way checkout does, and return its nonce.
async function startedCheckout() {
	caller = { product: PRODUCT, pairwise: PAIRWISE };
	sessionsCreated = [];
	const res = await handlers.checkout({});
	assert.equal(res.statusCode, 200);
	return sessionsCreated.at(-1).reference;
}

before(async () => {
	await raw
		.send(
			new CreateTableCommand({
				TableName: TABLE,
				BillingMode: 'PAY_PER_REQUEST',
				AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
				KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }]
			})
		)
		.catch((e) => {
			if (e.name !== 'ResourceInUseException') throw e;
		});
});

after(async () => {
	await raw.send(new DeleteTableCommand({ TableName: TABLE })).catch(() => {});
});

beforeEach(async () => {
	// Empty the table between tests: a grant leaking across tests would make a
	// failing gate look like a passing one.
	const scan = await raw.send(new ScanCommand({ TableName: TABLE }));
	for (const item of scan.Items ?? []) {
		await raw.send(
			new (await import('@aws-sdk/client-dynamodb')).DeleteItemCommand({
				TableName: TABLE,
				Key: { pk: item.pk }
			})
		);
	}
	caller = null;
	sessionsCreated = [];
});

// === ATTACK 1-8: the signature ==============================================
// These are pure and need no database, because a request that fails here never
// reaches one.

test('attack: forged signature, HMAC computed with the attacker’s own secret', async () => {
	const nonce = await startedCheckout();
	const payload = sessionEvent(nonce);
	const res = await handlers.webhook(post(payload, sign(payload, { secret: 'whsec_attacker' })));
	assert.equal(res.statusCode, 400);
	assert.equal(body(res).error, 'bad_signature');
	assert.equal(await hasCredits(PRODUCT), false);
});

test('attack: no signature header at all', async () => {
	const nonce = await startedCheckout();
	const res = await handlers.webhook({ body: sessionEvent(nonce), headers: {} });
	assert.equal(res.statusCode, 400);
	assert.equal(await hasCredits(PRODUCT), false);
});

test('attack: malformed signature header (no = separator, junk, empty v1)', () => {
	const b = '{}';
	for (const header of ['garbage', 't=1,v1', 'v1=deadbeef', 't=,v1=', 't=abc,v1=deadbeef', '']) {
		assert.equal(verifyStripeSignature(b, header, WEBHOOK_SECRET), false, header);
	}
});

test('attack: replay of a captured request outside the 300s window', () => {
	const b = sessionEvent('nonce');
	const t = Math.floor(Date.now() / 1000) - 301;
	// The signature is GENUINELY Stripe's — this is a recording, not a forgery.
	assert.equal(verifyStripeSignature(b, sign(b, { t }), WEBHOOK_SECRET), false);
	// One second inside the window still verifies, proving the boundary is the
	// thing being tested and not a blanket rejection.
	const fresh = Math.floor(Date.now() / 1000) - 299;
	assert.equal(verifyStripeSignature(b, sign(b, { t: fresh }), WEBHOOK_SECRET), true);
});

test('attack: timestamp from the future, beyond the window', () => {
	const b = sessionEvent('nonce');
	const t = Math.floor(Date.now() / 1000) + 301;
	assert.equal(verifyStripeSignature(b, sign(b, { t }), WEBHOOK_SECRET), false);
});

test('attack: body tampered after signing', async () => {
	const nonce = await startedCheckout();
	const original = sessionEvent(nonce, { status: 'unpaid' });
	const header = sign(original);
	// Flip unpaid → paid while keeping the signature that covered the original.
	const tampered = original.replace('"unpaid"', '"paid"');
	assert.notEqual(tampered, original);
	const res = await handlers.webhook(post(tampered, header));
	assert.equal(res.statusCode, 400);
	assert.equal(await hasCredits(PRODUCT), false);
});

test('attack: a valid signature lifted from a different body', async () => {
	const nonce = await startedCheckout();
	const other = sessionEvent('someone-elses-nonce');
	const res = await handlers.webhook(post(sessionEvent(nonce), sign(other)));
	assert.equal(res.statusCode, 400);
	assert.equal(await hasCredits(PRODUCT), false);
});

test('rotation: two v1 values, only one of which is ours, still verifies', () => {
	const b = sessionEvent('nonce');
	const t = Math.floor(Date.now() / 1000);
	const mine = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${b}`).digest('hex');
	const other = createHmac('sha256', 'whsec_the_other_half_of_a_rotation').update(`${t}.${b}`).digest('hex');
	// Ours second (undertext's fromEntries would keep this one and pass) …
	assert.equal(verifyStripeSignature(b, `t=${t},v1=${other},v1=${mine}`, WEBHOOK_SECRET), true);
	// … and ours FIRST, which is the case that regressed.
	assert.equal(verifyStripeSignature(b, `t=${t},v1=${mine},v1=${other}`, WEBHOOK_SECRET), true);
	// Neither ours: still no.
	assert.equal(verifyStripeSignature(b, `t=${t},v1=${other},v1=${other}`, WEBHOOK_SECRET), false);
});

test('attack: v0 signature only, no v1', () => {
	const b = sessionEvent('nonce');
	const t = Math.floor(Date.now() / 1000);
	const v0 = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${b}`).digest('hex');
	assert.equal(verifyStripeSignature(b, `t=${t},v0=${v0}`, WEBHOOK_SECRET), false);
});

test('attack: signature of a different length does not throw', () => {
	const b = '{}';
	const t = Math.floor(Date.now() / 1000);
	assert.equal(verifyStripeSignature(b, `t=${t},v1=ab`, WEBHOOK_SECRET), false);
	assert.equal(verifyStripeSignature(b, `t=${t},v1=${'a'.repeat(500)}`, WEBHOOK_SECRET), false);
});

test('attack: an empty or missing webhook secret never verifies anything', () => {
	const b = '{}';
	assert.equal(verifyStripeSignature(b, sign(b), ''), false);
	assert.equal(verifyStripeSignature(b, sign(b), undefined), false);
});

// === ATTACK 9-14: what a correctly signed event is allowed to do =============

test('attack: grant attempted without a completed payment (payment_status unpaid)', async () => {
	const nonce = await startedCheckout();
	const payload = sessionEvent(nonce, { status: 'unpaid' });
	const res = await handlers.webhook(post(payload, sign(payload)));
	// 200 so Stripe stops retrying, and nothing granted.
	assert.equal(res.statusCode, 200);
	assert.equal(await hasCredits(PRODUCT), false);
	// The pending row survives, so the later async_payment_succeeded can still pay out.
	assert.ok(await readPendingPurchase(doc, nonce, Math.floor(Date.now() / 1000)));
});

test('async settlement: unpaid completed, then async_payment_succeeded, credits once', async () => {
	const nonce = await startedCheckout();
	const first = sessionEvent(nonce, { status: 'unpaid' });
	await handlers.webhook(post(first, sign(first)));
	assert.equal(await hasCredits(PRODUCT), false);

	const second = sessionEvent(nonce, { type: 'checkout.session.async_payment_succeeded' });
	await handlers.webhook(post(second, sign(second)));
	assert.equal(await readCredits(doc, PRODUCT, PAIRWISE), 10);
});

test('out-of-order delivery: async_payment_succeeded arrives before completed', async () => {
	const nonce = await startedCheckout();
	const later = sessionEvent(nonce, { type: 'checkout.session.async_payment_succeeded' });
	await handlers.webhook(post(later, sign(later)));
	assert.equal(await hasCredits(PRODUCT), true);

	// The earlier event now lands. It must not un-grant, and it must not create a
	// second entitlement — the reference is already cleared, so it is a no-op.
	const earlier = sessionEvent(nonce, { type: 'checkout.session.completed' });
	const res = await handlers.webhook(post(earlier, sign(earlier)));
	assert.equal(res.statusCode, 200);
	assert.equal(await readCredits(doc, PRODUCT, PAIRWISE), 10, 'not a second bundle');
});

test('duplicate delivery: the same event five times buys exactly one bundle', async () => {
	// THE MONEY BUG THIS SUITE EXISTS FOR, under credits. Stripe guarantees
	// at-least-once delivery. Under the boolean a duplicate rewrote the identical
	// row and cost nothing; under a counter, five deliveries of one payment would
	// be fifty credits. The exclusive claim on the pending row is what stops it.
	const nonce = await startedCheckout();
	const payload = sessionEvent(nonce);
	const header = sign(payload);
	for (let i = 0; i < 5; i++) {
		assert.equal((await handlers.webhook(post(payload, header))).statusCode, 200);
	}
	assert.equal(await readCredits(doc, PRODUCT, PAIRWISE), 10, 'one bundle, not five');

	const scan = await raw.send(new ScanCommand({ TableName: TABLE }));
	const granted = (scan.Items ?? []).filter((i) => i.credits);
	assert.equal(granted.length, 1, 'exactly one entitlement row');
	// And the translation row is gone, so nothing maps Stripe's reference to a person.
	assert.equal(await readPendingPurchase(doc, nonce, Math.floor(Date.now() / 1000)), null);
});

test('attack: a genuine paid event for a session this server never created', async () => {
	// Correct secret, fresh timestamp, payment_status paid — everything except a
	// pending row. This is the shape of another product in the same Stripe
	// account, or a payment link created by hand in the dashboard.
	const payload = sessionEvent(randomBytes(32).toString('base64url'));
	const res = await handlers.webhook(post(payload, sign(payload)));
	assert.equal(res.statusCode, 200);
	const scan = await raw.send(new ScanCommand({ TableName: TABLE }));
	assert.equal((scan.Items ?? []).length, 0, 'nothing written');
});

test('attack: an event type that settles nothing', async () => {
	const nonce = await startedCheckout();
	for (const type of ['payment_intent.succeeded', 'charge.succeeded', 'invoice.paid', 'checkout.session.expired']) {
		const payload = JSON.stringify({
			type,
			data: { object: { payment_status: 'paid', client_reference_id: nonce } }
		});
		const res = await handlers.webhook(post(payload, sign(payload)));
		assert.equal(res.statusCode, 200, type);
		assert.equal(await hasCredits(PRODUCT), false, type);
	}
});

test('attack: replay of a genuine event after its reference was cleared', async () => {
	const nonce = await startedCheckout();
	const payload = sessionEvent(nonce);
	const header = sign(payload);
	await handlers.webhook(post(payload, header));

	// Forget the credits, then replay. The reference no longer resolves, so the
	// replay cannot re-establish it — a captured event is not a spare key, and it
	// is not a free top-up either.
	const { forgetEntitlement } = await import('../src/entitlement-store.mjs');
	await forgetEntitlement(doc, PRODUCT, PAIRWISE);
	await handlers.webhook(post(payload, header));
	assert.equal(await hasCredits(PRODUCT), false);
});

test('attack: an oversized or non-string client_reference_id', () => {
	for (const ref of ['a'.repeat(129), '', null, 42, { toString: () => 'x' }, undefined]) {
		const payload = {
			type: 'checkout.session.completed',
			data: { object: { payment_status: 'paid', client_reference_id: ref } }
		};
		assert.equal(purchaseReference(payload), null, String(ref));
	}
});

test('attack: a malformed event body with a valid signature', async () => {
	for (const payload of ['not json', '[]', 'null', '{"data":{"object":null},"type":"checkout.session.completed"}']) {
		const res = await handlers.webhook(post(payload, sign(payload)));
		assert.ok(res.statusCode === 200 || res.statusCode === 400, payload);
		assert.equal(await hasCredits(PRODUCT), false, payload);
	}
});

// === ATTACK 15-18: checkout =================================================

test('attack: checkout without a token creates no session and no pending row', async () => {
	caller = null;
	const res = await handlers.checkout({});
	assert.equal(body(res).url, null);
	assert.equal(sessionsCreated.length, 0, 'Stripe was never called');
	const scan = await raw.send(new ScanCommand({ TableName: TABLE }));
	assert.equal((scan.Items ?? []).length, 0);
});

test('checkout lets someone with credits buy more, and the balance accumulates', async () => {
	// Under the one-time unlock this was a refusal. Under credits it is the
	// model: someone with two left who is about to send five files has to be able
	// to top up, and a purchase must ADD rather than overwrite.
	await addCredits(doc, PRODUCT, PAIRWISE, 2);
	const nonce = await startedCheckout();
	assert.equal(sessionsCreated.length, 1, 'Stripe was called, not refused');

	const payload = sessionEvent(nonce);
	await handlers.webhook(post(payload, sign(payload)));
	assert.equal(await readCredits(doc, PRODUCT, PAIRWISE), 12, '2 kept, 10 added');
});

test('checkout fails closed when the product has no configured price', async () => {
	caller = { product: 'some-other-product', pairwise: PAIRWISE };
	const res = await handlers.checkout({});
	assert.equal(body(res).url, null);
	assert.equal(sessionsCreated.length, 0);
});

test('the nonce is what Stripe is given, and it is not derived from the subject', async () => {
	const nonce = await startedCheckout();
	assert.match(nonce, /^[A-Za-z0-9_-]{43}$/);
	assert.ok(!nonce.includes(PAIRWISE));
	// A second checkout mints a different nonce, so two payments are not linkable
	// to each other through Stripe's reference either.
	const again = await startedCheckout();
	assert.notEqual(nonce, again);
	// Stripe is handed the nonce and the price, and nothing about the person.
	const sent = sessionsCreated.at(-1);
	assert.equal(sent.price, PRICE);
	assert.equal(sent.reference, again);
	assert.equal(JSON.stringify(sent).includes(PAIRWISE), false, 'no subject reaches Stripe');
});

test('the pending row never stores the nonce in the clear', async () => {
	const nonce = await startedCheckout();
	const scan = await raw.send(new ScanCommand({ TableName: TABLE }));
	const dumped = JSON.stringify(scan.Items);
	assert.equal(dumped.includes(nonce), false, 'a table dump cannot be replayed at the webhook');
});

test('a base64-encoded body is verified against the decoded bytes', async () => {
	const nonce = await startedCheckout();
	const payload = sessionEvent(nonce);
	const res = await handlers.webhook({
		body: Buffer.from(payload, 'utf8').toString('base64'),
		isBase64Encoded: true,
		headers: { 'stripe-signature': sign(payload) }
	});
	assert.equal(res.statusCode, 200);
	assert.equal(await hasCredits(PRODUCT), true);
});

// === ATTACK 19-21: one webhook URL, several Stripe accounts ==================

test('attack: another product’s Stripe account cannot grant Cinder', async () => {
	const nonce = await startedCheckout(); // a pending row for PRODUCT
	const payload = sessionEvent(nonce);
	// Perfectly valid — correct HMAC, fresh timestamp, paid — but signed by the
	// OTHER product's account. Someone holding one product's webhook secret must
	// not be able to grant every product, which is precisely the containment
	// separate Stripe accounts are supposed to buy.
	const res = await handlers.webhook(post(payload, sign(payload, { secret: OTHER_WEBHOOK_SECRET })));
	assert.equal(res.statusCode, 200);
	assert.equal(await hasCredits(PRODUCT), false);
});

test('each product’s own account still grants its own product', async () => {
	caller = { product: OTHER_PRODUCT, pairwise: PAIRWISE };
	sessionsCreated = [];
	await handlers.checkout({});
	const nonce = sessionsCreated.at(-1).reference;

	const payload = sessionEvent(nonce);
	await handlers.webhook(post(payload, sign(payload, { secret: OTHER_WEBHOOK_SECRET })));
	assert.equal(await hasCredits(OTHER_PRODUCT), true);
	// And the same person is NOT entitled to Cinder off the back of it.
	assert.equal(await hasCredits(PRODUCT), false);
});

test('checkout uses the calling product’s own Stripe account key', async () => {
	caller = { product: OTHER_PRODUCT, pairwise: PAIRWISE };
	sessionsCreated = [];
	await handlers.checkout({});
	assert.equal(sessionsCreated.at(-1).secretKey, 'sk_test_also_never_real');
	assert.equal(sessionsCreated.at(-1).price, 'price_test_other');
});

test('checkout fails closed when a product has a price but no Stripe account key', async () => {
	const bare = makePurchaseHandlers(doc, {
		identify,
		secretKeys: {},
		webhookSecrets: { [PRODUCT]: WEBHOOK_SECRET },
		prices: { [PRODUCT]: PRICE },
		urls: { [PRODUCT]: { success: 'https://cinder.ink/pro/done', cancel: 'https://cinder.ink/pro' } },
		createSession
	});
	caller = { product: PRODUCT, pairwise: PAIRWISE };
	sessionsCreated = [];
	const res = await bare.checkout({});
	assert.equal(JSON.parse(res.body).url, null);
	assert.equal(sessionsCreated.length, 0, 'never billed another product’s account');
});

test('no webhook secret configured at all grants nothing', async () => {
	const deaf = makePurchaseHandlers(doc, {
		identify,
		secretKeys: {},
		webhookSecrets: {},
		prices: {},
		urls: {},
		createSession
	});
	const payload = sessionEvent('anything');
	const res = await deaf.webhook(post(payload, sign(payload)));
	assert.equal(res.statusCode, 400);
});
