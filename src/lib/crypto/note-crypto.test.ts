import { describe, it, expect } from 'vitest';
import { encryptNote, decryptNote } from './note-crypto';

describe('note-crypto', () => {
	it('round-trips without passphrase', async () => {
		const { payload, fragmentKey } = await encryptNote('hello blip');
		expect(await decryptNote(payload, fragmentKey)).toBe('hello blip');
		expect(payload.salt).toBeUndefined();
	});

	it('round-trips with two-factor passphrase', async () => {
		const { payload, fragmentKey } = await encryptNote('secret', 'correct horse');
		expect(payload.salt).toBeDefined();
		expect(await decryptNote(payload, fragmentKey, 'correct horse')).toBe('secret');
	});

	it('fails with wrong passphrase', async () => {
		const { payload, fragmentKey } = await encryptNote('secret', 'right');
		await expect(decryptNote(payload, fragmentKey, 'wrong')).rejects.toThrow();
	});

	it('fails without the passphrase when one is required', async () => {
		const { payload, fragmentKey } = await encryptNote('secret', 'right');
		await expect(decryptNote(payload, fragmentKey)).rejects.toThrow();
	});

	it('fails on tampered ciphertext', async () => {
		const { payload, fragmentKey } = await encryptNote('secret');
		const flip = payload.ct.endsWith('A') ? 'B' : 'A';
		const bad = { ...payload, ct: payload.ct.slice(0, -1) + flip };
		await expect(decryptNote(bad, fragmentKey)).rejects.toThrow();
	});

	it('produces a unique IV each call', async () => {
		const a = await encryptNote('x');
		const b = await encryptNote('x');
		expect(a.payload.iv).not.toBe(b.payload.iv);
	});

	it('handles unicode', async () => {
		const msg = 'café — 日本語 — 🔥';
		const { payload, fragmentKey } = await encryptNote(msg);
		expect(await decryptNote(payload, fragmentKey)).toBe(msg);
	});
});
