// Multipart transfers. The thing under test is NOT "does a big file arrive" —
// it is "is the per-object guarantee at N parts the same guarantee as at one".
// Every assertion below is written against a part, never against a transfer,
// because a transfer is not a unit the server has any concept of.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { makeHandlers } from '../src/handlers.mjs';
import { deriveChunkLocator } from '../src/id.mjs';
import { CAPABILITY, denyAll, checkCapability } from '../src/capabilities.mjs';

const cfg = {
	region: 'us-east-1',
	endpoint: 'http://localhost:8000',
	credentials: { accessKeyId: 'x', secretAccessKey: 'x' }
};
const raw = new DynamoDBClient(cfg);
const doc = DynamoDBDocumentClient.from(raw);
process.env.TABLE_NAME = 'blip-notes-chunked';

before(async () => {
	await raw.send(
		new CreateTableCommand({
			TableName: 'blip-notes-chunked',
			AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
			KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
			BillingMode: 'PAY_PER_REQUEST'
		})
	);
});
after(async () => {
	await raw.send(new DeleteTableCommand({ TableName: 'blip-notes-chunked' }));
});

// Same in-memory bucket as handlers.test.mjs, with per-part failure injection
// keyed by object key so one part of a transfer can be broken while its
// siblings stay healthy — which is the whole point of the partial-failure case.
function fakeS3({ failKeys = {}, stickyDeleteKeys = new Set() } = {}) {
	const objects = new Map();
	return {
		objects,
		put(key, body) {
			objects.set(key, { body, sha: createHash('sha256').update(body).digest('base64') });
		},
		async presignPut({ key, bytes, sha256, expiresIn }) {
			return {
				url: `https://bucket.invalid/${key}`,
				headers: { 'content-length': String(bytes), 'x-amz-checksum-sha256': sha256 },
				expiresIn
			};
		},
		async attributes({ key }) {
			const o = objects.get(key);
			return o ? { contentLength: o.body.length, checksumSha256: o.sha } : null;
		},
		async head({ key }) {
			return objects.has(key) ? {} : null;
		},
		async get({ key }) {
			if (failKeys[key] === 'get') throw new Error('injected get failure');
			const o = objects.get(key);
			if (!o) throw new Error('NoSuchKey');
			return o.body;
		},
		async delete({ key }) {
			if (failKeys[key] === 'delete') throw new Error('injected delete failure');
			if (!stickyDeleteKeys.has(key)) objects.delete(key);
		}
	};
}

// A gate that grants. The payments lane will supply the real one; this is what
// its contract looks like from the transport's side, and nothing more.
const proGate = {
	async check({ grant, capability }) {
		// Asserting the shape here is the point: the gate must be handed a grant
		// and a capability and NOTHING else. If someone ever starts passing the
		// raw event so a provider can peek at a header, this is what notices.
		assert.equal(capability, CAPABILITY.MULTIPART_TRANSFER);
		assert.ok(grant === null || typeof grant === 'string');
		return { granted: true, limits: { maxParts: 64 } };
	}
};

const partBody = (i) => Buffer.from(`part-${i}-`.padEnd(64, 'x'));
const sha = (b) => createHash('sha256').update(b).digest('base64');

// Drives a whole sender journey for an N-part transfer and returns everything a
// test needs to poke at it.
async function makeTransfer(s3, partCount, { events = [], gate = proGate } = {}) {
	const h = makeHandlers(doc, s3, { onEvent: (e) => events.push(e), capabilities: gate });
	const bodies = Array.from({ length: partCount }, (_, i) => partBody(i));

	const created = await h.createFile({
		body: JSON.stringify({
			parts: bodies.map((b) => ({ ciphertextBytes: b.length, ciphertextSha256: sha(b) })),
			ttlSeconds: 3600
		})
	});
	assert.equal(created.statusCode, 201);
	const { locator, uploadCapability, parts } = JSON.parse(created.body);

	const keys = parts.map((p) => new URL(p.upload.url).pathname.slice(1));
	keys.forEach((k, i) => s3.put(k, bodies[i]));

	const locators = await Promise.all(
		parts.map((_, i) => Promise.resolve(deriveChunkLocator(locator, i)))
	);

	return { h, locator, uploadCapability, parts, keys, bodies, locators, events };
}

async function finalizeAll(h, locators, uploadCapability) {
	for (const l of locators) {
		const res = await h.finalizeFile({
			body: JSON.stringify({ locator: l, uploadCapability })
		});
		assert.equal(res.statusCode, 200);
	}
}

// --- the gate ---------------------------------------------------------------

test('an ungated caller cannot create a multi-part transfer', async () => {
	const h = makeHandlers(doc, fakeS3()); // no capabilities → denyAll
	const b = partBody(0);
	const res = await h.createFile({
		body: JSON.stringify({
			parts: [
				{ ciphertextBytes: b.length, ciphertextSha256: sha(b) },
				{ ciphertextBytes: b.length, ciphertextSha256: sha(b) }
			],
			ttlSeconds: 60
		})
	});
	assert.equal(res.statusCode, 402);
});

test('the free single-file path never consults the gate', async () => {
	// A single transfer must cost no entitlement round trip at all, so a gate
	// that throws on every call must not be able to break it.
	let asked = 0;
	const exploding = {
		async check() {
			asked++;
			throw new Error('the gate must not have been asked');
		}
	};
	const h = makeHandlers(doc, fakeS3(), { capabilities: exploding });
	const b = partBody(0);
	const res = await h.createFile({
		body: JSON.stringify({ ciphertextBytes: b.length, ciphertextSha256: sha(b), ttlSeconds: 60 })
	});
	assert.equal(res.statusCode, 201);
	assert.equal(asked, 0);
});

test('a gate that throws denies rather than grants', async () => {
	const exploding = { async check() { throw new Error('provider down'); } };
	const h = makeHandlers(doc, fakeS3(), { capabilities: exploding });
	const b = partBody(0);
	const res = await h.createFile({
		body: JSON.stringify({
			parts: [
				{ ciphertextBytes: b.length, ciphertextSha256: sha(b) },
				{ ciphertextBytes: b.length, ciphertextSha256: sha(b) }
			],
			ttlSeconds: 60
		})
	});
	assert.equal(res.statusCode, 402);
});

test('a malformed decision cannot become a grant', async () => {
	for (const decision of [undefined, null, {}, { granted: 'yes' }, { granted: 1 }]) {
		const gate = { async check() { return decision; } };
		const out = await checkCapability(gate, 'g', CAPABILITY.MULTIPART_TRANSFER, 'maxParts');
		assert.equal(out.granted, false, `${JSON.stringify(decision)} must not grant`);
	}
	// Granted, but with a limit that is not a positive integer → limit zero,
	// never unlimited.
	for (const limits of [undefined, {}, { maxParts: '64' }, { maxParts: 0 }, { maxParts: -1 }]) {
		const gate = { async check() { return { granted: true, limits }; } };
		const out = await checkCapability(gate, 'g', CAPABILITY.MULTIPART_TRANSFER, 'maxParts');
		assert.equal(out.granted, true);
		assert.equal(out.limit, 0);
	}
	assert.equal((await denyAll.check()).granted, false);
});

test("a plan's limit is honored, and the transport's ceiling still wins", async () => {
	const stingy = { async check() { return { granted: true, limits: { maxParts: 3 } }; } };
	const h = makeHandlers(doc, fakeS3(), { capabilities: stingy });
	const b = partBody(0);
	const req = (n) =>
		JSON.stringify({
			parts: Array.from({ length: n }, () => ({
				ciphertextBytes: b.length,
				ciphertextSha256: sha(b)
			})),
			ttlSeconds: 60
		});

	assert.equal((await h.createFile({ body: req(3) })).statusCode, 201);
	assert.equal((await h.createFile({ body: req(4) })).statusCode, 403);

	// Above the transport's own ceiling, a generous plan changes nothing.
	const generous = { async check() { return { granted: true, limits: { maxParts: 10_000 } }; } };
	const h2 = makeHandlers(doc, fakeS3(), { capabilities: generous });
	assert.equal((await h2.createFile({ body: req(65) })).statusCode, 400);
});

// --- the transfer -----------------------------------------------------------

test('every part is an independent grant with its own object key', async () => {
	const s3 = fakeS3();
	const { locator, keys, locators } = await makeTransfer(s3, 5);

	assert.equal(new Set(keys).size, 5, 'no two parts may share an object key');
	assert.equal(new Set(locators).size, 5);
	// A part locator must not be the transfer locator, and no object key may be
	// derivable from anything in the link.
	for (const l of locators) assert.notEqual(l, locator);
	for (const k of keys) {
		assert.ok(!k.includes(locator));
		assert.match(k, /^d1\/[0-9a-f]{64}$/);
	}
});

test('a twelve-part transfer delivers every part exactly once, in order', async () => {
	const s3 = fakeS3();
	const events = [];
	const { h, uploadCapability, locators, bodies } = await makeTransfer(s3, 12, { events });
	await finalizeAll(h, locators, uploadCapability);

	events.length = 0;
	for (let i = 0; i < 12; i++) {
		const res = await h.claimFile({ body: JSON.stringify({ locator: locators[i] }) });
		assert.equal(res.statusCode, 200);
		assert.deepEqual(Buffer.from(res.body, 'base64'), bodies[i]);
	}

	// The guarantee, per part, twelve times: claim, open, delete, prove absent,
	// and only then does a response byte exist. Not once, in aggregate — twelve
	// identical five-step sequences.
	const expected = [];
	for (let i = 0; i < 12; i++) {
		expected.push('claim', 's3-open', 's3-delete', 's3-head-404', 'response-first-byte');
	}
	assert.deepEqual(events, expected);
	assert.equal(s3.objects.size, 0, 'every stored part must be gone');

	// And every part is spent.
	for (const l of locators) {
		assert.equal((await h.claimFile({ body: JSON.stringify({ locator: l }) })).statusCode, 410);
	}
});

test('an unfinalized part is not claimable, so a half-uploaded transfer cannot start', async () => {
	const s3 = fakeS3();
	const { h, uploadCapability, locators } = await makeTransfer(s3, 4);
	// Finalize everything except part 2.
	for (const [i, l] of locators.entries()) {
		if (i === 2) continue;
		await h.finalizeFile({ body: JSON.stringify({ locator: l, uploadCapability }) });
	}

	assert.equal((await h.claimFile({ body: JSON.stringify({ locator: locators[2] }) })).statusCode, 410);
});

test('twenty simultaneous claims on the same part yield exactly one winner', async () => {
	const s3 = fakeS3();
	const { h, uploadCapability, locators, bodies } = await makeTransfer(s3, 3);
	await finalizeAll(h, locators, uploadCapability);

	// The middle part, raced. A part is the unit the guarantee is about, so this
	// is the chunked equivalent of the single-file race and it must behave
	// identically — including for the losers, who must not be able to tell they
	// lost a race rather than opened a link that never existed.
	const results = await Promise.all(
		Array.from({ length: 20 }, () => h.claimFile({ body: JSON.stringify({ locator: locators[1] }) }))
	);
	const won = results.filter((r) => r.statusCode === 200);
	const lost = results.filter((r) => r.statusCode !== 200);
	assert.equal(won.length, 1);
	assert.equal(lost.length, 19);
	assert.deepEqual(Buffer.from(won[0].body, 'base64'), bodies[1]);

	const unknown = await h.claimFile({ body: JSON.stringify({ locator: 'never-existed' }) });
	for (const r of lost) {
		assert.equal(r.statusCode, unknown.statusCode);
		assert.equal(r.body, unknown.body);
	}

	// Losing the race for part 1 left parts 0 and 2 untouched. Contention on one
	// part must not consume its siblings.
	assert.equal((await h.claimFile({ body: JSON.stringify({ locator: locators[0] }) })).statusCode, 200);
	assert.equal((await h.claimFile({ body: JSON.stringify({ locator: locators[2] }) })).statusCode, 200);
});

test('every part of a transfer claimed at once still yields exactly one body each', async () => {
	const s3 = fakeS3();
	const { h, uploadCapability, locators } = await makeTransfer(s3, 8);
	await finalizeAll(h, locators, uploadCapability);

	// Three racers per part, all eight parts at once — 24 concurrent claims
	// across one transfer. Exactly eight bodies, one per part, and nothing left
	// in the bucket.
	const results = await Promise.all(
		locators.flatMap((l) =>
			Array.from({ length: 3 }, () => h.claimFile({ body: JSON.stringify({ locator: l }) }))
		)
	);
	assert.equal(results.filter((r) => r.statusCode === 200).length, 8);
	assert.equal(results.filter((r) => r.statusCode === 410).length, 16);
	assert.equal(s3.objects.size, 0);
});

// --- partial failure: the honest answer -------------------------------------

test('a failure at part seven destroys seven parts and leaves the rest unusable', async () => {
	const s3 = fakeS3();
	const events = [];
	const { h, uploadCapability, locators, keys } = await makeTransfer(s3, 12, { events });
	await finalizeAll(h, locators, uploadCapability);

	// Part 7's delete silently does nothing, so the absence check refuses.
	const broken = fakeS3({ stickyDeleteKeys: new Set([keys[6]]) });
	for (const [i, k] of keys.entries()) broken.put(k, partBody(i));
	const hb = makeHandlers(doc, broken, { onEvent: (e) => events.push(e), capabilities: proGate });

	events.length = 0;
	for (let i = 0; i < 6; i++) {
		assert.equal((await hb.claimFile({ body: JSON.stringify({ locator: locators[i] }) })).statusCode, 200);
	}
	await assert.rejects(() => hb.claimFile({ body: JSON.stringify({ locator: locators[6] }) }));

	// Six response-first-byte events for six delivered parts, and none for the
	// seventh. The failure produced no bytes.
	assert.equal(events.filter((e) => e === 'response-first-byte').length, 6);
	assert.equal(events.at(-1), 's3-delete');

	// Parts 0-6 are all permanently consumed, including the one that failed.
	for (let i = 0; i <= 6; i++) {
		assert.equal((await hb.claimFile({ body: JSON.stringify({ locator: locators[i] }) })).statusCode, 410);
	}

	// Parts 7-11 were never touched. They are still claimable — and that is the
	// truthful state rather than a tidy one. Cinder cannot un-destroy parts 0-6,
	// so there is no honest way to make the survivors into a file. They are
	// abandoned to the same S3 lifecycle sweep that already collects a cancelled
	// upload's orphan, and the recipient is told the transfer is gone rather than
	// offered a resume that cannot exist.
	for (let i = 7; i < 12; i++) {
		assert.equal((await hb.claimFile({ body: JSON.stringify({ locator: locators[i] }) })).statusCode, 200);
	}
});

test('a failed part emits no response bytes and is still permanently consumed', async () => {
	const s3 = fakeS3();
	const { uploadCapability, locators, keys } = await makeTransfer(s3, 4);
	await finalizeAll(makeHandlers(doc, s3, { capabilities: proGate }), locators, uploadCapability);

	const events = [];
	const broken = fakeS3({ failKeys: { [keys[1]]: 'get' } });
	for (const [i, k] of keys.entries()) broken.put(k, partBody(i));
	const h = makeHandlers(doc, broken, { onEvent: (e) => events.push(e), capabilities: proGate });

	await assert.rejects(() => h.claimFile({ body: JSON.stringify({ locator: locators[1] }) }));
	assert.ok(!events.includes('response-first-byte'));
	assert.equal((await h.claimFile({ body: JSON.stringify({ locator: locators[1] }) })).statusCode, 410);
});

test('a tampered part is refused and never delivered', async () => {
	const s3 = fakeS3();
	const { h, uploadCapability, locators, keys, bodies } = await makeTransfer(s3, 3);
	await finalizeAll(h, locators, uploadCapability);

	const tampered = Buffer.from(bodies[2]);
	tampered[0] ^= 0xff;
	s3.put(keys[2], tampered);

	await assert.rejects(() => h.claimFile({ body: JSON.stringify({ locator: locators[2] }) }));
});

// --- the things that must never quietly change ------------------------------

test('the per-object ceiling is exactly what the buffered transport entitles', async () => {
	// If anyone raises this, they have changed the transport's promise without
	// changing the transport. The number is derived in CHANGELOG 0.2.0: a 6 MB
	// buffered Lambda response carrying base64 admits 4,718,592 ciphertext bytes,
	// and Cinder sits under it with headroom. Chunking is what made a bigger file
	// possible WITHOUT touching this, so this test is the guard on that bargain.
	const src = readFileSync(new URL('../src/handlers.mjs', import.meta.url), 'utf8');
	const found = /const MAX_CIPHERTEXT_BYTES = (.+);/.exec(src);
	assert.ok(found, 'MAX_CIPHERTEXT_BYTES must still exist');
	assert.equal(found[1], '4 * 1024 * 1024 + 4096');

	// And the server still enforces it per part, not per transfer.
	const h = makeHandlers(doc, fakeS3(), { capabilities: proGate });
	const b = partBody(0);
	const res = await h.createFile({
		body: JSON.stringify({
			parts: [
				{ ciphertextBytes: b.length, ciphertextSha256: sha(b) },
				{ ciphertextBytes: 4 * 1024 * 1024 + 4097, ciphertextSha256: sha(b) }
			],
			ttlSeconds: 60
		})
	});
	assert.equal(res.statusCode, 400);
});

test('the delivery path is buffered and must never be streamed', async () => {
	// A streamed response can only promise "the delete happened before we
	// finished sending". A buffered one makes "nothing left before the delete was
	// verified" true by construction, because the response object does not exist
	// until every line above the return has run. Matt rejected streaming for
	// exactly this reason; if a future change reaches for it to raise the
	// ceiling, this fails first.
	const src = readFileSync(new URL('../src/handlers.mjs', import.meta.url), 'utf8');
	for (const forbidden of ['streamifyResponse', 'responseStream', 'HttpResponseStream', 'pipeline(']) {
		assert.ok(!src.includes(forbidden), `${forbidden} would trade the structural guarantee away`);
	}
	const lambda = readFileSync(new URL('../src/lambda.mjs', import.meta.url), 'utf8');
	assert.ok(!lambda.includes('streamifyResponse'));

	// The observable form of the same rule: a claim returns a complete base64
	// body, not a stream handle.
	const s3 = fakeS3();
	const { h, uploadCapability, locators, bodies } = await makeTransfer(s3, 2);
	await finalizeAll(h, locators, uploadCapability);
	const res = await h.claimFile({ body: JSON.stringify({ locator: locators[0] }) });
	assert.equal(res.isBase64Encoded, true);
	assert.equal(typeof res.body, 'string');
	assert.deepEqual(Buffer.from(res.body, 'base64'), bodies[0]);
});

test('the two readings of an S3 error still disagree about 403', async () => {
	// Duplicated on purpose from s3-errors.test.mjs. That file guards the module;
	// this one guards the multipart path's dependence on it, because chunking
	// multiplies a wrong answer here by the number of parts. If someone unifies
	// these two functions, the delete-before-delivery proof dies silently at
	// every size, and nothing else in this suite would notice.
	const { absentProven, notRetrievable } = await import('../src/s3-errors.mjs');
	const forbidden = { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } };
	assert.throws(() => absentProven(forbidden), 'a 403 is not proof of absence');
	assert.equal(notRetrievable(forbidden), null);
});

test('a part locator cannot be derived from another part locator', async () => {
	// Holding the link yields every part, which is correct. Holding one part
	// must yield nothing else.
	const transfer = 'a-transfer-locator';
	const zero = deriveChunkLocator(transfer, 0);
	assert.notEqual(deriveChunkLocator(zero, 1), deriveChunkLocator(transfer, 1));
	assert.equal(new Set([0, 1, 2, 3].map((i) => deriveChunkLocator(transfer, i))).size, 4);
	// Stable, because the browser computes the same string independently.
	assert.equal(deriveChunkLocator(transfer, 0), zero);
});
