# Architectural Decisions & Specification Resolutions

This document records specification conflicts, material ambiguities, architectural choices, and their costs.

> **Revision note — August 6, 2026:** Earlier revisions treated the reported hourly request limit as a separately enforced five-minute quota and overstated what choosing SQLite alone guarantees about crash recovery. Those conclusions were corrected after collecting and inventorying the full 34-response API capture and separating observed facts from design assumptions. The earlier revisions remain visible in Git history.

## Technical Stack and Scaffolding

### Context

The project requires:

- TypeScript on Node.js 22 LTS or newer;
- strict TypeScript configuration with no `any`;
- Jest for testing;
- runtime validation of untrusted external responses;
- persistent local storage;
- deterministic tests that do not use the real network or real timers.

### Options considered

- Node.js 22 LTS or Node.js 24 LTS;
- the latest TypeScript release or a version compatible with the selected Jest integration;
- manual runtime type guards or a schema-validation library;
- append-only JSONL or SQLite for local persistence.

### Decision

The current stack is:

- Node.js 24 LTS;
- TypeScript 6.x;
- Jest with `ts-jest`;
- Zod for runtime boundary validation;
- `better-sqlite3` as the intended local storage implementation.

TypeScript 6.x was selected because the installed `ts-jest` version declared compatibility with TypeScript versions below 7. Forcing npm to ignore the peer-dependency range would have created an unsupported dependency combination without providing a benefit required by the assignment.

Zod will validate untrusted CityBikes responses before they enter the internal domain model. External JSON will not be converted into trusted types through assertions such as `as NetworkResponse`.

SQLite was chosen because it requires no external service and supports transactions in a single local file.

### Consequences and cost

Selecting `better-sqlite3` does not, by itself, satisfy the hard-kill recovery requirement. R7 will only be considered satisfied after the project defines and tests:

- transaction boundaries;
- SQLite journal and synchronization settings;
- idempotent observation and aggregate writes;
- restart behavior for an in-flight hour;
- a real kill-and-restart recovery scenario.

The synchronous SQLite API is acceptable for the expected workload, but database operations must remain small and deliberate so they do not unnecessarily block the event loop.

---

## Specification Conflict: R5 Window Coverage vs R6 Request Budget

### Context

R5 requires at least one observation for every city in every five-minute window of the run.

R6 requires the service never to exceed the request budget reported by the provider. The ceiling includes retries and must be discovered from response metadata at runtime rather than assumed from configuration.

The provider response captured on August 5 reported an hourly limit of 300 requests.

The initial CityBikes mapping currently contains 34 candidate network endpoints for the 20 required cities.

### Proof

Under the current interpretation, one complete observation of a city requires refreshing every network included in that city's mapping.

Twelve five-minute windows occur in one hour:

```text
60 minutes / 5 minutes = 12 windows
```

Refreshing all 34 candidate endpoints once per window would require:

```text
34 endpoints × 12 windows = 408 requests per hour
```

The captured provider limit was:

```text
300 requests per hour
```

Therefore:

```text
408 required requests > 300 available requests
```

This minimum does not include retries, discovery requests, or a safety margin.

This proves that R5 and R6 cannot both be satisfied under the current complete-refresh interpretation and candidate mapping.

It does **not** prove that the provider enforces a separate quota of 25 requests inside each five-minute period. Dividing 300 by 12 gives an average allocation, not evidence of an independently enforced five-minute window.

### Decision

R6 will be treated as the hard invariant. The scheduler must not issue a request unless the runtime budget state indicates that the request is safe.

R5 compliance will be measured and reported rather than falsely guaranteed when the discovered budget makes full compliance impossible.

The scheduler must also preserve fairness so that no city is permanently starved while requests are allocated to more volatile cities.

### Cost and remaining dependency

Some five-minute windows may not contain a complete observation for every city.

The exact size of that degradation cannot be finalized until these two decisions are complete:

1. which of the 34 candidate endpoints belong in the final semantic city mapping;
2. whether a city observation requires all mapped networks to be fetched at the same scheduling opportunity or may combine values captured at different instants.

Any benchmark must report actual R5 compliance rather than claim compliance from the scheduler design alone.

---

## Aggregation Interpretation Confirmed by the Golden Vector

### Context

The specification defines an observation at time `t` as valid for:

```text
[t, t + maxStaleness)
```

It also states that uncovered seconds are excluded from both the weighted sum and the average denominator.

The provided golden vector establishes the expected boundary behavior.

### Proof

For the hour from `12:00:00Z` to `13:00:00Z` with `maxStaleness = 900` seconds:

| Observation        | Effective covered interval | Covered seconds |
| ------------------ | -------------------------- | --------------: |
| `11:52`, 100 bikes | `12:00–12:07`              |             420 |
| `12:10`, 130 bikes | `12:10–12:15`              |             300 |
| `12:15`, 130 bikes | `12:15–12:30`              |             900 |
| `12:50`, 70 bikes  | `12:50–13:00`              |             600 |

Total coverage:

```text
420 + 300 + 900 + 600 = 2220 seconds
```

Weighted total:

```text
(100 × 420)
+ (130 × 300)
+ (130 × 900)
+ (70 × 600)
= 240000 bike-seconds
```

Average:

```text
240000 / 2220 = 108.11
```

The expired intervals `12:07–12:10` and `12:30–12:50` contribute neither time nor bike values.

### Decision

The aggregation engine strictly enforces each observation's validity interval.

A newer observation supersedes an older observation from its own timestamp onward, even when the older observation has not yet reached its staleness limit.

Every validity interval is clipped against:

* the following observation;
* its staleness expiry;
* the beginning of the target hour;
* the end of the target hour.

When no valid observation covers any portion of an hour, `averageFreeBikes` is stored as `null`, not as zero.

### Consequences

The aggregation logic must operate over explicit intervals instead of carrying the last value indefinitely.

A numeric zero means that valid observations reported zero free bikes. `null` means that no valid information covered the hour. Those states must remain distinct throughout storage and result exposure.

---

## Architectural Boundary: CityBikes Client and Runtime Validation

### Context

CityBikes responses are untrusted external input.

The assignment explicitly prohibits using a type assertion to declare the response valid without runtime checking. Tests must also be able to exercise the client without touching the real network.

### Options considered

* validate the full provider response and retain all fields;
* validate only the minimum fields required by the service;
* throw all failures to the process entry point;
* convert failures to `null`;
* return explicit typed outcomes for different failure categories.

### Decision

A dedicated CityBikes client will be the only HTTP boundary.

The final Zod schemas will be based on the complete evidence matrix from all 34 captured candidate responses. The schemas will validate only fields required to produce an internal observation, while allowing unrelated provider-specific fields to be discarded.

Malformed data must not be converted into a valid empty network or into an observation with zero bikes.

The client should return a discriminated outcome that distinguishes at least:

* successful validated response;
* non-success HTTP response;
* network or transport failure;
* malformed JSON;
* structurally invalid provider response.

The client will also return parsed rate-limit metadata when those headers are present.

### Consequences

The scheduler must receive typed failure information because it owns:

* whether and when to retry;
* retry request accounting;
* backoff;
* fairness;
* selection of the next request.

The aggregator remains independent of HTTP behavior. A failed fetch creates no observation. Any coverage lost because no observation was produced is calculated later from persisted observations.

The exact response schema and failure types remain open until the evidence matrix is complete.

---

## Open Specification Questions

The following questions materially affect stored results or benchmark metrics and must be resolved before their corresponding modules are implemented.

### Timestamp of a multi-network city observation

A city may require multiple sequential HTTP requests. Candidate timestamps include:

* start of the first request;
* completion of the final request;
* each network's response time;
* oldest station timestamp;
* newest station timestamp.

The choice changes staleness, coverage, and hourly averages.

### Combining fresh and cached network values

Using a newly fetched value for one network together with older cached values for the others would reduce request use, but the resulting city total would combine measurements from different instants.

A decision is required on whether that result is still considered one city observation.

### Meaning of “nothing new”

Possible definitions include:

* unchanged city total;
* unchanged station values;
* unchanged provider timestamps;
* byte-identical response;
* an HTTP conditional-request response;
* no material change to the service's internal metric.

This definition affects both adaptive polling and the redundant-fetch ratio.

### Meaning of a five-minute window

R5 may refer to:

* fixed aligned windows such as `12:00–12:05`;
* every rolling five-minute interval.

These interpretations permit different maximum gaps and produce different compliance values.

### Partial multi-network fetches

A decision is required for a city where some mapped networks succeed and others fail:

* reject the whole city observation;
* store a marked partial total;
* combine successful responses with cached values.

Each option changes accuracy, coverage, and request behavior.
