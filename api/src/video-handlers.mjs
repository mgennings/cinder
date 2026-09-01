// The ephemeral-video endpoints. docs/video-api-contract.md is the wire
// contract; docs/ephemeral-video-design.md is the promise. Video is a third
// artifact: nothing here touches the note or file handlers, and no code path
// is shared with the one-delivery-attempt claim.
//
// The one deliberate departure from the file path is the presigned GET for
// segment ciphertext, and its boundary is structural: video objects live under
// their own `v/` key prefix, and only the segment-url role's s3:GetObject is
// scoped to `v/*` (template.yaml). A role that cannot name a file object
// cannot sign a GET for one.
//
// The availability guarantee is the AT-READ GUARD: every segment-url, finished,
// and extend call checks `deadlineEpoch > now` inside the same read or write it
// rides on, so availability ends exactly on time whether or not physical
// deletion has run yet. The scheduled burn and the lifecycle rule are the
// physical layers underneath, stated in that order everywhere.

import {
	putVideoSession,
	getVideoSession,
	sealVideoSession,
	openVideoSession,
	shortenDeadline,
	applyExtension,
	destroyUnclaimedVideo,
	deleteVideoSessionAtDeadline,
	putVideoSegment,
	getVideoSegment,
	markVideoSegmentReady,
	liftVideoSegmentExpiry,
	deleteVideoSegment
} from './video-store.mjs';
import {
	newCapability,
	hashCapability,
	newObjectKey,
	capabilityMatches,
	deriveSegmentLocator
} from './id.mjs';
import { CAPABILITY, denyAll, checkCapability } from './capabilities.mjs';
import { json } from './http.mjs';

// The numbers, in seconds where the server touches them. All on the
// powers-of-two ladder, fixed by the design doc and mirrored in
// src/lib/video/types.ts — changed in all three places or not at all.
const MAX_TTL = 604_800; // 7 days, pre-claim only
const MAX_SEGMENTS = 128; // × 4 MiB = the 512 MiB ceiling
const WATCH_WINDOW_SECONDS = 3840; // 64 minutes from claim
const FINISHED_COUNTDOWN_SECONDS = 480; // 8 minutes
const EXTENSION_SECONDS = 480; // 8 minutes per extension
const MAX_EXTENSIONS = 8;
const SESSION_CAP_SECONDS = 7680; // 128 minutes from claim, absolute
const SEGMENT_URL_SECONDS = 480; // presigned GET validity ceiling

// Same per-object ceiling as a file part, checked independently here — the
// browser's mirror of it is not to be trusted.
const MAX_CIPHERTEXT_BYTES = 4 * 1024 * 1024 + 4096;

// Same presigned-PUT window reasoning as the file path: every upload is pinned
// to an exact key, length, and SHA-256, so time buys an attacker nothing that
// content-pinning has not already taken away.
const UPLOAD_WINDOW_SECONDS = 300;
const UPLOAD_WINDOW_CEILING_SECONDS = 3600;
const uploadWindowFor = (segmentCount) =>
	Math.min(UPLOAD_WINDOW_SECONDS * segmentCount, UPLOAD_WINDOW_CEILING_SECONDS);

// The TTL written at claim. The row must outlive the longest possible session
// (128 minutes) so a crashed burn is still swept by DynamoDB TTL; 8192 is the
// next rung above the 7680-second cap. Availability is never governed by this
// number — the at-read guard on deadlineEpoch is the guarantee.
const SWEEP_SLACK_SECONDS = 8192;

// Every unavailable video answers identically, whatever the real reason:
// never existed, still uploading, expired unclaimed, destroyed, or the window
// has ended. Same rule as files, its own sentence.
const GONE = () => json(410, { error: 'This video is no longer available.' });

const isBase64Sha256 = (s) => typeof s === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(s);
const noStatusTokens = { mint: () => null, verify: () => null };
// The default burn scheduler: nothing. The at-read guard and the lifecycle
// rule still hold without one; production wires EventBridge Scheduler in
// video-lambda.mjs and the dev API wires a timer.
const noScheduler = { arm: async () => {} };

// One segment's declared shape, validated exactly as a file part is. A video
// with one bad segment is a bad request, not a shorter video.
function readSegment(p) {
	if (!p || typeof p !== 'object') return null;
	const { ciphertextBytes, ciphertextSha256 } = p;
	if (!Number.isInteger(ciphertextBytes) || ciphertextBytes <= 0) return null;
	if (ciphertextBytes > MAX_CIPHERTEXT_BYTES) return null;
	if (!isBase64Sha256(ciphertextSha256)) return null;
	return { ciphertextBytes, ciphertextSha256 };
}

const nowEpoch = () => Math.floor(Date.now() / 1000);

export function makeVideoHandlers(
	doc,
	s3,
	{ capabilities = denyAll, statusTokens = noStatusTokens, scheduler = noScheduler } = {}
) {
	const segmentPksFor = (locator, count) =>
		Array.from({ length: count }, (_, i) => hashCapability(deriveSegmentLocator(locator, i)));

	// Re-arm is best-effort where the write it follows already succeeded: the
	// at-read guard has the availability promise, and a schedule that fires at
	// a stale time either burns correctly (deadline passed) or self-heals (the
	// burn handler re-arms itself at the row's live deadline).
	async function rearm(locator, pk, segments, atEpoch) {
		try {
			await scheduler.arm({ pk, segmentPks: segmentPksFor(locator, segments), atEpoch });
		} catch {
			// The lifecycle rule is the stated physical backstop.
		}
	}

	// POST /videos — reserve the session and hand back one presigned PUT per
	// segment. Always paid: unlike /files there is no free single-segment shape.
	async function createVideo(event) {
		let data;
		try {
			data = JSON.parse(event.body || '{}');
		} catch {
			return json(400, { error: 'bad json' });
		}

		const { segments, ttlSeconds, capabilityGrant } = data;
		if (!Array.isArray(segments) || segments.length === 0) {
			return json(400, { error: 'bad segments' });
		}
		if (segments.length > MAX_SEGMENTS) return json(400, { error: 'too many segments' });
		const declared = segments.map(readSegment);
		if (declared.some((s) => s === null)) return json(400, { error: 'bad segments' });

		// The gate. The grant travels in the BODY, never a header — the transfer
		// API's CORS allows only content-type, so an account token cannot ride
		// along and make an account linkable to a video.
		const { granted, limit } = await checkCapability(
			capabilities,
			capabilityGrant,
			CAPABILITY.VIDEO_SEND,
			'maxSegments'
		);
		if (!granted) return json(402, { error: 'Sending a video requires Cinder Pro.' });
		if (declared.length > Math.min(limit, MAX_SEGMENTS)) {
			return json(403, { error: 'This video has more segments than your plan allows.' });
		}

		// Prepaid extensions are read off the GRANT, never the request body: they
		// are what was paid for at mint, so the grant is the authority. A missing
		// limit reads as zero; the ladder's ceiling caps a misminted value.
		const prepaid = await checkCapability(
			capabilities,
			capabilityGrant,
			CAPABILITY.VIDEO_SEND,
			'prepaidExtensions'
		);
		const prepaidRemaining = Math.min(prepaid.limit, MAX_EXTENSIONS);

		const locator = newCapability();
		const uploadCapability = newCapability();
		const ttl = Math.min(Math.max(Number(ttlSeconds) || 0, 1), MAX_TTL);
		const createdAt = nowEpoch();
		const expiresAt = createdAt + ttl;
		const expiresIn = uploadWindowFor(declared.length);
		// `parts: 1` because the sender's status question is answered entirely by
		// the SESSION row at the transfer locator — segments are never polled.
		// The token seam is shared with files on purpose; a video token presented
		// at /files/status finds a row of the wrong kind and reads gone.
		const statusToken = statusTokens.mint({ locator, parts: 1, expiresAt });

		await putVideoSession(doc, {
			pk: hashCapability(locator),
			uploadCapabilityHash: hashCapability(uploadCapability),
			segments: declared.length,
			prepaidRemaining,
			createdAt,
			expiresAt
		});

		const grants = await Promise.all(
			declared.map(async (segment, index) => {
				// The v/ prefix is the structural boundary of the presigned-GET
				// departure: the segment-url role's GetObject is scoped to v/*, so
				// it cannot sign a GET for a burn-mode file object. Bands inside it
				// per newObjectKey, so the lifecycle backstop sweeps on time.
				const objectKey = `v/${newObjectKey(ttl)}`;
				const upload = await s3.presignPut({
					key: objectKey,
					bytes: segment.ciphertextBytes,
					sha256: segment.ciphertextSha256,
					expiresIn
				});
				await putVideoSegment(doc, {
					pk: hashCapability(deriveSegmentLocator(locator, index)),
					objectKey,
					uploadCapabilityHash: hashCapability(uploadCapability),
					ciphertextBytes: segment.ciphertextBytes,
					ciphertextSha256: segment.ciphertextSha256,
					createdAt,
					expiresAt
				});
				return { index, upload };
			})
		);

		return json(201, {
			locator,
			uploadCapability,
			...(statusToken ? { statusToken } : {}),
			segments: grants
		});
	}

	// POST /videos/finalize — once per segment with the DERIVED locator, then
	// once with the transfer locator to seal the whole video. The row's kind
	// tells the shapes apart. Both are idempotent on identical facts, which is
	// what makes the sender's upload resumable.
	async function finalizeVideo(event) {
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
		const uch = hashCapability(uploadCapability);
		const now = nowEpoch();

		// Segment first: there are up to 128 of these per one video seal.
		const segment = await getVideoSegment(doc, pk);
		if (segment) {
			// Wrong capability rejected before S3 is touched, same single-trip
			// timing posture as /files/finalize.
			if (!capabilityMatches(uch, segment.uploadCapabilityHash)) return GONE();

			const stored = await s3.attributes({ key: segment.objectKey });
			if (!stored) return GONE();
			if (stored.contentLength !== segment.ciphertextBytes) return GONE();
			if (stored.checksumSha256 !== segment.ciphertextSha256) return GONE();

			const ok = await markVideoSegmentReady(doc, {
				pk,
				uploadCapabilityHash: uch,
				objectKey: segment.objectKey,
				ciphertextBytes: segment.ciphertextBytes,
				ciphertextSha256: segment.ciphertextSha256,
				nowEpoch: now
			});
			return ok ? json(200, { state: 'ready' }) : GONE();
		}

		// The transfer locator: seal the whole video. Until this succeeds the
		// video cannot be claimed, so a half-uploaded video is never presented
		// as whole.
		const session = await getVideoSession(doc, pk);
		if (!session) return GONE();
		if (!capabilityMatches(uch, session.uploadCapabilityHash)) return GONE();

		const states = await Promise.all(
			segmentPksFor(locator, session.segments).map((segPk) => getVideoSegment(doc, segPk))
		);
		const allReady = states.every((s) => s && s.state === 'ready' && s.expiresAt > now);
		if (!allReady) return GONE();

		const ok = await sealVideoSession(doc, { pk, uploadCapabilityHash: uch, nowEpoch: now });
		return ok ? json(200, { state: 'ready' }) : GONE();
	}

	// POST /videos/claim — opens the watch window, or resumes it. Resuming is
	// the deliberate difference from the file claim: closing the tab and
	// reopening the link inside the window must cost nothing.
	async function claimVideo(event) {
		let data;
		try {
			data = JSON.parse(event.body || '{}');
		} catch {
			return json(400, { error: 'bad json' });
		}
		const { locator } = data;
		if (typeof locator !== 'string' || !locator) return GONE();

		const pk = hashCapability(locator);
		const now = nowEpoch();
		const deadlineEpoch = now + WATCH_WINDOW_SECONDS;

		const view = (s) =>
			json(200, {
				deadlineEpoch: s.deadlineEpoch,
				segments: s.segments,
				finished: s.finished === true,
				prepaidRemaining: s.prepaidRemaining,
				extensionsUsed: s.extensionsUsed
			});

		// One read first: the resume answer (which mutates nothing), and the
		// segment count the burn schedule needs.
		const existing = await getVideoSession(doc, pk);
		if (!existing) return GONE();
		if (existing.state === 'open') {
			return existing.deadlineEpoch > now ? view(existing) : GONE();
		}
		// Still uploading: never presented as whole, and not worth arming for.
		if (existing.state !== 'ready') return GONE();

		// The burn is armed BEFORE the window opens, so a claim can never leave
		// an open session with no scheduled delete behind it. If the open below
		// then fails, the schedule fires against a row whose deadline guard
		// refuses the burn, and it does nothing. An arm failure throws here —
		// before anything opened — so the retry starts clean.
		await scheduler.arm({
			pk,
			segmentPks: segmentPksFor(locator, existing.segments),
			atEpoch: deadlineEpoch
		});

		const sweepExpiresAt = now + SESSION_CAP_SECONDS + SWEEP_SLACK_SECONDS;
		const opened = await openVideoSession(doc, { pk, nowEpoch: now, deadlineEpoch, sweepExpiresAt });
		if (opened) {
			// Lift every segment row's TTL to the same sweep horizon. Pre-claim
			// they carry the sender's expiry, and a window opened minutes before
			// that expiry must not have its segments reaped out from under it.
			await Promise.all(
				segmentPksFor(locator, opened.segments).map((segPk) =>
					liftVideoSegmentExpiry(doc, { pk: segPk, expiresAt: sweepExpiresAt })
				)
			);
			return view(opened);
		}

		// Lost the ready → open race to a concurrent claim of the same link —
		// same person, two tabs. Resume what they opened.
		const raced = await getVideoSession(doc, pk);
		if (raced && raced.state === 'open' && raced.deadlineEpoch > now) {
			return view(raced);
		}
		return GONE();
	}

	// POST /videos/segment-url — a short-lived presigned GET for one segment's
	// ciphertext, refused unconditionally past the deadline. The at-read guard
	// here IS the availability guarantee.
	async function segmentUrl(event) {
		let data;
		try {
			data = JSON.parse(event.body || '{}');
		} catch {
			return json(400, { error: 'bad json' });
		}
		const { locator, index } = data;
		if (typeof locator !== 'string' || !locator) return GONE();
		if (!Number.isInteger(index) || index < 0) return GONE();

		const now = nowEpoch();
		const session = await getVideoSession(doc, hashCapability(locator));
		if (!session || session.state !== 'open') return GONE();
		if (session.deadlineEpoch <= now) return GONE();
		if (index >= session.segments) return GONE();

		const segment = await getVideoSegment(doc, hashCapability(deriveSegmentLocator(locator, index)));
		if (!segment || segment.state !== 'ready') return GONE();

		// An issued URL never outlives the deadline, so "past its deadline, no
		// segment is ever served again" holds without an asterisk.
		const expiresIn = Math.min(SEGMENT_URL_SECONDS, session.deadlineEpoch - now);
		const url = await s3.presignGet({ key: segment.objectKey, expiresIn });
		return json(200, { url, expiresIn });
	}

	// POST /videos/finished — the client's report that playback ended. Only
	// ever SHORTENS the deadline; a forged or repeated report cannot buy time,
	// and a suppressed one is bounded by the window ceiling. The ceiling is the
	// guarantee; the countdown is the experience.
	async function finishedVideo(event) {
		let data;
		try {
			data = JSON.parse(event.body || '{}');
		} catch {
			return json(400, { error: 'bad json' });
		}
		const { locator } = data;
		if (typeof locator !== 'string' || !locator) return GONE();

		const pk = hashCapability(locator);
		const now = nowEpoch();
		const shortened = now + FINISHED_COUNTDOWN_SECONDS;

		if (await shortenDeadline(doc, { pk, nowEpoch: now, deadlineEpoch: shortened })) {
			const session = await getVideoSession(doc, pk);
			if (session) await rearm(locator, pk, session.segments, shortened);
			return json(200, { deadlineEpoch: shortened });
		}

		// Refused: either the deadline is already at least this short (a repeat
		// report — idempotent, answer the real deadline) or the session is gone.
		const session = await getVideoSession(doc, pk);
		if (session && session.state === 'open' && session.deadlineEpoch > now) {
			return json(200, { deadlineEpoch: session.deadlineEpoch });
		}
		return GONE();
	}

	// POST /videos/extend — either side may call it: holding the locator is the
	// authorization, so extending identifies nobody. Prepaid first, then a
	// video.extend grant. Both caps ride the same conditional write that moves
	// the deadline, so racing extensions cannot overshoot.
	async function extendVideo(event) {
		let data;
		try {
			data = JSON.parse(event.body || '{}');
		} catch {
			return json(400, { error: 'bad json' });
		}
		const { locator, capabilityGrant } = data;
		if (typeof locator !== 'string' || !locator) return GONE();

		const pk = hashCapability(locator);

		// Optimistic-concurrency loop: a lost race re-reads and re-decides. It
		// terminates because every pass either returns, or lost to a write that
		// consumed one of at most MAX_EXTENSIONS extensions; 16 is the rung
		// comfortably above that.
		for (let attempt = 0; attempt < 16; attempt++) {
			const now = nowEpoch();
			const session = await getVideoSession(doc, pk);
			if (!session || session.state !== 'open' || session.deadlineEpoch <= now) return GONE();

			const newDeadline = Math.min(
				session.deadlineEpoch + EXTENSION_SECONDS,
				session.claimedAt + SESSION_CAP_SECONDS
			);
			if (session.extensionsUsed >= MAX_EXTENSIONS || newDeadline <= session.deadlineEpoch) {
				return json(403, { error: 'This video has all the time it can be given.' });
			}

			const usePrepaid = session.prepaidRemaining > 0;
			if (!usePrepaid) {
				const { granted } = await checkCapability(
					capabilities,
					capabilityGrant,
					CAPABILITY.VIDEO_EXTEND,
					'extensions'
				);
				// The minutes already on the clock are never at risk; the UI's
				// answer to this is the design doc's open-doors copy.
				if (!granted) return json(402, { error: 'Adding time requires Cinder Pro.' });
			}

			const extended = await applyExtension(doc, {
				pk,
				nowEpoch: now,
				oldDeadline: session.deadlineEpoch,
				newDeadline,
				maxExtensions: MAX_EXTENSIONS,
				usePrepaid
			});
			if (extended) {
				await rearm(locator, pk, extended.segments, extended.deadlineEpoch);
				return json(200, {
					deadlineEpoch: extended.deadlineEpoch,
					prepaidRemaining: extended.prepaidRemaining,
					extensionsUsed: extended.extensionsUsed
				});
			}
			// Lost a race; loop re-reads and re-decides.
		}
		return GONE();
	}

	// POST /videos/status — sender-only. 'waiting' only while sealed, unclaimed,
	// and unexpired; everything else is 'gone', indistinguishably, because the
	// moment a recipient acts the sender's view collapses to one word.
	async function statusVideo(event) {
		let data;
		try {
			data = JSON.parse(event.body || '{}');
		} catch {
			return json(200, { status: 'gone' });
		}
		const claims = statusTokens.verify(data.statusToken);
		if (!claims) return json(200, { status: 'gone' });

		const session = await getVideoSession(doc, hashCapability(claims.locator));
		const waiting = Boolean(
			session && session.state === 'ready' && session.expiresAt > nowEpoch()
		);
		return json(200, { status: waiting ? 'waiting' : 'gone' });
	}

	// POST /videos/destroy — the recipient declining at the gate (locator), or
	// the sender regretting the send (statusToken). Works only while unclaimed:
	// an open window is the recipient's promise. Always answers 200 {} so the
	// endpoint is never an oracle and a repeated tap is safe.
	async function destroyVideo(event) {
		let data;
		try {
			data = JSON.parse(event.body || '{}');
		} catch {
			return json(200, {});
		}

		let locator = null;
		if (typeof data.statusToken === 'string') {
			locator = statusTokens.verify(data.statusToken)?.locator ?? null;
		} else if (typeof data.locator === 'string' && data.locator) {
			locator = data.locator;
		}
		if (!locator) return json(200, {});

		const destroyed = await destroyUnclaimedVideo(doc, {
			pk: hashCapability(locator),
			nowEpoch: nowEpoch()
		});
		if (destroyed) {
			await sweepSegments(segmentPksFor(locator, destroyed.segments));
		}
		return json(200, {});
	}

	async function sweepSegments(segmentPks) {
		await Promise.all(
			segmentPks.map(async (segPk) => {
				const seg = await deleteVideoSegment(doc, segPk);
				if (seg) await s3.delete({ key: seg.objectKey });
			})
		);
	}

	// The scheduled burn. Not an API route: EventBridge Scheduler (or the dev
	// timer) invokes it with { pk, segmentPks } — hashes only, never a locator,
	// so the schedule store holds nothing replayable against the API.
	//
	// The deadline guard makes a stale schedule harmless: if an extension moved
	// the deadline and the re-arm was lost, the delete is refused and the burn
	// re-arms itself at the row's live deadline. Availability ended at the
	// deadline regardless — this is the physical layer, not the guarantee.
	async function burnVideo(input) {
		const { pk, segmentPks } = input || {};
		if (typeof pk !== 'string' || !pk) return { burned: false };

		const outcome = await deleteVideoSessionAtDeadline(doc, { pk, nowEpoch: nowEpoch() });
		if (outcome === 'kept') {
			const session = await getVideoSession(doc, pk);
			if (session?.state === 'open') {
				await scheduler.arm({ pk, segmentPks, atEpoch: session.deadlineEpoch }).catch(() => {});
			}
			return { burned: false };
		}

		// 'deleted', or 'absent' (a crash between session delete and the sweep):
		// either way the segments go now. Idempotent all the way down.
		if (Array.isArray(segmentPks)) await sweepSegments(segmentPks);
		return { burned: true };
	}

	return {
		createVideo,
		finalizeVideo,
		claimVideo,
		segmentUrl,
		finishedVideo,
		extendVideo,
		statusVideo,
		destroyVideo,
		burnVideo
	};
}
