import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

// 16 random bytes → 22-char base64url id. Enough entropy that ids are
// unguessable, short enough to sit cleanly in a URL.
export function newId() {
	return randomBytes(16).toString('base64url');
}

// File transfers use capabilities rather than ids: holding the string IS the
// authorization, so they get a full 256 bits and are never stored in the clear.
// The locator and the upload capability are generated independently — one
// leaking must not imply the other.
export function newCapability() {
	return randomBytes(32).toString('base64url');
}

// What lands in DynamoDB. A dump of the table yields hashes, and a hash cannot
// be replayed against the API.
export function hashCapability(capability) {
	return createHash('sha256').update(capability, 'utf8').digest('base64');
}

// Object keys are random and carry no meaning — not the filename, not the
// locator, not a timestamp. A key seen in isolation says nothing about who
// uploaded what, and cannot be derived from a locator.
//
// The one exception is a coarse lifetime band, and it exists to honor the
// sender rather than to describe them. S3 lifecycle rules are per-prefix and
// day-granular, so a single flat rule meant a one-hour transfer's ciphertext
// sat for eight days after it stopped being readable. Banding by prefix lets
// the short-lived case be swept the next day. The band says only "this was
// under a day or over it" — no time, no size, no identity — and the only role
// that can list the bucket at all is the claim function.
export function newObjectKey(ttlSeconds) {
	const band = Number(ttlSeconds) <= 86_400 ? 'd1' : 'd8';
	return `${band}/${randomBytes(32).toString('hex')}`;
}

// The authoritative capability check is still the DynamoDB condition
// expression, which is atomic with the write it guards. This comparison exists
// for a different reason: finalize has to reject a wrong capability BEFORE it
// touches S3, or the extra round trip makes response time a reliable signal
// that a grant exists. Constant time, because comparing a secret in variable
// time is how you turn one oracle into two.
export function capabilityMatches(presented, stored) {
	const a = Buffer.from(String(presented), 'utf8');
	const b = Buffer.from(String(stored ?? ''), 'utf8');
	return a.length === b.length && timingSafeEqual(a, b);
}
