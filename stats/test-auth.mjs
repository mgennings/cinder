import assert from "node:assert/strict";
import { createHash, createHmac, scryptSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

process.env.STATS_SECRET_ID = "test-surface";
process.env.STATS_SHARED_SECRET_ID = "test-shared";
process.env.STATS_NAVIGATION_SECRET_ID = "test-navigation";
process.env.STATS_AUDIENCE = "stats.cinder.ink";

const {
  authReply,
  decodeSession,
  encodeSession,
  mattNavigation,
  navigationClaimReply,
  navigationReply,
  pageReply,
  validGrant,
} = await import("./index.mjs");

const sessionSecret = "a".repeat(64);
const grantSecret = "f".repeat(64);
const audience = "stats.cinder.ink";
const encodedPassword = (password) => {
  const salt = Buffer.from("cinder-test-salt");
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
};
const makeGrant = (grantAudience) => {
  const issued = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ aud: grantAudience, iat: issued, exp: issued + 120 })).toString("base64url");
  return `${payload}.${createHmac("sha256", grantSecret).update(payload).digest("hex")}`;
};
const event = (body) => ({ body: JSON.stringify(body), requestContext: { http: { method: "POST" } } });
const cookieToken = (reply) => reply.cookies[0].split("=", 2)[1].split(";", 1)[0];

assert.ok(decodeSession(encodeSession(sessionSecret), sessionSecret));
assert.equal(decodeSession(encodeSession(sessionSecret, -1), sessionSecret), null);
assert.equal(validGrant(makeGrant(audience), grantSecret, audience), true);
assert.equal(validGrant(makeGrant("stats.undertext.org"), grantSecret, audience), false);

const surface = { session_secret: sessionSecret, password_hashes: [encodedPassword("local")] };
const shared = {
  password_hashes: [encodedPassword("shared")],
  grant_secrets: {
    [audience]: grantSecret,
    "stats.undertext.org": "b".repeat(64),
  },
};
const sharedReply = authReply(event({ password: "shared" }), surface, shared);
const localReply = authReply(event({ password: "local" }), surface, shared);
const grantReply = authReply(event({ grant: makeGrant(audience) }), surface, shared);
assert.equal(authReply({ body: "x".repeat(2049) }, surface, shared).statusCode, 401);
for (const reply of [sharedReply, localReply, grantReply]) {
  assert.equal(reply.statusCode, 200);
  assert.match(reply.cookies[0], /; Max-Age=43200; Path=\/; Secure; HttpOnly; SameSite=Strict$/);
}
assert.ok(decodeSession(cookieToken(sharedReply), sessionSecret).capabilities.includes("stats-navigation"));
assert.equal(decodeSession(cookieToken(localReply), sessionSecret).capabilities, undefined);

const navigation = {
  schema: "org.uxuiai.stats-navigation.v1",
  destinations: [
    { id: "signal", group: "signals", label: "signal", href: "https://stats.undertext.org/" },
    { id: "place", group: "places", label: "place", href: "https://place.example/" },
  ],
  grants: {
    opaque: {
      active: true,
      audience,
      token_sha256: createHash("sha256").update("token").digest("hex"),
      code_sha256: createHash("sha256").update("code").digest("hex"),
      destinations: ["signal"],
    },
  },
};
const mattDestinations = mattNavigation(navigation, shared);
assert.equal(validGrant(mattDestinations[0].handoff, "b".repeat(64), "stats.undertext.org"), true);
assert.equal("handoff" in mattDestinations[1], false);
const claim = navigationClaimReply(event({ grant: "opaque.token.code" }), surface, navigation);
assert.equal(claim.statusCode, 200);
assert.equal(navigationClaimReply(event({ grant: "opaque.wrong.code" }), surface, navigation).statusCode, 401);

const navigationCookie = cookieToken(claim);
const mattEvent = { cookies: [`__Host-cinder_stats=${cookieToken(sharedReply)}`] };
assert.deepEqual(JSON.parse(navigationReply(mattEvent, surface, navigation).body).destinations.map(({ id }) => id), ["signal", "place"]);
const localEvent = { cookies: [`__Host-cinder_stats=${cookieToken(localReply)}`, `__Host-cinder_stats_navigation=${navigationCookie}`] };
assert.deepEqual(JSON.parse(navigationReply(localEvent, surface, navigation).body).destinations.map(({ id }) => id), ["signal"]);
navigation.grants.opaque.active = false;
assert.equal(navigationReply(localEvent, surface, navigation).statusCode, 401);

const protectedInventory = [
  "stats.uxuiai.org",
  "stats.ux-ui.ai",
  "stats.undertext.org",
  "stats.airbridgehealth.com",
  "stats.metamatt.io",
  "stats.cinder.ink",
  "mgennings.com",
  "holyinstant.app",
  "undertext.org",
];
for (const asset of ["welcome.html", "dashboard.html", "login.js", "navigation.js", "dashboard.js"]) {
  const source = await readFile(new URL(`site/${asset}`, import.meta.url), "utf8");
  for (const route of protectedInventory) assert.doesNotMatch(source, new RegExp(route.replaceAll(".", "\\.")));
  assert.doesNotMatch(source, /google-analytics|gtag\(|segment|mixpanel|localStorage|sessionStorage/i);
}
const welcome = await readFile(new URL("site/welcome.html", import.meta.url), "utf8");
assert.doesNotMatch(welcome, /private-navigation/);
const dashboard = await readFile(new URL("site/dashboard.html", import.meta.url), "utf8");
assert.match(dashboard, /id="private-navigation"/);
const loginSource = await readFile(new URL("site/login.js", import.meta.url), "utf8");
assert.doesNotMatch(loginSource, /dashboard\.html|welcome\.html/);
assert.match(loginSource, /window\.location\.replace\("\/"\)/);

const anonymousRoot = await pageReply({}, "/", async () => { throw new Error("authority must stay cold"); });
assert.equal(anonymousRoot.statusCode, 200);
assert.match(anonymousRoot.body, /the vault stays&nbsp;closed/);
const privateRoot = await pageReply(
  { cookies: [`__Host-cinder_stats=${cookieToken(sharedReply)}`] },
  "/",
  async () => surface,
);
assert.equal(privateRoot.statusCode, 200);
assert.match(privateRoot.body, /only infrastructure, never/);
for (const legacyPath of ["/welcome.html", "/dashboard.html"]) {
  const legacyReply = await pageReply({}, legacyPath, async () => { throw new Error("legacy redirects must stay cold"); });
  assert.equal(legacyReply.statusCode, 307);
  assert.equal(legacyReply.headers.location, "/");
  assert.equal(legacyReply.headers["cache-control"], "no-store, private");
}

const navigationSource = await readFile(new URL("site/navigation.js", import.meta.url), "utf8");
assert.match(navigationSource, /window\.location\.assign\(target\)/);
assert.doesNotMatch(navigationSource, /link\.href\s*=.*handoff|localStorage|sessionStorage|console\./);

const policy = JSON.parse(await readFile(new URL("infra/stats-policy.json", import.meta.url), "utf8"));
assert.equal(policy.Statement.length, 2);
assert.deepEqual(policy.Statement[0].Action, ["secretsmanager:GetSecretValue"]);
assert.deepEqual(new Set(policy.Statement[0].Resource), new Set([
  "arn:aws:secretsmanager:us-east-1:553806908724:secret:cinder-stats-secrets-*",
  "arn:aws:secretsmanager:us-east-1:553806908724:secret:stats-shared-credential-*",
  "arn:aws:secretsmanager:us-east-1:553806908724:secret:stats-private-navigation-*",
]));
assert.deepEqual(policy.Statement[1].Action, ["cloudwatch:GetMetricData"]);
assert.equal(policy.Statement[1].Resource, "*");
assert.deepEqual(policy.Statement[1].Condition, { StringEquals: { "aws:RequestedRegion": "us-east-1" } });
const policySource = JSON.stringify(policy);
assert.doesNotMatch(policySource, /logs:|dynamodb:|s3:|cognito|stripe/i);

const packageDocument = JSON.parse(await readFile(new URL("package.json", import.meta.url), "utf8"));
assert.ok(packageDocument.dependencies["@aws-sdk/client-cloudwatch"]);
assert.equal(packageDocument.dependencies["@aws-sdk/client-dynamodb"], undefined);
assert.equal(packageDocument.dependencies["@aws-sdk/client-s3"], undefined);
const deploySource = await readFile(new URL("deploy-stats.sh", import.meta.url), "utf8");
assert.doesNotMatch(deploySource, /AWSLambdaBasicExecutionRole|describe-stack-resource|list-functions/);
assert.match(deploySource, /CINDER_FUNCTION_MAP_JSON/);
assert.match(deploySource, /ensure-dualstack\.mjs/);

// The registry gains a Products group before it gains any Product destination,
// so every reader has to accept and order it while the live document still
// holds nine. Each rejection below already held and must keep holding.
const groupContract = {
  schema: "org.uxuiai.stats-navigation.v1",
  destinations: [
    { id: "signal-one", group: "signals", label: "signal", href: "https://stats.uxuiai.org/" },
    { id: "product-one", group: "products", label: "product", href: "https://stats.cinder.ink/" },
    { id: "place-one", group: "places", label: "place", href: "https://mgennings.com/" },
    { id: "unknown-group", group: "experiments", label: "unknown", href: "https://example.test/" },
    { id: "insecure", group: "products", label: "insecure", href: "http://example.test/" },
    { id: "script", group: "products", label: "script", href: "javascript:alert(1)" },
    { id: "credentialed", group: "products", label: "credentialed", href: "https://matt:secret@example.test/" },
    { id: "username-only", group: "products", label: "username only", href: "https://matt@example.test/" },
    { id: "password-only", group: "products", label: "password only", href: "https://:secret@example.test/" },
    { id: "empty-credential", group: "products", label: "empty credential", href: "https://@example.test/" },
    { id: "malformed-authority", group: "products", label: "malformed", href: "https://[::1/" },
    { id: "empty-host", group: "products", label: "empty host", href: "https://" },
    { id: "path-at-sign", group: "products", label: "path at sign", href: "https://example.test/a@b" },
    { id: "extra-field", group: "products", label: "extra", href: "https://example.test/", handoff: "x" },
  ],
};
assert.deepEqual(
  mattNavigation(groupContract, {}).map(({ id }) => id),
  ["signal-one", "product-one", "place-one", "path-at-sign"],
);

// Filtering is the backend's job; ordering the render is the reader's.
// allowedNavigation must never itself sort into signals/products/places -- it
// only has to decide keep-or-discard per record. If it silently started
// sorting, a broken render loop could hide behind a backend that quietly
// fixed the order for it. Feed a fixture whose groups are deliberately NOT
// listed canonically and compare the filtered result as a sorted set, never
// as an order-sensitive list, so this test cannot mistake "the fixture
// happens to be pre-sorted" for "the filter is correct."
const shuffledGroupOrder = {
  schema: "org.uxuiai.stats-navigation.v1",
  destinations: [
    { id: "place-one", group: "places", label: "place", href: "https://mgennings.com/" },
    { id: "unknown-group", group: "experiments", label: "unknown", href: "https://example.test/" },
    { id: "product-one", group: "products", label: "product", href: "https://stats.cinder.ink/" },
    { id: "insecure", group: "products", label: "insecure", href: "http://example.test/" },
    { id: "signal-one", group: "signals", label: "signal", href: "https://stats.uxuiai.org/" },
  ],
};
assert.deepEqual(
  mattNavigation(shuffledGroupOrder, {}).map(({ id }) => id).sort(),
  ["place-one", "product-one", "signal-one"].sort(),
);

assert.match(navigationSource, /\["signals", "products", "places"\]/);

// The literal-source check above proves the canonical array text is present,
// but not that the real loop uses it to order the DOM -- a reordered loop
// with the original array left behind in a comment would still pass it. Run
// the actual navigation.js in jsdom against a deliberately shuffled fixture
// and read the rendered group headings back out, so the render order itself
// is what the test proves rather than a string match on the source.
{
  // The live ten-destination taxonomy's exact 3/4/3 shape, deliberately fed in
  // scrambled order. Counting per group as well as reading the headings means
  // a renderer that emits all three headings but files a product under Places
  // cannot pass.
  const shuffledFixture = [
    { id: "place-one", group: "places", label: "place one", href: "https://mgennings.com/" },
    { id: "product-one", group: "products", label: "product one", href: "https://stats.undertext.org/" },
    { id: "signal-one", group: "signals", label: "signal one", href: "https://stats.uxuiai.org/" },
    { id: "place-two", group: "places", label: "place two", href: "https://undertext.org/" },
    { id: "product-two", group: "products", label: "product two", href: "https://stats.airbridgehealth.com/" },
    { id: "signal-two", group: "signals", label: "signal two", href: "https://stats.ux-ui.ai/" },
    { id: "place-three", group: "places", label: "place three", href: "https://mattbook.dev/" },
    { id: "product-three", group: "products", label: "product three", href: "https://stats.cinder.ink/" },
    { id: "signal-three", group: "signals", label: "signal three", href: "https://stats.metamatt.io/" },
    { id: "product-four", group: "products", label: "product four", href: "https://holyinstant.app/" },
  ];
  const dom = new JSDOM(`<!doctype html><body><div id="private-navigation"></div></body>`, {
    url: "https://stats.cinder.ink/",
    runScripts: "dangerously",
  });
  dom.window.fetch = async () => ({ ok: true, json: async () => ({ destinations: shuffledFixture }) });
  const script = dom.window.document.createElement("script");
  script.textContent = navigationSource;
  dom.window.document.body.append(script);
  // refresh_navigation() runs as an unawaited async IIFE at module load; give
  // its fetch-then-render microtask chain a few event-loop turns to settle.
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (dom.window.document.querySelector("li.group")) break;
  }
  const renderedGroups = [...dom.window.document.querySelectorAll("li.group")].map((li) => li.textContent);
  assert.deepEqual(renderedGroups, ["signals", "products", "places"]);

  // Walk the rendered <ul> in document order and bucket each link under the
  // heading that precedes it. Reading headings alone proves the labels exist;
  // this proves the destinations landed beneath the right one.
  const membership = new Map();
  let currentGroup = null;
  for (const item of dom.window.document.querySelectorAll(".switcher ul > li")) {
    if (item.classList.contains("group")) {
      currentGroup = item.textContent;
      membership.set(currentGroup, []);
      continue;
    }
    membership.get(currentGroup).push(item.querySelector("a"));
  }
  assert.deepEqual(
    [...membership].map(([group, links]) => [group, links.length]),
    [["signals", 3], ["products", 4], ["places", 3]],
  );
  assert.deepEqual(
    membership.get("products").map((link) => link.textContent),
    ["product one", "product two", "product three", "product four"],
  );

  // Every href renders byte-for-byte as delivered. A handoff appended to the
  // link itself -- rather than assigned at click time -- would show up here as
  // an extra hash or query the fixture never contained.
  const byLabel = new Map(shuffledFixture.map((destination) => [destination.label, destination.href]));
  for (const link of dom.window.document.querySelectorAll(".switcher a")) {
    assert.equal(link.getAttribute("href"), byLabel.get(link.textContent), link.textContent);
  }
  assert.equal(dom.window.document.querySelectorAll(".switcher a").length, 10);

  dom.window.close();
}

console.log("Cinder stats authentication contracts pass");
