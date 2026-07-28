import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';

// The signal terrain: the two ways it has already broken, and one it could.
//
// Both of the failures below were silent. Nothing errored, no test went red, and
// the stylesheet reported exactly the values it was supposed to have. The only
// thing that changed was that a layer stopped reaching the screen — which is why
// every assertion here compares rendered pixels rather than computed styles.

const hero = (page: Page) => page.locator('main.vault-glow');
const shot = async (page: Page) =>
	createHash('md5')
		.update(await page.screenshot({ clip: { x: 0, y: 0, width: 375, height: 220 } }))
		.digest('hex');

// Removing a layer must change the picture. If it does not, the layer was never
// on screen — which is exactly what happened when `body` carried the floor
// color: its background painted over every `z-index: -1` pseudo, and the vault
// glow survived only because its drift animation happened to promote it onto a
// compositing layer. Under reduced motion the drift stops, the promotion goes
// with it, and both the glow and the terrain vanished.
for (const reducedMotion of ['reduce', 'no-preference'] as const) {
	for (const colorScheme of ['dark', 'light'] as const) {
		test(`the terrain and the glow both reach the screen (${reducedMotion}, ${colorScheme})`, async ({
			browser
		}) => {
			const context = await browser.newContext({
				viewport: { width: 375, height: 667 },
				colorScheme,
				reducedMotion
			});
			const page = await context.newPage();
			await page.goto('/');
			await expect(hero(page)).toBeVisible();

			const composed = await shot(page);

			await page.addStyleTag({ content: '.vault-glow::after{display:none !important}' });
			const withoutTerrain = await shot(page);
			expect(withoutTerrain, 'the terrain paints nothing').not.toBe(composed);

			await page.addStyleTag({ content: '.vault-glow::before{display:none !important}' });
			expect(await shot(page), 'the vault glow paints nothing').not.toBe(withoutTerrain);

			await context.close();
		});
	}
}

test('reduced motion holds the terrain still under a moving pointer', async ({ browser }) => {
	const context = await browser.newContext({
		viewport: { width: 375, height: 667 },
		reducedMotion: 'reduce'
	});
	const page = await context.newPage();
	await page.goto('/');
	await expect(hero(page)).toBeVisible();

	await page.mouse.move(40, 40);
	await page.mouse.move(340, 600);
	await page.waitForTimeout(150);

	// Not "the screenshot matches": under reduced motion the attachment must
	// never have run at all, so the steering properties are never written and the
	// element renders the frame the stylesheet composes.
	const steer = await hero(page).evaluate((el) => [
		el.style.getPropertyValue('--sx'),
		el.style.getPropertyValue('--sy')
	]);
	expect(steer, 'reduced motion still wrote a steering value').toEqual(['', '']);

	await context.close();
});

test('a pointer steers the terrain when motion is allowed', async ({ browser }) => {
	const context = await browser.newContext({
		viewport: { width: 375, height: 667 },
		reducedMotion: 'no-preference'
	});
	const page = await context.newPage();
	await page.goto('/');
	await expect(hero(page)).toBeVisible();

	// The move happens INSIDE the poll. A pointer event that arrives before
	// hydration attaches the listener is simply lost, and re-reading the property
	// afterwards can never recover it — polling has to re-send the event, not
	// re-read the result.
	const steerTo = async (x: number, y: number) => {
		await page.mouse.move(x, y);
		return hero(page).evaluate((el) => el.style.getPropertyValue('--sx'));
	};
	await expect.poll(() => steerTo(340, 600).then(Number)).toBeGreaterThan(0);

	// And it settles back rather than holding a lean nothing on screen explains.
	// Dispatched rather than driven: Playwright cannot move the pointer outside
	// the viewport, which is the only way a real `pointerleave` happens here.
	await hero(page).evaluate((el) => el.dispatchEvent(new PointerEvent('pointerleave')));
	await expect
		.poll(() => hero(page).evaluate((el) => el.style.getPropertyValue('--sx')))
		.toBe('0.000');

	await context.close();
});
