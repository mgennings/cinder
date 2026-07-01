// DynamoDB note store. The burn is the whole game: an atomic conditional
// DeleteItem that returns the item it deleted. Exactly one caller wins the
// race; everyone else gets a ConditionalCheckFailedException (→ null here).
// The `expiresAt > :now` guard is mandatory because TTL deletion is
// best-effort and expired-but-unreaped items still show up in reads.

import { PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

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
