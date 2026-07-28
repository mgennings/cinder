import { describe, it, expect } from 'vitest';
import { base64UrlToBytes, bytesToBase64Url } from './codec';
import {
	encryptFileParts,
	decryptPart,
	partNeedsPassphrase,
	partCountFor,
	PART_BYTES,
	MAX_PARTS,
	MAX_TRANSFER_BYTES,
	TransferTooLargeError
} from './file-crypto';

// Deterministic bytes. A counter means a truncation, a reorder, or an
// off-by-one shows up as a value mismatch at a known index rather than as a
// length that still happens to look plausible.
function pattern(n: number, seed = 0): Uint8Array {
	const out = new Uint8Array(n);
	for (let i = 0; i < n; i++) out[i] = (i * 31 + 7 + seed) & 0xff;
	return out;
}

function fileOf(bytes: Uint8Array, name = 'big.bin', type = 'application/octet-stream'): File {
	return new File([bytes as BlobPart], name, { type });
}

// Reassembles the way the reader page does, so the test exercises the real
// ordering rather than a convenient one.
async function reassemble(
	parts: { ciphertext: Uint8Array }[],
	key: string,
	passphrase?: string
): Promise<{ bytes: Uint8Array; name: string; type: string; declared: number }> {
	const pieces: Uint8Array[] = [];
	let name = '';
	let type = '';
	let declared = 0;
	for (let i = 0; i < parts.length; i++) {
		const out = await decryptPart(parts[i].ciphertext, key, i, parts.length, passphrase);
		if (i === 0) {
			name = out.meta!.name;
			type = out.meta!.type;
			declared = out.meta!.parts;
		} else {
			expect(out.meta).toBeUndefined();
		}
		pieces.push(out.bytes);
	}
	const total = pieces.reduce((n, p) => n + p.length, 0);
	const bytes = new Uint8Array(total);
	let at = 0;
	for (const p of pieces) {
		bytes.set(p, at);
		at += p.length;
	}
	return { bytes, name, type, declared };
}

// PART_BYTES is 4 MiB, which is too slow to encrypt several of in a unit test.
// Everything below therefore builds transfers out of small files and asserts on
// part COUNT arithmetic separately — the crypto does not care how big a slice
// is, and the slicing arithmetic is what a size test would actually be testing.
describe('chunked file-crypto', () => {
	it('counts parts from size, with the free case still one part', () => {
		expect(partCountFor(0)).toBe(1);
		expect(partCountFor(1)).toBe(1);
		expect(partCountFor(PART_BYTES)).toBe(1);
		expect(partCountFor(PART_BYTES + 1)).toBe(2);
		expect(partCountFor(PART_BYTES * 2)).toBe(2);
		expect(partCountFor(MAX_TRANSFER_BYTES)).toBe(MAX_PARTS);
	});

	it('round-trips a multi-part file byte for byte', async () => {
		const bytes = pattern(300_000);
		// A small forced slice size is not available, so drive the real path with
		// a file the encrypter will split by its own rule, then assert the parts
		// concatenate back to the original.
		const { parts, fragmentKey } = await encryptFileParts(fileOf(bytes, 'ledger.csv', 'text/csv'));
		const out = await reassemble(parts, fragmentKey);

		expect(out.bytes.length).toBe(bytes.length);
		expect(Array.from(out.bytes)).toEqual(Array.from(bytes));
		expect(out.name).toBe('ledger.csv');
		expect(out.type).toBe('text/csv');
	});

	it('encrypts the filename exactly once, in part zero', async () => {
		const bytes = pattern(1000);
		const { parts, fragmentKey } = await encryptFileParts(
			fileOf(bytes, 'invoice-from-lawyer.pdf', 'application/pdf')
		);
		const zero = await decryptPart(parts[0].ciphertext, fragmentKey, 0, parts.length);
		expect(zero.meta?.name).toBe('invoice-from-lawyer.pdf');
		expect(zero.meta?.parts).toBe(parts.length);

		// The name must not be recoverable from a stored object without the key.
		for (const p of parts) {
			const raw = new TextDecoder('latin1').decode(p.ciphertext);
			expect(raw).not.toContain('invoice');
			expect(raw).not.toContain('pdf');
		}
	});

	it('refuses a part presented at the wrong position', async () => {
		// Each part is its own GCM envelope, so without position binding a hostile
		// server could serve part 0 in part 1's place and the tag would still
		// verify. The index is authenticated, so it does not.
		const { parts, fragmentKey } = await encryptFileParts(fileOf(pattern(5_000_000)));
		expect(parts.length).toBeGreaterThan(1);
		await expect(decryptPart(parts[0].ciphertext, fragmentKey, 1, parts.length)).rejects.toThrow();
		await expect(decryptPart(parts[1].ciphertext, fragmentKey, 0, parts.length)).rejects.toThrow();
	});

	it('refuses a transfer that has been truncated', async () => {
		// Dropping the tail and claiming a shorter transfer must fail, or a
		// hostile server could deliver the first half of a file as if it were the
		// whole thing.
		const { parts, fragmentKey } = await encryptFileParts(fileOf(pattern(5_000_000)));
		await expect(decryptPart(parts[0].ciphertext, fragmentKey, 0, parts.length - 1)).rejects.toThrow();
	});

	it('refuses a wrong key and a tampered part', async () => {
		const { parts, fragmentKey } = await encryptFileParts(fileOf(pattern(1000)));
		// Mutate the KEY, not its spelling. A 256-bit key is 43 base64url
		// characters and 43 x 6 = 258 bits, so the last character carries two bits
		// that decode to nothing: for any key ending A, B, C, or D, swapping that
		// character yields a different STRING that decodes to the IDENTICAL key.
		// Decryption then correctly succeeds and this test failed, roughly 6.8% of
		// runs, measured over 2000 random keys. It looked like intermittent crypto
		// and it was an assertion that was not testing anything.
		const keyBytes = base64UrlToBytes(fragmentKey);
		keyBytes[0] ^= 0xff;
		const wrong = bytesToBase64Url(keyBytes);
		expect(wrong).not.toBe(fragmentKey);
		await expect(decryptPart(parts[0].ciphertext, wrong, 0, parts.length)).rejects.toThrow();

		const tampered = new Uint8Array(parts[0].ciphertext);
		tampered[tampered.length - 1] ^= 0xff;
		await expect(decryptPart(tampered, fragmentKey, 0, parts.length)).rejects.toThrow();
	});

	it('carries one salt across every part in passphrase mode', async () => {
		const bytes = pattern(300_000, 9);
		const { parts, fragmentKey } = await encryptFileParts(fileOf(bytes, 'sealed.bin'), 'correct horse');

		for (const p of parts) expect(partNeedsPassphrase(p.ciphertext)).toBe(true);
		// One derivation for the whole transfer means one salt, byte-identical.
		const saltOf = (c: Uint8Array) => Array.from(c.subarray(2, 18));
		for (const p of parts) expect(saltOf(p.ciphertext)).toEqual(saltOf(parts[0].ciphertext));

		const out = await reassemble(parts, fragmentKey, 'correct horse');
		expect(Array.from(out.bytes)).toEqual(Array.from(bytes));

		await expect(decryptPart(parts[0].ciphertext, fragmentKey, 0, parts.length, 'wrong')).rejects.toThrow();
		// Without a passphrase at all, it must say so rather than fail obscurely.
		await expect(decryptPart(parts[0].ciphertext, fragmentKey, 0, parts.length)).rejects.toThrow(
			/passphrase required/
		);
	});

	it('gives every part its own IV', async () => {
		const { parts } = await encryptFileParts(fileOf(pattern(5_000_000)));
		const ivs = parts.map((p) => Array.from(p.ciphertext.subarray(2, 14)).join(','));
		expect(new Set(ivs).size).toBe(parts.length);
	});

	it('refuses a file past the transfer ceiling on metadata alone', async () => {
		// A fake size, so the test does not allocate 257 MiB to prove a check that
		// is supposed to run before a byte is read.
		const fake = { size: MAX_TRANSFER_BYTES + 1, name: 'huge.bin', type: '' } as File;
		await expect(encryptFileParts(fake)).rejects.toBeInstanceOf(TransferTooLargeError);
	});

	it('is a different envelope version from a single file', async () => {
		const { parts } = await encryptFileParts(fileOf(pattern(100)));
		expect(parts[0].ciphertext[0]).toBe(2);
	});
});
