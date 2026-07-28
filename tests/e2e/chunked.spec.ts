import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// A multi-part transfer, driven through a real browser. The unit and API suites
// prove the guarantee per part; this proves the two things only a browser can
// show: that the recipient is told the cost BEFORE committing, and that N parts
// reassemble into the exact bytes that were sent.
//
// PART_BYTES is 4 MiB, so a genuinely multi-part file is ~9 MB of encryption in
// a headless browser. That is slow but it is the only honest version of this
// test — a smaller forced slice size would be testing a fixture, not the
// product. The timeout below is raised for that reason and no other.
test.describe.configure({ timeout: 180_000 });

const PART_BYTES = 4 * 1024 * 1024;

function pattern(n: number): Buffer {
	const out = Buffer.alloc(n);
	for (let i = 0; i < n; i++) out[i] = (i * 31 + 7) & 0xff;
	return out;
}

async function sendFile(page: Page, bytes: Buffer, name: string): Promise<string> {
	await page.goto('/');
	await page.getByRole('radio', { name: /^file$/i }).check();
	await page.setInputFiles('#file-input', {
		name,
		mimeType: 'application/octet-stream',
		buffer: bytes
	});
	await page.getByRole('button', { name: /create one-time link/i }).click();

	const linkInput = page.getByRole('textbox', { name: /one-time link/i });
	await expect(linkInput).toBeVisible({ timeout: 120_000 });
	return linkInput.inputValue();
}

test('the sender is told the piece count and the cost before sending', async ({ page }) => {
	await page.goto('/');
	await page.getByRole('radio', { name: /^file$/i }).check();
	await page.setInputFiles('#file-input', {
		name: 'big.bin',
		mimeType: 'application/octet-stream',
		buffer: pattern(PART_BYTES + 1024)
	});

	await expect(page.getByText(/this goes in 2 pieces and costs 1 Cinder Pro credit/i)).toBeVisible();
	await expect(page.getByText(/the whole transfer is permanently gone/i)).toBeVisible();
	// The credit is spent whether or not the delivery survives, and that has to be
	// on the screen BEFORE the sender commits — never implied as refundable.
	//
	// Kept to a phrase that does not straddle a source line break: getByText
	// normalizes whitespace for a STRING and not for a RegExp, so a regex spanning
	// the template's own wrapping fails on the newline and reads as missing copy.
	await expect(page.getByText(/credit is spent either way/i)).toBeVisible();
});

test('the recipient is told the piece count before anything is claimed', async ({ page }) => {
	// The gate has to state the cost from the link alone, with no request. That
	// is why the part count rides in the fragment: asking the server would be a
	// request on link arrival, which is exactly what the bot defense forbids.
	let requests = 0;
	await page.route('**/files/**', (route) => {
		requests++;
		return route.continue();
	});

	await page.goto('/f/some-locator#SOMEKEY.12');

	await expect(page.getByText(/this file arrives in 12 pieces/i)).toBeVisible();
	await expect(page.getByText(/every piece already\s+delivered is permanently destroyed/i)).toBeVisible();
	await expect(page.getByText(/there is no\s+retry and no resume/i)).toBeVisible();
	await expect(page.getByRole('button', { name: /destroy all 12 stored pieces/i })).toBeVisible();

	await page.waitForTimeout(500);
	expect(requests, 'arriving at a chunked link must claim nothing').toBe(0);
});

test('a two-part file round-trips byte for byte and claims each part exactly once', async ({
	page,
	context
}) => {
	const bytes = pattern(PART_BYTES + 500_000);
	const link = await sendFile(page, bytes, 'ledger-big.bin');

	// The link carries the part count in the fragment and nothing in the path.
	expect(link).toMatch(/\/f\/[^#]+#[^.]+\.2$/);

	const reader = await context.newPage();
	let claims = 0;
	await reader.route('**/files/claim', (route) => {
		claims++;
		return route.continue();
	});

	await reader.goto(link);
	await expect(reader.getByText(/this file arrives in 2 pieces/i)).toBeVisible();
	expect(claims, 'link arrival must not claim').toBe(0);

	const download = reader.waitForEvent('download', { timeout: 120_000 });
	await reader.getByRole('button', { name: /destroy all 2 stored pieces/i }).click();

	const file = await download;
	expect(file.suggestedFilename()).toBe('ledger-big.bin');
	// Exactly one claim per part. Not one per transfer, and not more than one.
	expect(claims, 'each part is claimed exactly once').toBe(2);

	const got = await readFile(await file.path());
	expect(got.length).toBe(bytes.length);
	expect(createHash('sha256').update(got).digest('hex')).toBe(
		createHash('sha256').update(bytes).digest('hex')
	);

	await expect(reader.getByText(/2 of 2 delivered/i)).toBeVisible();
	await expect(reader.getByText(/Deleted, absence verified/i)).toBeVisible();

	// Every part is spent. A second reader gets the generic gone state, and must
	// not be able to tell that some parts of this transfer ever existed.
	const reader2 = await context.newPage();
	await reader2.goto(link);
	await reader2.getByRole('button', { name: /destroy all 2 stored pieces/i }).click();
	await expect(reader2.getByRole('heading', { name: /this transfer is gone/i })).toBeVisible({
		timeout: 30_000
	});
});

test('a piece failing partway states the permanent loss and offers no retry', async ({
	page,
	context
}) => {
	const link = await sendFile(page, pattern(PART_BYTES + 500_000), 'doomed.bin');

	const reader = await context.newPage();

	// Let part one through, then break the second claim at the transport. This is
	// the failure the whole design had to answer honestly: one piece is already
	// destroyed and the file can never be assembled.
	let seen = 0;
	await reader.route('**/files/claim', (route) => {
		seen++;
		if (seen === 1) return route.continue();
		return route.abort('failed');
	});

	await reader.goto(link);
	await reader.getByRole('button', { name: /destroy all 2 stored pieces/i }).click();

	await expect(
		reader.getByRole('heading', { name: /the delivery began but could not finish/i })
	).toBeVisible({ timeout: 60_000 });
	// Scoped to the visible paragraph: the same sentence also reaches the live
	// region, which is the point of that region and not an ambiguity to remove.
	await expect(reader.getByText(/Cinder handed over 1 of 2 pieces/i)).toBeVisible();
	await expect(reader.getByText(/cannot be retried or\s+resumed/i)).toBeVisible();

	// No retry button anywhere. Offering one would be a lie the backend cannot
	// honor, and "try again" is exactly what a person reaches for here.
	await expect(reader.getByRole('button', { name: /try again/i })).toHaveCount(0);
	await expect(reader.locator('[aria-live="polite"]')).toContainText(
		/permanently destroyed/i
	);
});

test('an unentitled sender is refused before anything is stored', async ({ page }) => {
	// Strip the dev grant so the server's gate answers 402, which is what a real
	// unpaid caller gets. The message must be about the plan, not a stack trace.
	await page.route('**/files', async (route) => {
		const body = JSON.parse(route.request().postData() || '{}');
		if (!body.parts) return route.continue();
		delete body.capabilityGrant;
		return route.continue({ postData: JSON.stringify(body) });
	});

	await page.goto('/');
	await page.getByRole('radio', { name: /^file$/i }).check();
	await page.setInputFiles('#file-input', {
		name: 'big.bin',
		mimeType: 'application/octet-stream',
		buffer: pattern(PART_BYTES + 1024)
	});
	await page.getByRole('button', { name: /create one-time link/i }).click();

	await expect(page.getByRole('alert')).toContainText(/costs one Cinder Pro credit/i, {
		timeout: 120_000
	});
	// And it says the promise is unchanged, because that is the actual product
	// claim: Pro adds size, it does not buy a different guarantee.
	await expect(page.getByRole('alert')).toContainText(/Pro adds size/i);
});
