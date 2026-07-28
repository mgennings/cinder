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

import { bytesToBase64Url } from './crypto/codec';

const HOSTED_UI = import.meta.env.VITE_IDENTITY_HOSTED_UI ?? '';
const CLIENT_ID = import.meta.env.VITE_IDENTITY_CLIENT_ID ?? '';
const API_BASE = import.meta.env.VITE_IDENTITY_API_BASE ?? '';

// Cognito's provider names, exactly as template.yaml declares them.
export type Provider = 'SignInWithApple' | 'Google';

const VERIFIER_KEY = 'cinder.pkce';
const TOKENS_KEY = 'cinder.tokens';
const RETURN_KEY = 'cinder.returnto';

export const identityConfigured = () => Boolean(HOSTED_UI && CLIENT_ID && API_BASE);

const redirectUri = () => `${location.origin}/account`;

// The crypto layer's encoder rather than a third hand-rolled copy of the
// base64url alphabet. PKCE is exact about this: a verifier and its challenge
// that disagree by one padding character fail the exchange with an error that
// says nothing about which side got it wrong.
const b64url = (bytes: ArrayBuffer) => bytesToBase64Url(new Uint8Array(bytes));

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

/* WHERE THE PERSON WAS WHEN THEY DECIDED TO SIGN IN.

   The callback URL is fixed — Cognito will only redirect to a URL the app
   client already lists, and every one of those is `/account`. So somebody who
   pressed sign in on /pro used to complete Apple and land on an account page
   they never asked for, with the thing they were about to buy two clicks away.

   Kept in sessionStorage rather than round-tripped through OAuth `state`. The
   PKCE verifier already lives there and already binds this round trip to this
   one tab, so `state` would be a second copy of a guarantee that is already
   made — and a second thing to get wrong. If sessionStorage did not survive,
   the exchange would fail on the missing verifier before any of this mattered.

   Only a same-origin PATH is ever stored or honored. A returned absolute URL is
   an open redirect wearing a convenience feature's clothes, so one is never
   accepted, not even for this site's own origin. */
const safePath = (value: string | null | undefined): string | null => {
	if (!value) return null;

	/* The character checks below are the cheap first pass. They are NOT the
	   guarantee, because a blocklist of dangerous characters is a race against
	   whoever knows one more of them, and that race was already lost here once.

	   The URL parser STRIPS ASCII tab, line feed, and carriage return before it
	   resolves anything. So a path holding a tab passed the leading-slash check,
	   passed the protocol-relative check, passed the backslash check, and then
	   resolved to another origin entirely. Reproduced in a real browser, one
	   click, on a product whose whole promise is that you can trust where it
	   sends you. */
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f]/.test(value)) return null;
	// A leading `//` is protocol-relative and resolves to another host entirely.
	if (!value.startsWith('/') || value.startsWith('//')) return null;
	// `\` because some browsers normalize it to `/`, so a backslash host is the
	// same attack spelled differently.
	if (value.includes('\\')) return null;

	/* THE GUARANTEE, and the reason the list above no longer has to be complete.
	   Resolve the candidate against an origin that cannot exist and demand the
	   result still be on it. Anything that escapes, by a character nobody
	   thought of or a parser quirk nobody has published yet, changes the origin
	   and is refused here without having to be enumerated first. */
	try {
		const probe = 'https://cinder.invalid';
		const resolved = new URL(value, probe);
		if (resolved.origin !== probe) return null;
		return resolved.pathname + resolved.search + resolved.hash;
	} catch {
		return null;
	}
};

/** Read a `?next=` intent off the current URL, or null if it is not a safe path. */
export const intendedPath = (search: string): string | null =>
	safePath(new URLSearchParams(search).get('next'));

/** The pending destination, consumed. Null when there is not one. */
export function takeReturnTo(): string | null {
	const stored = safePath(sessionStorage.getItem(RETURN_KEY));
	sessionStorage.removeItem(RETURN_KEY);
	return stored;
}

/** The pending destination, left in place — for a retry after a failed sign-in. */
export const peekReturnTo = (): string | null => safePath(sessionStorage.getItem(RETURN_KEY));

// Send the browser to Apple or Google. `identity_provider` skips Cognito's
// provider-chooser screen, so the button says Apple and the next thing on the
// screen is Apple — no intermediate page asking again.
export async function startSignIn(provider: Provider, returnTo?: string | null): Promise<void> {
	const destination = safePath(returnTo);
	if (destination) sessionStorage.setItem(RETURN_KEY, destination);
	else sessionStorage.removeItem(RETURN_KEY);

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
/* Four different things can go wrong here and they used to be one `false`.
   That is how a real sign-in failure rendered as the ordinary signed-out page:
   the person completed Apple, came back, and the interface said nothing at all.
   Measured on the live site — a bad code produced zero network requests and a
   plain "Signed out." A journey that can fail silently is a journey nobody can
   debug, including the person living it.

   The reasons are separated because they need DIFFERENT words. "You signed in
   somewhere else" and "that link expired" are not the same problem and must not
   share a sentence. Nothing here exposes anything the person cannot already
   see; the code is single-use and already spent by the time any of this runs. */
export type SignInFailure =
	| 'no-verifier'
	| 'rejected'
	| 'incomplete'
	| 'offline';

export type SignInResult = { ok: true } | { ok: false; reason: SignInFailure; detail?: string };

export async function completeSignIn(code: string): Promise<SignInResult> {
	const verifier = sessionStorage.getItem(VERIFIER_KEY);
	// One use, always. Removed before the request rather than after, so a failed
	// exchange cannot be retried with the same verifier.
	sessionStorage.removeItem(VERIFIER_KEY);
	// The tab that started the sign-in is the only one holding the verifier.
	// On a phone this is the common failure: the provider hands the callback to
	// a fresh tab, and this one never had the secret.
	if (!verifier) return { ok: false, reason: 'no-verifier' };

	let res: Response;
	try {
		res = await fetch(new URL('/oauth2/token', HOSTED_UI), {
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
	} catch {
		// An uncaught throw here used to abort the caller's onMount before it
		// rendered anything, which is the worst version of this bug: a blank
		// decision with no state at all.
		return { ok: false, reason: 'offline' };
	}

	if (!res.ok) {
		// Cognito names the reason, and the name is worth keeping: `invalid_grant`
		// on a second visit to the same callback URL is a completely different
		// story from `invalid_client`, and only one of them is the person's doing.
		let detail: string | undefined;
		try {
			detail = ((await res.json()) as { error?: string }).error;
		} catch {
			detail = `HTTP ${res.status}`;
		}
		return { ok: false, reason: 'rejected', detail };
	}

	const body = (await res.json()) as { id_token?: string; refresh_token?: string };
	if (!body.id_token || !body.refresh_token) return { ok: false, reason: 'incomplete' };

	sessionStorage.setItem(
		TOKENS_KEY,
		JSON.stringify({ idToken: body.id_token, refreshToken: body.refresh_token })
	);
	return { ok: true };
}

/** What the person is told, per reason. One sentence, no blame, next step included. */
export function signInFailureMessage(reason: SignInFailure, detail?: string): string {
	switch (reason) {
		case 'no-verifier':
			return 'That sign-in finished in a different tab from the one that started it, so this tab could not complete it. Try again from here and stay in this tab.';
		case 'rejected':
			return detail === 'invalid_grant'
				? 'That sign-in link was already used, or it expired. Signing in again takes a second.'
				: 'The sign-in was refused before it finished. Nothing was created and nothing was charged.';
		case 'incomplete':
			return 'The sign-in came back missing part of its answer, so Cinder did not trust it. Try again.';
		case 'offline':
			return 'Cinder could not reach the sign-in service. Check the connection and try again.';
	}
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

/* THREE ANSWERS, NOT TWO, BECAUSE THE MIDDLE ONE HAS ITS OWN SENTENCE.

   `signedIn()` reads storage: it says a token was written here once. That is a
   different question from whether the origin still honors it, and the two used
   to collapse into one word. A refresh token revoked on another device, expired
   after seven days, or belonging to a deleted account all rendered as the plain
   signed-out page — so somebody who WAS signed in a minute ago was shown the
   same screen as somebody who never had been, with nothing to explain why the
   balance they were looking at vanished.

   'expired' is that gap named. It costs one network round trip that the page
   was already making. */
export type SessionState = 'none' | 'live' | 'expired';

export async function sessionState(): Promise<SessionState> {
	if (!signedIn()) return 'none';
	// freshIdToken clears storage itself when the origin refuses, so by the time
	// this returns, `signedIn()` already agrees with the answer given here.
	return (await freshIdToken()) ? 'live' : 'expired';
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
