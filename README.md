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
- deterministic Bay Wheels filtering for the San Francisco slice.

### Provider reconnaissance and semantic analysis completed

- investigated 34 candidate network resources;
- verified V2 stations plus roaming vehicles with `?fields=stations,vehicles`;
- empirically characterized station and vehicle shapes;
- documented provider representation differences and stale-source cases;
- recorded semantic mapping and composition decisions in [`DECISIONS.md`](./DECISIONS.md).

### Not yet implemented

- complete/incomplete city composition;
- scheduler and budget controller;
- persistence and recovery;
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

The aggregation logic, core CityBikes provider boundary, reproducible city/network configuration, and network normalization are implemented. The normalizer applies explicit representation modes, bicycle-kind semantics, geographic filtering where configured, and conservative source-time validity intervals. City composition, request-budget control, adaptive scheduling, persistence/recovery, deterministic replay/benchmarking, and result exposure are not yet implemented.

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
