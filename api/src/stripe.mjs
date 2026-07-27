// The entire Stripe client, and it is one function.
//
// No `stripe` npm package. That dependency is ~1 MB of transitive code running
// inside a function that holds a live secret key, in a repo whose stated rule is
// that a clever dependency saving ten lines but adding a trust surface is a bad
// trade (CONTRIBUTING.md). Creating a Checkout Session is one form-encoded POST,
// and the webhook signature is an HMAC that node:crypto already computes. There
// is nothing left for a library to do.
//
// PORTABLE. Nothing here knows what Cinder is.

const API = 'https://api.stripe.com/v1/checkout/sessions';

/**
 * Create a one-time Checkout Session and return its hosted URL.
 *
 * `reference` is the opaque nonce that becomes client_reference_id, and it is
 * also the idempotency key: a retried call with the same nonce returns the SAME
 * session rather than creating a second one, so a client that fires twice cannot
 * produce two chances to pay.
 *
 * Deliberately NOT sent: customer, customer_email, or any field that would ask
 * Stripe to build a durable customer record. In `payment` mode Stripe's default
 * customer_creation is `if_required`, so a card charge with none of these creates
 * no Customer object at all. Stripe still sees the card and the email it collects
 * on its own page — that is unavoidable and the pay-point copy says so — but
 * nothing here asks it to keep a profile.
 */
export async function createCheckoutSession({
	secretKey,
	price,
	reference,
	successUrl,
	cancelUrl,
	fetchImpl = fetch
}) {
	const body = new URLSearchParams({
		mode: 'payment',
		'line_items[0][price]': price,
		'line_items[0][quantity]': '1',
		client_reference_id: reference,
		success_url: successUrl,
		cancel_url: cancelUrl
	});

	const res = await fetchImpl(API, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${secretKey}`,
			'content-type': 'application/x-www-form-urlencoded',
			'idempotency-key': reference
		},
		body: body.toString()
	});

	if (!res.ok) {
		// The response body carries Stripe's error message and can quote request
		// parameters back. It never reaches a caller and it is never logged — a
		// 500 with no detail is the correct amount to say about a payment
		// processor's refusal.
		throw new Error(`stripe checkout failed: ${res.status}`);
	}

	const session = await res.json();
	if (typeof session?.url !== 'string') throw new Error('stripe checkout returned no url');
	return session.url;
}
