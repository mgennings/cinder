// Pending purchases. One row, short-lived, in the entitlement table.
//
// THE ITEM, IN FULL:
//   pk        "purchase#<sha256(nonce)>"  — never the nonce itself
//   kind      "purchase"
//   product   "cinder"
//   pairwise  the buyer's pairwise subject for that product
//   expiresAt epoch seconds, DynamoDB TTL
//
// WHY THIS ROW EXISTS AT ALL, since Stripe would happily carry the pairwise
// subject in client_reference_id and save a write:
//
// Because then Stripe's records would hold {pairwise subject ↔ card ↔ email}
// forever, and Cinder's table holds {pairwise subject ↔ entitled}. Two databases
// that individually say nothing become, on a subpoena or a breach of either, one
// database that names the buyer. The nonce breaks that join: Stripe stores a
// random string that expires here in an hour and means nothing afterward, and
// this row — the only thing that could translate it — is deleted the moment the
// grant lands. There is a window of about one checkout in which the linkage
// exists, and then there is no artifact anywhere that recreates it.
//
// PORTABLE. `product` and `pairwise` are opaque strings; nothing here knows what
// Cinder is.

import { PutCommand, GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'node:crypto';

const TABLE = () => process.env.ENTITLEMENT_TABLE || 'mattos-entitlements';

// Long enough for someone to find their card, short enough that an abandoned
// checkout is not a row sitting around describing an intent to buy.
const PENDING_TTL_SECONDS = 60 * 60;

// Stored as a hash, never the nonce, following the same rule as every other
// capability in this repo: a dump of the table cannot be replayed against the
// API, because what the API is handed is the preimage.
const key = (nonce) => `purchase#${createHash('sha256').update(String(nonce), 'utf8').digest('base64')}`;

// `expiresAt` is a parameter only so a failed credit can put the row BACK with
// its original deadline (see restore in purchase.mjs). Normal checkout omits it.
export async function putPendingPurchase(
	doc,
	{ nonce, product, pairwise, nowEpoch, expiresAt = nowEpoch + PENDING_TTL_SECONDS }
) {
	await doc.send(
		new PutCommand({
			TableName: TABLE(),
			Item: {
				pk: key(nonce),
				kind: 'purchase',
				product,
				pairwise,
				expiresAt
			},
			// A nonce is 256 random bits, so a collision is not a real event. The
			// condition is here so that if one ever happened it would be an error
			// rather than a silent overwrite that redirected someone's payment to
			// another person's entitlement.
			ConditionExpression: 'attribute_not_exists(pk)'
		})
	);
}

// Resolve a nonce to what it was minted for, WITHOUT consuming it. This is the
// read the webhook's cross-check runs on: an event signed by the wrong Stripe
// account must be able to look at a pending row without destroying it.
//
// The expiry guard is mandatory: DynamoDB TTL deletion is best-effort and an
// expired-but-unreaped row still comes back from a read.
export async function readPendingPurchase(doc, nonce, nowEpoch) {
	const res = await doc.send(new GetCommand({ TableName: TABLE(), Key: { pk: key(nonce) } }));
	const item = res.Item;
	if (!item || item.kind !== 'purchase') return null;
	if (!(item.expiresAt > nowEpoch)) return null;
	return { product: item.product, pairwise: item.pairwise };
}

// CLAIM IT. The exactly-once gate for the whole money path, and the reason a
// duplicate Stripe delivery cannot buy a second bundle of credits.
//
// Under the one-time unlock the grant was a PUT of a fixed item, so idempotency
// was free: five deliveries of the same event wrote the identical row. Credits
// accumulate, so the same five deliveries would have added fifty. The dedupe
// therefore lives HERE, on the only artifact that is unique per purchase — the
// pending row — and it is a conditional delete rather than a read-then-delete so
// that two deliveries racing each other cannot both win.
//
// Returns the claimed row, or null if there was nothing left to claim: already
// consumed, expired, or never minted. `ALL_OLD` is what makes one call both the
// claim and the answer.
//
// It also deletes the translation. After this, nothing anywhere maps Stripe's
// stored reference back to a person — not this table, not a log, not us.
export async function claimPendingPurchase(doc, nonce, nowEpoch) {
	try {
		const res = await doc.send(
			new DeleteCommand({
				TableName: TABLE(),
				Key: { pk: key(nonce) },
				ConditionExpression: 'attribute_exists(pk) AND kind = :k AND expiresAt > :now',
				ExpressionAttributeValues: { ':k': 'purchase', ':now': nowEpoch },
				ReturnValues: 'ALL_OLD'
			})
		);
		const item = res.Attributes;
		return item ? { product: item.product, pairwise: item.pairwise, expiresAt: item.expiresAt } : null;
	} catch (e) {
		if (e?.name === 'ConditionalCheckFailedException') return null;
		throw e;
	}
}
