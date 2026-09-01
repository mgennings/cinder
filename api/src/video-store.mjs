// The video rows. Same table as notes and file grants, same one-conditional-
// write-per-transition idiom as store.mjs, keyed by hashes so a dump replays
// nothing. Two row kinds:
//
//   'video'          — the session row, one per video. uploading → ready → open.
//   'video-segment'  — one per segment, deliberately the file-grant shape plus
//                      a different kind. /files/claim conditions on
//                      kind = 'file', so a video segment is structurally
//                      unclaimable through the file path with no change to it.
//
// Nothing readable is stored: no name, no type, no thumbnail, no recipient,
// no account. docs/video-api-contract.md is the row contract.

import { PutCommand, DeleteCommand, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const TABLE = () => process.env.TABLE_NAME || 'blip-notes';

// `state` and `kind` are both DynamoDB reserved words.
const NAMES = { '#s': 'state', '#k': 'kind' };

// --- session row -------------------------------------------------------------

export async function putVideoSession(
	doc,
	{ pk, uploadCapabilityHash, segments, prepaidRemaining, createdAt, expiresAt }
) {
	await doc.send(
		new PutCommand({
			TableName: TABLE(),
			Item: {
				pk,
				kind: 'video',
				state: 'uploading',
				uploadCapabilityHash,
				segments,
				prepaidRemaining,
				extensionsUsed: 0,
				finished: false,
				createdAt,
				expiresAt
			},
			ConditionExpression: 'attribute_not_exists(pk)'
		})
	);
}

// One consistent read of the session row, with the kind check done here so no
// caller can forget it. Returns the whole session view; every DECISION about it
// still belongs to a conditional write below.
export async function getVideoSession(doc, pk) {
	const res = await doc.send(
		new GetCommand({ TableName: TABLE(), Key: { pk }, ConsistentRead: true })
	);
	const item = res.Item;
	if (!item || item.kind !== 'video') return null;
	return item;
}

// uploading → ready, once every segment has been verified by the caller. The
// upload capability is a condition rather than an argument check, so a seal
// with the wrong capability fails the same way a seal of a claimed video does.
export async function sealVideoSession(doc, { pk, uploadCapabilityHash, nowEpoch }) {
	try {
		await doc.send(
			new UpdateCommand({
				TableName: TABLE(),
				Key: { pk },
				UpdateExpression: 'SET #s = :ready',
				ConditionExpression: [
					'attribute_exists(pk)',
					'#k = :video',
					'(#s = :uploading OR #s = :ready)', // retry-idempotent, like markFileReady
					'uploadCapabilityHash = :uch',
					'expiresAt > :now'
				].join(' AND '),
				ExpressionAttributeNames: NAMES,
				ExpressionAttributeValues: {
					':ready': 'ready',
					':uploading': 'uploading',
					':video': 'video',
					':uch': uploadCapabilityHash,
					':now': nowEpoch
				}
			})
		);
		return true;
	} catch (e) {
		if (e.name === 'ConditionalCheckFailedException') return false;
		throw e;
	}
}

// The recipient's consent moment: ready → open, recording the claim time and
// the window deadline in the same write. `expiresAt` — the DynamoDB TTL — is
// rewritten to outlive the longest possible session so a crashed burn is still
// swept; availability is governed by deadlineEpoch alone from here on.
//
// Returns the opened session, or null if the row was not claimable — the
// caller then re-reads to distinguish "already open, resume it" from "gone",
// which is safe because a resume mutates nothing.
export async function openVideoSession(doc, { pk, nowEpoch, deadlineEpoch, sweepExpiresAt }) {
	try {
		const res = await doc.send(
			new UpdateCommand({
				TableName: TABLE(),
				Key: { pk },
				UpdateExpression:
					'SET #s = :open, claimedAt = :now, deadlineEpoch = :deadline, expiresAt = :sweep',
				ConditionExpression:
					'attribute_exists(pk) AND #k = :video AND #s = :ready AND expiresAt > :now',
				ExpressionAttributeNames: NAMES,
				ExpressionAttributeValues: {
					':open': 'open',
					':video': 'video',
					':ready': 'ready',
					':now': nowEpoch,
					':deadline': deadlineEpoch,
					':sweep': sweepExpiresAt
				},
				ReturnValues: 'ALL_NEW'
			})
		);
		return res.Attributes;
	} catch (e) {
		if (e.name === 'ConditionalCheckFailedException') return null;
		throw e;
	}
}

// The finished report. Only ever SHORTENS: the condition refuses a deadline
// that is not strictly later than the proposed one, so a forged or repeated
// report cannot buy time. The caller treats a refusal on an open session as
// idempotent success and answers with the current deadline.
export async function shortenDeadline(doc, { pk, nowEpoch, deadlineEpoch }) {
	try {
		await doc.send(
			new UpdateCommand({
				TableName: TABLE(),
				Key: { pk },
				UpdateExpression: 'SET deadlineEpoch = :deadline, finished = :true',
				ConditionExpression: [
					'attribute_exists(pk)',
					'#k = :video',
					'#s = :open',
					'deadlineEpoch > :now',
					'deadlineEpoch > :deadline' // shorten only, never lengthen
				].join(' AND '),
				ExpressionAttributeNames: NAMES,
				ExpressionAttributeValues: {
					':video': 'video',
					':open': 'open',
					':now': nowEpoch,
					':deadline': deadlineEpoch,
					':true': true
				}
			})
		);
		return true;
	} catch (e) {
		if (e.name === 'ConditionalCheckFailedException') return false;
		throw e;
	}
}

// One extension, funded and capped in the same conditional write. The caller
// computed `newDeadline` from a read; `oldDeadline` in the condition is what
// makes that read-then-write safe — a racing extension moved the deadline, the
// condition fails, and the caller re-reads and retries rather than overshooting.
// The extension count cap rides in the same condition, so racing extensions
// cannot pass MAX_EXTENSIONS either.
export async function applyExtension(
	doc,
	{ pk, nowEpoch, oldDeadline, newDeadline, maxExtensions, usePrepaid }
) {
	const conditions = [
		'attribute_exists(pk)',
		'#k = :video',
		'#s = :open',
		'deadlineEpoch = :old',
		'deadlineEpoch > :now',
		'extensionsUsed < :max'
	];
	const values = {
		':video': 'video',
		':open': 'open',
		':old': oldDeadline,
		':now': nowEpoch,
		':max': maxExtensions,
		':new': newDeadline,
		':one': 1
	};
	let update = 'SET deadlineEpoch = :new, extensionsUsed = extensionsUsed + :one';
	if (usePrepaid) {
		// The prepaid spend is part of the same write: no prepaid left, no
		// extension, and a race cannot spend the same prepaid twice.
		conditions.push('prepaidRemaining >= :one');
		update += ', prepaidRemaining = prepaidRemaining - :one';
	}
	try {
		const res = await doc.send(
			new UpdateCommand({
				TableName: TABLE(),
				Key: { pk },
				UpdateExpression: update,
				ConditionExpression: conditions.join(' AND '),
				ExpressionAttributeNames: NAMES,
				ExpressionAttributeValues: values,
				ReturnValues: 'ALL_NEW'
			})
		);
		return res.Attributes;
	} catch (e) {
		if (e.name === 'ConditionalCheckFailedException') return null;
		throw e;
	}
}

// The sender's regret and the recipient's decline, one shape: delete the
// session, but ONLY from `ready`. Once a watch window is open it is the
// recipient's promise and nobody can slam it shut. Returns what it deleted so
// the caller can sweep the segments, or null for "there was nothing to do" —
// which the endpoint reports identically, on purpose.
export async function destroyUnclaimedVideo(doc, { pk, nowEpoch }) {
	try {
		const res = await doc.send(
			new DeleteCommand({
				TableName: TABLE(),
				Key: { pk },
				ConditionExpression:
					'attribute_exists(pk) AND #k = :video AND #s = :ready AND expiresAt > :now',
				ExpressionAttributeNames: NAMES,
				ExpressionAttributeValues: { ':video': 'video', ':ready': 'ready', ':now': nowEpoch },
				ReturnValues: 'ALL_OLD'
			})
		);
		return res.Attributes || null;
	} catch (e) {
		if (e.name === 'ConditionalCheckFailedException') return null;
		throw e;
	}
}

// The burn's session delete. Guarded by the deadline so a stale schedule — one
// a later extension should have re-armed past — cannot burn early: if the
// deadline has moved, the condition fails and the objects live to their real
// deadline. Returns 'deleted', 'kept' (a live deadline is still running), or
// 'absent' (already burned or destroyed; the caller sweeps segments anyway).
export async function deleteVideoSessionAtDeadline(doc, { pk, nowEpoch }) {
	try {
		await doc.send(
			new DeleteCommand({
				TableName: TABLE(),
				Key: { pk },
				ConditionExpression: 'attribute_exists(pk) AND #k = :video AND deadlineEpoch <= :now',
				ExpressionAttributeNames: { '#k': 'kind' },
				ExpressionAttributeValues: { ':video': 'video', ':now': nowEpoch },
				ReturnValuesOnConditionCheckFailure: 'ALL_OLD'
			})
		);
		return 'deleted';
	} catch (e) {
		if (e.name === 'ConditionalCheckFailedException') {
			return e.Item ? 'kept' : 'absent';
		}
		throw e;
	}
}

// --- segment rows ------------------------------------------------------------
//
// Deliberately the putFileGrant shape with kind 'video-segment'. Written as its
// own function rather than a parameter on the file one, so no refactor of the
// file path can quietly change what a video row looks like or vice versa.

export async function putVideoSegment(
	doc,
	{ pk, objectKey, uploadCapabilityHash, ciphertextBytes, ciphertextSha256, createdAt, expiresAt }
) {
	await doc.send(
		new PutCommand({
			TableName: TABLE(),
			Item: {
				pk,
				kind: 'video-segment',
				state: 'uploading',
				objectKey,
				uploadCapabilityHash,
				ciphertextBytes,
				ciphertextSha256,
				createdAt,
				expiresAt
			},
			ConditionExpression: 'attribute_not_exists(pk)'
		})
	);
}

// Finalize's read: which object key did we authorize, and against what facts.
// Answers a question, grants nothing — the conditional write below re-checks
// every fact this returned. Also serves the video seal, which needs `state`.
export async function getVideoSegment(doc, pk) {
	const res = await doc.send(
		new GetCommand({ TableName: TABLE(), Key: { pk }, ConsistentRead: true })
	);
	const item = res.Item;
	if (!item || item.kind !== 'video-segment') return null;
	return {
		objectKey: item.objectKey,
		uploadCapabilityHash: item.uploadCapabilityHash,
		ciphertextBytes: item.ciphertextBytes,
		ciphertextSha256: item.ciphertextSha256,
		state: item.state,
		expiresAt: item.expiresAt
	};
}

// uploading → ready, identical semantics to markFileReady, on the video kind.
export async function markVideoSegmentReady(
	doc,
	{ pk, uploadCapabilityHash, objectKey, ciphertextBytes, ciphertextSha256, nowEpoch }
) {
	try {
		await doc.send(
			new UpdateCommand({
				TableName: TABLE(),
				Key: { pk },
				UpdateExpression: 'SET #s = :ready',
				ConditionExpression: [
					'attribute_exists(pk)',
					'#k = :seg',
					'(#s = :uploading OR #s = :ready)',
					'uploadCapabilityHash = :uch',
					'objectKey = :key',
					'ciphertextBytes = :bytes',
					'ciphertextSha256 = :sum',
					'expiresAt > :now'
				].join(' AND '),
				ExpressionAttributeNames: NAMES,
				ExpressionAttributeValues: {
					':ready': 'ready',
					':uploading': 'uploading',
					':seg': 'video-segment',
					':uch': uploadCapabilityHash,
					':key': objectKey,
					':bytes': ciphertextBytes,
					':sum': ciphertextSha256,
					':now': nowEpoch
				}
			})
		);
		return true;
	} catch (e) {
		if (e.name === 'ConditionalCheckFailedException') return false;
		throw e;
	}
}

// The claim's other write: lift a segment row's TTL to the session sweep
// horizon. Pre-claim, expiresAt is the sender's expiry; once a window is open
// the segment must outlive it, or DynamoDB's reaper could eat a row inside an
// open window a person was promised. Only ever raises, so a stale retry
// cannot shorten anything.
export async function liftVideoSegmentExpiry(doc, { pk, expiresAt }) {
	try {
		await doc.send(
			new UpdateCommand({
				TableName: TABLE(),
				Key: { pk },
				UpdateExpression: 'SET expiresAt = :sweep',
				ConditionExpression: '#k = :seg AND expiresAt < :sweep',
				ExpressionAttributeNames: { '#k': 'kind' },
				ExpressionAttributeValues: { ':seg': 'video-segment', ':sweep': expiresAt }
			})
		);
	} catch (e) {
		if (e.name !== 'ConditionalCheckFailedException') throw e;
		// Already at or past the horizon, or already gone: nothing to lift.
	}
}

// Segment delete returning the object key, for the destroy and burn sweeps.
// Conditioned on the kind so a sweep handed a wrong pk can only ever remove a
// video segment, never any other row. Idempotent: a segment already gone
// returns null and the sweep moves on.
export async function deleteVideoSegment(doc, pk) {
	try {
		const res = await doc.send(
			new DeleteCommand({
				TableName: TABLE(),
				Key: { pk },
				ConditionExpression: '#k = :seg',
				ExpressionAttributeNames: { '#k': 'kind' },
				ExpressionAttributeValues: { ':seg': 'video-segment' },
				ReturnValues: 'ALL_OLD'
			})
		);
		const item = res.Attributes;
		return item ? { objectKey: item.objectKey } : null;
	} catch (e) {
		if (e.name === 'ConditionalCheckFailedException') return null;
		throw e;
	}
}
