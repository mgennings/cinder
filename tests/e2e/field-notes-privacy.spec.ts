import { test, expect } from '@playwright/test';

// The executable form of the field-note read promise, asserted against the
// RENDERED page rather than against the source that is supposed to produce it.
//
// This covers everything inside the browser and nothing outside it. The edge
// half — CloudFront and S3 access logs, which no page assertion can observe —
// is guarded by src/routes/field-notes/privacy-claim.test.ts, and the sentence
// both halves defend lives in src/lib/field-note-privacy.ts.
//
// The failure this suite exists to catch is somebody later adding an analytics
// snippet, a hosted font, or a "remember where you were reading" localStorage
// write, all of which are individually reasonable and all of which break the
// published claim.

import { READ_PRIVACY_CLAIM } from '../../src/lib/field-note-privacy';

const ROUTES = ['/field-notes', '/field-notes/the-vote-to-stay-blind'];

for (const route of ROUTES) {
	test(`${route} fetches nothing from another host`, async ({ page, baseURL }) => {
		const foreign: string[] = [];
		page.on('request', (request) => {
			const url = request.url();
			// data: and blob: are the page addressing itself, not a network hop.
			if (url.startsWith('data:') || url.startsWith('blob:')) return;
			if (!url.startsWith(baseURL!)) foreign.push(`${request.resourceType()} ${url}`);
		});

		await page.goto(route, { waitUntil: 'networkidle' });

		expect(foreign).toEqual([]);
	});

	test(`${route} sets no cookie and writes nothing to storage`, async ({ page, context }) => {
		// Wrapping setItem catches a write that is made and then removed, which
		// an end-state check of localStorage.length would report as clean.
		await page.addInitScript(() => {
			const writes: string[] = [];
			(window as unknown as { __storageWrites: string[] }).__storageWrites = writes;
			const setItem = Storage.prototype.setItem;
			Storage.prototype.setItem = function (key: string, value: string) {
				writes.push(key);
				return setItem.call(this, key, value);
			};
		});

		await page.goto(route, { waitUntil: 'networkidle' });

		expect(await context.cookies()).toEqual([]);
		expect(
			await page.evaluate(
				() => (window as unknown as { __storageWrites: string[] }).__storageWrites
			)
		).toEqual([]);
		expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
	});

	test(`${route} loads no web font`, async ({ page }) => {
		await page.goto(route);

		// Note what is NOT asserted: the computed font-family. app.css names
		// 'Inter' first and never ships an @font-face for it, so a reader who
		// happens to have Inter installed locally renders in Inter with no
		// request made. Asserting the computed family would fail on that machine
		// while proving nothing about privacy. What matters is that no font is
		// FETCHED, and an @font-face rule is the only way one could be.
		const fontFaceRules = await page.evaluate(
			() =>
				[...document.styleSheets]
					.flatMap((sheet) => {
						try {
							return [...sheet.cssRules];
						} catch {
							// A stylesheet this origin cannot read would itself be a
							// third-party stylesheet, which the request test above
							// already fails on.
							return [];
						}
					})
					.filter((rule) => rule.constructor.name === 'CSSFontFaceRule').length
		);

		expect(fontFaceRules).toBe(0);
		expect(await page.evaluate(() => document.fonts.size)).toBe(0);
	});

	test(`${route} ships a policy that pins every fetch to this origin`, async ({ page }) => {
		const response = await page.goto(route);

		// SvelteKit delivers the SAME policy by two different transports, and
		// which one you get depends on the environment this spec is pointed at.
		// The dev server sends a `content-security-policy` RESPONSE HEADER and no
		// meta tag; the adapter-static build emits a hashed `<meta>` tag and no
		// header, because CloudFront never adds one (template.yaml's
		// SiteHeadersPolicy carries HSTS and frame-ancestors, not CSP). A spec
		// that reads only one of the two passes in one environment and is blind
		// in the other, so this reads every policy present and requires one.
		const fromMeta = await page
			.locator('meta[http-equiv="content-security-policy" i]')
			.evaluateAll((tags) => tags.map((tag) => tag.getAttribute('content')));

		const policies = [response?.headers()['content-security-policy'], ...fromMeta].filter(
			(policy): policy is string => Boolean(policy)
		);

		expect(policies.length, 'this page carries no Content-Security-Policy at all').toBeGreaterThan(
			0
		);

		for (const policy of policies) {
			const directives = new Map(
				policy.split(';').map((part) => {
					const [name, ...sources] = part.trim().split(/\s+/);
					return [name, sources];
				})
			);

			expect(directives.get('default-src')).toEqual(["'none'"]);
			expect(directives.get('font-src')).toEqual(["'self'"]);
			expect(directives.get('img-src')).toEqual(["'self'", 'data:']);

			// script-src carries 'self' plus SvelteKit's inline-bootstrap hashes,
			// whose value changes every build. Assert the property that matters
			// rather than the exact list: nothing in it is an origin.
			const scriptSrc = directives.get('script-src') ?? [];
			expect(scriptSrc).toContain("'self'");
			expect(scriptSrc.filter((source) => !source.startsWith("'"))).toEqual([]);
		}
	});

	test(`${route} publishes the claim these tests prove`, async ({ page }) => {
		await page.goto(route);
		await expect(page.getByText(READ_PRIVACY_CLAIM)).toBeVisible();
	});
}
