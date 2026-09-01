import { describe, it, expect } from 'vitest';
import {
	buildLink,
	buildFileLink,
	buildTransferLink,
	parseFragmentKey,
	parseFragmentParts,
	derivePartLocator,
	deriveSegmentLocator
} from './link';

describe('link', () => {
	it('builds a note link with fragment', () => {
		expect(buildLink('https://blip.site', 'abc', 'KEY')).toBe('https://blip.site/n/abc#KEY');
	});

	it('builds a file link on its own route', () => {
		// Files get /f/ so the reader page knows which protocol to speak from the
		// URL alone. Discovering it by asking the server would mean a request on
		// link arrival, which is exactly what the bot-safe design forbids.
		expect(buildFileLink('https://cinder.ink', 'LOC', 'KEY')).toBe('https://cinder.ink/f/LOC#KEY');
	});

	it('parses the fragment key', () => {
		expect(parseFragmentKey('#KEY')).toBe('KEY');
		expect(parseFragmentKey('')).toBe('');
	});

	it('keeps the key out of everything a server can see', () => {
		const key = 'SECRET_KEY_MATERIAL';
		for (const link of [
			buildLink('https://cinder.ink', 'abc', key),
			buildFileLink('https://cinder.ink', 'abc', key)
		]) {
			const url = new URL(link);
			// The request line is pathname + search. Browsers never transmit hash.
			expect(url.pathname).not.toContain(key);
			expect(url.search).toBe('');
			expect(url.hash).toBe(`#${key}`);
			expect(parseFragmentKey(url.hash)).toBe(key);
		}
	});

	it('carries the part count in the fragment, never the path', () => {
		const link = buildTransferLink('https://cinder.ink', 'LOC', 'KEY', 12);
		expect(link).toBe('https://cinder.ink/f/LOC#KEY.12');
		const url = new URL(link);
		// The count is the recipient's, not the server's. It rides in the one part
		// of a URL a browser never transmits.
		expect(url.pathname).toBe('/f/LOC');
		expect(url.search).toBe('');
		expect(parseFragmentKey(url.hash)).toBe('KEY');
		expect(parseFragmentParts(url.hash)).toBe(12);
	});

	it('falls back to the plain file link for a single part', () => {
		expect(buildTransferLink('https://cinder.ink', 'LOC', 'KEY', 1)).toBe(
			'https://cinder.ink/f/LOC#KEY'
		);
		// Every link already in the wild has no suffix and must read as one part.
		expect(parseFragmentParts('#KEY')).toBe(1);
		expect(parseFragmentParts('')).toBe(1);
	});

	it('treats a nonsense part count as one part rather than trusting it', () => {
		for (const hash of ['#KEY.', '#KEY.0', '#KEY.-4', '#KEY.abc', '#KEY.1.5']) {
			expect(parseFragmentParts(hash)).toBe(1);
			expect(parseFragmentKey(hash)).toBe('KEY');
		}
	});

	it('derives part locators identically to the server', async () => {
		// These are not guesses. They are the output of deriveChunkLocator in
		// api/src/id.mjs, pasted in. If the browser and the server ever disagree
		// about this string, every part answers 410 and a whole transfer is lost
		// to a typo — so the agreement is pinned here rather than assumed.
		expect(await derivePartLocator('the-transfer-locator', 0)).toBe(
			'EZs_axYFbYFTg6Q4tTLX93h2MjtjYayJ1sFr3neNrkU'
		);
		expect(await derivePartLocator('the-transfer-locator', 1)).toBe(
			'PXYZFNtL5h25OK5daKVzSGE3Yr3om0ZB_z5aRAWa-rY'
		);
		expect(await derivePartLocator('the-transfer-locator', 7)).toBe(
			'FaZ0Hg0YQz37DVi3oZLWtjnq1LGol1pfFh_q-2H78nM'
		);
	});

	it('derives video segment locators identically to parts, and to the server', async () => {
		// The design doc's rule: video segments REUSE the part derivation rather
		// than inventing a third one. The constants below are the output of
		// deriveSegmentLocator in api/src/id.mjs, and they are the same bytes the
		// part test above pins — that sameness is the contract, not an accident.
		// If this test ever needs different constants from the part test, the
		// reuse has been broken and every video segment will answer 410.
		expect(await deriveSegmentLocator('the-transfer-locator', 0)).toBe(
			'EZs_axYFbYFTg6Q4tTLX93h2MjtjYayJ1sFr3neNrkU'
		);
		expect(await deriveSegmentLocator('the-transfer-locator', 127)).toBe(
			await derivePartLocator('the-transfer-locator', 127)
		);
	});

	it('produces base64url part locators that are safe in a path', async () => {
		const l = await derivePartLocator('another-locator', 3);
		expect(l).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(encodeURIComponent(l)).toBe(l);
	});
});
