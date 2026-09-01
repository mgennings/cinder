// The resumable sender-side uploader. One object owns the whole send after
// encryption is opened: stage every envelope to scratch storage (POST /videos
// pins each segment's exact SHA-256 before any upload grant exists, and
// re-encrypting would mint a different hash — so the bytes hashed are the
// bytes uploaded, held on disk rather than 512 MiB of RAM), create the video,
// PUT and finalize each segment in index order, then seal the whole video.
//
// Resume is free of ethics here — nothing has been promised to a recipient
// until the link is shared. "Confirmed" means the server said so at finalize,
// never that the PUT returned 200: a constraint on what S3 will accept is not
// evidence of what S3 holds. Finalize is idempotent on identical facts, which
// is the entire resume mechanism: after a dropped connection, run() again and
// already-confirmed segments answer 200 while the first unconfirmed one does
// the work.

import { uploadCiphertext } from '../api';
import { deriveSegmentLocator } from '../link';
import {
	createVideo,
	finalizeVideo,
	type VideoCreateGrant,
	type VideoSegmentDigest
} from './api';
import { scratchStore, type ScratchStore } from './storage';
import type { ResumableUploader, UploadState, VideoSegmentStream } from './types';

export type VideoUploaderOptions = {
	stream: VideoSegmentStream;
	ttlSeconds: number;
	capabilityGrant: string;
	/** Injection seams for vitest; the defaults are the real thing. */
	staging?: ScratchStore;
	create?: typeof createVideo;
	finalize?: typeof finalizeVideo;
	upload?: typeof uploadCiphertext;
};

export type VideoUploader = ResumableUploader & {
	/**
	 * Resolves once POST /videos has answered — the moment the sender's link
	 * can be built (grant.locator + stream.fragmentKey) and the statusToken
	 * remembered. Never rejects on its own; failures surface through run().
	 */
	created: Promise<VideoCreateGrant>;
};

export function createVideoUploader(options: VideoUploaderOptions): VideoUploader {
	const {
		stream,
		ttlSeconds,
		capabilityGrant,
		staging = scratchStore(),
		create = createVideo,
		finalize = finalizeVideo,
		upload = uploadCiphertext
	} = options;

	const segments = stream.segments;
	// Staging keys are namespaced by a throwaway id, never by anything secret —
	// the fragment key must not become an OPFS filename.
	const prefix = `s/${crypto.randomUUID()}/`;
	const key = (i: number) => `${prefix}${i}`;

	// Assigned synchronously by the executor; the `!` is for the compiler only.
	let resolveCreated!: (grant: VideoCreateGrant) => void;
	const created = new Promise<VideoCreateGrant>((resolve) => (resolveCreated = resolve));

	// What survives between run() calls — the resume state.
	const digests: VideoSegmentDigest[] = [];
	let staged = false;
	let grant: VideoCreateGrant | null = null;
	const putOk: boolean[] = new Array(segments).fill(false);
	let confirmed = 0;

	let state: UploadState = { phase: 'uploading', confirmed: 0, segments, fraction: 0 };
	const subscribers = new Set<(s: UploadState) => void>();
	const set = (next: UploadState) => {
		state = next;
		for (const run of subscribers) run(state);
	};

	let controller: AbortController | null = null;
	let canceled = false;
	let running: Promise<void> | null = null;

	const uploading = (putFraction = 0) =>
		set({
			phase: 'uploading',
			confirmed,
			segments,
			fraction: Math.min(1, (confirmed + putFraction) / segments)
		});

	async function drive(): Promise<void> {
		canceled = false;
		controller = new AbortController();
		uploading();

		try {
			// Stage everything first: the create call needs every hash, and the
			// stream encrypts lazily so only one segment is ever in memory.
			if (!staged) {
				for await (const { index, envelope } of stream.envelopes()) {
					if (canceled) throw new DOMException('aborted', 'AbortError');
					await staging.put(key(index), envelope.ciphertext);
					digests[index] = {
						ciphertextBytes: envelope.ciphertextBytes,
						ciphertextSha256: envelope.ciphertextSha256
					};
				}
				staged = true;
			}

			// One create. Credits are spent at grant mint, not here, and a retry
			// inside the grant window is free — so a create that failed on the way
			// back retries safely on the next run().
			if (!grant) {
				grant = await create(digests, ttlSeconds, capabilityGrant);
				resolveCreated(grant);
			}

			for (let i = confirmed; i < segments; i++) {
				if (canceled) throw new DOMException('aborted', 'AbortError');

				// A PUT whose 200 we never saw re-PUTs the identical bytes to the
				// identical key — harmless. A PUT that landed but whose finalize
				// response was lost skips straight to finalize, which answers 200
				// idempotently. Both dropped-connection shapes converge here.
				if (!putOk[i]) {
					const blob = await staging.get(key(i));
					if (!blob) throw new Error(`staged segment ${i} is missing`);
					await upload(grant.segments[i].upload, new Uint8Array(await blob.arrayBuffer()), {
						signal: controller.signal,
						onProgress: (fraction) => uploading(fraction)
					});
					putOk[i] = true;
				}

				await finalize(await deriveSegmentLocator(grant.locator, i), grant.uploadCapability);
				confirmed = i + 1;
				uploading();
			}

			// Seal the whole video. Until this succeeds it cannot be claimed, so a
			// half-uploaded video is never presented as whole.
			await finalize(grant.locator, grant.uploadCapability);

			// The staged ciphertext has done its job. Best effort — the sweep
			// failing costs local disk, never the send.
			await staging.removeAll(prefix);

			set({ phase: 'done', segments });
		} catch (error) {
			if (canceled) {
				set({ phase: 'canceled', confirmed, segments });
				return;
			}
			// Recoverable by construction: run() again resumes from `confirmed`.
			// The error still reaches the caller through run()'s rejection, so a
			// genuinely dead video (410 at finalize) is not silently retried
			// forever — the UI decides.
			set({ phase: 'stalled', confirmed, segments });
			throw error;
		} finally {
			controller = null;
			running = null;
		}
	}

	return {
		created,
		run() {
			if (state.phase === 'done') return Promise.resolve();
			return (running ??= drive());
		},
		cancel() {
			canceled = true;
			controller?.abort();
		},
		subscribe(run: (s: UploadState) => void) {
			subscribers.add(run);
			run(state);
			return () => subscribers.delete(run);
		}
	};
}
