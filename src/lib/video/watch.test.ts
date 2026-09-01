import { describe, it, expect, vi } from 'vitest';
import { createWatchStore, type WatchStore } from './watch';
import { memoryStore, type ScratchStore } from './storage';
import { VideoGoneError, VideoExtensionCapError } from './api';
import { sealingKey, sealPositionedPart } from '../crypto/file-crypto';
import { bytesToBase64Url } from '../crypto/codec';
import type { WatchSessionState } from './types';

const enc = new TextEncoder();

function pattern(n: number, seed = 0): Uint8Array {
	const out = new Uint8Array(n);
	for (let i = 0; i < n; i++) out[i] = (i * 31 + 7 + seed) & 0xff;
	return out;
}

// Two real sealed segments, small — the watch store does not care that a
// production segment is 4 MiB, and the crypto is the same code path.
async function sealedVideo() {
	const raw = crypto.getRandomValues(new Uint8Array(32));
	const { key, salt } = await sealingKey(raw);
	const header = enc.encode(JSON.stringify({ name: 'checkin.mp4', type: 'video/mp4', parts: 2 }));
	const seg0 = pattern(3_000);
	const seg1 = pattern(2_000, 9);
	return {
		fragmentKey: bytesToBase64Url(raw),
		ciphertexts: [
			(await sealPositionedPart(key, salt, header, seg0, 0, 2)).ciphertext,
			(await sealPositionedPart(key, salt, new Uint8Array(0), seg1, 1, 2)).ciphertext
		],
		totalBytes: seg0.length + seg1.length
	};
}

const LOCATOR = 'L'.repeat(43);

type FakeOpts = {
	storage?: ScratchStore;
	claimError?: Error;
	extendError?: Error;
	finishedAtClaim?: boolean;
	failFetchOnce?: boolean;
	now?: () => number;
};

async function fakeWatch(opts: FakeOpts = {}) {
	const video = await sealedVideo();
	const nowFn = opts.now ?? (() => 1_000_000);
	const deadline = { value: nowFn() + 3840 };
	const calls = {
		claims: 0,
		segmentUrls: [] as number[],
		fetches: [] as string[],
		destroys: [] as object[],
		finished: 0,
		extends: [] as (string | undefined)[],
		revoked: [] as string[],
		blobs: [] as Blob[]
	};
	let prepaidRemaining = 2;
	let extensionsUsed = 0;
	let fetchFailuresLeft = opts.failFetchOnce ? 1 : 0;

	const storage = opts.storage ?? memoryStore();
	const store = createWatchStore({
		locator: LOCATOR,
		fragmentKey: video.fragmentKey,
		segments: 2,
		storage,
		claim: async () => {
			calls.claims++;
			if (opts.claimError) throw opts.claimError;
			return {
				deadlineEpoch: deadline.value,
				segments: 2,
				finished: opts.finishedAtClaim ?? false,
				prepaidRemaining,
				extensionsUsed
			};
		},
		segmentUrl: async (_locator, index) => {
			calls.segmentUrls.push(index);
			return { url: `https://s3/get/${index}`, expiresIn: 480 };
		},
		fetchSegment: async (url) => {
			calls.fetches.push(url);
			if (fetchFailuresLeft-- > 0) throw new Error('elevator');
			return video.ciphertexts[Number(url.split('/').pop())];
		},
		finished: async () => {
			calls.finished++;
			deadline.value = nowFn() + 480;
			return { deadlineEpoch: deadline.value };
		},
		extend: async (_locator, grant) => {
			calls.extends.push(grant);
			if (opts.extendError) throw opts.extendError;
			if (prepaidRemaining > 0) prepaidRemaining--;
			extensionsUsed++;
			deadline.value += 480;
			return { deadlineEpoch: deadline.value, prepaidRemaining, extensionsUsed };
		},
		destroy: async (credential) => {
			calls.destroys.push(credential);
		},
		createObjectUrl: (blob) => {
			calls.blobs.push(blob);
			return 'blob:cinder-test';
		},
		revokeObjectUrl: (url) => {
			calls.revoked.push(url);
		},
		now: nowFn,
		sleep: async () => {}
	});

	const states: WatchSessionState[] = [];
	store.subscribe((s) => states.push(s));
	return { store, states, calls, video, deadline, storage };
}

function when(store: WatchStore, pred: (s: WatchSessionState) => boolean) {
	return new Promise<WatchSessionState>((resolve) => {
		const unsub = store.subscribe((s) => {
			if (pred(s)) {
				queueMicrotask(unsub);
				resolve(s);
			}
		});
	});
}

describe('the watch store', () => {
	it('starts at the gate with the fragment hint, nothing claimed, nothing fetched', async () => {
		const w = await fakeWatch();
		expect(w.states[0]).toEqual({ phase: 'gate', segments: 2 });
		expect(w.calls.claims).toBe(0);
		expect(w.calls.fetches).toHaveLength(0);
	});

	it('claims, narrates every segment truthfully, and starts playback only when the download is whole', async () => {
		const w = await fakeWatch();
		const watching = when(w.store, (s) => s.phase === 'watching');
		await w.store.claim();
		const final = await watching;

		const downloading = w.states.filter((s) => s.phase === 'downloading');
		expect(downloading.map((s) => (s.phase === 'downloading' ? s.received : -1))).toEqual([
			0, 1, 2
		]);
		// playable never claims what the moov atom cannot deliver: only the state
		// with every segment down says true.
		expect(downloading.map((s) => (s.phase === 'downloading' ? s.playable : null))).toEqual([
			false,
			false,
			true
		]);

		if (final.phase !== 'watching') throw new Error('unreachable');
		expect(final.objectUrl).toBe('blob:cinder-test');
		expect(final.meta).toEqual({ name: 'checkin.mp4', type: 'video/mp4', segments: 2 });
		expect(final.deadlineEpoch).toBe(w.deadline.value);

		// The assembled Blob is the decrypted plaintext, typed for the player.
		expect(w.calls.blobs[0].size).toBe(w.video.totalBytes);
		expect(w.calls.blobs[0].type).toBe('video/mp4');
	});

	it('declining at the gate destroys unwatched and fetches nothing', async () => {
		const w = await fakeWatch();
		await w.store.decline();
		expect(w.calls.destroys).toEqual([{ locator: LOCATOR }]);
		expect(w.states.at(-1)).toEqual({ phase: 'declined' });
		expect(w.calls.fetches).toHaveLength(0);
	});

	it('a gone video answers gone at the claim, watched false', async () => {
		const w = await fakeWatch({ claimError: new VideoGoneError() });
		await w.store.claim();
		expect(w.states.at(-1)).toEqual({ phase: 'gone', watched: false });
	});

	it('a claim that never got a response returns to the gate and rethrows, so a retry can resume', async () => {
		const w = await fakeWatch({ claimError: new Error('offline') });
		await expect(w.store.claim()).rejects.toThrow('offline');
		expect(w.states.at(-1)).toEqual({ phase: 'gate', segments: 2 });
	});

	it('a dropped segment fetch retries with a FRESH issued URL and still completes', async () => {
		const w = await fakeWatch({ failFetchOnce: true });
		const watching = when(w.store, (s) => s.phase === 'watching');
		await w.store.claim();
		await watching;
		// Segment 0 was asked for twice — a lapsed presigned URL is reissued, not
		// retried stale.
		expect(w.calls.segmentUrls).toEqual([0, 0, 1]);
	});

	it('reportFinished shortens the deadline into a countdown carrying the extension doors', async () => {
		const w = await fakeWatch();
		const watching = when(w.store, (s) => s.phase === 'watching');
		await w.store.claim();
		await watching;

		await w.store.reportFinished();
		const state = w.states.at(-1);
		expect(state?.phase).toBe('countdown');
		if (state?.phase !== 'countdown') throw new Error('unreachable');
		expect(state.deadlineEpoch).toBe(w.deadline.value);
		expect(state.extensions).toEqual({ prepaidRemaining: 2, used: 0, canExtend: true });
	});

	it('a session that already reported finished resumes straight into the countdown', async () => {
		const w = await fakeWatch({ finishedAtClaim: true });
		const countdown = when(w.store, (s) => s.phase === 'countdown');
		await w.store.claim();
		const state = await countdown;
		if (state.phase !== 'countdown') throw new Error('unreachable');
		expect(state.objectUrl).toBe('blob:cinder-test');
	});

	it('extend renders only the server’s numbers: new deadline, prepaid spent, count advanced', async () => {
		const w = await fakeWatch();
		const watching = when(w.store, (s) => s.phase === 'watching');
		await w.store.claim();
		await watching;
		await w.store.reportFinished();

		const before = w.deadline.value;
		await w.store.extend();
		const state = w.states.at(-1);
		if (state?.phase !== 'countdown') throw new Error('expected countdown');
		expect(state.deadlineEpoch).toBe(before + 480);
		expect(state.extensions).toEqual({ prepaidRemaining: 1, used: 1, canExtend: true });
	});

	it('a capped extension rethrows for the UI and never invents time', async () => {
		const w = await fakeWatch({ extendError: new VideoExtensionCapError() });
		const watching = when(w.store, (s) => s.phase === 'watching');
		await w.store.claim();
		await watching;
		await w.store.reportFinished();
		const deadlineBefore = (w.states.at(-1) as { deadlineEpoch: number }).deadlineEpoch;

		await expect(w.store.extend()).rejects.toThrow(VideoExtensionCapError);
		// No invented deadline, no spent prepaid, the wire really was asked —
		// and the countdown now says every door is closed.
		const after = w.states.at(-1);
		if (after?.phase !== 'countdown') throw new Error('expected countdown');
		expect(after.deadlineEpoch).toBe(deadlineBefore);
		expect(after.extensions.canExtend).toBe(false);
		expect(w.calls.extends).toHaveLength(1);
	});

	it('the deadline passing discards the local copy and closes honestly', async () => {
		vi.useFakeTimers();
		try {
			let epoch = 1_000_000;
			const w = await fakeWatch({ now: () => epoch });
			const watching = when(w.store, (s) => s.phase === 'watching');
			await w.store.claim();
			await watching;

			epoch = w.deadline.value + 1; // the server's clock, not a theatrical one
			await vi.advanceTimersByTimeAsync(1100);

			expect(w.states.at(-1)).toEqual({ phase: 'gone', watched: true });
			expect(w.calls.revoked).toEqual(['blob:cinder-test']);
			// Every staged segment and the meta are gone from local storage.
			expect(await w.storage.get(`w/${LOCATOR}/0`)).toBeNull();
			expect(await w.storage.get(`w/${LOCATOR}/meta`)).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it('reopening inside the window resumes from the local copy with zero server reads for segments', async () => {
		const shared = memoryStore();
		const first = await fakeWatch({ storage: shared });
		const watching = when(first.store, (s) => s.phase === 'watching');
		await first.store.claim();
		await watching;
		await first.store.dispose(); // dispose discards — so re-seed the cache case
		// dispose() wiped the copy: the elevator case is a NEW page inside the
		// window whose OPFS still holds the segments (the tab closed, the
		// browser kept the origin's storage). Recreate that by downloading again
		// into the same store, then opening a second store over it.
		const second = await fakeWatch({ storage: shared });
		const w2 = when(second.store, (s) => s.phase === 'watching');
		await second.store.claim();
		await w2;

		const third = await fakeWatch({ storage: shared });
		const w3 = when(third.store, (s) => s.phase === 'watching');
		await third.store.claim();
		await w3;
		// The third arrival fetched nothing: every segment came from local bytes.
		expect(third.calls.fetches).toHaveLength(0);
		expect(third.calls.segmentUrls).toHaveLength(0);
	});
});
