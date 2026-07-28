// The purchase path. Two routes, and between them exactly one thing can happen:
// a person who signed in and paid gets credits.
//
//   POST /purchase/checkout  → { url }
//   POST /purchase/webhook   → Stripe's callback; the ONLY grantor in the stack
//
// It lives on the identity API rather than the note and file API, for the same
// reason /entitlement does: Cinder's note API refuses the Authorization header
// at CORS, so a browser cannot attach a token to a note request even by
// accident, and the two APIs do not share an access log.
//
// WHAT CREDITS REQUIRE, all five, in order:
//   1. a Stripe-Signature this server verified against the webhook secret
//   2. a timestamp inside the 300-second replay window
//   3. payment_status of paid (or no_payment_required)
//   4. a client_reference_id matching a pending row THIS server minted
//   5. an EXCLUSIVE CLAIM on that row — one delivery wins it, the rest add
//      nothing. Under a boolean this step did not have to exist; under a counter
//      it is the difference between at-least-once delivery and at-least-once
//      billing.
//
// Nothing in the payload is ever believed on its own terms. The product and the
// person come from our own row, never from the event, so an event describing a
// different product — or one with attacker-chosen metadata — resolves to nothing.
//
// ONE STRIPE ACCOUNT PER PRODUCT, NOT ONE PER MATTOS.
//
// Stripe's branding, statement descriptor, receipt, and dispute history are
// account-level, not product-level. A charge for Cinder must read CINDER.INK on
// a card statement, and it cannot if it shares an account with something else.
// So every credential below is a MAP keyed by product, never a constant: the
// secret key, the webhook signing secret, the price, and the return URLs. A
// third domain is a third row in each map and no code change.
//
// This is also why the webhook does not take an account as a parameter. It
// cannot: Stripe calls it, and the request does not say which account it is
// until the signature is checked. So the webhook DISCOVERS the account by
// finding which configured secret verifies the delivery, and that discovery is
// then a constraint — see the cross-check in `webhook`.
//
// PORTABLE. The product string comes from the token's audience via the identity
// lane; everything else is configuration.

import { createHash, randomBytes } from 'node:crypto';
import { verifyStripeSignature, purchaseReference } from './entitlement-logic.mjs';
import {
	putPendingPurchase,
	readPendingPurchase,
	claimPendingPurchase
} from './purchase-store.mjs';
import { addCredits } from './entitlement-store.mjs';

// How many large sends one purchase buys, when a product does not say. Ten, and
// the price that goes with it lives in Stripe rather than here: the fixed 30¢ of
// a card fee is 92% of the fee damage on a sub-dollar charge, so a bundle is the
// difference between the fee eating a third of the money and eating a tenth.
const DEFAULT_CREDITS_PER_PURCHASE = 10;

const json = (statusCode, obj) => ({
	statusCode,
	headers: {
		'content-type': 'application/json',
		'cache-control': 'no-store, private',
		'x-content-type-options': 'nosniff',
		'referrer-policy': 'no-referrer'
	},
	body: JSON.stringify(obj)
});

/**
 * @param identify        the identity lane's verifier, from entitlement.mjs:
 *                        (event) => {product, username, sub, pairwise} | null.
 *                        Never reimplemented here — this lane does not do auth,
 *                        and a second copy of that decision is a second thing to
 *                        get wrong. Only `product` and `pairwise` are read.
 * @param secretKeys      {[product]: 'sk_test_…'}   one Stripe ACCOUNT per product
 * @param webhookSecrets  {[product]: 'whsec_…'}     that account's signing secret
 * @param prices          {[product]: 'price_…'}
 * @param urls            {[product]: {success, cancel}}
 * @param credits         {[product]: 10}  how many sends one purchase adds
 * @param createSession   injected so the suite runs with no Stripe credential at
 *                        all. The mock and the real client take the identical
 *                        arguments, so moving from mocked to sandbox test mode is
 *                        a configuration change and never a code change.
 */
export function makePurchaseHandlers(
	doc,
	{ identify, secretKeys, webhookSecrets, prices, urls, credits = {}, createSession }
) {
	const creditsFor = (product) => {
		const n = Number(credits[product]);
		return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_CREDITS_PER_PURCHASE;
	};

	async function checkout(event) {
		const who = await identify(event);
		// The same negative answer an anonymous caller gets. There is nothing to
		// buy without an account, and saying which of the two is missing would be
		// an oracle for "that token was real but expired".
		if (!who) return json(200, { url: null });

		// NO already-owns check, and its absence is the point. Under the one-time
		// unlock a second purchase bought nothing, so it was refused. Under prepaid
		// credits a second purchase is a TOP-UP, which is the whole model: someone
		// with two credits left who is about to send five files must be able to buy
		// more. The balance accumulates (addCredits), so nothing is lost by paying
		// again and nothing is charged for twice.

		const secretKey = secretKeys[who.product];
		const price = prices[who.product];
		const url = urls[who.product];
		// Fail closed on a config gap. All four have to be present for THIS
		// product: a missing key must never fall back to another product's Stripe
		// account, which would put the wrong name on the buyer's statement and
		// bill the wrong business.
		if (!secretKey || !price || !url?.success || !url?.cancel) return json(200, { url: null });

		// The nonce Stripe will hold. 256 bits, generated here, never derived from
		// the subject — a derived value would let anyone holding both databases
		// recompute the join this row exists to prevent.
		const nonce = randomBytes(32).toString('base64url');
		await putPendingPurchase(doc, {
			nonce,
			product: who.product,
			pairwise: who.pairwise,
			nowEpoch: Math.floor(Date.now() / 1000)
		});

		return json(200, {
			url: await createSession({
				secretKey,
				price,
				reference: nonce,
				successUrl: url.success,
				cancelUrl: url.cancel
			})
		});
	}

	// Stripe's callback. Everything about this function is written on the
	// assumption that anyone on the internet can call it, because they can.
	async function webhook(event) {
		// The RAW body, before anything parses it. API Gateway base64-encodes a
		// body it thinks is binary; decoding here rather than trusting the string
		// is what keeps the bytes we verify identical to the bytes Stripe signed.
		const raw = event.isBase64Encoded
			? Buffer.from(event.body || '', 'base64').toString('utf8')
			: event.body || '';

		const sig = event.headers?.['stripe-signature'] || event.headers?.['Stripe-Signature'];

		// WHICH ACCOUNT SENT THIS? One Stripe account per product means several
		// signing secrets arrive at one URL, and the request does not say which
		// account it came from — the signature is the only thing that does. So we
		// try each configured secret and keep the product whose secret verified.
		//
		// This is not "try until something works and then trust it". Every attempt
		// is the same full check (HMAC over the raw body, inside the replay
		// window), so a delivery signed by nobody's secret matches nobody's, and
		// the loop costs one HMAC per configured product against a body we have
		// already bounded. What it BUYS is the cross-check below.
		let signedBy = null;
		for (const [product, secret] of Object.entries(webhookSecrets)) {
			if (verifyStripeSignature(raw, sig, secret)) {
				signedBy = product;
				break;
			}
		}
		// A forged, absent, stale, or truncated signature dies here, before any
		// parsing, any lookup, and any write.
		if (!signedBy) return json(400, { error: 'bad_signature' });

		let payload;
		try {
			payload = JSON.parse(raw);
		} catch {
			return json(400, { error: 'bad_payload' });
		}

		// null for: an event type that settles nothing, an unpaid async session, a
		// session with no reference, and a reference too long to be one of ours.
		// Each answers 200 so Stripe stops retrying an event we will never act on.
		const reference = purchaseReference(payload);
		if (!reference) return json(200, { received: true });

		const pending = await readPendingPurchase(doc, reference, Math.floor(Date.now() / 1000));
		// A genuine, correctly signed, genuinely paid event for a session this
		// server did not create — another product in the same Stripe account, a
		// dashboard-created payment link, a replay after the row was cleared. It
		// is acknowledged and it grants nothing.
		if (!pending) return json(200, { received: true });

		// THE CROSS-CHECK. The account that signed the delivery must be the
		// account that product's checkout was created against. Without it, anyone
		// holding ONE product's webhook secret could grant EVERY product — which
		// is exactly the failure a shared Stripe account would have made invisible,
		// and exactly the failure separate accounts are supposed to contain. A
		// mismatch is a real anomaly rather than a normal negative, but it is still
		// answered with the same silent 200: Stripe must stop retrying, and the
		// caller learns nothing either way.
		if (pending.product !== signedBy) return json(200, { received: true });

		// CLAIM, then credit. Under the one-time unlock the order was the other way
		// around — grant, then clear — because the grant was an idempotent PUT and
		// a duplicate delivery rewrote the identical row. Credits ACCUMULATE, so
		// that order would have turned Stripe's at-least-once delivery into
		// at-least-once billing: five deliveries of one event, fifty credits.
		//
		// So the claim comes first and it is a conditional delete, which means two
		// deliveries racing each other cannot both win. A duplicate finds nothing
		// left to claim and adds nothing.
		const claimed = await claimPendingPurchase(doc, reference, Math.floor(Date.now() / 1000));
		if (!claimed) return json(200, { received: true });

		try {
			await addCredits(doc, claimed.product, claimed.pairwise, creditsFor(claimed.product));
		} catch (e) {
			// The one hole this order opens: a claim that succeeded and a credit that
			// did not leaves someone who paid with nothing. So put the row back with
			// its ORIGINAL deadline — not a fresh hour, which would quietly extend
			// the window in which Stripe's reference is still translatable to a
			// person — and answer non-2xx so Stripe retries into it.
			await putPendingPurchase(doc, {
				nonce: reference,
				product: claimed.product,
				pairwise: claimed.pairwise,
				expiresAt: claimed.expiresAt
			}).catch(() => {});
			throw e;
		}

		return json(200, { received: true });
	}

	return { checkout, webhook };
}

// Exported for the runbook's sake: the fingerprint of a webhook secret, so Matt
// can confirm which secret a deployed function is holding without printing it.
export const secretFingerprint = (s) =>
	s ? createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 8) : 'unset';
