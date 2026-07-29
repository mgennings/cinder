// Browser gate for the stats charts' inspection layer.
//
// These charts used to be `role="img"` polylines with no cursor, no marker, no
// readout, and no keyboard or pointer handling at all: a reader could see a
// shape and never learn a single value from it. This file loads dashboard.html
// directly, as an authenticated session would see it, stubs `/api/metrics`, and
// proves the four things that were false.
//
// It measures composited pixels and real client rects. A computed style is not
// evidence here: the readout paints a translucent panel with a backdrop blur
// over whatever the chart happens to be drawing underneath it.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { chromium } from "@playwright/test";

const HERE = new URL(".", import.meta.url);
const BREAKPOINTS = [320, 375, 440, 768, 1440];
const APPEARANCES = ["light", "dark"];
const POINTS = 24;

const ASSETS = new Map([
  ["/stats.css", ["site/stats.css", "text/css; charset=utf-8"]],
  ["/navigation.js", ["site/navigation.js", "application/javascript; charset=utf-8"]],
  ["/dashboard.js", ["site/dashboard.js", "application/javascript; charset=utf-8"]],
]);

// Deterministic, and deliberately NOT monotonic: a marker that only ever climbs
// would never sit mid-field, which is exactly where an overlaid readout covered
// it. The sawtooth puts the selection at every height in the plot.
const metricsPayload = () => {
  const end = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const series = [
    { id: "invocations", label: "invocations", unit: "count", aggregation: "sum", summary: 4210 },
    { id: "errors", label: "errors", unit: "count", aggregation: "sum", summary: 12 },
    { id: "duration", label: "duration", unit: "milliseconds", aggregation: "average", summary: 84.2 },
  ];
  return {
    scope: { functionCount: 11 },
    checkedAt: new Date(end).toISOString(),
    range: { id: "24h", mode: "live", end: new Date(end).toISOString(), label: "24 hours ending now" },
    series: series.map((entry, position) => ({
      ...entry,
      points: Array.from({ length: POINTS }, (_, index) => ({
        at: new Date(end - (POINTS - index) * 3_600_000).toISOString(),
        value: 10 + ((index * (7 + position * 5)) % 90),
      })),
    })),
  };
};

const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  const json = (body) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (path === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return response.end(await readFile(new URL("site/dashboard.html", HERE)));
  }
  if (path === "/api/metrics") return json(metricsPayload());
  if (path === "/api/navigation") return json({ destinations: [] });
  if (path === "/api/logout") return json({ ok: true });
  if (path === "/favicon.ico" || path.endsWith(".woff2")) {
    response.writeHead(204);
    return response.end();
  }
  const asset = ASSETS.get(path);
  if (!asset) {
    response.writeHead(404);
    return response.end();
  }
  response.writeHead(200, { "content-type": asset[1] });
  return response.end(await readFile(new URL(asset[0], HERE)));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });

// WCAG's ratio, computed in the page from a real capture of the readout's own
// box, so a translucent blurred panel is judged by the pixels a reader gets.
const CONTRAST_PROBE = async ({ png }) => {
  const image = new Image();
  image.src = `data:image/png;base64,${png}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0);

  const channel = (value) => {
    const part = value / 255;
    return part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
  };
  const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

  // Inset past the border and the blur fringe; sample the panel interior only.
  const inset = Math.max(4, Math.round(Math.min(canvas.width, canvas.height) * 0.16));
  const { data } = context.getImageData(inset, inset, canvas.width - inset * 2, canvas.height - inset * 2);
  const counts = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const paper = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0].split(",").map(Number);
  const paperLuminance = luminance(paper);
  let ink = paper;
  let widest = 0;
  for (const key of counts.keys()) {
    const candidate = key.split(",").map(Number);
    const distance = Math.abs(luminance(candidate) - paperLuminance);
    if (distance > widest) {
      widest = distance;
      ink = candidate;
    }
  }
  const [high, low] = [luminance(paper), luminance(ink)].sort((a, b) => b - a);
  return { paper, ink, ratio: (high + 0.05) / (low + 0.05) };
};

try {
  for (const appearance of APPEARANCES) {
    for (const width of BREAKPOINTS) {
      const label = `${width} ${appearance}`;
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        colorScheme: appearance,
        reducedMotion: "reduce",
        // A tap emits pointerdown and pointerup and no pointermove at all. A
        // mouse-only context cannot express the event sequence every phone
        // actually sends, which is the sequence that used to do nothing.
        hasTouch: true,
      });
      const consoleErrors = [];
      page.on("pageerror", (error) => consoleErrors.push(String(error)));
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });

      await page.goto(origin, { waitUntil: "networkidle" });
      await page.waitForFunction(() => document.querySelectorAll("#metric-grid .metric-card").length >= 3);
      assert.deepEqual(consoleErrors, [], `${label}: console errors on arrival`);

      const figure = page.locator("#metric-grid figure").first();
      await figure.scrollIntoViewIfNeeded();

      // -- a scrubbable series is a slider, and it speaks its current value ---
      assert.equal(await figure.getAttribute("role"), "slider", `${label}: an inspectable chart must not announce as a static image`);
      assert.equal(await figure.getAttribute("aria-valuemax"), String(POINTS - 1), `${label}: every sample must be addressable`);
      assert.equal(
        await figure.getAttribute("aria-valuetext"),
        (await figure.locator(".chart-readout").textContent()).trim(),
        `${label}: the chart must speak the same value it shows`,
      );

      // -- the readout never covers the point it describes, at any sample -----
      // Walk the whole series with the keyboard and measure both the coverage
      // and how far the eye has to travel from the marker to its own value.
      const sweep = await page.evaluate((count) => {
        const field = document.querySelector("#metric-grid figure");
        field.focus();
        const results = [];
        field.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
        for (let index = 0; index < count; index += 1) {
          const dot = field.querySelector(".chart-marker").getBoundingClientRect();
          const readout = field.querySelector(".chart-readout").getBoundingClientRect();
          const x = dot.x + dot.width / 2;
          const y = dot.y + dot.height / 2;
          const covered = x >= readout.left && x <= readout.right && y >= readout.top && y <= readout.bottom;
          const nearestX = Math.max(readout.left, Math.min(x, readout.right));
          const nearestY = Math.max(readout.top, Math.min(y, readout.bottom));
          results.push({
            index,
            covered,
            travel: Math.round(Math.hypot(x - nearestX, y - nearestY)),
            valuenow: Number(field.getAttribute("aria-valuenow")),
            round: Math.abs(dot.width - dot.height) <= 2,
          });
          field.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        }
        return results;
      }, POINTS);

      assert.equal(sweep.length, POINTS, `${label}: the sweep did not visit every sample`);
      assert.deepEqual(
        sweep.filter((entry) => entry.covered).map((entry) => entry.index),
        [],
        `${label}: the readout covered the marker it describes`,
      );
      assert.deepEqual(
        sweep.map((entry) => entry.valuenow),
        sweep.map((entry) => entry.index),
        `${label}: the keyboard must reach every sample, one arrow press per sample`,
      );
      assert.deepEqual(sweep.filter((entry) => !entry.round).map((entry) => entry.index), [], `${label}: the marker must render round`);

      // The readout rides in a band directly beneath the plot, so the farthest
      // a marker can ever be from it is the plot's own height plus the band's
      // offset -- the case where the marker sits at the very top of the field.
      // Anything beyond that means the readout left its band, which is the
      // failure that matters; a smaller hand-picked budget would only be a
      // number this file invented.
      const plot = await figure.locator("svg").boundingBox();
      const band = await figure.locator(".chart-readout").boundingBox();
      const reach = Math.ceil(plot.height + Math.max(band.y - (plot.y + plot.height), 0));
      const worst = Math.max(...sweep.map((entry) => entry.travel));
      assert.ok(
        worst <= reach,
        `${label}: the readout sits ${worst}px from its marker, past the ${reach}px the plot plus its band can account for`,
      );

      // -- a tap selects --------------------------------------------------
      const beforeTap = await figure.locator(".chart-readout").textContent();
      const box = await figure.boundingBox();
      await page.touchscreen.tap(box.x + box.width * 0.85, box.y + box.height * 0.4);
      assert.notEqual(await figure.locator(".chart-readout").textContent(), beforeTap, `${label}: a tap must inspect a sample`);

      // -- the readout is legible where it actually lands --------------------
      const readoutBox = await figure.locator(".chart-readout").boundingBox();
      const png = (await page.screenshot({ clip: readoutBox })).toString("base64");
      const contrast = await page.evaluate(CONTRAST_PROBE, { png });
      assert.ok(
        contrast.ratio >= 4.5,
        `${label}: readout text measured ${contrast.ratio.toFixed(2)}:1 against its own painted panel, under WCAG AA 4.5:1`,
      );

      // -- nothing the chart added may push the page sideways ----------------
      const overflow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth }));
      assert.ok(overflow.scrollWidth <= overflow.viewport, `${label}: ${overflow.scrollWidth}px content exceeds the ${overflow.viewport}px viewport`);

      await page.close();
    }
  }

  // -- Forced Colors strips the palette; the crosshair and marker must stay
  // distinguishable from the trend line on their own terms.
  {
    const page = await browser.newPage({ viewport: { width: 500, height: 900 }, colorScheme: "dark" });
    await page.emulateMedia({ forcedColors: "active" });
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.querySelectorAll("#metric-grid .metric-card").length >= 3);
    const [line, cursor] = await Promise.all([
      page.locator("#metric-grid .chart-line").first().evaluate((element) => getComputedStyle(element).stroke),
      page.locator("#metric-grid .chart-cursor").first().evaluate((element) => getComputedStyle(element).stroke),
    ]);
    assert.notEqual(line, cursor, "the crosshair must stay distinguishable from the trend line under forced colors");
    await page.close();
  }

  console.log(
    `cinder chart inspection pass: ${BREAKPOINTS.length * APPEARANCES.length} responsive states, ${POINTS} keyboard-reachable samples each, no readout covering its marker, tap selection, measured WCAG AA readout contrast, forced colors`,
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
