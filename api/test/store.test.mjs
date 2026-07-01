import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
	DynamoDBClient,
	CreateTableCommand,
	DeleteTableCommand
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { putNote, burnNote } from '../src/store.mjs';

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
