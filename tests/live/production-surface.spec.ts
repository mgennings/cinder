import { test, expect } from '@playwright/test';

// The ONE Cinder production check the UXQA registry may run unattended.
// tests/live/live.spec.ts (create -> reveal -> destroy) proves the one-time
// lifecycle and stays a human, attended action — it is never registered.
// This file proves the surface is up, safely headed, and reachable, and it
// PROVES non-mutation rather than merely avoiding a click: every route is
// intercepted, and a POST/PUT/PATCH/DELETE aborts the request and fails the
// test immediately, so a future edit that adds an action here fails loudly
// instead of quietly mutating a real note store.
const FORBIDDEN_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Quick mode (default): the plan's declared smoke widths, 375 and 1440.
// Deep mode (CINDER_UXQA_MODE=deep): the complete declared matrix from the
// manifest at .uxqa.json. Both come from scripts/uxqa-matrix.mjs, which the
// evidence reporter reads too, so the reported matrix cannot drift from the
// one this file actually loops over.
import { COLOR_SCHEMES, WIDTHS } from '../../scripts/uxqa-matrix.mjs';

function guardNonMutating(page: import('@playwright/test').Page, blocked: string[]) {
	return page.route('**/*', (route) => {
		const method = route.request().method();
		if (FORBIDDEN_METHODS.has(method)) {
			blocked.push(`${method} ${route.request().url()}`);
			route.abort('blockedbyclient');
			return;
		}
		route.continue();
	});
}

for (const width of WIDTHS) {
	for (const colorScheme of COLOR_SCHEMES) {
		test(`LIVE non-mutating: ${width}px ${colorScheme} loads safely and never mutates`, async ({
			page
		}) => {
			const blocked: string[] = [];
			const consoleErrors: string[] = [];
			const pageErrors: string[] = [];

			await guardNonMutating(page, blocked);
			page.on('console', (msg) => {
				if (msg.type() === 'error') consoleErrors.push(msg.text());
			});
			page.on('pageerror', (err) => pageErrors.push(String(err)));

			await page.setViewportSize({ width, height: Math.max(640, Math.round(width * 1.4)) });
			await page.emulateMedia({ colorScheme });

			const response = await page.goto('/', { waitUntil: 'networkidle' });
			expect(response, 'the production origin must respond').not.toBeNull();
			expect(response?.status()).toBe(200);

			const headers = response?.headers() ?? {};
			expect(headers['x-frame-options']).toBe('DENY');
			expect(headers['x-content-type-options']).toBe('nosniff');
			expect(headers['referrer-policy']).toBe('no-referrer');
			expect(headers['strict-transport-security'] ?? '').toContain('max-age=');
			expect(headers['content-security-policy'] ?? '').toContain("frame-ancestors 'none'");
			expect(headers['permissions-policy'] ?? '').toContain('payment=()');

			// The document loads and paints something real — not a blank shell.
			await expect(page.locator('body')).toBeVisible();
			const overflowX = await page.evaluate(
				() => document.documentElement.scrollWidth > document.documentElement.clientWidth
			);
			expect(overflowX, `no document-level horizontal overflow at ${width}px`).toBe(false);

			expect(blocked, `a read-only surface check must never send a mutating request: ${blocked.join(', ')}`).toEqual(
				[]
			);
			expect(consoleErrors, `no unexpected console errors: ${consoleErrors.join(', ')}`).toEqual([]);
			expect(pageErrors, `no unhandled page errors: ${pageErrors.join(', ')}`).toEqual([]);
		});
	}
}
