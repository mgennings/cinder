// The mattOS identity API. Two routes, and between them they can say exactly
// two things: "this caller is entitled to this product" and "this account no
// longer exists."
//
//   POST /entitlement    → { entitled: boolean }
//   POST /account/delete → { deleted: boolean }
//
// Deliberately a SEPARATE HTTP API from the note and file endpoints (see
// template.yaml). Cinder's own API refuses the Authorization header at CORS,
// so a browser cannot attach a token to a note request even by accident, and
// the two APIs do not share an access log. That is the structural half of "an
// account is never linkable to a note"; the other half is that a note carries
// no identity to link to in the first place.
//
// The product is derived from the token's audience — the app client that minted
// it — never from the request body. A caller cannot ask about a product it did
// not sign in to.

import { bearerToken, verifyIdToken, pairwiseSubject, parseMap } from './identity.mjs';
import { isEntitled, forgetEntitlement } from './entitlement-store.mjs';

// Both routes answer 200 with a negative body for every refusal: no token, a
// forged token, an expired token, a token from another pool, a token for an
// unconfigured client. A 401 here would distinguish "wrong token" from "no
// entitlement", which is the beginning of an oracle and buys the caller nothing
// they can act on.
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

export function makeEntitlementHandlers(
	doc,
	{ getJwks, deleteUser, issuer, clientProducts, productPeppers }
) {
	const clients = typeof clientProducts === 'string' ? parseMap(clientProducts) : clientProducts;
	const peppers = typeof productPeppers === 'string' ? parseMap(productPeppers) : productPeppers;

	// Verify, then resolve which product is asking. Returns null for every
	// failure — the caller must not be able to tell them apart.
	async function identify(event) {
		const token = bearerToken(event.headers || {});
		if (!token) return null;

		const claims = verifyIdToken(token, {
			jwks: await getJwks(),
			issuer,
			audiences: Object.keys(clients)
		});
		if (!claims) return null;

		const product = clients[claims.aud];
		const pepper = peppers[product];
		// Fail closed on a config gap. A product listed as a client but missing a
		// pepper must deny, not fall back to a shared or empty key.
		if (!product || !pepper) return null;

		return {
			product,
			username: claims.username,
			// `sub` stays inside this function's return so deleteAccount can derive
			// the OTHER products' pairwise subjects. It never reaches a response
			// body, a log line, or the database.
			sub: claims.sub,
			pairwise: pairwiseSubject(claims.sub, product, pepper)
		};
	}

	async function checkEntitlement(event) {
		const who = await identify(event);
		if (!who) return json(200, { entitled: false });
		return json(200, { entitled: await isEntitled(doc, who.product, who.pairwise) });
	}

	// Delete everything, at the origin.
	//
	// Order matters and it is the unforgiving direction: entitlement rows FIRST,
	// then the Cognito user. A row is keyed by an HMAC of the Cognito subject, so
	// once the user is gone nobody — including us — can compute that key again.
	// Deleting the user first would leave a row that is unreachable rather than
	// erased. If the Cognito delete then fails, the person keeps a signed-in
	// account with no entitlement and can retry; that is the recoverable failure,
	// and it is the one we choose to be on the wrong side of.
	//
	// This deletes rows for EVERY product whose pepper this function carries.
	// Adding a product to the pool without adding its pepper to PRODUCT_PEPPERS
	// leaves an orphan row that can never be deleted — see .notes/GOTCHAS.md.
	async function deleteAccount(event) {
		const who = await identify(event);
		if (!who) return json(200, { deleted: false });

		for (const [product, pepper] of Object.entries(peppers)) {
			await forgetEntitlement(doc, product, pairwiseSubject(who.sub, product, pepper));
		}

		// AdminDeleteUser removes the pool record AND the federated link to Apple
		// or Google with it. Nothing is retained, disabled, or archived: Cognito
		// has no soft delete, which is the property we want.
		await deleteUser(who.username);

		return json(200, { deleted: true });
	}

	// `identify` is returned as well as used, because the purchase lane
	// (purchase.mjs) needs exactly this answer and must not reimplement it. There
	// is one place in this codebase that decides who a caller is, and a second
	// copy of that decision is a second thing to get wrong. It stays a closure
	// over the same config, so a product missing a pepper denies in both lanes.
	return { checkEntitlement, deleteAccount, identify };
}
