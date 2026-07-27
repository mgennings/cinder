import { test, expect } from '@playwright/test';

test('create → reveal once → second reveal is gone', async ({ page, context }) => {
	await page.goto('/');
	await page.getByPlaceholder(/type your secret/i).fill('the eagle lands at dawn');
	await page.getByRole('button', { name: /create one-time link/i }).click();

	const linkInput = page.getByRole('textbox', { name: /one-time link/i });
	await expect(linkInput).toBeVisible();
	const link = await linkInput.inputValue();
	expect(link).toContain('/n/');
	expect(link).toContain('#');

	// First reader reveals the note.
	const reader = await context.newPage();
	await reader.goto(link);
	await reader.getByRole('button', { name: /reveal note/i }).click();
	await expect(reader.getByText('the eagle lands at dawn')).toBeVisible();
	await expect(reader.getByText(/Cinder's stored copy is gone/i)).toBeVisible();

	// Second reader gets the gone state.
	const reader2 = await context.newPage();
	await reader2.goto(link);
	await reader2.getByRole('button', { name: /reveal note/i }).click();
	await expect(reader2.getByText(/this note is gone/i)).toBeVisible();
});

test('passphrase note needs the passphrase to open', async ({ page, context }) => {
	await page.goto('/');
	await page.getByPlaceholder(/type your secret/i).fill('nuclear codes: 0000');
	await page.getByLabel(/add a passphrase/i).check();
	await page.getByPlaceholder(/passphrase \(needed to open/i).fill('hunter2');
	await page.getByRole('button', { name: /create one-time link/i }).click();

	const link = await page.getByRole('textbox', { name: /one-time link/i }).inputValue();

	const reader = await context.newPage();
	await reader.goto(link);
	await reader.getByRole('button', { name: /reveal note/i }).click();
	// It burns, then asks for the passphrase.
	await reader.getByPlaceholder(/enter the passphrase/i).fill('hunter2');
	await reader.getByRole('button', { name: /unlock & reveal/i }).click();
	await expect(reader.getByText('nuclear codes: 0000')).toBeVisible();
});
