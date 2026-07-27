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
	return (hash.startsWith('#') ? hash.slice(1) : hash).split('.')[0];
}

// --- multipart transfers ---------------------------------------------------
//
// A large file is N transfers sharing one link. The fragment carries the key and
// the part count; the path still carries a single locator, and the browser
// derives each part's locator from it. Two consequences worth being explicit
// about:
//
//   1. The link stays short. Carrying 64 capabilities in the fragment would
//      produce a 2.8 KB URL that chat clients truncate, and a truncated Cinder
//      link is a destroyed file.
//   2. The part count reaches the recipient without a request. The reveal gate
//      has to state the cost BEFORE anything is claimed, and asking the server
//      how many parts there are would be a request on link arrival — exactly
//      what the preview-bot defense forbids.
//
// The count is a hint, not an authority. Part zero's decrypted header carries
// the authenticated count, and the reader refuses if the two disagree.
export function buildTransferLink(
	origin: string,
	locator: string,
	fragmentKey: string,
	partCount: number
): string {
	return partCount > 1
		? `${origin}/f/${locator}#${fragmentKey}.${partCount}`
		: buildFileLink(origin, locator, fragmentKey);
}

export function parseFragmentParts(hash: string): number {
	const raw = (hash.startsWith('#') ? hash.slice(1) : hash).split('.')[1];
	const n = Number(raw);
	return Number.isInteger(n) && n > 1 ? n : 1;
}

// Must stay byte-identical to deriveChunkLocator in api/src/id.mjs. If these
// two ever disagree the client asks for locators that do not exist and every
// part answers 410 — a whole transfer lost to a string literal.
export async function derivePartLocator(locator: string, index: number): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(`${locator}:part:${index}`)
	);
	// base64url, unpadded — Node's `digest('base64url')` produces exactly this.
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}
