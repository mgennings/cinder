// The counter, under contention.
//
// Everything else about prepaid credits is ordinary code. Two things are not,
// and both of them are money bugs rather than logic bugs, which means they are
// silent, they favor the wrong party, and they only appear under a race:
//
//   1. SPENDING. Two sends in flight against a balance of one must hand out ONE
//      grant. A read-then-write would hand out two and write zero twice, and
//      nothing downstream would ever notice — the transfer works, the balance
//      looks right, and the person got a send they did not pay for.
//   2. CREDITING. Stripe delivers at least once. Two deliveries of one payment
//      must add ONE bundle. Under the boolean this was free; under a counter a
//      duplicate is a double charge in the customer's favor and a broken ledger
//      in ours.
//
// So this file runs both concurrently against DynamoDB Local — a real
// conditional update, on a real partition, with real optimistic contention —
// rather than against a mock that could only ever confirm what it was written
// to confirm.
//
// Needs DynamoDB Local on :8000 (./scripts/dynamodb-local.sh).

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import {
	DynamoDBClient,
	CreateTableCommand,
	DeleteTableCommand,
	GetItemCommand
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { readCredits, addCredits, spendCredit } from '../src/entitlement-store.mjs';
import { makePurchaseHandlers } from '../src/purchase.mjs';

const TABLE = 'mattos-entitlements-c';
process.env.ENTITLEMENT_TABLE = TABLE;

const raw = new DynamoDBClient({
	region: 'us-east-1',
	endpoint: 'http://localhost:8000',
	credentials: { accessKeyId: 'x', secretAccessKey: 'x' }
});
const doc = DynamoDBDocumentClient.from(raw);

const PRODUCT = 'cinder';
const PAIRWISE = 'Y3JlZGl0cyB0ZXN0IHBhaXJ3aXNlIHN1YmplY3Q=';
const WEBHOOK_SECRET = 'whsec_credits_test_only';
const CREDITS = 10;

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

// The row as DynamoDB actually holds it. readCredits clamps a nonsense value to
// zero, which is right for the product and wrong for a test about the floor: a
// clamp that hides a negative balance hides the bug.
const rawItem = (pairwise) =>
	raw.send(new GetItemCommand({ TableName: TABLE, Key: { pk: { S: `${PRODUCT}#${pairwise}` } } }));

// --- the spend --------------------------------------------------------------

test('N simultaneous spends against a balance of M take exactly M', async () => {
	const pairwise = `${PAIRWISE}-spend`;
	const M = 7;
	const N = 40;
	await addCredits(doc, PRODUCT, pairwise, M);

	// Fired together, deliberately not awaited in sequence: this is the shape of
	// forty tabs pressing send at once, which is the only shape that finds the
	// bug.
	const results = await Promise.all(
		Array.from({ length: N }, () => spendCredit(doc, PRODUCT, pairwise))
	);

	assert.equal(results.filter(Boolean).length, M, 'exactly M spends succeeded');
	assert.equal(results.filter((r) => !r).length, N - M, 'the rest were refused, not queued');
	assert.equal(await readCredits(doc, PRODUCT, pairwise), 0);
});

test('the balance never goes below zero, however hard it is pushed', async () => {
	const pairwise = `${PAIRWISE}-floor`;
	await addCredits(doc, PRODUCT, pairwise, 1);
	await Promise.all(Array.from({ length: 25 }, () => spendCredit(doc, PRODUCT, pairwise)));

	// Read the RAW attribute, not readCredits, which clamps. A clamp that hides a
	// negative row is a clamp that hides the bug.
	const { Item } = await rawItem(pairwise);
	assert.equal(Number(Item.credits.N), 0);
});

test('spending against a row that never existed is false, and creates nothing', async () => {
	const pairwise = `${PAIRWISE}-absent`;
	assert.equal(await spendCredit(doc, PRODUCT, pairwise), false);
	assert.equal(await readCredits(doc, PRODUCT, pairwise), 0);
	const { Item } = await rawItem(pairwise);
	assert.equal(Item, undefined, 'a refused spend must not conjure a row');
});

// --- the credit -------------------------------------------------------------

let caller = null;
let sessionsCreated = [];

const handlers = makePurchaseHandlers(doc, {
	identify: async () => caller,
	secretKeys: { [PRODUCT]: 'sk_test_never_real' },
	webhookSecrets: { [PRODUCT]: WEBHOOK_SECRET },
	prices: { [PRODUCT]: 'price_test' },
	urls: { [PRODUCT]: { success: 'https://cinder.ink/pro/done', cancel: 'https://cinder.ink/pro' } },
	credits: { [PRODUCT]: CREDITS },
	createSession: async (args) => {
		sessionsCreated.push(args);
		return `https://checkout.stripe.test/${args.reference}`;
	}
});

const sessionEvent = (reference) =>
	JSON.stringify({
		id: `evt_${randomBytes(8).toString('hex')}`,
		type: 'checkout.session.completed',
		data: { object: { payment_status: 'paid', client_reference_id: reference } }
	});

function signed(bodyText) {
	const t = Math.floor(Date.now() / 1000);
	const v1 = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${bodyText}`, 'utf8').digest('hex');
	return { body: bodyText, headers: { 'stripe-signature': `t=${t},v1=${v1}` } };
}

async function checkout(pairwise) {
	caller = { product: PRODUCT, pairwise };
	sessionsCreated = [];
	await handlers.checkout({});
	return sessionsCreated.at(-1).reference;
}

beforeEach(() => {
	caller = null;
	sessionsCreated = [];
});

test('ten simultaneous deliveries of one payment add one bundle', async () => {
	const pairwise = `${PAIRWISE}-webhook`;
	const nonce = await checkout(pairwise);
	const delivery = signed(sessionEvent(nonce));

	// All at once, which is the case a sequential loop cannot reach: the read,
	// the cross-check, and the claim interleave across ten invocations. Only the
	// claim is atomic, and it is the only thing that has to be.
	const results = await Promise.all(
		Array.from({ length: 10 }, () => handlers.webhook({ ...delivery }))
	);
	for (const res of results) assert.equal(res.statusCode, 200);
	assert.equal(await readCredits(doc, PRODUCT, pairwise), CREDITS, 'one bundle, not ten');
});

test('two separate purchases accumulate', async () => {
	const pairwise = `${PAIRWISE}-topup`;
	for (let i = 0; i < 2; i++) {
		const nonce = await checkout(pairwise);
		const delivery = signed(sessionEvent(nonce));
		await handlers.webhook(delivery);
		// Replaying the first purchase's delivery after the second must still add
		// nothing: its pending row is claimed and gone.
		await handlers.webhook(delivery);
	}
	assert.equal(await readCredits(doc, PRODUCT, pairwise), CREDITS * 2);
});

test('buy, spend it all, buy again — the balance is a counter, not a flag', async () => {
	const pairwise = `${PAIRWISE}-cycle`;
	const first = await checkout(pairwise);
	await handlers.webhook(signed(sessionEvent(first)));

	for (let i = 0; i < CREDITS; i++) {
		assert.equal(await spendCredit(doc, PRODUCT, pairwise), true, `spend ${i}`);
	}
	assert.equal(await spendCredit(doc, PRODUCT, pairwise), false, 'empty');

	const second = await checkout(pairwise);
	await handlers.webhook(signed(sessionEvent(second)));
	assert.equal(await readCredits(doc, PRODUCT, pairwise), CREDITS);
});
