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
		throw new DeliveryFailedError();
	}

	if (res.status === 410) throw new TransferGoneError();
	if (!res.ok) throw new DeliveryFailedError();

	try {
		return new Uint8Array(await res.arrayBuffer());
	} catch {
		// Connection died partway through the body. The stored copy is already
		// gone; there is nothing to go back for.
		throw new DeliveryFailedError();
	}
}
