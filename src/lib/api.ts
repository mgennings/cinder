// Thin client for the blip API. Maps between the crypto layer's payload shape
// ({ ct, iv, salt }) and the server's DynamoDB attribute names
// ({ ciphertext, iv, salt }) at this boundary, so neither side leaks into the
// other.

import type { EncryptedPayload } from './crypto/note-crypto';

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

export class NoteGoneError extends Error {
	constructor() {
		super('This note has already been read or has expired.');
		this.name = 'NoteGoneError';
	}
}

export async function createNote(payload: EncryptedPayload, ttlSeconds: number): Promise<string> {
	const body = {
		ciphertext: payload.ct,
		iv: payload.iv,
		...(payload.salt ? { salt: payload.salt } : {}),
		ttlSeconds
	};
	const res = await fetch(`${API_BASE}/notes`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	if (!res.ok) throw new Error(`create failed: ${res.status}`);
	return (await res.json()).id as string;
}

export async function burnNote(id: string): Promise<EncryptedPayload> {
	const res = await fetch(`${API_BASE}/notes/${id}/burn`, { method: 'POST' });
	if (res.status === 410) throw new NoteGoneError();
	if (!res.ok) throw new Error(`read failed: ${res.status}`);
	const raw = (await res.json()) as { ciphertext: string; iv: string; salt?: string };
	return { ct: raw.ciphertext, iv: raw.iv, ...(raw.salt ? { salt: raw.salt } : {}) };
}

// --- file transfer ---------------------------------------------------------

export class TransferGoneError extends Error {
	constructor() {
		super('This transfer is no longer available.');
		this.name = 'TransferGoneError';
	}
}

// Raised only after the claim succeeded, which means the transfer is spent.
// The UI must never offer a retry for this one — there is nothing to retry.
export class DeliveryFailedError extends Error {
	constructor() {
		super('The delivery began but could not finish.');
		this.name = 'DeliveryFailedError';
	}
}

// Cinder refused to start. This is the ONLY recoverable failure in the whole
// product, and telling it apart from DeliveryFailedError is the difference
// between "try again in a moment" and "your file is gone forever."
//
// It exists because the two were conflated: every non-410 refusal used to
// render as permanent destruction. Under load that is a lie — a throttled or
// shed request never reaches the Lambda, so the atomic claim never runs and the
// stored copy is untouched. Reserved concurrency makes shedding MORE likely,
// which made the lie more frequent rather than less.
export class TransferBusyError extends Error {
	constructor() {
		super('Cinder could not start the delivery. Nothing was consumed.');
		this.name = 'TransferBusyError';
	}
}

export type UploadGrant = { url: string; headers: Record<string, string> };
export type TransferGrant = {
	locator: string;
	uploadCapability: string;
	upload: UploadGrant;
};

export async function createFileTransfer(
	ciphertextBytes: number,
	ciphertextSha256: string,
	ttlSeconds: number
): Promise<TransferGrant> {
	const res = await fetch(`${API_BASE}/files`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ ciphertextBytes, ciphertextSha256, ttlSeconds })
	});
	if (!res.ok) throw new Error(`create failed: ${res.status}`);
	return res.json();
}

// The capability gate said no. This is the only failure in the sender journey
// that is about the account rather than the bytes, and it must never render as
// a technical error — nothing is broken, the transfer is simply larger than
// what this caller may send.
export class TransferNotEntitledError extends Error {
	constructor(readonly parts: number) {
		super('A transfer this size needs Cinder Pro.');
		this.name = 'TransferNotEntitledError';
	}
}

export type TransferPartGrant = { index: number; upload: UploadGrant };
export type MultipartGrant = {
	locator: string;
	uploadCapability: string;
	parts: TransferPartGrant[];
};

// Reserves N parts in one request. Every part is an independent grant on the
// server with its own object key and its own atomic claim — this call is a
// convenience for the sender, not a new kind of transfer.
export async function createMultipartTransfer(
	parts: { ciphertextBytes: number; ciphertextSha256: string }[],
	ttlSeconds: number,
	capabilityGrant: string | null
): Promise<MultipartGrant> {
	// The grant rides in the BODY and there is no Authorization header, because
	// this API allows only `content-type` at CORS. That is deliberate: an account
	// must never be linkable to a transfer, so what the sender presents says what
	// they may do, not who they are.
	const res = await fetch(`${API_BASE}/files`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ parts, ttlSeconds, ...(capabilityGrant ? { capabilityGrant } : {}) })
	});
	// 402 is the gate, 403 is the plan's own ceiling. Both mean the same thing
	// to the person: this file is bigger than what you may send right now.
	if (res.status === 402 || res.status === 403) throw new TransferNotEntitledError(parts.length);
	if (!res.ok) throw new Error(`create failed: ${res.status}`);
	return res.json();
}

// XHR rather than fetch: it is still the only way to observe upload progress,
// and a 4 MiB upload on cellular is long enough that an indeterminate spinner
// would read as a hang. `signal` lets the sender cancel before finalize, which
// is the last moment cancelling is meaningful.
export function uploadCiphertext(
	grant: UploadGrant,
	ciphertext: Uint8Array,
	{ onProgress, signal }: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}
): Promise<void> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open('PUT', grant.url, true);
		for (const [k, v] of Object.entries(grant.headers)) {
			// content-length is set by the browser and rejected as unsafe here.
			if (k.toLowerCase() === 'content-length') continue;
			xhr.setRequestHeader(k, v);
		}

		xhr.upload.onprogress = (e) => {
			if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
		};
		xhr.onload = () =>
			xhr.status >= 200 && xhr.status < 300
				? resolve()
				: reject(new Error(`upload failed: ${xhr.status}`));
		xhr.onerror = () => reject(new Error('upload failed'));
		xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'));

		signal?.addEventListener('abort', () => xhr.abort(), { once: true });
		// Same TypeScript generic fight as toBuf() in note-crypto: Uint8Array's
		// ArrayBufferLike parameter admits SharedArrayBuffer, which the DOM body
		// types exclude. The value is a plain ArrayBufferView at runtime.
		xhr.send(ciphertext as unknown as XMLHttpRequestBodyInit);
	});
}

export async function finalizeFileTransfer(
	locator: string,
	uploadCapability: string
): Promise<void> {
	const res = await fetch(`${API_BASE}/files/finalize`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ locator, uploadCapability })
	});
	if (res.status === 410) throw new TransferGoneError();
	if (!res.ok) throw new Error(`finalize failed: ${res.status}`);
}

// The one delivery attempt. A 410 here means it was never available to us; any
// other failure means the claim already happened on the server and the transfer
// is permanently spent.
export async function claimFile(locator: string): Promise<Uint8Array> {
	let res: Response;
	try {
		res = await fetch(`${API_BASE}/files/claim`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ locator })
		});
	} catch {
		// No response at all. Genuinely ambiguous — the request may never have
		// left, or it may have run and died on the way back. Treated as busy
		// rather than lost ON PURPOSE: if it really was consumed, trying again
		// returns 410 and tells the truth, whereas guessing "destroyed" when it
		// wasn't makes someone abandon a file that is still there. The kinder
		// wrong answer is also the self-correcting one.
		throw new TransferBusyError();
	}

	if (res.status === 410) throw new TransferGoneError();

	// Refused before the handler ever ran. A gateway 502/503/504 and a 429 are
	// produced by API Gateway or by Lambda's concurrency ceiling; in every one
	// of those cases the function was never invoked, so the atomic claim never
	// executed and the stored copy is untouched. Measured under a 200-request
	// burst: 189 × 503, Throttles 286, Invocations 27, Errors 0 — a shed request
	// does not enter the function at all.
	if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
		throw new TransferBusyError();
	}

	// Anything else — notably a 500 — means the handler DID run and threw, which
	// can be after the claim. That one really is spent.
	if (!res.ok) throw new DeliveryFailedError();

	try {
		return new Uint8Array(await res.arrayBuffer());
	} catch {
		// A 200 arrived, so the claim provably succeeded and the stored copy is
		// already deleted. The body died on the way. Nothing to go back for.
		throw new DeliveryFailedError();
	}
}
