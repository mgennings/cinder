import { test, expect, type Page } from '@playwright/test';

// The SENDER's side of ephemeral video (docs/ephemeral-video-design.md):
// disclosure before any encryption, resume after a dropped connection, and a
// status view that is deliberately ignorant. Transfer behavior only — the gate
// here is satisfied by the dev literal, so anything about WHO may send belongs
// in tests/journey, not in this file (see .notes/GOTCHAS.md).

const API = 'http://127.0.0.1:4000';

// Deterministic bytes generated at runtime — no binary fixtures in the repo.
function pattern(n: number): Buffer {
	const out = Buffer.alloc(n);
	for (let i = 0; i < n; i++) out[i] = (i * 31 + 7) & 0xff;
	return out;
}

async function startVideoSend(page: Page, bytes: Buffer, name = 'checkin.mp4'): Promise<void> {
	await page.goto('/');
	await page.getByRole('radio', { name: /^video$/i }).check();
	await page.setInputFiles('#video-input', { name, mimeType: 'video/mp4', buffer: bytes });
}

async function finishVideoSend(page: Page): Promise<{ link: string; locator: string }> {
	await page.getByRole('button', { name: /create one-time link/i }).click();
	const linkInput = page.getByRole('textbox', { name: /one-time link/i });
	await expect(linkInput).toBeVisible({ timeout: 20_000 });
	const link = await linkInput.inputValue();
	const locator = link.match(/\/v\/([A-Za-z0-9_-]{43})#/)?.[1];
	expect(locator, `no video locator in ${link}`).toBeTruthy();
	return { link, locator: locator! };
}

test('the disclosure is on screen before anything encrypts or uploads', async ({ page }) => {
	// Every request to the video API, from page load onward. The order proof is
	// that the disclosure is visible while this list is still empty.
	const videoCalls: string[] = [];
	page.on('request', (r) => {
		if (r.url().startsWith(`${API}/videos`) || r.url().includes('/dev-bucket/')) {
			videoCalls.push(r.url());
		}
	});

	await startVideoSend(page, pattern(64_000));

	// What the sender must be able to READ before the button is pressed. The
	// cost and the zero-knowledge line are visible outright; the rest is one
	// tap away, under the question a person actually asks. The disclosures are
	// native <details>, so their text is in the DOM either way — asserting the
	// summaries is what proves the question is reachable rather than buried.
	await expect(page.getByText(/2 credits/)).toBeVisible();
	await expect(page.getByText('Cinder never sees the video, its name, or your key.')).toBeVisible();
	await expect(page.getByText('Can they save a copy anyway?')).toBeVisible();
	await expect(page.getByText('What happens to my credits?')).toBeVisible();
	// The honesty itself, still stated in full, still before anything encrypts.
	await expect(
		page.getByText(/no app on earth can stop that|record their screen/)
	).toHaveCount(1);
	expect(videoCalls).toEqual([]);

	const { link } = await finishVideoSend(page);
	expect(link).toContain('/v/');
	expect(link).toContain('#');
	// The link carries the segment count after the key, so the watch gate can
	// state the cost without a request on arrival.
	expect(link).toMatch(/#[A-Za-z0-9_-]{43}\.1$/);
	// Only after the press did anything reach the video API.
	expect(videoCalls.length).toBeGreaterThan(0);
});

test('a dropped connection stalls the upload and resume finishes it', async ({ page }) => {
	// Three segments, so the failure lands mid-transfer with one confirmed.
	const bytes = pattern(9 * 1024 * 1024);

	let puts = 0;
	let failed = false;
	await page.route('**/dev-bucket/**', async (route) => {
		if (route.request().method() === 'PUT' && !failed && ++puts === 2) {
			failed = true;
			return route.abort('connectionreset');
		}
		return route.fallback();
	});

	await startVideoSend(page, bytes, 'long-checkin.mp4');
	await expect(page.getByText(/3\s+encrypted pieces/)).toBeVisible();
	await page.getByRole('button', { name: /create one-time link/i }).click();

	// The stall is narrated honestly: where it stopped, and that nothing is lost.
	await expect(page.getByText(/the upload stopped at piece 2 of 3/i)).toBeVisible({
		timeout: 30_000
	});
	await expect(page.getByText(/nothing is\s+lost/i)).toBeVisible();

	// Resume continues from the last confirmed piece rather than starting over.
	await page.getByRole('button', { name: /resume the upload/i }).click();
	const linkInput = page.getByRole('textbox', { name: /one-time link/i });
	await expect(linkInput).toBeVisible({ timeout: 30_000 });
	expect(await linkInput.inputValue()).toContain('/v/');
});

test('the sender status view shows still waiting, and destroy kills an unclaimed video', async ({
	page,
	request
}) => {
	await startVideoSend(page, pattern(48_000));
	const { locator } = await finishVideoSend(page);

	// The link-ready panel offers the one private door, for this browser only.
	await page.getByRole('link', { name: /check on it/i }).click();
	await expect(page.getByRole('heading', { name: /still waiting/i })).toBeVisible();
	// The ignorance is stated as the feature it is.
	await expect(page.getByText(/no\s+timestamps, no identities/i)).toBeVisible();

	await page.getByRole('button', { name: /destroy it unwatched/i }).click();
	await expect(page.getByRole('heading', { name: /^gone$/i })).toBeVisible();
	// Scoped to main: the live region outside it announces the same sentence.
	await expect(page.getByRole('main').getByText(/destroyed unwatched now/i)).toBeVisible();

	// The recipient's link is dark: the claim answers 410, indistinguishably.
	const claim = await request.post(`${API}/videos/claim`, { data: { locator } });
	expect(claim.status()).toBe(410);
});

test('a claimed video and a declined video are indistinguishable to the sender', async ({
	page,
	request
}) => {
	// Video A: the recipient claims it and is mid-watch.
	await startVideoSend(page, pattern(48_000));
	const { locator: claimed } = await finishVideoSend(page);
	const claim = await request.post(`${API}/videos/claim`, { data: { locator: claimed } });
	expect(claim.ok()).toBeTruthy();

	// Video B: the recipient declines at the gate, destroying it unwatched.
	await page.getByRole('button', { name: /send something else/i }).click();
	await page.getByRole('radio', { name: /^video$/i }).check();
	await page.setInputFiles('#video-input', {
		name: 'second.mp4',
		mimeType: 'video/mp4',
		buffer: pattern(48_000)
	});
	const { locator: declined } = await finishVideoSend(page);
	const destroy = await request.post(`${API}/videos/destroy`, { data: { locator: declined } });
	expect(destroy.ok()).toBeTruthy();

	// The sender's view of both is byte-for-byte the same page: same one word,
	// same copy, no timestamp, no tell. Declining carries no social penalty the
	// sender can measure — that is the promise, rendered.
	await page.goto(`/video/${claimed}`);
	await expect(page.getByRole('heading', { name: /^gone$/i })).toBeVisible();
	const claimedText = (await page.getByRole('main').innerText()).trim();

	await page.goto(`/video/${declined}`);
	await expect(page.getByRole('heading', { name: /^gone$/i })).toBeVisible();
	const declinedText = (await page.getByRole('main').innerText()).trim();

	expect(declinedText).toBe(claimedText);
	expect(claimedText).not.toMatch(/\d{1,2}:\d{2}/); // no clock, no timestamp
});

test('the sender can add time to an open watch window, funded by prepaid first', async ({
	page,
	request
}) => {
	await startVideoSend(page, pattern(48_000));
	const { locator } = await finishVideoSend(page);

	// The recipient claims; the window is open. (The dev grant carries 2
	// prepaid extensions, so the sender's add-time needs no identity here.)
	const claim = await request.post(`${API}/videos/claim`, { data: { locator } });
	expect(claim.ok()).toBeTruthy();
	const before = (await claim.json()).deadlineEpoch as number;

	await page.goto(`/video/${locator}`);
	await expect(page.getByRole('heading', { name: /^gone$/i })).toBeVisible();
	await page.getByRole('button', { name: /add 8 minutes/i }).click();
	// Scoped to main: the live region outside it announces the same sentence.
	await expect(page.getByRole('main').getByText(/8 minutes added to the open window/i)).toBeVisible();

	// The claim resumes with the same shape, and the server's deadline moved.
	const after = await request.post(`${API}/videos/claim`, { data: { locator } });
	expect(after.ok()).toBeTruthy();
	expect((await after.json()).deadlineEpoch).toBe(before + 480);
});

test('a stranger at the status route learns nothing', async ({ page, browser }) => {
	await startVideoSend(page, pattern(48_000));
	const { locator } = await finishVideoSend(page);

	// A different person: a fresh context, not a tab sharing the sender's
	// storage (.notes/GOTCHAS.md, the sender-vs-stranger trap).
	const stranger = await browser.newContext();
	const strangerPage = await stranger.newPage();
	await strangerPage.goto(`/video/${locator}`);
	await expect(strangerPage.getByRole('heading', { name: /nothing to show here/i })).toBeVisible();
	// Not even whether the locator is real.
	await expect(strangerPage.getByText(/holds no record/i)).toBeVisible();
	await stranger.close();
});
