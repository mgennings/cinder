// Note-link helpers. The fragment (everything after `#`) holds the decryption
// key and is never sent to the server — keep it out of query strings and logs.

export function buildLink(origin: string, id: string, fragmentKey: string): string {
	return `${origin}/n/${id}#${fragmentKey}`;
}

// Files live on their own route. The reader page has to know which protocol to
// speak before it fetches anything, and asking the server would mean a request
// on link arrival — the exact thing the preview-bot defense forbids. The path
// carries the kind; the fragment carries the key.
export function buildFileLink(origin: string, locator: string, fragmentKey: string): string {
	return `${origin}/f/${locator}#${fragmentKey}`;
}

export function parseFragmentKey(hash: string): string {
	return hash.startsWith('#') ? hash.slice(1) : hash;
}
