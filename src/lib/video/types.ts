// The video contract, in types. This file is the seam every video builder
// codes against: the client lib implements these interfaces, the UI imports
// them, and the numbers here are the numbers in docs/ephemeral-video-design.md
// and docs/video-api-contract.md — every one on the powers-of-two ladder,
// chosen deliberately, changed in all three places or not at all.
//
// Video is a THIRD artifact with its own promise. Nothing here touches the
// note promise or the file promise, and no type in this file is a bigger
// version of a file type — where a shape is genuinely shared (the encrypted
// segment envelope, the locator derivation) it is imported, never re-derived.

import type { PartEnvelope } from '../crypto/file-crypto';

// --- the numbers ------------------------------------------------------------

/** One encrypted S3 object per segment, same size as a file part. */
export const SEGMENT_BYTES = 4 * 1024 * 1024;

/** 128 segments × 4 MiB = the 512 MiB ceiling. */
export const MAX_SEGMENTS = 128;

/** Refused before a byte is read, same posture as MAX_TRANSFER_BYTES. */
export const MAX_VIDEO_BYTES = SEGMENT_BYTES * MAX_SEGMENTS;

/** The enforced guarantee: no segment served past claim + 64 minutes, ever. */
export const WATCH_WINDOW_SECONDS = 64 * 60;

/** Deadline after the client reports playback finished. */
export const FINISHED_COUNTDOWN_SECONDS = 8 * 60;

/** One extension. One credit, or one prepaid tap. */
export const EXTENSION_SECONDS = 8 * 60;

/** 8 extensions × 8 minutes = 64 added minutes. */
export const MAX_EXTENSIONS = 8;

/** The absolute cap no combination of extensions can pass: 128 minutes. */
export const SESSION_CAP_SECONDS = 128 * 60;

/** How long one issued segment URL works; reissued while the session is open. */
export const SEGMENT_URL_SECONDS = 8 * 60;

/**
 * Credits spent when the send link is minted — not when it is watched.
 * PRICING IS MATT'S GATE (design doc, "What is Matt's to decide"): these two
 * are the recommendation the UI may render, never a decision it may assume.
 */
export const SEND_COST_CREDITS = 2;
export const EXTENSION_COST_CREDITS = 1;

/** The only prepaid-extension counts a sender can attach. */
export const PREPAID_EXTENSION_CHOICES = [0, 2, 4, 8] as const;
export type PrepaidExtensions = (typeof PREPAID_EXTENSION_CHOICES)[number];

// --- envelopes --------------------------------------------------------------

/**
 * One encrypted segment: the complete S3 object body plus the exact length and
 * checksum the server pins the presigned PUT to and re-verifies at finalize.
 * Deliberately the same shape as a chunked file part — same AES-256-GCM
 * envelope framing, same position-authenticating AAD discipline (index and
 * segment count sealed in, so reordering or truncation fails the tag), key in
 * the URL fragment only.
 */
export type SegmentEnvelope = PartEnvelope;

/** Segment zero's decrypted header — the video's name, type, and true count. */
export type VideoMeta = {
	name: string;
	/** The container the sender's phone produced; Cinder never transcodes. */
	type: string;
	/** Authenticated count. The fragment's count is a hint; this is the truth. */
	segments: number;
};

export type DecryptedSegment = {
	bytes: Uint8Array;
	/** Present on segment zero only. */
	meta?: VideoMeta;
};

// --- the segmenter ----------------------------------------------------------

/**
 * Cuts and encrypts a video file into independent segment envelopes.
 *
 * An async iterable rather than an array on purpose: 512 MiB must never be
 * resident at once. Each yielded envelope is encrypted from its own Blob slice
 * and can be handed to the uploader and released.
 */
export interface VideoSegmenter {
	/**
	 * Size math from metadata only — refusing a 4 GB file costs zero reads.
	 * Throws VideoTooLargeError past MAX_VIDEO_BYTES.
	 */
	plan(file: File): { segments: number; bytes: number };

	/**
	 * Encrypts under one fresh AES-256 key. The returned fragmentKey goes in
	 * the URL fragment and nowhere else, same as every note and file.
	 */
	open(file: File, passphrase?: string): Promise<VideoSegmentStream>;
}

export interface VideoSegmentStream {
	/** Never sent anywhere — this goes in the URL fragment. */
	readonly fragmentKey: string;
	readonly segments: number;
	/** Envelopes in index order, encrypted lazily. */
	envelopes(): AsyncIterable<{ index: number; envelope: SegmentEnvelope }>;
}

export interface VideoDecryptor {
	/**
	 * index and segmentCount are authenticated, not merely used: a segment
	 * sealed at another position or for another count fails the GCM tag rather
	 * than producing plausible wrong bytes.
	 */
	decryptSegment(
		ciphertext: Uint8Array,
		fragmentKey: string,
		index: number,
		segmentCount: number,
		passphrase?: string
	): Promise<DecryptedSegment>;
}

export class VideoTooLargeError extends Error {
	constructor(readonly size: number) {
		super(`Video is ${size} bytes; the limit is ${MAX_VIDEO_BYTES}.`);
		this.name = 'VideoTooLargeError';
	}
}

// --- the resumable uploader -------------------------------------------------

/**
 * Uploads segment envelopes against the grants POST /videos returned, resuming
 * from the last CONFIRMED segment after a dropped connection. Resume is free
 * of ethics here — nothing has been promised to a recipient until the link is
 * shared — which is exactly why the sender side gets a resume and the claim
 * side never will.
 *
 * "Confirmed" means the server said so at finalize, never that the PUT
 * returned 200: a constraint on what S3 will accept is not evidence of what
 * S3 holds.
 */
export interface ResumableUploader {
	/** Uploads and finalizes every segment not yet confirmed, in index order. */
	run(): Promise<void>;
	/** Aborts the in-flight PUT. Already-confirmed segments stay confirmed. */
	cancel(): void;
	subscribe(run: (state: UploadState) => void): () => void;
}

export type UploadState =
	| { phase: 'uploading'; confirmed: number; segments: number; fraction: number }
	| { phase: 'done'; segments: number }
	| { phase: 'canceled'; confirmed: number; segments: number }
	/** Recoverable by construction: run() again resumes from `confirmed`. */
	| { phase: 'stalled'; confirmed: number; segments: number };

// --- the watch session ------------------------------------------------------

/**
 * What the recipient's screen is doing, as a discriminated union so a surface
 * cannot render a state that does not exist. One honest asymmetry runs through
 * all of it: `deadlineEpoch` is the SERVER's deadline in epoch seconds, and it
 * is the only number the countdown may render. The client never invents,
 * rounds, or theatricalizes a deadline — the countdown counts the real one.
 */
export type WatchSessionState =
	/** The reveal gate. Nothing claimed, nothing fetched, bot-safe. */
	| { phase: 'gate'; segments: number }
	/** POST /videos/claim in flight. */
	| { phase: 'claiming' }
	/**
	 * The window is open and segments are landing. `playableFrom` flips when
	 * enough contiguous segments are decrypted for playback to truthfully
	 * start — the screen narrates the download, never a dead spinner.
	 */
	| {
			phase: 'downloading';
			deadlineEpoch: number;
			received: number;
			segments: number;
			playable: boolean;
	  }
	/** A bounded transfer failure. The server clock still owns the window. */
	| {
			phase: 'transfer-error';
			deadlineEpoch: number;
			received: number;
			segments: number;
	  }
	/** Everything local. Seeking and rewatching cost zero server reads. */
	| { phase: 'watching'; deadlineEpoch: number; objectUrl: string; meta: VideoMeta }
	/**
	 * Playback ended naturally; the server shortened the deadline. Same local
	 * copy, same rewatch, now with the warm countdown rendered from the real
	 * deadline. `canExtend` is false only when every door is closed: the
	 * extension count or session cap is reached.
	 */
	| {
			phase: 'countdown';
			deadlineEpoch: number;
			objectUrl: string;
			meta: VideoMeta;
			extensions: ExtensionState;
	  }
	/** The window ended. Local copy discarded, warm zero-state copy. */
	| { phase: 'gone'; watched: boolean }
	/** The recipient declined at the gate; destroyed unwatched. */
	| { phase: 'declined' };

export type ExtensionState = {
	/** Sender-prepaid extensions still unspent. One tap, no account, no card. */
	prepaidRemaining: number;
	/** Extensions applied so far, of MAX_EXTENSIONS. */
	used: number;
	/** False once used === MAX_EXTENSIONS or the SESSION_CAP is reached. */
	canExtend: boolean;
};

// --- the playback store -----------------------------------------------------

/**
 * The one stateful object the watch UI talks to. Svelte-store contract
 * (`subscribe`) so components consume it with `$store`, plus the four verbs a
 * recipient has. Implementations own the OPFS staging, the segment-URL
 * reissue loop, the deadline clock, and the best-effort local discard at
 * `gone` — none of which leaks into the UI.
 */
export interface PlaybackStore {
	subscribe(run: (state: WatchSessionState) => void): () => void;
	/** The gate's Start watching. Opens the window; the claim is the consent. */
	claim(): Promise<void>;
	/** Retries a transfer that exhausted its automatic attempts. */
	retry(): Promise<void>;
	/** The gate's Decline. Destroys unwatched; costs nothing; looks identical
	 *  to watching from the sender's side. */
	decline(): Promise<void>;
	/**
	 * Fired by the player's natural end event. Tells the server, which
	 * SHORTENS the deadline to now + FINISHED_COUNTDOWN_SECONDS (never
	 * lengthens it). Suppressing this signal is bounded by the window ceiling;
	 * the ceiling is the guarantee, the countdown is the experience.
	 */
	reportFinished(): Promise<void>;
	/**
	 * Adds EXTENSION_SECONDS to the server deadline, capped by MAX_EXTENSIONS
	 * and SESSION_CAP_SECONDS. Spends a prepaid extension when one remains;
	 * otherwise requires a `video.extend` capability grant minted on the
	 * identity API (1 credit, credits-at-mint, no subject in the grant).
	 */
	extend(capabilityGrant?: string): Promise<void>;
}

// --- the sender's view ------------------------------------------------------

/**
 * The sender status surface renders exactly two words, on purpose: 'waiting'
 * (unclaimed, unexpired) and 'gone' (everything else, indistinguishably).
 * Watched, declined, expired, and destroyed are all 'gone' — declining must
 * carry no social penalty the sender can measure.
 */
export type SenderVideoStatus = 'waiting' | 'gone';
