# 🚲 fiets-radar 🌐

> **Note on the name:** “Fiets” is Dutch for bicycle. The name reflects the project's purpose of tracking bike availability across multiple bike-sharing networks.

## Overview

`fiets-radar` is a TypeScript service that tracks free-bike availability for the fixed list of 20 cities in the assignment, persists provider-backed observations, and stores time-weighted hourly averages.

The implementation is deliberately split into independently testable boundaries:

- runtime validation of untrusted CityBikes responses;
- evidence-backed network normalization;
- causal multi-network city composition;
- explicit-validity hourly aggregation;
- durable SQLite persistence and request-budget state;
- one centralized adaptive scheduler;
- crash-safe hourly finalization;
- raw trace recording and deterministic offline replay;
- adaptive-versus-fixed benchmarking;
- CLI exposure of stored hourly results.

The runtime implementation is complete. The final two-hour V2 benchmark trace and comparison results are still being collected at the time of this revision.

## Architecture

```text
                         ┌──────────────────────┐
                         │    ServiceRuntime    │
                         │ one central tick loop│
                         └──────────┬───────────┘
                                    │
                     ┌──────────────┴──────────────┐
                     │                             │
                     ▼                             ▼
             Hourly finalizer              AdaptiveScheduler
                     │                             │
                     │                     RequestBudgetController
                     │                             │
                     │                       CityBikes client
                     │                             │
                     │                     runtime validation
                     │                             │
                     │                    network normalization
                     │                             │
                     └──────────────┬──────────────┘
                                    ▼
                              SQLite store
                         snapshots / observations
                         hourly results / budget
                                    │
                     ┌──────────────┴──────────────┐
                     ▼                             ▼
               results CLI                 trace / replay /
                                            benchmark
```

Only one CityBikes request is allowed in flight globally. The scheduler owns request selection and timing; the request-budget controller authorizes each provider request before it is sent.

## Implemented Behavior

- strict TypeScript configuration with no `any`;
- Node.js 24 LTS target;
- Jest tests with no real network access;
- injected/fake time for deterministic scheduling tests;
- runtime-validated CityBikes V2 responses using Zod;
- strict parsing of the provider's observed timestamp forms, including the `+00:00Z` form;
- runtime parsing and consistency checks for rate-limit headers;
- 20 required cities represented exactly and mapped reproducibly to 30 selected CityBikes resources;
- station-only, vehicle-only, and combined network normalization;
- bicycle/ebike inclusion and scooter exclusion based on captured provider evidence;
- provider source timestamps kept separate from HTTP receipt time;
- causal city composition that never uses a response before it was fetched;
- incomplete multi-network city states never stored as official city observations;
- Golden Vector hourly aggregation with uncovered seconds excluded;
- `averageFreeBikes: null` when no valid data covers an hour;
- SQLite persistence using WAL + `synchronous = FULL` for file-backed databases;
- idempotent network/city observation writes and upserted hourly results;
- persistent global request-budget state with reserve-before-request accounting;
- fail-closed handling for malformed persisted budget state and unusable runtime rate metadata;
- centralized earliest-deadline-first scheduling with deterministic tie-breaking;
- rolling five-minute R5 interpretation with a 240-second city-observation target;
- adaptive cadence based on availability changes, source-freshness refreshes, redundancy, and failures;
- runtime sustainable pacing floor derived from current provider `remaining` and reset time;
- fixed polling mode used only as the benchmark baseline;
- raw V2 trace recording with fetch time, HTTP status, headers, and exact response body;
- deterministic raw replay through the real CityBikes validation boundary;
- same-budget adaptive-versus-fixed benchmark infrastructure;
- process-level SIGKILL/restart recovery test using a real file-backed SQLite database;
- JSON CLI for stored hourly results.

## Install

```bash
npm install
```

The repository pins Node.js `24.14.1` in `.nvmrc`.

## Run Tests

```bash
npm test -- --runInBand
```

## Type Check

```bash
npx tsc --noEmit
```

## Run the Service

Use a file-backed SQLite database:

```bash
npm run service -- --db fiets-radar.sqlite
```

The service uses all 20 configured cities and one centralized runtime loop.

On normal `SIGINT` or `SIGTERM`, the SQLite store is closed before exit. `SIGKILL` cannot be handled by a process; crash safety instead comes from durable committed observations and deterministic recomputation after restart.

## Read Stored Hourly Results

```bash
npm run results -- --db fiets-radar.sqlite
```

The command prints deterministic JSON records such as:

```json
[
  {
    "city": "Madrid",
    "countryCode": "ES",
    "hourStart": "2026-08-08T12:00:00.000Z",
    "coveredSeconds": 3600,
    "averageFreeBikes": 5032.14,
    "coverage": 1,
    "partial": false
  }
]
```

An uncovered hour preserves:

```json
"averageFreeBikes": null
```

rather than reporting a measured zero.

## Record a Real Benchmark Trace

The final benchmark recorder supports a repeatable city subset. The current benchmark capture uses Barcelona, Madrid, and Göteborg:

```bash
npm run trace:record -- \
  --output traces/citybikes-benchmark-v2.json \
  --rounds 60 \
  --interval-seconds 120 \
  --city Barcelona \
  --city Madrid \
  --city Göteborg
```

The recorder stores raw evidence for every fetch:

- capture instant;
- HTTP status;
- response headers;
- exact response body.

It uses the same provider budget boundary as the service and stops rather than knowingly continuing without authorization.

## Run the Comparison

After a V2 trace has been recorded:

```bash
npm run benchmark -- \
  --trace traces/citybikes-benchmark-v2.json \
  --budget <request-budget-for-the-experiment>
```

The adaptive and fixed strategies receive the same trace, virtual time range, configured city subset, and explicit simulated request budget.

The benchmark reports:

- requests used;
- mean and p95 provider-source staleness;
- redundant-fetch ratio;
- rolling R5 window compliance;
- mean absolute error of stored hourly averages against trace-derived ground truth.

The final measured comparison and exact reproduction command belong in [`docs/benchmark.md`](./docs/benchmark.md).

## Important Interpretation Choices

### Provider freshness is not HTTP freshness

`fetchedAt` records when this service received a response. It never renews the provider's source timestamps.

A successfully fetched historical response can therefore be persisted as evidence while still being unusable as current state.

### Multi-network cities are composed causally

A network snapshot may contribute to a city at `asOf` only when:

```text
fetchedAt <= asOf
validFrom <= asOf < validUntil
```

Every configured component is required for an official complete city observation.

For a complete city:

```text
observedAt = asOf
freeBikes  = sum(component freeBikes)
validUntil = earliest component validUntil
```

Composition never grants a fresh full 900-second window to older component data.

### R5 uses rolling windows

R5 is interpreted as a rolling five-minute requirement, not clock-aligned `00/05/10/...` buckets.

The scheduler targets a complete city observation every 240 seconds, leaving headroom before the 300-second threshold. A city-level observation may be materialized at `asOf` from component measurements fetched earlier only while every required component remains causally available and provider-valid at `asOf`; local recomposition never extends a component's expiry.

Actual R5 compliance is measured by the benchmark rather than inferred from the target or from provider request frequency.

### “Nothing new” is semantic

A fetch can be:

- an availability change;
- a source-freshness refresh;
- redundant;
- a failure.

An unchanged bike count with meaningfully newer provider timestamps is useful freshness information. A later HTTP fetch carrying the same old provider state is not.

The strict literal reading of R2 (“never spend a request on data that has not changed”) cannot be guaranteed together with R1's runtime-driven adaptation on a pull-only API: before probing, the scheduler cannot know whether a previously flat resource is still flat or has changed. The implemented resolution is to minimize, learn from, and report redundant fetches rather than claim they can be eliminated with certainty. The proof and cost are recorded in [`DECISIONS.md`](./DECISIONS.md).

## Crash Recovery

Hourly results are derived state. Durable city observations are the aggregation source facts.

The service does **not** persist a mutable `weightedSumSoFar` or `coveredSecondsSoFar`. After a crash, the hour is recomputed from the observations that were durably committed before the crash plus observations written after restart.

The process-level recovery test:

1. writes and finalizes a completed hour;
2. writes part of the next hour;
3. sends an explicit ready signal;
4. receives `SIGKILL`;
5. restarts against the same SQLite file;
6. deliberately replays one identical pre-kill observation;
7. adds the remaining observations;
8. finalizes the recovered hour.

The duplicate observation is ignored by the idempotent observation key, so the recovered aggregate neither loses nor double-counts committed coverage.

## Current Limitations

- The 20-city network mapping is evidence-backed but static; provider fleet representations can change.
- Some captured CityBikes resources return provider timestamps that are already stale by much more than `maxStaleness`. The service refuses to turn those responses into fresh observations.
- Adaptive interval state is run-local and is rebuilt after restart. Durable correctness state is persisted.
- A restart automatically finalizes the immediately preceding completed hour. A persistent finalization cursor for arbitrary multi-hour downtime is not implemented.
- The first request needed to discover an unknown runtime budget is an unavoidable bootstrap edge. After discovery, request authorization is fail-closed.
- The adaptive heuristic is intentionally simple and remains the least-trusted policy area until the final real-trace benchmark is complete.
- The required specification conflict is resolved in `DECISIONS.md` as R1 versus the strict literal reading of R2. The final benchmark result is still being collected at the time of this revision.

## Documentation

- [`DECISIONS.md`](./DECISIONS.md): specification conflicts, interpretations, architectural decisions, and costs.
- [`AI-USAGE.md`](./AI-USAGE.md): assistant workflow, failures, rejected suggestions, and confidence assessment.
- [`docs/api-findings.md`](./docs/api-findings.md): measured CityBikes behavior and captured evidence.
- [`docs/benchmark.md`](./docs/benchmark.md): deterministic comparison methodology and final measured results.

## What I Would Do Next With More Time

- persist an hourly-finalization cursor so arbitrary multi-hour downtime can be caught up automatically;
- add production observability for provider freshness, request-budget state, city coverage, and scheduler decisions;
- periodically rediscover/revalidate provider representation and city mapping assumptions;
- run longer traces across different times of day before tuning the adaptive heuristic further;
- add a controlled operational recovery path for an unknown bootstrap budget state.
