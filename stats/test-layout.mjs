import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "@playwright/test";


const HERE = new URL(".", import.meta.url);
const BREAKPOINTS = [
  { name: "mobile-320", width: 320, height: 568 },
  { name: "mobile-375", width: 375, height: 667 },
  { name: "mobile-440", width: 440, height: 956 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "desktop-1440", width: 1440, height: 900 },
];
const APPEARANCES = ["light", "dark"];
const ASSETS = new Map([
  ["/stats.css", ["site/stats.css", "text/css; charset=utf-8"]],
  ["/login.js", ["site/login.js", "application/javascript; charset=utf-8"]],
  ["/navigation.js", ["site/navigation.js", "application/javascript; charset=utf-8"]],
  ["/dashboard.js", ["site/dashboard.js", "application/javascript; charset=utf-8"]],
]);
// The live taxonomy's exact shape: ten destinations across three groups, 3/4/3.
// Hosts stay generic on purpose -- this fixture proves rendering, and the real
// private inventory is asserted absent from every site asset in test-auth.mjs.
const NAVIGATION_GROUP_COUNTS = [["signals", 3], ["products", 4], ["places", 3]];
const NAVIGATION = {
  destinations: NAVIGATION_GROUP_COUNTS.flatMap(([group, count]) =>
    Array.from({ length: count }, (_, index) => ({
      id: `${group}-${index + 1}`,
      group,
      label: `private ${group} ${index + 1}`,
      href: `https://private-${group}-${index + 1}.example/`,
    })),
  ),
};
const NAVIGATION_TOTAL = NAVIGATION.destinations.length;

// One fixed instant used only to render "checked ..." style text in the
// mock's live payloads. Never compared against the browser's real clock.
const LIVE_INSTANT = "2026-07-28T18:00:30.000Z";
const RANGE_LABELS = { "1h": "last hour", "4h": "last 4 hours", "24h": "last 24 hours", "7d": "last 7 days" };
const RANGE_PERIODS = { "1h": 60, "4h": 300, "24h": 1_800, "7d": 10_800 };
const RANGE_POINT_COUNTS = { "1h": 6, "4h": 8, "24h": 8, "7d": 7 };

// A minimal stand-in for Task 4's real /api/metrics?window=...&end=... range
// document. Echoes the requested window/end back so query-string restore and
// live-clamp tests can assert against values they themselves constructed.
const rangePayload = (windowId, mode, end) => {
  const count = RANGE_POINT_COUNTS[windowId] ?? RANGE_POINT_COUNTS["24h"];
  const period = RANGE_PERIODS[windowId] ?? RANGE_PERIODS["24h"];
  const anchorMs = new Date(end ?? LIVE_INSTANT).getTime();
  const timestamps = Array.from({ length: count }, (_, index) => new Date(anchorMs - (count - index) * period * 1000).toISOString());
  const build = (id, label, unit, aggregation, summary, values) => ({
    id, label, unit, aggregation, summary,
    points: values ? timestamps.map((at, index) => ({ at, value: values[index] })) : [],
  });
  return {
    checkedAt: LIVE_INSTANT,
    source: "AWS/Lambda",
    scope: { product: "Cinder", functionCount: 11 },
    range: {
      id: windowId,
      label: RANGE_LABELS[windowId] ?? RANGE_LABELS["24h"],
      start: timestamps[0],
      end: new Date(anchorMs).toISOString(),
      periodSeconds: period,
      mode,
    },
    series: [
      build("invocations", "Invocations", "count", "sum", 84, Array.from({ length: count }, (_, i) => i * 3)),
      build("errors", "Errors", "count", "sum", 4, Array.from({ length: count }, (_, i) => i % 2)),
      build("error_rate", "Error rate", "percent", "ratio", 4.76, Array.from({ length: count }, (_, i) => (i % 2) * 12.5)),
      build("throttles", "Throttles", "count", "sum", 0, Array.from({ length: count }, () => 0)),
      // Deliberately null: proves the "no samples" rendering path for an
      // undefined rate rather than a fabricated zero.
      build("throttle_rate", "Throttle rate", "percent", "ratio", null, null),
      build("duration", "Duration", "milliseconds", "average", 48.2, Array.from({ length: count }, (_, i) => 42 + i / 2)),
    ],
  };
};

let navigationAllowed = true;
let sessionValid = true;     // false simulates an expired session: /api/metrics AND / both deny
let metricsAvailable = true; // false simulates a 503 with the session intact
let metricsDelayMs = 0;      // artificial per-response latency for race/logout-mid-fetch coverage
// Per-window latency, so an EARLIER request can be made to answer LAST. Without
// it every stale response is simply aborted and out-of-order delivery is never
// actually exercised.
let metricsDelayByWindow = null;


const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const path = url.pathname;
  const authenticated = (request.headers.cookie?.includes("cinder_test_session=valid") ?? false) && sessionValid;
  if (["/welcome.html", "/dashboard.html"].includes(path)) {
    response.writeHead(307, { location: "/", "cache-control": "no-store, private" });
    return response.end();
  }
  if (path === "/") {
    const asset = authenticated
      ? ["site/dashboard.html", "text/html; charset=utf-8"]
      : ["site/welcome.html", "text/html; charset=utf-8"];
    response.writeHead(200, { "content-type": asset[1] });
    return response.end(await readFile(new URL(asset[0], HERE)));
  }
  if (path === "/api/auth") {
    response.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": "cinder_test_session=valid; Path=/; HttpOnly; SameSite=Strict",
    });
    return response.end(JSON.stringify({ ok: true }));
  }
  if (path === "/api/session") {
    response.writeHead(authenticated ? 200 : 401, { "content-type": "application/json" });
    return response.end(JSON.stringify(authenticated ? { authenticated: true } : { error: "authentication required" }));
  }
  if (path === "/api/logout") {
    response.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": "cinder_test_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict",
    });
    return response.end(JSON.stringify({ ok: true }));
  }
  if (path === "/api/navigation") {
    if (!navigationAllowed) {
      response.writeHead(401, { "content-type": "application/json" });
      return response.end(JSON.stringify({ error: "authentication required" }));
    }
    response.writeHead(200, { "content-type": "application/json" });
    return response.end(JSON.stringify(NAVIGATION));
  }
  if (path === "/api/metrics") {
    if (!sessionValid) {
      response.writeHead(401, { "content-type": "application/json" });
      return response.end(JSON.stringify({ error: "authentication required" }));
    }
    if (!metricsAvailable) {
      response.writeHead(503, { "content-type": "application/json" });
      return response.end(JSON.stringify({ error: "metrics unavailable" }));
    }
    const windowId = url.searchParams.get("window") ?? "24h";
    const end = url.searchParams.get("end");
    const send = () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(rangePayload(windowId, end ? "fixed" : "live", end)));
    };
    const delay = metricsDelayByWindow?.get(windowId) ?? metricsDelayMs;
    if (delay > 0) return void setTimeout(send, delay);
    return send();
  }
  const asset = ASSETS.get(path);
  if (!asset) {
    response.writeHead(404);
    return response.end();
  }
  response.writeHead(200, { "content-type": asset[1] });
  return response.end(await readFile(new URL(asset[0], HERE)));
});


const listen = () => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

// An exact UTC hour boundary N hours before the REAL current instant. Anchors
// used by direct-navigation tests must be genuine relative to wall-clock time,
// since dashboard.js validates/clamps against `new Date()`, not any fixture.
const flooredHoursAgo = (hours) => {
  const flooredNow = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  return new Date(flooredNow - hours * 3_600_000).toISOString();
};


const assertLayout = async (page, label) => {
  const result = await page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && bounds.width > 0 && bounds.height > 0;
    };
    // A wide table inside `.data-table { overflow-x: auto }` legitimately
    // extends past the viewport -- it is reachable by scrolling its own box,
    // never "clipped" in the sense this check exists to catch. Walk up for a
    // scrollable ancestor before flagging an element as unreachable.
    const withinScrollableRegion = (element) => {
      for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
        if (/(auto|scroll)/.test(getComputedStyle(node).overflowX)) return true;
      }
      return false;
    };
    const clipped = [...document.querySelectorAll("h1, h2, p, span, strong, a, label, button, summary, th, td")]
      .filter(visible)
      .filter((element) => {
        const bounds = element.getBoundingClientRect();
        return (bounds.left < -1 || bounds.right > innerWidth + 1) && !withinScrollableRegion(element);
      })
      .map((element) => element.textContent.trim().slice(0, 40));
    const smallTargets = [...document.querySelectorAll("button, input, summary")]
      .filter(visible)
      .filter((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.width < 48 || bounds.height < 48;
      })
      .map((element) => element.tagName.toLowerCase());
    return {
      clipped,
      smallTargets,
      viewport: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  assert.ok(result.scrollWidth <= result.viewport, `${label}: ${result.scrollWidth}px content exceeds ${result.viewport}px viewport`);
  assert.deepEqual(result.clipped, [], `${label}: visible text leaves the viewport`);
  assert.deepEqual(result.smallTargets, [], `${label}: interactive target is smaller than 48px`);
  assert.deepEqual(await orphanedBlocks(page), [], `${label}: a heading or paragraph ends on a single stranded word`);
};


// A heading or paragraph whose final laid-out line carries one stranded word is
// a defect, and it has been caught by eye more than once. Measure it instead:
// walk each block's words with a Range, group them by the top of the line box
// they actually landed in, and flag any block that wrapped and ended alone.
// Reading the source string could never see this -- the same words orphan at
// one width and read fine at another.
// The prescribed fix is a non-breaking space binding the final two words, so a
// unit containing one is deliberately NOT a stranded single word -- it renders
// as two words that simply cannot be split. Splitting on whitespace EXCEPT
// U+00A0 makes the measurement agree with the fix.
// Scope: headings, card titles, captions, and paragraphs -- exactly what the
// rule governs. A <summary> is an interactive disclosure control, not a
// heading, and neither is an all-caps mono `.eyebrow` kicker. Forcing either
// one unbreakable measurably overflowed the page at 200% text on a 320px
// screen -- 399px and then 331px of content in a 320px viewport -- which is a
// worse defect than the orphan it would have fixed.
const ORPHAN_SELECTOR = "h1, h2, h3, caption, .hero p:not(.eyebrow), .arrival-copy p:not(.eyebrow), .metric-card p, .lead";
const orphanedBlocks = async (page, selector = ORPHAN_SELECTOR) => page.evaluate((blockSelector) => {
  const stranded = [];
  for (const block of document.querySelectorAll(blockSelector)) {
    const style = getComputedStyle(block);
    if (style.visibility === "hidden" || style.display === "none") continue;
    // Only blocks laid out as one continuous run of inline content: a block
    // child would start its own line box and make "the last line" ambiguous.
    if ([...block.children].some((child) => !getComputedStyle(child).display.startsWith("inline"))) continue;

    const words = [];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue;
      for (const match of text.matchAll(/[^\s\u00A0]+(?:\u00A0[^\s\u00A0]+)*/g)) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
        if (!rects.length) continue;
        // A word that itself wrapped spans two line boxes; the LAST rect is
        // the line it ends on, which is the line that matters here.
        words.push({ text: match[0], top: Math.round(rects[rects.length - 1].top) });
      }
    }
    if (words.length < 2) continue;

    const lines = [];
    for (const word of words) {
      const line = lines.at(-1);
      if (line && line.top === word.top) line.words.push(word.text);
      else lines.push({ top: word.top, words: [word.text] });
    }
    if (lines.length < 2) continue;
    const last = lines.at(-1).words;
    if (last.length === 1 && !last[0].includes("\u00A0")) {
      stranded.push(`${block.tagName.toLowerCase()}: "${block.textContent.trim().slice(0, 60)}" ends alone on "${last[0]}"`);
    }
  }
  return stranded;
}, selector);


const colorContrast = async (page) => page.evaluate(() => {
  const styles = getComputedStyle(document.documentElement);
  const color = (name) => styles.getPropertyValue(name).trim().match(/[0-9a-f]{2}/gi).map((part) => parseInt(part, 16));
  const luminance = ([red, green, blue]) => {
    const channels = [red, green, blue].map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const ratio = (foreground, background) => {
    const values = [luminance(color(foreground)), luminance(color(background))].sort((a, b) => b - a);
    return (values[0] + 0.05) / (values[1] + 0.05);
  };
  return {
    inkOnPanel: ratio("--ink", "--panel"),
    mutedOnGround: ratio("--muted", "--ground"),
    emberOnPanel: ratio("--ember", "--panel"),
  };
});


await listen();
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;
const outputDirectory = process.env.QA_SCREENSHOT_DIR || await mkdtemp(join(tmpdir(), "cinder-stats-qa-"));
const ownsOutput = !process.env.QA_SCREENSHOT_DIR;
const browser = await chromium.launch({ headless: true });

try {
  for (const appearance of APPEARANCES) {
    for (const breakpoint of BREAKPOINTS) {
      const label = `${breakpoint.name} ${appearance}`;
      const page = await browser.newPage({
        viewport: { width: breakpoint.width, height: breakpoint.height },
        colorScheme: appearance,
        reducedMotion: "reduce",
      });
      await page.goto(origin, { waitUntil: "networkidle" });
      await assertLayout(page, `${label} arrival`);

      const ratios = await colorContrast(page);
      for (const [pair, ratio] of Object.entries(ratios)) {
        assert.ok(ratio >= 4.5, `${label}: ${pair} contrast ${ratio.toFixed(2)} is below WCAG AA`);
      }

      await page.locator("#password").fill("test");
      await page.getByRole("button", { name: /open stats/i }).click();
      await page.waitForSelector(".metric-card");
      assert.equal(new URL(page.url()).pathname, "/", `${label}: login exposed an implementation route`);
      assert.equal(await page.locator(".metric-card").count(), 6, `${label}: expected six metric small multiples (added error/throttle rate)`);
      assert.equal(
        await page.locator(".metric-card figure").count(), 6,
        `${label}: every metric needs a chart container`,
      );
      assert.equal(
        await page.locator('figure[role="slider"]').count(), 5,
        `${label}: sampled metrics need keyboard-accessible chart sliders`,
      );
      assert.equal(
        await page
          .locator("figure:not([role]) .chart-readout")
          .filter({ hasText: "no samples in this window" })
          .count(),
        1,
        `${label}: a metric without samples needs truthful chart context, not a fabricated value`,
      );

      // -- range buttons: exact four, correct labels, default 24h selected --
      const rangeButtonLabels = await page.locator("[data-window]").allTextContents();
      assert.deepEqual(rangeButtonLabels, ["1 hour", "4 hours", "24 hours", "7 days"], `${label}: exact range button set`);
      assert.equal(await page.locator('[data-window="24h"]').getAttribute("aria-pressed"), "true", `${label}: 24h is the default range`);

      // -- hour navigator: Previous/Live/Next with correct initial state ----
      assert.equal(await page.locator("#nav-live").getAttribute("aria-pressed"), "true", `${label}: Live is initially pressed`);
      assert.equal(await page.locator("#nav-next").isDisabled(), true, `${label}: Next hour is disabled while live`);
      assert.equal(await page.locator("#nav-previous").isDisabled(), false, `${label}: Previous hour is available from live`);

      // -- Previous/Next round-trip: URL carries window/end via replaceState --
      await page.locator("#nav-previous").click();
      await page.waitForFunction(() => new URL(location.href).searchParams.has("end"));
      assert.equal(await page.locator("#nav-live").getAttribute("aria-pressed"), "false", `${label}: Live releases once anchored`);
      assert.equal(await page.locator("#nav-next").isDisabled(), false, `${label}: Next hour opens up once anchored`);
      await page.locator("#nav-next").click();
      await page.waitForFunction(() => !new URL(location.href).searchParams.has("end"));
      assert.equal(await page.locator("#nav-live").getAttribute("aria-pressed"), "true", `${label}: Next hour returns to live`);

      // -- keyboard parity: ArrowLeft/ArrowRight on the navigator -----------
      await page.locator("#nav-previous").focus();
      await page.keyboard.press("ArrowLeft");
      await page.waitForFunction(() => new URL(location.href).searchParams.has("end"));
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(() => !new URL(location.href).searchParams.has("end"));

      // -- explorer shell preserves vertical page scroll (`touch-action`) ---
      assert.equal(
        await page.locator("#metric-grid").evaluate((element) => getComputedStyle(element).touchAction),
        "pan-y",
        `${label}: the explorer shell must leave vertical panning to the browser`,
      );

      await page.getByRole("button", { name: "7 days" }).click();
      assert.equal(await page.getByRole("button", { name: "7 days" }).getAttribute("aria-pressed"), "true");
      await page.waitForFunction(() => document.querySelector(".metric-card p")?.textContent.includes("last 7 days"));
      assert.match(await page.locator(".metric-card").first().locator("p").textContent(), /last 7 days/);

      // -- percent formatting and an honest "no samples" for a null rate ----
      assert.match(await page.locator(".metric-error_rate strong").textContent(), /%/, `${label}: error rate renders as a percent`);
      assert.equal(await page.locator(".metric-throttle_rate strong").textContent(), "no samples", `${label}: a null rate never shows a false zero`);

      // -- the data table keeps UTC as its time-of-record, per point --------
      await page.locator(".data-table summary").first().click();
      assert.equal(await page.locator(".data-table tbody tr").first().count(), 1, `${label}: accessible data table did not open`);
      assert.match(await page.locator(".data-table thead th").first().textContent(), /time \(UTC\)/, `${label}: the table keeps UTC as its time-of-record`);
      await page.locator(".data-table summary").first().click();
      await page.locator(".switcher summary").click();
      await assertLayout(page, `${label} dashboard`);
      assert.equal(
        await page.locator(".switcher a").count(),
        NAVIGATION_TOTAL,
        `${label}: ${NAVIGATION_TOTAL} private destinations did not render`,
      );

      // Group headings in canonical order, with the right destinations under
      // each. A renderer that emitted every link but dropped the Products
      // heading, or listed the groups in another order, passes the count above
      // and fails here.
      const groupShape = await page.locator(".switcher ul").evaluate((list) => {
        const shape = [];
        for (const item of list.children) {
          if (item.classList.contains("group")) shape.push([item.textContent, 0]);
          else if (shape.length) shape[shape.length - 1][1] += 1;
        }
        return shape;
      });
      assert.deepEqual(groupShape, NAVIGATION_GROUP_COUNTS, `${label}: private navigation group shape`);
      assert.equal(await page.locator("body").evaluate((element) => getComputedStyle(element).animationName), "none");
      await page.locator(".switcher summary").click();

      if (appearance === "dark" && breakpoint.name === "mobile-320") {
        navigationAllowed = false;
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await page.waitForFunction(() => !document.querySelector("#private-navigation")?.children.length);
        assert.equal(await page.locator("#private-navigation").getByRole("link").count(), 0, "revocation left destinations in the DOM");
        navigationAllowed = true;
      }

      // 200% text zoom at the narrowest supported width: same layout floor
      // (no overflow, no clipping, 48px targets) must still hold.
      if (breakpoint.name === "mobile-320") {
        await page.addStyleTag({ content: "html { font-size: 200%; }" });
        await assertLayout(page, `${label} 200% text`);
        await page.addStyleTag({ content: "html { font-size: 100%; }" });
      }

      if (breakpoint.name === "mobile-320" || breakpoint.name === "desktop-1440") {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: join(outputDirectory, `${breakpoint.name}-${appearance}.png`), fullPage: true });
      }

      await page.locator("#logout").click();
      await page.waitForSelector("#login");
      assert.equal(new URL(page.url()).pathname, "/", `${label}: logout exposed an implementation route`);
      await page.close();
    }
  }

  // =====================================================================
  // Task 5: gesture, keyboard-race, deep-link, and failure-mode coverage.
  // Run once, not per breakpoint/appearance -- none of it is viewport-
  // dependent, and each scenario needs a clean authenticated session.
  // =====================================================================
  {
    const page = await browser.newPage({
      viewport: { width: 500, height: 900 },
      colorScheme: "dark",
      reducedMotion: "reduce",
    });
    const login = async () => {
      await page.goto(origin, { waitUntil: "networkidle" });
      await page.locator("#password").fill("test");
      await page.getByRole("button", { name: /open stats/i }).click();
      await page.waitForSelector(".metric-card");
    };
    await login();

    // The public-safe window/end state lives only in the URL.
    const storageEmpty = await page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0);
    assert.ok(storageEmpty, "range state must never enter local or session storage");

    // -- pointer swipe: Chromium unifies mouse input into Pointer Events, so
    // a mouse-simulated drag exercises the same pointerdown/pointermove/
    // pointerup handlers a touchscreen would trigger. `steps` interpolates
    // several intermediate pointermove events per drag, which is exactly
    // what would over-trigger a "move per pointer event" bug.
    await page.locator("#metric-grid").scrollIntoViewIfNeeded();
    const shellBox = await page.locator("#metric-grid").boundingBox();
    const midX = shellBox.x + shellBox.width / 2;
    // The masthead is `position: sticky`, so it stays pinned over whatever
    // scrolls to the top of the viewport -- a shallow offset from the grid's
    // own top edge lands on the masthead instead of the explorer shell.
    const midY = shellBox.y + 250;

    const drag = async (dx, dy) => {
      await page.mouse.move(midX, midY);
      await page.mouse.down();
      await page.mouse.move(midX + dx, midY + dy, { steps: 10 });
      await page.mouse.up();
    };

    // `page.url()` is Playwright's CACHED main-frame URL. `history.replaceState`
    // reaches it asynchronously, so a no-op assertion written against it can
    // read the same stale string before and after a gesture and compare a value
    // to itself -- passing whether or not the gesture was correctly ignored.
    // Every assertion below reads `location.href` inside the page instead, and
    // any assertion proving a NEGATIVE settles the event loop first.
    const currentEnd = () => page.evaluate(() => new URL(location.href).searchParams.get("end"));
    const settledEnd = async () => {
      await page.waitForTimeout(50);
      return currentEnd();
    };

    // Swiping left while live has nothing to move to; the URL stays live.
    await drag(-100, 0);
    assert.equal(await settledEnd(), null, "swiping left while live must stay a no-op");

    // Swiping right moves exactly one hour into the past per gesture, twice.
    await drag(100, 0);
    await page.waitForFunction(() => new URL(location.href).searchParams.has("end"));
    const anchor1 = await currentEnd();
    await drag(100, 0);
    await page.waitForFunction((previous) => new URL(location.href).searchParams.get("end") !== previous, anchor1);
    const anchor2 = await currentEnd();
    assert.equal(
      new Date(anchor1).getTime() - new Date(anchor2).getTime(),
      3_600_000,
      "a completed horizontal gesture must move exactly one hour, never one hour per pointermove step",
    );

    // Swiping left moves forward exactly one hour, back to anchor1.
    await drag(-100, 0);
    await page.waitForFunction((previous) => new URL(location.href).searchParams.get("end") !== previous, anchor2);
    assert.equal(await currentEnd(), anchor1, "swiping left must move forward exactly one hour");

    // A vertical-first drag must never move the hour, even past the 48px
    // horizontal threshold, because the axis already locked to vertical.
    const beforeVerticalDrag = await currentEnd();
    await drag(60, 160);
    assert.equal(await settledEnd(), beforeVerticalDrag, "a vertical-first drag must not move the hour");

    // -- the 48-pixel horizontal threshold, one pixel either side of it. The
    // short drag still passes the 6-pixel axis lock, so this proves the
    // threshold itself rather than the lock.
    const beforeShortDrag = await currentEnd();
    await drag(47, 0);
    assert.equal(await settledEnd(), beforeShortDrag, "a 47px horizontal drag is below the threshold and must not move the hour");
    await drag(48, 0);
    await page.waitForFunction((previous) => new URL(location.href).searchParams.get("end") !== previous, beforeShortDrag);
    assert.equal(
      new Date(beforeShortDrag).getTime() - new Date(await currentEnd()).getTime(),
      3_600_000,
      "a 48px horizontal drag is exactly at the threshold and must move one hour",
    );

    // -- rapid alternating selection: the last click's request must win,
    // even though its two predecessors were still in flight when it fired.
    metricsDelayMs = 60;
    await page.evaluate(() => {
      document.querySelector('[data-window="1h"]').click();
      document.querySelector('[data-window="4h"]').click();
      document.querySelector('[data-window="24h"]').click();
    });
    await page.waitForTimeout(200);
    metricsDelayMs = 0;
    assert.equal(await page.locator('[data-window="24h"]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator('[data-window="1h"]').getAttribute("aria-pressed"), "false");
    assert.match(await page.locator(".metric-card").first().locator("p").textContent(), /last 24 hours/, "the last selection must win the race, never a stale earlier response");

    // -- out-of-order delivery: the FIRST request answers LAST. The client
    // defends this twice over -- it aborts the superseded controller AND
    // re-checks `controller === activeRequest` before rendering -- so removing
    // either mechanism alone leaves this green. Removing both turns it red,
    // which is the property worth pinning: a late earlier response can never
    // repaint the surface.
    metricsDelayByWindow = new Map([["7d", 400], ["4h", 200], ["1h", 0]]);
    await page.evaluate(() => {
      document.querySelector('[data-window="7d"]').click();
      document.querySelector('[data-window="4h"]').click();
      document.querySelector('[data-window="1h"]').click();
    });
    await page.waitForTimeout(700);
    metricsDelayByWindow = null;
    assert.equal(await page.locator('[data-window="1h"]').getAttribute("aria-pressed"), "true");
    assert.match(
      await page.locator(".metric-card").first().locator("p").textContent(),
      /last hour/,
      "a late-arriving earlier response must never repaint over the last selection",
    );

    // -- malformed deep link: garbage window/end fall back to 24h/live -----
    await page.goto(`${origin}/?window=99h&end=garbage`, { waitUntil: "networkidle" });
    await page.waitForSelector(".metric-card");
    assert.equal(await page.locator('[data-window="24h"]').getAttribute("aria-pressed"), "true");
    assert.equal(new URL(page.url()).searchParams.get("window"), "24h");
    assert.equal(new URL(page.url()).searchParams.has("end"), false);

    // -- query-string restore: a well-formed deep link is honored exactly --
    const restoreAnchor = flooredHoursAgo(4);
    await page.goto(`${origin}/?window=4h&end=${encodeURIComponent(restoreAnchor)}`, { waitUntil: "networkidle" });
    await page.waitForSelector(".metric-card");
    assert.equal(await page.locator('[data-window="4h"]').getAttribute("aria-pressed"), "true");
    assert.equal(new URL(page.url()).searchParams.get("end"), restoreAnchor);
    assert.equal(await page.locator("#nav-live").getAttribute("aria-pressed"), "false");

    // -- live clamp: at the deepest permitted anchor for a window, Previous
    // hour must disable itself rather than invite a request the backend
    // would reject.
    const deepestFor1h = flooredHoursAgo(335); // 335 + the 1h window itself = the 336h ceiling
    await page.goto(`${origin}/?window=1h&end=${encodeURIComponent(deepestFor1h)}`, { waitUntil: "networkidle" });
    await page.waitForSelector(".metric-card");
    assert.equal(await page.locator("#nav-previous").isDisabled(), true, "Previous hour must clamp at the 336-hour lookback ceiling");
    assert.equal(await page.locator("#nav-next").isDisabled(), false);

    // -- 401 mid-session: /api/metrics denies, the client returns to "/" ---
    // Both welcome.html and dashboard.html serve at "/", so a pathname check
    // is trivially already true; wait for the actual public-arrival markup.
    sessionValid = false;
    await page.locator('[data-window="7d"]').click();
    await page.waitForSelector("#login");
    assert.equal(await page.locator("#login").count(), 1, "a 401 from the range endpoint must return to the public arrival");
    sessionValid = true;

    // The session cookie itself was never cleared -- only the simulated
    // 401 flag -- so returning to the dashboard is a plain reload, not a
    // fresh password submission.
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.waitForSelector(".metric-card");

    // -- 503: the surface reports unavailability, it never hangs or throws -
    metricsAvailable = false;
    await page.locator('[data-window="1h"]').click();
    await page.waitForFunction(() => document.querySelector("#status")?.textContent.includes("unavailable"));
    metricsAvailable = true;

    // -- logout mid-fetch: a pending slow request must not block or corrupt
    // the logout, and must never leave a stale authenticated view behind.
    metricsDelayMs = 300;
    await page.locator('[data-window="24h"]').click();
    await page.locator("#logout").click();
    await page.waitForSelector("#login");
    assert.equal(new URL(page.url()).pathname, "/", "logout mid-fetch must still land on the clean public route");
    metricsDelayMs = 0;

    await page.close();
  }

  // -- Forced Colors: the selected range/anchor state must stay visually
  // distinct from an unselected one using the system palette, not the ember
  // tokens forced-colors mode strips away.
  {
    const page = await browser.newPage({ viewport: { width: 500, height: 900 }, colorScheme: "dark" });
    await page.emulateMedia({ forcedColors: "active" });
    await page.goto(origin, { waitUntil: "networkidle" });
    await page.locator("#password").fill("test");
    await page.getByRole("button", { name: /open stats/i }).click();
    await page.waitForSelector(".metric-card");
    const [selected, unselected] = await Promise.all([
      page.locator('[data-window="24h"]').evaluate((element) => getComputedStyle(element).backgroundColor),
      page.locator('[data-window="7d"]').evaluate((element) => getComputedStyle(element).backgroundColor),
    ]);
    assert.notEqual(selected, unselected, "the selected range must remain distinguishable under forced colors");
    await page.close();
  }

  const noScript = await browser.newPage({ javaScriptEnabled: false });
  await noScript.goto(`${origin}/dashboard.html`, { waitUntil: "networkidle" });
  assert.equal(new URL(noScript.url()).pathname, "/", "no-JS legacy navigation did not collapse to the clean route");
  assert.equal(await noScript.locator("#login").count(), 1, "no-JS legacy navigation did not reach the public arrival");
  await noScript.close();
  console.log(`Cinder layout pass: ${BREAKPOINTS.length * APPEARANCES.length} responsive states, 48px targets, WCAG AA tokens, reduced motion, forced colors, hour-scrub gestures`);
  if (!ownsOutput) console.log(`screenshots: ${outputDirectory}`);
} finally {
  await browser.close();
  await close();
  if (ownsOutput) await rm(outputDirectory, { recursive: true, force: true });
}
