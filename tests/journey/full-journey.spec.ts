import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// THE WHOLE CHAIN, once, in order.
//
// Three lanes built the pieces of Cinder Pro and each proved its own piece. This
// is the only thing that proves they are connected: one browser, one account,
// one payment, one 9 MiB file, from refused to delivered to destroyed.
//
// THE ORDER IS THE TEST. A run that only asserted the final success would pass
// just as happily if the gate were open the whole time — so the two refusals
// come first and they are load-bearing:
//
//   1. anonymous       → 402, because a grant was never minted
//   2. signed in, unpaid → 402, because the mint refused: an account is not a
//                          purchase, and this is the assertion that catches a
//                          mint that grants on a valid token alone
//   3. paid            → delivered
//
// Everything between the browser and the database is Cinder's shipped code. The
// only substitutions are Cognito and Stripe, and both are replaced at the
// service boundary only — see the header of scripts/dev-identity.mjs.
//
// SLOW, and honestly so. Nine MiB of AES-GCM in a headless browser, three times,
// because each refusal happens at create — after the encryption, which is where
// it happens for a real sender too. A smaller file would be testing a fixture.
test.describe.configure({ mode: 'serial', timeout: 900_000 });

const NINE_MIB = 9 * 1024 * 1024;

function pattern(n: number): Buffer {
	const out = Buffer.alloc(n);
	for (let i = 0; i < n; i++) out[i] = (i * 37 + 11) & 0xff;
	return out;
}

const bytes = pattern(NINE_MIB);

async function attemptSend(page: Page): Promise<void> {
	await page.goto('/');
	await page.getByRole('radio', { name: /^file$/i }).check();
	await page.setInputFiles('#file-input', {
		name: 'nine-mib.bin',
		mimeType: 'application/octet-stream',
		buffer: bytes
	});
	// The sender is told the shape AND the price before committing. 9 MiB over a
	// 4 MiB part size is three pieces costing one credit, and the page says both
	// at file selection — not after encrypting 9 MiB and refusing.
	await expect(page.getByText(/this goes in 3 pieces and costs 1 Cinder Pro credit/i)).toBeVisible();
	await page.getByRole('button', { name: /create one-time link/i }).click();
}

const refusal = (page: Page, wording: RegExp) =>
	expect(page.getByRole('alert')).toContainText(wording, { timeout: 300_000 });

test('refused anonymous, refused signed-in-unpaid, delivered after paying', async ({
	page,
	context
}) => {
	// --- 1. anonymous -------------------------------------------------------
	await attemptSend(page);
	// Anonymous, so the page has no balance to name and says what a large send
	// costs rather than what this account has left.
	await refusal(page, /costs one Cinder Pro credit/i);
	// And the refusal says the promise is unchanged, because that is the actual
	// product claim: Pro adds size, it does not buy a different guarantee.
	await expect(page.getByRole('alert')).toContainText(/Pro adds size/i);

	// --- 2. signed in, and still refused ------------------------------------
	await page.goto('/account');
	await page.getByRole('button', { name: /sign in with apple/i }).click();
	await expect(page.getByRole('heading', { name: /^signed in$/i })).toBeVisible({
		timeout: 30_000
	});
	// The account exists and has bought nothing. This sentence is the state the
	// next refusal has to come from.
	// Matched on the visible paragraph's own wording: the same sentence also
	// reaches the live region, which is the point of that region and not an
	// ambiguity to remove.
	await expect(page.getByText(/no credits on this account\. sending under the free/i)).toBeVisible();

	// The mint is asked and refuses. Asserted at the network rather than
	// inferred from the 402, because a client that never asked and a server that
	// said no look identical from the send page.
	let minted: (string | null)[] = [];
	await page.route('**/capability', async (route) => {
		const res = await route.fetch();
		const body = await res.json();
		minted.push(body.grant);
		return route.fulfill({ response: res, body: JSON.stringify(body) });
	});

	await attemptSend(page);
	// Signed in with a zero balance, so the wording is the top-up state rather
	// than the anonymous one — and it never implies the send failed for a reason
	// the sender cannot fix.
	await refusal(page, /this account has none left/i);
	expect(minted, 'the client asked the identity API for a grant').toHaveLength(1);
	expect(minted[0], 'an account without a purchase mints nothing').toBeNull();

	// --- 3. pay -------------------------------------------------------------
	await page.goto('/pro');
	await page.getByRole('button', { name: /pay .* for 10 sends/i }).click();
	// Checkout, the webhook, and the return trip. The page polls because Stripe's
	// redirect and Stripe's webhook are independent and the browser usually wins.
	await expect(page.getByRole('heading', { name: /cinder pro is active/i })).toBeVisible({
		timeout: 60_000
	});

	// --- 4. the same send, now delivered ------------------------------------
	minted = [];
	await attemptSend(page);

	const linkInput = page.getByRole('textbox', { name: /one-time link/i });
	await expect(linkInput).toBeVisible({ timeout: 300_000 });
	const link = await linkInput.inputValue();

	// Three parts, stated in the fragment, which is what lets the recipient's
	// gate name the cost with no request at all.
	expect(link).toMatch(/\/f\/[^#]+#[^.]+\.3$/);

	expect(minted, 'a purchase mints exactly one grant').toHaveLength(1);
	const grant = minted[0]!;
	expect(typeof grant).toBe('string');

	// THE GRANT CARRIES NO SUBJECT. Decoded, not trusted: the payload is exactly
	// four keys, and none of them is derived from the account. If a later change
	// smuggles an identifier in here, this fails before anyone ships it.
	const payload = JSON.parse(Buffer.from(grant.split('.')[0], 'base64url').toString());
	expect(Object.keys(payload).sort()).toEqual(['cap', 'exp', 'limits', 'nonce']);
	expect(payload.cap).toBe('transfer.multipart');
	expect(payload.limits).toEqual({ maxParts: 64 });
	expect(JSON.stringify(payload)).not.toMatch(/sub|email|customer|account|user/i);

	// --- 5. received, byte for byte, and burned -----------------------------
	const reader = await context.newPage();
	let claims = 0;
	await reader.route('**/files/claim', (route) => {
		claims++;
		return route.continue();
	});

	await reader.goto(link);
	await expect(reader.getByText(/this file arrives in 3 pieces/i)).toBeVisible();
	expect(claims, 'link arrival must not claim').toBe(0);

	const download = reader.waitForEvent('download', { timeout: 300_000 });
	await reader.getByRole('button', { name: /destroy all 3 stored pieces/i }).click();

	const file = await download;
	expect(file.suggestedFilename()).toBe('nine-mib.bin');
	expect(claims, 'each part is claimed exactly once').toBe(3);

	const got = await readFile(await file.path());
	expect(got.length).toBe(bytes.length);
	expect(createHash('sha256').update(got).digest('hex')).toBe(
		createHash('sha256').update(bytes).digest('hex')
	);

	// It burned. A second reader gets the generic gone state and cannot tell that
	// any part of this transfer ever existed.
	const reader2 = await context.newPage();
	await reader2.goto(link);
	await reader2.getByRole('button', { name: /destroy all 3 stored pieces/i }).click();
	await expect(reader2.getByRole('heading', { name: /this transfer is gone/i })).toBeVisible({
		timeout: 60_000
	});
});

// THE RETRY, and it is a pricing question rather than a transport one.
//
// entitlement-provider.mjs requires that a grant NOT be single-use: a create
// retried after a dropped connection must not fail for the person who paid.
// Under prepaid credits that same retry must also not COST twice, and the answer
// is that the client presents the identical cached grant — same nonce — so a
// retry is recognizable as a retry rather than as a second send.
//
// This asserts the property the credits model will depend on, now, while it is
// cheap to assert: two consecutive multipart creates in one session send ONE
// minted grant, byte for byte.
test('a second send in the same session reuses one grant and mints nothing new', async ({
	page
}) => {
	await page.goto('/account');
	await page.getByRole('button', { name: /sign in with apple/i }).click();
	await expect(page.getByRole('heading', { name: /^signed in$/i })).toBeVisible({
		timeout: 30_000
	});
	await page.goto('/pro');
	await page.getByRole('button', { name: /pay .* for 10 sends/i }).click();
	await expect(page.getByRole('heading', { name: /cinder pro is active/i })).toBeVisible({
		timeout: 60_000
	});

	const mints: string[] = [];
	await page.route('**/capability', async (route) => {
		const res = await route.fetch();
		const body = await res.json();
		if (body.grant) mints.push(body.grant);
		return route.fulfill({ response: res, body: JSON.stringify(body) });
	});

	const presented: string[] = [];
	await page.route('**/files', async (route) => {
		const body = JSON.parse(route.request().postData() || '{}');
		if (body.parts) presented.push(body.capabilityGrant);
		return route.continue();
	});

	// ONE page load, two sends. A reload would clear the in-memory cache and mint
	// again, which is correct behavior and not what this is measuring: the retry
	// that must not double-charge is the one where the sender presses the button
	// again on the page they are already looking at.
	const small = pattern(4 * 1024 * 1024 + 4096);
	await page.goto('/');
	for (const name of ['first.bin', 'second.bin']) {
		await page.getByRole('radio', { name: /^file$/i }).check();
		await page.setInputFiles('#file-input', {
			name,
			mimeType: 'application/octet-stream',
			buffer: small
		});
		await page.getByRole('button', { name: /create one-time link/i }).click();
		await expect(page.getByRole('textbox', { name: /one-time link/i })).toBeVisible({
			timeout: 300_000
		});
		if (name === 'first.bin') await page.getByRole('button', { name: /send something else/i }).click();
	}

	expect(presented, 'two multipart creates').toHaveLength(2);
	expect(presented[0]).toBe(presented[1]);
	expect(mints, 'one mint, reused for both').toHaveLength(1);

	// AND IT COST ONE CREDIT, not two. This is the assertion the retry safety was
	// always for: one mint is one charge, so two sends behind one cached grant
	// move the balance by exactly one. Read off the account page rather than the
	// API, because the number a person can see is the number that has to be true.
	await page.goto('/account');
	await expect(page.getByRole('heading', { name: /^9 credits left$/i })).toBeVisible({
		timeout: 30_000
	});
});
