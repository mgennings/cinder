// The entitlement table. One row per (product, person), and the row is the
// whole record: a pairwise subject and a count. No email, no name, no provider
// identity, no sign-in history, no device, no IP.
//
// THE ITEM, IN FULL — this is the complete list of what an account stores:
//   pk        "cinder#<base64 hmac>"  — product tag + pairwise subject
//   credits   7                       — prepaid large sends remaining
//   grantedAt "2026-07-27T00:00:00Z"  — day-resolution would be kinder, but a
//                                       purchase dispute needs a timestamp and
//                                       the copy on /account says it is stored
//
// It is a COUNTER, not a boolean, because Cinder Pro is prepaid credits: one
// purchase adds a bundle, one large send spends one. `credits > 0` is the only
// thing the rest of the stack ever asks, and the number itself never leaves the
// identity API — see the note in capability-grant.mjs about a rare balance being
// a fingerprint.
//
// It is a DIFFERENT TABLE from blip-notes on purpose. Notes carry no identity
// at all, so there is nothing to join even for someone holding both — but two
// tables also means two IAM policies, and the note functions have no read of
// this one.

import { GetCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

const TABLE = () => process.env.ENTITLEMENT_TABLE || 'mattos-entitlements';

// The product tag rides in the key as well as in the pepper. The pepper is what
// makes rows unrelatable across products; the tag is what makes a table scan
// legible to an operator without it meaning anything about a person.
const key = (product, pairwise) => `${product}#${pairwise}`;

// What a person has left. Zero for a row that does not exist, which is the same
// answer as a row spent down to nothing — running out and never having bought
// are deliberately indistinguishable to everything downstream.
export async function readCredits(doc, product, pairwise) {
	const res = await doc.send(
		new GetCommand({
			TableName: TABLE(),
			Key: { pk: key(product, pairwise) },
			// The only attribute anyone is allowed to ask for.
			ProjectionExpression: 'credits'
		})
	);
	const credits = res.Item?.credits;
	return Number.isSafeInteger(Number(credits)) && credits > 0 ? Number(credits) : 0;
}

// SPEND, ATOMICALLY. True if the credits were actually taken.
//
// A read-then-write here would be a money bug wearing a race condition: two
// mints in flight against a balance of one would both read 1, both write 0, and
// both hand out a grant. So the check and the decrement are the SAME DynamoDB
// call — the condition is evaluated on the item the update is about to modify,
// under that partition's own lock, and the loser gets
// ConditionalCheckFailedException instead of a negative balance.
//
// The condition is what makes the floor real. `credits >= :one` on a row with no
// `credits` attribute does not match — a comparison against a missing attribute
// is false, never true — so a person who never bought anything fails here too,
// with no extra branch and no second read.
// `count` defaults to 1 (a multipart send); a video send spends 2 and a video
// extension 1 (docs/video-api-contract.md), through this same call so the
// atomicity story never forks. All-or-nothing: a balance of 1 against a spend
// of 2 takes nothing, because a partial charge would be a partial grant.
export async function spendCredit(doc, product, pairwise, count = 1) {
	if (!Number.isSafeInteger(count) || count < 1) throw new Error('spendCredit: bad count');
	try {
		await doc.send(
			new UpdateCommand({
				TableName: TABLE(),
				Key: { pk: key(product, pairwise) },
				UpdateExpression: 'SET credits = credits - :n',
				ConditionExpression: 'attribute_exists(pk) AND credits >= :n',
				ExpressionAttributeValues: { ':n': count }
			})
		);
		return true;
	} catch (e) {
		if (e?.name === 'ConditionalCheckFailedException') return false;
		// Anything else — throttling, a network fault, a wrong table name — must
		// NOT read as "no credits left". Failing closed on an unknown error is
		// right; doing it silently is how an outage becomes an invisible refusal
		// aimed at the people who paid.
		throw e;
	}
}

// The seam the purchase lane writes through. Its ONLY caller is the Stripe
// webhook in purchase.mjs, which reaches this line solely after a signature it
// verified, a payment Stripe reported settled, and an EXCLUSIVE CLAIM on a
// pending row this server minted itself. Nothing else in the stack may call it:
// a second caller is a second way to get credits, and there is only supposed to
// be one.
//
// Adding is deliberately NOT idempotent — a top-up must accumulate, so the same
// call twice adds twice. That moves the idempotency one step upstream, onto the
// claim in purchase-store.mjs, where a duplicate Stripe delivery is stopped
// before it ever reaches this line. Under a boolean that safety was free (a PUT
// of a fixed item); under a counter it has to be designed, because a duplicate
// delivery is now a money bug rather than a no-op.
export async function addCredits(doc, product, pairwise, count) {
	if (!Number.isSafeInteger(count) || count < 1) throw new Error('addCredits: bad count');
	await doc.send(
		new UpdateCommand({
			TableName: TABLE(),
			Key: { pk: key(product, pairwise) },
			UpdateExpression: 'SET credits = if_not_exists(credits, :zero) + :n, grantedAt = :now',
			ExpressionAttributeValues: {
				':zero': 0,
				':n': count,
				':now': new Date().toISOString()
			}
		})
	);
}

// Unconditional delete: no read first, no "did it exist" answer, no tombstone.
// The row is gone, not flagged. DynamoDB's DeleteItem is idempotent, so calling
// it for a person who never bought anything is a no-op and reveals nothing.
export async function forgetEntitlement(doc, product, pairwise) {
	await doc.send(new DeleteCommand({ TableName: TABLE(), Key: { pk: key(product, pairwise) } }));
}
