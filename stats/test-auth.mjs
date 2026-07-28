import assert from "node:assert/strict";
import { createHash, createHmac, scryptSync } from "node:crypto";
import { readFile } from "node:fs/promises";

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
assert.match(anonymousRoot.body, /the vault stays closed/);
const privateRoot = await pageReply(
  { cookies: [`__Host-cinder_stats=${cookieToken(sharedReply)}`] },
  "/",
  async () => surface,
);
assert.equal(privateRoot.statusCode, 200);
assert.match(privateRoot.body, /only the infrastructure/);
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

console.log("Cinder stats authentication contracts pass");
