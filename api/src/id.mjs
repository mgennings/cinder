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

// A multipart transfer is N ordinary transfers that happen to have been created
// together. Each part gets its own grant, its own object key, and its own atomic
// claim — the per-object guarantee is not re-implemented for parts, it is the
// same code path, which is the only way to be sure it is identical.
//
// The parts' locators are DERIVED from the transfer locator rather than issued
// separately, and that is the design's whole trick: one short link still opens
// every part, so the fragment does not have to carry N capabilities. The
// recipient's browser computes part i's locator locally; the server only ever
// stores sha256 of it, exactly as it does for a single file.
//
// Direction matters. Holding the transfer locator yields every part, which is
// correct — it is one link to one recipient. Holding one part's locator yields
// nothing else, because inverting SHA-256 is the work. A part is not a foothold.
export function deriveChunkLocator(locator, index) {
	return createHash('sha256').update(`${locator}:part:${index}`, 'utf8').digest('base64url');
}

// A video's segment locators are derived from its transfer locator EXACTLY the
// way a file's part locators are: same string, same hash, same encoding. This
// is a name for that reuse, not a third derivation — the design doc
// (docs/ephemeral-video-design.md) forbids inventing one, and the byte-for-byte
// agreement with src/lib/link.ts is already pinned by tests on both sides. No
// collision is possible: every transfer's locator is its own 256 random bits,
// and a video grant row is additionally distinguished by its `kind`.
//
// If you are tempted to give video its own separator string, you are signing up
// to keep FOUR implementations in agreement instead of two. Do not.
export const deriveSegmentLocator = deriveChunkLocator;

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
