import { test, expect } from '@playwright/test';

// https://cinder.ink/field-notes was note 001's own page and is externally
// linked (uxuiai/src/data/products.js). These specs prove: the externally
// linked URL still works, now as an index that leads with note 001; the
// note's full argument survives the move to its own descriptive URL even
// with JavaScript disabled (docs/field-notes/render.py generates the JSON
// these pages render from, and it exists so a crawler sees the whole
// argument); and the two pages carry distinct, correct discovery metadata.

test('the index lists every note, with 001 first', async ({ page }) => {
	await page.goto('/field-notes');

	const titles = page.locator('h2');
	await expect(titles).toHaveCount(1);
	await expect(titles.first()).toHaveText('Field Note 001 — The Vote To Stay Blind');

	await page.getByRole('link', { name: 'Read the note' }).first().click();
	await expect(page).toHaveURL(/\/field-notes\/the-vote-to-stay-blind$/);
});

test('the note renders its full argument with JavaScript disabled', async ({ browser }) => {
	const context = await browser.newContext({ javaScriptEnabled: false });
	const page = await context.newPage();
	await page.goto('/field-notes/the-vote-to-stay-blind');

	await expect(page.locator('h1')).toHaveText('Field Note 001 — The Vote To Stay Blind');

	// Both halves the house format requires (docs/field-notes/README.md).
	await expect(page.getByRole('heading', { name: 'In plain words' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'The technical record' })).toBeVisible();

	// Content that exists in the canonical markdown and never existed on the
	// old hand-authored page — proof this route renders the CURRENT source,
	// not a stale copy of it.
	await expect(page.getByRole('heading', { name: 'Media validated end to end' })).toBeVisible();
	await expect(page.getByText('The defect the audit found in our own work')).toBeVisible();

	// One row from each block kind the note actually uses: a meta row, a
	// measurement code block, a claim/reality table, and the closing coda.
	await expect(page.getByText('12 of 12, unanimous.')).toBeVisible();
	await expect(page.getByText('40 concurrent claims')).toBeVisible();
	await expect(page.getByText('GetObjectAttributes')).toBeVisible();
	await expect(page.getByText('Cinder is open source.')).toBeVisible();

	await context.close();
});

test('canonical and social tags are correct and differ between the index and the note', async ({ page }) => {
	await page.goto('/field-notes');
	await expect(page.locator('link[rel=canonical]')).toHaveAttribute(
		'href',
		'https://cinder.ink/field-notes'
	);
	// app.html ships site-wide default og:url/og:description/twitter:description
	// tags ("Per-page titles/descriptions override via <svelte:head>"), and
	// <svelte:head> appends rather than replaces — so each of these exists
	// twice in the DOM, default first. `.last()` is always the page's own.
	await expect(page.locator('meta[property="og:url"]').last()).toHaveAttribute(
		'content',
		'https://cinder.ink/field-notes'
	);
	const indexDescription = await page
		.locator('meta[name="twitter:description"]')
		.last()
		.getAttribute('content');
	const indexTitle = await page.title();

	await page.goto('/field-notes/the-vote-to-stay-blind');
	await expect(page.locator('link[rel=canonical]')).toHaveAttribute(
		'href',
		'https://cinder.ink/field-notes/the-vote-to-stay-blind'
	);
	await expect(page.locator('meta[property="og:url"]').last()).toHaveAttribute(
		'content',
		'https://cinder.ink/field-notes/the-vote-to-stay-blind'
	);
	const noteDescription = await page
		.locator('meta[name="twitter:description"]')
		.last()
		.getAttribute('content');
	const noteTitle = await page.title();

	expect(noteDescription).not.toBe(indexDescription);
	expect(noteTitle).not.toBe(indexTitle);
	expect(noteTitle).toContain('Field Note 001');
});

test('no cookie is set on the index or the note page', async ({ page, context }) => {
	await page.goto('/field-notes');
	expect(await context.cookies()).toHaveLength(0);

	await page.goto('/field-notes/the-vote-to-stay-blind');
	expect(await context.cookies()).toHaveLength(0);
});
