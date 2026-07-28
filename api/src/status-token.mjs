import { createHmac, timingSafeEqual } from 'node:crypto';

const AUDIENCE = 'cinder.sender-status';
const MAX_TOKEN_CHARS = 2048;
const MAX_PARTS = 64;
const PAYLOAD_KEYS = new Set(['aud', 'v', 'locator', 'parts', 'exp']);

const sign = (secret, payload) =>
	createHmac('sha256', secret).update(`cinder-status-v1:${payload}`, 'utf8').digest();

export function mintStatusToken({ secret, locator, parts, expiresAt }) {
	if (!secret) throw new Error('missing status secret');
	if (typeof locator !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(locator)) {
		throw new Error('bad locator');
	}
	if (!Number.isInteger(parts) || parts < 1 || parts > MAX_PARTS) throw new Error('bad parts');
	if (!Number.isInteger(expiresAt) || expiresAt <= 0) throw new Error('bad expiry');

	const payload = Buffer.from(
		JSON.stringify({ aud: AUDIENCE, v: 1, locator, parts, exp: expiresAt })
	).toString('base64url');
	return `${payload}.${sign(secret, payload).toString('base64url')}`;
}

export function verifyStatusToken(token, { secret, nowEpoch = Math.floor(Date.now() / 1000) }) {
	if (!secret || typeof token !== 'string' || token.length > MAX_TOKEN_CHARS) return null;
	const [payload, signature, extra] = token.split('.');
	if (!payload || !signature || extra !== undefined) return null;

	const expected = sign(secret, payload);
	const presented = Buffer.from(signature, 'base64url');
	if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;

	let claims;
	try {
		claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
	} catch {
		return null;
	}
	if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return null;
	if (Object.keys(claims).some((key) => !PAYLOAD_KEYS.has(key))) return null;
	if (claims.aud !== AUDIENCE || claims.v !== 1) return null;
	if (typeof claims.locator !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(claims.locator)) return null;
	if (!Number.isInteger(claims.parts) || claims.parts < 1 || claims.parts > MAX_PARTS) return null;
	if (!Number.isInteger(claims.exp) || claims.exp <= nowEpoch) return null;

	return { locator: claims.locator, parts: claims.parts, expiresAt: claims.exp };
}
