// Note-link helpers. The fragment (everything after `#`) holds the decryption
// key and is never sent to the server — keep it out of query strings and logs.

import { bytesToBase64Url } from './crypto/codec';

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
	// The encoding is the crypto layer's, not a second hand-rolled copy of it:
	// this string has to match a Node digest byte for byte, and two independent
	// implementations of the same alphabet is exactly how that stops being true.
	return bytesToBase64Url(new Uint8Array(digest));
}

// A video link always carries its segment count, even at 1: the watch gate has
// to state what claiming costs to download BEFORE anything is claimed, and
// asking the server would be a request on link arrival — the preview-bot
// defense forbids exactly that. Same reasoning as buildTransferLink; the count
// stays a hint until segment zero's authenticated header confirms it.
export function buildVideoLink(
	origin: string,
	locator: string,
	fragmentKey: string,
	segments: number
): string {
	return `${origin}/v/${locator}#${fragmentKey}.${segments}`;
}

// Video segment locators are the SAME derivation, by design rather than by
// coincidence: docs/ephemeral-video-design.md says video reuses the part
// derivation instead of inventing a third one, so this is a name, not a new
// recipe. It must stay byte-identical to deriveSegmentLocator in
// api/src/id.mjs (itself an alias of deriveChunkLocator). The parity test in
// link.test.ts pins this export against Node-produced constants, so replacing
// the alias with a drifted reimplementation goes red instead of quietly
// answering 410 for every segment.
export const deriveSegmentLocator = derivePartLocator;
