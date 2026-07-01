// API Gateway HTTP API handlers. The store is injected so tests can point at
// DynamoDB Local. createNote validates and clamps; readNote burns and maps a
// missing/expired note to 410 Gone.

import { putNote, burnNote } from './store.mjs';
import { newId } from './id.mjs';

const MAX_CT = 100_000; // reject oversized ciphertext (chars)
const MAX_TTL = 604_800; // 7 days

const json = (statusCode, obj) => ({
	statusCode,
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(obj)
});

export function makeHandlers(doc) {
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

	return { createNote, readNote };
}
