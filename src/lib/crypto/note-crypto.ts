// Zero-knowledge note crypto. Everything here runs in the browser; the raw key
// never leaves the client (it rides in the URL fragment). The server only ever
// sees the EncryptedPayload — ciphertext, IV, and (in passphrase mode) salt.
//
// AES-256-GCM gives us authenticated encryption: a tampered ciphertext fails to
// decrypt rather than returning garbage. Two-factor passphrase mode XORs a
// PBKDF2-derived key into the random key, so the reader needs BOTH the link and
// the passphrase.

import { bytesToBase64, base64ToBytes, bytesToBase64Url, base64UrlToBytes } from './codec';

export type EncryptedPayload = { ct: string; iv: string; salt?: string };
export type EncryptResult = { payload: EncryptedPayload; fragmentKey: string };

const enc = new TextEncoder();
const dec = new TextDecoder();

const PBKDF2_ITERATIONS = 600_000; // OWASP-current for PBKDF2-HMAC-SHA256

// WebCrypto wants a BufferSource backed by a plain ArrayBuffer. Copy into a
// fresh ArrayBuffer so TypeScript's Uint8Array<ArrayBufferLike> generic (which
// admits SharedArrayBuffer) doesn't fight the BufferSource parameter types.
//
// Exported (with the two key derivations below) so file-crypto can reuse the
// exact same key handling rather than growing a second, subtly different copy.
// One scheme, two envelopes.
export function toBuf(bytes: Uint8Array): ArrayBuffer {
	return bytes.slice().buffer as ArrayBuffer;
}

export async function deriveWithPassphrase(
	raw: Uint8Array,
	passphrase: string,
	salt: Uint8Array
): Promise<CryptoKey> {
	const material = await crypto.subtle.importKey('raw', toBuf(enc.encode(passphrase)), 'PBKDF2', false, [
		'deriveBits'
	]);
	const derived = new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: 'PBKDF2', salt: toBuf(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
			material,
			256
		)
	);
	// Both factors required: XOR the passphrase-derived bytes into the random key.
	const mixed = raw.map((b, i) => b ^ derived[i]);
	return crypto.subtle.importKey('raw', toBuf(mixed), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export function importRaw(raw: Uint8Array): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', toBuf(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptNote(text: string, passphrase?: string): Promise<EncryptResult> {
	const raw = crypto.getRandomValues(new Uint8Array(32)); // AES-256 key
	const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit GCM nonce, unique per note

	let salt: Uint8Array | undefined;
	let key: CryptoKey;
	if (passphrase) {
		salt = crypto.getRandomValues(new Uint8Array(16));
		key = await deriveWithPassphrase(raw, passphrase, salt);
	} else {
		key = await importRaw(raw);
	}

	const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toBuf(iv) }, key, toBuf(enc.encode(text)));
	const payload: EncryptedPayload = {
		ct: bytesToBase64(new Uint8Array(ctBuf)),
		iv: bytesToBase64(iv),
		...(salt ? { salt: bytesToBase64(salt) } : {})
	};
	return { payload, fragmentKey: bytesToBase64Url(raw) };
}

export async function decryptNote(
	payload: EncryptedPayload,
	fragmentKey: string,
	passphrase?: string
): Promise<string> {
	const raw = base64UrlToBytes(fragmentKey);
	const iv = base64ToBytes(payload.iv);
	const ct = base64ToBytes(payload.ct);

	let key: CryptoKey;
	if (payload.salt) {
		if (!passphrase) throw new Error('passphrase required');
		key = await deriveWithPassphrase(raw, passphrase, base64ToBytes(payload.salt));
	} else {
		key = await importRaw(raw);
	}

	const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toBuf(iv) }, key, toBuf(ct));
	return dec.decode(plainBuf);
}
