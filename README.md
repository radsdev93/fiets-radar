# 🚲 fiets-radar 🌐

> **Note on the name:** “Fiets” is Dutch for bicycle. The name reflects the project's purpose of tracking bike availability across multiple bike-sharing networks.

## Overview

`fiets-radar` is a TypeScript service that tracks free-bike availability for the fixed list of 20 cities required by the assignment.

The service:

- validates CityBikes V2 responses at runtime;
- normalizes provider state using provider/source timestamps rather than HTTP receipt time;
- composes complete city observations from one or more configured network resources;
- schedules polling centrally under the provider's runtime-reported global request budget;
- persists normalized snapshots, city observations, budget state, and hourly results in SQLite;
- calculates time-weighted hourly free-bike averages with explicit validity intervals;
- survives process termination by recomputing in-flight hours from durable observations;
- records raw real-provider traces and deterministically replays them with a virtual clock;
- compares the adaptive scheduler against a fixed-interval baseline under the same recorded evidence and request budget.

## Requirements

- Node.js 24 LTS
- npm

The repository contains `.nvmrc` for the intended runtime.

## Install

```bash
npm install
```

## Test

```bash
npm test -- --runInBand
```

The test suite uses Jest, injected/fake time for deterministic scheduler and benchmark behavior, and no real provider network access in unit tests.

## Type Check

```bash
npx tsc --noEmit
```

## Run the Service

The service stores state in a file-backed SQLite database:

```bash
npm run service -- --db fiets-radar.sqlite
```

The process runs the centralized scheduler loop and finalizes completed UTC hours.

Stop it with `Ctrl+C` / `SIGINT` or `SIGTERM`.

## Read Stored Hourly Results

```bash
npm run results -- --db fiets-radar.sqlite
```

Output is deterministic JSON containing:

```text
city
countryCode
hourStart
coveredSeconds
averageFreeBikes
coverage
partial
```

`averageFreeBikes` is `null` when the hour has no covered seconds; missing coverage is never converted to zero availability.

## Record a Raw Provider Trace

Example used for the final benchmark:

```bash
npm run trace:record -- \
  --output traces/citybikes-benchmark-v2.json \
  --rounds 60 \
  --interval-seconds 120 \
  --city Barcelona \
  --city Madrid \
  --city Göteborg
```

The recorder stores each raw HTTP response with:

- fetch/capture instant;
- HTTP status;
- response headers;
- exact response body text.

The final trace contains 60 complete rounds, five selected network resources, and 300 successful real provider requests.

## Replay Benchmark

```bash
npm run benchmark -- \
  --trace traces/citybikes-benchmark-v2.json \
  --budget 300
```

Both strategies replay the same raw trace causally with the same virtual request budget.

### Final submitted adaptive result

| Metric | Adaptive | Fixed | Better |
| --- | ---: | ---: | --- |
| Requests | **255** | 295 | **Adaptive** |
| Mean staleness | 179.756 s | **108.275 s** | **Fixed** |
| p95 staleness | 292.352 s | **188.385 s** | **Fixed** |
| Redundant ratio | 0.117647 | **0.050847** | **Fixed** |
| R5 compliance | 1.000000 | 1.000000 | Tie |
| Hourly-average MAE | 3.486667 | **1.850000** | **Fixed** |

The adaptive scheduler uses **13.6% fewer requests** while maintaining full measured R5 compliance, but the fixed baseline is better on staleness, redundant ratio, and hourly-average error on this trace. This is a measured trade-off on this workload, not a claim that adaptive scheduling is impossible in general.

Two later evidence-driven tuning experiments were also measured against the same trace and budget. Both used fewer requests but degraded quality further, so they were rejected and reverted. Those rejected experiments are intentionally documented in [`docs/benchmark.md`](./docs/benchmark.md) and remain visible in Git history.

## Architecture

```text
ServiceRuntime
    |
    v
AdaptiveScheduler
    |
    +--> RequestBudgetController
    |        |
    |        v
    |     SQLite
    |
    v
CityBikes HTTP client
    |
    v
runtime validation
    |
    v
network normalization
    |
    v
durable network snapshots
    |
    v
city composition
    |
    v
durable city observations
    |
    v
hourly finalization / aggregation
    |
    v
durable hourly results
```

### Provider boundary

External JSON is treated as untrusted data and validated at runtime. The implementation does not use a TypeScript assertion such as `await response.json() as NetworkResponse`.

### Freshness and validity

Provider/source timestamps define freshness. Re-fetching old provider state does not renew validity.

Normalized network snapshots retain:

```text
oldestSourceAt
newestSourceAt
fetchedAt
validFrom
validUntil
```

For a composed city observation, every required component must be causal and provider-valid at the composition instant.

### Hourly aggregation

A city observation contributes only while valid. The aggregator:

- honors pre-hour observations that remain valid into the hour;
- clips intervals at hour boundaries;
- applies supersession by newer observations;
- excludes uncovered seconds from the average denominator;
- reports no average (`null`) when coverage is zero;
- calculates coverage as `coveredSeconds / 3600`;
- marks results partial below 75% coverage.

### Centralized scheduler and global budget

There is one centralized scheduler and at most one provider request in flight globally.

Before an HTTP request is sent, the request-budget controller durably reserves the request. Provider-reported post-request remaining values are then reconciled back into persistent budget state.

The scheduler uses earliest-deadline-first selection with stable configuration-order tie-breaking. It has no timer per city or per network.

### R5 interpretation

R5 is treated as a rolling five-minute requirement, not aligned `00/05/10/...` buckets.

The scheduler targets complete city observations every 240 seconds, with a 300-second rolling overdue threshold. A city observation may be recomposed from cached network snapshots without spending a provider request when every required component remains causal and provider-valid.

### R2 interpretation

Fetches are classified as:

```text
availability-change
freshness-refresh
redundant
failure
```

A same-count response whose provider-backed freshness advances is useful and is therefore not classified as redundant.

Because CityBikes exposes no verified free push/change-notification mechanism or conditional validator for these resources, the implementation cannot know before a probe whether the remote value changed. The operational interpretation of R2 is therefore to minimize and report semantically redundant fetches rather than claim zero redundancy.

## Persistence and Crash Recovery

SQLite stores durable facts rather than a mutable in-progress weighted sum.

Hourly results are deterministically recomputed from persisted city observations and upserted. The crash-recovery test starts a real child process with a real file-backed SQLite database, kills it with `SIGKILL` after a committed-state checkpoint, restarts against the same database, replays an observation idempotently, and verifies both the completed and resumed hour.

A known limitation is that scheduler heuristic state itself is run-local. Durable correctness relies on persisted observations, results, snapshots, and request-budget state.

## Important Specification Decisions

The assignment intentionally contains conflicting and underspecified requirements. The full proofs and choices are in [`DECISIONS.md`](./DECISIONS.md).

The principal conflict is R1 versus a strict literal interpretation of R2:

- before making a future pull request, the client cannot distinguish a world where the provider is unchanged from one where it changed;
- probing can therefore return unchanged data;
- never probing would prevent runtime adaptation to a later change.

The implementation preserves R1 and interprets R2 operationally as minimizing and reporting redundant fetches.

A material underspecification is also documented around the meaning of observation instant `t` when a city total is composed from independently timestamped provider records and multiple HTTP responses.

## Provider Findings

Captured CityBikes behavior and raw-evidence conclusions are documented in:

- [`docs/api-findings.md`](./docs/api-findings.md)
- [`docs/benchmark.md`](./docs/benchmark.md)

The recorded provider evidence includes runtime rate-limit headers, representation differences, stale resources, and the non-standard timestamp form ending in `+00:00Z`.

## AI Usage

AI usage, verification, rejected suggestions, failures, and human review are documented in [`AI-USAGE.md`](./AI-USAGE.md).

The project intentionally keeps the development trail and rejected scheduler experiments visible rather than rewriting history after measurement.

## Known Limitations

- The benchmark trace covers three cities and roughly two hours, not every city or time-of-day pattern.
- The benchmark target of at least two adaptive metric wins was not met on this trace: adaptive won request count, tied R5 compliance, and fixed won the four measured quality metrics.
- Some real CityBikes resources observed during reconnaissance were already stale beyond configured validity.
- Future provider clock-skew handling remains conservative and is not presented as fully solved.
- A fresh service restart after a long multi-hour downtime does not reconstruct every missed historical finalization cursor; completed durable observations/results remain safe, but arbitrary downtime backfill is outside the implemented recovery claim.

## Documentation

- [`DECISIONS.md`](./DECISIONS.md) — specification conflicts, proofs, interpretations, trade-offs, and costs.
- [`AI-USAGE.md`](./AI-USAGE.md) — AI workflow, verification, failures, and rejected suggestions.
- [`docs/api-findings.md`](./docs/api-findings.md) — measured CityBikes API behavior.
- [`docs/benchmark.md`](./docs/benchmark.md) — trace format, replay methodology, metrics, results, rejected tuning experiments, and reproduction instructions.
