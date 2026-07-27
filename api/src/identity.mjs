// The portable half of the mattOS identity layer: pure token verification and
// pairwise subject derivation. Deliberately free of every AWS SDK import and
// of every network call, so it is unit-tested with node:test and zero
// dependencies — the same posture as id.mjs and s3-errors.mjs.
//
// This file answers exactly one question and refuses to answer any other:
// "which pairwise subject, for which product, is this caller?" It never
// returns an email, a name, a provider identity, or the raw Cognito subject.
// Nothing here logs.

import { createPublicKey, createVerify, createHmac } from 'node:crypto';

// Cognito's minimum token validity is 5 minutes; we allow a little clock skew
// in the caller's favor and no more. A large window here would quietly extend
// the life of a token after sign-out, because a stateless ID token cannot be
// recalled — see docs/identity.md, "What sign-out actually does".
const CLOCK_SKEW_SECONDS = 60;

const b64urlToBuffer = (s) => Buffer.from(String(s), 'base64url');

function decodeJson(segment) {
	try {
		return JSON.parse(b64urlToBuffer(segment).toString('utf8'));
	} catch {
		return null;
	}
}

// The Bearer token, or null. Case-insensitive header lookup because API Gateway
// lowercases header names for HTTP APIs but a local dev server may not.
export function bearerToken(headers = {}) {
	for (const [k, v] of Object.entries(headers)) {
		if (k.toLowerCase() !== 'authorization') continue;
		const m = /^Bearer\s+([A-Za-z0-9._-]+)$/.exec(String(v ?? '').trim());
		return m ? m[1] : null;
	}
	return null;
}

// Verify a Cognito ID token and return its claims, or null.
//
// Every rejection returns the same null. The caller turns that into the same
// answer it gives an anonymous request, so this is never an oracle for "that
// token was real but expired" versus "that token was never real".
//
// `jwks` is the pool's JWKS document ({ keys: [...] }), fetched and cached by
// the impure layer. `now` is injectable so expiry is testable.
export function verifyIdToken(token, { jwks, issuer, audiences, now = Date.now() }) {
	if (typeof token !== 'string') return null;

	const [headerSeg, payloadSeg, signatureSeg] = token.split('.');
	if (!headerSeg || !payloadSeg || !signatureSeg) return null;

	const header = decodeJson(headerSeg);
	// Pin the algorithm before touching a key. Accepting whatever `alg` says is
	// the classic JWT break: `none` skips verification entirely, and `HS256`
	// invites verifying an HMAC against the public key as if it were a secret.
	if (!header || header.alg !== 'RS256' || !header.kid) return null;

	const jwk = jwks?.keys?.find((k) => k.kid === header.kid);
	// A token minted by a DIFFERENT user pool is rejected right here: its kid is
	// not in this pool's JWKS. The issuer check below is the second, independent
	// answer to the same attack.
	if (!jwk || jwk.kty !== 'RSA' || (jwk.alg && jwk.alg !== 'RS256')) return null;

	let key;
	try {
		key = createPublicKey({ key: jwk, format: 'jwk' });
	} catch {
		return null;
	}

	const signature = b64urlToBuffer(signatureSeg);
	const verified = createVerify('RSA-SHA256')
		.update(`${headerSeg}.${payloadSeg}`)
		.verify(key, signature);
	if (!verified) return null;

	const claims = decodeJson(payloadSeg);
	if (!claims) return null;

	// An ACCESS token also verifies against this JWKS and also carries a sub.
	// Only the ID token is audience-bound to one app client, so only the ID
	// token can tell us which product is asking. Insisting on token_use is what
	// stops an access token issued to one client from being replayed at another.
	if (claims.token_use !== 'id') return null;
	if (claims.iss !== issuer) return null;
	if (!audiences.includes(claims.aud)) return null;

	const nowSeconds = Math.floor(now / 1000);
	if (!Number.isFinite(claims.exp) || nowSeconds > claims.exp + CLOCK_SKEW_SECONDS) return null;
	if (Number.isFinite(claims.iat) && nowSeconds + CLOCK_SKEW_SECONDS < claims.iat) return null;

	if (typeof claims.sub !== 'string' || !claims.sub) return null;
	if (typeof claims['cognito:username'] !== 'string' || !claims['cognito:username']) return null;

	return { sub: claims.sub, username: claims['cognito:username'], aud: claims.aud };
}

// PAIRWISE SUBJECT — the reason one pool can serve several products without
// becoming a profile that follows a person across them.
//
// The pool knows one `sub` per person. If every product stored that `sub`, then
// anyone holding two products' databases could join them and say "the person
// entitled on cinder.ink is the person entitled over there." So no product ever
// stores `sub`. Each stores HMAC-SHA256(product_pepper, "product:sub"), and each
// product's pepper is a separate secret. Two entitlement rows for the same human
// are unrelatable without both peppers.
//
// It is a one-way function on purpose: there is no path from a stored row back
// to a person, an account, or a provider identity.
export function pairwiseSubject(sub, product, pepper) {
	if (!pepper) throw new Error('missing product pepper');
	return createHmac('sha256', pepper).update(`${product}:${sub}`, 'utf8').digest('base64');
}

// Parse the two JSON config maps the identity functions carry. A malformed map
// yields {} rather than throwing at import time, and every caller treats an
// unknown key as "deny" — a config typo must fail closed, never open.
export function parseMap(raw) {
	try {
		const parsed = JSON.parse(raw || '{}');
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}
