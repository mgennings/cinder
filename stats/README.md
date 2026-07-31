# Cinder private infrastructure stats

`stats.cinder.ink` is a clean-root, audience-bound private surface. It reads
only CloudWatch aggregate metrics: delivery requests from Cinder's one public
CloudFront distribution, plus Invocations, Errors, Throttles, and Duration for
Cinder's exact Lambda function set over fixed 24-hour and 7-day windows. A
site request is a delivery request, not a visitor, reader, or note event.

The Lambda role can call only `cloudwatch:GetMetricData` in `us-east-1` and
read the three exact stats secrets. It has no log permission and no application
data permission. The browser response contains aggregate series only and never
includes Lambda physical names.

## Anchored explorer windows

`GET /api/metrics` with no query string keeps returning the deployed
`windows: [24h, 7d]` document for old clients. A query-carrying request scrubs
one anchored range at a time:

```
GET /api/metrics?window=4h
GET /api/metrics?window=4h&end=2026-07-28T18:00:00.000Z
```

`window` is one of `1h`, `4h`, `24h`, `7d`, pinned to periods `60`, `300`,
`1800`, and `10800` seconds. An absent `end` returns the live/current partial
interval; a present `end` must be an exact UTC hour boundary
(`YYYY-MM-DDTHH:00:00.000Z`) and is end-exclusive. A request is rejected with
`400` before any CloudWatch call for an unknown or repeated `window`/`end`, a
malformed or non-hour `end`, a future anchor, an anchor more than 336 hours
(14 days) old, or a range whose *start* -- anchor minus the window's own
duration -- would exceed that same 336-hour lookback. 336 hours sits exactly at
CloudWatch's 1-minute-resolution retention ceiling.

The response uses 62 `GetMetricData` query structures: 55 per-function
metrics, 6 Lambda aggregate expressions, and one public-site request metric.
Every complete response carries `availability: "available"`. Missing result
IDs, CloudWatch messages, and non-`Complete` result statuses fail with
`availability: "unavailable"`; invalid deployment inputs fail with
`availability: "unconfigured"`. A complete empty series remains an available
numeric zero.
It adds two series derived entirely server-side from the Lambda aggregates:
`error_rate` and `throttle_rate`, each `errors|throttles / invocations * 100`
aligned by timestamp. A bucket whose invocations are zero or absent produces no
rate point for that bucket, and the whole-range `summary` is `null` -- never
`Infinity`, `NaN`, or a falsely reassuring `0` -- whenever total invocations
are zero.

## Local verification

```bash
npm ci
npm run test:all
```

The layout gate runs at 320, 375, 440, 768, and 1440 pixels in both color
schemes, checks 48-pixel targets and WCAG AA token contrast, and exercises the
clean-root login, window control, navigation revocation, and logout paths.

## Deployment input

Deployment requires `CINDER_FUNCTION_MAP_JSON`, a JSON object whose keys are
the 11 exact logical function IDs in `template.yaml` and whose values are their
exact deployed physical names, plus `CINDER_SITE_DISTRIBUTION_ID` for Cinder's
public CloudFront distribution. The deploy script does not list or discover
Cinder resources. The runtime rejects missing, additional, malformed, or
duplicate function-map entries, and an invalid distribution ID, before issuing
a metric query.

```bash
export CINDER_FUNCTION_MAP_JSON='{"CreateNoteFn":"blip-CreateNoteFn-..."}'
export CINDER_SITE_DISTRIBUTION_ID='EXAMPLE123'
./deploy-stats.sh origin
./deploy-stats.sh domain
```

The abbreviated example is intentionally not deployable. Supply all 11 exact
entries. Deployment is a separate operator action; tests and builds do not
mutate AWS, DNS, or the private navigation document.
