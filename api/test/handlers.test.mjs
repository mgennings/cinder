import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
	DynamoDBClient,
	CreateTableCommand,
	DeleteTableCommand
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { makeHandlers } from '../src/handlers.mjs';

const cfg = {
	region: 'us-east-1',
	endpoint: 'http://localhost:8000',
	credentials: { accessKeyId: 'x', secretAccessKey: 'x' }
};
const raw = new DynamoDBClient(cfg);
const doc = DynamoDBDocumentClient.from(raw);
process.env.TABLE_NAME = 'blip-notes-h';
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
