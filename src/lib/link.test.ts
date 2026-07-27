import { describe, it, expect } from 'vitest';
import { buildLink, buildFileLink, parseFragmentKey } from './link';

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
});
