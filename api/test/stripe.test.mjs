import assert from 'node:assert/strict';
import test from 'node:test';

import { createCheckoutSession } from '../src/stripe.mjs';

test('checkout explicitly keeps Cinder as merchant of record', async () => {
	let request;
	const fetchImpl = async (url, options) => {
		request = { url, options };
		return new Response(JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/cs_live_test' }));
	};

	await createCheckoutSession({
		secretKey: 'rk_live_test',
		price: 'price_live_test',
		reference: 'opaque-reference',
		successUrl: 'https://cinder.ink/pro/done',
		cancelUrl: 'https://cinder.ink/pro',
		fetchImpl
	});

	const body = new URLSearchParams(request.options.body);
	assert.equal(body.get('managed_payments[enabled]'), 'false');
	assert.equal(body.get('line_items[0][price]'), 'price_live_test');
	assert.equal(body.get('client_reference_id'), 'opaque-reference');
	assert.equal(body.has('customer'), false);
	assert.equal(body.has('customer_email'), false);
	assert.equal(request.options.headers['idempotency-key'], 'opaque-reference');
});
