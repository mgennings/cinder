import { describe, it, expect } from 'vitest';
import { memoryStore, scratchStore, type ScratchStore } from './storage';

// The memory store is the vitest double for OPFS, so its contract IS the
// contract the uploader and watch store are tested against. Keep it honest.
describe('scratch storage (memory contract)', () => {
	it('falls back to memory when the browser advertises OPFS but cannot write to it', async () => {
		const unavailable: ScratchStore = {
			put: async () => {
				throw new DOMException(
					'The operation failed for an unknown transient reason.',
					'UnknownError'
				);
			},
			get: async () => null,
			remove: async () => {},
			removeAll: async () => {}
		};
		const store = scratchStore(Promise.resolve(unavailable));

		await store.put('w/abc/meta', new Uint8Array([1, 2, 3]));
		expect(
			Array.from(new Uint8Array(await (await store.get('w/abc/meta'))!.arrayBuffer()))
		).toEqual([1, 2, 3]);
	});

	it('round-trips bytes as a Blob and answers null for the never-written', async () => {
		const store = memoryStore();
		await store.put('w/abc/0', new Uint8Array([1, 2, 3]));

		const blob = await store.get('w/abc/0');
		expect(Array.from(new Uint8Array(await blob!.arrayBuffer()))).toEqual([1, 2, 3]);
		expect(await store.get('w/abc/1')).toBeNull();
	});

	it('stores a copy, not a view — the caller may release its buffer', async () => {
		const store = memoryStore();
		const bytes = new Uint8Array([9, 9, 9]);
		await store.put('k', bytes);
		bytes.fill(0);
		expect(Array.from(new Uint8Array(await (await store.get('k'))!.arrayBuffer()))).toEqual([
			9, 9, 9
		]);
	});

	it('removeAll sweeps exactly one prefix', async () => {
		const store = memoryStore();
		await store.put('w/abc/0', new Uint8Array([1]));
		await store.put('w/abc/meta', new Uint8Array([2]));
		await store.put('w/xyz/0', new Uint8Array([3]));

		await store.removeAll('w/abc/');
		expect(await store.get('w/abc/0')).toBeNull();
		expect(await store.get('w/abc/meta')).toBeNull();
		expect(await store.get('w/xyz/0')).not.toBeNull();
	});
});
