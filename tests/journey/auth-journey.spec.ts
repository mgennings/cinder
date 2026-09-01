import { test, expect } from '@playwright/test';

// THE SIGN-IN JOURNEY, INCLUDING THE PARTS THAT FAIL.
//
// full-journey.spec.ts proves the happy path end to end and always did. What
// had no coverage at all was every way the round trip can end badly, which is
// exactly the set of states that used to render as the ordinary signed-out
// page — a sign-in that failed and a sign-in that never happened were the same
// screen, so nobody could tell which one they were looking at, including us.
//
// Journey rather than e2e on purpose: this needs the real identity API on
// :4100 (see .notes/GOTCHAS.md on why the two suites are configured
// differently). Nothing here touches the transfer path or a capability.
//
// The Cognito double redirects straight back from /oauth2/authorize, so
// "pressing Apple" here exercises the whole PKCE handshake without a provider
// screen — which is the part this file is about.

const APPLE = /sign in with apple|sign up with apple|continue with apple/i;
const IDENTITY = process.env.CINDER_TEST_IDENTITY_ORIGIN ?? 'http://127.0.0.1:4100';

test.describe('the doors', () => {
	test('both providers are offered, Apple first and not subordinate', async ({ page }) => {
		await page.goto('/signin');

		const buttons = page.locator('.btn-provider');
		await expect(buttons).toHaveCount(2);

		// Apple's guidelines require its button not be visually subordinate to
		// another provider's. Asserted as geometry rather than as a promise in a
		// comment: same width, same height, and above.
		const apple = buttons.nth(0);
		const google = buttons.nth(1);
		await expect(apple).toHaveText(APPLE);
		await expect(google).toHaveText(/google/i);

		const a = (await apple.boundingBox())!;
		const g = (await google.boundingBox())!;
		expect(a.width).toBe(g.width);
		expect(a.height).toBe(g.height);
		expect(a.y).toBeLessThan(g.y);
		// 44px, the fingertip floor the rest of the product already holds to.
		expect(a.height).toBeGreaterThanOrEqual(44);
	});

	test('the sign-up door says the same two buttons are the whole form', async ({ page }) => {
		await page.goto('/signup');
		await expect(page.getByRole('heading', { name: /^sign up$/i })).toBeVisible();
		await expect(page.getByText(/there is no form/i)).toBeVisible();
		await expect(page.locator('.btn-provider')).toHaveCount(2);
	});

	test('the most recently selected provider is a browser cue, not a session', async ({
		page,
		context
	}) => {
		await page.goto('/signin');
		const googleButton = page.getByRole('button', { name: /sign in with google/i });
		await expect(googleButton).toBeVisible();
		await context.setOffline(true);
		await googleButton.click();

		const google = page.locator('[data-provider="Google"]');
		await expect(google.getByText(/last used/i)).toBeVisible();
		await expect(page.getByRole('alert')).toContainText(/offline.*cannot reach Google/i);
		expect(await page.evaluate(() => sessionStorage.getItem('cinder.tokens'))).toBeNull();

		await context.setOffline(false);
		await page.reload();
		await expect(google.getByText(/last used/i)).toBeVisible();
		await expect(page.getByText(/does not mean the sign-in\s+finished/i)).toBeVisible();
	});
});

test.describe('where the person ends up', () => {
	test('video asks for sign-in before file selection and returns directly to Video', async ({
		page
	}) => {
		await page.goto('/#video=on');
		await page.getByRole('radio', { name: /^video$/i }).check();

		await expect(page.getByRole('heading', { name: /sign in before choosing the video/i })).toBeVisible();
		await expect(page.locator('#video-input')).toHaveCount(0);

		await page.getByRole('button', { name: /continue with apple/i }).click();
		await expect(page).toHaveURL(/\/?mode=video$/, { timeout: 30_000 });
		await expect(page.getByRole('radio', { name: /^video$/i })).toBeChecked();
		await expect(page.locator('#video-input')).toBeVisible();

		// Fieldsets have a browser min-content width by default. At 200% text
		// that used to widen the segmented controls inside an overflow-hidden
		// card, so the document itself reported no overflow while half the
		// controls were visibly gone.
		await page.setViewportSize({ width: 375, height: 667 });
		await page.evaluate(() => document.documentElement.style.setProperty('font-size', '200%'));
		const layout = await page.evaluate(() => {
			const card = document.querySelector<HTMLElement>('.card')!;
			const clippedControls = [...card.querySelectorAll<HTMLElement>('fieldset, .seg, .field')].filter(
				(element) => element.scrollWidth > element.clientWidth + 1
			);
			return {
				cardOverflow: card.scrollWidth - card.clientWidth,
				clippedControls: clippedControls.length
			};
		});
		expect(layout).toEqual({ cardOverflow: 0, clippedControls: 0 });
	});

	test('signing in from the pay point comes back to the pay point', async ({ page }) => {
		await page.goto('/pro');
		await page.getByRole('button', { name: APPLE }).click();

		// Back on /pro, signed in, with the buy button — not stranded on /account.
		await expect(page).toHaveURL(/\/pro$/);
		await expect(page.getByRole('button', { name: /pay .* for \d+ sends/i })).toBeVisible({
			timeout: 30_000
		});
	});

	test('a destination that is not this origin is refused', async ({ page }) => {
		// The open-redirect shape: a cinder.ink link that lands somebody on
		// another host the instant they authenticate. The path is never honored,
		// so the callback keeps them on /account.
		await page.goto('/signin?next=https://evil.example/steal');
		await page.getByRole('button', { name: APPLE }).click();

		await expect(page.getByRole('heading', { name: /^signed in$/i })).toBeVisible({
			timeout: 30_000
		});
		await expect(page).toHaveURL(/\/account$/);
	});

	test('a door visited while already signed in says so instead of starting over', async ({
		page
	}) => {
		await page.goto('/signin');
		await page.getByRole('button', { name: APPLE }).click();
		await expect(page.getByRole('heading', { name: /^signed in$/i })).toBeVisible({
			timeout: 30_000
		});

		await page.goto('/signup');
		await expect(page.getByRole('heading', { name: /already signed in/i })).toBeVisible();
		await expect(page.locator('.btn-provider')).toHaveCount(0);
	});
});

test.describe('the failures, which are the point', () => {
	test('a callback that this tab never started names that exact reason', async ({ page }) => {
		// The phone case: the provider hands the callback to a fresh tab, and that
		// tab never held the PKCE verifier. It used to render as "Signed out."
		await page.goto('/account?code=not-a-real-code');

		await expect(page).toHaveURL(/\/signin/);
		await expect(page.getByRole('alert')).toContainText(/different tab from the one that started it/i);
		// And the reason does not survive a reload, or every later visit would
		// report a sign-in failure that never happened.
		await page.reload();
		await expect(page.getByRole('alert')).toHaveCount(0);
	});

	test('a provider that refused says nothing was created', async ({ page }) => {
		await page.goto('/account?error=access_denied&error_description=user+cancelled');

		await expect(page).toHaveURL(/\/signin/);
		await expect(page.getByRole('alert')).toContainText(/refused before it finished/i);
		// The provider's own developer-facing string is never shown.
		await expect(page.getByRole('alert')).not.toContainText(/access_denied/);
	});

	test('a refusal keeps the destination, so the retry still lands in the right place', async ({
		page
	}) => {
		await page.goto('/pro');
		// Start a real handshake so a verifier and a destination both exist, then
		// come back the way a cancelled provider would.
		await page.getByRole('button', { name: APPLE }).click();
		await expect(page).toHaveURL(/\/pro$/, { timeout: 30_000 });

		await page.evaluate(() => sessionStorage.setItem('cinder.returnto', '/pro'));
		await page.goto('/account?error=access_denied');
		await expect(page).toHaveURL(/\/signin\?.*next=%2Fpro/);
	});

	test('an offline device is told before it leaves, not after', async ({ page, context }) => {
		await page.goto('/signin');
		// Offline AFTER the door has rendered. Cutting the network first would
		// stop the dev server's own module graph from loading, and the test would
		// be measuring Vite rather than the button.
		const apple = page.getByRole('button', { name: APPLE });
		await expect(apple).toBeVisible();
		await context.setOffline(true);
		await apple.click();

		await expect(page.getByRole('alert')).toContainText(/offline.*cannot reach Apple/i);
		// It never left. A failed navigation would have replaced the door.
		await expect(page).toHaveURL(/\/signin$/);
		await expect(page.locator('.btn-provider')).toHaveCount(2);
		await context.setOffline(false);
	});

	test('an ended session is not the same screen as never having signed in', async ({ page }) => {
		await page.goto('/signin');
		await page.getByRole('button', { name: APPLE }).click();
		await expect(page.getByRole('heading', { name: /^signed in$/i })).toBeVisible({
			timeout: 30_000
		});

		// Revoked elsewhere: the token in this tab is still there, and the origin
		// no longer honors it. The distinction only exists because the page asks
		// the origin rather than reading its own storage.
		await page.evaluate(async (identity) => {
			const t = JSON.parse(sessionStorage.getItem('cinder.tokens')!);
			await fetch(`${identity}/oauth2/revoke`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ client_id: 'dev-cinder-client', token: t.refreshToken })
			});
		}, IDENTITY);

		await page.reload();
		await expect(page.getByRole('heading', { name: /that session ended/i })).toBeVisible({
			timeout: 30_000
		});
		await expect(page.getByRole('heading', { name: /^signed out$/i })).toHaveCount(0);
	});
});
