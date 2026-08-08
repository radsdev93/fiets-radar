# Adaptive Scheduler Benchmark

This document describes the deterministic adaptive-versus-fixed comparison required by section 5 of the assignment.

> **Status:** methodology is implemented and tested. The final V2 raw trace is still being captured at the time of this revision. The result table below must be filled from the completed trace; no benchmark result is claimed before that run exists.

## Purpose

The benchmark answers one question:

> Under the same recorded provider behavior and the same request budget, does the adaptive scheduler make better use of requests than a dumb fixed-interval policy?

The adaptive strategy is not treated as better by definition. Losses are reported as losses.

## Final Trace

The final benchmark trace uses the V2 raw format required by the brief.

Each real fetch stores:

```text
networkId
capturedAt
HTTP status
response headers
exact response body text
```

The trace itself records:

```text
version
provider
recordedAt
maxStalenessSeconds
selectedCities
networkIds
rounds
```

All trace input is runtime-validated before replay.

### Selected cities

The dense comparison trace uses:

```text
Barcelona
Madrid
Göteborg
```

which resolve to five configured resources:

```text
ambici-amb
bicing
bicimad
e-cargobike-goteborg
styr-staell-goeteborg
```

The earlier all-resource diagnostic capture showed these resources producing current provider-backed state and a useful mix of changing and comparatively flat bike counts.

Known persistently expired resources from that diagnostic run were intentionally not selected for the scheduler-quality benchmark: a provider that cannot produce usable current state mostly measures provider failure, not the difference between adaptive and fixed request allocation.

### Recording command

```bash
npm run trace:record -- \
  --output traces/citybikes-benchmark-v2.json \
  --rounds 60 \
  --interval-seconds 120 \
  --city Barcelona \
  --city Madrid \
  --city Göteborg
```

The recorder still obeys runtime provider budget authorization. `60 × 5 = 300` is the requested maximum number of fetches, not an assumed provider allowance.

## Causal Replay

One trace round is a sequential sweep, so responses inside the round have different `capturedAt` values.

A complete round becomes visible only at:

```text
roundAvailableAt =
  max(roundAt, every response.capturedAt)
```

This prevents a response captured later in a sweep from being read from the future.

When replay serves one recorded response, it reconstructs a synthetic HTTP `Response`. That response is passed through the production CityBikes client:

```text
recorded raw response
→ CityBikes client
→ rate-limit parser
→ JSON as unknown
→ Zod runtime validation
→ network normalizer
```

Replay therefore does not trust the recorded body through a TypeScript assertion.

## Strategies

Both runs instantiate the real `AdaptiveScheduler`.

### Adaptive

The production heuristic reacts to:

```text
availability change
freshness-only refresh
redundant fetch
failure
```

while respecting the same persistent request-budget controller and runtime sustainable pacing floor used by the service.

### Fixed baseline

Fixed mode uses a constant per-network interval and does not adapt that interval from fetch usefulness.

For an experiment with:

```text
N = configured network count
D = benchmark duration in milliseconds
B = explicit benchmark request budget
```

the fixed interval is:

```text
ceil(N × D / B)
```

Both strategies still pass every request through the same request-budget controller.

## Same Virtual Budget

The real recorder's decreasing provider headers are evidence from the recording process; they are **not** reused as the policy budget for one strategy.

Instead both strategies receive the same explicit benchmark budget over the same virtual time window.

For simulated request number `k`:

```text
remaining = requestBudget - k
```

with one deterministic reset boundary at the end of the experiment.

This isolates scheduler policy rather than rewarding the strategy whose request pattern happens to resemble the recorder.

## Metrics

### Requests used

Exact scheduler fetch attempts.

Lower is better, provided the other quality metrics are considered.

### Mean / p95 staleness

Staleness is provider-source age, not HTTP-receipt age:

```text
evaluationTime - city.oldestSourceAt
```

It is sampled only at regular deterministic evaluation ticks after scheduler work for that tick.

The default evaluation tick is 30 seconds.

p95 uses the nearest-rank definition.

### Redundant fetch ratio

```text
redundantFetches / totalFetches
```

A same-count response with newer provider-backed freshness is a freshness refresh, not redundant.

Failures are tracked separately rather than being counted as redundant.

### R5 window compliance

R5 is interpreted as rolling five-minute windows.

For run interval `[start, end)`, complete rolling windows have ending instants in:

```text
[start + 300s, end)
```

An observation at `t` satisfies window-ending instants in:

```text
[t, t + 300s)
```

Those intervals are clipped to the valid domain, unioned per city, and divided by the total possible complete-window duration across all selected cities.

A run shorter than five minutes reports zero compliance because it contains no complete five-minute benchmark domain under this implementation.

### Mean absolute error

The required MAE compares **stored hourly averages**, not instantaneous bike values.

Trace ground truth is generated through the same semantic path:

```text
raw recorded response
→ client validation
→ normalization
→ city composition
→ persisted city observations
→ explicit-validity hourly aggregation
```

Only completed UTC clock hours are considered.

For city-hour pairs where both strategy and ground truth contain a numeric average:

```text
absoluteError =
  abs(strategyAverage - groundTruthAverage)

MAE =
  mean(all comparable absolute errors)
```

A missing average is never converted to zero.

## Result

**Pending completion of the final V2 trace.**

| Metric | Adaptive | Fixed | Better |
| --- | ---: | ---: | --- |
| requests used | pending | pending | pending |
| mean staleness (s) | pending | pending | pending |
| p95 staleness (s) | pending | pending | pending |
| redundant fetch ratio | pending | pending | pending |
| R5 window compliance | pending | pending | pending |
| hourly-average MAE (bikes) | pending | pending | pending |

### Trace metadata

| Field | Value |
| --- | --- |
| selected cities | Barcelona, Madrid, Göteborg |
| network resources | 5 |
| trace rounds | pending |
| complete trace rounds | pending |
| trace duration | pending |
| raw trace file size | pending |
| benchmark request budget | pending |
| fixed interval | pending |
| evaluation tick | 30 seconds |

## Interpretation

Pending the measured comparison.

This section must state both:

- the metrics the adaptive scheduler wins;
- the metrics it loses or ties, and why those outcomes are plausible.

No parameter will be changed merely to manufacture two wins. If tuning is performed after the first real comparison, it will use the same recorded trace so the before/after comparison remains reproducible.

## Reproduce

After the trace has been committed:

```bash
npm install
npm test -- --runInBand

npm run benchmark -- \
  --trace traces/citybikes-benchmark-v2.json \
  --budget <final-budget>
```

The exact final budget and expected output will replace the placeholder above once the real trace completes.

## Known Experimental Limitations

- The trace covers a handful of cities and roughly a couple of hours, not every time-of-day pattern.
- The raw trace is ground truth for the experiment, not a claim of omniscient physical bike availability.
- A complete trace round is exposed only when the whole sequential sweep finishes, which is intentionally conservative.
- The benchmark compares the currently implemented heuristic, not an optimized control algorithm.
