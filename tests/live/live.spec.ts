import { test, expect } from '@playwright/test';

const SITE = 'https://d1v6mxepibwneb.cloudfront.net';

test('LIVE: create → reveal once → second reveal is gone', async ({ page, context }) => {
	await page.goto(`${SITE}/`);
	await page.getByPlaceholder(/type your secret/i).fill('shipped on real aws 🔥');
	await page.getByRole('button', { name: /create one-time link/i }).click();

	const link = await page.getByRole('textbox', { name: /one-time link/i }).inputValue();
	expect(link).toContain('/n/');
	expect(link).toContain('#');

	const reader = await context.newPage();
	await reader.goto(link);
	await reader.getByRole('button', { name: /reveal note/i }).click();
	await expect(reader.getByText('shipped on real aws 🔥')).toBeVisible();

	const reader2 = await context.newPage();
	await reader2.goto(link);
	await reader2.getByRole('button', { name: /reveal note/i }).click();
	await expect(reader2.getByText(/this note is gone/i)).toBeVisible();
});
