import { test, expect, type Page } from '@playwright/test';

const nav = (page: Page) => page.getByRole('navigation', { name: 'Cinder destinations' });

test.describe('the Cinder dashboard shell', () => {
	test('the brand returns home and every destination stays explicit', async ({ page }) => {
		await page.goto('/account');

		const header = page.getByRole('banner');
		await expect(header.getByRole('link', { name: 'Cinder home' })).toHaveAttribute('href', '/');
		await expect(header.getByRole('link', { name: 'Cinder home' }).locator('img')).toHaveAttribute(
			'src',
			'/brand/cinder-mark.svg'
		);

		const destinations = nav(page);
		await expect(destinations.getByRole('link', { name: 'Send' })).toHaveAttribute('href', '/');
		await expect(destinations.getByRole('link', { name: 'Cinder Pro' })).toHaveAttribute(
			'href',
			'/pro'
		);
		await expect(destinations.getByRole('link', { name: 'Account' })).toHaveAttribute(
			'aria-current',
			'page'
		);
	});

	test('sign in is a first-class destination before Pro on the sending surface', async ({ page }) => {
		await page.goto('/');

		const destinations = nav(page).getByRole('link');
		await expect(destinations).toHaveText(['Send', 'Sign in', 'Cinder Pro']);
		await expect(destinations.nth(1)).toHaveAttribute('href', '/signin');
	});

	test('the keyboard path starts with escape, home, then the destinations', async ({ page }) => {
		await page.goto('/account');

		const skip = page.getByRole('link', { name: 'Skip to content' });
		const path = [
			page.getByRole('banner').getByRole('link', { name: 'Cinder home' }),
			nav(page).getByRole('link', { name: 'Send' }),
			nav(page).getByRole('link', { name: 'Account' }),
			nav(page).getByRole('link', { name: 'Cinder Pro' })
		];

		await skip.focus();
		await expect(skip).toBeFocused();
		for (const destination of path) {
			await page.keyboard.press('Tab');
			await expect(destination).toBeFocused();
		}
	});

	test('the account route remains the OAuth callback', async ({ page }) => {
		await page.goto('/account?code=not-a-real-code');

		await expect(page).toHaveURL(/\/signin/);
		await expect(page.getByRole('alert')).toContainText(
			/different tab from the one that started it/i
		);
	});

	test('the shell holds at the smallest viewport in both appearances and larger text', async ({
		page
	}) => {
		await page.setViewportSize({ width: 375, height: 667 });

		const variants = [
			{ colorScheme: 'light' as const, reducedMotion: 'no-preference' as const, scale: '100%' },
			{ colorScheme: 'dark' as const, reducedMotion: 'no-preference' as const, scale: '100%' },
			{ colorScheme: 'light' as const, reducedMotion: 'reduce' as const, scale: '200%' },
			{ colorScheme: 'dark' as const, reducedMotion: 'reduce' as const, scale: '200%' }
		];

		for (const variant of variants) {
			await page.emulateMedia({
				colorScheme: variant.colorScheme,
				reducedMotion: variant.reducedMotion
			});
			await page.goto('/account');
			await page.evaluate((scale) => {
				document.documentElement.style.fontSize = scale;
			}, variant.scale);
			await expect(nav(page)).toBeVisible();

			const measurement = await page.evaluate(() => {
				const links = [...document.querySelectorAll<HTMLElement>('.dashboard-nav-link')];
				return {
					documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
					headerPosition: getComputedStyle(document.querySelector('.dashboard-header')!).position,
					minTarget: Math.min(...links.map((link) => link.getBoundingClientRect().height)),
					offscreen: links.filter((link) => {
						const box = link.getBoundingClientRect();
						return box.left < 0 || box.right > window.innerWidth;
					}).length
				};
			});

			expect(measurement, JSON.stringify(variant)).toEqual({
				documentOverflow: 0,
				headerPosition: 'sticky',
				minTarget: expect.any(Number),
				offscreen: 0
			});
			expect(measurement.minTarget, JSON.stringify(variant)).toBeGreaterThanOrEqual(44);
		}
	});
});
