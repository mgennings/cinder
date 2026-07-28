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
const NAVIGATION = {
  destinations: Array.from({ length: 9 }, (_, index) => ({
    id: `destination-${index}`,
    group: index < 6 ? "signals" : "places",
    label: `private destination ${index + 1}`,
    href: `https://private-${index + 1}.example/`,
  })),
};
const timestamps = Array.from({ length: 28 }, (_, index) => new Date(Date.UTC(2026, 6, 27, index)).toISOString());
const series = (id, label, unit, aggregation, count) => ({
  id,
  label,
  unit,
  aggregation,
  points: timestamps.slice(0, count).map((at, index) => ({ at, value: id === "duration" ? 42 + index / 2 : index * 3 })),
});
const METRICS = {
  checkedAt: "2026-07-28T12:00:00.000Z",
  source: "AWS/Lambda",
  scope: { product: "Cinder", functionCount: 11 },
  windows: [
    {
      id: "24h",
      label: "last 24 hours",
      periodSeconds: 3_600,
      series: [
        series("invocations", "Invocations", "count", "sum", 24),
        series("errors", "Errors", "count", "sum", 24),
        series("throttles", "Throttles", "count", "sum", 24),
        series("duration", "Duration", "milliseconds", "average", 24),
      ],
    },
    {
      id: "7d",
      label: "last 7 days",
      periodSeconds: 21_600,
      series: [
        series("invocations", "Invocations", "count", "sum", 28),
        series("errors", "Errors", "count", "sum", 28),
        series("throttles", "Throttles", "count", "sum", 28),
        series("duration", "Duration", "milliseconds", "average", 28),
      ],
    },
  ],
};
let navigationAllowed = true;


const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  const authenticated = request.headers.cookie?.includes("cinder_test_session=valid") ?? false;
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
    response.writeHead(200, { "content-type": "application/json" });
    return response.end(JSON.stringify(METRICS));
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


const assertLayout = async (page, label) => {
  const result = await page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && bounds.width > 0 && bounds.height > 0;
    };
    const clipped = [...document.querySelectorAll("h1, h2, p, span, strong, a, label, button, summary, th, td")]
      .filter(visible)
      .filter((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.left < -1 || bounds.right > innerWidth + 1;
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
};


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
      assert.equal(await page.locator(".metric-card").count(), 4, `${label}: expected four metric small multiples`);
      assert.equal(await page.locator("svg[role=img]").count(), 4, `${label}: every metric needs an accessible chart`);
      await page.getByRole("button", { name: "7 days" }).click();
      assert.equal(await page.getByRole("button", { name: "7 days" }).getAttribute("aria-pressed"), "true");
      assert.match(await page.locator(".metric-card").first().locator("p").textContent(), /last 7 days/);
      await page.locator(".data-table summary").first().click();
      assert.equal(await page.locator(".data-table tbody tr").first().count(), 1, `${label}: accessible data table did not open`);
      await page.locator(".data-table summary").first().click();
      await page.locator(".switcher summary").click();
      await assertLayout(page, `${label} dashboard`);
      assert.equal(await page.locator(".switcher a").count(), 9, `${label}: nine private destinations did not render`);
      assert.equal(await page.locator("body").evaluate((element) => getComputedStyle(element).animationName), "none");
      await page.locator(".switcher summary").click();

      if (appearance === "dark" && breakpoint.name === "mobile-320") {
        navigationAllowed = false;
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await page.waitForFunction(() => !document.querySelector("#private-navigation")?.children.length);
        assert.equal(await page.locator("#private-navigation").getByRole("link").count(), 0, "revocation left destinations in the DOM");
        navigationAllowed = true;
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

  const noScript = await browser.newPage({ javaScriptEnabled: false });
  await noScript.goto(`${origin}/dashboard.html`, { waitUntil: "networkidle" });
  assert.equal(new URL(noScript.url()).pathname, "/", "no-JS legacy navigation did not collapse to the clean route");
  assert.equal(await noScript.locator("#login").count(), 1, "no-JS legacy navigation did not reach the public arrival");
  await noScript.close();
  console.log(`Cinder layout pass: ${BREAKPOINTS.length * APPEARANCES.length} responsive states, 48px targets, WCAG AA tokens, reduced motion`);
  if (!ownsOutput) console.log(`screenshots: ${outputDirectory}`);
} finally {
  await browser.close();
  await close();
  if (ownsOutput) await rm(outputDirectory, { recursive: true, force: true });
}
