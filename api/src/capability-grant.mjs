// The grant format, minting and verification in one file because they are one
// decision. Pure node:crypto — no AWS SDK, no network, no product name — the
// same posture as identity.mjs, entitlement-logic.mjs, and s3-errors.mjs.
//
// THE FORMAT, exactly as api/src/entitlement-provider.mjs specifies it:
//
//   base64url(JSON{ cap, limits, exp, nonce }) . base64url(HMAC-SHA256(secret, that))
//
// The signature covers the FIRST SEGMENT AS SENT, not a re-serialization of the
// parsed payload. Verifying a re-serialized object is the classic way to make a
// signature check pass on bytes nobody actually received.
//
// WHAT IT DELIBERATELY CANNOT CARRY: a subject, an account, an email, a session,
// a customer id, a balance. Not by convention — `readPayload` refuses any key
// outside the four above, so a future line that adds `sub` to the payload
// produces a grant this verifier rejects rather than a grant that quietly links
// an account to a transfer. The test suite asserts that refusal.
//
// WHY NO BALANCE, even when the plan becomes prepaid credits: a remaining-credit
// count is a small integer that changes per send, and a rare value ("3 left") is
// a usable fingerprint across otherwise unlinkable transfers. The balance stays
// on the identity API, where it is already linkable to an account and where the
// person can see it. See docs/pro-payments.md, "Credits and the grant".

import { createHmac, timingSafeEqual } from 'node:crypto';

// A grant is minted small and read once. The bound exists so a hostile string
// cannot turn into work before anything has been verified.
const MAX_GRANT_CHARS = 2048;

// The complete payload vocabulary. Adding to this list is a privacy decision,
// not a formatting one.
const PAYLOAD_KEYS = new Set(['cap', 'limits', 'exp', 'nonce']);

const b64url = (buf) => Buffer.from(buf).toString('base64url');

const sign = (secret, payloadSegment) =>
	createHmac('sha256', secret).update(payloadSegment, 'utf8').digest();

// Every limit is a positive integer. A missing limit is read as zero by
// checkCapability in capabilities.mjs, never as unlimited, so a malformed limit
// must never survive minting or verification.
const limitsAreClean = (limits) =>
	limits !== null &&
	typeof limits === 'object' &&
	!Array.isArray(limits) &&
	Object.values(limits).every((v) => Number.isInteger(v) && v > 0);

/**
 * Mint a grant. `nonce` is 128+ bits of randomness supplied by the caller so
 * this file stays deterministic and testable; it makes two grants for the same
 * capability and second distinct, which matters when a grant nonce becomes the
 * idempotency key for a prepaid send (docs/pro-payments.md).
 */
export function mintCapabilityGrant({ secret, capability, limits, ttlSeconds, nonce, now = Date.now() }) {
	if (!secret) throw new Error('missing capability secret');
	if (typeof capability !== 'string' || !capability) throw new Error('missing capability');
	if (!limitsAreClean(limits)) throw new Error('limits must be positive integers');
	if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) throw new Error('bad ttl');
	if (typeof nonce !== 'string' || nonce.length < 16) throw new Error('bad nonce');

	const payload = {
		cap: capability,
		limits,
		exp: Math.floor(now / 1000) + ttlSeconds,
		nonce
	};
	const segment = b64url(JSON.stringify(payload));
	return `${segment}.${b64url(sign(secret, segment))}`;
}

// Parse the payload, refusing anything that is not exactly the four keys in
// exactly the right shapes. Returns null rather than throwing so the gate has
// one denial path.
function readPayload(segment) {
	let parsed;
	try {
		parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

	// The subject check, and it is structural. An unknown key — `sub`, `email`,
	// `customer`, anything — fails the whole grant.
	for (const k of Object.keys(parsed)) if (!PAYLOAD_KEYS.has(k)) return null;

	if (typeof parsed.cap !== 'string' || !parsed.cap) return null;
	if (!Number.isInteger(parsed.exp)) return null;
	if (typeof parsed.nonce !== 'string' || !parsed.nonce) return null;
	if (!limitsAreClean(parsed.limits)) return null;
	return parsed;
}

/**
 * Verify a grant for one named capability. Returns the limits, or null.
 *
 * NOT single-use, and that is a requirement rather than an omission: a retried
 * create after a dropped connection must not fail for the person who paid.
 * See entitlement-provider.mjs and docs/pro-payments.md.
 */
export function verifyCapabilityGrant(grant, { secret, capability, now = Date.now() }) {
	if (!secret) return null;
	if (typeof grant !== 'string' || !grant || grant.length > MAX_GRANT_CHARS) return null;

	const parts = grant.split('.');
	// Exactly two segments. A three-segment string is a JWT, and a verifier that
	// shrugged at the extra segment would be one refactor away from reading one.
	if (parts.length !== 2) return null;
	const [segment, signature] = parts;
	if (!segment || !signature) return null;

	const expected = sign(secret, segment);
	const got = Buffer.from(signature, 'base64url');
	// Length first so timingSafeEqual cannot throw on a truncated signature.
	if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;

	const payload = readPayload(segment);
	if (!payload) return null;

	// The capability is checked AFTER the signature, so a wrong-capability grant
	// and a forged one are the same silent null either way.
	if (payload.cap !== capability) return null;
	// No clock skew allowance. A grant is minted for the browser that is about to
	// use it, its lifetime is minutes, and a renewal costs one request.
	if (Math.floor(now / 1000) >= payload.exp) return null;

	return { limits: payload.limits, exp: payload.exp, nonce: payload.nonce };
}
