import { test, expect, type Page } from '@playwright/test';
import { videoSegmenter } from '../../src/lib/video/crypto';
import { deriveSegmentLocator } from '../../src/lib/link';

// The recipient watch journey, against the real dev API where the promise is
// server-enforced, and against a mocked API where the thing under test is the
// SCREEN's honesty about a server number it does not control.
//
// Segments are sealed here in Node with the same client crypto the browser
// uses (src/lib/video/crypto.ts), because the composer belongs to another
// slice — the wire format is the contract, not the UI that feeds it.

const API = 'http://127.0.0.1:4000';

function pattern(n: number): Buffer {
	const out = Buffer.alloc(n);
	for (let i = 0; i < n; i++) out[i] = (i * 31 + 7) & 0xff;
	return out;
}

async function postJson(path: string, body: unknown) {
	const res = await fetch(`${API}${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	if (!res.ok) throw new Error(`${path} answered ${res.status}`);
	return res.json();
}

type Sealed = {
	fragmentKey: string;
	segments: number;
	envelopes: { ciphertext: Uint8Array; ciphertextBytes: number; ciphertextSha256: string }[];
};

async function seal(bytes: Buffer, name = 'checkin.mp4'): Promise<Sealed> {
	const stream = await videoSegmenter.open(new File([new Uint8Array(bytes)], name, { type: 'video/mp4' }));
	const envelopes: Sealed['envelopes'] = [];
	for await (const { envelope } of stream.envelopes()) envelopes.push(envelope);
	return { fragmentKey: stream.fragmentKey, segments: stream.segments, envelopes };
}

/** Create, upload, and seal a real video against the dev API. */
async function mintVideo(bytes: Buffer): Promise<{ link: string; locator: string }> {
	const sealed = await seal(bytes);
	const grant = await postJson('/videos', {
		segments: sealed.envelopes.map((e) => ({
			ciphertextBytes: e.ciphertextBytes,
			ciphertextSha256: e.ciphertextSha256
		})),
		ttlSeconds: 3600,
		capabilityGrant: 'dev-capability-grant'
	});
	for (let i = 0; i < sealed.envelopes.length; i++) {
		const put = await fetch(grant.segments[i].upload.url, {
			method: 'PUT',
			headers: grant.segments[i].upload.headers,
			body: sealed.envelopes[i].ciphertext as unknown as BodyInit
		});
		if (!put.ok) throw new Error(`segment PUT answered ${put.status}`);
		await postJson('/videos/finalize', {
			locator: await deriveSegmentLocator(grant.locator, i),
			uploadCapability: grant.uploadCapability
		});
	}
	await postJson('/videos/finalize', {
		locator: grant.locator,
		uploadCapability: grant.uploadCapability
	});
	return {
		link: `/v/${grant.locator}#${sealed.fragmentKey}.${sealed.segments}`,
		locator: grant.locator
	};
}

const epoch = () => Math.floor(Date.now() / 1000);

/**
 * A fully mocked watch session: the page decrypts REAL ciphertext, but every
 * deadline is a number this test chose — which is exactly how the countdown's
 * honesty is provable. If the screen ever renders a theatrical number instead
 * of the server's, these assertions go red.
 */
async function mockSession(
	page: Page,
	sealed: Sealed,
	{ finishedDeadlineIn }: { finishedDeadlineIn: number }
) {
	await page.route('**/videos/claim', (route) =>
		route.fulfill({
			json: {
				deadlineEpoch: epoch() + 3840,
				segments: sealed.segments,
				finished: false,
				prepaidRemaining: 2,
				extensionsUsed: 0
			}
		})
	);
	// The mock segment URL sits on the API origin: the dev CSP's connect-src
	// allows only self, the API, and the media bucket, and an interception
	// still has to pass CSP before Playwright ever sees the request.
	await page.route('**/videos/segment-url', (route) =>
		route.fulfill({ json: { url: `${API}/__mock-seg-0`, expiresIn: 480 } })
	);
	await page.route('**/__mock-seg-0', (route) =>
		route.fulfill({
			body: Buffer.from(sealed.envelopes[0].ciphertext),
			contentType: 'application/octet-stream'
		})
	);
	await page.route('**/videos/finished', (route) =>
		route.fulfill({ json: { deadlineEpoch: epoch() + finishedDeadlineIn } })
	);
}

async function startWatching(page: Page, link: string) {
	await page.goto(link);
	await page.getByRole('button', { name: /^start watching$/i }).click();
	await expect(page.locator('video')).toBeVisible({ timeout: 20_000 });
}

const endPlayback = (page: Page) =>
	page.locator('video').evaluate((v) => v.dispatchEvent(new Event('ended')));

// --- the gate ---------------------------------------------------------------

test('the gate fetches nothing until a human acts — link-preview bots get words', async ({
	page
}) => {
	const { link } = await mintVideo(pattern(96_000));

	const apiCalls: string[] = [];
	await page.route('**/videos/**', (route) => {
		apiCalls.push(new URL(route.request().url()).pathname);
		return route.continue();
	});

	await page.goto(link);

	// The whole choice is on screen, rendered from the link alone.
	await expect(page.getByText('Someone sent you a video, for you alone.')).toBeVisible();
	await expect(page.getByRole('button', { name: /^start watching$/i })).toBeVisible();
	await expect(page.getByRole('button', { name: /decline and destroy it unwatched/i })).toBeVisible();
	await expect(
		page.getByText(/The sender only ever sees that it is gone, never whether you watched or declined\./)
	).toBeVisible();
	await expect(page.getByText(/nothing on the web can stop a screen recording/)).toBeVisible();

	await page.waitForTimeout(500);
	expect(apiCalls, 'link arrival must not touch the video API').toHaveLength(0);

	// The human acts; only then does the claim open the window.
	await page.getByRole('button', { name: /^start watching$/i }).click();
	await expect(page.locator('video')).toBeVisible({ timeout: 20_000 });
	expect(apiCalls).toContain('/videos/claim');
});

test('declining at the gate destroys unwatched, and a later visitor finds it gone', async ({
	page,
	browser
}) => {
	const { link } = await mintVideo(pattern(64_000));

	await page.goto(link);
	await page.getByRole('button', { name: /decline and destroy it unwatched/i }).click();
	await expect(page.getByRole('heading', { name: 'Destroyed unwatched' })).toBeVisible();

	// A different person holding the same link. A fresh context, per GOTCHAS —
	// a same-context tab would be the first browser, not a stranger. A manual
	// context inherits no baseURL, so it is read off the project config.
	const base = test.info().project.use.baseURL ?? 'http://127.0.0.1:5178';
	const stranger = await browser.newContext();
	const later = await stranger.newPage();
	await later.goto(`${base}${link}`);
	await later.getByRole('button', { name: /^start watching$/i }).click();
	await expect(later.getByRole('heading', { name: 'This video is no longer available' })).toBeVisible();
	await stranger.close();
});

// --- countdown honesty ------------------------------------------------------

test('the countdown renders the server deadline, never a theatrical 8:00', async ({ page }) => {
	const sealed = await seal(pattern(48_000));
	// The server answers finished with now+300 — NOT the 480 the copy talks
	// about. An honest screen shows 5:00; a theatrical one shows 8:00.
	await mockSession(page, sealed, { finishedDeadlineIn: 300 });

	await startWatching(page, `/v/mockedvideolocator#${sealed.fragmentKey}.1`);
	await endPlayback(page);

	// Scoped to main: the polite live region announces the same sentence.
	await expect(page.getByRole('main').getByText('You watched all of it.')).toBeVisible();
	const digits = page.getByTestId('ember-digits');
	await expect(digits).toBeVisible();
	const first = (await digits.textContent()) ?? '';
	expect(first, 'the countdown must render the mocked server deadline').toMatch(/^(5:00|4:5\d)$/);

	// And it counts: the numeral moves with the real clock.
	await page.waitForTimeout(2_000);
	const second = (await digits.textContent()) ?? '';
	expect(second).not.toBe(first);
	expect(second).toMatch(/^4:5\d$/);

	// The timer is not color-alone: numeral, label, and shape all present.
	await expect(page.getByRole('timer')).toHaveAttribute('aria-label', /left on Cinder's copy/);
});

test('an extension moves the clock to the new server deadline', async ({ page }) => {
	const sealed = await seal(pattern(48_000));
	await mockSession(page, sealed, { finishedDeadlineIn: 300 });
	await page.route('**/videos/extend', (route) =>
		route.fulfill({
			json: { deadlineEpoch: epoch() + 769, prepaidRemaining: 1, extensionsUsed: 1 }
		})
	);

	await startWatching(page, `/v/mockedvideolocator#${sealed.fragmentKey}.1`);
	await endPlayback(page);

	// Prepaid: one tap, no account, no card.
	await expect(page.getByText(/Prepaid by the sender: 2 left/)).toBeVisible();
	await page.getByRole('button', { name: /add 8 minutes/i }).click();

	const digits = page.getByTestId('ember-digits');
	await expect(digits).toHaveText(/^12:4\d$/);
	await expect(page.getByText(/Prepaid by the sender: 1 left/)).toBeVisible();
});

test('reduced motion still renders the composed countdown and counts', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	const sealed = await seal(pattern(48_000));
	await mockSession(page, sealed, { finishedDeadlineIn: 300 });

	await startWatching(page, `/v/mockedvideolocator#${sealed.fragmentKey}.1`);
	await endPlayback(page);

	const digits = page.getByTestId('ember-digits');
	await expect(digits).toBeVisible();
	const first = (await digits.textContent()) ?? '';
	await page.waitForTimeout(2_000);
	expect(await digits.textContent()).not.toBe(first);
});

// --- zero -------------------------------------------------------------------

test('zero mid-rewatch stops playback, discards the local copy, and closes warmly', async ({
	page
}) => {
	const sealed = await seal(pattern(48_000));
	await mockSession(page, sealed, { finishedDeadlineIn: 4 });

	await startWatching(page, `/v/mockedvideolocator#${sealed.fragmentKey}.1`);
	await endPlayback(page);

	// The window ends while the player is still on screen. The page lets go:
	// no video element, no download, and the copy closes warmly.
	await expect(page.getByRole('heading', { name: 'That is the whole thing' })).toBeVisible({
		timeout: 15_000
	});
	await expect(page.getByRole('main').getByText(/What you saw stays with you\./)).toBeVisible();
	await expect(page.locator('video')).toHaveCount(0);
});
