import { describe, it, expect } from 'vitest';
import {
	encryptFile,
	decryptFile,
	MAX_FILE_BYTES,
	MAX_FILENAME_BYTES,
	FileTooLargeError,
	FilenameTooLongError
} from './file-crypto';

// Deterministic bytes: a real binary pattern, not a string. Using a counter
// means a truncation or an off-by-one shows up as a value mismatch at a known
// index rather than as a length that still happens to look plausible.
function pattern(n: number): Uint8Array {
	const out = new Uint8Array(n);
	for (let i = 0; i < n; i++) out[i] = (i * 31 + 7) & 0xff;
	return out;
}

function fileOf(bytes: Uint8Array, name = 'note.bin', type = 'application/octet-stream'): File {
	return new File([bytes as BlobPart], name, { type });
}

describe('file-crypto', () => {
	it('round-trips zero bytes', async () => {
		const { ciphertext, fragmentKey } = await encryptFile(fileOf(new Uint8Array(0)));
		const out = await decryptFile(ciphertext, fragmentKey);
		expect(out.bytes.length).toBe(0);
		expect(out.name).toBe('note.bin');
	});

	it('round-trips one byte', async () => {
		const { ciphertext, fragmentKey } = await encryptFile(fileOf(new Uint8Array([0xff])));
		const out = await decryptFile(ciphertext, fragmentKey);
		expect(Array.from(out.bytes)).toEqual([0xff]);
	});

	it('round-trips deterministic binary content exactly', async () => {
		const bytes = pattern(65_536);
		const { ciphertext, fragmentKey } = await encryptFile(fileOf(bytes));
		const out = await decryptFile(ciphertext, fragmentKey);
		expect(out.bytes).toEqual(bytes);
	});

	it('round-trips a unicode filename', async () => {
		const name = 'café — 日本語 — 🔥.pdf';
		const { ciphertext, fragmentKey } = await encryptFile(fileOf(pattern(64), name, 'application/pdf'));
		const out = await decryptFile(ciphertext, fragmentKey);
		expect(out.name).toBe(name);
		expect(out.type).toBe('application/pdf');
	});

	it('round-trips an absent MIME type', async () => {
		const { ciphertext, fragmentKey } = await encryptFile(fileOf(pattern(8), 'x', ''));
		const out = await decryptFile(ciphertext, fragmentKey);
		expect(out.type).toBe('');
	});

	it('round-trips through a passphrase', async () => {
		const { ciphertext, fragmentKey } = await encryptFile(fileOf(pattern(128)), 'correct horse');
		const out = await decryptFile(ciphertext, fragmentKey, 'correct horse');
		expect(out.bytes).toEqual(pattern(128));
	});

	it('fails with the wrong passphrase', async () => {
		const { ciphertext, fragmentKey } = await encryptFile(fileOf(pattern(32)), 'right');
		await expect(decryptFile(ciphertext, fragmentKey, 'wrong')).rejects.toThrow();
	});

	it('fails without the passphrase when one is required', async () => {
		const { ciphertext, fragmentKey } = await encryptFile(fileOf(pattern(32)), 'right');
		await expect(decryptFile(ciphertext, fragmentKey)).rejects.toThrow();
	});

	it('fails with a wrong but well-formed key', async () => {
		const { ciphertext } = await encryptFile(fileOf(pattern(32)));
		const { fragmentKey: other } = await encryptFile(fileOf(pattern(32)));
		await expect(decryptFile(ciphertext, other)).rejects.toThrow();
	});

	it('fails on changed ciphertext', async () => {
		const { ciphertext, fragmentKey } = await encryptFile(fileOf(pattern(1024)));
		const bad = ciphertext.slice();
		bad[bad.length - 1] ^= 0x01; // flip a bit inside the GCM tag
		await expect(decryptFile(bad, fragmentKey)).rejects.toThrow();
	});

	it('fails on changed metadata', async () => {
		// The filename lives inside the AES-GCM region, so touching it is
		// indistinguishable from touching the bytes: the tag simply fails.
		const { ciphertext, fragmentKey } = await encryptFile(fileOf(pattern(64), 'invoice.pdf'));
		const bad = ciphertext.slice();
		const headerStart = 1 + 1 + 12; // version | saltLen | iv, no salt
		bad[headerStart + 6] ^= 0x40;
		await expect(decryptFile(bad, fragmentKey)).rejects.toThrow();
	});

	it('fails on a truncated envelope', async () => {
		const { ciphertext, fragmentKey } = await encryptFile(fileOf(pattern(64)));
		await expect(decryptFile(ciphertext.slice(0, 8), fragmentKey)).rejects.toThrow();
	});

	it('fails on an unsupported envelope version', async () => {
		const { ciphertext, fragmentKey } = await encryptFile(fileOf(pattern(64)));
		const bad = ciphertext.slice();
		bad[0] = 9;
		await expect(decryptFile(bad, fragmentKey)).rejects.toThrow(/version/i);
	});

	it('never puts the filename or MIME type in the clear', async () => {
		const { ciphertext } = await encryptFile(fileOf(pattern(256), 'salary-2026.pdf', 'application/pdf'));
		const asText = new TextDecoder('latin1').decode(ciphertext);
		expect(asText).not.toContain('salary-2026');
		expect(asText).not.toContain('application/pdf');
	});

	it('uses a unique IV per call', async () => {
		const a = await encryptFile(fileOf(pattern(16)));
		const b = await encryptFile(fileOf(pattern(16)));
		expect(a.ciphertext.slice(2, 14)).not.toEqual(b.ciphertext.slice(2, 14));
	});

	it('reports the exact ciphertext length and a base64 SHA-256', async () => {
		const { ciphertext, ciphertextBytes, ciphertextSha256 } = await encryptFile(fileOf(pattern(1000)));
		expect(ciphertextBytes).toBe(ciphertext.length);
		// base64 of 32 bytes is 44 chars with one '=' of padding.
		expect(ciphertextSha256).toMatch(/^[A-Za-z0-9+/]{43}=$/);
	});

	it('rejects one byte over the ceiling before encrypting', async () => {
		const over = fileOf(new Uint8Array(MAX_FILE_BYTES + 1));
		await expect(encryptFile(over)).rejects.toThrow(FileTooLargeError);
	});

	it('accepts a file exactly at the ceiling', async () => {
		const at = fileOf(new Uint8Array(MAX_FILE_BYTES));
		const { ciphertextBytes } = await encryptFile(at);
		expect(ciphertextBytes).toBeGreaterThan(MAX_FILE_BYTES);
	});

	it('rejects an over-long filename before encrypting', async () => {
		const name = 'a'.repeat(MAX_FILENAME_BYTES + 1);
		await expect(encryptFile(fileOf(pattern(8), name))).rejects.toThrow(FilenameTooLongError);
	});

	it('measures the filename ceiling in UTF-8 bytes, not characters', async () => {
		// 🔥 is four UTF-8 bytes, so 64 of them exceed a 255-byte budget while
		// being only 64 code points. Measuring characters would let this through
		// and blow the ciphertext budget the server verifies against.
		const name = '🔥'.repeat(64);
		await expect(encryptFile(fileOf(pattern(8), name))).rejects.toThrow(FilenameTooLongError);
	});
});
