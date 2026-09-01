import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadAuth = async (instantSession: boolean) => {
	vi.resetModules();
	vi.stubEnv('VITE_IDENTITY_API_BASE', 'http://127.0.0.1:4100');
	vi.stubEnv('VITE_IDENTITY_HOSTED_UI', 'http://127.0.0.1:4100');
	vi.stubEnv('VITE_IDENTITY_CLIENT_ID', 'dev-cinder-client');
	vi.stubEnv('VITE_DEV_INSTANT_SESSION', instantSession ? '1' : '0');
	return import('./auth');
};

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
		const { sessionState, signedIn } = await loadAuth(true);

		await expect(sessionState()).resolves.toBe('live');
		expect(signedIn()).toBe(true);
		expect(request).toHaveBeenCalledOnce();
		expect(request.mock.calls[0]?.[0].toString()).toBe('http://127.0.0.1:4100/dev/session');
	});

	it('does nothing when an ordinary build has not opted in', async () => {
		const request = vi.spyOn(globalThis, 'fetch');
		const { sessionState, signedIn } = await loadAuth(false);

		await expect(sessionState()).resolves.toBe('none');
		expect(signedIn()).toBe(false);
		expect(request).not.toHaveBeenCalled();
	});
});
