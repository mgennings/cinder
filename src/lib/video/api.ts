// Thin client for the video API (docs/video-api-contract.md). Every capability
// travels in the request BODY, never a path, query string, or header — same
// rule and same reason as the file API. No call here carries identity: the
// transfer API's CORS allows only content-type, and what the caller presents
// says what they may do, not who they are.

import type { UploadGrant } from '../api';

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

// The contract's one sentence for every unavailable video: never existed,
// still uploading, expired, destroyed, or past deadline — indistinguishably.
export class VideoGoneError extends Error {
	constructor() {
		super('This video is no longer available.');
		this.name = 'VideoGoneError';
	}
}

// The gate said no at create: out of credits, never bought any, or anonymous —
// indistinguishable on purpose. About the account, never the bytes.
export class VideoNotEntitledError extends Error {
	constructor() {
		super('Sending a video needs Cinder credits.');
		this.name = 'VideoNotEntitledError';
	}
}

// 402 on extend. The UI's answer is the design doc's copy — open doors, never
// a checkout wall — so the error carries no imperative of its own.
export class VideoExtensionUnfundedError extends Error {
	constructor() {
		super('No prepaid extensions remain and no grant was presented.');
		this.name = 'VideoExtensionUnfundedError';
	}
}

// 403 on extend: the extension count or the 128-minute session cap is reached.
// This video has all the time it can be given.
export class VideoExtensionCapError extends Error {
	constructor() {
		super('This video has all the time it can be given.');
		this.name = 'VideoExtensionCapError';
	}
}

export type VideoSegmentDigest = { ciphertextBytes: number; ciphertextSha256: string };
export type VideoSegmentGrant = { index: number; upload: UploadGrant };
export type VideoCreateGrant = {
	locator: string;
	uploadCapability: string;
	statusToken: string;
	segments: VideoSegmentGrant[];
};

/** POST /videos. Always paid — there is no free video shape. */
export async function createVideo(
	segments: VideoSegmentDigest[],
	ttlSeconds: number,
	capabilityGrant: string
): Promise<VideoCreateGrant> {
	const res = await fetch(`${API_BASE}/videos`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ segments, ttlSeconds, capabilityGrant })
	});
	if (res.status === 402 || res.status === 403) throw new VideoNotEntitledError();
	if (!res.ok) throw new Error(`create failed: ${res.status}`);
	return res.json();
}

/**
 * POST /videos/finalize — one call per segment (derived locator), then one
 * with the transfer locator to seal the whole video. Idempotent on identical
 * facts, which is exactly what makes the upload resumable: a confirmed
 * segment answers 200 again.
 */
export async function finalizeVideo(locator: string, uploadCapability: string): Promise<void> {
	const res = await fetch(`${API_BASE}/videos/finalize`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ locator, uploadCapability })
	});
	if (res.status === 410) throw new VideoGoneError();
	if (!res.ok) throw new Error(`finalize failed: ${res.status}`);
}

export type VideoSession = {
	deadlineEpoch: number;
	segments: number;
	finished: boolean;
	prepaidRemaining: number;
	extensionsUsed: number;
};

/**
 * POST /videos/claim. Opens the watch window — or resumes it: reopening the
 * link inside the window returns the same shape, so the client cannot tell
 * first from resumed and does not need to.
 */
export async function claimVideo(locator: string): Promise<VideoSession> {
	const res = await fetch(`${API_BASE}/videos/claim`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ locator })
	});
	if (res.status === 410) throw new VideoGoneError();
	if (!res.ok) throw new Error(`claim failed: ${res.status}`);
	return res.json();
}

/** POST /videos/segment-url. Reissue freely while the session is open. */
export async function issueSegmentUrl(
	locator: string,
	index: number
): Promise<{ url: string; expiresIn: number }> {
	const res = await fetch(`${API_BASE}/videos/segment-url`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ locator, index })
	});
	if (res.status === 410) throw new VideoGoneError();
	if (!res.ok) throw new Error(`segment-url failed: ${res.status}`);
	return res.json();
}

/** The presigned GET itself. Ciphertext only, useless without the fragment. */
export async function fetchSegmentCiphertext(url: string): Promise<Uint8Array> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`segment fetch failed: ${res.status}`);
	return new Uint8Array(await res.arrayBuffer());
}

/**
 * POST /videos/finished. The server only ever SHORTENS the deadline, so a
 * forged or repeated report cannot buy time. Returns the real deadline the
 * countdown renders.
 */
export async function reportVideoFinished(locator: string): Promise<{ deadlineEpoch: number }> {
	const res = await fetch(`${API_BASE}/videos/finished`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ locator })
	});
	if (res.status === 410) throw new VideoGoneError();
	if (!res.ok) throw new Error(`finished failed: ${res.status}`);
	return res.json();
}

export type VideoExtendResult = {
	deadlineEpoch: number;
	prepaidRemaining: number;
	extensionsUsed: number;
};

/**
 * POST /videos/extend. Either side may call it — holding the locator is the
 * authorization, so extending identifies nobody. Prepaid is spent first;
 * otherwise the grant funds it.
 */
export async function extendVideo(
	locator: string,
	capabilityGrant?: string
): Promise<VideoExtendResult> {
	const res = await fetch(`${API_BASE}/videos/extend`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ locator, ...(capabilityGrant ? { capabilityGrant } : {}) })
	});
	if (res.status === 402) throw new VideoExtensionUnfundedError();
	if (res.status === 403) throw new VideoExtensionCapError();
	if (res.status === 410) throw new VideoGoneError();
	if (!res.ok) throw new Error(`extend failed: ${res.status}`);
	return res.json();
}

/**
 * POST /videos/status, sender-side only. Two words, on purpose: 'waiting'
 * while sealed, unclaimed, and unexpired; everything else is 'gone',
 * indistinguishably. Infrastructure failure throws so the caller never
 * fabricates a gone state.
 */
export async function checkVideoStatus(statusToken: string): Promise<'waiting' | 'gone'> {
	const res = await fetch(`${API_BASE}/videos/status`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ statusToken })
	});
	if (!res.ok) throw new Error(`status failed: ${res.status}`);
	const status = (await res.json()).status;
	if (status !== 'waiting' && status !== 'gone') throw new Error('status failed: bad response');
	return status;
}

/**
 * POST /videos/destroy — the recipient declining at the gate ({ locator }) or
 * the sender regretting the send ({ statusToken }). Works only while
 * unclaimed; answers 200 {} unconditionally so it is never an oracle and a
 * repeated tap is safe.
 */
export async function destroyVideo(
	credential: { locator: string } | { statusToken: string }
): Promise<void> {
	const res = await fetch(`${API_BASE}/videos/destroy`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(credential)
	});
	if (!res.ok) throw new Error(`destroy failed: ${res.status}`);
}
