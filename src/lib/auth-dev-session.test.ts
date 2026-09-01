import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadAuth = async (instantSession: boolean) => {
	vi.resetModules();
	vi.stubEnv('VITE_IDENTITY_API_BASE', 'http://127.0.0.1:4100');
	vi.stubEnv('VITE_IDENTITY_HOSTED_UI', 'http://127.0.0.1:4100');
	vi.stubEnv('VITE_IDENTITY_CLIENT_ID', 'dev-cinder-client');
	vi.stubEnv('VITE_DEV_INSTANT_SESSION', instantSession ? '1' : '0');
	return import('./auth');
};

const malformedSuccess = () =>
	new Response('{"id_token":', {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});

const tokenSuccess = () =>
	new Response(JSON.stringify({ id_token: 'fresh-id-token', refresh_token: 'refresh-token' }), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});

describe('the explicit local-review session', () => {
	beforeEach(() => {
		sessionStorage.clear();
		vi.restoreAllMocks();
	});

	afterEach(() => vi.unstubAllEnvs());

	it('creates one real server session when the review build opts in', async () => {
		const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ id_token: 'signed-id-token', refresh_token: 'refresh-token' }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);
		const { reviewAccessEnabled, sessionState, signedIn } = await loadAuth(true);

		expect(reviewAccessEnabled()).toBe(true);
		await expect(sessionState()).resolves.toBe('live');
		expect(signedIn()).toBe(true);
		expect(request).toHaveBeenCalledOnce();
		expect(request.mock.calls[0]?.[0].toString()).toBe('http://127.0.0.1:4100/dev/session');
	});

	it('does nothing when an ordinary build has not opted in', async () => {
		const request = vi.spyOn(globalThis, 'fetch');
		const { reviewAccessEnabled, sessionState, signedIn } = await loadAuth(false);

		expect(reviewAccessEnabled()).toBe(false);
		await expect(sessionState()).resolves.toBe('none');
		expect(signedIn()).toBe(false);
		expect(request).not.toHaveBeenCalled();
	});

	it('fails closed when the review session answer is truncated', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(malformedSuccess());
		const { sessionState, signedIn } = await loadAuth(true);

		await expect(sessionState()).resolves.toBe('none');
		expect(signedIn()).toBe(false);
	});
});

describe('untrusted successful auth responses', () => {
	beforeEach(() => {
		sessionStorage.clear();
		vi.restoreAllMocks();
	});

	afterEach(() => vi.unstubAllEnvs());

	it('returns bounded failures for wrong-shaped and truncated token answers', async () => {
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response('null', { status: 200 }))
			.mockResolvedValueOnce(malformedSuccess());
		const { completeSignIn, freshIdToken } = await loadAuth(false);

		sessionStorage.setItem('cinder.pkce', 'verifier');
		await expect(completeSignIn('code')).resolves.toEqual({ ok: false, reason: 'incomplete' });

		sessionStorage.setItem(
			'cinder.tokens',
			JSON.stringify({ idToken: 'old-id-token', refreshToken: 'refresh-token' })
		);
		await expect(freshIdToken()).resolves.toBeNull();
	});

	it('fails closed for every malformed account API answer', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
			String(input).includes('/oauth2/token') ? tokenSuccess() : malformedSuccess()
		);
		const { entitlement, startCheckout, deleteAccount } = await loadAuth(false);
		sessionStorage.setItem(
			'cinder.tokens',
			JSON.stringify({ idToken: 'old-id-token', refreshToken: 'refresh-token' })
		);

		await expect(entitlement()).resolves.toEqual({ entitled: false, credits: 0 });
		await expect(startCheckout()).resolves.toBeNull();
		await expect(deleteAccount()).resolves.toBe(false);
	});
});
