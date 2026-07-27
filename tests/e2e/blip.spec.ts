import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';

// Deterministic bytes generated at runtime — no binary fixtures in the repo.
function pattern(n: number): Buffer {
	const out = Buffer.alloc(n);
	for (let i = 0; i < n; i++) out[i] = (i * 31 + 7) & 0xff;
	return out;
}

async function sendFile(page: Page, bytes: Buffer, name = 'ledger.bin'): Promise<string> {
	await page.goto('/');
	await page.getByRole('radio', { name: /^file$/i }).check();
	await page.setInputFiles('#file-input', {
		name,
		mimeType: 'application/octet-stream',
		buffer: bytes
	});
	await page.getByRole('button', { name: /create one-time link/i }).click();

	const linkInput = page.getByRole('textbox', { name: /one-time link/i });
	await expect(linkInput).toBeVisible({ timeout: 20_000 });
	return linkInput.inputValue();
}

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

// --- file transfer ---------------------------------------------------------

test('file: create → reveal once → second reveal is gone', async ({ page, context }) => {
	const bytes = pattern(20_000);
	const link = await sendFile(page, bytes);
	expect(link).toContain('/f/');
	expect(link).toContain('#');

	const reader = await context.newPage();

	// Arriving at the link must claim nothing. Count every claim the page makes.
	let claims = 0;
	await reader.route('**/files/claim', (route) => {
		claims++;
		return route.continue();
	});

	await reader.goto(link);
	await expect(reader.getByRole('button', { name: /reveal and destroy/i })).toBeVisible();
	await reader.waitForTimeout(500);
	expect(claims, 'link arrival must not claim').toBe(0);

	// The exact approved warning, before anything destructive is possible.
	await expect(reader.getByText(/Exactly one server delivery can begin/)).toBeVisible();
	await expect(
		reader.getByText(/If that delivery fails, the file is permanently unavailable/)
	).toBeVisible();

	const download = reader.waitForEvent('download');
	await reader.getByRole('button', { name: /reveal and destroy/i }).click();

	const file = await download;
	expect(file.suggestedFilename()).toBe('ledger.bin');
	expect(claims, 'reveal claims exactly once').toBe(1);

	// The bytes that came back are byte-identical to what was sent.
	const path = await file.path();
	const { readFile } = await import('node:fs/promises');
	const got = await readFile(path);
	expect(createHash('sha256').update(got).digest('hex')).toBe(
		createHash('sha256').update(bytes).digest('hex')
	);

	await expect(reader.getByText(/Deleted, absence verified/i)).toBeVisible();

	// A second reader gets the generic gone state, and — the part that used to
	// be silent — it reaches a screen reader too.
	const reader2 = await context.newPage();
	await reader2.goto(link);
	await reader2.getByRole('button', { name: /reveal and destroy/i }).click();
	await expect(reader2.getByRole('heading', { name: /this transfer is gone/i })).toBeVisible();
	await expect(reader2.locator('[aria-live="polite"]')).toContainText(/no stored copy to return/i);
});

test('file: the reveal button cannot be double-activated', async ({ page, context }) => {
	const link = await sendFile(page, pattern(4_000));

	const reader = await context.newPage();
	let claims = 0;
	await reader.route('**/files/claim', async (route) => {
		claims++;
		await new Promise((r) => setTimeout(r, 300)); // hold the claim open
		return route.continue();
	});
	await reader.goto(link);

	// By id, not by text: the label changes to the live status mid-claim.
	const button = reader.locator('#reveal');
	await button.click();
	await expect(button).toBeDisabled();
	await button.click({ force: true, trial: true }).catch(() => {}); // a second press must do nothing
	await reader.waitForEvent('download');

	expect(claims, 'exactly one claim despite a held request').toBe(1);
});

test('file: a preview bot GET never claims the transfer', async ({ page, context, request }) => {
	const link = await sendFile(page, pattern(2_000));

	// What an unfurler actually does: GET the page, follow nothing destructive.
	const res = await request.get(link.split('#')[0]);
	expect(res.ok()).toBeTruthy();

	// The human still gets the file.
	const reader = await context.newPage();
	await reader.goto(link);
	const download = reader.waitForEvent('download');
	await reader.getByRole('button', { name: /reveal and destroy/i }).click();
	await download;
});

test('file: over the ceiling is refused in the browser, before any upload', async ({ page }) => {
	await page.goto('/');
	await page.getByRole('radio', { name: /^file$/i }).check();

	let uploads = 0;
	await page.route('**/files', (route) => {
		uploads++;
		return route.continue();
	});

	await page.setInputFiles('#file-input', {
		name: 'too-big.bin',
		mimeType: 'application/octet-stream',
		buffer: Buffer.alloc(4 * 1024 * 1024 + 1)
	});

	await expect(page.getByRole('alert')).toContainText(/limit is 4 MiB/i);
	expect(uploads, 'nothing may reach the server').toBe(0);
});

test('file: a passphrase file needs the passphrase after the claim', async ({ page, context }) => {
	await page.goto('/');
	await page.getByRole('radio', { name: /^file$/i }).check();
	await page.setInputFiles('#file-input', {
		name: 'sealed.bin',
		mimeType: 'application/octet-stream',
		buffer: pattern(3_000)
	});
	await page.getByLabel(/add a passphrase/i).check();
	await page.getByPlaceholder(/passphrase \(needed to open/i).fill('hunter2');
	await page.getByRole('button', { name: /create one-time link/i }).click();

	const link = await page.getByRole('textbox', { name: /one-time link/i }).inputValue();

	const reader = await context.newPage();
	await reader.goto(link);
	await reader.getByRole('button', { name: /reveal and destroy/i }).click();

	// The claim already happened; the passphrase gate is purely local.
	await reader.getByPlaceholder(/enter the passphrase/i).fill('hunter2');
	const download = reader.waitForEvent('download');
	await reader.getByRole('button', { name: /unlock and save/i }).click();
	expect((await download).suggestedFilename()).toBe('sealed.bin');
});

test('file: the key never leaves the browser', async ({ page, context }) => {
	const link = await sendFile(page, pattern(1_500));
	const key = link.split('#')[1];
	expect(key.length).toBeGreaterThan(20);

	const reader = await context.newPage();
	const sent: string[] = [];
	reader.on('request', (r) => sent.push(r.url() + ' ' + (r.postData() ?? '')));

	await reader.goto(link);
	const download = reader.waitForEvent('download');
	await reader.getByRole('button', { name: /reveal and destroy/i }).click();
	await download;

	for (const line of sent) {
		expect(line, `key leaked in: ${line}`).not.toContain(key);
	}
});

test('file: every outcome is announced and takes focus', async ({ page, context }) => {
	// Both used to fail silently: the only live region lived inside the gate and
	// unmounted at the exact moment there was something worth saying, and focus
	// fell back to <body> right after the most consequential action on the site.
	const link = await sendFile(page, pattern(2_500));

	const reader = await context.newPage();
	await reader.goto(link);
	const download = reader.waitForEvent('download');
	await reader.getByRole('button', { name: /reveal and destroy/i }).click();
	await download;

	await expect(reader.locator('[aria-live="polite"]')).toContainText(/delivered/i);
	await expect(reader.locator('[aria-live="polite"]')).toContainText(/stored copy is deleted/i);

	const focused = await reader.evaluate(() => document.activeElement?.tagName ?? 'NONE');
	expect(focused, 'focus must not fall back to body').toBe('H1');
});

test('file: the reveal page does not scroll sideways at any width', async ({ page, context }) => {
	// The ambient glow is intentionally wider than its container; /f/ and /n/
	// both forgot to clip it and scrolled sideways at every width.
	const link = await sendFile(page, pattern(1_200));
	const reader = await context.newPage();
	await reader.goto(link);

	for (const width of [320, 375, 440, 768, 1440]) {
		await reader.setViewportSize({ width, height: 760 });
		const overflow = await reader.evaluate(
			() => document.documentElement.scrollWidth - document.documentElement.clientWidth
		);
		expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(0);
	}
});
