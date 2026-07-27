// API Gateway HTTP API handlers. The store and the S3 port are injected so
// tests can point at DynamoDB Local and an in-memory bucket. createNote
// validates and clamps; readNote burns and maps a missing/expired note to 410
// Gone; the file handlers implement the one-delivery-attempt transfer.

import {
	putNote,
	burnNote,
	putFileGrant,
	getFileGrant,
	markFileReady,
	claimFileGrant
} from './store.mjs';
import { createHash } from 'node:crypto';
import { newId, newCapability, hashCapability, newObjectKey, capabilityMatches } from './id.mjs';

const MAX_CT = 100_000; // reject oversized ciphertext (chars)
const MAX_TTL = 604_800; // 7 days

// The retrieval Lambda returns ciphertext as one buffered response, and AWS
// caps that at 6 MB — base64, so 4 bytes on the wire for every 3 stored. The
// largest ciphertext that fits is 4,718,592 bytes; this sits well under it and
// leaves room for headers and the JSON frame. The browser's 4 MiB plaintext
// ceiling in src/lib/crypto/file-crypto.ts is the other half of this pair, and
// this is the server's independent check of it — not a mirror to be trusted.
const MAX_CIPHERTEXT_BYTES = 4 * 1024 * 1024 + 4096;

// A presigned upload is a loaded gun. Five minutes is long enough for a 4 MiB
// upload on a bad connection and short enough that a leaked URL is stale before
// anyone can use it.
const UPLOAD_WINDOW_SECONDS = 300;

// Every response this API produces is one-shot and secret-adjacent, so nothing
// it returns should ever be written to a cache — including a burned note, whose
// body IS the plaintext-bearing ciphertext.
const json = (statusCode, obj) => ({
	statusCode,
	headers: {
		'content-type': 'application/json',
		'cache-control': 'no-store, private',
		'x-content-type-options': 'nosniff',
		'referrer-policy': 'no-referrer'
	},
	body: JSON.stringify(obj)
});

// Every unavailable file answers identically, whatever the real reason: never
// existed, malformed locator, still uploading, expired, or already claimed.
// Distinguishing them would turn this endpoint into an oracle that confirms a
// link once existed.
const GONE = () => json(410, { error: 'This transfer is no longer available.' });

const isBase64Sha256 = (s) => typeof s === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(s);

export function makeHandlers(doc, s3, { onEvent = () => {} } = {}) {
	async function createNote(event) {
		let data;
		try {
			data = JSON.parse(event.body || '{}');
		} catch {
			return json(400, { error: 'bad json' });
		}

		const { ciphertext, iv, salt, ttlSeconds } = data;
		if (typeof ciphertext !== 'string' || typeof iv !== 'string') {
			return json(400, { error: 'missing ciphertext/iv' });
		}
		if (ciphertext.length > MAX_CT) return json(400, { error: 'note too large' });

		const ttl = Math.min(Math.max(Number(ttlSeconds) || 0, 1), MAX_TTL);
		const expiresAt = Math.floor(Date.now() / 1000) + ttl;
		const id = newId();
		await putNote(doc, { id, ciphertext, iv, salt, expiresAt });
		return json(201, { id });
	}

	async function readNote(event) {
		const id = event.pathParameters?.id;
		if (!id) return json(400, { error: 'missing id' });

		const note = await burnNote(doc, id, Math.floor(Date.now() / 1000));
		if (!note) return json(410, { error: 'This note has already been read or has expired.' });

		const out = { ciphertext: note.ciphertext, iv: note.iv };
		if (note.salt) out.salt = note.salt;
		return json(200, out);
	}

	// POST /files — reserve one transfer and hand back a single-use upload.
	//
	// The locator and the upload capability are independent secrets. The locator
	// is what the recipient's link carries; the upload capability never leaves
	// the sender's browser. Neither is stored in the clear.
	async function createFile(event) {
		let data;
		try {
			data = JSON.parse(event.body || '{}');
		} catch {
			return json(400, { error: 'bad json' });
		}

		const { ciphertextBytes, ciphertextSha256, ttlSeconds } = data;
		if (!Number.isInteger(ciphertextBytes) || ciphertextBytes <= 0) {
			return json(400, { error: 'missing ciphertextBytes' });
		}
		if (ciphertextBytes > MAX_CIPHERTEXT_BYTES) return json(400, { error: 'file too large' });
		if (!isBase64Sha256(ciphertextSha256)) return json(400, { error: 'missing ciphertextSha256' });

		const locator = newCapability();
		const uploadCapability = newCapability();
		const ttl = Math.min(Math.max(Number(ttlSeconds) || 0, 1), MAX_TTL);
		// Keyed into a lifetime band so a short transfer's bytes are swept the
		// next day rather than sitting for the flat maximum.
		const objectKey = newObjectKey(ttl);

		const createdAt = Math.floor(Date.now() / 1000);

		// The upload authorization is signed against this exact key, length, and
		// checksum, so S3 itself refuses a substituted or resized body. Finalize
		// then re-verifies against the stored object, because a constraint on what
		// S3 will accept is not evidence of what S3 actually holds.
		const upload = await s3.presignPut({
			key: objectKey,
			bytes: ciphertextBytes,
			sha256: ciphertextSha256,
			expiresIn: UPLOAD_WINDOW_SECONDS
		});

		await putFileGrant(doc, {
			pk: hashCapability(locator),
			objectKey,
			uploadCapabilityHash: hashCapability(uploadCapability),
			ciphertextBytes,
			ciphertextSha256,
			createdAt,
			expiresAt: createdAt + ttl
		});

		return json(201, { locator, uploadCapability, upload });
	}

	// POST /files/finalize — the server looks at S3 itself and decides.
	async function finalizeFile(event) {
		let data;
		try {
			data = JSON.parse(event.body || '{}');
		} catch {
			return json(400, { error: 'bad json' });
		}

		const { locator, uploadCapability } = data;
		if (typeof locator !== 'string' || typeof uploadCapability !== 'string') {
			return json(400, { error: 'missing capability' });
		}

		const pk = hashCapability(locator);
		const grant = await getFileGrant(doc, pk);
		// Reading the grant only answers "which object key did we authorize?".
		// Nothing is decided here — the conditional write at the bottom is the
		// only thing that grants readiness, and it re-checks every fact.
		if (!grant) return GONE();

		// Reject a wrong capability BEFORE touching S3. This is not the security
		// boundary — the conditional write below is — but it is load-bearing for
		// a different reason: an unknown locator costs one DynamoDB round trip
		// and a known one used to cost two, which made response time a reliable
		// oracle for "this link still exists". Measured at ~72 ms of separation
		// with non-overlapping distributions, enough to poll for the moment a
		// recipient opens a transfer. Now both paths cost exactly one trip.
		if (!capabilityMatches(hashCapability(uploadCapability), grant.uploadCapabilityHash)) {
			return GONE();
		}

		// `attributes` asks S3 for size and checksum rather than the body. Note
		// that this does NOT make the finalize role unable to read ciphertext —
		// AWS requires s3:GetObject alongside s3:GetObjectAttributes, so the
		// permission comes along whether we want it or not. The narrowing that
		// is real: finalize holds no delete and no list.
		const stored = await s3.attributes({ key: grant.objectKey });
		if (!stored) return GONE();
		if (stored.contentLength !== grant.ciphertextBytes) return GONE();
		if (stored.checksumSha256 !== grant.ciphertextSha256) return GONE();

		const ok = await markFileReady(doc, {
			pk,
			uploadCapabilityHash: hashCapability(uploadCapability),
			objectKey: grant.objectKey,
			ciphertextBytes: grant.ciphertextBytes,
			ciphertextSha256: grant.ciphertextSha256,
			nowEpoch: Math.floor(Date.now() / 1000)
		});
		if (!ok) return GONE();

		return json(200, { state: 'ready' });
	}

	// POST /files/claim — the one delivery attempt.
	//
	// The order below is the entire promise, and it is enforced by the shape of
	// the transport, not by discipline: this is a buffered Lambda proxy
	// integration, so the response object does not exist until every line above
	// it has run, and API Gateway cannot send a byte of a response it has not
	// received. Nothing here can flush early even if someone later reorders it
	// carelessly — the return statement is the only exit.
	//
	// Every failure after the claim is permanent and deliberate. The grant is
	// already deleted; we never put it back. A transfer that dies here is gone,
	// which is exactly what the link promised.
	async function claimFile(event) {
		let data;
		try {
			data = JSON.parse(event.body || '{}');
		} catch {
			return json(400, { error: 'bad json' });
		}

		const { locator } = data;
		if (typeof locator !== 'string' || !locator) return GONE();

		const grant = await claimFileGrant(doc, hashCapability(locator), Math.floor(Date.now() / 1000));
		if (!grant) return GONE();
		onEvent('claim');

		const ciphertext = await s3.get({ key: grant.objectKey });
		onEvent('s3-open');

		await s3.delete({ key: grant.objectKey });
		onEvent('s3-delete');

		const after = await s3.head({ key: grant.objectKey });
		if (after) throw new Error('stored copy still present after delete');
		onEvent('s3-head-404');

		// Deliver only what was finalized. The grant carries the exact length and
		// checksum the server verified at finalize time, and until now the claim
		// path fetched the object and returned it without ever looking at either.
		// Anyone who could write to the bucket between finalize and claim could
		// therefore spend a recipient's single delivery attempt on bytes the
		// server had the evidence to reject. AES-GCM means they get a decryption
		// failure rather than forged content — but a decryption failure is
		// indistinguishable from a wrong passphrase, and the transfer is gone
		// either way. Refusing here is the difference between "something was
		// tampered with" and "your file silently didn't work."
		if (
			ciphertext.length !== grant.ciphertextBytes ||
			createHash('sha256').update(ciphertext).digest('base64') !== grant.ciphertextSha256
		) {
			throw new Error('stored ciphertext does not match the finalized transfer');
		}

		// First moment any response byte exists anywhere in this process.
		onEvent('response-first-byte');
		return {
			statusCode: 200,
			headers: {
				'content-type': 'application/octet-stream',
				'cache-control': 'no-store, private',
				'x-content-type-options': 'nosniff',
				'referrer-policy': 'no-referrer'
			},
			isBase64Encoded: true,
			body: Buffer.from(ciphertext).toString('base64')
		};
	}

	return { createNote, readNote, createFile, finalizeFile, claimFile };
}
