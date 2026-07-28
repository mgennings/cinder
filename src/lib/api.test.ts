import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	checkTransferStatus,
	claimFile,
	TransferGoneError,
	DeliveryFailedError,
	TransferBusyError
} from './api';

// The single most consequential branch in the client: telling "we never
// started" apart from "we started and it is gone forever."
//
// These two used to be the same code path. Every non-410 refusal rendered as
// permanent destruction, so a throttled request — which never reaches the
// Lambda and therefore never runs the atomic claim — told the recipient their
// file had been destroyed while it sat untouched in S3. Reserved concurrency
// made shedding more likely, so the lie got more frequent, not less.

function respondWith(init: { status: number; body?: BodyInit | null }) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(init.body ?? null, { status: init.status }))
	);
}

afterEach(() => vi.unstubAllGlobals());

describe('claimFile error mapping', () => {
	it('treats 410 as genuinely gone', async () => {
		respondWith({ status: 410, body: '{"error":"gone"}' });
		await expect(claimFile('loc')).rejects.toBeInstanceOf(TransferGoneError);
	});

	// Measured against production: a 200-request burst produced 189 × 503 with
	// Throttles 286, Invocations 27, Errors 0. A shed request does not enter the
	// function, so the grant is intact and the link still works.
	it.each([429, 502, 503, 504])('treats %i as busy, never as destroyed', async (status) => {
		respondWith({ status });
		const err = await claimFile('loc').catch((e) => e);
		expect(err).toBeInstanceOf(TransferBusyError);
		expect(err).not.toBeInstanceOf(DeliveryFailedError);
	});

	// A 500 means the handler DID run and threw, which can happen after the
	// atomic claim. That one really is spent.
	it('treats 500 as a spent delivery', async () => {
		respondWith({ status: 500 });
		await expect(claimFile('loc')).rejects.toBeInstanceOf(DeliveryFailedError);
	});

	// Genuinely ambiguous, and resolved in the direction that self-corrects: if
	// it really was consumed, retrying returns 410 and says so truthfully.
	// Guessing "destroyed" would make someone abandon a file that is still there.
	it('treats a dead connection as busy rather than guessing destruction', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new TypeError('Failed to fetch');
			})
		);
		await expect(claimFile('loc')).rejects.toBeInstanceOf(TransferBusyError);
	});

	it('returns the ciphertext on success', async () => {
		respondWith({ status: 200, body: new Uint8Array([1, 2, 3]) });
		expect(Array.from(await claimFile('loc'))).toEqual([1, 2, 3]);
	});
});

describe('sender status check', () => {
	it('sends only the separate status token and accepts the two bounded states', async () => {
		const fetch = vi.fn(async () =>
			new Response(JSON.stringify({ status: 'available' }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetch);
		await expect(checkTransferStatus('sender-token')).resolves.toBe('available');
		expect(fetch).toHaveBeenCalledWith(
			expect.stringContaining('/files/status'),
			expect.objectContaining({ body: JSON.stringify({ statusToken: 'sender-token' }) })
		);
	});
});
