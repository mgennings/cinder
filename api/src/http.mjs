// The one JSON response shape, for every route in both APIs.
//
// It was written three times — once in handlers.mjs, once in entitlement.mjs,
// once in purchase.mjs — by three lanes that each needed the same headers. Three
// copies of a security header set is three places to forget one, and the one
// most likely to be forgotten is the one that matters most here.
//
// Every response either API produces is one-shot and secret-adjacent: a burned
// note's body IS the plaintext-bearing ciphertext, a capability grant is a
// bearer token, and a balance is the only number an account has. None of it may
// be cached, sniffed into another content type, or carried into a referrer.

export const json = (statusCode, obj) => ({
	statusCode,
	headers: {
		'content-type': 'application/json',
		'cache-control': 'no-store, private',
		'x-content-type-options': 'nosniff',
		'referrer-policy': 'no-referrer'
	},
	body: JSON.stringify(obj)
});
