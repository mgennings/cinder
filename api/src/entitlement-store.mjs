// The entitlement table. One row per (product, person), and the row is the
// whole record: a pairwise subject and a boolean. No email, no name, no
// provider identity, no sign-in history, no device, no IP.
//
// THE ITEM, IN FULL — this is the complete list of what an account stores:
//   pk        "cinder#<base64 hmac>"  — product tag + pairwise subject
//   entitled  true
//   grantedAt "2026-07-27T00:00:00Z"  — day-resolution would be kinder, but a
//                                       purchase dispute needs a timestamp and
//                                       the copy on /account says it is stored
//
// It is a DIFFERENT TABLE from blip-notes on purpose. Notes carry no identity
// at all, so there is nothing to join even for someone holding both — but two
// tables also means two IAM policies, and the note functions have no read of
// this one.

import { GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

const TABLE = () => process.env.ENTITLEMENT_TABLE || 'mattos-entitlements';

// The product tag rides in the key as well as in the pepper. The pepper is what
// makes rows unrelatable across products; the tag is what makes a table scan
// legible to an operator without it meaning anything about a person.
const key = (product, pairwise) => `${product}#${pairwise}`;

export async function isEntitled(doc, product, pairwise) {
	const res = await doc.send(
		new GetCommand({
			TableName: TABLE(),
			Key: { pk: key(product, pairwise) },
			// The only attribute anyone is allowed to ask for.
			ProjectionExpression: 'entitled'
		})
	);
	return res.Item?.entitled === true;
}

// The seam the purchase lane writes through. Its ONLY caller is the Stripe
// webhook in purchase.mjs, which reaches this line solely after a signature it
// verified, a payment Stripe reported settled, and a pending row this server
// minted itself. Nothing else in the stack may call it: a second caller is a
// second way to become entitled, and there is only supposed to be one.
//
// A grant is a PUT of a fixed item, so it is idempotent by construction. Stripe
// guarantees at-least-once delivery and retries until it sees a 2xx, so the same
// event arriving five times, or the two settling events for one session arriving
// out of order, all write the identical row. `grantedAt` moving is the only
// visible effect, and it is not load-bearing for anything.
export async function grantEntitlement(doc, product, pairwise) {
	await doc.send(
		new PutCommand({
			TableName: TABLE(),
			Item: {
				pk: key(product, pairwise),
				entitled: true,
				grantedAt: new Date().toISOString()
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
