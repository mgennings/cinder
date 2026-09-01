// The video lifecycle against DynamoDB Local: create → finalize → seal →
// claim → segment URLs → finished → extend → burn, plus every refusal the
// contract (docs/video-api-contract.md) promises. The at-read deadline guard
// is exercised by writing the past INTO the row rather than by mocking clocks,
// the same way the file tests stage states through the store.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
	DynamoDBClient,
	CreateTableCommand,
	DeleteTableCommand
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { makeVideoHandlers } from '../src/video-handlers.mjs';
import { makeHandlers } from '../src/handlers.mjs';
import { hashCapability, deriveSegmentLocator } from '../src/id.mjs';
import { mintStatusToken, verifyStatusToken } from '../src/status-token.mjs';

const cfg = {
	region: 'us-east-1',
	endpoint: 'http://localhost:8000',
	credentials: { accessKeyId: 'x', secretAccessKey: 'x' }
};
const raw = new DynamoDBClient(cfg);
const doc = DynamoDBDocumentClient.from(raw);
process.env.TABLE_NAME = 'blip-notes-v';

// --- fakes -------------------------------------------------------------------

function fakeS3() {
	const objects = new Map();
	const putGrants = new Map(); // key -> { bytes, sha256 }
	return {
		objects,
		putGrants,
		// The test's stand-in for the sender's browser honoring a presigned PUT.
		upload(key, body) {
			objects.set(key, { body, sha: createHash('sha256').update(body).digest('base64') });
		},
		async presignPut({ key, bytes, sha256, expiresIn }) {
			putGrants.set(key, { bytes, sha256 });
			return {
				url: `https://bucket.invalid/${key}`,
				headers: { 'content-length': String(bytes), 'x-amz-checksum-sha256': sha256 },
				expiresIn
			};
		},
		async presignGet({ key, expiresIn }) {
			return `https://bucket.invalid/${key}?get&expiresIn=${expiresIn}`;
		},
		async attributes({ key }) {
			const o = objects.get(key);
			return o ? { contentLength: o.body.length, checksumSha256: o.sha } : null;
		},
		async delete({ key }) {
			objects.delete(key);
		},
		// The file handlers' claim path needs these; the cross-path test uses them.
		async get({ key }) {
			const o = objects.get(key);
			if (!o) throw new Error('NoSuchKey');
			return o.body;
		},
		async head({ key }) {
			return objects.has(key) ? {} : null;
		}
	};
}

// Grant literals, exactly the shape the real gate would decide.
const GATE_GRANTS = {
	'video-send-grant': { cap: 'video.send', limits: { maxSegments: 128 } },
	'video-send-prepaid-2': { cap: 'video.send', limits: { maxSegments: 128, prepaidExtensions: 2 } },
	'video-send-small': { cap: 'video.send', limits: { maxSegments: 2 } },
	'video-extend-grant': { cap: 'video.extend', limits: { extensions: 1 } }
};
const fakeGate = {
	async check({ grant, capability }) {
		const known = GATE_GRANTS[grant];
		if (!known || known.cap !== capability) return { granted: false, limits: {} };
		return { granted: true, limits: known.limits };
	}
};

const STATUS_SECRET = 'video-test-status-secret';
const statusTokens = {
	mint: (claims) => mintStatusToken({ secret: STATUS_SECRET, ...claims }),
	verify: (token) => verifyStatusToken(token, { secret: STATUS_SECRET })
};

function fakeScheduler() {
	const arms = [];
	return {
		arms,
		async arm(schedule) {
			arms.push(schedule);
		}
	};
}

const s3 = fakeS3();
const scheduler = fakeScheduler();
const handlers = makeVideoHandlers(doc, s3, { capabilities: fakeGate, statusTokens, scheduler });
const fileHandlers = makeHandlers(doc, s3);

const now = () => Math.floor(Date.now() / 1000);
const body = (obj) => ({ body: JSON.stringify(obj) });
const parse = (res) => JSON.parse(res.body);

// One declared segment: deterministic bytes so the checksum is real.
function segmentBody(i, length = 64) {
	return Buffer.alloc(length, i + 1);
}
function declareSegments(count) {
	return Array.from({ length: count }, (_, i) => {
		const buf = segmentBody(i);
		return {
			ciphertextBytes: buf.length,
			ciphertextSha256: createHash('sha256').update(buf).digest('base64')
		};
	});
}

// Drives a video to sealed-and-ready, the state a recipient's link points at.
async function sealedVideo({ count = 3, grant = 'video-send-grant', ttlSeconds = 3600 } = {}) {
	const created = await handlers.createVideo(
		body({ segments: declareSegments(count), ttlSeconds, capabilityGrant: grant })
	);
	assert.equal(created.statusCode, 201);
	const { locator, uploadCapability, statusToken, segments } = parse(created);
	assert.equal(segments.length, count);

	// Upload every segment through its presigned key, then finalize each by
	// its DERIVED locator, then seal with the transfer locator.
	for (const { index, upload } of segments) {
		const key = upload.url.replace('https://bucket.invalid/', '');
		s3.upload(key, segmentBody(index));
		const fin = await handlers.finalizeVideo(
			body({ locator: deriveSegmentLocator(locator, index), uploadCapability })
		);
		assert.equal(fin.statusCode, 200);
	}
	const sealed = await handlers.finalizeVideo(body({ locator, uploadCapability }));
	assert.equal(sealed.statusCode, 200);
	return { locator, uploadCapability, statusToken, count };
}

async function setSession(locator, values) {
	const names = Object.fromEntries(Object.keys(values).map((k, i) => [`#a${i}`, k]));
	const vals = Object.fromEntries(Object.values(values).map((v, i) => [`:v${i}`, v]));
	await doc.send(
		new UpdateCommand({
			TableName: process.env.TABLE_NAME,
			Key: { pk: hashCapability(locator) },
			UpdateExpression:
				'SET ' + Object.keys(values).map((_, i) => `#a${i} = :v${i}`).join(', '),
			ExpressionAttributeNames: names,
			ExpressionAttributeValues: vals
		})
	);
}

async function rowExists(pkSource) {
	const res = await doc.send(
		new GetCommand({
			TableName: process.env.TABLE_NAME,
			Key: { pk: hashCapability(pkSource) },
			ConsistentRead: true
		})
	);
	return Boolean(res.Item);
}

before(async () => {
	await raw.send(
		new CreateTableCommand({
			TableName: 'blip-notes-v',
			AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
			KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
			BillingMode: 'PAY_PER_REQUEST'
		})
	);
});
after(async () => {
	await raw.send(new DeleteTableCommand({ TableName: 'blip-notes-v' }));
});

// --- create ------------------------------------------------------------------

test('create without a grant answers 402; the video is always paid', async () => {
	const res = await handlers.createVideo(body({ segments: declareSegments(1), ttlSeconds: 60 }));
	assert.equal(res.statusCode, 402);
});

test('create beyond the granted segment limit answers 403', async () => {
	const res = await handlers.createVideo(
		body({ segments: declareSegments(3), ttlSeconds: 60, capabilityGrant: 'video-send-small' })
	);
	assert.equal(res.statusCode, 403);
});

test('create refuses malformed, empty, and oversized segment lists', async () => {
	for (const segments of [
		[],
		[{ ciphertextBytes: 0, ciphertextSha256: 'x' }],
		declareSegments(129)
	]) {
		const res = await handlers.createVideo(
			body({ segments, ttlSeconds: 60, capabilityGrant: 'video-send-grant' })
		);
		assert.equal(res.statusCode, 400);
	}
});

test('a wrong upload capability cannot finalize a segment or seal the video', async () => {
	const created = parse(
		await handlers.createVideo(
			body({ segments: declareSegments(1), ttlSeconds: 3600, capabilityGrant: 'video-send-grant' })
		)
	);
	const key = created.segments[0].upload.url.replace('https://bucket.invalid/', '');
	s3.upload(key, segmentBody(0));
	const wrong = 'A'.repeat(43);
	const seg = await handlers.finalizeVideo(
		body({ locator: deriveSegmentLocator(created.locator, 0), uploadCapability: wrong })
	);
	assert.equal(seg.statusCode, 410);
	const seal = await handlers.finalizeVideo(
		body({ locator: created.locator, uploadCapability: wrong })
	);
	assert.equal(seal.statusCode, 410);
});

test('the video cannot seal while any segment is unfinalized', async () => {
	const created = parse(
		await handlers.createVideo(
			body({ segments: declareSegments(2), ttlSeconds: 3600, capabilityGrant: 'video-send-grant' })
		)
	);
	const { locator, uploadCapability } = created;
	// Only segment 0 is uploaded and finalized.
	const key = created.segments[0].upload.url.replace('https://bucket.invalid/', '');
	s3.upload(key, segmentBody(0));
	const fin = await handlers.finalizeVideo(
		body({ locator: deriveSegmentLocator(locator, 0), uploadCapability })
	);
	assert.equal(fin.statusCode, 200);

	const seal = await handlers.finalizeVideo(body({ locator, uploadCapability }));
	assert.equal(seal.statusCode, 410);

	// And an unsealed video is not claimable: half-uploaded is never whole.
	const claim = await handlers.claimVideo(body({ locator }));
	assert.equal(claim.statusCode, 410);
});

test('segment finalize is idempotent on identical facts, which is the resume', async () => {
	const { locator, uploadCapability } = await sealedVideo({ count: 2 });
	const again = await handlers.finalizeVideo(
		body({ locator: deriveSegmentLocator(locator, 1), uploadCapability })
	);
	assert.equal(again.statusCode, 200);
	const sealAgain = await handlers.finalizeVideo(body({ locator, uploadCapability }));
	assert.equal(sealAgain.statusCode, 200);
});

// --- sender status -----------------------------------------------------------

test('status is waiting only while sealed, unclaimed, unexpired', async () => {
	const { locator, statusToken } = await sealedVideo();
	assert.deepEqual(parse(await handlers.statusVideo(body({ statusToken }))), {
		status: 'waiting'
	});

	await handlers.claimVideo(body({ locator }));
	// Claimed collapses the sender's view to one word, indistinguishably from
	// watched, declined, extended, or destroyed.
	assert.deepEqual(parse(await handlers.statusVideo(body({ statusToken }))), { status: 'gone' });
});

test('an unsealed video reads gone to the sender, and garbage reads gone too', async () => {
	const created = parse(
		await handlers.createVideo(
			body({ segments: declareSegments(1), ttlSeconds: 3600, capabilityGrant: 'video-send-grant' })
		)
	);
	assert.deepEqual(parse(await handlers.statusVideo(body({ statusToken: created.statusToken }))), {
		status: 'gone'
	});
	assert.deepEqual(parse(await handlers.statusVideo(body({ statusToken: 'nonsense' }))), {
		status: 'gone'
	});
});

// --- claim and the watch window ----------------------------------------------

test('claim opens the 64-minute window, arms the burn, and resumes for free', async () => {
	const { locator, count } = await sealedVideo();
	const before = now();
	const armsBefore = scheduler.arms.length;

	const first = parse(await handlers.claimVideo(body({ locator })));
	assert.ok(first.deadlineEpoch >= before + 3840 && first.deadlineEpoch <= now() + 3840);
	assert.equal(first.segments, count);
	assert.equal(first.finished, false);
	assert.equal(first.prepaidRemaining, 0);
	assert.equal(first.extensionsUsed, 0);

	// The burn was armed at the deadline, with the derived segment pks.
	const arm = scheduler.arms[scheduler.arms.length - 1];
	assert.ok(scheduler.arms.length > armsBefore);
	assert.equal(arm.atEpoch, first.deadlineEpoch);
	assert.equal(arm.pk, hashCapability(locator));
	assert.deepEqual(
		arm.segmentPks,
		Array.from({ length: count }, (_, i) => hashCapability(deriveSegmentLocator(locator, i)))
	);

	// Re-claim resumes the same window; the client cannot tell first from
	// resumed and does not need to.
	const resumed = parse(await handlers.claimVideo(body({ locator })));
	assert.equal(resumed.deadlineEpoch, first.deadlineEpoch);
});

test('claim lifts every segment row past the sender expiry, so the reaper cannot eat an open window', async () => {
	// A window opened minutes before the sender's expiry runs long past it.
	// The claim rewrites the session TTL and must lift the SEGMENT rows too,
	// or DynamoDB's reaper could remove them mid-window.
	const { locator, count } = await sealedVideo({ count: 2, ttlSeconds: 120 });
	await handlers.claimVideo(body({ locator }));

	for (let i = 0; i < count; i++) {
		const res = await doc.send(
			new GetCommand({
				TableName: process.env.TABLE_NAME,
				Key: { pk: hashCapability(deriveSegmentLocator(locator, i)) },
				ConsistentRead: true
			})
		);
		// Past the 128-minute session cap, matching the session row's sweep.
		assert.ok(res.Item.expiresAt >= now() + 7680, `segment ${i} lifted`);
	}
});

test('a never-created locator answers the one GONE sentence', async () => {
	const res = await handlers.claimVideo(body({ locator: 'B'.repeat(43) }));
	assert.equal(res.statusCode, 410);
	assert.equal(parse(res).error, 'This video is no longer available.');
});

test('segment URLs are issued inside the window, never past the deadline', async () => {
	const { locator, count } = await sealedVideo();
	const claimed = parse(await handlers.claimVideo(body({ locator })));

	const issued = parse(await handlers.segmentUrl(body({ locator, index: 0 })));
	assert.ok(issued.url.includes('?get'));
	assert.ok(issued.expiresIn > 0 && issued.expiresIn <= 480);
	// An issued URL never outlives the deadline.
	assert.ok(now() + issued.expiresIn <= claimed.deadlineEpoch + 1);

	// Out of range is indistinguishable from gone.
	assert.equal((await handlers.segmentUrl(body({ locator, index: count }))).statusCode, 410);
	assert.equal((await handlers.segmentUrl(body({ locator, index: -1 }))).statusCode, 410);

	// Past the deadline: refused immediately and unconditionally. The at-read
	// guard is the availability guarantee, so the row still existing changes
	// nothing.
	await setSession(locator, { deadlineEpoch: now() - 1 });
	assert.equal((await handlers.segmentUrl(body({ locator, index: 0 }))).statusCode, 410);
	assert.equal((await handlers.finishedVideo(body({ locator }))).statusCode, 410);
	assert.equal((await handlers.extendVideo(body({ locator }))).statusCode, 410);
	assert.equal((await handlers.claimVideo(body({ locator }))).statusCode, 410);
});

test('an unclaimed video issues no segment URLs', async () => {
	const { locator } = await sealedVideo();
	assert.equal((await handlers.segmentUrl(body({ locator, index: 0 }))).statusCode, 410);
});

// --- finished ----------------------------------------------------------------

test('finished shortens the deadline to now + 8 minutes and never lengthens', async () => {
	const { locator } = await sealedVideo();
	await handlers.claimVideo(body({ locator }));

	const first = parse(await handlers.finishedVideo(body({ locator })));
	assert.ok(first.deadlineEpoch <= now() + 480);

	// A repeated (or forged) report cannot buy time: idempotent, and the
	// deadline it answers is never later than the one it set.
	const second = parse(await handlers.finishedVideo(body({ locator })));
	assert.ok(second.deadlineEpoch <= first.deadlineEpoch);

	const resumed = parse(await handlers.claimVideo(body({ locator })));
	assert.equal(resumed.finished, true);
	assert.equal(resumed.deadlineEpoch, second.deadlineEpoch);
});

// --- extend ------------------------------------------------------------------

test('extend without prepaid or a grant answers 402 with the doors named', async () => {
	const { locator } = await sealedVideo();
	await handlers.claimVideo(body({ locator }));
	const res = await handlers.extendVideo(body({ locator }));
	assert.equal(res.statusCode, 402);
});

test('a video.extend grant adds exactly 8 minutes', async () => {
	const { locator } = await sealedVideo();
	const claimed = parse(await handlers.claimVideo(body({ locator })));
	const res = parse(
		await handlers.extendVideo(body({ locator, capabilityGrant: 'video-extend-grant' }))
	);
	assert.equal(res.deadlineEpoch, claimed.deadlineEpoch + 480);
	assert.equal(res.extensionsUsed, 1);
	assert.equal(res.prepaidRemaining, 0);
});

test('prepaid extensions spend first, one tap, no grant, then the doors close honestly', async () => {
	const { locator } = await sealedVideo({ grant: 'video-send-prepaid-2' });
	const claimed = parse(await handlers.claimVideo(body({ locator })));
	assert.equal(claimed.prepaidRemaining, 2);

	const one = parse(await handlers.extendVideo(body({ locator })));
	assert.equal(one.prepaidRemaining, 1);
	assert.equal(one.extensionsUsed, 1);
	assert.equal(one.deadlineEpoch, claimed.deadlineEpoch + 480);

	const two = parse(await handlers.extendVideo(body({ locator })));
	assert.equal(two.prepaidRemaining, 0);

	// Prepaid exhausted: no grant means 402, a grant still works.
	assert.equal((await handlers.extendVideo(body({ locator }))).statusCode, 402);
	const three = parse(
		await handlers.extendVideo(body({ locator, capabilityGrant: 'video-extend-grant' }))
	);
	assert.equal(three.extensionsUsed, 3);
});

test('the extension count cap answers 403: all the time it can be given', async () => {
	const { locator } = await sealedVideo();
	await handlers.claimVideo(body({ locator }));
	await setSession(locator, { extensionsUsed: 8 });
	const res = await handlers.extendVideo(body({ locator, capabilityGrant: 'video-extend-grant' }));
	assert.equal(res.statusCode, 403);
});

test('the 128-minute session cap clamps the last extension and then refuses', async () => {
	const { locator } = await sealedVideo();
	await handlers.claimVideo(body({ locator }));
	// Stage a session whose deadline sits 200 seconds under the absolute cap.
	const claimedAt = now() - 1000;
	await setSession(locator, { claimedAt, deadlineEpoch: claimedAt + 7680 - 200 });

	// The extension is clamped to the cap, not refused: 200 seconds granted.
	const clamped = parse(
		await handlers.extendVideo(body({ locator, capabilityGrant: 'video-extend-grant' }))
	);
	assert.equal(clamped.deadlineEpoch, claimedAt + 7680);

	// At the cap, no combination of funding buys another second.
	const refused = await handlers.extendVideo(
		body({ locator, capabilityGrant: 'video-extend-grant' })
	);
	assert.equal(refused.statusCode, 403);
});

// --- decline and destroy -----------------------------------------------------

test('the recipient declines at the gate: destroyed unwatched, rows and objects gone', async () => {
	const { locator, count } = await sealedVideo();
	const res = await handlers.destroyVideo(body({ locator }));
	assert.deepEqual(parse(res), {});

	assert.equal(await rowExists(locator), false);
	for (let i = 0; i < count; i++) {
		assert.equal(await rowExists(deriveSegmentLocator(locator, i)), false);
	}
	assert.equal((await handlers.claimVideo(body({ locator }))).statusCode, 410);
});

test('the sender regrets via statusToken, and a repeat tap is a safe 200', async () => {
	const { locator, statusToken } = await sealedVideo();
	assert.deepEqual(parse(await handlers.destroyVideo(body({ statusToken }))), {});
	assert.equal(await rowExists(locator), false);
	// Again, and for garbage: the endpoint is never an oracle.
	assert.deepEqual(parse(await handlers.destroyVideo(body({ statusToken }))), {});
	assert.deepEqual(parse(await handlers.destroyVideo(body({ locator: 'C'.repeat(43) }))), {});
	assert.deepEqual(parse(await handlers.destroyVideo(body({}))), {});
});

test('an open watch window cannot be destroyed by either side', async () => {
	const { locator, statusToken } = await sealedVideo();
	await handlers.claimVideo(body({ locator }));
	await handlers.destroyVideo(body({ locator }));
	await handlers.destroyVideo(body({ statusToken }));
	// The window is the recipient's promise: still open, still serving.
	assert.equal((await handlers.segmentUrl(body({ locator, index: 0 }))).statusCode, 200);
});

// --- the burn ----------------------------------------------------------------

test('the burn refuses a live deadline, self-heals its schedule, and deletes at the deadline', async () => {
	const { locator, count } = await sealedVideo();
	const claimed = parse(await handlers.claimVideo(body({ locator })));
	const pk = hashCapability(locator);
	const segmentPks = Array.from({ length: count }, (_, i) =>
		hashCapability(deriveSegmentLocator(locator, i))
	);

	// A stale schedule firing early: nothing is deleted, and the burn re-arms
	// itself at the row's live deadline.
	const armsBefore = scheduler.arms.length;
	assert.deepEqual(await handlers.burnVideo({ pk, segmentPks }), { burned: false });
	assert.equal(await rowExists(locator), true);
	const rearm = scheduler.arms[scheduler.arms.length - 1];
	assert.ok(scheduler.arms.length > armsBefore);
	assert.equal(rearm.atEpoch, claimed.deadlineEpoch);

	// At the deadline: session row, segment rows, and objects all go.
	await setSession(locator, { deadlineEpoch: now() - 1 });
	assert.deepEqual(await handlers.burnVideo({ pk, segmentPks }), { burned: true });
	assert.equal(await rowExists(locator), false);
	for (const segPk of segmentPks) {
		const res = await doc.send(
			new GetCommand({ TableName: process.env.TABLE_NAME, Key: { pk: segPk } })
		);
		assert.equal(res.Item, undefined);
	}

	// A duplicate fire sweeps nothing and breaks nothing.
	assert.deepEqual(await handlers.burnVideo({ pk, segmentPks }), { burned: true });
});

test('burned segment objects are gone from the bucket', async () => {
	const { locator, count } = await sealedVideo();
	await handlers.claimVideo(body({ locator }));
	const pk = hashCapability(locator);
	const segmentPks = Array.from({ length: count }, (_, i) =>
		hashCapability(deriveSegmentLocator(locator, i))
	);
	const keysBefore = [...s3.objects.keys()].filter((k) => k.startsWith('v/'));
	assert.ok(keysBefore.length >= count);

	await setSession(locator, { deadlineEpoch: now() - 1 });
	await handlers.burnVideo({ pk, segmentPks });

	// Every object this video owned is out of the bucket. Other tests' objects
	// are untouched, so compare against the segment rows we knew.
	for (const key of keysBefore.slice(-count)) {
		assert.equal(s3.objects.has(key), false);
	}
});

// --- the structural boundary with the file path ------------------------------

test('a video segment is unclaimable through the file claim path', async () => {
	const { locator } = await sealedVideo({ count: 1 });
	// The file claim conditions on kind = 'file'; a video segment row is kind
	// 'video-segment', so this answers 410 without any code in the file path
	// knowing video exists.
	const res = await fileHandlers.claimFile(
		body({ locator: deriveSegmentLocator(locator, 0) })
	);
	assert.equal(res.statusCode, 410);
	// And nothing was consumed: the segment still serves inside a window.
	await handlers.claimVideo(body({ locator }));
	assert.equal((await handlers.segmentUrl(body({ locator, index: 0 }))).statusCode, 200);
});

test('objects live under the v/ prefix that scopes the GET-signing role', async () => {
	const created = parse(
		await handlers.createVideo(
			body({ segments: declareSegments(1), ttlSeconds: 60, capabilityGrant: 'video-send-grant' })
		)
	);
	const key = created.segments[0].upload.url.replace('https://bucket.invalid/', '');
	assert.match(key, /^v\/d1\/[0-9a-f]{64}$/);
});
