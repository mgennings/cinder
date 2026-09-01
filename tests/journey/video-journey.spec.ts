import { test, expect, type Page } from '@playwright/test';

// THE VIDEO MONEY SEAM, against the REAL mint.
//
// tests/e2e proves how a video behaves with the capability gate satisfied by a
// dev literal. This is the other half, and the only place it can be proven:
// the journey server carries no dev grant, so every capability here is minted
// by the shipped mint in api/src/entitlement.mjs — which is exactly the code
// that must refuse the unpaid.
//
// THE ORDER IS THE TEST, same as full-journey.spec.ts: the refusals come
// first, because a run that only asserted the paid success would pass just as
// happily if the mint granted on a valid token alone.
//
//   1. signed in, unpaid → video send refused: the mint was asked and answered
//      null, so an account is not a purchase for video either
//   2. signed in, unpaid → video.extend mints nothing: an unpaid extension
//      cannot exist, because the only path to one is this mint
//   3. paid → both mint, subject-free, and the balance moves by exactly the
//      advertised cost (2-credit send + 1 credit per prepaid extension —
//      every number is Matt's pricing gate, docs/ephemeral-video-design.md)
test.describe.configure({ mode: 'serial', timeout: 300_000 });

const IDENTITY = 'http://127.0.0.1:4100';

function pattern(n: number): Buffer {
	const out = Buffer.alloc(n);
	for (let i = 0; i < n; i++) out[i] = (i * 41 + 3) & 0xff;
	return out;
}

/** Ask the identity API for a capability with the page's own session token —
 * the same bearer + endpoint the shipped client uses, minus the UI that only
 * exists once a watch session is already open. */
function mintFromPage(page: Page, capability: string) {
	return page.evaluate(
		async ({ identity, capability }) => {
			const tokens = JSON.parse(sessionStorage.getItem('cinder.tokens') ?? 'null');
			const res = await fetch(`${identity}/capability`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${tokens.idToken}`
				},
				body: JSON.stringify({ capability })
			});
			return (await res.json()) as { grant: string | null };
		},
		{ identity: IDENTITY, capability }
	);
}

const decodeGrant = (grant: string) =>
	JSON.parse(Buffer.from(grant.split('.')[0], 'base64url').toString());

async function attemptVideoSend(page: Page, prepaidLabel?: RegExp): Promise<void> {
	await page.goto('/');
	await page.getByRole('radio', { name: /^video$/i }).check();
	await page.setInputFiles('#video-input', {
		name: 'checkin.mp4',
		mimeType: 'video/mp4',
		buffer: pattern(96_000)
	});
	if (prepaidLabel) await page.getByRole('radio', { name: prepaidLabel }).check();
	// The cost is on screen before the button that spends anything.
	await expect(page.getByText(/2 credits/)).toBeVisible();
	await page.getByRole('button', { name: /create one-time link/i }).click();
}

test('video send refused unpaid, extend unmintable unpaid, both minted subject-free after paying', async ({
	page
}) => {
	// --- signed in, and that is not enough ----------------------------------
	await page.goto('/account');
	await page.getByRole('button', { name: /sign in with apple/i }).click();
	await expect(page.getByRole('heading', { name: /^signed in$/i })).toBeVisible({
		timeout: 30_000
	});

	// The mint is observed at the network, not inferred from the refusal: a
	// client that never asked and a mint that said no look identical on screen.
	let minted: (string | null)[] = [];
	await page.route('**/capability', async (route) => {
		const res = await route.fetch();
		const body = await res.json();
		minted.push(body.grant);
		return route.fulfill({ response: res, body: JSON.stringify(body) });
	});

	// 1. The send. Refused by the real mint, worded as a state, not a fault.
	await attemptVideoSend(page);
	await expect(page.getByRole('alert')).toContainText(
		/costs 2 credits and this account has none left/i
	);
	expect(minted, 'the client asked the real mint').toHaveLength(1);
	expect(minted[0], 'an account without a purchase mints no video.send').toBeNull();

	// 2. The extension. An unpaid extension cannot pass, because the only path
	// to one is this mint and this mint refuses.
	const unpaidExtend = await mintFromPage(page, 'video.extend');
	expect(unpaidExtend.grant, 'an account without a purchase mints no video.extend').toBeNull();

	// --- pay ----------------------------------------------------------------
	await page.goto('/pro');
	await page.getByRole('button', { name: /pay .* for 10 sends/i }).click();
	await expect(page.getByRole('heading', { name: /cinder pro is active/i })).toBeVisible({
		timeout: 60_000
	});

	// 3a. The extension mints now, carries no subject, and costs 1 credit.
	const paidExtend = await mintFromPage(page, 'video.extend');
	expect(typeof paidExtend.grant).toBe('string');
	const extendPayload = decodeGrant(paidExtend.grant!);
	expect(Object.keys(extendPayload).sort()).toEqual(['cap', 'exp', 'limits', 'nonce']);
	expect(extendPayload.cap).toBe('video.extend');
	expect(extendPayload.limits).toEqual({ extensions: 1 });
	expect(JSON.stringify(extendPayload)).not.toMatch(/sub|email|customer|account|user/i);

	// 3b. The send mints, with two prepaid extensions riding in the LIMITS —
	// the only place they may travel, never as a subject.
	minted = [];
	await attemptVideoSend(page, /^16 min$/i);
	const linkInput = page.getByRole('textbox', { name: /one-time link/i });
	await expect(linkInput).toBeVisible({ timeout: 120_000 });
	expect(await linkInput.inputValue()).toMatch(/\/v\/[^#]+#[^.]+\.1$/);

	const sendGrant = minted.find((g) => g !== null);
	expect(sendGrant, 'the paid send minted a grant').toBeTruthy();
	const sendPayload = decodeGrant(sendGrant!);
	expect(Object.keys(sendPayload).sort()).toEqual(['cap', 'exp', 'limits', 'nonce']);
	expect(sendPayload.cap).toBe('video.send');
	expect(sendPayload.limits).toEqual({ maxSegments: 128, prepaidExtensions: 2 });
	expect(JSON.stringify(sendPayload)).not.toMatch(/sub|email|customer|account|user/i);

	// --- the balance moved by exactly the advertised cost --------------------
	// 10 bought − 1 (extend mint) − 2 (send) − 2 (two prepaid at 1 each) = 5.
	// Read off the account page, because the number a person can see is the
	// number that has to be true.
	await page.goto('/account');
	await expect(page.getByRole('heading', { name: /^5 credits left$/i })).toBeVisible({
		timeout: 30_000
	});
});
