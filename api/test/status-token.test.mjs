import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { mintStatusToken, verifyStatusToken } from '../src/status-token.mjs';

const secret = 'status-secret-separate-from-every-other-cinder-key';
const locator = 'A'.repeat(43);

test('sender status tokens are scoped, bounded, tamper-evident, and expiring', () => {
	const token = mintStatusToken({ secret, locator, parts: 3, expiresAt: 2000 });
	assert.deepEqual(verifyStatusToken(token, { secret, nowEpoch: 1000 }), {
		locator,
		parts: 3,
		expiresAt: 2000
	});
	assert.equal(verifyStatusToken(token, { secret: 'wrong', nowEpoch: 1000 }), null);
	assert.equal(verifyStatusToken(`${token}x`, { secret, nowEpoch: 1000 }), null);
	assert.equal(verifyStatusToken(token, { secret, nowEpoch: 2000 }), null);

	const [payload, signature] = token.split('.');
	const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
	claims.sub = 'someone@example.com';
	const subjectBearing = `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`;
	assert.equal(verifyStatusToken(subjectBearing, { secret, nowEpoch: 1000 }), null);
});

test('the status Lambda can read one grant and cannot write or touch S3', () => {
	const template = readFileSync(new URL('../../template.yaml', import.meta.url), 'utf8');
	const block = template.match(/  StatusFileFn:[\s\S]*?(?=\n  StatusFileLogGroup:)/)?.[0] ?? '';
	assert.match(block, /Action: \[dynamodb:GetItem\]/);
	for (const forbidden of ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 's3:']) {
		assert.equal(block.includes(forbidden), false, `${forbidden} reached the status role`);
	}
});
