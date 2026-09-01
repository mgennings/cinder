import { describe, it, expect } from 'vitest';
import { videoSegmenter, decryptSegment } from './crypto';
import { SEGMENT_BYTES, MAX_VIDEO_BYTES, MAX_SEGMENTS, VideoTooLargeError } from './types';
import { decryptPart, FilenameTooLongError } from '../crypto/file-crypto';
import { bytesToBase64 } from '../crypto/codec';

// Deterministic bytes, same convention as chunked-crypto.test.ts: a counter
// means a truncation or reorder shows up as a value mismatch at a known index.
function pattern(n: number, seed = 0): Uint8Array {
	const out = new Uint8Array(n);
	for (let i = 0; i < n; i++) out[i] = (i * 31 + 7 + seed) & 0xff;
	return out;
}

function fileOf(bytes: Uint8Array, name = 'checkin.mp4', type = 'video/mp4'): File {
	return new File([bytes as BlobPart], name, { type });
}

// plan() reads only file.size, so a ceiling test never has to allocate the
// bytes — an own property shadows the prototype getter.
function fileOfSize(size: number): File {
	const f = fileOf(new Uint8Array(1));
	Object.defineProperty(f, 'size', { value: size });
	return f;
}

async function collect(stream: Awaited<ReturnType<typeof videoSegmenter.open>>) {
	const out: { index: number; envelope: { ciphertext: Uint8Array; ciphertextBytes: number; ciphertextSha256: string } }[] =
		[];
	for await (const item of stream.envelopes()) out.push(item);
	return out;
}

describe('video segmenter', () => {
	it('plans segment count from size alone, with the smallest video one segment', () => {
		expect(videoSegmenter.plan(fileOfSize(1)).segments).toBe(1);
		expect(videoSegmenter.plan(fileOfSize(SEGMENT_BYTES)).segments).toBe(1);
		expect(videoSegmenter.plan(fileOfSize(SEGMENT_BYTES + 1)).segments).toBe(2);
		expect(videoSegmenter.plan(fileOfSize(MAX_VIDEO_BYTES)).segments).toBe(MAX_SEGMENTS);
	});

	it('refuses a video past the ceiling before reading a byte', () => {
		expect(() => videoSegmenter.plan(fileOfSize(MAX_VIDEO_BYTES + 1))).toThrow(VideoTooLargeError);
	});

	it('refuses a filename past 255 UTF-8 bytes', () => {
		expect(() => videoSegmenter.plan(fileOf(pattern(8), 'x'.repeat(256) + '.mp4'))).toThrow(
			FilenameTooLongError
		);
	});

	it('round-trips a single-segment video with its meta', async () => {
		const bytes = pattern(100_000);
		const stream = await videoSegmenter.open(fileOf(bytes, 'checkin.mp4', 'video/mp4'));
		expect(stream.segments).toBe(1);

		const [zero] = await collect(stream);
		const out = await decryptSegment(zero.envelope.ciphertext, stream.fragmentKey, 0, 1);
		expect(out.meta).toEqual({ name: 'checkin.mp4', type: 'video/mp4', segments: 1 });
		expect(Array.from(out.bytes)).toEqual(Array.from(bytes));
	});

	it('round-trips a multi-segment video byte for byte, meta on segment zero only', async () => {
		const bytes = pattern(5_000_000); // > 4 MiB → the segmenter's own rule cuts 2
		const stream = await videoSegmenter.open(fileOf(bytes));
		expect(stream.segments).toBe(2);

		const items = await collect(stream);
		expect(items.map((i) => i.index)).toEqual([0, 1]);

		const pieces: Uint8Array[] = [];
		for (const { index, envelope } of items) {
			const out = await decryptSegment(envelope.ciphertext, stream.fragmentKey, index, 2);
			if (index === 0) expect(out.meta?.segments).toBe(2);
			else expect(out.meta).toBeUndefined();
			pieces.push(out.bytes);
		}

		const joined = new Uint8Array(pieces[0].length + pieces[1].length);
		joined.set(pieces[0], 0);
		joined.set(pieces[1], pieces[0].length);
		expect(joined.length).toBe(bytes.length);
		expect(bytesToBase64(joined)).toBe(bytesToBase64(bytes));
	});

	it('refuses a segment presented at the wrong position or for the wrong count', async () => {
		const stream = await videoSegmenter.open(fileOf(pattern(5_000_000)));
		const items = await collect(stream);

		// Reordered: each envelope is valid only at the position it was sealed at.
		await expect(
			decryptSegment(items[0].envelope.ciphertext, stream.fragmentKey, 1, 2)
		).rejects.toThrow();
		// Truncated: claiming a shorter video fails the tag, not just a check.
		await expect(
			decryptSegment(items[0].envelope.ciphertext, stream.fragmentKey, 0, 1)
		).rejects.toThrow();
	});

	it('seals the exact envelope shape a chunked file part has', async () => {
		// The design doc forbids a third derivation, so a video segment must open
		// with the file path's own decryptPart — same framing, same AAD.
		const bytes = pattern(10_000);
		const stream = await videoSegmenter.open(fileOf(bytes, 'v.mp4', 'video/mp4'));
		const [zero] = await collect(stream);

		const viaFilePath = await decryptPart(zero.envelope.ciphertext, stream.fragmentKey, 0, 1);
		expect(Array.from(viaFilePath.bytes)).toEqual(Array.from(bytes));
		expect(viaFilePath.meta?.name).toBe('v.mp4');

		// The digest the create call pins is the digest of these exact bytes.
		const digest = new Uint8Array(
			await crypto.subtle.digest('SHA-256', zero.envelope.ciphertext.slice().buffer)
		);
		expect(zero.envelope.ciphertextSha256).toBe(bytesToBase64(digest));
		expect(zero.envelope.ciphertextBytes).toBe(zero.envelope.ciphertext.length);
	});

	it('honors a passphrase, and refuses its absence', async () => {
		const bytes = pattern(2_000);
		const stream = await videoSegmenter.open(fileOf(bytes), 'hunter2');
		const [zero] = await collect(stream);

		const out = await decryptSegment(zero.envelope.ciphertext, stream.fragmentKey, 0, 1, 'hunter2');
		expect(Array.from(out.bytes)).toEqual(Array.from(bytes));
		await expect(decryptSegment(zero.envelope.ciphertext, stream.fragmentKey, 0, 1)).rejects.toThrow();
	});

	it('never writes the name or type into a stored object in the clear', async () => {
		// Only the long substring is asserted: a 3-byte string like "mp4" appears
		// by chance in 5 MB of ciphertext about a third of the time, and a flaky
		// crypto assertion teaches people to rerun instead of read.
		const stream = await videoSegmenter.open(fileOf(pattern(5_000_000), 'recovery-checkin.mp4'));
		for (const { envelope } of await collect(stream)) {
			const raw = new TextDecoder('latin1').decode(envelope.ciphertext);
			expect(raw).not.toContain('recovery-checkin');
		}
	});
});
