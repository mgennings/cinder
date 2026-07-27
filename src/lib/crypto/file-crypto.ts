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
