// The mattOS identity API. Two routes, and between them they can say exactly
// two things: "this caller has this many prepaid sends left for this product"
// and "this account no longer exists."
//
//   POST /entitlement    → { entitled: boolean, credits: number }
//   POST /capability     → { grant: string|null, expiresIn: number|null }
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

import { randomBytes } from 'node:crypto';
import { bearerToken, verifyIdToken, pairwiseSubject, parseMap } from './identity.mjs';
import { readCredits, spendCredit, forgetEntitlement } from './entitlement-store.mjs';
import { mintCapabilityGrant } from './capability-grant.mjs';

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

// How long a minted grant lives. Short because it is a bearer capability that
// travels on an unauthenticated request: whoever holds the string may use it
// until it expires. Long enough that encrypting and uploading a 250 MB transfer
// on a slow connection finishes inside one grant, because the gate is asked at
// create and a grant expiring mid-upload would strand a paid send.
const GRANT_TTL_SECONDS = 900;

export function makeEntitlementHandlers(
	doc,
	{ getJwks, deleteUser, issuer, clientProducts, productPeppers, capabilitySecret, capabilityLimits }
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

	// The balance, and the only place it is ever legible. It is answered to the
	// signed-in person about their own account, over an authenticated request, on
	// the API that already knows who they are — which is exactly why it may be
	// said here and may NOT enter a capability grant, where a rare remaining
	// count would be a fingerprint across otherwise unlinkable transfers.
	//
	// `entitled` is kept alongside it, and it is simply `credits > 0`: the
	// question every screen actually asks is "can I send a large file right now",
	// and no caller should have to reimplement that comparison.
	async function checkEntitlement(event) {
		const who = await identify(event);
		if (!who) return json(200, { entitled: false, credits: 0 });
		const credits = await readCredits(doc, who.product, who.pairwise);
		return json(200, { entitled: credits > 0, credits });
	}

	// POST /capability — the only place a grant is ever created.
	//
	// This is the hinge of the whole design: the LAST moment identity exists in
	// the chain. Above this line there is a verified ID token, a pairwise subject,
	// and a database row. Below it there is a signed string that says "someone
	// entitled to transfer.multipart, with these limits, until this second" and
	// carries nothing else. capability-grant.mjs enforces that structurally — it
	// refuses to read a payload with any key beyond cap, limits, exp, and nonce —
	// so a later change that tries to smuggle a subject through produces a grant
	// the transfer API rejects rather than a linkable transfer.
	//
	// One negative answer for every refusal: no token, a forged token, a product
	// with no configured limits, no purchase. Telling them apart would be an
	// oracle and buys the caller nothing they can act on.
	//
	// THE CREDITS SEAM, now wired. This function spends one credit per grant and
	// nothing downstream can tell: the grant format, the gate, the transfer API,
	// and the client are all unaware of which pricing model is in force. What must
	// NOT move into the grant is the remaining balance — see the note in
	// capability-grant.mjs about a rare count being a fingerprint.
	async function mintCapability(event) {
		const nothing = json(200, { grant: null, expiresIn: null });

		let requested;
		try {
			requested = JSON.parse(event.body || '{}').capability;
		} catch {
			return nothing;
		}
		if (typeof requested !== 'string' || !requested) return nothing;

		const who = await identify(event);
		if (!who) return nothing;

		// Fail closed on a config gap, exactly as `identify` does for a missing
		// pepper: an unconfigured product or an unknown capability name denies
		// rather than falling back to a default set of limits.
		const limits = capabilityLimits?.[who.product]?.[requested];
		if (!limits || !capabilitySecret) return nothing;

		// THE CHARGE. One grant is one prepaid send, and this is the line that
		// spends it — the last authenticated moment in the chain, before any bytes
		// exist. Not at create (the transfer API has no subject and must never
		// acquire one), not at claim (the recipient would be triggering the
		// sender's charge), not at finalize (one transfer is many parts).
		//
		// It is atomic, so N mints racing against a balance of M hand out exactly M
		// grants. A false answer here is the ordinary end of a purchase — zero
		// credits is a state, not a fault — and it is the SAME silent negative that
		// an anonymous caller gets, because telling them apart would be an oracle.
		//
		// A retry never reaches this line: the client presents its cached grant,
		// byte for byte, and the gate verifies it again without a mint. That is the
		// property tests/journey/full-journey.spec.ts pins.
		if (!(await spendCredit(doc, who.product, who.pairwise))) return nothing;

		return json(200, {
			grant: mintCapabilityGrant({
				secret: capabilitySecret,
				capability: requested,
				limits,
				ttlSeconds: GRANT_TTL_SECONDS,
				// 256 bits, generated here, never derived from the subject. A derived
				// nonce would make two grants for the same person recognizable as
				// such, which is the exact join the pairwise subject exists to break.
				nonce: randomBytes(32).toString('base64url')
			}),
			expiresIn: GRANT_TTL_SECONDS
		});
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
	return { checkEntitlement, mintCapability, deleteAccount, identify };
}
