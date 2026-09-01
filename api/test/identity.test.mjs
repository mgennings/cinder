// The denial paths ARE the feature. Every test below is a way a caller could
// try to be entitled without being entitled, and each one must land on the same
// answer an anonymous caller gets.
//
// Zero dependencies and no AWS: RSA keys are generated here, tokens are signed
// here, and the store is a Map. Run with `node --test api/test/identity.test.mjs`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { bearerToken, verifyIdToken, pairwiseSubject, parseMap } from '../src/identity.mjs';
import { makeEntitlementHandlers } from '../src/entitlement.mjs';
import { verifyCapabilityGrant } from '../src/capability-grant.mjs';

const ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_mattOS';
const CLIENT = 'cinderclient123';
const PRODUCT = 'cinder';
const PEPPER = 'pepper-for-cinder';

// --- a miniature Cognito ----------------------------------------------------

function makePool(kid) {
	const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
	return { jwks: { keys: [jwk] }, privateKey, kid };
}

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function mint(pool, claims, { alg = 'RS256', sign = true } = {}) {
	const header = b64url({ alg, kid: pool.kid, typ: 'JWT' });
	const payload = b64url({
		iss: ISSUER,
		aud: CLIENT,
		token_use: 'id',
		sub: 'cognito-subject-0001',
		'cognito:username': 'signinwithapple_000123',
		iat: Math.floor(Date.now() / 1000),
		exp: Math.floor(Date.now() / 1000) + 300,
		...claims
	});
	const signature = sign
		? createSign('RSA-SHA256').update(`${header}.${payload}`).sign(pool.privateKey).toString('base64url')
		: 'not-a-signature';
	return `${header}.${payload}.${signature}`;
}

const pool = makePool('key-1');
const verify = (token, over = {}) =>
	verifyIdToken(token, { jwks: pool.jwks, issuer: ISSUER, audiences: [CLIENT], ...over });

// --- the authority boundary -------------------------------------------------

test('a genuine ID token verifies and yields only sub, username, aud', () => {
	const claims = verify(mint(pool, {}));
	assert.deepEqual(Object.keys(claims).sort(), ['aud', 'sub', 'username']);
	assert.equal(claims.sub, 'cognito-subject-0001');
});

test('anonymous: no header, empty header, wrong scheme', () => {
	assert.equal(bearerToken({}), null);
	assert.equal(bearerToken({ authorization: '' }), null);
	assert.equal(bearerToken({ Authorization: 'Basic abc' }), null);
	assert.equal(bearerToken({ AUTHORIZATION: 'Bearer abc.def.ghi' }), 'abc.def.ghi');
	assert.equal(verify(null), null);
	assert.equal(verify('not-a-jwt'), null);
});

test('expired: one second past the skew allowance denies', () => {
	const exp = Math.floor(Date.now() / 1000) - 3600;
	const token = mint(pool, { exp, iat: exp - 300 });
	assert.equal(verify(token), null);

	// Same token, evaluated inside its life, verifies — so the denial above is
	// the expiry and not something else about the token.
	assert.ok(verify(token, { now: (exp - 10) * 1000 }));
});

test('forged: a tampered payload invalidates the signature', () => {
	const token = mint(pool, {});
	const [h, p, s] = token.split('.');
	const swapped = b64url({ ...JSON.parse(Buffer.from(p, 'base64url')), sub: 'someone-else' });
	assert.equal(verify(`${h}.${swapped}.${s}`), null);
});

test('forged: an unsigned token, and alg=none, both deny', () => {
	assert.equal(verify(mint(pool, {}, { sign: false })), null);
	assert.equal(verify(mint(pool, {}, { alg: 'none', sign: false })), null);
	// alg confusion: a real RSA signature relabeled as HS256 must not be treated
	// as an HMAC over the public key.
	const real = mint(pool, {});
	const [, p, s] = real.split('.');
	assert.equal(verify(`${b64url({ alg: 'HS256', kid: pool.kid })}.${p}.${s}`), null);
});

test('foreign pool: a valid token from another pool denies twice over', () => {
	const other = makePool('key-1'); // same kid on purpose — only the key differs
	assert.equal(verify(mint(other, {})), null, 'signature must not verify against our JWKS');

	const otherIssuer = makePool('key-2');
	const wrongIssuer = mint(otherIssuer, { iss: 'https://cognito-idp.us-east-1.amazonaws.com/evil' });
	assert.equal(
		verifyIdToken(wrongIssuer, { jwks: otherIssuer.jwks, issuer: ISSUER, audiences: [CLIENT] }),
		null,
		'issuer must be checked independently of the signature'
	);
});

test('wrong audience and wrong token_use deny', () => {
	assert.equal(verify(mint(pool, { aud: 'some-other-app-client' })), null);
	assert.equal(verify(mint(pool, { token_use: 'access' })), null);
});

test('a token missing sub or cognito:username denies', () => {
	assert.equal(verify(mint(pool, { sub: undefined })), null);
	assert.equal(verify(mint(pool, { 'cognito:username': undefined })), null);
});

// --- pairwise subjects ------------------------------------------------------

test('the same person is a different subject in every product', () => {
	const a = pairwiseSubject('sub-1', 'cinder', 'pepper-a');
	const b = pairwiseSubject('sub-1', 'otherproduct', 'pepper-b');
	assert.notEqual(a, b);
	assert.equal(a, pairwiseSubject('sub-1', 'cinder', 'pepper-a'), 'must be stable');
	assert.notEqual(a, pairwiseSubject('sub-2', 'cinder', 'pepper-a'));
	// Nothing recoverable: the raw subject must not appear in the stored value.
	assert.equal(Buffer.from(a, 'base64').toString('utf8').includes('sub-1'), false);
});

test('parseMap fails closed on garbage', () => {
	assert.deepEqual(parseMap('{"a":"b"}'), { a: 'b' });
	assert.deepEqual(parseMap('nonsense'), {});
	assert.deepEqual(parseMap('["a"]'), {});
	assert.deepEqual(parseMap(undefined), {});
});

// --- the routes -------------------------------------------------------------

const CAPABILITY_SECRET = 'mint-secret-for-tests';
const LIMITS = {
	[PRODUCT]: {
		'transfer.multipart': { maxParts: 64 },
		'video.send': { maxSegments: 128 },
		'video.extend': { extensions: 1 }
	}
};
// Mirrors identity-lambda.mjs: transfer.multipart deliberately absent (absent
// means 1 credit, unchanged), video priced per docs/video-api-contract.md.
const COSTS = {
	[PRODUCT]: {
		'video.send': { credits: 2, prepaidExtensionCredits: 1 },
		'video.extend': { credits: 1 }
	}
};

function makeApi({
	rows = new Map(),
	peppers = { [PRODUCT]: PEPPER },
	capabilitySecret = CAPABILITY_SECRET,
	capabilityLimits = LIMITS,
	capabilityCosts = COSTS
} = {}) {
	const deleted = [];
	// A DynamoDB small enough to read, and it enforces the ONE thing the mint
	// depends on: the conditional decrement either takes a credit or throws
	// ConditionalCheckFailedException. A mock that always succeeded would make a
	// broken spend look like a working one.
	const doc = {
		async send(cmd) {
			const { TableName, Key, Item, UpdateExpression, ExpressionAttributeValues } = cmd.input;
			assert.equal(TableName, 'mattos-entitlements');
			if (Item) return rows.set(Item.pk, Item), {};
			if (cmd.constructor.name === 'DeleteCommand') return rows.delete(Key.pk), {};
			if (UpdateExpression?.includes('credits - :n')) {
				// The spend: conditional decrement of :n, all or nothing, exactly
				// the shape entitlement-store.mjs sends.
				const n = ExpressionAttributeValues[':n'];
				const item = rows.get(Key.pk);
				if (!item || !(item.credits >= n)) {
					throw Object.assign(new Error('conditional'), {
						name: 'ConditionalCheckFailedException'
					});
				}
				rows.set(Key.pk, { ...item, credits: item.credits - n });
				return {};
			}
			if (UpdateExpression) {
				const item = rows.get(Key.pk) ?? {};
				rows.set(Key.pk, {
					...item,
					credits: (item.credits ?? 0) + ExpressionAttributeValues[':n']
				});
				return {};
			}
			const item = rows.get(Key.pk);
			return { Item: item ? { credits: item.credits } : undefined };
		}
	};
	const api = makeEntitlementHandlers(doc, {
		getJwks: async () => pool.jwks,
		deleteUser: async (username) => deleted.push(username),
		issuer: ISSUER,
		clientProducts: { [CLIENT]: PRODUCT },
		productPeppers: peppers,
		capabilitySecret,
		capabilityLimits,
		capabilityCosts
	});
	return { api, rows, deleted };
}

process.env.ENTITLEMENT_TABLE = 'mattos-entitlements';

const authed = (token) => ({ headers: { authorization: `Bearer ${token}` } });

test('entitlement: denies anonymous, expired, forged, and foreign-pool callers', async () => {
	const { api, rows } = makeApi();
	// A row exists for this person, so every denial below is the token failing,
	// not an empty table.
	rows.set(`${PRODUCT}#${pairwiseSubject('cognito-subject-0001', PRODUCT, PEPPER)}`, {
		credits: 3
	});

	const exp = Math.floor(Date.now() / 1000) - 3600;
	const denials = {
		anonymous: { headers: {} },
		expired: authed(mint(pool, { exp, iat: exp - 300 })),
		forged: authed(mint(pool, {}, { sign: false })),
		foreignPool: authed(mint(makePool('key-1'), {})),
		wrongAudience: authed(mint(pool, { aud: 'another-client' }))
	};
	for (const [name, event] of Object.entries(denials)) {
		const res = await api.checkEntitlement(event);
		assert.equal(res.statusCode, 200, name);
		assert.deepEqual(JSON.parse(res.body), { entitled: false, credits: 0 }, name);
	}

	const ok = await api.checkEntitlement(authed(mint(pool, {})));
	assert.deepEqual(JSON.parse(ok.body), { entitled: true, credits: 3 });
});

test('entitlement: a valid token with no purchase has no credits', async () => {
	const { api } = makeApi();
	const res = await api.checkEntitlement(authed(mint(pool, {})));
	assert.deepEqual(JSON.parse(res.body), { entitled: false, credits: 0 });
});

test('a missing pepper fails closed rather than sharing a key', async () => {
	const { api } = makeApi({ peppers: {} });
	const res = await api.checkEntitlement(authed(mint(pool, {})));
	assert.deepEqual(JSON.parse(res.body), { entitled: false, credits: 0 });
});

test('the response body carries nothing but the answer', async () => {
	const { api } = makeApi();
	const body = (await api.checkEntitlement(authed(mint(pool, {})))).body;
	for (const leak of ['cognito-subject-0001', 'signinwithapple', 'apple', '@']) {
		assert.equal(body.toLowerCase().includes(leak.toLowerCase()), false, leak);
	}
});

test('deletion removes the row and the Cognito user, and is idempotent', async () => {
	const { api, rows, deleted } = makeApi();
	const pairwise = pairwiseSubject('cognito-subject-0001', PRODUCT, PEPPER);
	rows.set(`${PRODUCT}#${pairwise}`, { credits: 10 });

	const res = await api.deleteAccount(authed(mint(pool, {})));
	assert.deepEqual(JSON.parse(res.body), { deleted: true });
	assert.equal(rows.size, 0, 'the row is deleted, not flagged');
	assert.deepEqual(deleted, ['signinwithapple_000123']);

	// Nothing left to find, and a second call still succeeds without a read.
	assert.equal(
		(await api.checkEntitlement(authed(mint(pool, {})))).body,
		'{"entitled":false,"credits":0}'
	);
	await api.deleteAccount(authed(mint(pool, {})));
	assert.equal(deleted.length, 2);
});

test('deletion sweeps every product this function holds a pepper for', async () => {
	const peppers = { cinder: PEPPER, otherproduct: 'pepper-b' };
	const { api, rows } = makeApi({ peppers });
	for (const [product, pepper] of Object.entries(peppers)) {
		rows.set(`${product}#${pairwiseSubject('cognito-subject-0001', product, pepper)}`, {
			credits: 4
		});
	}
	await api.deleteAccount(authed(mint(pool, {})));
	assert.equal(rows.size, 0);
});

test('an unauthenticated delete deletes nothing and says so', async () => {
	const { api, rows, deleted } = makeApi();
	rows.set('cinder#someone-else', { credits: 4 });
	const res = await api.deleteAccount({ headers: {} });
	assert.deepEqual(JSON.parse(res.body), { deleted: false });
	assert.equal(rows.size, 1);
	assert.equal(deleted.length, 0);
});

// --- the mint ---------------------------------------------------------------
//
// The last place identity exists in the chain. Everything after this holds a
// signed string that says what may be done and nothing about who is doing it.

const entitle = (rows, credits = 5) =>
	rows.set(`${PRODUCT}#${pairwiseSubject('cognito-subject-0001', PRODUCT, PEPPER)}`, { credits });

const balance = (rows) =>
	rows.get(`${PRODUCT}#${pairwiseSubject('cognito-subject-0001', PRODUCT, PEPPER)}`)?.credits ?? 0;

const mintCap = (api, token, capability = 'transfer.multipart', extra = {}) =>
	api.mintCapability({ ...authed(token), body: JSON.stringify({ capability, ...extra }) });

test('capability: an entitled caller gets a grant the real gate accepts', async () => {
	const { api, rows } = makeApi();
	entitle(rows);

	const body = JSON.parse((await mintCap(api, mint(pool, {}))).body);
	assert.equal(body.expiresIn, 900);

	const verified = verifyCapabilityGrant(body.grant, {
		secret: CAPABILITY_SECRET,
		capability: 'transfer.multipart'
	});
	assert.deepEqual(verified.limits, { maxParts: 64 });
});

test('capability: the grant carries no subject and no balance', async () => {
	const { api, rows } = makeApi();
	entitle(rows);
	const { grant } = JSON.parse((await mintCap(api, mint(pool, {}))).body);
	const payload = JSON.parse(Buffer.from(grant.split('.')[0], 'base64url').toString());
	assert.deepEqual(Object.keys(payload).sort(), ['cap', 'exp', 'limits', 'nonce']);
	// The nonce is random, not derived: two grants for the SAME person must not
	// be recognizable as such, which is the join the pairwise subject exists to
	// break and which a derived nonce would hand back.
	const second = JSON.parse((await mintCap(api, mint(pool, {}))).body);
	const other = JSON.parse(Buffer.from(second.grant.split('.')[0], 'base64url').toString());
	assert.notEqual(payload.nonce, other.nonce);
});

test('capability: minting spends exactly one credit, and a zero balance mints nothing', async () => {
	const { api, rows } = makeApi();
	entitle(rows, 2);

	assert.ok(JSON.parse((await mintCap(api, mint(pool, {}))).body).grant, 'first');
	assert.equal(balance(rows), 1);
	assert.ok(JSON.parse((await mintCap(api, mint(pool, {}))).body).grant, 'second');
	assert.equal(balance(rows), 0);

	// The third is the ordinary end of a purchase, and it is the SAME silent
	// negative an anonymous caller gets — not an error, and not a different shape
	// anyone could use as an oracle.
	assert.deepEqual(JSON.parse((await mintCap(api, mint(pool, {}))).body), {
		grant: null,
		expiresIn: null
	});
	assert.equal(balance(rows), 0, 'a refused mint never goes negative');
});

test('capability: a refusal AFTER the balance check spends nothing', async () => {
	// An unknown capability name is refused before the charge. If that order ever
	// flipped, a typo in the client would silently burn a credit per attempt.
	const { api, rows } = makeApi();
	entitle(rows, 3);
	await mintCap(api, mint(pool, {}), 'transfer.everything');
	await api.mintCapability({ ...authed(mint(pool, {})), body: 'not json' });
	assert.equal(balance(rows), 3);
});

test('capability: a valid token with no purchase mints nothing', async () => {
	// Someone who never paid. This is the assertion that catches a mint which
	// grants on a verified token alone — an account is not a purchase.
	const { api } = makeApi();
	assert.deepEqual(JSON.parse((await mintCap(api, mint(pool, {}))).body), {
		grant: null,
		expiresIn: null
	});
});

test('capability: anonymous, forged, foreign-pool, and wrong-audience mint nothing', async () => {
	const { api, rows } = makeApi();
	entitle(rows);
	const exp = Math.floor(Date.now() / 1000) - 3600;
	const denials = [
		api.mintCapability({ headers: {}, body: '{"capability":"transfer.multipart"}' }),
		mintCap(api, mint(pool, { exp, iat: exp - 300 })),
		mintCap(api, mint(pool, {}, { sign: false })),
		mintCap(api, mint(makePool('key-1'), {})),
		mintCap(api, mint(pool, { aud: 'another-client' }))
	];
	for (const res of denials) assert.equal(JSON.parse((await res).body).grant, null);
});

test('capability: an unknown capability name mints nothing', async () => {
	const { api, rows } = makeApi();
	entitle(rows);
	for (const name of ['transfer.everything', '', 'TRANSFER.MULTIPART', 42]) {
		assert.equal(JSON.parse((await mintCap(api, mint(pool, {}), name)).body).grant, null);
	}
	// A malformed body is a refusal, not a 500.
	const bad = await api.mintCapability({ ...authed(mint(pool, {})), body: 'not json' });
	assert.equal(JSON.parse(bad.body).grant, null);
});

// --- video pricing (docs/video-api-contract.md; every number is Matt's gate) --

test('capability: a video send spends 2 credits, all or nothing', async () => {
	const { api, rows } = makeApi();
	entitle(rows, 3);

	const body = JSON.parse((await mintCap(api, mint(pool, {}), 'video.send')).body);
	assert.ok(body.grant);
	assert.equal(balance(rows), 1);
	assert.deepEqual(
		verifyCapabilityGrant(body.grant, { secret: CAPABILITY_SECRET, capability: 'video.send' })
			.limits,
		{ maxSegments: 128 }
	);

	// One credit left against a cost of two: nothing is taken, nothing minted.
	// A partial charge would be a partial grant.
	const short = JSON.parse((await mintCap(api, mint(pool, {}), 'video.send')).body);
	assert.equal(short.grant, null);
	assert.equal(balance(rows), 1);
});

test('capability: prepaid extensions are bought at mint and ride in the limits', async () => {
	const { api, rows } = makeApi();
	entitle(rows, 8);

	// 2 for the send + 4 × 1 per prepaid extension = 6.
	const body = JSON.parse(
		(await mintCap(api, mint(pool, {}), 'video.send', { prepaidExtensions: 4 })).body
	);
	assert.ok(body.grant);
	assert.equal(balance(rows), 2);
	assert.deepEqual(
		verifyCapabilityGrant(body.grant, { secret: CAPABILITY_SECRET, capability: 'video.send' })
			.limits,
		{ maxSegments: 128, prepaidExtensions: 4 }
	);
});

test('capability: only the ladder shapes of prepaid exist, and zero means absent', async () => {
	const { api, rows } = makeApi();
	entitle(rows, 20);

	for (const prepaidExtensions of [3, 1, -2, 16, '4', 4.5]) {
		const res = JSON.parse(
			(await mintCap(api, mint(pool, {}), 'video.send', { prepaidExtensions })).body
		);
		assert.equal(res.grant, null, String(prepaidExtensions));
	}
	assert.equal(balance(rows), 20, 'refusals spend nothing');

	// prepaidExtensions: 0 is a plain send — no key in the limits, because the
	// grant format refuses non-positive limit values and a missing limit
	// already reads as zero.
	const zero = JSON.parse(
		(await mintCap(api, mint(pool, {}), 'video.send', { prepaidExtensions: 0 })).body
	);
	assert.deepEqual(
		verifyCapabilityGrant(zero.grant, { secret: CAPABILITY_SECRET, capability: 'video.send' })
			.limits,
		{ maxSegments: 128 }
	);
	assert.equal(balance(rows), 18);
});

test('capability: prepaid extensions on an unpriced capability mint nothing', async () => {
	// transfer.multipart has no prepaidExtensionCredits configured, so asking
	// for prepaid on it is refused rather than silently unpaid-for.
	const { api, rows } = makeApi();
	entitle(rows, 10);
	const res = JSON.parse(
		(await mintCap(api, mint(pool, {}), 'transfer.multipart', { prepaidExtensions: 2 })).body
	);
	assert.equal(res.grant, null);
	assert.equal(balance(rows), 10);
});

test('capability: a video extension costs 1 credit', async () => {
	const { api, rows } = makeApi();
	entitle(rows, 1);
	const body = JSON.parse((await mintCap(api, mint(pool, {}), 'video.extend')).body);
	assert.ok(body.grant);
	assert.equal(balance(rows), 0);
	assert.deepEqual(
		verifyCapabilityGrant(body.grant, { secret: CAPABILITY_SECRET, capability: 'video.extend' })
			.limits,
		{ extensions: 1 }
	);
});

test('capability: an unconfigured product or missing secret fails closed', async () => {
	const noSecret = makeApi({ capabilitySecret: '' });
	entitle(noSecret.rows);
	assert.equal(JSON.parse((await mintCap(noSecret.api, mint(pool, {}))).body).grant, null);

	const noLimits = makeApi({ capabilityLimits: {} });
	entitle(noLimits.rows);
	assert.equal(JSON.parse((await mintCap(noLimits.api, mint(pool, {}))).body).grant, null);
});

test('capability: deleting the entitlement stops the mint, and does not recall a live grant', async () => {
	const { api, rows } = makeApi();
	entitle(rows);
	const { grant } = JSON.parse((await mintCap(api, mint(pool, {}))).body);

	await api.deleteAccount(authed(mint(pool, {})));
	assert.equal(rows.size, 0);

	// The mint is closed immediately.
	assert.equal(JSON.parse((await mintCap(api, mint(pool, {}))).body).grant, null);

	// The grant already handed out still works until it expires, and that is
	// STATED rather than hidden: a bearer capability cannot be recalled, exactly
	// as a stateless ID token cannot (docs/identity.md, "What sign-out actually
	// does"). Fifteen minutes is the whole exposure, it buys the holder more
	// transfers and nothing else, and closing it would mean the transfer API
	// consulting the entitlement table on every send — which is precisely the
	// link this design exists to prevent.
	assert.ok(
		verifyCapabilityGrant(grant, {
			secret: CAPABILITY_SECRET,
			capability: 'transfer.multipart'
		})
	);
});
