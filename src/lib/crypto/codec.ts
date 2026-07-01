// Base64 / base64url conversion for binary crypto material.
//
// Prefers the native Uint8Array base64 methods (Baseline 2025) and falls back
// to a btoa/atob bridge for older engines. Standard base64 is used for JSON
// transport; base64url (no padding) is used for the URL fragment so the key
// survives a URL without escaping.

const hasNative =
	typeof (Uint8Array.prototype as unknown as { toBase64?: unknown }).toBase64 === 'function';

export function bytesToBase64(bytes: Uint8Array): string {
	if (hasNative) return (bytes as unknown as { toBase64(): string }).toBase64();
	let s = '';
	for (const byte of bytes) s += String.fromCharCode(byte);
	return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
	if (hasNative) {
		return (Uint8Array as unknown as { fromBase64(s: string): Uint8Array }).fromBase64(b64);
	}
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
	if (hasNative) {
		return (
			bytes as unknown as {
				toBase64(o: { alphabet: string; omitPadding: boolean }): string;
			}
		).toBase64({ alphabet: 'base64url', omitPadding: true });
	}
	return bytesToBase64(bytes)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

export function base64UrlToBytes(b64url: string): Uint8Array {
	if (hasNative) {
		return (
			Uint8Array as unknown as {
				fromBase64(s: string, o: { alphabet: string }): Uint8Array;
			}
		).fromBase64(b64url, { alphabet: 'base64url' });
	}
	const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
	return base64ToBytes(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
}
