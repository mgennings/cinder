import { describe, it, expect } from 'vitest';
import { buildLink, parseFragmentKey } from './link';

describe('link', () => {
	it('builds a note link with fragment', () => {
		expect(buildLink('https://blip.site', 'abc', 'KEY')).toBe('https://blip.site/n/abc#KEY');
	});

	it('parses the fragment key', () => {
		expect(parseFragmentKey('#KEY')).toBe('KEY');
		expect(parseFragmentKey('')).toBe('');
	});
});
