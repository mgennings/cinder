// The new seam, attacked. Every case below is a way someone gets a grant the
// system did not mean to give them, and every one of them must be the same
// silent denial.
//
// Nothing here needs a database or a network: the grant format is offline by
// design, which is exactly what makes the transfer API unable to learn who is
// sending. That property is asserted at the bottom.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { mintCapabilityGrant, verifyCapabilityGrant } from '../src/capability-grant.mjs';
import { CAPABILITY, checkCapability } from '../src/capabilities.mjs';

const SECRET = 'test-capability-secret';
const CAP = CAPABILITY.MULTIPART_TRANSFER;
const NONCE = 'a'.repeat(43);

const mint = (over = {}) =>
	mintCapabilityGrant({
		secret: SECRET,
		capability: CAP,
		limits: { maxParts: 64 },
		ttlSeconds: 900,
		nonce: NONCE,
		...over
	});

const verify = (grant, over = {}) =>
	verifyCapabilityGrant(grant, { secret: SECRET, capability: CAP, ...over });

const payloadOf = (grant) => JSON.parse(Buffer.from(grant.split('.')[0], 'base64url').toString());

// Sign an arbitrary payload the way someone HOLDING the secret would, so the
// tests below can prove a correctly signed grant is still rejected when its
// contents are illegal. The signature is not the only check.
const seal = (payload, secret = SECRET) => {
	const segment = Buffer.from(JSON.stringify(payload)).toString('base64url');
	return `${segment}.${createHmac('sha256', secret).update(segment, 'utf8').digest('base64url')}`;
};

// --- the happy path, so the negatives mean something -------------------------

test('a freshly minted grant verifies and carries its limits', () => {
	const v = verify(mint());
	assert.deepEqual(v.limits, { maxParts: 64 });
	assert.equal(v.nonce, NONCE);
});

test('the same grant verifies repeatedly: it is NOT single-use', () => {
	// entitlement-provider.mjs requires this. A create retried after a dropped
	// connection must not fail for the person who paid.
	const g = mint();
	assert.ok(verify(g));
	assert.ok(verify(g));
	assert.ok(verify(g));
});

// --- adversarial -------------------------------------------------------------

test('a grant minted for a DIFFERENT capability is refused', () => {
	const g = mint({ capability: 'transfer.something.else' });
	assert.equal(verify(g), null);
	// And the reverse direction: a legitimate multipart grant does not open some
	// other capability either.
	assert.equal(verify(mint(), { capability: 'transfer.something.else' }), null);
});

test('an expired grant is refused, with no skew allowance', () => {
	const g = mint({ ttlSeconds: 60, now: 1_000_000_000_000 });
	assert.ok(verify(g, { now: 1_000_000_000_000 + 59_000 }));
	assert.equal(verify(g, { now: 1_000_000_000_000 + 60_000 }), null);
	assert.equal(verify(g, { now: 1_000_000_000_000 + 86_400_000 }), null);
});

test('a tampered limits field is refused', () => {
	const g = mint();
	const payload = payloadOf(g);
	payload.limits = { maxParts: 9999 };
	const forged = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${g.split('.')[1]}`;
	assert.equal(verify(forged), null);
});

test('a grant signed with the WRONG secret is refused', () => {
	assert.equal(verify(mint({ secret: 'some-other-secret' })), null);
	// And a verifier with no secret at all denies rather than accepting anything.
	assert.equal(verifyCapabilityGrant(mint(), { secret: '', capability: CAP }), null);
});

test('a grant cannot carry a subject, even correctly signed', () => {
	// The case that matters most. Someone adds `sub` to the mint "just for
	// debugging" and every transfer becomes linkable to an account. The verifier
	// refuses any key outside the four, so the change breaks loudly instead.
	for (const extra of [{ sub: 'cognito-subject-1234' }, { email: 'a@b.c' }, { credits: 9 }]) {
		assert.equal(verify(seal({ ...payloadOf(mint()), ...extra })), null);
	}
	// The four legal keys, and nothing has quietly been added to them.
	assert.deepEqual(Object.keys(payloadOf(mint())).sort(), ['cap', 'exp', 'limits', 'nonce']);
});

test('malformed strings are refused rather than parsed', () => {
	const g = mint();
	for (const bad of [
		null,
		undefined,
		'',
		'not-a-grant',
		g.split('.')[0], // payload with no signature
		`${g}.extra`, // three segments: a JWT-shaped thing is not a grant
		`.${g.split('.')[1]}`,
		`${g.split('.')[0]}.`,
		`${g.split('.')[0]}.${'A'.repeat(43)}`, // right length, wrong bytes
		'x'.repeat(5000)
	]) {
		assert.equal(verify(bad), null, `accepted: ${String(bad).slice(0, 40)}`);
	}
});

test('minting refuses limits that are not positive integers', () => {
	for (const limits of [{ maxParts: 0 }, { maxParts: -1 }, { maxParts: 1.5 }, { maxParts: '64' }, null]) {
		assert.throws(() => mint({ limits }));
	}
	// And a hand-sealed grant carrying an illegal limit is refused at verify too,
	// so the rule holds on both ends rather than only at the mint.
	const p = payloadOf(mint());
	assert.equal(verify(seal({ ...p, limits: { maxParts: 0 } })), null);
	assert.equal(verify(seal({ ...p, limits: { maxParts: '64' } })), null);
});

// --- the gate, as the transport actually calls it ----------------------------

test('the shipped gate denies every adversarial grant and grants only the real one', async () => {
	process.env.CAPABILITY_SECRET = SECRET;
	const { gate } = await import('../src/entitlement-provider.mjs');

	const good = await checkCapability(gate, mint(), CAP, 'maxParts');
	assert.deepEqual(good, { granted: true, limit: 64 });

	for (const bad of [
		null,
		'',
		'dev-capability-grant',
		mint({ secret: 'wrong' }),
		mint({ capability: 'other' })
	]) {
		const d = await checkCapability(gate, bad, CAP, 'maxParts');
		assert.deepEqual(d, { granted: false, limit: 0 });
	}
});

test('the gate denies everything when no secret is configured', async () => {
	const { gate } = await import('../src/entitlement-provider.mjs');
	const grant = mint();
	const saved = process.env.CAPABILITY_SECRET;
	delete process.env.CAPABILITY_SECRET;
	assert.deepEqual(await checkCapability(gate, grant, CAP, 'maxParts'), {
		granted: false,
		limit: 0
	});
	process.env.CAPABILITY_SECRET = saved;
});

// --- the unlinkability properties a refactor would silently destroy ----------
//
// These are not about this seam working. They are about the seam not quietly
// becoming a way to tie an account to a transfer. Each one is a single line
// somewhere else that would undo it.

test('the gate signature still takes no request event', async () => {
	process.env.CAPABILITY_SECRET = SECRET;
	const { gate } = await import('../src/entitlement-provider.mjs');
	let sawKeys = null;
	const spy = { async check(req) { sawKeys = Object.keys(req).sort(); return gate.check(req); } };
	await checkCapability(spy, mint(), CAP, 'maxParts');
	assert.deepEqual(sawKeys, ['capability', 'grant']);
});

test('the transfer API still admits only content-type at CORS', () => {
	const template = readFileSync(new URL('../../template.yaml', import.meta.url), 'utf8');
	// The transfer API's CorsConfiguration, not the identity API's — the identity
	// API is the one that IS allowed an Authorization header, and confusing the
	// two is how this property gets deleted by accident.
	const httpApi = template.slice(template.indexOf('  HttpApi:'), template.indexOf('  IdentityApi:'));
	const headers = /AllowHeaders:\s*\[([^\]]*)\]/.exec(httpApi);
	assert.ok(headers, 'transfer API declares AllowHeaders');
	assert.deepEqual(
		headers[1].split(',').map((s) => s.trim()),
		['content-type']
	);
});

test('the client never sends an Authorization header to /files', () => {
	// Comments stripped first: this file TALKS about the Authorization header at
	// length, and the thing being asserted is that it never sets one.
	const api = readFileSync(new URL('../../src/lib/api.ts', import.meta.url), 'utf8')
		.replace(/\/\/.*$/gm, '')
		.replace(/\/\*[\s\S]*?\*\//g, '');
	assert.equal(/authorization/i.test(api), false, 'src/lib/api.ts must set no authorization header');
	// And the grant travels in the body, which is the other half of the same rule.
	assert.match(api, /capabilityGrant \? \{ capabilityGrant \}/);
});
