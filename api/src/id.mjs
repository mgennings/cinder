import { randomBytes, createHash } from 'node:crypto';

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
export function newObjectKey() {
	return randomBytes(32).toString('hex');
}

// ponytail: there is deliberately no local capability comparison here. Every
// capability check is a DynamoDB condition expression instead, which is both
// atomic with the write it guards and free of a read-then-compare window. A
// local constant-time compare would be strictly weaker.
