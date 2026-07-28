# Cinder private infrastructure stats

`stats.cinder.ink` is a clean-root, audience-bound private surface. It reads
only CloudWatch aggregate metrics for Cinder's exact Lambda function set:
Invocations, Errors, Throttles, and Duration over fixed 24-hour and 7-day
windows.

The Lambda role can call only `cloudwatch:GetMetricData` in `us-east-1` and
read the three exact stats secrets. It has no log permission and no application
data permission. The browser response contains aggregate series only and never
includes Lambda physical names.

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
exact deployed physical names. The deploy script does not list or discover
Cinder resources. The runtime rejects missing, additional, malformed, or
duplicate entries before issuing a metric query.

```bash
export CINDER_FUNCTION_MAP_JSON='{"CreateNoteFn":"blip-CreateNoteFn-..."}'
./deploy-stats.sh origin
./deploy-stats.sh domain
```

The abbreviated example is intentionally not deployable. Supply all 11 exact
entries. Deployment is a separate operator action; tests and builds do not
mutate AWS, DNS, or the private navigation document.
