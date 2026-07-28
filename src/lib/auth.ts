// Sign-in against the mattOS Cognito pool, by hand and with no SDK.
//
// The whole flow is authorization code + PKCE against the hosted UI. That is
// roughly eighty lines here versus a dependency that would pull in analytics
// hooks, a credential cache, and a global store — none of which this product
// wants inside its bundle. `connect-src` in vite.config.ts has to name the two
// origins below, so a dependency that quietly called a third would be blocked
// by CSP anyway.
//
// WHAT IS KEPT IN THE BROWSER, AND WHERE:
//   sessionStorage  the refresh token and the current ID token
//   sessionStorage  the PKCE verifier, deleted the moment the code is exchanged
// sessionStorage rather than localStorage: closing the tab ends the session,
// which is the behavior someone using a self-destructing-notes product would
// expect if they thought about it. Nothing about an account is written to a
// cookie, so no note request can carry one.

const HOSTED_UI = import.meta.env.VITE_IDENTITY_HOSTED_UI ?? '';
const CLIENT_ID = import.meta.env.VITE_IDENTITY_CLIENT_ID ?? '';
const API_BASE = import.meta.env.VITE_IDENTITY_API_BASE ?? '';

// Cognito's provider names, exactly as template.yaml declares them.
export type Provider = 'SignInWithApple' | 'Google';

const VERIFIER_KEY = 'cinder.pkce';
const TOKENS_KEY = 'cinder.tokens';

export const identityConfigured = () => Boolean(HOSTED_UI && CLIENT_ID && API_BASE);

const redirectUri = () => `${location.origin}/account`;

const b64url = (bytes: ArrayBuffer) =>
	btoa(String.fromCharCode(...new Uint8Array(bytes)))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');

// PKCE S256. The verifier never leaves this browser; the server only ever sees
// its hash, so an intercepted authorization code is useless without the tab
// that started the flow.
async function newChallenge(): Promise<{ verifier: string; challenge: string }> {
	const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return { verifier, challenge: b64url(digest) };
}

type Tokens = { idToken: string; refreshToken: string };

const readTokens = (): Tokens | null => {
	try {
		return JSON.parse(sessionStorage.getItem(TOKENS_KEY) ?? 'null');
	} catch {
		return null;
	}
};

export const signedIn = () => readTokens() !== null;

// Send the browser to Apple or Google. `identity_provider` skips Cognito's
// provider-chooser screen, so the button says Apple and the next thing on the
// screen is Apple — no intermediate page asking again.
export async function startSignIn(provider: Provider): Promise<void> {
	const { verifier, challenge } = await newChallenge();
	sessionStorage.setItem(VERIFIER_KEY, verifier);

	const url = new URL('/oauth2/authorize', HOSTED_UI);
	url.search = new URLSearchParams({
		response_type: 'code',
		client_id: CLIENT_ID,
		redirect_uri: redirectUri(),
		// openid only. Asking for `email` here would populate the directory with
		// an address the pool is otherwise built never to hold.
		scope: 'openid',
		identity_provider: provider,
		code_challenge_method: 'S256',
		code_challenge: challenge
	}).toString();

	location.assign(url.toString());
}

// Exchange the authorization code for tokens. Returns false for every failure —
// a wrong code, a replayed code, a missing verifier — because the page has the
// same thing to say in all of them.
export async function completeSignIn(code: string): Promise<boolean> {
	const verifier = sessionStorage.getItem(VERIFIER_KEY);
	// One use, always. Removed before the request rather than after, so a failed
	// exchange cannot be retried with the same verifier.
	sessionStorage.removeItem(VERIFIER_KEY);
	if (!verifier) return false;

	const res = await fetch(new URL('/oauth2/token', HOSTED_UI), {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			client_id: CLIENT_ID,
			code,
			redirect_uri: redirectUri(),
			code_verifier: verifier
		})
	});
	if (!res.ok) return false;

	const body = (await res.json()) as { id_token?: string; refresh_token?: string };
	if (!body.id_token || !body.refresh_token) return false;
	sessionStorage.setItem(
		TOKENS_KEY,
		JSON.stringify({ idToken: body.id_token, refreshToken: body.refresh_token })
	);
	return true;
}

// ID tokens live five minutes, so any session older than that needs a refresh
// before the entitlement check. Refreshing is also how sign-out on another
// device takes effect here: a revoked refresh token fails, and this clears.
// Exported for src/lib/entitlement.ts, which needs the same token to mint a
// capability grant. Exported rather than duplicated: there is one place in this
// browser that decides whether a session is still live, and a second copy of
// that decision is a second thing to get wrong.
export async function freshIdToken(): Promise<string | null> {
	const tokens = readTokens();
	if (!tokens) return null;

	const res = await fetch(new URL('/oauth2/token', HOSTED_UI), {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			client_id: CLIENT_ID,
			refresh_token: tokens.refreshToken
		})
	});
	if (!res.ok) {
		// Revoked, expired, or deleted at the origin. Whatever the reason, this
		// browser is no longer signed in and must stop believing it is.
		sessionStorage.removeItem(TOKENS_KEY);
		return null;
	}

	const body = (await res.json()) as { id_token?: string };
	if (!body.id_token) return null;
	sessionStorage.setItem(TOKENS_KEY, JSON.stringify({ ...tokens, idToken: body.id_token }));
	return body.id_token;
}

// The one question this whole layer exists to answer, and under prepaid credits
// it has a number in it: how many large sends are left.
//
// Zero for every failure — signed out, a token the server would not verify, an
// unreachable API. A wrong "you have none" is a person told to top up when they
// did not have to; a wrong "you have some" is a send that fails after the file
// is already encrypted. The first is the better of the two to be wrong about.
export type Entitlement = { entitled: boolean; credits: number };

export async function entitlement(): Promise<Entitlement> {
	const none: Entitlement = { entitled: false, credits: 0 };
	const idToken = await freshIdToken();
	if (!idToken) return none;

	const res = await fetch(`${API_BASE}/entitlement`, {
		method: 'POST',
		headers: { authorization: `Bearer ${idToken}` }
	});
	if (!res.ok) return none;

	const body = (await res.json()) as { entitled?: boolean; credits?: number };
	const credits = Number.isFinite(body.credits) ? Math.max(0, Math.trunc(body.credits!)) : 0;
	// `entitled` is the server's own answer, not a comparison recomputed here:
	// one place decides what a balance means and it is the place that holds it.
	return { entitled: body.entitled === true, credits };
}

/** The same question with the number dropped, for screens that only need yes/no. */
export const isEntitled = async (): Promise<boolean> => (await entitlement()).entitled;

// Start a purchase. Returns the Stripe-hosted checkout URL, or null.
//
// null covers every refusal with one answer: not signed in, a token the server
// would not verify, or a product with no configured price. Having credits
// already is NOT a refusal — buying again is a top-up, the balance accumulates,
// and nothing is charged for twice.
//
// The caller NAVIGATES to this URL; it is never fetched, framed, or proxied.
// Cinder's page does not render a card field, does not touch one, and could not
// read one if it tried: the fields belong to checkout.stripe.com, a different
// origin, and this site's CSP names no frame-src at all.
export async function startCheckout(): Promise<string | null> {
	const idToken = await freshIdToken();
	if (!idToken) return null;

	const res = await fetch(`${API_BASE}/purchase/checkout`, {
		method: 'POST',
		headers: { authorization: `Bearer ${idToken}` }
	});
	if (!res.ok) return null;
	const body = (await res.json()) as { url?: string | null };
	return typeof body.url === 'string' ? body.url : null;
}

// Sign out: revoke the refresh token at Cognito, then forget everything here.
// The revocation is what matters — it is the only part that survives this tab.
// The ID token cannot be recalled and simply dies within five minutes.
export async function signOut(): Promise<void> {
	const tokens = readTokens();
	sessionStorage.removeItem(TOKENS_KEY);
	sessionStorage.removeItem(VERIFIER_KEY);
	if (!tokens) return;

	await fetch(new URL('/oauth2/revoke', HOSTED_UI), {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ client_id: CLIENT_ID, token: tokens.refreshToken })
		// A failed revoke is not worth surfacing: this browser has already
		// forgotten the token, and the refresh token expires in seven days.
	}).catch(() => {});
}

// Delete the account at the origin. Returns false if nothing was deleted, which
// the page must not present as success.
export async function deleteAccount(): Promise<boolean> {
	const idToken = await freshIdToken();
	if (!idToken) return false;

	const res = await fetch(`${API_BASE}/account/delete`, {
		method: 'POST',
		headers: { authorization: `Bearer ${idToken}` }
	});
	const deleted = res.ok && ((await res.json()) as { deleted?: boolean }).deleted === true;
	if (deleted) {
		sessionStorage.removeItem(TOKENS_KEY);
		sessionStorage.removeItem(VERIFIER_KEY);
	}
	return deleted;
}
