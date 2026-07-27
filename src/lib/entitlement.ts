// THE CLIENT SEAM, and the mirror of api/src/entitlement-provider.mjs.
//
// The sender needs one thing before creating a transfer larger than the free
// ceiling: an opaque grant string to put in the request body. Not a token, not a
// session, not an account id — a bearer capability that says what may be done
// and nothing about who is doing it.
//
// It fails closed everywhere: not signed in, not entitled, identity API down,
// malformed answer — all of them return null, the server refuses with 402, and
// the page says "this needs Cinder Pro." It never throws, because a checkout
// problem must not become an unhandled error on the send page.
//
// Portable: a second mattOS product imports the same function with its own
// capability name. Only the capability constant below is Cinder's.

import { freshIdToken } from './auth';

/** Must match CAPABILITY.MULTIPART_TRANSFER in api/src/capabilities.mjs. */
export const CAPABILITY_MULTIPART_TRANSFER = 'transfer.multipart';

const API_BASE = import.meta.env.VITE_IDENTITY_API_BASE ?? '';

// Set only by the local dev server and the e2e suite (see playwright.config.ts
// and scripts/dev-api.mjs), so the chunked path can be exercised without an
// identity server running at all.
//
// This is safe to leave in the shipped bundle even if someone sets it in a
// production build, and the reason is structural rather than careful: the
// SERVER's gate is api/src/entitlement-provider.mjs, which verifies an HMAC
// against a secret this browser does not have. A grant string the server does
// not honor is a string. The client cannot grant itself anything, which is the
// property a capability gate has to have.
const DEV_GRANT: string | null = import.meta.env.VITE_DEV_CAPABILITY_GRANT ?? null;

// One cached grant per capability, with the moment it stops being usable.
//
// Cached because this runs on every large send and a round trip per send is a
// delay with no purpose. Expired a little EARLY — the server mints a 15-minute
// grant and this treats it as 14 — because the gate is checked when the create
// request lands, not when the grant was fetched, and a grant that expires in the
// flight between the two would fail a send the person already paid for.
const EARLY_SECONDS = 60;
const cache = new Map<string, { grant: string; usableUntilMs: number }>();

/** Test seam. Nothing in the product calls this; the vitest suite does. */
export const forgetCachedGrants = () => cache.clear();

export async function capabilityGrant(capability: string): Promise<string | null> {
	const cached = cache.get(capability);
	if (cached && Date.now() < cached.usableUntilMs) return cached.grant;

	try {
		const idToken = API_BASE ? await freshIdToken() : null;
		if (idToken) {
			const res = await fetch(`${API_BASE}/capability`, {
				method: 'POST',
				headers: { authorization: `Bearer ${idToken}`, 'content-type': 'application/json' },
				body: JSON.stringify({ capability })
			});
			if (res.ok) {
				const body = (await res.json()) as { grant?: string | null; expiresIn?: number };
				// Both fields or neither. A grant with no stated lifetime would have to
				// be cached on a guess, and guessing long is how a paid send starts
				// failing silently once the server's TTL changes.
				if (typeof body.grant === 'string' && body.grant && Number.isFinite(body.expiresIn)) {
					const usableUntilMs = Date.now() + Math.max(body.expiresIn! - EARLY_SECONDS, 0) * 1000;
					cache.set(capability, { grant: body.grant, usableUntilMs });
					return body.grant;
				}
			}
		}
	} catch {
		// Unreachable identity API, a CSP refusal, an aborted navigation. The
		// answer is the same as "not entitled", and it is the safe one.
	}

	return DEV_GRANT;
}
