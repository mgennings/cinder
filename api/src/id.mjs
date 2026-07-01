import { randomBytes } from 'node:crypto';

// 16 random bytes → 22-char base64url id. Enough entropy that ids are
// unguessable, short enough to sit cleanly in a URL.
export function newId() {
	return randomBytes(16).toString('base64url');
}
