import { describe, it, expect } from 'vitest';
import { createVideoUploader } from './uploader';
import { memoryStore } from './storage';
import { deriveSegmentLocator } from '../link';
import type { UploadState, VideoSegmentStream } from './types';
import type { VideoCreateGrant } from './api';

// The uploader never opens an envelope, so tiny fake ciphertext exercises the
// whole machine without 4 MiB of GCM per segment.
function fakeStream(count: number): VideoSegmentStream {
	return {
		fragmentKey: 'not-sent-anywhere',
		segments: count,
		async *envelopes() {
			for (let index = 0; index < count; index++) {
				const ciphertext = new Uint8Array([index, index + 1, index + 2]);
				yield {
					index,
					envelope: { ciphertext, ciphertextBytes: 3, ciphertextSha256: `sha-${index}` }
				};
			}
		}
	};
}

function grantFor(count: number): VideoCreateGrant {
	return {
		locator: 'L'.repeat(43),
		uploadCapability: 'cap',
		statusToken: 'status',
		segments: Array.from({ length: count }, (_, index) => ({
			index,
			upload: { url: `https://s3/put/${index}`, headers: {} }
		}))
	};
}

function harness(count: number, opts: { failUploadAt?: number; failFinalizeAt?: string } = {}) {
	const calls = {
		create: [] as { digests: { ciphertextSha256: string }[]; ttl: number; grant: string }[],
		uploads: [] as { url: string; bytes: number[] }[],
		finalized: [] as string[]
	};
	const grant = grantFor(count);
	let uploadFailuresLeft = opts.failUploadAt !== undefined ? 1 : 0;
	let finalizeFailuresLeft = opts.failFinalizeAt !== undefined ? 1 : 0;
	const states: UploadState[] = [];

	const uploader = createVideoUploader({
		stream: fakeStream(count),
		ttlSeconds: 3600,
		capabilityGrant: 'video.send-grant',
		staging: memoryStore(),
		create: async (digests, ttl, g) => {
			calls.create.push({ digests, ttl, grant: g });
			return grant;
		},
		upload: async (uploadGrant, bytes, { signal } = {}) => {
			const index = Number(uploadGrant.url.split('/').pop());
			if (index === opts.failUploadAt && uploadFailuresLeft-- > 0) {
				throw new Error('connection dropped');
			}
			if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
			calls.uploads.push({ url: uploadGrant.url, bytes: Array.from(bytes) });
		},
		finalize: async (locator) => {
			if (locator === opts.failFinalizeAt && finalizeFailuresLeft-- > 0) {
				throw new Error('response lost');
			}
			calls.finalized.push(locator);
		}
	});
	uploader.subscribe((s) => states.push(s));
	return { uploader, calls, grant, states };
}

async function segmentLocators(locator: string, count: number) {
	return Promise.all(Array.from({ length: count }, (_, i) => deriveSegmentLocator(locator, i)));
}

describe('resumable video uploader', () => {
	it('stages, creates, uploads, and finalizes every segment in order, then seals the video', async () => {
		const h = harness(3);
		await h.uploader.run();

		// One create, carrying every digest the stream produced, in index order.
		expect(h.calls.create).toHaveLength(1);
		expect(h.calls.create[0].digests.map((d) => d.ciphertextSha256)).toEqual([
			'sha-0',
			'sha-1',
			'sha-2'
		]);
		expect(h.calls.create[0].grant).toBe('video.send-grant');

		// Each PUT carried the exact staged ciphertext to its own grant.
		expect(h.calls.uploads.map((u) => u.url)).toEqual([
			'https://s3/put/0',
			'https://s3/put/1',
			'https://s3/put/2'
		]);
		expect(h.calls.uploads[1].bytes).toEqual([1, 2, 3]);

		// Segment finalizes with DERIVED locators, then the transfer locator seals.
		const derived = await segmentLocators(h.grant.locator, 3);
		expect(h.calls.finalized).toEqual([...derived, h.grant.locator]);

		expect((await h.uploader.created).statusToken).toBe('status');
		const last = h.states.at(-1);
		expect(last).toEqual({ phase: 'done', segments: 3 });
	});

	it('narrates confirmed truthfully: confirmed means the server said so, not that a PUT returned', async () => {
		const h = harness(2);
		await h.uploader.run();
		const uploadingStates = h.states.filter((s) => s.phase === 'uploading');
		// Confirmed only ever advances after a finalize — 0, then 1, then 2.
		const confirmedSeen = uploadingStates.map((s) => (s.phase === 'uploading' ? s.confirmed : -1));
		expect(confirmedSeen[0]).toBe(0);
		expect(Math.max(...confirmedSeen)).toBe(2);
		expect([...confirmedSeen].sort((a, b) => a - b)).toEqual(confirmedSeen);
	});

	it('stalls on a dropped connection and resumes from the last confirmed segment', async () => {
		const h = harness(3, { failUploadAt: 1 });

		await expect(h.uploader.run()).rejects.toThrow('connection dropped');
		expect(h.states.at(-1)).toEqual({ phase: 'stalled', confirmed: 1, segments: 3 });

		await h.uploader.run();

		// Create ran once; segment 0 was never re-uploaded; 1 and 2 completed.
		expect(h.calls.create).toHaveLength(1);
		expect(h.calls.uploads.map((u) => u.url)).toEqual([
			'https://s3/put/0',
			'https://s3/put/1',
			'https://s3/put/2'
		]);
		expect(h.states.at(-1)).toEqual({ phase: 'done', segments: 3 });
	});

	it('recovers a lost finalize response without re-uploading the segment', async () => {
		const grant = grantFor(2);
		const lostAt = (await segmentLocators(grant.locator, 2))[0];
		const h = harness(2, { failFinalizeAt: lostAt });

		await expect(h.uploader.run()).rejects.toThrow('response lost');
		expect(h.states.at(-1)).toEqual({ phase: 'stalled', confirmed: 0, segments: 2 });

		await h.uploader.run();
		// The PUT for segment 0 happened exactly once; only its finalize repeated.
		expect(h.calls.uploads.filter((u) => u.url.endsWith('/0'))).toHaveLength(1);
		expect(h.states.at(-1)).toEqual({ phase: 'done', segments: 2 });
	});

	it('cancel aborts and reports canceled with what was already confirmed', async () => {
		const states: UploadState[] = [];
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));

		const uploader = createVideoUploader({
			stream: fakeStream(2),
			ttlSeconds: 3600,
			capabilityGrant: 'g',
			staging: memoryStore(),
			create: async () => grantFor(2),
			upload: async (_grant, _bytes, { signal } = {}) => {
				await gate;
				if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
			},
			finalize: async () => {}
		});
		uploader.subscribe((s) => states.push(s));

		const running = uploader.run();
		uploader.cancel();
		release();
		await running;

		expect(states.at(-1)).toEqual({ phase: 'canceled', confirmed: 0, segments: 2 });
	});

	it('run() after done is a no-op', async () => {
		const h = harness(1);
		await h.uploader.run();
		await h.uploader.run();
		expect(h.calls.create).toHaveLength(1);
		expect(h.calls.uploads).toHaveLength(1);
	});
});
