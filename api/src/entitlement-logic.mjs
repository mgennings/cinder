// Pure purchase logic — no AWS SDK, no network, no product names. Everything
// here is a decision about a Stripe event, testable with node:test and zero
// dependencies, the same posture as identity.mjs and s3-errors.mjs.
//
// PORTABLE. Nothing in this file knows what Cinder is. A second mattOS product
// on a second domain reuses it unchanged.

import { createHmac, timingSafeEqual } from 'node:crypto';

// Stripe's own tolerance for its timestamps. A request older than this is a
// replay of a captured delivery rather than a live one.
const SIGNATURE_TOLERANCE_SECONDS = 300;

// Verify a Stripe webhook signature without the SDK. The Stripe-Signature
// header is `t=<unix_ts>,v1=<hex_hmac>[,v1=<hex_hmac>…]` and the signed payload
// is `${t}.${rawBody}`. `now` is injectable so the replay window is testable.
//
// The RAW body is what gets signed, so this must run before anything parses it.
// Re-serializing parsed JSON and verifying that is the classic way to make this
// check pass on a body nobody actually received.
//
// Deviation from undertext's version, deliberate: Stripe sends MORE THAN ONE v1
// while a webhook secret is being rotated, and undertext's `Object.fromEntries`
// keeps only the last, so during a rotation it silently rejects every event
// signed with the other secret. We collect all v1 values and accept any match.
export function verifyStripeSignature(rawBody, sigHeader, secret, now = Date.now()) {
	if (typeof rawBody !== 'string' || !sigHeader || !secret) return false;

	let t = null;
	const candidates = [];
	for (const part of String(sigHeader).split(',')) {
		const eq = part.indexOf('=');
		if (eq < 0) return false; // malformed — refuse rather than guess
		const name = part.slice(0, eq).trim();
		const value = part.slice(eq + 1).trim();
		if (name === 't') t = value;
		else if (name === 'v1') candidates.push(value);
	}
	// A v0 signature (Stripe's thin-payload scheme) is deliberately not accepted:
	// it signs a different payload, and treating an absent v1 as "try v0" would
	// mean a header that omits v1 gets a second chance to be believed.
	if (!t || !/^\d+$/.test(t) || candidates.length === 0) return false;

	// The replay window. A captured request replayed an hour later fails here
	// even though its signature is genuinely Stripe's, and that is the only thing
	// standing between someone holding one logged request body and an unlimited
	// grant machine.
	if (Math.abs(now / 1000 - Number(t)) > SIGNATURE_TOLERANCE_SECONDS) return false;

	const expected = Buffer.from(
		createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex'),
		'utf8'
	);

	// Constant time, with the length check first so timingSafeEqual cannot throw.
	// `some` short-circuits, which leaks only how many v1 values were presented —
	// a number the caller chose themselves.
	return candidates.some((v1) => {
		const got = Buffer.from(v1, 'utf8');
		return got.length === expected.length && timingSafeEqual(got, expected);
	});
}

// The two events that can mean money settled. `checkout.session.completed` also
// fires for UNPAID asynchronous methods (ACH, SEPA, BNPL, OXXO), so the type
// alone grants nothing — isPaidSession below is the gate that matters.
// `async_payment_succeeded` is the later event for those, once money lands.
const SETTLING_EVENTS = new Set([
	'checkout.session.completed',
	'checkout.session.async_payment_succeeded'
]);

export const isSettlingEvent = (type) => SETTLING_EVENTS.has(type);

// Paid, or legitimately nothing to charge (a 100%-off comp). Anything else,
// including `unpaid`, `no_payment_required`'s absence, and anything
// unrecognized, is false.
export function isPaidSession(session) {
	const s = session?.payment_status;
	return s === 'paid' || s === 'no_payment_required';
}

// What a settling event is allowed to grant.
//
// The reference is a nonce THIS server minted and handed to Stripe when it
// created the session. It is the only thing read out of the event, and it is not
// a claim about a product — it is a lookup key into a row that already knows
// which product and which person. So an event describing some other product, or
// carrying attacker-chosen metadata, resolves to a nonce that matches no row and
// grants nothing. Nothing in the payload is ever believed on its own terms.
export function purchaseReference(payload) {
	if (!isSettlingEvent(payload?.type)) return null;
	const session = payload?.data?.object;
	if (!isPaidSession(session)) return null;
	const ref = session?.client_reference_id;
	// Bounded before it becomes a hash input, so an oversized body cannot turn
	// into work. The nonce is a 43-character base64url capability.
	return typeof ref === 'string' && ref.length > 0 && ref.length <= 128 ? ref : null;
}
