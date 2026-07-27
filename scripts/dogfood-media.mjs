// Send real media through the LIVE product in a real browser, then open what
// comes back. Byte-identical is necessary and not sufficient — the file has to
// still be the thing it claims to be, so every fixture is verified twice: by
// hash, and by asking the operating system what it thinks the file is.
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Real artifacts only. Synthetic filler round-trips perfectly and proves
// nothing, because it has no structure to break — that is exactly how a
// corrupt fixture once looked like a product bug.
const MEDIA = process.env.CINDER_MEDIA_DIR || path.join(process.cwd(), 'docs/field-notes/build');
const TARGET = process.env.CINDER_TARGET || 'https://cinder.ink/';
const FIXTURES = [
  { file: 'real.pdf', mime: 'application/pdf',  expect: /PDF document/ },
  { file: 'real.png', mime: 'image/png',        expect: /PNG image data/ },
  { file: 'real.mp4', mime: 'video/mp4',        expect: /ISO Media|MP4/ }
];

const sha = (b) => createHash('sha256').update(b).digest('hex');
const browser = await chromium.launch();
const results = [];

for (const fx of FIXTURES) {
  const src = path.join(MEDIA, fx.file);
  const srcBytes = readFileSync(src);
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  const row = { file: fx.file, bytes: srcBytes.length };

  try {
    await page.goto(TARGET, { waitUntil: 'domcontentloaded' });
    await page.getByRole('radio', { name: /^file$/i }).check();
    await page.setInputFiles('#file-input', src);
    await page.getByRole('button', { name: /create one-time link/i }).click();

    const link = await page.getByRole('textbox', { name: /one-time link/i })
      .inputValue({ timeout: 90_000 });
    row.link = link.includes('/f/') && link.includes('#');

    const reader = await ctx.newPage();
    await reader.goto(link, { waitUntil: 'domcontentloaded' });
    const dl = reader.waitForEvent('download', { timeout: 90_000 });
    await reader.getByRole('button', { name: /reveal and destroy/i }).click();

    const download = await dl;
    row.name = download.suggestedFilename();
    const out = path.join(mkdtempSync(path.join(tmpdir(), 'cinder-')), row.name);
    await download.saveAs(out);

    const got = readFileSync(out);
    row.identical = sha(got) === sha(srcBytes);
    row.type = execSync(`file -b "${out}"`).toString().trim().slice(0, 40);
    row.opens = fx.expect.test(row.type);

    // Second reveal must be gone.
    const again = await ctx.newPage();
    await again.goto(link, { waitUntil: 'domcontentloaded' });
    await again.getByRole('button', { name: /reveal and destroy/i }).click();
    // waitFor, not isVisible — isVisible() checks immediately and does not
    // auto-wait, so it reports false while the claim round-trip is still in
    // flight. That produced a false failure the first time this ran.
    row.secondGone = await again
      .getByRole('heading', { name: /this transfer is gone/i })
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
  } catch (e) {
    row.error = String(e).split('\n')[0].slice(0, 90);
  }
  results.push(row);
  await ctx.close();
}
await browser.close();

console.log('\n  FILE        SIZE     NAME KEPT              IDENTICAL  OPENS AS                 2ND=GONE');
for (const r of results) {
  console.log(
    '  ' + r.file.padEnd(11) +
    String(r.bytes).padEnd(8) +
    String(r.name ?? '—').slice(0, 21).padEnd(22) +
    String(r.identical ?? '—').padEnd(11) +
    String(r.type ?? r.error ?? '—').slice(0, 24).padEnd(25) +
    String(r.secondGone ?? '—')
  );
}
const ok = results.every(r => r.identical && r.opens && r.secondGone);
console.log('\n  VERDICT:', ok ? 'ALL MEDIA PASS' : 'FAILURE — see rows above');
process.exit(ok ? 0 : 1);
