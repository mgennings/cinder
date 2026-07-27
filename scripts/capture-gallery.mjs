// Capture the 0.2.0 gallery: every product surface, both color schemes, at a
// real iPhone 17 Pro Max — plus one short motion clip of the core journey.
//
// This replaces hand-taken phone screenshots dropped in ~/Downloads. Those were
// unreproducible: nobody could say which build they showed, and a stale one
// looked exactly like a current one.
//
//   node scripts/capture-gallery.mjs            # against https://cinder.ink
//   node scripts/capture-gallery.mjs --local    # against a dev stack you started
//   node scripts/capture-gallery.mjs --only compose,reveal
//   node scripts/capture-gallery.mjs --list     # names only, captures nothing
//
// Production is the default on purpose: a gallery is a claim about the shipped
// product, so it gets photographed from the shipped product. The link-ready,
// reveal, and transfer-record scenes therefore create and burn real notes and
// files. That is the design — they are one-time by construction — so every
// payload here is obviously synthetic and carries nothing real.
import { chromium, devices } from '@playwright/test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(REPO, 'artifacts', 'site-gallery-0.2.0');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
	const i = argv.indexOf(`--${name}`);
	return i === -1 ? null : argv[i + 1];
};

const BASE = flag('local') ? 'http://127.0.0.1:5178' : 'https://cinder.ink';

// iPhone 17 Pro Max. 440x956 CSS at 3x = 1320x2868 PNGs, which is what the
// downstream framing pipeline expects — it will not accept anything else.
const { defaultBrowserType: _ignored, ...IPHONE } = devices['iPhone 15 Pro Max'];
const DEVICE = {
	...IPHONE,
	viewport: { width: 440, height: 956 },
	deviceScaleFactor: 3,
	isMobile: true,
	hasTouch: true
};
const EXPECT = { width: 1320, height: 2868 };

const SYNTHETIC_NOTE = 'Rehearsal dinner is at 6:30, the good bakery on Third. Do not tell Mara.';
const SYNTHETIC_FILE = {
	name: 'seating-chart.txt',
	mimeType: 'text/plain',
	// Deterministic and harmless. Never a real secret, even on a burn-on-read service.
	buffer: Buffer.from('SYNTHETIC CAPTURE FIXTURE — table 1: Mara, Jonah, Priya\n'.repeat(12))
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- shared steps ----------------------------------------------------------

async function composeNote(page, { passphrase } = {}) {
	await page.goto(BASE, { waitUntil: 'domcontentloaded' });
	await page.getByPlaceholder(/type your secret/i).fill(SYNTHETIC_NOTE);
	if (passphrase) {
		await page.getByLabel(/add a passphrase/i).check();
		await page.getByPlaceholder(/passphrase \(needed to open/i).fill(passphrase);
	}
}

async function composeFile(page) {
	await page.goto(BASE, { waitUntil: 'domcontentloaded' });
	await page.getByRole('radio', { name: /^file$/i }).check();
	await page.setInputFiles('#file-input', SYNTHETIC_FILE);
}

async function createLink(page) {
	await page.getByRole('button', { name: /create one-time link/i }).click();
	return page.getByRole('textbox', { name: /one-time link/i }).inputValue({ timeout: 90_000 });
}

/**
 * Pin a heading to the top of the viewport.
 *
 * Not `scrollIntoViewIfNeeded` — this viewport is 956 CSS px tall, so the
 * heading is usually already "in view" and that call is a no-op. Two /security
 * scenes came out byte-identical before this was forced.
 */
async function scrollTo(page, heading) {
	const el = page.getByRole('heading', { name: heading });
	await el.waitFor({ state: 'visible', timeout: 60_000 });
	await el.evaluate((node) => {
		node.scrollIntoView({ block: 'start', behavior: 'instant' });
		window.scrollBy(0, -24);
	});
	await sleep(350);
}

// --- the scenes ------------------------------------------------------------
//
// `assert` is not decoration. A screenshot of a page that never rendered is a
// blank PNG that reports success, which is the exact failure this script
// exists to end. Every scene names something that must be visible first.
const SCENES = [
	{
		name: 'compose',
		note: 'the note composer with a message typed',
		async setup(page) {
			await composeNote(page);
			await page.getByPlaceholder(/type your secret/i).blur();
		},
		assert: (page) => page.getByRole('button', { name: /create one-time link/i })
	},
	{
		name: 'file',
		note: 'the encrypted file-transfer chooser with a file selected',
		async setup(page) {
			await composeFile(page);
		},
		assert: (page) => page.getByText(/seating-chart\.txt/i)
	},
	{
		name: 'passphrase',
		note: 'the two-factor passphrase field on top of the link',
		async setup(page) {
			await composeNote(page, { passphrase: 'juniper-lantern' });
			await page.getByPlaceholder(/passphrase \(needed to open/i).blur();
		},
		assert: (page) => page.getByPlaceholder(/passphrase \(needed to open/i)
	},
	{
		name: 'link-ready',
		note: 'the created one-time link, ready to copy',
		async setup(page) {
			await composeNote(page);
			await createLink(page);
		},
		assert: (page) => page.getByRole('heading', { name: /your one-time link is ready/i })
	},
	{
		name: 'reveal',
		note: 'the recipient gate, stating the irreversible cost before the press',
		async setup(page, ctx) {
			const sender = await ctx.newPage();
			await composeFile(sender);
			const link = await createLink(sender);
			await sender.close();
			await page.goto(link, { waitUntil: 'domcontentloaded' });
		},
		assert: (page) => page.getByText(/Exactly one server delivery can begin/)
	},
	{
		name: 'transfer-record',
		note: 'the technical readout on delivery — five rows, all entailed',
		async setup(page, ctx) {
			const sender = await ctx.newPage();
			await composeFile(sender);
			const link = await createLink(sender);
			await sender.close();
			await page.goto(link, { waitUntil: 'domcontentloaded' });
			const download = page.waitForEvent('download', { timeout: 90_000 });
			await page.getByRole('button', { name: /reveal and destroy/i }).click();
			await download;
		},
		assert: (page) => page.getByText(/Deleted, absence verified/i)
	},
	{
		name: 'privacy-intro',
		note: '/security — the honest opening and what Cinder protects',
		async setup(page) {
			await page.goto(`${BASE}/security`, { waitUntil: 'domcontentloaded' });
		},
		assert: (page) => page.getByRole('heading', { name: /how private is this, really/i })
	},
	{
		name: 'file-promise',
		note: '/security — the file promise and its permanent-loss cost',
		async setup(page) {
			await page.goto(`${BASE}/security`, { waitUntil: 'domcontentloaded' });
			await scrollTo(page, /sending a file/i);
		},
		assert: (page) => page.getByRole('heading', { name: /sending a file/i })
	},
	{
		name: 'privacy-limits',
		note: "/security — what Cinder can't protect",
		async setup(page) {
			await page.goto(`${BASE}/security`, { waitUntil: 'domcontentloaded' });
			await scrollTo(page, /what cinder can't protect/i);
		},
		assert: (page) => page.getByRole('heading', { name: /what cinder can't protect/i })
	},
	{
		name: 'field-notes',
		note: '/field-notes — the vote to stay blind',
		async setup(page) {
			await page.goto(`${BASE}/field-notes`, { waitUntil: 'domcontentloaded' });
		},
		assert: (page) => page.getByRole('heading', { name: /the vote to stay blind/i })
	}
];

// --- run -------------------------------------------------------------------

if (flag('list')) {
	for (const s of SCENES) console.log(`${s.name.padEnd(16)} ${s.note}`);
	process.exit(0);
}

const only = value('only')?.split(',').map((s) => s.trim());
const scenes = only ? SCENES.filter((s) => only.includes(s.name)) : SCENES;
if (only && scenes.length !== only.length) {
	throw new Error(`unknown scene in --only: ${only.filter((n) => !SCENES.some((s) => s.name === n))}`);
}

// A full run owns the whole tree and starts clean, so a scene deleted from the
// list can never linger as a stale PNG. `--only` re-shoots in place instead.
if (!only) await rm(OUT, { recursive: true, force: true });
const browser = await chromium.launch();
const manifest = [];

for (const colorScheme of ['light', 'dark']) {
	const dir = path.join(OUT, colorScheme);
	await mkdir(dir, { recursive: true });

	for (const scene of scenes) {
		// A fresh context per scene: link-ready, reveal, and transfer-record each
		// consume a real one-time link, and nothing may leak between scenes.
		const ctx = await browser.newContext({
			...DEVICE,
			colorScheme,
			// Stills only. Reduced motion means nothing is ever caught mid-transition;
			// the motion clip below deliberately runs without it.
			reducedMotion: 'reduce',
			acceptDownloads: true
		});
		const page = await ctx.newPage();
		const file = path.join(dir, `${scene.name}.png`);

		await scene.setup(page, ctx);
		await scene.assert(page).waitFor({ state: 'visible', timeout: 60_000 });
		await sleep(400); // let fonts and the ambient glow settle
		await page.screenshot({ path: file });

		manifest.push({ scheme: colorScheme, scene: scene.name, file, note: scene.note });
		console.log(`  ${colorScheme.padEnd(5)} ${scene.name.padEnd(16)} ${scene.note}`);
		await ctx.close();
	}
}

// --- motion: compose -> link -> reveal -> burn, under 8 seconds -------------
//
// Raw capture only. A downstream lane frames it, so this stays an honest
// recording of the real flow at full motion — no GIF, no speed-up, no cuts.
// `--only` is for re-shooting a still that drifted; it leaves the clip alone.
if (only) {
	await browser.close();
	console.log(`\n  ${manifest.length} stills re-shot at ${EXPECT.width}x${EXPECT.height}`);
	console.log(`  motion clip left untouched — run without --only to re-record it`);
	process.exit(0);
}

const motionDir = path.join(OUT, 'motion');
await mkdir(motionDir, { recursive: true });
const raw = path.join(motionDir, 'raw');

const ctx = await browser.newContext({
	...DEVICE,
	colorScheme: 'dark',
	reducedMotion: 'no-preference',
	acceptDownloads: true,
	// Record at the CSS viewport, 1:1.
	//
	// ponytail: Chromium records at CSS resolution and Playwright will scale a
	// frame DOWN to fit `size` but never UP. Asking for 1320x2868 does not give a
	// 3x capture — it draws a 440x956 frame into the top-left corner of a
	// 1320x2868 canvas and pads the rest gray. ffmpeg upscales below instead, so
	// the clip's real detail ceiling is 1x. If that ever matters, the upgrade is
	// a screen recorder outside the browser, not a bigger number here.
	recordVideo: { dir: raw, size: DEVICE.viewport }
});
const page = await ctx.newPage();
const senderVideo = page.video();

await composeNote(page);
await sleep(500);
const link = await createLink(page);
await sleep(900);
// Closing the sender finalizes its recording. Leaving it open would keep it
// filming through the recipient's half, and the concatenation would double-count.
await page.close();

const reader = await ctx.newPage();
const readerVideo = reader.video();
await reader.goto(link, { waitUntil: 'domcontentloaded' });
await sleep(700);
await reader.getByRole('button', { name: /reveal note/i }).click();
await reader.getByText(/Cinder's stored copy is gone/i).waitFor({ state: 'visible', timeout: 60_000 });
await sleep(800);
await ctx.close();
await browser.close();

// Explicit paths, not a directory listing: Playwright names recordings with a
// random hash, so sorting the directory would splice the journey out of order.
const parts = [await senderVideo.path(), await readerVideo.path()];
if (parts.some((p) => !p)) throw new Error('no video recorded');
const clip = path.join(motionDir, 'core-journey.mp4');
// Concatenating the two recordings gives one continuous journey: the composer,
// then the recipient's arrival and burn.
const list = path.join(motionDir, 'concat.txt');
await writeFile(list, parts.map((p) => `file '${p}'`).join('\n'));
execFileSync('ffmpeg', [
	'-y', '-hide_banner', '-loglevel', 'error',
	'-f', 'concat', '-safe', '0', '-i', list,
	'-vf', `scale=${EXPECT.width}:${EXPECT.height}:flags=lanczos`,
	'-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-an',
	clip
]);
await rm(list);
await rm(raw, { recursive: true, force: true }); // the webm sources are scratch

const seconds = Number(
	execFileSync('ffprobe', [
		'-v', 'error', '-show_entries', 'format=duration',
		'-of', 'default=nw=1:nk=1', clip
	]).toString().trim()
);
if (seconds > 8) {
	throw new Error(`motion clip is ${seconds.toFixed(1)}s; the brief caps it at 8s`);
}

console.log(`\n  ${manifest.length} stills at ${EXPECT.width}x${EXPECT.height}`);
console.log(`  motion  ${clip}  ${seconds.toFixed(1)}s`);
console.log(`  source  ${BASE}`);
console.log(`  out     ${OUT}`);
