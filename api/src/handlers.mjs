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
import {
	newId,
	newCapability,
	hashCapability,
	newObjectKey,
	capabilityMatches,
	deriveChunkLocator
} from './id.mjs';
import { CAPABILITY, denyAll, checkCapability } from './capabilities.mjs';

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

// A multipart transfer cannot upload 64 parts inside one part's window, so the
// window scales with the work. That is safe for a specific reason rather than a
// hopeful one: every presigned PUT is signed against an exact key, an exact
// length, AND an exact SHA-256 (see the `unhoistableHeaders` note in
// lambda.mjs). A leaked URL therefore authorizes writing precisely the bytes it
// was already going to receive, to a key nobody else can guess. Time buys an
// attacker nothing that content-pinning has not already taken away.
const UPLOAD_WINDOW_CEILING_SECONDS = 3600;
const uploadWindowFor = (partCount) =>
	Math.min(UPLOAD_WINDOW_SECONDS * partCount, UPLOAD_WINDOW_CEILING_SECONDS);

// The transport's own ceiling on parts, independent of whatever an entitlement
// provider is willing to grant. The effective limit is the smaller of the two,
// so a bug or a generous plan in the payments lane cannot raise this.
//
// 64 is memory-bound, not transport-bound, and it is the one number here that
// is a judgment rather than a derivation. A recipient reassembles every part in
// one browser tab before anything is written to disk, so the ceiling is really
// "how much can a phone hold without the tab being killed mid-delivery" — and a
// tab killed mid-delivery is a permanently destroyed file, not an inconvenience.
// 64 × 4 MiB = 256 MiB, which also happens to clear the 200 MB that response
// streaming would have bought at the cost of the structural guarantee.
const MAX_PARTS = 64;

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

// One part's declared shape, validated exactly as a single file's is. Returns
// null for anything malformed so the caller can refuse the whole request — a
// transfer with one bad part is a bad transfer, not a shorter one.
function readPart(p) {
	if (!p || typeof p !== 'object') return null;
	const { ciphertextBytes, ciphertextSha256 } = p;
	if (!Number.isInteger(ciphertextBytes) || ciphertextBytes <= 0) return null;
	if (ciphertextBytes > MAX_CIPHERTEXT_BYTES) return null;
	if (!isBase64Sha256(ciphertextSha256)) return null;
	return { ciphertextBytes, ciphertextSha256 };
}

export function makeHandlers(doc, s3, { onEvent = () => {}, capabilities = denyAll } = {}) {
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

	// POST /files — reserve one transfer and hand back its single-use uploads.
	//
	// The locator and the upload capability are independent secrets. The locator
	// is what the recipient's link carries; the upload capability never leaves
	// the sender's browser. Neither is stored in the clear.
	//
	// A transfer is one part or many. A many-part transfer is NOT a second
	// protocol — it is N of the identical grant below, each with its own object
	// key, its own finalize, and its own atomic claim. The per-object promise is
	// not re-derived at a larger size; it is the same rows in the same table hit
	// by the same conditional writes, which is the only form of "identical" worth
	// claiming. What multipart adds is size. It subtracts nothing.
	async function createFile(event) {
		let data;
		try {
			data = JSON.parse(event.body || '{}');
		} catch {
			return json(400, { error: 'bad json' });
		}

		const { ciphertextBytes, ciphertextSha256, parts, ttlSeconds, capabilityGrant } = data;

		// Two request shapes, one internal representation. The single-file shape
		// is kept verbatim rather than folded into `parts`, because every link
		// already in the wild was created with it and a shipped protocol is not a
		// thing to tidy.
		// Which shape was used decides how locators are derived, NOT how many
		// parts arrived. A one-element `parts` array is still the multipart
		// protocol, so its single part still lives at index 0's derived locator —
		// otherwise the client and server would disagree about where it is.
		const multipart = parts !== undefined;

		let declared;
		if (!multipart) {
			const only = readPart({ ciphertextBytes, ciphertextSha256 });
			if (!only) {
				if (!Number.isInteger(ciphertextBytes) || ciphertextBytes <= 0) {
					return json(400, { error: 'missing ciphertextBytes' });
				}
				if (ciphertextBytes > MAX_CIPHERTEXT_BYTES) return json(400, { error: 'file too large' });
				return json(400, { error: 'missing ciphertextSha256' });
			}
			declared = [only];
		} else {
			if (!Array.isArray(parts) || parts.length === 0) return json(400, { error: 'bad parts' });
			if (parts.length > MAX_PARTS) return json(400, { error: 'too many parts' });
			declared = parts.map(readPart);
			if (declared.some((p) => p === null)) return json(400, { error: 'bad parts' });
		}

		// The gate, and the reason it sits here rather than at the top: a
		// single-part transfer is the free capability and must cost no entitlement
		// round trip at all. Only asking for more asks anyone for permission.
		if (declared.length > 1) {
			// The grant comes out of the BODY, never a header. Cinder's transfer API
			// allows only `content-type` at CORS precisely so an account token
			// cannot ride along with a transfer and make the two linkable.
			const { granted, limit } = await checkCapability(
				capabilities,
				capabilityGrant,
				CAPABILITY.MULTIPART_TRANSFER,
				'maxParts'
			);
			// 402 rather than 403: nothing about the caller is wrong, the
			// capability simply is not theirs yet. It carries no locator and no
			// grant, so it reveals nothing beyond what the request already said.
			if (!granted) return json(402, { error: 'A transfer of more than one part requires Cinder Pro.' });
			// The transport's ceiling wins whenever it is lower. A generous plan,
			// or a bug in the provider, cannot raise a limit this file owns.
			if (declared.length > Math.min(limit, MAX_PARTS)) {
				return json(403, { error: 'This transfer has more parts than your plan allows.' });
			}
		}

		const locator = newCapability();
		const uploadCapability = newCapability();
		const ttl = Math.min(Math.max(Number(ttlSeconds) || 0, 1), MAX_TTL);
		const createdAt = Math.floor(Date.now() / 1000);
		const expiresIn = uploadWindowFor(declared.length);

		// Every part is an ordinary grant. The only thing tying them together is
		// that the recipient's browser can derive each part's locator from the one
		// in their link — the server stores nothing that says "these belong to the
		// same file" beyond having written them in the same second.
		const grants = await Promise.all(
			declared.map(async (part, index) => {
				// Keyed into a lifetime band so a short transfer's bytes are swept
				// the next day rather than sitting for the flat maximum.
				const objectKey = newObjectKey(ttl);

				// The upload authorization is signed against this exact key, length,
				// and checksum, so S3 itself refuses a substituted or resized body.
				// Finalize then re-verifies against the stored object, because a
				// constraint on what S3 will accept is not evidence of what S3
				// actually holds.
				const upload = await s3.presignPut({
					key: objectKey,
					bytes: part.ciphertextBytes,
					sha256: part.ciphertextSha256,
					expiresIn
				});

				await putFileGrant(doc, {
					pk: hashCapability(multipart ? deriveChunkLocator(locator, index) : locator),
					objectKey,
					uploadCapabilityHash: hashCapability(uploadCapability),
					ciphertextBytes: part.ciphertextBytes,
					ciphertextSha256: part.ciphertextSha256,
					createdAt,
					expiresAt: createdAt + ttl
				});

				return { index, upload };
			})
		);

		// The single-part response shape is unchanged, to the byte.
		if (!multipart) {
			return json(201, { locator, uploadCapability, upload: grants[0].upload });
		}
		return json(201, { locator, uploadCapability, parts: grants });
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
