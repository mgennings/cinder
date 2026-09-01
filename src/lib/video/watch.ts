// The recipient's playback store — the one stateful object the watch UI talks
// to. It owns the claim, the segment download, the OPFS staging, the deadline
// clock, and the best-effort local discard; the UI only renders the
// discriminated WatchSessionState and calls its small set of verbs.
//
// Playback honesty, non-negotiable: phone MP4s routinely carry the moov atom
// at the end of the file, so progressive playback of a partial download is not
// generally possible. Playback therefore starts when the download is
// complete, and the download is narrated truthfully (which segment landed,
// how many remain) — never a fake stream, never a dead spinner. `playable`
// flips only when that is actually true.
//
// One honest asymmetry runs through all of it: `deadlineEpoch` is the
// SERVER's deadline. The client never invents, rounds, or theatricalizes one
// — the countdown counts the real number, and the at-read guard on the server
// is the guarantee whether or not this clock is even running.

import {
	claimVideo,
	destroyVideo,
	extendVideo,
	fetchSegmentCiphertext,
	issueSegmentUrl,
	reportVideoFinished,
	VideoExtensionCapError,
	VideoGoneError
} from './api';
import { decryptSegment } from './crypto';
import { scratchStore, type ScratchStore } from './storage';
import { MAX_EXTENSIONS, type PlaybackStore, type VideoMeta, type WatchSessionState } from './types';

// Both on the ladder. The tick is how often the local clock compares itself
// to the server deadline; the retry is how long a dropped connection waits
// before asking for a fresh segment URL again.
const TICK_MS = 1024;
const RETRY_MS = 2048;
const MAX_SEGMENT_ATTEMPTS = 4;

export type WatchStoreOptions = {
	locator: string;
	fragmentKey: string;
	/** The fragment's count — a hint for the gate. The claim's count is the truth. */
	segments: number;
	passphrase?: string;
	/** Injection seams for vitest; the defaults are the real thing. */
	storage?: ScratchStore;
	claim?: typeof claimVideo;
	segmentUrl?: typeof issueSegmentUrl;
	fetchSegment?: typeof fetchSegmentCiphertext;
	finished?: typeof reportVideoFinished;
	extend?: typeof extendVideo;
	destroy?: typeof destroyVideo;
	createObjectUrl?: (blob: Blob) => string;
	revokeObjectUrl?: (url: string) => void;
	/** Epoch seconds. */
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
};

export type WatchStore = PlaybackStore & {
	/** The page letting go: discard the local copy and stop every clock. */
	dispose(): Promise<void>;
};

export function createWatchStore(options: WatchStoreOptions): WatchStore {
	const {
		locator,
		fragmentKey,
		passphrase,
		storage = scratchStore(),
		claim = claimVideo,
		segmentUrl = issueSegmentUrl,
		fetchSegment = fetchSegmentCiphertext,
		finished = reportVideoFinished,
		extend = extendVideo,
		destroy = destroyVideo,
		createObjectUrl = (blob) => URL.createObjectURL(blob),
		revokeObjectUrl = (url) => URL.revokeObjectURL(url),
		now = () => Math.floor(Date.now() / 1000),
		sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))
	} = options;

	const prefix = `w/${locator}/`;
	const segKey = (i: number) => `${prefix}${i}`;
	const metaKey = `${prefix}meta`;

	let state: WatchSessionState = { phase: 'gate', segments: options.segments };
	const subscribers = new Set<(s: WatchSessionState) => void>();
	const set = (next: WatchSessionState) => {
		state = next;
		for (const run of subscribers) run(state);
	};

	// The session facts, all server-issued.
	let deadlineEpoch = 0;
	let prepaidRemaining = 0;
	let extensionsUsed = 0;
	let capReached = false;
	let meta: VideoMeta | null = null;
	let objectUrl: string | null = null;
	let watched = false;
	let ended = false;
	let finishedAtClaim = false;
	let ticker: ReturnType<typeof setInterval> | null = null;

	const extensions = () => ({
		prepaidRemaining,
		used: extensionsUsed,
		canExtend: !capReached && extensionsUsed < MAX_EXTENSIONS
	});

	async function discardLocal() {
		if (objectUrl) {
			try {
				revokeObjectUrl(objectUrl);
			} catch {
				// Letting go of a URL the page never minted is still let go.
			}
			objectUrl = null;
		}
		await storage.removeAll(prefix);
	}

	/** The window ended — by the clock, or by the server saying 410 first. */
	async function expire() {
		if (ended) return;
		ended = true;
		if (ticker) clearInterval(ticker);
		await discardLocal();
		set({ phase: 'gone', watched });
	}

	function startTicker() {
		ticker = setInterval(() => {
			// The server's at-read guard is the guarantee; this clock only keeps
			// the page from claiming a window that has already closed.
			if (now() >= deadlineEpoch) void expire();
		}, TICK_MS);
	}

	/** One segment: fresh URL, fetch, decrypt, stage. Local cache first, so a
	 *  reopened tab inside the window costs no re-download. */
	async function obtainSegment(index: number, segments: number): Promise<boolean> {
		const cachedMeta = index === 0 ? await storage.get(metaKey) : null;
		if (index === 0 && cachedMeta) meta = JSON.parse(await cachedMeta.text()) as VideoMeta;

		// Segment zero's cached bytes are only usable when its meta survived too.
		if ((index > 0 || cachedMeta) && (await storage.get(segKey(index)))) return true;

		for (let attempt = 0; attempt < MAX_SEGMENT_ATTEMPTS && !ended; attempt++) {
			try {
				const { url } = await segmentUrl(locator, index);
				const ciphertext = await fetchSegment(url);
				const out = await decryptSegment(ciphertext, fragmentKey, index, segments, passphrase);
				if (out.meta) {
					meta = out.meta;
					await storage.put(metaKey, new TextEncoder().encode(JSON.stringify(out.meta)));
				}
				await storage.put(segKey(index), out.bytes);
				return true;
			} catch (error) {
				// The window closing is the only unrecoverable answer. Everything
				// else gets four fresh attempts before the page asks the person to
				// act. Reissue is free while the session is open.
				if (error instanceof VideoGoneError) {
					await expire();
					return false;
				}
				if (attempt + 1 < MAX_SEGMENT_ATTEMPTS) await sleep(RETRY_MS);
			}
		}
		return false;
	}

	async function download(segments: number, alreadyFinished: boolean) {
		for (let index = 0; index < segments; index++) {
			if (ended) return;
			if (!(await obtainSegment(index, segments))) {
				if (!ended) set({ phase: 'transfer-error', deadlineEpoch, received: index, segments });
				return;
			}
			set({
				phase: 'downloading',
				deadlineEpoch,
				received: index + 1,
				segments,
				// True only on the last segment: the moov atom problem means a
				// partial file is not honestly playable, so the flag never lies.
				playable: index + 1 === segments
			});
		}
		if (ended) return;

		// Everything local from here: seeking and rewatching cost zero reads.
		const parts: Blob[] = [];
		for (let index = 0; index < segments; index++) {
			const blob = await storage.get(segKey(index));
			if (!blob) return void (await expire());
			parts.push(blob);
		}
		if (!meta) return void (await expire());
		objectUrl = createObjectUrl(new Blob(parts, { type: meta.type }));
		watched = true;

		// A resumed session that already reported finished lands straight in the
		// countdown — the deadline was already shortened and the UI should say so.
		if (alreadyFinished) {
			set({ phase: 'countdown', deadlineEpoch, objectUrl, meta, extensions: extensions() });
		} else {
			set({ phase: 'watching', deadlineEpoch, objectUrl, meta });
		}
	}

	return {
		subscribe(run: (s: WatchSessionState) => void) {
			subscribers.add(run);
			run(state);
			return () => subscribers.delete(run);
		},

		async claim() {
			if (state.phase !== 'gate') return;
			set({ phase: 'claiming' });
			let session;
			try {
				session = await claim(locator);
			} catch (error) {
				if (error instanceof VideoGoneError) {
					set({ phase: 'gone', watched: false });
					return;
				}
				// No response at all. The window may or may not have opened; going
				// back to the gate lets the person try again, and a second claim
				// resumes rather than double-opens by contract.
				set({ phase: 'gate', segments: options.segments });
				throw error;
			}

			deadlineEpoch = session.deadlineEpoch;
			prepaidRemaining = session.prepaidRemaining;
			extensionsUsed = session.extensionsUsed;
			finishedAtClaim = session.finished;
			set({ phase: 'downloading', deadlineEpoch, received: 0, segments: session.segments, playable: false });
			startTicker();
			void download(session.segments, finishedAtClaim);
		},

		async retry() {
			if (state.phase !== 'transfer-error') return;
			const { received, segments } = state;
			set({ phase: 'downloading', deadlineEpoch, received, segments, playable: false });
			void download(segments, finishedAtClaim);
		},

		async decline() {
			if (state.phase !== 'gate') return;
			await destroy({ locator });
			set({ phase: 'declined' });
		},

		async reportFinished() {
			if (state.phase !== 'watching' || !objectUrl || !meta) return;
			try {
				const { deadlineEpoch: shortened } = await finished(locator);
				// The server only ever shortens; trusting its number keeps the
				// countdown honest even if a race extended first.
				deadlineEpoch = shortened;
			} catch (error) {
				if (error instanceof VideoGoneError) return void (await expire());
				// Unreachable is not refused: the local countdown continues against
				// the deadline we already hold, and the ceiling stays the guarantee.
			}
			set({ phase: 'countdown', deadlineEpoch, objectUrl, meta, extensions: extensions() });
		},

		async extend(capabilityGrant?: string) {
			if (ended) return;
			try {
				const result = await extend(locator, capabilityGrant);
				deadlineEpoch = result.deadlineEpoch;
				prepaidRemaining = result.prepaidRemaining;
				extensionsUsed = result.extensionsUsed;
			} catch (error) {
				if (error instanceof VideoGoneError) return void (await expire());
				if (error instanceof VideoExtensionCapError) {
					capReached = true;
					// Every door is closed — say so on the surface now, not after
					// some later success that will never come.
					if (state.phase === 'countdown' && objectUrl && meta) {
						set({ phase: 'countdown', deadlineEpoch, objectUrl, meta, extensions: extensions() });
					}
				}
				// 402 and the cap both rethrow: the UI owns the copy for each, and
				// every minute already on the clock is untouched.
				throw error;
			}
			if (state.phase === 'countdown' && objectUrl && meta) {
				set({ phase: 'countdown', deadlineEpoch, objectUrl, meta, extensions: extensions() });
			} else if (state.phase === 'watching' && objectUrl && meta) {
				set({ phase: 'watching', deadlineEpoch, objectUrl, meta });
			} else if (state.phase === 'downloading') {
				set({ ...state, deadlineEpoch });
			}
		},

		async dispose() {
			ended = true;
			if (ticker) clearInterval(ticker);
			await discardLocal();
		}
	};
}
