// Video segment crypto. Deliberately NOT a new scheme: a segment is sealed by
// the same `sealPositionedPart` the chunked file path uses and opened by the
// same `decryptPart`, so the envelope framing, the position-authenticating
// AAD, and the key derivation live in exactly one place
// (src/lib/crypto/file-crypto.ts). This file adds only the video-shaped seams:
// lazy per-segment encryption (512 MiB must never be resident at once) and the
// VideoMeta header on segment zero.

import {
	sealingKey,
	sealPositionedPart,
	decryptPart,
	FilenameTooLongError,
	MAX_FILENAME_BYTES
} from '../crypto/file-crypto';
import { bytesToBase64Url } from '../crypto/codec';
import {
	SEGMENT_BYTES,
	MAX_VIDEO_BYTES,
	VideoTooLargeError,
	type VideoSegmenter,
	type VideoSegmentStream,
	type DecryptedSegment
} from './types';

const enc = new TextEncoder();

/** Size math from metadata only — refusing a 4 GB file costs zero reads. */
function plan(file: File): { segments: number; bytes: number } {
	if (file.size > MAX_VIDEO_BYTES) throw new VideoTooLargeError(file.size);
	if (enc.encode(file.name).length > MAX_FILENAME_BYTES) throw new FilenameTooLongError();
	return { segments: Math.max(1, Math.ceil(file.size / SEGMENT_BYTES)), bytes: file.size };
}

export const videoSegmenter: VideoSegmenter = {
	plan,

	async open(file: File, passphrase?: string): Promise<VideoSegmentStream> {
		const { segments } = plan(file);

		const raw = crypto.getRandomValues(new Uint8Array(32)); // AES-256 key
		// One salt and one derivation for the whole video, same reasoning as
		// encryptFileParts: PBKDF2 per segment costs a phone dearly and buys
		// no secrecy.
		const { key, salt } = await sealingKey(raw, passphrase);

		return {
			fragmentKey: bytesToBase64Url(raw),
			segments,
			async *envelopes() {
				for (let index = 0; index < segments; index++) {
					// A Blob slice, so only this segment's bytes are ever resident.
					const slice = new Uint8Array(
						await file.slice(index * SEGMENT_BYTES, (index + 1) * SEGMENT_BYTES).arrayBuffer()
					);

					// Segment zero carries the video's name, type, and true count —
					// the same header keys as a chunked file part, on purpose, so
					// decryptPart parses it without a second format. The count is
					// ALSO in the AAD, so a segment sealed for another count fails
					// the tag before the header is ever read.
					const header =
						index === 0
							? enc.encode(JSON.stringify({ name: file.name, type: file.type, parts: segments }))
							: new Uint8Array(0);

					yield { index, envelope: await sealPositionedPart(key, salt, header, slice, index, segments) };
				}
			}
		};
	}
};

/**
 * Decrypts one segment. `index` and `segmentCount` are authenticated: a
 * segment sealed at another position or for another count fails the GCM tag
 * rather than producing plausible wrong bytes. Implements VideoDecryptor.
 */
export async function decryptSegment(
	ciphertext: Uint8Array,
	fragmentKey: string,
	index: number,
	segmentCount: number,
	passphrase?: string
): Promise<DecryptedSegment> {
	const { bytes, meta } = await decryptPart(ciphertext, fragmentKey, index, segmentCount, passphrase);
	if (!meta) return { bytes };

	// The header's count and the authenticated count come from the same sealer
	// under one tag, so disagreement means a malformed envelope, not a choice.
	if (meta.parts !== segmentCount) throw new Error('Envelope is malformed.');
	return { bytes, meta: { name: meta.name, type: meta.type, segments: meta.parts } };
}
