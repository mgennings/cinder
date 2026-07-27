// Zero-knowledge file crypto. Same scheme as a note — AES-256-GCM, key in the
// URL fragment — but a different envelope, because a file carries two secrets
// instead of one: the bytes AND what the file is called.
//
// The filename and MIME type are encrypted *inside* the GCM region rather than
// travelling beside it as authenticated-but-visible data. "invoice-from-lawyer.pdf"
// is often the whole story; a design that authenticates the name while leaving
// it readable would protect it from tampering and not at all from reading.
//
// Envelope layout (this is the S3 object body, byte for byte):
//
//   ┌─────────┬─────────┬──────────┬──────────┬──────────────────────────────┐
//   │ version │ saltLen │ salt     │ iv       │ AES-256-GCM                  │
//   │ 1 byte  │ 1 byte  │ 0 or 16  │ 12 bytes │ headerLen ‖ header ‖ bytes ‖ tag │
//   └─────────┴─────────┴──────────┴──────────┴──────────────────────────────┘
//
// The prefix is not authenticated, and does not need to be: every way to corrupt
// it (wrong iv, wrong salt, wrong version) ends in a thrown error, never in
// plausible-looking wrong output. GCM's tag covers everything that carries meaning.

import { bytesToBase64, bytesToBase64Url, base64UrlToBytes } from './codec';
import { toBuf, deriveWithPassphrase, importRaw } from './note-crypto';

const ENVELOPE_VERSION = 1;
const CHUNKED_ENVELOPE_VERSION = 2;
const IV_BYTES = 12; // 96-bit GCM nonce, unique per file
const SALT_BYTES = 16;
const TAG_BYTES = 16;
const HEADER_LEN_BYTES = 4;

// The ceiling is transport-bound, not taste-bound, and it is derived rather
// than chosen. Cinder's retrieval Lambda returns the ciphertext as a single
// buffered response, because a buffered response is the only shape in which
// "nothing leaves before the delete is verified" is true by construction
// instead of by careful ordering (see docs/architecture.md). AWS caps that
// response at 6 MB — 6,291,456 bytes — and it is base64 on the wire, costing 4
// bytes for every 3.
//
//   4 MiB plaintext + 255-byte name + envelope + tag ≈ 4,194,674 ciphertext bytes
//   base64 → 5,592,900 bytes, leaving ~698 KB (11%) under the hard limit.
//
// Raising this means changing the transport, and changing the transport means
// re-proving the delete-before-delivery guarantee. Do not raise it here alone.
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

// 255 UTF-8 bytes is the filesystem convention, and it is also what the
// headroom above was computed against.
export const MAX_FILENAME_BYTES = 255;

// --- larger files: more envelopes, not a bigger one ------------------------
//
// The ceiling above is a property of ONE buffered response, so the way past it
// is more responses rather than a larger one. A big file is cut into parts of
// exactly the size a single transfer already carries, and each part is its own
// independent AES-256-GCM envelope claimed through the same atomic path. The
// per-object guarantee at 256 MiB is not a bigger version of the guarantee at
// 4 MiB; it is the same guarantee, N times, unchanged.
//
// Response streaming would have raised the single-response ceiling to 200 MB
// and was rejected: a stream can only promise "we deleted it before we finished
// sending", which is a behavioral claim about ordering. A buffered response
// makes "nothing left before the delete was verified" true by construction.
// Cinder does not trade a structural guarantee for a behavioral one.
export const PART_BYTES = MAX_FILE_BYTES;

// Memory-bound, and it must agree with MAX_PARTS in api/src/handlers.mjs. The
// server enforces its own copy — this one exists to refuse a hopeless file
// before reading a byte of it, not to be trusted by anybody.
export const MAX_PARTS = 64;
export const MAX_TRANSFER_BYTES = PART_BYTES * MAX_PARTS;

export class TransferTooLargeError extends Error {
	constructor(readonly size: number) {
		super(`Transfer is ${size} bytes; the limit is ${MAX_TRANSFER_BYTES}.`);
		this.name = 'TransferTooLargeError';
	}
}

export type TransferEnvelope = {
	/** One S3 object body per part, in order. */
	parts: FileEnvelope[];
	/** Never sent anywhere — this goes in the URL fragment. */
	fragmentKey: string;
};

export function partCountFor(size: number): number {
	return Math.max(1, Math.ceil(size / PART_BYTES));
}

// Position and total, authenticated. Each part decrypts on its own, so without
// this a hostile server could reorder parts, drop the tail, or replay part 3 in
// part 5's place and every individual GCM tag would still verify. Feeding the
// index and the count in as additional authenticated data makes each envelope
// valid only at the exact position it was written for, and only in a transfer
// of exactly this length. Truncation and reordering both fail the tag.
function positionAad(index: number, partCount: number): Uint8Array {
	const aad = new Uint8Array(8);
	const view = new DataView(aad.buffer);
	view.setUint32(0, index, false);
	view.setUint32(4, partCount, false);
	return aad;
}

/**
 * Encrypts one file as N independent envelopes under a single key.
 *
 * The filename and MIME type are encrypted ONCE, into part zero's header, not
 * repeated per part. Repeating them would hand an observer N copies of the same
 * ciphertext prefix under the same key at a known offset — a gift with no
 * upside — and it would make the name's length visible in every object's size.
 */
export async function encryptFileParts(
	file: File,
	passphrase?: string
): Promise<TransferEnvelope> {
	// Metadata only, before a byte is read. Refusing a 4 GB file should be free.
	if (file.size > MAX_TRANSFER_BYTES) throw new TransferTooLargeError(file.size);
	if (utf8Length(file.name) > MAX_FILENAME_BYTES) throw new FilenameTooLongError();

	const raw = crypto.getRandomValues(new Uint8Array(32)); // AES-256 key

	// One salt and one derivation for the whole transfer. Deriving per part
	// would run 600,000 PBKDF2 rounds 64 times on a phone, for no added secrecy.
	let salt: Uint8Array | undefined;
	let key: CryptoKey;
	if (passphrase) {
		salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
		key = await deriveWithPassphrase(raw, passphrase, salt);
	} else {
		key = await importRaw(raw);
	}

	const partCount = partCountFor(file.size);
	const parts: FileEnvelope[] = [];

	for (let index = 0; index < partCount; index++) {
		// A Blob slice, so only this part's bytes are ever resident. Reading the
		// whole file into memory to slice it would defeat the point at 256 MiB.
		const slice = new Uint8Array(
			await file.slice(index * PART_BYTES, (index + 1) * PART_BYTES).arrayBuffer()
		);

		// Only part zero carries the header. Everything after it is length zero,
		// which keeps one parser for both cases instead of two formats.
		const header =
			index === 0
				? enc.encode(JSON.stringify({ name: file.name, type: file.type, parts: partCount }))
				: new Uint8Array(0);

		const plain = new Uint8Array(HEADER_LEN_BYTES + header.length + slice.length);
		new DataView(plain.buffer).setUint32(0, header.length, false); // big-endian
		plain.set(header, HEADER_LEN_BYTES);
		plain.set(slice, HEADER_LEN_BYTES + header.length);

		// A fresh 96-bit IV per part. Random IVs under one key are safe far past
		// 64 messages; the birthday bound that makes this a real question starts
		// around 2^32.
		const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
		const sealed = new Uint8Array(
			await crypto.subtle.encrypt(
				{
					name: 'AES-GCM',
					iv: toBuf(iv),
					additionalData: toBuf(positionAad(index, partCount))
				},
				key,
				toBuf(plain)
			)
		);

		const saltLen = salt ? salt.length : 0;
		const ciphertext = new Uint8Array(2 + saltLen + IV_BYTES + sealed.length);
		ciphertext[0] = CHUNKED_ENVELOPE_VERSION;
		ciphertext[1] = saltLen;
		if (salt) ciphertext.set(salt, 2);
		ciphertext.set(iv, 2 + saltLen);
		ciphertext.set(sealed, 2 + saltLen + IV_BYTES);

		parts.push({
			ciphertext,
			ciphertextBytes: ciphertext.length,
			ciphertextSha256: await sha256Base64(ciphertext),
			fragmentKey: '' // the transfer owns the key, not the part
		});
	}

	return { parts, fragmentKey: bytesToBase64Url(raw) };
}

/** True if this envelope was sealed with a passphrase. Costs no request. */
export function partNeedsPassphrase(ciphertext: Uint8Array): boolean {
	return ciphertext.length > 1 && ciphertext[1] !== 0;
}

export type DecryptedPart = {
	bytes: Uint8Array;
	/** Present on part zero only — the transfer's name, type, and part count. */
	meta?: { name: string; type: string; parts: number };
};

/**
 * Decrypts one part of a chunked transfer.
 *
 * `index` and `partCount` are authenticated, not merely used: a part that was
 * sealed at a different position, or as part of a transfer of a different
 * length, fails the GCM tag here rather than producing plausible wrong bytes.
 */
export async function decryptPart(
	ciphertext: Uint8Array,
	fragmentKey: string,
	index: number,
	partCount: number,
	passphrase?: string
): Promise<DecryptedPart> {
	if (ciphertext.length < 2) throw new Error('Envelope is truncated.');

	const version = ciphertext[0];
	if (version !== CHUNKED_ENVELOPE_VERSION) {
		throw new Error(`Unsupported envelope version ${version}.`);
	}

	const saltLen = ciphertext[1];
	if (saltLen !== 0 && saltLen !== SALT_BYTES) throw new Error('Envelope is malformed.');

	const minimum = 2 + saltLen + IV_BYTES + HEADER_LEN_BYTES + TAG_BYTES;
	if (ciphertext.length < minimum) throw new Error('Envelope is truncated.');

	const salt = saltLen ? ciphertext.subarray(2, 2 + saltLen) : undefined;
	const iv = ciphertext.subarray(2 + saltLen, 2 + saltLen + IV_BYTES);
	const sealed = ciphertext.subarray(2 + saltLen + IV_BYTES);

	const raw = base64UrlToBytes(fragmentKey);
	let key: CryptoKey;
	if (salt) {
		if (!passphrase) throw new Error('passphrase required');
		key = await deriveWithPassphrase(raw, passphrase, salt);
	} else {
		key = await importRaw(raw);
	}

	const plain = new Uint8Array(
		await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: toBuf(iv), additionalData: toBuf(positionAad(index, partCount)) },
			key,
			toBuf(sealed)
		)
	);

	const headerLen = new DataView(plain.buffer, plain.byteOffset).getUint32(0, false);
	if (headerLen > plain.length - HEADER_LEN_BYTES) throw new Error('Envelope is malformed.');
	const bytes = plain.slice(HEADER_LEN_BYTES + headerLen);

	if (headerLen === 0) return { bytes };

	const meta = JSON.parse(dec.decode(plain.subarray(HEADER_LEN_BYTES, HEADER_LEN_BYTES + headerLen)));
	return {
		bytes,
		meta: {
			name: typeof meta.name === 'string' ? meta.name : 'file',
			type: typeof meta.type === 'string' ? meta.type : '',
			parts: Number.isInteger(meta.parts) ? meta.parts : partCount
		}
	};
}

export class FileTooLargeError extends Error {
	constructor(readonly size: number) {
		super(`File is ${size} bytes; the limit is ${MAX_FILE_BYTES}.`);
		this.name = 'FileTooLargeError';
	}
}

export class FilenameTooLongError extends Error {
	constructor() {
		super(`Filename exceeds ${MAX_FILENAME_BYTES} bytes.`);
		this.name = 'FilenameTooLongError';
	}
}

export type FileEnvelope = {
	/** The complete S3 object body. */
	ciphertext: Uint8Array;
	/** Exact length the server independently re-verifies with HeadObject. */
	ciphertextBytes: number;
	/** Base64 SHA-256, the shape S3's `x-amz-checksum-sha256` wants. */
	ciphertextSha256: string;
	/** Never sent anywhere — this goes in the URL fragment. */
	fragmentKey: string;
};

export type DecryptedFile = {
	bytes: Uint8Array;
	name: string;
	type: string;
};

const enc = new TextEncoder();
const dec = new TextDecoder();

function utf8Length(s: string): number {
	return enc.encode(s).length;
}

async function sha256Base64(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', toBuf(bytes));
	return bytesToBase64(new Uint8Array(digest));
}

export async function encryptFile(file: File, passphrase?: string): Promise<FileEnvelope> {
	// Both checks run against metadata only, before a single byte is read into
	// memory. Rejecting a 2 GB file should cost nothing.
	if (file.size > MAX_FILE_BYTES) throw new FileTooLargeError(file.size);
	if (utf8Length(file.name) > MAX_FILENAME_BYTES) throw new FilenameTooLongError();

	const raw = crypto.getRandomValues(new Uint8Array(32)); // AES-256 key
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

	let salt: Uint8Array | undefined;
	let key: CryptoKey;
	if (passphrase) {
		salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
		key = await deriveWithPassphrase(raw, passphrase, salt);
	} else {
		key = await importRaw(raw);
	}

	// Plaintext fed to GCM: a length-prefixed JSON header, then the file itself.
	const header = enc.encode(JSON.stringify({ name: file.name, type: file.type }));
	const bytes = new Uint8Array(await file.arrayBuffer());

	const plain = new Uint8Array(HEADER_LEN_BYTES + header.length + bytes.length);
	new DataView(plain.buffer).setUint32(0, header.length, false); // big-endian
	plain.set(header, HEADER_LEN_BYTES);
	plain.set(bytes, HEADER_LEN_BYTES + header.length);

	const sealed = new Uint8Array(
		await crypto.subtle.encrypt({ name: 'AES-GCM', iv: toBuf(iv) }, key, toBuf(plain))
	);

	const saltLen = salt ? salt.length : 0;
	const ciphertext = new Uint8Array(2 + saltLen + IV_BYTES + sealed.length);
	ciphertext[0] = ENVELOPE_VERSION;
	ciphertext[1] = saltLen;
	if (salt) ciphertext.set(salt, 2);
	ciphertext.set(iv, 2 + saltLen);
	ciphertext.set(sealed, 2 + saltLen + IV_BYTES);

	return {
		ciphertext,
		ciphertextBytes: ciphertext.length,
		ciphertextSha256: await sha256Base64(ciphertext),
		fragmentKey: bytesToBase64Url(raw)
	};
}

export async function decryptFile(
	ciphertext: Uint8Array,
	fragmentKey: string,
	passphrase?: string
): Promise<DecryptedFile> {
	if (ciphertext.length < 2) throw new Error('Envelope is truncated.');

	const version = ciphertext[0];
	if (version !== ENVELOPE_VERSION) throw new Error(`Unsupported envelope version ${version}.`);

	const saltLen = ciphertext[1];
	if (saltLen !== 0 && saltLen !== SALT_BYTES) throw new Error('Envelope is malformed.');

	// Smallest legal body is an empty file: 4-byte header length, a two-key JSON
	// header, and the tag. Anything shorter cannot be a whole envelope.
	const minimum = 2 + saltLen + IV_BYTES + HEADER_LEN_BYTES + TAG_BYTES;
	if (ciphertext.length < minimum) throw new Error('Envelope is truncated.');

	const salt = saltLen ? ciphertext.subarray(2, 2 + saltLen) : undefined;
	const iv = ciphertext.subarray(2 + saltLen, 2 + saltLen + IV_BYTES);
	const sealed = ciphertext.subarray(2 + saltLen + IV_BYTES);

	const raw = base64UrlToBytes(fragmentKey);
	let key: CryptoKey;
	if (salt) {
		if (!passphrase) throw new Error('passphrase required');
		key = await deriveWithPassphrase(raw, passphrase, salt);
	} else {
		key = await importRaw(raw);
	}

	// Throws on a wrong key, a wrong passphrase, or any tampering. There is no
	// path from here that returns altered content.
	const plain = new Uint8Array(
		await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toBuf(iv) }, key, toBuf(sealed))
	);

	const headerLen = new DataView(plain.buffer, plain.byteOffset).getUint32(0, false);
	if (headerLen > plain.length - HEADER_LEN_BYTES) throw new Error('Envelope is malformed.');

	const meta = JSON.parse(dec.decode(plain.subarray(HEADER_LEN_BYTES, HEADER_LEN_BYTES + headerLen)));
	return {
		bytes: plain.slice(HEADER_LEN_BYTES + headerLen),
		name: typeof meta.name === 'string' ? meta.name : 'file',
		type: typeof meta.type === 'string' ? meta.type : ''
	};
}
