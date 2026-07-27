// THE CLIENT SEAM, and the mirror of api/src/entitlement-provider.mjs.
//
// The sender needs one thing before creating a transfer larger than the free
// ceiling: an opaque grant string to put in the request body. Not a token, not a
// session, not an account id — a bearer capability that says what may be done
// and nothing about who is doing it.
//
// It ships returning null, which fails closed: the server refuses with 402 and
// the page says "this needs Cinder Pro." That is the correct behavior until the
// identity lane mints real grants, and it is also the correct behavior if
// minting ever breaks.
//
// What replacing this must satisfy:
//
//   - Ask the SEPARATE identity API (src/lib/auth.ts talks to it already) for a
//     grant for `capability`, using the signed-in session it holds.
//   - Return an opaque string, or null if the person is not entitled, not signed
//     in, or the identity API is unreachable. Never throw — a checkout problem
//     must not become an unhandled error on the send page.
//   - Never return anything derived from the person's identity. The grant is
//     about to travel on a request that Cinder deliberately keeps unlinkable to
//     an account, and putting a subject in it would undo that in one line.
//   - Cache it for its lifetime. This is called on every large send, and a
//     network round trip per send is a delay with no purpose.
//
// Portable: a second mattOS product imports the same function with its own
// capability name. Only the capability constant below is Cinder's.

/** Must match CAPABILITY.MULTIPART_TRANSFER in api/src/capabilities.mjs. */
export const CAPABILITY_MULTIPART_TRANSFER = 'transfer.multipart';

// Set only by the local dev server and the e2e suite (see playwright.config.ts
// and scripts/dev-api.mjs), so the chunked path can be exercised end to end
// before the identity lane exists.
//
// This is safe to leave in the shipped bundle even if someone sets it in a
// production build, and the reason is structural rather than careful: the
// SERVER's gate is api/src/entitlement-provider.mjs, which denies everything. A
// grant string the server does not honor is a string. The client cannot grant
// itself anything, which is the property a capability gate has to have.
const DEV_GRANT: string | null = import.meta.env.VITE_DEV_CAPABILITY_GRANT ?? null;

export async function capabilityGrant(_capability: string): Promise<string | null> {
	return DEV_GRANT;
}
