import { expect, test, type Locator, type Page } from '@playwright/test';

const APPLE = /continue with apple/i;
const PAY = /pay \$4\.94 for 10 sends/i;

const disclosure = (page: Page) => page.locator('[aria-labelledby="money-heading"]');

async function expectBefore(first: Locator, second: Locator): Promise<void> {
	const firstHandle = await first.elementHandle();
	const secondHandle = await second.elementHandle();

	expect(firstHandle, 'the first journey step is rendered').not.toBeNull();
	expect(secondHandle, 'the supporting disclosure is rendered').not.toBeNull();

	const isBefore = await firstHandle!.evaluate(
		(firstElement, secondElement) =>
			secondElement !== null &&
			Boolean(firstElement.compareDocumentPosition(secondElement) & Node.DOCUMENT_POSITION_FOLLOWING),
		secondHandle
	);

	expect(isBefore, 'the usable next action comes before the supporting disclosure').toBe(true);
}

async function expectConstrainedLayout(page: Page, primary: Locator): Promise<void> {
	const primaryBox = await primary.boundingBox();
	expect(primaryBox, 'the primary action is rendered').not.toBeNull();
	expect(primaryBox!.y + primaryBox!.height, 'the first decision is above the fold').toBeLessThanOrEqual(667);

	await page.evaluate(() => document.documentElement.style.setProperty('font-size', '200%'));
	const width = await page.evaluate(() => ({
		client: document.documentElement.clientWidth,
		scroll: document.documentElement.scrollWidth
	}));
	expect(width.scroll, '200% text adds no horizontal document overflow').toBe(width.client);
}

test('signed-out Pro leads with the two live account doors', async ({ page }) => {
	await page.goto('/pro');

	const providerButtons = page.locator('.btn-provider');
	await expect(providerButtons).toHaveCount(2);
	await expect(providerButtons.first()).toHaveText(APPLE);
	await expectBefore(providerButtons.first(), disclosure(page));
});

for (const colorScheme of ['light', 'dark'] as const) {
	test(`the signed-out decision fits the smallest screen in ${colorScheme} with reduced motion`, async ({
		page
	}) => {
		await page.setViewportSize({ width: 375, height: 667 });
		await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
		await page.goto('/pro');

		const providerButtons = page.locator('.btn-provider');
		await expect(providerButtons).toHaveCount(2);

		const buttonBoxes = await providerButtons.evaluateAll((buttons) =>
			buttons.map((button) => button.getBoundingClientRect().toJSON())
		);
		expect(buttonBoxes.every(({ height }) => height >= 44), 'both account doors meet the 44px floor').toBe(
			true
		);
		expect(buttonBoxes.at(-1)!.bottom, 'the complete signed-out decision is above the fold').toBeLessThanOrEqual(
			667
		);

		await page.keyboard.press('Tab');
		await expect(providerButtons.first()).toBeFocused();
		expect(
			await providerButtons.first().evaluate((button) => getComputedStyle(button).boxShadow),
			'the first keyboard stop has a visible focus treatment'
		).not.toBe('none');
		await page.keyboard.press('Tab');
		await expect(providerButtons.last()).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(page.locator('summary')).toBeFocused();

		await page.evaluate(() => document.documentElement.style.setProperty('font-size', '200%'));
		const layout = await page.evaluate(() => ({
			clientWidth: document.documentElement.clientWidth,
			scrollWidth: document.documentElement.scrollWidth,
			controls: [...document.querySelectorAll<HTMLElement>('button, summary')].map((control) => {
				const rect = control.getBoundingClientRect();
				return { left: rect.left, right: rect.right, height: rect.height };
			})
		}));

		expect(layout.scrollWidth, '200% text adds no horizontal document overflow').toBe(layout.clientWidth);
		expect(
			layout.controls.every(({ left, right }) => left >= 0 && right <= layout.clientWidth),
			'controls stay inside the viewport at 200% text'
		).toBe(true);
	});
}

test.describe('signed-in Pro', () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: 375, height: 667 });
		await page.addInitScript(() => {
			sessionStorage.setItem(
				'cinder.tokens',
				JSON.stringify({ idToken: 'stale-id-token', refreshToken: 'refresh-token' })
			);
		});

		await page.route('**/oauth2/token', (route) =>
			route.fulfill({ json: { id_token: 'fresh-id-token' } })
		);
	});

	test('an unpaid account gets the purchase action after the material facts', async ({ page }) => {
		await page.route('**/entitlement', (route) =>
			route.fulfill({ json: { entitled: false, credits: 0 } })
		);
		await page.goto('/pro');

		const pay = page.getByRole('button', { name: PAY });
		await expect(pay).toBeVisible();
		await expect(page.getByText(/a credit is spent before/i)).toBeVisible();
		await expect(page.getByText(/spent credits are not refundable/i)).toBeVisible();
		await expectBefore(pay, disclosure(page));
		await expectConstrainedLayout(page, pay);
	});

	test('a paid account keeps its balance and top-up action ahead of detail', async ({ page }) => {
		await page.route('**/entitlement', (route) =>
			route.fulfill({ json: { entitled: true, credits: 7 } })
		);
		await page.goto('/pro');

		await expect(page.getByText(/you have 7 credits left/i)).toBeVisible();
		const pay = page.getByRole('button', { name: PAY });
		await expect(pay).toBeVisible();
		await expectBefore(pay, disclosure(page));
		await expectConstrainedLayout(page, pay);
	});
});
