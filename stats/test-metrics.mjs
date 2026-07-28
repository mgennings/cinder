import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.STATS_SECRET_ID = "test-surface";
process.env.STATS_SHARED_SECRET_ID = "test-shared";
process.env.STATS_NAVIGATION_SECRET_ID = "test-navigation";
process.env.STATS_AUDIENCE = "stats.cinder.ink";

const {
  CINDER_FUNCTION_IDS,
  METRIC_WINDOWS,
  metricQueries,
  metricsDocument,
  parseFunctionMap,
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
