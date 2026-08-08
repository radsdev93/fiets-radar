# 🚲 fiets-radar 🌐

> **Note on the name:** “Fiets” is Dutch for bicycle. The name reflects the project's purpose of tracking bike availability across multiple bike-sharing networks.

## Overview

`fiets-radar` is an in-progress TypeScript service for tracking free-bike availability across the fixed list of 20 cities defined by the project specification.

The completed service will collect validated availability observations, schedule requests within the provider's runtime-reported global budget, persist results safely, calculate time-weighted hourly averages, deterministically replay recorded traces, and compare adaptive scheduling with a fixed-interval baseline.

## Current Status

### Implemented

- strict TypeScript and Jest project configuration;
- pure hourly aggregation function and its golden-vector coverage;
- no-average-versus-zero handling for uncovered hours;
- strict CityBikes timestamp parsing for the captured UTC forms, including the provider's `+00:00Z` quirk;
- runtime-validated CityBikes V2 response boundary with Zod;
- provider timestamp transformation through the strict CityBikes timestamp adapter;
- strict runtime parsing and consistency checks for CityBikes rate-limit headers;
- thin CityBikes V2 HTTP client with injected fetch, fail-closed budget validation, JSON decoding as untrusted data, and discriminated failure results;
- reproducible configuration for the 20 required cities and 30 selected network resources;
- evidence-backed network normalization for station-only, vehicle-only, and combined representations;
- source-time validity intervals that do not refresh stale provider state from HTTP fetch time;
- deterministic Bay Wheels filtering for the San Francisco slice;
- causal complete/incomplete city composition from cached network snapshots;
- interval-aware hourly aggregation with explicit per-observation expiry while preserving the original Golden Vector API;
- SQLite persistence for normalized network snapshots, complete city observations, and hourly results;
- idempotent persistence and normal close/reopen recovery using file-backed SQLite;
- provider-valid cached network selection that prefers source freshness over HTTP fetch recency;
- persistent global CityBikes request-budget controller with durable reservation-before-request accounting;
- runtime budget reconciliation from provider-reported post-request `remaining` values;
- conservative bootstrap, reset, exhaustion, and fail-closed handling, including hostile persisted-state validation;
- centralized adaptive scheduler with one global provider request in flight at a time;
- earliest-deadline-first network selection with deterministic tie-breaking and no per-city/per-network timers;
- rolling R5 city-observation policy targeting a complete observation every 240 seconds with a 300-second overdue threshold;
- run-local R2 fetch usefulness metrics for availability changes, freshness refreshes, redundant fetches, and failures;
- runtime budget-derived sustainable polling floor with explicit capacity-insufficient signaling;
- provider-freshness-aware scheduler classification so historical/older provider state is not mistaken for new availability;
- deadline pacing that prevents expiry-safety logic from polling earlier than the known sustainable budget floor.

### Provider reconnaissance and semantic analysis completed

- investigated 34 candidate network resources;
- verified V2 stations plus roaming vehicles with `?fields=stations,vehicles`;
- empirically characterized station and vehicle shapes;
- documented provider representation differences and stale-source cases;
- recorded semantic mapping and composition decisions in [`DECISIONS.md`](./DECISIONS.md).

### Not yet implemented

- production service loop / runtime orchestration around the scheduler;
- hard-kill (`SIGKILL`) recovery proof;
- trace recording, replay, and benchmarking;
- CLI or HTTP result exposure.

## Intended Architecture Boundaries

```text
Central scheduler + global budget
  → provider boundary
  → network normalization
  → city composition
  → persistence / aggregation

Fetch outcomes and observed state feed back into the scheduler.
```

The core provider-to-storage path, persistent request-budget guard, and centralized adaptive scheduling policy are implemented. Each scheduler step materializes due city observations from provider-valid cached state, selects at most one due network, reserves budget before the HTTP request, reconciles runtime rate-limit metadata, normalizes and persists successful history, classifies fetch usefulness, and advances that network's deadline. R5 is interpreted as a rolling five-minute requirement with a 240-second target; R2 tracks availability changes, freshness-only refreshes, redundant fetches, and failures. Polling cadence is derived from the provider's current remaining budget/reset window and never intentionally runs below the known sustainable pacing floor. The remaining major work is production orchestration, actual hard-kill recovery proof, deterministic trace/replay benchmarking, result exposure, the final impossible-pair proof, and submission packaging.

## Development Requirements

- Node.js 24 LTS
- npm

## Install

```bash
npm install
```

## Run Tests

```bash
npm test -- --runInBand
```

## Type Check

```bash
npx tsc --noEmit
```

## Documentation

- [`DECISIONS.md`](./DECISIONS.md): specification conflicts, interpretations, choices, and costs.
- [`AI-USAGE.md`](./AI-USAGE.md): implementation-assistant workflow, verification, and failures.
- [`docs/api-findings.md`](./docs/api-findings.md): measured CityBikes behavior and captured evidence.

Run instructions for the completed service, trace recorder, replay mode, and benchmark will be added as those components are implemented.
