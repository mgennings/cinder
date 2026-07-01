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
