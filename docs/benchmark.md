# Adaptive Scheduler Benchmark

This document describes the deterministic adaptive-versus-fixed comparison required by section 5 of the assignment.

> **Status:** the final V2 raw trace has been captured successfully and the comparison is complete. The original adaptive heuristic and two evidence-driven tuning experiments were replayed against the **same trace and same request budget**. Neither tuning experiment improved the overall comparison, so both were rejected and the original adaptive heuristic was restored for the final submission. The rejected experiments remain in Git history and are documented below.

## Purpose

The benchmark answers one question:

> Under the same recorded provider behavior and the same request budget, does the adaptive scheduler make better use of requests than a dumb fixed-interval policy?

The adaptive strategy is not treated as better by definition. Losses are reported as losses.

The first real-trace result is intentionally kept even though it does not meet the brief's target that adaptive should beat the baseline on at least two metrics. The brief also explicitly asks losses to be reported rather than hidden. This result is therefore treated as evidence about the original heuristic and the reason for any later policy correction, not as something to tune away.

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

Recorder output:

```text
Completed rounds: 60
Incomplete rounds: 0
Provider requests: 300
Output: traces/citybikes-benchmark-v2.json
```

The recorder still obeyed runtime provider budget authorization. `60 × 5 = 300` was the requested maximum number of fetches, not a hardcoded assumption about the provider allowance.

### Captured trace facts

| Field | Value |
| --- | --- |
| trace version | 2 |
| selected cities | Barcelona, Madrid, Göteborg |
| network resources | 5 |
| trace rounds | 60 |
| complete trace rounds | 60 |
| incomplete trace rounds | 0 |
| provider requests | 300 |
| raw trace file size | 30,880,313 bytes (29.45 MiB) |
| recordedAt | 2026-08-08T21:11:38.944Z |
| first complete-round availability | 2026-08-08T23:11:56.815Z |
| last complete-round availability | 2026-08-08T23:11:59.016Z |
| benchmark duration | 7217.866 seconds (~2h 00m 18s) |
| max staleness | 900 seconds |

The capture completed all requested rounds with no incomplete round reported by the recorder.

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

The original production heuristic used for the first real-trace run reacts to:

```text
availability change
freshness-only refresh
redundant fetch
failure
```

while respecting the same persistent request-budget controller and runtime sustainable pacing floor used by the service.

The initial comparison below reflects that original heuristic before any evidence-driven tuning.

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

For the final trace and a budget of `300`, the fixed interval is:

```text
120.298 seconds
```

That is close to the recording cadence, which avoids giving the baseline an unrealistically fast polling frequency relative to the density of the real trace.

## Same Virtual Budget

The real recorder's decreasing provider headers are evidence from the recording process; they are **not** reused as the policy budget for one strategy.

Instead both strategies receive the same explicit benchmark budget over the same virtual time window.

For simulated request number `k`:

```text
remaining = requestBudget - k
```

with one deterministic reset boundary at the end of the experiment.

This isolates scheduler policy rather than rewarding the strategy whose request pattern happens to resemble the recorder.

The first real-trace comparison uses:

```text
request budget = 300
```

That budget was chosen before observing the benchmark result. It corresponds to the 300 real fetches captured in the final trace and gives the fixed baseline a cadence close to the approximately two-minute trace density.

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

## Initial Real-Trace Result — Original Adaptive Heuristic

The first comparison was run immediately after the final trace completed, before changing the adaptive policy:

```bash
npm run benchmark -- \
  --trace traces/citybikes-benchmark-v2.json \
  --budget 300
```

Result:

| Metric | Adaptive | Fixed | Better |
| --- | ---: | ---: | --- |
| requests used | **255** | 295 | **Adaptive** |
| mean staleness (s) | 179.756 | **108.275** | **Fixed** |
| p95 staleness (s) | 292.352 | **188.385** | **Fixed** |
| redundant fetch ratio | 0.117647 | **0.050847** | **Fixed** |
| R5 window compliance | 1.000000 | 1.000000 | Tie |
| hourly-average MAE (bikes) | 3.486667 | **1.850000** | **Fixed** |

Additional output:

| Field | Adaptive | Fixed |
| --- | ---: | ---: |
| staleness sample count | 723 | 723 |
| hourly MAE sample count | 6 | 6 |

The benchmark classified the outcome as:

```text
adaptive wins:
  requests

fixed wins:
  meanStalenessSeconds
  p95StalenessSeconds
  redundantRatio
  maeFreeBikes

ties:
  r5Compliance
```

### What the initial result shows

The original adaptive policy used:

```text
255 / 295 = 86.44%
```

as many requests as the fixed baseline, saving:

```text
40 requests
≈ 13.56%
```

while still achieving perfect rolling R5 compliance.

That is a genuine adaptive benefit: the scheduler reduced upstream request consumption without sacrificing the five-minute observation requirement on this trace.

However, the cost was significant:

- mean provider-source staleness was materially higher;
- p95 staleness was materially higher;
- hourly-average MAE was higher;
- redundant-fetch ratio was unexpectedly higher rather than lower.

The result therefore does **not** support a claim that the original adaptive heuristic is better overall.

It wins one metric, ties one, and loses four. It also does **not** establish that adaptive scheduling is impossible in general; it establishes only what happened for this recorded workload, this benchmark methodology, and the policies actually measured.

## Evidence-Driven Interpretation of the Initial Loss

The first real-trace run exposed a policy weakness that unit tests did not show clearly.

The scheduler distinguishes semantic fetch outcomes:

```text
availability change
freshness-only refresh
redundant
failure
```

That classification is useful for R2 accounting, but the original adaptive heuristic also used it directly as its volatility signal.

A response such as:

```text
100 bikes @ provider source 12:00
100 bikes @ provider source 12:02
100 bikes @ provider source 12:04
```

is correctly classified as useful freshness evidence rather than redundant data.

But repeated same-count freshness refreshes also provide a different kind of information:

```text
availability is currently flat
```

The original policy did not progressively back off from that evidence in the same way it reacts to truly redundant responses.

This means two separate questions were partially conflated:

```text
Was this fetch semantically useful?       ← R2 accounting
How volatile does this network appear?    ← R1 adaptation
```

They are related, but they are not identical.

The initial policy also began unseen adaptive resources above the sustainable budget-neutral cadence rather than first observing them at that cadence and then learning whether to back off.

The trace contains both relatively flat and frequently changing resources, so this distinction matters in the measured result rather than only in a synthetic test.

## Tuning Policy

The initial result is preserved and will not be overwritten.

Any scheduler correction after this point must follow these rules:

- use the exact same raw V2 trace;
- keep the benchmark budget at `300`;
- keep the fixed baseline unchanged;
- keep the metric implementations unchanged;
- change only scheduler policy justified by the observed weakness;
- rerun the full test suite and type check;
- report the second benchmark even if it still loses;
- do not change parameters merely to manufacture two adaptive wins.

This keeps the before/after comparison reproducible.

## Post-Tuning Attempt 1 — Freshness Backoff

After the initial real-trace loss, the adaptive policy was changed manually in two deliberately small ways:

```text
unknown network
→ start at the sustainable neutral cadence

same availability + newer provider freshness
→ keep the fetch classified as freshness-refresh
→ modestly back off the per-network interval by 1.25×
```

The existing behavior for availability changes, redundant fetches, failures, budget safety, expiry safety, R5 materialization, and the fixed baseline was left unchanged.

The intent was to separate two questions that the original heuristic partially conflated:

```text
Was this fetch semantically useful?
How volatile does this network appear?
```

A same-count response with newer provider freshness remains useful for R2 accounting, while repeated same-count fresh responses provide evidence that availability is currently flat.

The implementation and focused unit test were committed before seeing the next benchmark result. The same command was then rerun:

```bash
npm run benchmark -- \
  --trace traces/citybikes-benchmark-v2.json \
  --budget 300
```

Result:

| Metric | Adaptive | Fixed | Better |
| --- | ---: | ---: | --- |
| requests used | **216** | 295 | **Adaptive** |
| mean staleness (s) | 317.121 | **108.275** | **Fixed** |
| p95 staleness (s) | 746.825 | **188.385** | **Fixed** |
| redundant fetch ratio | 0.194444 | **0.050847** | **Fixed** |
| R5 window compliance | 1.000000 | 1.000000 | Tie |
| hourly-average MAE (bikes) | 4.173333 | **1.850000** | **Fixed** |

Additional output:

| Field | Adaptive | Fixed |
| --- | ---: | ---: |
| staleness sample count | 723 | 723 |
| hourly MAE sample count | 6 | 6 |

The benchmark again classified the result as:

```text
adaptive wins:
  requests

fixed wins:
  meanStalenessSeconds
  p95StalenessSeconds
  redundantRatio
  maeFreeBikes

ties:
  r5Compliance
```

### Comparison with the original adaptive heuristic

| Metric | Original adaptive | Attempt 1 | Direction |
| --- | ---: | ---: | --- |
| requests used | 255 | **216** | fewer requests |
| mean staleness (s) | 179.756 | **317.121** | worse |
| p95 staleness (s) | 292.352 | **746.825** | much worse |
| redundant fetch ratio | 0.117647 | **0.194444** | worse |
| R5 window compliance | 1.000000 | 1.000000 | unchanged |
| hourly-average MAE (bikes) | 3.486667 | **4.173333** | worse |

Attempt 1 reduced adaptive requests from `255` to `216`, a further reduction of `39` requests. Relative to the fixed baseline, it used `79` fewer requests:

```text
216 / 295 ≈ 73.22%
```

or about `26.78%` fewer requests.

That additional saving did not translate into better allocation quality. Mean staleness, p95 staleness, redundant ratio, and hourly-average MAE all became worse.

### Interpretation of Attempt 1

This result rejects the simple hypothesis that stronger backing off from flat availability is sufficient.

The experiment shows that the scheduler can reduce polling on resources that appear flat, but the saved capacity is not then used to observe changing resources more aggressively.

The reason is structural.

The current sustainable-floor calculation is:

```text
networkCount × remainingWindow / remainingBudget
```

and that value is then used as a lower bound for each individual network interval.

That calculation is appropriate for an equal-share cadence: it answers approximately how slowly every network must be polled if all resources receive the same share of the global request budget.

It does not answer how quickly the central scheduler may spend the next request globally.

As a result, the current adaptive policy can do:

```text
flat resource
→ poll less often
→ spend fewer requests
```

but it cannot fully do:

```text
flat resource
→ poll less often
→ reuse saved global capacity
→ poll a changing resource faster than the equal-share floor
```

The first tuning attempt therefore made the asymmetry more visible: it created more savings on flat resources, but the per-network floor prevented the scheduler from reallocating those savings effectively.

The high p95 staleness is also consistent with repeated 1.25× backoff pushing some flat-resource intervals toward the freshness ceiling. For multi-resource cities, an older flat component can increase city-level source staleness even while another component is changing and observed more frequently.

### Decision after Attempt 1

Attempt 1 is kept as a rejected experiment whose hypothesis was falsified by measurement.

The 1.25 multiplier will not be repeatedly adjusted against this trace merely to search for a winning constant.

The next design question is structural:

> How should global sustainable request pacing be separated from per-network adaptive cadence so that saved capacity can be reallocated to changing resources without violating the provider budget, freshness safety, R5 coverage, or fairness?

Any follow-up implementation must preserve the same trace, budget, fixed baseline, and metric definitions so that later results remain comparable.


## Post-Tuning Attempt 2 — Global Request Pacing

Attempt 1 showed that backing off flat resources saved requests but did not make those savings useful elsewhere. A second change therefore separated per-network adaptive cadence from aggregate request pacing.

The scheduler retained the same adaptive outcome policy from Attempt 1:

```text
availability change
→ shorten the network interval

freshness refresh with unchanged availability
→ modestly back off by 1.25×

redundant response
→ strong backoff

failure
→ strong backoff
```

The structural correction changed how those per-network requests were constrained:

```text
per-network schedule
→ decides when a resource would like to be polled

global sustainable pacing
→ remaining reset-window time / remaining requests

persistent RequestBudgetController
→ remains the hard authorization boundary
```

The equal-share sustainable cadence was no longer used as a hard minimum interval for every network while capacity was sufficient. A changing resource could therefore become due sooner than the equal-share cadence, while a separate global request gate paced aggregate request consumption. Initial discovery remained prompt so that previously unseen resources could establish their first state.

All unit tests, TypeScript checks, and diff checks passed before this benchmark was run.

The same trace and budget were then replayed again:

```bash
npm run benchmark -- \
  --trace traces/citybikes-benchmark-v2.json \
  --budget 300
```

Result:

| Metric | Adaptive | Fixed | Better |
| --- | ---: | ---: | --- |
| requests used | **246** | 295 | **Adaptive** |
| mean staleness (s) | 317.213 | **108.275** | **Fixed** |
| p95 staleness (s) | 796.160 | **188.385** | **Fixed** |
| redundant fetch ratio | 0.186992 | **0.050847** | **Fixed** |
| R5 window compliance | 1.000000 | 1.000000 | Tie |
| hourly-average MAE (bikes) | 4.105000 | **1.850000** | **Fixed** |

Additional output:

| Field | Adaptive | Fixed |
| --- | ---: | ---: |
| staleness sample count | 717 | 723 |
| hourly MAE sample count | 6 | 6 |

The benchmark classified the comparison as:

```text
adaptive wins:
  requests

fixed wins:
  meanStalenessSeconds
  p95StalenessSeconds
  redundantRatio
  maeFreeBikes

ties:
  r5Compliance
```

### Comparison across adaptive versions

| Metric | Original | Attempt 1 | Attempt 2 |
| --- | ---: | ---: | ---: |
| requests used | 255 | **216** | 246 |
| mean staleness (s) | **179.756** | 317.121 | 317.213 |
| p95 staleness (s) | **292.352** | 746.825 | 796.160 |
| redundant fetch ratio | **0.117647** | 0.194444 | 0.186992 |
| R5 window compliance | 1.000000 | 1.000000 | 1.000000 |
| hourly-average MAE (bikes) | **3.486667** | 4.173333 | 4.105000 |
| staleness sample count | 723 | 723 | 717 |

Attempt 2 did re-spend some capacity that Attempt 1 had left unused: requests rose from `216` to `246`. It also modestly improved the redundant ratio and hourly-average MAE relative to Attempt 1.

However, the quality result remained poor. Mean staleness was effectively unchanged from Attempt 1, p95 staleness became worse, and the adaptive run produced fewer staleness samples than either the original heuristic or the fixed baseline.

The structural pacing hypothesis therefore did not solve the benchmark weakness on this trace.

### Interpretation

The trace itself helps explain why the measured adaptive policies trade request savings against freshness on this workload.

The recorded provider evidence advances in discrete capture rounds roughly two minutes apart. The fixed baseline interval is approximately `120.298` seconds, already close to the trace resolution. Polling a changing resource substantially faster than the trace can therefore produce requests before a newer captured provider response exists, which increases semantic redundancy rather than necessarily improving measured freshness. This is a characteristic of the recorded workload, not a reason to discard the benchmark: the trace and budget were fixed before the result was known, so the measured comparison stands.

At the same time, backing off resources whose bike counts are flat reduces request usage but also lets their source timestamps become older. The benchmark's staleness metrics measure source freshness, not only whether the numerical bike count changed. A flat-but-fresh resource can therefore be useful for staleness quality even when its availability count is unchanged.

This creates a real trade-off on this trace:

```text
back off flat availability
→ fewer requests
→ older source evidence

poll changing resources faster
→ potentially more responsive
→ but requests can occur before the next captured provider update
→ more redundancy
```

The experiments show that simply changing multiplicative backoff or separating aggregate pacing from per-network deadlines is not enough to beat the fixed baseline on two metrics under this recorded workload. This is an empirical result, not a proof that no adaptive policy could do so.

### Decision after Attempt 2

No further constant tuning is justified against this same development trace.

Both tuning commits were reverted after measurement, restoring the original adaptive heuristic for the final submission.

The original adaptive heuristic remains the best of the measured adaptive variants on the quality metrics:

- lowest mean staleness;
- lowest p95 staleness;
- lowest redundant ratio;
- lowest hourly-average MAE;
- full R5 compliance;
- while still using fewer requests than the fixed baseline.

Attempts 1 and 2 are retained as evidence-driven experiments because they demonstrate why apparently reasonable control-loop changes were rejected after measurement rather than kept for architectural appearance.

For final submission, the original adaptive heuristic was restored rather than shipping either more complicated tuning that measured worse. The benchmark does **not** claim that the adaptive strategy beats the fixed baseline on two metrics. It reports the loss directly, as required by the challenge guidance.


## Final Submitted Scheduler State

The final submitted scheduler uses the original adaptive heuristic measured in the initial real-trace run:

```text
availability change → shorten cadence
freshness refresh   → keep current cadence
redundant            → back off
failure              → conservative backoff
```

It also retains the original runtime-derived equal-share sustainable floor and expiry-safety pacing.

The two later tuning experiments remain visible in repository history but were reverted because their measured quality was worse. The final benchmark result to associate with the submitted scheduler is therefore the **Initial Real-Trace Result — Original Adaptive Heuristic**, not either tuning attempt.

## Reproduce

Install dependencies and run tests:

```bash
npm install
npm test -- --runInBand
```

Run the recorded comparison:

```bash
npm run benchmark -- \
  --trace traces/citybikes-benchmark-v2.json \
  --budget 300
```

The initial original-heuristic output is:

```json
{
  "adaptive": {
    "requests": 255,
    "meanStalenessSeconds": 179.75615767634847,
    "p95StalenessSeconds": 292.352,
    "stalenessSampleCount": 723,
    "redundantRatio": 0.11764705882352941,
    "r5Compliance": 1,
    "maeFreeBikes": 3.486666666666565,
    "maeSampleCount": 6
  },
  "fixed": {
    "requests": 295,
    "meanStalenessSeconds": 108.27536514522801,
    "p95StalenessSeconds": 188.385,
    "stalenessSampleCount": 723,
    "redundantRatio": 0.05084745762711865,
    "r5Compliance": 1,
    "maeFreeBikes": 1.849999999999871,
    "maeSampleCount": 6
  },
  "comparison": {
    "adaptiveWins": ["requests"],
    "fixedWins": [
      "meanStalenessSeconds",
      "p95StalenessSeconds",
      "redundantRatio",
      "maeFreeBikes"
    ],
    "ties": ["r5Compliance"]
  },
  "metadata": {
    "selectedCities": ["Barcelona", "Madrid", "Göteborg"],
    "traceRounds": 60,
    "completeTraceRounds": 60,
    "durationSeconds": 7217.866,
    "requestBudget": 300,
    "fixedIntervalSeconds": 120.298,
    "evaluationTickSeconds": 30
  }
}
```

The first tuning attempt above was produced with this same command and the same budget. Any later scheduler change must continue to use this exact trace, budget, fixed baseline, and metric definitions so the comparison remains reproducible.

## Known Experimental Limitations

- The trace covers three cities and five network resources for roughly two hours, not every city or time-of-day pattern.
- The raw trace is ground truth for the experiment, not a claim of omniscient physical bike availability.
- A complete trace round is exposed only when the whole sequential sweep finishes, which is intentionally conservative.
- The trace resolution is approximately two minutes, so replay cannot provide genuinely new provider evidence at a finer real-world resolution than was recorded.
- The benchmark budget is a deterministic experiment budget, not a simulation of every hourly provider reset observed during the live capture.
- Only six comparable completed city-hour averages are available for MAE in this roughly two-hour, three-city trace.
- The first comparison measures the original heuristic, not an optimized control algorithm.
- The first and second tuning attempts are intentionally preserved even though neither improved the overall comparison.
- Because tuning is evidence-driven against this same trace, the trace is now development evidence rather than a completely untouched holdout set.
- The benchmark does not yet prove that the current scheduler reallocates saved request capacity optimally across resources; Attempt 1 provides evidence that the present per-network sustainable floor limits that behavior.
