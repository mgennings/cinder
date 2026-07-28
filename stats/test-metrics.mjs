import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.STATS_SECRET_ID = "test-surface";
process.env.STATS_SHARED_SECRET_ID = "test-shared";
process.env.STATS_NAVIGATION_SECRET_ID = "test-navigation";
process.env.STATS_AUDIENCE = "stats.cinder.ink";

const {
  CINDER_FUNCTION_IDS,
  MAX_LOOKBACK_HOURS,
  METRIC_WINDOWS,
  RANGE_WINDOWS,
  metricQueries,
  metricsDocument,
  metricsRouteReply,
  parseFunctionMap,
  parseRangeRequest,
  rangeDocument,
} = await import("./index.mjs");

const functionMap = Object.fromEntries(
  CINDER_FUNCTION_IDS.map((logicalId, index) => [logicalId, `blip-${logicalId}-Exact${index}`]),
);

assert.deepEqual(parseFunctionMap(JSON.stringify(functionMap)), functionMap);
assert.throws(() => parseFunctionMap("{}"), /every exact Cinder function/);
assert.throws(
  () => parseFunctionMap(JSON.stringify({ ...functionMap, UnexpectedFn: "blip-UnexpectedFn-Wrong" })),
  /every exact Cinder function/,
);
assert.throws(
  () => parseFunctionMap(JSON.stringify({ ...functionMap, CreateNoteFn: "other-CreateNoteFn-Wrong" })),
  /unexpected physical name/,
);
assert.throws(
  () => parseFunctionMap(JSON.stringify({ ...functionMap, CreateNoteFn: functionMap.ReadNoteFn })),
  /unexpected physical name|must be unique/,
);

const queries = metricQueries(functionMap, 3_600);
assert.equal(queries.length, CINDER_FUNCTION_IDS.length * 5 + 6);
const rawQueries = queries.filter((query) => query.MetricStat);
const expressionQueries = queries.filter((query) => query.Expression);
assert.equal(rawQueries.length, 55);
assert.equal(expressionQueries.length, 6);
assert.deepEqual(new Set(rawQueries.map((query) => query.MetricStat.Metric.Namespace)), new Set(["AWS/Lambda"]));
assert.deepEqual(
  new Set(rawQueries.map((query) => query.MetricStat.Metric.MetricName)),
  new Set(["Invocations", "Errors", "Throttles", "Duration"]),
);
assert.deepEqual(
  new Set(rawQueries.map((query) => query.MetricStat.Stat)),
  new Set(["Sum", "SampleCount"]),
);
assert.deepEqual(
  new Set(rawQueries.map((query) => query.MetricStat.Metric.Dimensions[0].Name)),
  new Set(["FunctionName"]),
);
assert.deepEqual(
  new Set(rawQueries.map((query) => query.MetricStat.Metric.Dimensions[0].Value)),
  new Set(Object.values(functionMap)),
);
assert.ok(rawQueries.every((query) => query.ReturnData === false));
assert.ok(expressionQueries.every((query) => query.ReturnData === true));
assert.deepEqual(expressionQueries.map((query) => query.Id), [
  "aggregate_invocations",
  "aggregate_errors",
  "aggregate_throttles",
  "aggregate_duration",
  "aggregate_duration_sum",
  "aggregate_duration_count",
]);

const now = new Date("2026-07-28T18:00:00.000Z");
const calls = [];
const send = async (command) => {
  calls.push(command.input);
  const period = command.input.MetricDataQueries[0].MetricStat.Period;
  const points = period === 3_600 ? 24 : 28;
  const timestamps = Array.from({ length: points }, (_, index) => new Date(now.getTime() - (points - index) * period * 1000));
  return {
    MetricDataResults: [
      { Id: "aggregate_invocations", Timestamps: timestamps, Values: timestamps.map((_, index) => index + 1) },
      { Id: "aggregate_errors", Timestamps: timestamps, Values: timestamps.map(() => 0) },
      { Id: "aggregate_throttles", Timestamps: timestamps, Values: timestamps.map(() => 0) },
      { Id: "aggregate_duration", Timestamps: timestamps, Values: timestamps.map((_, index) => 40 + index / 10) },
      // Deliberately unequal buckets. The visible Duration summary must weight
      // by samples, not average the already-averaged trend points.
      { Id: "aggregate_duration_sum", Timestamps: timestamps, Values: timestamps.map((_, index) => index ? 1_000 : 10) },
      { Id: "aggregate_duration_count", Timestamps: timestamps, Values: timestamps.map((_, index) => index ? 10 : 1) },
    ],
  };
};

const document = await metricsDocument({ functionMap, now, send });
assert.equal(document.checkedAt, now.toISOString());
assert.equal(document.source, "AWS/Lambda");
assert.deepEqual(document.scope, { product: "Cinder", functionCount: 11 });
assert.deepEqual(document.windows.map((window) => window.id), ["24h", "7d"]);
assert.deepEqual(document.windows.map((window) => window.periodSeconds), [3_600, 21_600]);
assert.deepEqual(document.windows[0].series.map((series) => series.label), ["Invocations", "Errors", "Throttles", "Duration"]);
assert.equal(document.windows[0].series[0].points.length, 24);
assert.equal(document.windows[1].series[0].points.length, 28);
assert.equal(document.windows[0].series[3].aggregation, "average");
assert.equal(document.windows[0].series[0].summary, 300);
assert.equal(document.windows[0].series[3].summary, (10 + 23_000) / (1 + 230));
assert.notEqual(document.windows[0].series[3].summary, 41.15);
assert.equal(calls.length, 2);

for (const window of METRIC_WINDOWS) {
  const call = calls.find((candidate) => candidate.MetricDataQueries[0].MetricStat.Period === window.periodSeconds);
  assert.ok(call);
  assert.equal(call.ScanBy, "TimestampAscending");
  assert.equal(call.EndTime.toISOString(), now.toISOString());
  assert.equal((call.EndTime - call.StartTime) / 1000, window.seconds);
}

const browserDocument = JSON.stringify(document);
for (const physicalName of Object.values(functionMap)) assert.doesNotMatch(browserDocument, new RegExp(physicalName));
assert.doesNotMatch(browserDocument, /people|recipients|downloads|deliveries|opens/i);

const source = await readFile(new URL("index.mjs", import.meta.url), "utf8");
assert.doesNotMatch(source, /ListMetrics|SEARCH\s*\(|DescribeFunctions|ListFunctions/);
assert.doesNotMatch(source, /client-dynamodb|client-s3|client-cognito|stripe/i);
const dashboardSource = await readFile(new URL("site/dashboard.js", import.meta.url), "utf8");
assert.match(dashboardSource, /series\.summary/);
assert.doesNotMatch(dashboardSource, /aggregateValue/);

console.log("Cinder aggregate metric contracts pass");

// =====================================================================
// Task 4: anchored 1h/4h/24h/7d ranges with server-derived error/throttle
// rates. The no-query legacy document above must keep passing unchanged.
// =====================================================================

assert.equal(MAX_LOOKBACK_HOURS, 336);
assert.deepEqual(RANGE_WINDOWS.map((window) => window.id), ["1h", "4h", "24h", "7d"]);
assert.deepEqual(RANGE_WINDOWS.map((window) => window.periodSeconds), [60, 300, 1_800, 10_800]);
assert.deepEqual(RANGE_WINDOWS.map((window) => window.seconds), [3_600, 14_400, 86_400, 604_800]);

// The 61-query ceiling holds at every anchored period, not just the legacy
// document's 3_600s period exercised above.
for (const anchoredPeriod of RANGE_WINDOWS.map((window) => window.periodSeconds)) {
  assert.equal(metricQueries(functionMap, anchoredPeriod).length, 61);
}

// --- parseRangeRequest: accept ------------------------------------------

const onTheHour = new Date("2026-07-28T18:00:00.000Z");
const midHour = new Date("2026-07-28T18:30:00.000Z");

assert.deepEqual(parseRangeRequest("", midHour), { legacy: true });
assert.deepEqual(parseRangeRequest(undefined, midHour), { legacy: true });
assert.deepEqual(parseRangeRequest("foo=bar", midHour), { legacy: true });

{
  const live = parseRangeRequest("window=4h", midHour);
  assert.equal(live.legacy, false);
  assert.equal(live.window.id, "4h");
  assert.equal(live.end, null);
}
{
  const fixed = parseRangeRequest("window=4h&end=2026-07-28T18:00:00.000Z", midHour);
  assert.equal(fixed.legacy, false);
  assert.equal(fixed.window.id, "4h");
  assert.equal(fixed.end.toISOString(), "2026-07-28T18:00:00.000Z");
}
// An unrelated extra key never blocks a well-formed request.
assert.equal(parseRangeRequest("window=1h&extra=ignored", midHour).legacy, false);
// An anchor exactly equal to "now" is not "future" -- only strictly later is.
assert.equal(parseRangeRequest("window=1h&end=2026-07-28T18:00:00.000Z", onTheHour).legacy, false);
// 335 hours old is exactly at the 1h window's start-of-range limit (335 + 1 = 336): accepted.
{
  const boundary = new Date(onTheHour.getTime() - 335 * 3_600_000).toISOString();
  assert.equal(parseRangeRequest(`window=1h&end=${boundary}`, onTheHour).legacy, false);
}

// --- parseRangeRequest: reject, every case before touching CloudWatch ---

const rejected = [
  "window=2h",                                                              // unknown window id
  "window=1h&window=4h",                                                    // repeated window
  "window=",                                                                // empty window value
  "window=4h&end=2026-07-28T18:00:00.000Z&end=2026-07-28T17:00:00.000Z",    // repeated end
  "window=4h&end=2026-07-28T18:00:00.000",                                  // missing Z
  "window=4h&end=2026-07-28T18:00:00.000+00:00",                            // offset instead of Z
  "window=4h&end=2026-07-28T18:30:00.000Z",                                 // non-hour timestamp
  "window=4h&end=2026-07-28T18:00:05.000Z",                                 // seconds drift
  "window=4h&end=not-a-date",                                               // invalid date
  "window=4h&end=2026-02-30T10:00:00.000Z",                                 // invalid calendar date (Feb 30)
  "window=1h&end=2026-07-28T19:00:00.000Z",                                 // future anchor (now=18:30)
];
for (const query of rejected) assert.equal(parseRangeRequest(query, midHour), null, query);

// An anchor absolutely too old, independent of window (400h > 336h).
{
  const ancient = new Date(onTheHour.getTime() - 400 * 3_600_000).toISOString();
  assert.equal(parseRangeRequest(`window=1h&end=${ancient}`, onTheHour), null);
}
// 336 hours old alone is not "older than 336 hours", but for the 1h window the
// START (337h old) exceeds the limit -- proves the second, start-based check
// fires independently of the first.
{
  const oneOver = new Date(onTheHour.getTime() - 336 * 3_600_000).toISOString();
  assert.equal(parseRangeRequest(`window=1h&end=${oneOver}`, onTheHour), null);
}
// The end anchor itself (200h old) is nowhere near 336h old, yet the 7-day
// window pushes the START to 368h old -- rejected by the start-exceeds-limit
// check alone.
{
  const shallow = new Date(onTheHour.getTime() - 200 * 3_600_000).toISOString();
  assert.equal(parseRangeRequest(`window=7d&end=${shallow}`, onTheHour), null);
}

// --- rangeDocument: math ---------------------------------------------------

const rangeSend = (points, values) => async (command) => {
  const period = command.input.MetricDataQueries[0].MetricStat.Period;
  const start = command.input.StartTime;
  const timestamps = Array.from({ length: points }, (_, index) => new Date(start.getTime() + index * period * 1000));
  return {
    MetricDataResults: Object.entries(values).map(([id, seriesValues]) => ({
      Id: id,
      Timestamps: seriesValues.map((value, index) => value === null ? null : timestamps[index]).filter(Boolean),
      Values: seriesValues.filter((value) => value !== null),
    })),
  };
};

{
  // t1 has invocations=0 with a stray error -- that bucket's rate must be
  // dropped, never Infinity. t2's throttle rate is a legitimate 0%.
  const send = rangeSend(3, {
    aggregate_invocations: [10, 0, 5],
    aggregate_errors: [2, 3, 1],
    aggregate_throttles: [1, 0, 0],
    aggregate_duration: [40, 41, 42],
    aggregate_duration_sum: [100, 0, 60],
    aggregate_duration_count: [10, 0, 5],
  });
  const window = RANGE_WINDOWS.find((candidate) => candidate.id === "4h");
  const doc = await rangeDocument({ window, end: onTheHour, functionMap, now: onTheHour, send });

  assert.deepEqual(Object.keys(doc).sort(), ["checkedAt", "range", "scope", "series", "source"].sort());
  assert.deepEqual(Object.keys(doc.range).sort(), ["end", "id", "label", "mode", "periodSeconds", "start"].sort());
  assert.equal(doc.range.mode, "fixed");
  assert.equal(doc.range.id, "4h");
  assert.equal(doc.range.end, onTheHour.toISOString());
  assert.equal(doc.range.start, new Date(onTheHour.getTime() - 4 * 3_600_000).toISOString());
  assert.equal(doc.range.periodSeconds, 300);

  assert.deepEqual(doc.series.map((series) => series.id), [
    "invocations", "errors", "error_rate", "throttles", "throttle_rate", "duration",
  ]);
  for (const series of doc.series) {
    assert.deepEqual(Object.keys(series).sort(), ["aggregation", "id", "label", "points", "summary", "unit"].sort());
    for (const point of series.points) assert.deepEqual(Object.keys(point).sort(), ["at", "value"]);
  }

  const errorRate = doc.series.find((series) => series.id === "error_rate");
  assert.equal(errorRate.points.length, 2);
  assert.equal(errorRate.points[0].value, 20);   // 2/10 * 100
  assert.equal(errorRate.points[1].value, 20);   // 1/5 * 100
  assert.equal(errorRate.summary, (2 + 3 + 1) / (10 + 0 + 5) * 100);

  const throttleRate = doc.series.find((series) => series.id === "throttle_rate");
  assert.equal(throttleRate.points.length, 2);
  assert.equal(throttleRate.points[0].value, 10);  // 1/10 * 100
  assert.equal(throttleRate.points[1].value, 0);   // 0/5 * 100, a real zero
  assert.equal(throttleRate.summary, (1 + 0 + 0) / (10 + 0 + 5) * 100);

  for (const physicalName of Object.values(functionMap)) {
    assert.doesNotMatch(JSON.stringify(doc), new RegExp(physicalName));
  }
  assert.doesNotMatch(JSON.stringify(doc), /people|recipients|downloads|deliveries|opens/i);
}

{
  // Zero invocations across the whole range: both rates report `summary:
  // null`, never Infinity/NaN/a falsely reassuring zero, and no rate points.
  const send = rangeSend(2, {
    aggregate_invocations: [0, 0],
    aggregate_errors: [0, 0],
    aggregate_throttles: [0, 0],
    aggregate_duration: [null, null],
    aggregate_duration_sum: [0, 0],
    aggregate_duration_count: [0, 0],
  });
  const window = RANGE_WINDOWS.find((candidate) => candidate.id === "1h");
  const doc = await rangeDocument({ window, end: null, functionMap, now: onTheHour, send });
  assert.equal(doc.range.mode, "live");
  assert.equal(doc.range.end, onTheHour.toISOString());
  const errorRate = doc.series.find((series) => series.id === "error_rate");
  const throttleRate = doc.series.find((series) => series.id === "throttle_rate");
  const duration = doc.series.find((series) => series.id === "duration");
  assert.equal(errorRate.summary, null);
  assert.equal(throttleRate.summary, null);
  assert.equal(duration.summary, null);
  assert.deepEqual(errorRate.points, []);
  assert.deepEqual(throttleRate.points, []);
}

{
  // A bucket present in the errors series but entirely absent from
  // invocations (not merely zero) must also be dropped, never treated as an
  // implicit zero denominator turned into Infinity.
  const send = rangeSend(2, {
    aggregate_invocations: [10, null],
    aggregate_errors: [1, 4],
    aggregate_throttles: [0, 0],
    aggregate_duration: [30, 31],
    aggregate_duration_sum: [30, 31],
    aggregate_duration_count: [1, 1],
  });
  const window = RANGE_WINDOWS.find((candidate) => candidate.id === "1h");
  const doc = await rangeDocument({ window, end: onTheHour, functionMap, now: onTheHour, send });
  const errorRate = doc.series.find((series) => series.id === "error_rate");
  assert.equal(errorRate.points.length, 1);
  assert.equal(errorRate.points[0].value, 10);
}

// --- metricsRouteReply: validate before touching CloudWatch ---------------

{
  const calls = [];
  const send = async (command) => { calls.push(command.input); return { MetricDataResults: [] }; };

  for (const query of rejected) {
    const reply = await metricsRouteReply(query, { now: midHour, functionMap, send });
    assert.equal(reply.statusCode, 400, query);
  }
  assert.equal(calls.length, 0, "an invalid request must never reach CloudWatch");

  const legacyReply = await metricsRouteReply(undefined, { now, functionMap, send });
  assert.equal(legacyReply.statusCode, 200);
  assert.ok(JSON.parse(legacyReply.body).windows, "legacy no-query clients keep the deployed document shape");
  assert.equal(calls.length, 2);
  calls.length = 0;

  const liveReply = await metricsRouteReply("window=1h", { now: onTheHour, functionMap, send });
  assert.equal(liveReply.statusCode, 200);
  const liveBody = JSON.parse(liveReply.body);
  assert.equal(liveBody.range.mode, "live");
  assert.equal(liveBody.range.end, onTheHour.toISOString());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].MetricDataQueries[0].MetricStat.Period, 60);
  calls.length = 0;

  const fixedReply = await metricsRouteReply("window=4h&end=2026-07-28T18:00:00.000Z", { now: midHour, functionMap, send });
  assert.equal(fixedReply.statusCode, 200);
  const fixedBody = JSON.parse(fixedReply.body);
  assert.equal(fixedBody.range.mode, "fixed");
  assert.equal(fixedBody.range.start, "2026-07-28T14:00:00.000Z");
  assert.equal(fixedBody.range.end, "2026-07-28T18:00:00.000Z");
  assert.equal(calls.length, 1);
}

console.log("Cinder anchored range and derived-rate contracts pass");
