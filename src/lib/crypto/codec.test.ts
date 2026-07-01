import { describe, it, expect } from 'vitest';
import { bytesToBase64, base64ToBytes, bytesToBase64Url, base64UrlToBytes } from './codec';

describe('codec', () => {
	it('round-trips standard base64', () => {
		const b = new Uint8Array([0, 255, 16, 128, 42]);
		expect(base64ToBytes(bytesToBase64(b))).toEqual(b);
	});

	it('round-trips base64url with high bytes and no padding', () => {
		const b = crypto.getRandomValues(new Uint8Array(32));
		const s = bytesToBase64Url(b);
		expect(s).not.toMatch(/[+/=]/);
		expect(base64UrlToBytes(s)).toEqual(b);
	});

	it('handles an empty buffer', () => {
		const b = new Uint8Array([]);
		expect(base64ToBytes(bytesToBase64(b))).toEqual(b);
	});
});
