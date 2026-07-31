import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CloudWatchClient, GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";


const HERE = dirname(fileURLToPath(import.meta.url));
const REGION = "us-east-1";
const STATS_SECRET_ID = process.env.STATS_SECRET_ID;
const STATS_SHARED_SECRET_ID = process.env.STATS_SHARED_SECRET_ID;
const STATS_NAVIGATION_SECRET_ID = process.env.STATS_NAVIGATION_SECRET_ID;
const STATS_AUDIENCE = process.env.STATS_AUDIENCE;
const COOKIE_NAME = "__Host-cinder_stats";
const NAVIGATION_COOKIE_NAME = "__Host-cinder_stats_navigation";
const NAVIGATION_CAPABILITY = "stats-navigation";
const GRANT_MAX_LIFETIME_SECONDS = 300;
const GRANT_FUTURE_SKEW_SECONDS = 60;

export const CINDER_FUNCTION_IDS = Object.freeze([
  "CreateNoteFn",
  "ReadNoteFn",
  "CreateFileFn",
  "FinalizeFileFn",
  "StatusFileFn",
  "ClaimFileFn",
  "CheckEntitlementFn",
  "MintCapabilityFn",
  "DeleteAccountFn",
  "StartCheckoutFn",
  "PurchaseWebhookFn",
]);

export const METRIC_WINDOWS = Object.freeze([
  Object.freeze({ id: "24h", label: "last 24 hours", seconds: 86_400, periodSeconds: 3_600 }),
  Object.freeze({ id: "7d", label: "last 7 days", seconds: 604_800, periodSeconds: 21_600 }),
]);

// Anchored explorer windows. Distinct from METRIC_WINDOWS above -- these serve
// the scrubbable /api/metrics?window=... range endpoint and deliberately use
// finer periods than the legacy no-query document. 336 hours (14 days) sits
// exactly at CloudWatch's 1-minute-resolution retention ceiling, which is why
// the 1h window's 60-second period stays valid across the whole lookback.
export const RANGE_WINDOWS = Object.freeze([
  Object.freeze({ id: "1h", label: "last hour", seconds: 3_600, periodSeconds: 60 }),
  Object.freeze({ id: "4h", label: "last 4 hours", seconds: 14_400, periodSeconds: 300 }),
  Object.freeze({ id: "24h", label: "last 24 hours", seconds: 86_400, periodSeconds: 1_800 }),
  Object.freeze({ id: "7d", label: "last 7 days", seconds: 604_800, periodSeconds: 10_800 }),
]);

export const MAX_LOOKBACK_HOURS = 336;
const HOUR_MILLISECONDS = 3_600_000;
const ANCHOR_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/;

const secrets = new SecretsManagerClient({ region: REGION });
const cloudwatch = new CloudWatchClient({ region: REGION });


const securityHeaders = {
  "cache-control": "no-store, private",
  "content-security-policy": "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};


const jsonReply = (statusCode, body, cookies) => ({
  statusCode,
  headers: { ...securityHeaders, "content-type": "application/json; charset=utf-8" },
  ...(cookies ? { cookies } : {}),
  body: JSON.stringify(body),
});


const assetReply = async (name, contentType) => ({
  statusCode: 200,
  headers: { ...securityHeaders, "content-type": contentType },
  body: await readFile(join(HERE, "site", name), "utf8"),
});


const cleanRouteReply = () => ({
  statusCode: 307,
  headers: { ...securityHeaders, location: "/" },
  body: "",
});


export const encodeSession = (secret, hours = 12, claims = {}) => {
  const expires = Math.floor(Date.now() / 1000) + hours * 3600;
  const payload = Buffer.from(JSON.stringify({ ...claims, exp: expires })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${signature}`;
};


export const decodeSession = (token, secret) => {
  const [payload, signature] = String(token ?? "").split(".");
  if (!payload || !signature || !secret) return null;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const supplied = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    return Number(claims.exp) > Math.floor(Date.now() / 1000) ? claims : null;
  } catch {
    return null;
  }
};


export const validGrant = (token, secret, audience) => {
  if (!secret || !audience) return false;
  const [payload, signature, extra] = String(token ?? "").split(".");
  if (!payload || !signature || extra || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    const issued = Number(claims.iat);
    const expires = Number(claims.exp);
    const now = Math.floor(Date.now() / 1000);
    return claims.aud === audience
      && Number.isSafeInteger(issued)
      && Number.isSafeInteger(expires)
      && expires > now
      && issued <= now + GRANT_FUTURE_SKEW_SECONDS
      && expires - issued > 0
      && expires - issued <= GRANT_MAX_LIFETIME_SECONDS;
  } catch {
    return false;
  }
};


const derivedSecret = (secret, purpose) =>
  createHmac("sha256", secret).update(purpose).digest("hex");


const verifyPassword = (password, stored) => {
  try {
    const [scheme, saltValue, hashValue, extra] = String(stored ?? "").split("$");
    if (scheme !== "scrypt" || extra) return false;
    const salt = Buffer.from(saltValue, "base64url");
    const expected = Buffer.from(hashValue, "base64url");
    const actual = scryptSync(String(password ?? ""), salt, expected.length);
    return expected.length > 0 && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
};


const requestCookie = (event, name = COOKIE_NAME) => {
  const cookie = (event.cookies ?? []).find((item) => item.startsWith(`${name}=`));
  return cookie?.slice(name.length + 1) ?? "";
};


const requestBody = (event) => {
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? "", "base64").toString("utf8")
      : event.body;
    if (typeof raw === "string" && raw.length > 2048) return {};
    const body = JSON.parse(raw || "{}");
    return body && typeof body === "object" && !Array.isArray(body) ? body : {};
  } catch {
    return {};
  }
};


const secureCookie = (name, value, maxAge = 43200) =>
  `${name}=${value}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Strict`;


const readSecret = async (secretId) => {
  const { SecretString } = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
  return JSON.parse(SecretString);
};


export const authReply = (event, surface, shared) => {
  if (!surface || typeof surface.session_secret !== "string" || !shared || typeof shared !== "object") {
    return jsonReply(401, { error: "access denied" });
  }
  const body = requestBody(event);
  const password = typeof body.password === "string" ? body.password.slice(0, 256) : "";
  const grant = typeof body.grant === "string" ? body.grant.slice(0, 512) : "";
  const sharedHashes = Array.isArray(shared.password_hashes) ? shared.password_hashes : [];
  const localHashes = Array.isArray(surface.password_hashes) ? surface.password_hashes : [];
  const grantSecret = typeof shared.grant_secrets?.[STATS_AUDIENCE] === "string"
    ? shared.grant_secrets[STATS_AUDIENCE]
    : "";
  const sharedAccepted = password
    ? sharedHashes.some((hash) => typeof hash === "string" && verifyPassword(password, hash))
    : false;
  const localAccepted = password
    ? localHashes.some((hash) => typeof hash === "string" && verifyPassword(password, hash))
    : false;
  const grantAccepted = !password && validGrant(grant, grantSecret, STATS_AUDIENCE);
  if (!sharedAccepted && !localAccepted && !grantAccepted) {
    return jsonReply(401, { error: "access denied" });
  }
  const claims = sharedAccepted || grantAccepted ? { capabilities: [NAVIGATION_CAPABILITY] } : {};
  return jsonReply(200, { ok: true }, [secureCookie(COOKIE_NAME, encodeSession(surface.session_secret, 12, claims))]);
};


const verifiedNavigationGrant = (document, wireValue) => {
  if (document?.schema !== "org.uxuiai.stats-navigation.v1") return null;
  const parts = String(wireValue ?? "").split(".");
  if (parts.length !== 3) return null;
  const [grantId, token, code] = parts;
  const grant = document.grants?.[grantId];
  if (!grant || grant.active !== true || grant.audience !== STATS_AUDIENCE) return null;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const codeHash = createHash("sha256").update(code).digest("hex");
  const tokenExpected = String(grant.token_sha256 ?? "");
  const codeExpected = String(grant.code_sha256 ?? "");
  if (tokenExpected.length !== 64 || !timingSafeEqual(Buffer.from(tokenHash), Buffer.from(tokenExpected))) return null;
  if (codeExpected.length !== 64 || !timingSafeEqual(Buffer.from(codeHash), Buffer.from(codeExpected))) return null;
  return grantId;
};


const allowedNavigation = (document, destinationIds = null) => {
  const allowed = destinationIds ? new Set(destinationIds) : null;
  return Array.isArray(document?.destinations)
    ? document.destinations.filter((item) => {
      if (Object.keys(item ?? {}).sort().join(",") !== "group,href,id,label") return false;
      if (allowed && !allowed.has(item.id)) return false;
      const href = String(item.href);
      // A username or password in the authority would hand a credential to the
      // destination host on the first click. Owner-only registry, second lock.
      if (!href.startsWith("https://")) return false;
      if (href.slice("https://".length).split(/[/?#]/, 1)[0].includes("@")) return false;
      // A malformed or hostless authority (an unbalanced IPv6 literal, a bare
      // "https://") must not reach the renderer as a broken link; discard the
      // single bad record instead of raising through the whole navigation route.
      try {
        new URL(href);
      } catch {
        return false;
      }
      return ["signals", "products", "places"].includes(item.group);
    })
    : [];
};


const mintHandoff = (secret, audience) => {
  const issued = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    aud: audience,
    iat: issued,
    exp: issued + 120,
    nonce: randomBytes(12).toString("base64url"),
  })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${signature}`;
};


export const mattNavigation = (document, sharedCredential) => {
  const grantSecrets = sharedCredential?.grant_secrets;
  return allowedNavigation(document).map((item) => {
    try {
      const target = new URL(item.href);
      const secret = grantSecrets?.[target.hostname];
      if (target.protocol === "https:" && target.hostname.startsWith("stats.") && typeof secret === "string" && secret) {
        return { ...item, handoff: mintHandoff(secret, target.hostname) };
      }
    } catch { /* unreachable: allowedNavigation already discards any href that fails to parse */ }
    return item;
  });
};


export const navigationClaimReply = (event, surface, navigation) => {
  const grantId = verifiedNavigationGrant(navigation, requestBody(event).grant);
  if (!grantId || typeof surface?.session_secret !== "string") {
    return jsonReply(401, { error: "access denied" });
  }
  const secret = derivedSecret(surface.session_secret, "stats-navigation-cookie");
  const token = encodeSession(secret, 12, { grant_id: grantId });
  return jsonReply(200, { ok: true }, [secureCookie(NAVIGATION_COOKIE_NAME, token)]);
};


export const navigationReply = (event, surface, navigation, sharedCredential = null) => {
  const session = decodeSession(requestCookie(event), surface?.session_secret);
  if (!session) return jsonReply(401, { error: "authentication required" });
  if (Array.isArray(session.capabilities) && session.capabilities.includes(NAVIGATION_CAPABILITY)) {
    return jsonReply(200, { destinations: mattNavigation(navigation, sharedCredential) });
  }
  const secret = derivedSecret(surface.session_secret, "stats-navigation-cookie");
  const navSession = decodeSession(requestCookie(event, NAVIGATION_COOKIE_NAME), secret);
  const grant = navigation?.grants?.[navSession?.grant_id];
  if (!grant || grant.active !== true || grant.audience !== STATS_AUDIENCE || !Array.isArray(grant.destinations)) {
    return jsonReply(401, { error: "authentication required" });
  }
  return jsonReply(200, { destinations: allowedNavigation(navigation, grant.destinations) });
};


const authenticated = (event, surface) =>
  decodeSession(requestCookie(event), surface?.session_secret);


export const pageReply = async (event, path, loadSurface = () => readSecret(STATS_SECRET_ID)) => {
  if (["/welcome.html", "/dashboard.html"].includes(path)) return cleanRouteReply();
  if (path !== "/") return null;
  if (!requestCookie(event)) return assetReply("welcome.html", "text/html; charset=utf-8");
  try {
    const surface = await loadSurface();
    if (authenticated(event, surface)) return assetReply("dashboard.html", "text/html; charset=utf-8");
  } catch { /* The public arrival stays available if private authority is quiet. */ }
  return assetReply("welcome.html", "text/html; charset=utf-8");
};


export const parseFunctionMap = (wireValue = process.env.CINDER_FUNCTION_MAP) => {
  let document;
  try {
    document = JSON.parse(String(wireValue ?? ""));
  } catch {
    throw new Error("CINDER_FUNCTION_MAP must be valid JSON");
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("CINDER_FUNCTION_MAP must be an object");
  }
  const actualKeys = Object.keys(document).sort();
  const expectedKeys = [...CINDER_FUNCTION_IDS].sort();
  if (actualKeys.join("\n") !== expectedKeys.join("\n")) {
    throw new Error("CINDER_FUNCTION_MAP must name every exact Cinder function once");
  }
  for (const logicalId of CINDER_FUNCTION_IDS) {
    if (!new RegExp(`^blip-${logicalId}-[A-Za-z0-9]+$`).test(document[logicalId])) {
      throw new Error(`unexpected physical name for ${logicalId}`);
    }
  }
  if (new Set(Object.values(document)).size !== CINDER_FUNCTION_IDS.length) {
    throw new Error("CINDER_FUNCTION_MAP physical names must be unique");
  }
  return Object.freeze({ ...document });
};


// This is an address, not a name: it identifies the one public Cinder
// distribution whose aggregate delivery requests belong on this surface. It
// arrives as explicit deployment input so the stats deploy never discovers
// Cinder resources or expands its read authority.
export const parseSiteDistributionId = (wireValue = process.env.CINDER_SITE_DISTRIBUTION_ID) => {
  const distributionId = String(wireValue ?? "");
  if (!/^[A-Z0-9]{1,64}$/.test(distributionId)) {
    throw new Error("CINDER_SITE_DISTRIBUTION_ID must be a CloudFront distribution ID");
  }
  return distributionId;
};


// Parses and validates a `/api/metrics` query string before anything ever
// reaches CloudWatch. Returns `null` for any malformed, unknown, repeated, or
// out-of-range input; `{ legacy: true }` for the deployed no-query document
// old clients still call; or `{ legacy: false, window, end }` for a validated
// anchored range, where `end` is a Date for a fixed anchor or `null` for
// live/current.
export const parseRangeRequest = (rawQueryString, now = new Date()) => {
  const params = new URLSearchParams(rawQueryString ?? "");
  if (!params.has("window") && !params.has("end")) return { legacy: true };

  const windowValues = params.getAll("window");
  if (windowValues.length !== 1) return null;
  const window = RANGE_WINDOWS.find((candidate) => candidate.id === windowValues[0]);
  if (!window) return null;

  const endValues = params.getAll("end");
  if (endValues.length > 1) return null;
  const endValue = endValues[0];
  if (endValue === undefined) return { legacy: false, window, end: null };

  if (!ANCHOR_FORMAT.test(endValue)) return null;
  const anchor = new Date(endValue);
  if (Number.isNaN(anchor.getTime()) || anchor.toISOString() !== endValue) return null;
  if (anchor.getTime() > now.getTime()) return null;

  // One ceiling, checked at the START of the range. Every window has positive
  // length, so `start` is always older than `anchor` and a separate anchor-side
  // check could never reject anything this one lets through -- it was dead by
  // construction and no test could ever tell it apart. If a zero-length window
  // is ever added to RANGE_WINDOWS, that assumption dies and the anchor needs
  // its own check again.
  const start = new Date(anchor.getTime() - window.seconds * 1000);
  const startHoursOld = (now.getTime() - start.getTime()) / HOUR_MILLISECONDS;
  if (startHoursOld > MAX_LOOKBACK_HOURS) return null;

  return { legacy: false, window, end: anchor };
};


const metricStat = (functionName, metricName, period, stat) => ({
  Metric: {
    Namespace: "AWS/Lambda",
    MetricName: metricName,
    Dimensions: [{ Name: "FunctionName", Value: functionName }],
  },
  Period: period,
  Stat: stat,
});


const cloudFrontMetricStat = (distributionId, metricName, period, stat) => ({
  Metric: {
    Namespace: "AWS/CloudFront",
    MetricName: metricName,
    Dimensions: [
      { Name: "DistributionId", Value: distributionId },
      { Name: "Region", Value: "Global" },
    ],
  },
  Period: period,
  Stat: stat,
});


export const metricQueries = (functionMap, siteDistributionId, period) => {
  const queries = [];
  CINDER_FUNCTION_IDS.forEach((logicalId, index) => {
    const functionName = functionMap[logicalId];
    queries.push(
      { Id: `invocations_${index}`, MetricStat: metricStat(functionName, "Invocations", period, "Sum"), ReturnData: false },
      { Id: `errors_${index}`, MetricStat: metricStat(functionName, "Errors", period, "Sum"), ReturnData: false },
      { Id: `throttles_${index}`, MetricStat: metricStat(functionName, "Throttles", period, "Sum"), ReturnData: false },
      { Id: `duration_sum_${index}`, MetricStat: metricStat(functionName, "Duration", period, "Sum"), ReturnData: false },
      { Id: `duration_count_${index}`, MetricStat: metricStat(functionName, "Duration", period, "SampleCount"), ReturnData: false },
    );
  });
  return [
    ...queries,
    { Id: "site_requests", MetricStat: cloudFrontMetricStat(siteDistributionId, "Requests", period, "Sum"), ReturnData: true },
    { Id: "aggregate_invocations", Expression: 'SUM(METRICS("invocations_"))', Label: "Invocations", ReturnData: true },
    { Id: "aggregate_errors", Expression: 'SUM(METRICS("errors_"))', Label: "Errors", ReturnData: true },
    { Id: "aggregate_throttles", Expression: 'SUM(METRICS("throttles_"))', Label: "Throttles", ReturnData: true },
    { Id: "aggregate_duration", Expression: 'SUM(METRICS("duration_sum_"))/SUM(METRICS("duration_count_"))', Label: "Duration", ReturnData: true },
    { Id: "aggregate_duration_sum", Expression: 'SUM(METRICS("duration_sum_"))', Label: "Duration sum", ReturnData: true },
    { Id: "aggregate_duration_count", Expression: 'SUM(METRICS("duration_count_"))', Label: "Duration count", ReturnData: true },
  ];
};


const metricDefinitions = Object.freeze([
  Object.freeze({ id: "site_requests", label: "Site requests", unit: "count", aggregation: "sum" }),
  Object.freeze({ id: "invocations", label: "Invocations", unit: "count", aggregation: "sum" }),
  Object.freeze({ id: "errors", label: "Errors", unit: "count", aggregation: "sum" }),
  Object.freeze({ id: "throttles", label: "Throttles", unit: "count", aggregation: "sum" }),
  Object.freeze({ id: "duration", label: "Duration", unit: "milliseconds", aggregation: "average" }),
]);


const pointsFor = (result) => (result?.Timestamps ?? [])
  .map((timestamp, index) => ({ at: new Date(timestamp).toISOString(), value: result.Values?.[index] }))
  .filter((point) => Number.isFinite(point.value));


const sumValues = (result) => (result?.Values ?? [])
  .filter(Number.isFinite)
  .reduce((sum, value) => sum + value, 0);


const REQUIRED_RESULT_IDS = Object.freeze([
  "site_requests",
  "aggregate_invocations",
  "aggregate_errors",
  "aggregate_throttles",
  "aggregate_duration",
  "aggregate_duration_sum",
  "aggregate_duration_count",
]);


const completeMetricResults = (response) => {
  const results = new Map((response.MetricDataResults ?? []).map((result) => [result.Id, result]));
  const complete = REQUIRED_RESULT_IDS.every((id) => results.get(id)?.StatusCode === "Complete");
  if (!complete || (response.Messages?.length ?? 0) > 0) throw new Error("incomplete CloudWatch results");
  return results;
};


export const readMetricWindow = async (
  window,
  functionMap,
  siteDistributionId,
  now = new Date(),
  send = (command) => cloudwatch.send(command),
) => {
  const response = await send(new GetMetricDataCommand({
    StartTime: new Date(now.getTime() - window.seconds * 1000),
    EndTime: now,
    ScanBy: "TimestampAscending",
    MetricDataQueries: metricQueries(functionMap, siteDistributionId, window.periodSeconds),
  }));
  const results = completeMetricResults(response);
  const durationCount = sumValues(results.get("aggregate_duration_count"));
  const summaries = {
    site_requests: sumValues(results.get("site_requests")),
    invocations: sumValues(results.get("aggregate_invocations")),
    errors: sumValues(results.get("aggregate_errors")),
    throttles: sumValues(results.get("aggregate_throttles")),
    duration: durationCount > 0
      ? sumValues(results.get("aggregate_duration_sum")) / durationCount
      : null,
  };
  return {
    id: window.id,
    label: window.label,
    periodSeconds: window.periodSeconds,
    series: metricDefinitions.map((definition) => ({
      ...definition,
      summary: summaries[definition.id],
      points: pointsFor(results.get(definition.id === "site_requests" ? "site_requests" : `aggregate_${definition.id}`)),
    })),
  };
};


export const metricsDocument = async ({
  functionMap = parseFunctionMap(),
  siteDistributionId = parseSiteDistributionId(),
  now = new Date(),
  send,
} = {}) => ({
  availability: "available",
  checkedAt: now.toISOString(),
  source: "AWS/CloudFront + AWS/Lambda",
  scope: { product: "Cinder", functionCount: CINDER_FUNCTION_IDS.length, siteRequestSource: "AWS/CloudFront" },
  windows: await Promise.all(METRIC_WINDOWS.map((window) => readMetricWindow(window, functionMap, siteDistributionId, now, send))),
});


// The scrubbable range endpoint adds Error rate and Throttle rate beside the
// Lambda series. Both are derived here, server-side, from the same 62
// queries -- never a new CloudWatch query, never client-side math.
const rangeSeriesDefinitions = Object.freeze([
  Object.freeze({ id: "site_requests", label: "Site requests", unit: "count", aggregation: "sum" }),
  Object.freeze({ id: "invocations", label: "Invocations", unit: "count", aggregation: "sum" }),
  Object.freeze({ id: "errors", label: "Errors", unit: "count", aggregation: "sum" }),
  Object.freeze({ id: "error_rate", label: "Error rate", unit: "percent", aggregation: "ratio" }),
  Object.freeze({ id: "throttles", label: "Throttles", unit: "count", aggregation: "sum" }),
  Object.freeze({ id: "throttle_rate", label: "Throttle rate", unit: "percent", aggregation: "ratio" }),
  Object.freeze({ id: "duration", label: "Duration", unit: "milliseconds", aggregation: "average" }),
]);


const timestampMap = (result) => new Map(
  (result?.Timestamps ?? [])
    .map((timestamp, index) => [new Date(timestamp).toISOString(), result.Values?.[index]])
    .filter(([, value]) => Number.isFinite(value)),
);


// A per-bucket rate needs its own denominator bucket to exist and be positive.
// A missing or zero-invocation bucket produces no point at all -- never
// Infinity, never NaN, and never a zero that would misrepresent "no traffic"
// as "no errors."
const ratePoints = (numeratorResult, denominatorResult) => {
  const numerators = timestampMap(numeratorResult);
  const points = [];
  for (const [at, denominator] of timestampMap(denominatorResult)) {
    if (!(denominator > 0)) continue;
    const numerator = numerators.get(at);
    if (!Number.isFinite(numerator)) continue;
    points.push({ at, value: (numerator / denominator) * 100 });
  }
  return points;
};


export const readRangeWindow = async (
  window,
  start,
  end,
  functionMap,
  siteDistributionId,
  send = (command) => cloudwatch.send(command),
) => {
  const response = await send(new GetMetricDataCommand({
    StartTime: start,
    EndTime: end,
    ScanBy: "TimestampAscending",
    MetricDataQueries: metricQueries(functionMap, siteDistributionId, window.periodSeconds),
  }));
  const results = completeMetricResults(response);
  const durationCount = sumValues(results.get("aggregate_duration_count"));
  const invocationsTotal = sumValues(results.get("aggregate_invocations"));
  const errorsTotal = sumValues(results.get("aggregate_errors"));
  const throttlesTotal = sumValues(results.get("aggregate_throttles"));

  const summaries = {
    site_requests: sumValues(results.get("site_requests")),
    invocations: invocationsTotal,
    errors: errorsTotal,
    error_rate: invocationsTotal > 0 ? (errorsTotal / invocationsTotal) * 100 : null,
    throttles: throttlesTotal,
    throttle_rate: invocationsTotal > 0 ? (throttlesTotal / invocationsTotal) * 100 : null,
    duration: durationCount > 0 ? sumValues(results.get("aggregate_duration_sum")) / durationCount : null,
  };
  const pointsById = {
    site_requests: pointsFor(results.get("site_requests")),
    invocations: pointsFor(results.get("aggregate_invocations")),
    errors: pointsFor(results.get("aggregate_errors")),
    error_rate: ratePoints(results.get("aggregate_errors"), results.get("aggregate_invocations")),
    throttles: pointsFor(results.get("aggregate_throttles")),
    throttle_rate: ratePoints(results.get("aggregate_throttles"), results.get("aggregate_invocations")),
    duration: pointsFor(results.get("aggregate_duration")),
  };

  return rangeSeriesDefinitions.map((definition) => ({
    ...definition,
    summary: summaries[definition.id],
    points: pointsById[definition.id],
  }));
};


export const rangeDocument = async ({
  window,
  end = null,
  functionMap = parseFunctionMap(),
  siteDistributionId = parseSiteDistributionId(),
  now = new Date(),
  send,
}) => {
  const anchor = end ?? now;
  const start = new Date(anchor.getTime() - window.seconds * 1000);
  const series = await readRangeWindow(window, start, anchor, functionMap, siteDistributionId, send);
  return {
    availability: "available",
    checkedAt: now.toISOString(),
    source: "AWS/CloudFront + AWS/Lambda",
    scope: { product: "Cinder", functionCount: CINDER_FUNCTION_IDS.length, siteRequestSource: "AWS/CloudFront" },
    range: {
      id: window.id,
      label: window.label,
      start: start.toISOString(),
      end: anchor.toISOString(),
      periodSeconds: window.periodSeconds,
      mode: end ? "fixed" : "live",
    },
    series,
  };
};


// Thin, testable seam between the raw query string and CloudWatch: every
// rejection returns before `functionMap` or `send` is ever touched.
export const metricsRouteReply = async (rawQueryString, { now = new Date(), functionMap, siteDistributionId, send } = {}) => {
  const parsed = parseRangeRequest(rawQueryString, now);
  if (!parsed) return jsonReply(400, { error: "invalid range request" });
  let resolvedFunctionMap;
  let resolvedSiteDistributionId;
  try {
    resolvedFunctionMap = parseFunctionMap(functionMap === undefined ? undefined : JSON.stringify(functionMap));
    resolvedSiteDistributionId = parseSiteDistributionId(siteDistributionId);
  } catch {
    return jsonReply(503, { availability: "unconfigured", error: "metrics unconfigured" });
  }
  try {
    const document = parsed.legacy
      ? await metricsDocument({ functionMap: resolvedFunctionMap, siteDistributionId: resolvedSiteDistributionId, now, send })
      : await rangeDocument({ window: parsed.window, end: parsed.end, functionMap: resolvedFunctionMap, siteDistributionId: resolvedSiteDistributionId, now, send });
    return jsonReply(200, document);
  } catch {
    return jsonReply(503, { availability: "unavailable", error: "metrics unavailable" });
  }
};


export async function handler(event) {
  const path = event.rawPath || event.requestContext?.http?.path || "/";
  const method = event.requestContext?.http?.method || "GET";

  if (method === "GET") {
    const page = await pageReply(event, path);
    if (page) return page;
  }
  if (method === "GET" && path === "/stats.css") return assetReply("stats.css", "text/css; charset=utf-8");
  if (method === "GET" && path === "/login.js") return assetReply("login.js", "application/javascript; charset=utf-8");

  if (path === "/api/auth" && method === "POST") {
    const [surface, shared] = await Promise.all([
      readSecret(STATS_SECRET_ID),
      readSecret(STATS_SHARED_SECRET_ID),
    ]);
    return authReply(event, surface, shared);
  }
  if (path === "/api/navigation/claim" && method === "POST") {
    const [surface, navigation] = await Promise.all([
      readSecret(STATS_SECRET_ID),
      readSecret(STATS_NAVIGATION_SECRET_ID),
    ]);
    return navigationClaimReply(event, surface, navigation);
  }
  if (path === "/api/logout" && method === "POST") {
    return jsonReply(200, { ok: true }, [
      secureCookie(COOKIE_NAME, "", 0),
      secureCookie(NAVIGATION_COOKIE_NAME, "", 0),
    ]);
  }

  const surface = await readSecret(STATS_SECRET_ID);
  const session = authenticated(event, surface);
  if (!session) return jsonReply(401, { error: "authentication required" });
  if (method === "GET" && path === "/navigation.js") return assetReply("navigation.js", "application/javascript; charset=utf-8");
  if (method === "GET" && path === "/dashboard.js") return assetReply("dashboard.js", "application/javascript; charset=utf-8");
  if (path === "/api/session" && method === "GET") return jsonReply(200, { authenticated: true });
  if (path === "/api/navigation" && method === "GET") {
    const navigation = await readSecret(STATS_NAVIGATION_SECRET_ID);
    const capabilities = Array.isArray(session.capabilities) ? session.capabilities : [];
    const shared = capabilities.includes(NAVIGATION_CAPABILITY)
      ? await readSecret(STATS_SHARED_SECRET_ID)
      : null;
    return navigationReply(event, surface, navigation, shared);
  }
  if (path === "/api/metrics" && method === "GET") {
    return metricsRouteReply(event.rawQueryString);
  }
  return jsonReply(404, { error: "route not found" });
}
