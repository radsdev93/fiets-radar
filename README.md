# 🚲 fiets-radar 🌐

> **Note on the name:** “Fiets” is Dutch for bicycle. The name reflects the project's purpose of tracking bike availability across multiple bike-sharing networks.

## Overview

`fiets-radar` is an in-progress TypeScript service for tracking free-bike availability across the fixed list of 20 cities defined by the project specification.

The completed service will:

- resolve each required city to its applicable CityBikes network endpoints;
- collect validated availability observations;
- centrally schedule requests under the provider's runtime-reported global request budget;
- adapt polling frequency based on observed changes without starving cities;
- persist observations and completed hourly results;
- calculate time-weighted hourly averages and coverage;
- survive process termination and resume safely;
- record and deterministically replay real API traces;
- compare the adaptive scheduler against a fixed-interval baseline.

## Current Status

### Implemented

- strict TypeScript and Jest project configuration;
- pure hourly aggregation function;
- required golden-vector test;
- pre-hour validity-boundary test;
- zero-coverage regression test using `null` for an absent average.

### Captured and under analysis

- initial provider rate-limit response headers;
- the global network metadata response;
- 34 candidate network responses across the 20 required cities;
- matching header and JSON body evidence for each candidate endpoint.

### Not yet implemented

- final reproducible city-to-network mapping;
- Zod schemas for the provider boundary;
- CityBikes HTTP client;
- centralized scheduler;
- adaptive polling policy;
- global budget controller;
- persistent observation and hourly-result storage;
- crash recovery;
- recording and deterministic replay;
- fixed-interval baseline and benchmark;
- CLI or HTTP result exposure.

## Current Architecture Boundaries

The implementation is being separated into independently testable concerns:

- **Provider boundary:** fetch and runtime-validate untrusted CityBikes responses.
- **Scheduler:** decide which network to request next under one global budget.
- **Observation composition:** combine network results into city observations according to explicit timestamp and completeness rules.
- **Aggregation:** calculate time-weighted hourly averages from persisted observations.
- **Storage:** persist observations, results, and recovery state transactionally.
- **Trace and benchmark:** record real responses and replay scheduling policies deterministically.

Only the aggregation boundary is currently implemented.

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

* [`DECISIONS.md`](./DECISIONS.md): specification conflicts, interpretations, choices, and costs.
* [`AI-USAGE.md`](./AI-USAGE.md): implementation-assistant workflow, verification, and failures.
* [`docs/api-findings.md`](./docs/api-findings.md): measured CityBikes behavior and raw evidence excerpts.

Run instructions for the completed service, trace recorder, replay mode, and benchmark will be added as those components are implemented.
