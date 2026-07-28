import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
	DynamoDBClient,
	CreateTableCommand,
	DeleteTableCommand
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { makeHandlers } from '../src/handlers.mjs';
import { putFileGrant, markFileReady } from '../src/store.mjs';
import { hashCapability } from '../src/id.mjs';
import { mintStatusToken, verifyStatusToken } from '../src/status-token.mjs';

const cfg = {
	region: 'us-east-1',
	endpoint: 'http://localhost:8000',
	credentials: { accessKeyId: 'x', secretAccessKey: 'x' }
};
const raw = new DynamoDBClient(cfg);
const doc = DynamoDBDocumentClient.from(raw);
process.env.TABLE_NAME = 'blip-notes-h';

// An in-memory stand-in for the private bucket. `fail` forces one operation to
// throw so the destructive path can be broken at every seam; `stickyDelete`
// makes delete silently do nothing, which is the one failure the absence check
// exists to catch.
function fakeS3({ fail = {}, stickyDelete = false } = {}) {
	const objects = new Map();
	const calls = [];
	const boom = (op) => {
		throw new Error(`injected ${op} failure`);
	};
	return {
		objects,
		calls,
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
		// Finalize's narrow view: size and checksum, never the body.
		async attributes({ key }) {
			calls.push('attributes');
			if (fail.attributes) boom('attributes');
			const o = objects.get(key);
			return o ? { contentLength: o.body.length, checksumSha256: o.sha } : null;
		},
		// The claim path's absence check.
		async head({ key }) {
			if (fail.head) boom('head');
			return objects.has(key) ? {} : null;
		},
		async get({ key }) {
			if (fail.get) boom('get');
			const o = objects.get(key);
			if (!o) throw new Error('NoSuchKey');
			return o.body;
		},
		async delete({ key }) {
			if (fail.delete) boom('delete');
			if (!stickyDelete) objects.delete(key);
		}
	};
}

const { createNote, readNote } = makeHandlers(doc);

before(async () => {
	await raw.send(
		new CreateTableCommand({
			TableName: 'blip-notes-h',
			AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
			KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
			BillingMode: 'PAY_PER_REQUEST'
		})
	);
});
after(async () => {
	await raw.send(new DeleteTableCommand({ TableName: 'blip-notes-h' }));
});

// --- notes (unchanged protocol) --------------------------------------------

test('create then read burns once', async () => {
	const create = await createNote({
		body: JSON.stringify({ ciphertext: 'CT', iv: 'IV', ttlSeconds: 3600 })
	});
	assert.equal(create.statusCode, 201);
	const { id } = JSON.parse(create.body);

	const read1 = await readNote({ pathParameters: { id } });
	assert.equal(read1.statusCode, 200);
	assert.deepEqual(JSON.parse(read1.body), { ciphertext: 'CT', iv: 'IV' });

	const read2 = await readNote({ pathParameters: { id } });
	assert.equal(read2.statusCode, 410);
});

test('passphrase note carries salt through create+read', async () => {
	const create = await createNote({
		body: JSON.stringify({ ciphertext: 'CT', iv: 'IV', salt: 'SALT', ttlSeconds: 3600 })
	});
	const { id } = JSON.parse(create.body);
	const read = await readNote({ pathParameters: { id } });
	assert.deepEqual(JSON.parse(read.body), { ciphertext: 'CT', iv: 'IV', salt: 'SALT' });
});

test('rejects oversized ciphertext', async () => {
	const big = 'x'.repeat(100_001);
	const res = await createNote({
		body: JSON.stringify({ ciphertext: big, iv: 'IV', ttlSeconds: 60 })
	});
	assert.equal(res.statusCode, 400);
});

test('rejects missing fields', async () => {
	const res = await createNote({ body: JSON.stringify({ iv: 'IV', ttlSeconds: 60 }) });
	assert.equal(res.statusCode, 400);
});

test('clamps ttl over the max', async () => {
	const res = await createNote({
		body: JSON.stringify({ ciphertext: 'CT', iv: 'IV', ttlSeconds: 999_999_999 })
	});
	assert.equal(res.statusCode, 201);
});

test('read of unknown id is 410', async () => {
	const res = await readNote({ pathParameters: { id: 'does-not-exist' } });
	assert.equal(res.statusCode, 410);
});

// --- file transfer ---------------------------------------------------------

const BODY = Buffer.from('encrypted-file-bytes-pretend-this-is-ciphertext');
const BODY_SHA = createHash('sha256').update(BODY).digest('base64');
const STATUS_SECRET = 'test-status-secret-that-is-not-a-capability-secret';
const statusTokens = {
	mint: (claims) => mintStatusToken({ secret: STATUS_SECRET, ...claims }),
	verify: (token) => verifyStatusToken(token, { secret: STATUS_SECRET })
};

// Drives the whole sender journey against a given bucket, returning the
// capabilities plus the trace sink so a test can assert what happened.
async function makeTransfer(s3, events = []) {
	const h = makeHandlers(doc, s3, { onEvent: (e) => events.push(e) });
	const created = await h.createFile({
		body: JSON.stringify({
			ciphertextBytes: BODY.length,
			ciphertextSha256: BODY_SHA,
			ttlSeconds: 3600
		})
	});
	assert.equal(created.statusCode, 201);
	const { locator, uploadCapability, upload } = JSON.parse(created.body);

	// Stand in for the browser's direct PUT to the private bucket.
	const key = new URL(upload.url).pathname.slice(1);
	s3.put(key, BODY);

	return { h, locator, uploadCapability, key, events };
}

test('create issues independent capabilities and a constrained upload', async () => {
	const s3 = fakeS3();
	const h = makeHandlers(doc, s3);
	const res = await h.createFile({
		body: JSON.stringify({
			ciphertextBytes: BODY.length,
			ciphertextSha256: BODY_SHA,
			ttlSeconds: 3600
		})
	});
	const { locator, uploadCapability, upload } = JSON.parse(res.body);

	assert.notEqual(locator, uploadCapability);
	assert.ok(locator.length >= 43 && uploadCapability.length >= 43); // 256 bits, base64url
	assert.equal(upload.headers['content-length'], String(BODY.length));
	assert.equal(upload.headers['x-amz-checksum-sha256'], BODY_SHA);
	// The object key must not be derivable from the locator.
	assert.ok(!upload.url.includes(locator));
});

test('create rejects an oversized declared ciphertext', async () => {
	const h = makeHandlers(doc, fakeS3());
	const res = await h.createFile({
		body: JSON.stringify({
			ciphertextBytes: 4 * 1024 * 1024 + 4097,
			ciphertextSha256: BODY_SHA,
			ttlSeconds: 60
		})
	});
	assert.equal(res.statusCode, 400);
});

test('create rejects a malformed checksum', async () => {
	const h = makeHandlers(doc, fakeS3());
	const res = await h.createFile({
		body: JSON.stringify({ ciphertextBytes: 10, ciphertextSha256: 'not-a-sha', ttlSeconds: 60 })
	});
	assert.equal(res.statusCode, 400);
});

test('the full journey delivers the ciphertext exactly once', async () => {
	const s3 = fakeS3();
	const { h, locator, uploadCapability } = await makeTransfer(s3);

	assert.equal((await h.finalizeFile({ body: JSON.stringify({ locator, uploadCapability }) })).statusCode, 200);

	const got = await h.claimFile({ body: JSON.stringify({ locator }) });
	assert.equal(got.statusCode, 200);
	assert.equal(got.isBase64Encoded, true);
	assert.deepEqual(Buffer.from(got.body, 'base64'), BODY);
	assert.equal(got.headers['cache-control'], 'no-store, private');

	const again = await h.claimFile({ body: JSON.stringify({ locator }) });
	assert.equal(again.statusCode, 410);
});

test('sender status is read-only, token-gated, and changes from available to gone', async () => {
	const s3 = fakeS3();
	const h = makeHandlers(doc, s3, { statusTokens });
	const created = await h.createFile({
		body: JSON.stringify({
			ciphertextBytes: BODY.length,
			ciphertextSha256: BODY_SHA,
			ttlSeconds: 3600
		})
	});
	const { locator, uploadCapability, statusToken, upload } = JSON.parse(created.body);
	const key = new URL(upload.url).pathname.slice(1);
	s3.put(key, BODY);

	const check = () => h.statusFile({ body: JSON.stringify({ statusToken }) });
	assert.deepEqual(JSON.parse((await check()).body), { status: 'gone' }, 'uploading is not available');
	await h.finalizeFile({ body: JSON.stringify({ locator, uploadCapability }) });
	for (let index = 0; index < 100; index += 1) {
		assert.deepEqual(JSON.parse((await check()).body), { status: 'available' });
	}
	assert.equal(s3.calls.filter((call) => call !== 'attributes').length, 0);

	assert.equal((await h.claimFile({ body: JSON.stringify({ locator }) })).statusCode, 200);
	assert.deepEqual(JSON.parse((await check()).body), { status: 'gone' });
	for (const bad of [null, '', `${statusToken}x`, 'not-a-token']) {
		const result = await h.statusFile({ body: JSON.stringify({ statusToken: bad }) });
		assert.deepEqual(JSON.parse(result.body), { status: 'gone' });
	}
});

test('claim before finalize is refused and does not consume the transfer', async () => {
	const s3 = fakeS3();
	const { h, locator, uploadCapability } = await makeTransfer(s3);

	assert.equal((await h.claimFile({ body: JSON.stringify({ locator }) })).statusCode, 410);

	// The grant survived, so the sender can still finish the upload.
	assert.equal((await h.finalizeFile({ body: JSON.stringify({ locator, uploadCapability }) })).statusCode, 200);
	assert.equal((await h.claimFile({ body: JSON.stringify({ locator }) })).statusCode, 200);
});

test('finalize refuses a missing object', async () => {
	const s3 = fakeS3();
	const { h, locator, uploadCapability, key } = await makeTransfer(s3);
	s3.objects.delete(key);

	assert.equal((await h.finalizeFile({ body: JSON.stringify({ locator, uploadCapability }) })).statusCode, 410);
	assert.equal((await h.claimFile({ body: JSON.stringify({ locator }) })).statusCode, 410);
});

test('finalize refuses a wrong stored size', async () => {
	const s3 = fakeS3();
	const { h, locator, uploadCapability, key } = await makeTransfer(s3);
	s3.put(key, Buffer.concat([BODY, Buffer.from('extra')]));

	assert.equal((await h.finalizeFile({ body: JSON.stringify({ locator, uploadCapability }) })).statusCode, 410);
});

test('finalize refuses a same-size body with a different checksum', async () => {
	const s3 = fakeS3();
	const { h, locator, uploadCapability, key } = await makeTransfer(s3);
	const swapped = Buffer.from(BODY);
	swapped[0] ^= 0xff;
	s3.put(key, swapped);

	assert.equal((await h.finalizeFile({ body: JSON.stringify({ locator, uploadCapability }) })).statusCode, 410);
});

test('finalize refuses a wrong upload capability', async () => {
	const s3 = fakeS3();
	const { h, locator } = await makeTransfer(s3);

	const res = await h.finalizeFile({
		body: JSON.stringify({ locator, uploadCapability: 'attacker-supplied' })
	});
	assert.equal(res.statusCode, 410);
	assert.equal((await h.claimFile({ body: JSON.stringify({ locator }) })).statusCode, 410);
});

test('finalize refuses an unknown locator', async () => {
	const s3 = fakeS3();
	const h = makeHandlers(doc, s3);
	const res = await h.finalizeFile({
		body: JSON.stringify({ locator: 'no-such-locator', uploadCapability: 'x' })
	});
	assert.equal(res.statusCode, 410);
});

test('duplicate finalize is idempotent and still yields one delivery', async () => {
	const s3 = fakeS3();
	const { h, locator, uploadCapability } = await makeTransfer(s3);
	const body = JSON.stringify({ locator, uploadCapability });

	assert.equal((await h.finalizeFile({ body })).statusCode, 200);
	assert.equal((await h.finalizeFile({ body })).statusCode, 200);

	assert.equal((await h.claimFile({ body: JSON.stringify({ locator }) })).statusCode, 200);
	assert.equal((await h.claimFile({ body: JSON.stringify({ locator }) })).statusCode, 410);
});

// --- the destructive path: order, and what happens when it breaks ----------

test('the delivery path runs exactly claim, open, delete, absence, first byte', async () => {
	const s3 = fakeS3();
	const events = [];
	const { h, locator, uploadCapability } = await makeTransfer(s3, events);
	await h.finalizeFile({ body: JSON.stringify({ locator, uploadCapability }) });

	events.length = 0;
	const res = await h.claimFile({ body: JSON.stringify({ locator }) });

	assert.equal(res.statusCode, 200);
	assert.deepEqual(events, ['claim', 's3-open', 's3-delete', 's3-head-404', 'response-first-byte']);
	// The stored copy is gone before the caller holds anything.
	assert.equal(s3.objects.size, 0);
});

// Each seam, broken. The assertion is the same every time: the response-first-byte
// event never fires, so no byte of ciphertext existed to be sent, and the
// transfer is permanently consumed regardless.
for (const seam of ['get', 'delete', 'head']) {
	test(`a ${seam} failure emits zero response bytes and permanently consumes the transfer`, async () => {
		const good = fakeS3();
		const events = [];
		const { locator, uploadCapability, key } = await makeTransfer(good, events);
		await makeHandlers(doc, good).finalizeFile({
			body: JSON.stringify({ locator, uploadCapability })
		});

		// Same bucket contents, but this seam throws.
		const broken = fakeS3({ fail: { [seam]: true } });
		broken.put(key, BODY);
		const h = makeHandlers(doc, broken, { onEvent: (e) => events.push(e) });

		events.length = 0;
		await assert.rejects(() => h.claimFile({ body: JSON.stringify({ locator }) }));
		assert.ok(!events.includes('response-first-byte'), 'no response byte may exist');

		// The claim already happened. Nothing restores eligibility.
		const retry = await makeHandlers(doc, fakeS3()).claimFile({ body: JSON.stringify({ locator }) });
		assert.equal(retry.statusCode, 410);
	});
}

test('a delete that silently does nothing is caught by the absence check', async () => {
	const s3 = fakeS3({ stickyDelete: true });
	const events = [];
	const { h, locator, uploadCapability } = await makeTransfer(s3, events);
	await h.finalizeFile({ body: JSON.stringify({ locator, uploadCapability }) });

	events.length = 0;
	await assert.rejects(() => h.claimFile({ body: JSON.stringify({ locator }) }));

	assert.deepEqual(events, ['claim', 's3-open', 's3-delete']);
	assert.ok(!events.includes('s3-head-404'));
	assert.ok(!events.includes('response-first-byte'));
});

test('twenty simultaneous claims produce one body and nineteen identical refusals', async () => {
	const s3 = fakeS3();
	const { h, locator, uploadCapability } = await makeTransfer(s3);
	await h.finalizeFile({ body: JSON.stringify({ locator, uploadCapability }) });

	const results = await Promise.all(
		Array.from({ length: 20 }, () => h.claimFile({ body: JSON.stringify({ locator }) }))
	);

	const won = results.filter((r) => r.statusCode === 200);
	const lost = results.filter((r) => r.statusCode !== 200);
	assert.equal(won.length, 1);
	assert.equal(lost.length, 19);

	// Losers must be indistinguishable from each other and from "never existed".
	const unknown = await h.claimFile({ body: JSON.stringify({ locator: 'never-existed' }) });
	for (const r of lost) {
		assert.equal(r.statusCode, unknown.statusCode);
		assert.equal(r.body, unknown.body);
	}
});

test('an expired ready grant is refused even before TTL reaps it', async () => {
	const s3 = fakeS3();
	const past = Math.floor(Date.now() / 1000) - 60;
	const locator = 'expired-locator';
	const pk = hashCapability(locator);

	await putFileGrant(doc, {
		pk,
		objectKey: 'k-expired',
		uploadCapabilityHash: hashCapability('u'),
		ciphertextBytes: BODY.length,
		ciphertextSha256: BODY_SHA,
		createdAt: past - 10,
		expiresAt: past + 5 // already in the past
	});
	await markFileReady(doc, {
		pk,
		uploadCapabilityHash: hashCapability('u'),
		objectKey: 'k-expired',
		ciphertextBytes: BODY.length,
		ciphertextSha256: BODY_SHA,
		nowEpoch: past
	});
	s3.put('k-expired', BODY);

	const h = makeHandlers(doc, s3);
	assert.equal((await h.claimFile({ body: JSON.stringify({ locator }) })).statusCode, 410);
	// The object was never opened, so it is still there for lifecycle cleanup.
	assert.equal(s3.objects.size, 1);
});

test('a malformed or absent locator is refused like everything else', async () => {
	const h = makeHandlers(doc, fakeS3());
	const unknown = await h.claimFile({ body: JSON.stringify({ locator: 'never-existed' }) });

	for (const body of ['{}', JSON.stringify({ locator: '' }), JSON.stringify({ locator: 123 })]) {
		const res = await h.claimFile({ body });
		assert.equal(res.statusCode, unknown.statusCode);
		assert.equal(res.body, unknown.body);
	}
});

// --- what the adversarial pass found ---------------------------------------

test('a wrong upload capability costs the same S3 work as an unknown locator', async () => {
	// Finalize used to read the grant, then call S3, and only check the
	// capability at the very end. An unknown locator therefore cost one round
	// trip and a known one cost two — a ~72ms difference that let anyone
	// holding only a locator poll to learn whether a transfer was still live.
	const s3 = fakeS3();
	const { h, locator } = await makeTransfer(s3);

	s3.calls.length = 0;
	const wrongCap = await h.finalizeFile({
		body: JSON.stringify({ locator, uploadCapability: 'attacker-supplied' })
	});
	const knownLocatorCalls = [...s3.calls];

	s3.calls.length = 0;
	const unknown = await h.finalizeFile({
		body: JSON.stringify({ locator: 'never-existed', uploadCapability: 'attacker-supplied' })
	});
	const unknownLocatorCalls = [...s3.calls];

	assert.equal(wrongCap.statusCode, unknown.statusCode);
	assert.equal(wrongCap.body, unknown.body);
	// The observable that leaked was work, not bytes. Both paths must do none.
	assert.deepEqual(knownLocatorCalls, []);
	assert.deepEqual(unknownLocatorCalls, []);
});

test('claim refuses ciphertext that does not match what was finalized', async () => {
	const s3 = fakeS3();
	const events = [];
	const { h, locator, uploadCapability, key } = await makeTransfer(s3, events);
	await h.finalizeFile({ body: JSON.stringify({ locator, uploadCapability }) });

	// Someone with bucket write swaps the body for one of identical length.
	const tampered = Buffer.from(BODY);
	tampered[0] ^= 0xff;
	s3.put(key, tampered);

	events.length = 0;
	await assert.rejects(() => h.claimFile({ body: JSON.stringify({ locator }) }));
	assert.ok(!events.includes('response-first-byte'), 'tampered bytes must not be delivered');

	// The transfer is still consumed — the claim already happened.
	assert.equal((await h.claimFile({ body: JSON.stringify({ locator }) })).statusCode, 410);
});

test('claim refuses ciphertext of the wrong length', async () => {
	const s3 = fakeS3();
	const { h, locator, uploadCapability, key } = await makeTransfer(s3);
	await h.finalizeFile({ body: JSON.stringify({ locator, uploadCapability }) });

	s3.put(key, Buffer.concat([BODY, Buffer.from('x')]));
	await assert.rejects(() => h.claimFile({ body: JSON.stringify({ locator }) }));
});

test('object keys carry a lifetime band so short transfers sweep sooner', async () => {
	// S3 lifecycle rules are per-prefix and day-granular, so one flat rule left
	// a one-hour transfer's ciphertext sitting for the full maximum after it
	// stopped being readable. The band is the whole mechanism that fixes it.
	const s3 = fakeS3();
	const h = makeHandlers(doc, s3);
	const body = JSON.stringify({ ciphertextBytes: BODY.length, ciphertextSha256: BODY_SHA });

	const short = JSON.parse(
		(await h.createFile({ body: JSON.stringify({ ...JSON.parse(body), ttlSeconds: 3600 }) })).body
	);
	const long = JSON.parse(
		(await h.createFile({ body: JSON.stringify({ ...JSON.parse(body), ttlSeconds: 604_800 }) })).body
	);

	assert.match(new URL(short.upload.url).pathname, /\/d1\//);
	assert.match(new URL(long.upload.url).pathname, /\/d8\//);

	// The band must be the ONLY thing the key reveals — no locator, no time.
	assert.ok(!short.upload.url.includes(short.locator));
	assert.match(new URL(short.upload.url).pathname, /\/d1\/[0-9a-f]{64}$/);
});
