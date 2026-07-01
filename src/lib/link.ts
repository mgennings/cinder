// Note-link helpers. The fragment (everything after `#`) holds the decryption
// key and is never sent to the server — keep it out of query strings and logs.

export function buildLink(origin: string, id: string, fragmentKey: string): string {
	return `${origin}/n/${id}#${fragmentKey}`;
}

export function parseFragmentKey(hash: string): string {
	return hash.startsWith('#') ? hash.slice(1) : hash;
}
