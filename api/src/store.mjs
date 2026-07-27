// DynamoDB note store. The burn is the whole game: an atomic conditional
// DeleteItem that returns the item it deleted. Exactly one caller wins the
// race; everyone else gets a ConditionalCheckFailedException (→ null here).
// The `expiresAt > :now` guard is mandatory because TTL deletion is
// best-effort and expired-but-unreaped items still show up in reads.

import { PutCommand, DeleteCommand, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const TABLE = () => process.env.TABLE_NAME || 'blip-notes';

export async function putNote(doc, { id, ciphertext, iv, salt, expiresAt }) {
	await doc.send(
		new PutCommand({
			TableName: TABLE(),
			Item: { pk: id, ciphertext, iv, ...(salt ? { salt } : {}), expiresAt },
			ConditionExpression: 'attribute_not_exists(pk)'
		})
	);
}

export async function burnNote(doc, id, nowEpoch) {
	try {
		const res = await doc.send(
			new DeleteCommand({
				TableName: TABLE(),
				Key: { pk: id },
				ConditionExpression: 'attribute_exists(pk) AND expiresAt > :now',
				ExpressionAttributeValues: { ':now': nowEpoch },
				ReturnValues: 'ALL_OLD',
				ReturnValuesOnConditionCheckFailure: 'ALL_OLD'
			})
		);
		const item = res.Attributes;
		if (!item) return null;
		return { ciphertext: item.ciphertext, iv: item.iv, salt: item.salt };
	} catch (e) {
		if (e.name === 'ConditionalCheckFailedException') return null;
		throw e;
	}
}

// --- file grants -----------------------------------------------------------
//
// A file transfer is a two-state machine: `uploading` the moment the grant
// exists, `ready` once the server has looked at S3 itself and agreed the stored
// object is the one it authorized. Every transition below is ONE conditional
// write. There is no read-then-decide anywhere in this file, because a
// read-then-decide is a race wearing two API calls.
//
// The item is keyed by sha256(locator), never the locator, so a dump of this
// table cannot be replayed against the API.

// `state` and `kind` are both DynamoDB reserved words.
const NAMES = { '#s': 'state', '#k': 'kind' };

export async function putFileGrant(
	doc,
	{ pk, objectKey, uploadCapabilityHash, ciphertextBytes, ciphertextSha256, createdAt, expiresAt }
) {
	await doc.send(
		new PutCommand({
			TableName: TABLE(),
			Item: {
				pk,
				kind: 'file',
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

// Reads the grant so finalize knows which object key to inspect in S3. This
// answers a question, it never grants anything: readiness comes only from the
// conditional write below, which re-checks every fact this read returned.
export async function getFileGrant(doc, pk) {
	const res = await doc.send(new GetCommand({ TableName: TABLE(), Key: { pk } }));
	const item = res.Item;
	if (!item || item.kind !== 'file') return null;
	return {
		state: item.state,
		objectKey: item.objectKey,
		ciphertextBytes: item.ciphertextBytes,
		ciphertextSha256: item.ciphertextSha256,
		expiresAt: item.expiresAt
	};
}

// uploading -> ready, and only that. Every fact the caller claims must already
// match what create recorded, so a finalize cannot redirect the grant at a
// different object, a different size, or a different checksum.
//
// `ready` is accepted as a starting state as well as `uploading`, which makes a
// retried finalize idempotent — but only because every other condition still
// has to hold. A retry that changed one fact is still refused, and a grant that
// has already been claimed no longer exists to update.
export async function markFileReady(
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
					'#k = :file',
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
					':file': 'file',
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

// The one delivery attempt. Identical in shape to burnNote: a conditional
// delete that returns what it deleted, so exactly one concurrent caller can
// win and the losers cannot tell why they lost.
//
// An `uploading` grant is deliberately not claimable — a half-finished upload
// must never be delivered as if it were whole.
export async function claimFileGrant(doc, pk, nowEpoch) {
	try {
		const res = await doc.send(
			new DeleteCommand({
				TableName: TABLE(),
				Key: { pk },
				ConditionExpression:
					'attribute_exists(pk) AND #k = :file AND #s = :ready AND expiresAt > :now',
				ExpressionAttributeNames: NAMES,
				ExpressionAttributeValues: { ':file': 'file', ':ready': 'ready', ':now': nowEpoch },
				ReturnValues: 'ALL_OLD'
			})
		);
		const item = res.Attributes;
		if (!item) return null;
		return {
			objectKey: item.objectKey,
			ciphertextBytes: item.ciphertextBytes,
			ciphertextSha256: item.ciphertextSha256
		};
	} catch (e) {
		if (e.name === 'ConditionalCheckFailedException') return null;
		throw e;
	}
}
