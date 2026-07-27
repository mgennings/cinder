import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
	DynamoDBClient,
	CreateTableCommand,
	DeleteTableCommand
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
	putNote,
	burnNote,
	putFileGrant,
	markFileReady,
	claimFileGrant
} from '../src/store.mjs';

const cfg = {
	region: 'us-east-1',
	endpoint: 'http://localhost:8000',
	credentials: { accessKeyId: 'x', secretAccessKey: 'x' }
};
const raw = new DynamoDBClient(cfg);
const doc = DynamoDBDocumentClient.from(raw);
process.env.TABLE_NAME = 'blip-notes-test';

before(async () => {
	await raw.send(
		new CreateTableCommand({
			TableName: 'blip-notes-test',
			AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
			KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
			BillingMode: 'PAY_PER_REQUEST'
		})
	);
});
after(async () => {
	await raw.send(new DeleteTableCommand({ TableName: 'blip-notes-test' }));
});

const now = 1_800_000_000;

test('put then burn returns the note once', async () => {
	await putNote(doc, { id: 'a', ciphertext: 'CT', iv: 'IV', expiresAt: now + 1000 });
	const first = await burnNote(doc, 'a', now);
	assert.deepEqual(first, { ciphertext: 'CT', iv: 'IV', salt: undefined });
	const second = await burnNote(doc, 'a', now);
	assert.equal(second, null);
});

test('expired note is never served', async () => {
	await putNote(doc, { id: 'b', ciphertext: 'CT', iv: 'IV', expiresAt: now - 1 });
	assert.equal(await burnNote(doc, 'b', now), null);
});

test('concurrent burns yield exactly one winner', async () => {
	await putNote(doc, { id: 'c', ciphertext: 'CT', iv: 'IV', expiresAt: now + 1000 });
	const results = await Promise.all([
		burnNote(doc, 'c', now),
		burnNote(doc, 'c', now),
		burnNote(doc, 'c', now)
	]);
	assert.equal(results.filter((r) => r !== null).length, 1);
});

test('passphrase note round-trips salt through the store', async () => {
	await putNote(doc, { id: 'd', ciphertext: 'CT', iv: 'IV', salt: 'SALT', expiresAt: now + 1000 });
	const got = await burnNote(doc, 'd', now);
	assert.deepEqual(got, { ciphertext: 'CT', iv: 'IV', salt: 'SALT' });
});

// --- file grants -----------------------------------------------------------
//
// The grant is a two-state machine (uploading -> ready) whose every transition
// is a single conditional write. Nothing here reads and then decides.

const grant = (over = {}) => ({
	pk: 'F1',
	objectKey: 'objkey',
	uploadCapabilityHash: 'UCH',
	ciphertextBytes: 1024,
	ciphertextSha256: 'SHA',
	createdAt: now,
	expiresAt: now + 1000,
	...over
});

const ready = (over = {}) => ({
	uploadCapabilityHash: 'UCH',
	objectKey: 'objkey',
	ciphertextBytes: 1024,
	ciphertextSha256: 'SHA',
	nowEpoch: now,
	...over
});

test('a new grant starts in uploading and is not yet claimable', async () => {
	await putFileGrant(doc, grant({ pk: 'f-new' }));
	assert.equal(await claimFileGrant(doc, 'f-new', now), null);
});

test('create refuses to overwrite an existing grant', async () => {
	await putFileGrant(doc, grant({ pk: 'f-dupe' }));
	await assert.rejects(
		() => putFileGrant(doc, grant({ pk: 'f-dupe', objectKey: 'attacker-key' })),
		(e) => e.name === 'ConditionalCheckFailedException'
	);
});

test('finalize moves uploading to ready and makes the grant claimable', async () => {
	await putFileGrant(doc, grant({ pk: 'f-ok' }));
	assert.equal(await markFileReady(doc, ready({ pk: 'f-ok' })), true);

	const claimed = await claimFileGrant(doc, 'f-ok', now);
	assert.deepEqual(claimed, { objectKey: 'objkey', ciphertextBytes: 1024, ciphertextSha256: 'SHA' });
});

test('finalize rejects a wrong upload capability', async () => {
	await putFileGrant(doc, grant({ pk: 'f-cap' }));
	assert.equal(
		await markFileReady(doc, ready({ pk: 'f-cap', uploadCapabilityHash: 'WRONG' })),
		false
	);
	assert.equal(await claimFileGrant(doc, 'f-cap', now), null);
});

test('finalize rejects a substituted object key', async () => {
	await putFileGrant(doc, grant({ pk: 'f-sub' }));
	assert.equal(await markFileReady(doc, ready({ pk: 'f-sub', objectKey: 'somewhere-else' })), false);
});

test('finalize rejects a wrong stored size', async () => {
	await putFileGrant(doc, grant({ pk: 'f-size' }));
	assert.equal(await markFileReady(doc, ready({ pk: 'f-size', ciphertextBytes: 9999 })), false);
});

test('finalize rejects a wrong checksum', async () => {
	await putFileGrant(doc, grant({ pk: 'f-sum' }));
	assert.equal(await markFileReady(doc, ready({ pk: 'f-sum', ciphertextSha256: 'OTHER' })), false);
});

test('finalize rejects an expired grant', async () => {
	await putFileGrant(doc, grant({ pk: 'f-exp', expiresAt: now - 1 }));
	assert.equal(await markFileReady(doc, ready({ pk: 'f-exp' })), false);
});

test('finalize rejects a grant that does not exist', async () => {
	assert.equal(await markFileReady(doc, ready({ pk: 'f-ghost' })), false);
});

test('duplicate finalize is idempotent when every verified fact matches', async () => {
	await putFileGrant(doc, grant({ pk: 'f-idem' }));
	assert.equal(await markFileReady(doc, ready({ pk: 'f-idem' })), true);
	assert.equal(await markFileReady(doc, ready({ pk: 'f-idem' })), true);
	// Still exactly one delivery attempt, not two.
	assert.ok(await claimFileGrant(doc, 'f-idem', now));
	assert.equal(await claimFileGrant(doc, 'f-idem', now), null);
});

test('finalize after a claim cannot resurrect the grant', async () => {
	await putFileGrant(doc, grant({ pk: 'f-resurrect' }));
	await markFileReady(doc, ready({ pk: 'f-resurrect' }));
	assert.ok(await claimFileGrant(doc, 'f-resurrect', now));

	assert.equal(await markFileReady(doc, ready({ pk: 'f-resurrect' })), false);
	assert.equal(await claimFileGrant(doc, 'f-resurrect', now), null);
});

test('claim refuses an expired ready grant even before TTL reaps it', async () => {
	await putFileGrant(doc, grant({ pk: 'f-stale', expiresAt: now + 10 }));
	await markFileReady(doc, ready({ pk: 'f-stale' }));
	assert.equal(await claimFileGrant(doc, 'f-stale', now + 11), null);
});

test('twenty simultaneous claims yield exactly one winner', async () => {
	await putFileGrant(doc, grant({ pk: 'f-race' }));
	await markFileReady(doc, ready({ pk: 'f-race' }));

	const results = await Promise.all(
		Array.from({ length: 20 }, () => claimFileGrant(doc, 'f-race', now))
	);
	assert.equal(results.filter((r) => r !== null).length, 1);
	assert.equal(results.filter((r) => r === null).length, 19);
});
