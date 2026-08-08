# Architectural Decisions & Specification Resolutions

This document records specification conflicts, material ambiguities, architectural choices, and their costs. Measured CityBikes behavior is recorded separately in [`docs/api-findings.md`](./docs/api-findings.md).

> **Revision note — August 7, 2026:** Additional provider reconnaissance changed the city-resource and composition model. In particular, the earlier request arithmetic relied on a complete-refresh assumption that is no longer the chosen model. Captured facts, external/operator research, and architectural decisions are now distinguished more explicitly. Earlier revisions remain visible in Git history.

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

TypeScript 6.x was selected because the installed `ts-jest` version declared compatibility with TypeScript versions below 7. Forcing npm to ignore the peer-dependency range would create an unsupported dependency combination without providing a benefit required by the assignment.

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

## Reassessment: R5 Window Coverage and R6 Request Budget

### Context

R5 requires at least one observation for every city in every five-minute window of the run. R6 requires the service never to exceed the request budget reported by the provider, including retries.

The August 5 capture reported an hourly limit of 300 requests. Broad discovery found 34 candidate resources, later narrowed semantically to 30 resources in the reproducible mapping. Bay Wheels is included only through the implemented deterministic San Francisco filter. The captured details are documented in `docs/api-findings.md`.

### Reassessment

The earlier calculation of `34 endpoints × 12 windows = 408 requests/hour` was useful under an interpretation requiring every mapped network to be freshly fetched for every city observation. It no longer proves impossibility because the selected composition model permits still-valid cached network measurements to participate in a city state.

R6 remains a hard invariant. The earlier proof must not be replaced with another unverified proof, and it also must not be read as proving that R5 and R6 are compatible. The challenge guarantees that at least one impossible requirement pair exists; the final proven pair remains open and must be established before submission.

### Consequences

After runtime budget state has been established, the scheduler must not issue a request unless that state indicates that it is safe. Benchmarking must report actual R5 compliance rather than claiming it from the design. It must also report actual request accounting, including retries and failures.

### R6 bootstrap ambiguity and fail-closed policy

R6 requires the service to discover the provider budget at runtime from the API itself while also treating that budget as a hard ceiling. The first response headers cannot be inspected until a request has already been sent, so the specification does not define how the very first budget-discovery request is authorized.

The implementation will treat one initial request as an unavoidable **bootstrap request** when no usable runtime budget state exists.

Once that response is available:

- the bootstrap request counts as a real provider request;
- the controller initializes from the provider-reported post-request `remaining` value rather than assuming `limit - 1`;
- if the response reports `remaining = 0`, no further requests are permitted until the reported reset;
- missing, malformed, or contradictory budget headers leave the budget unknown and the service fails closed rather than continuing to poll;
- a transport failure that produces no usable response headers also leaves the budget unknown, so the service must not blindly retry startup requests under the claim that R6 is still proven.

This is a conservative resolution, not a proof that the bootstrap request itself can never encounter an already-exhausted externally shared provider budget. No pre-request mechanism was established that can reveal the current remaining budget without consuming a request. The limitation must therefore be stated rather than hidden behind an assumed configured limit.

The current rate-limit boundary parses the captured primary headers (`ratelimit-limit`, `ratelimit-remaining`, and `ratelimit-reset`) and checks the optional hourly compatibility headers for consistency. Request authorization and reset-time handling belong to the later global budget controller.

### Consequences and cost

This policy gives R6 a clear operational meaning after discovery and prevents retries or normal polling from proceeding on guessed budget state. Its cost is availability: a malformed bootstrap response or transport failure can stop polling until a later explicit recovery path is defined.

The bootstrap ambiguity is recorded as an underspecified operational edge of R6. It is **not** being claimed as the assignment's required impossible requirement pair; that proof remains open.

---

## Aggregation Interpretation Confirmed by the Golden Vector

### Context

The specification defines an observation at time `t` as valid for:

```text
[t, t + maxStaleness)
```

It also states that uncovered seconds are excluded from both the weighted sum and the average denominator. The provided golden vector establishes the expected boundary behavior.

### Proof

For the hour from `12:00:00Z` to `13:00:00Z` with `maxStaleness = 900` seconds:

| Observation | Effective covered interval | Covered seconds |
| --- | --- | ---: |
| `11:52`, 100 bikes | `12:00–12:07` | 420 |
| `12:10`, 130 bikes | `12:10–12:15` | 300 |
| `12:15`, 130 bikes | `12:15–12:30` | 900 |
| `12:50`, 70 bikes | `12:50–13:00` | 600 |

Total coverage is `2220` seconds. The weighted total is `240000` bike-seconds, so the average is `240000 / 2220 = 108.11`.

The expired intervals `12:07–12:10` and `12:30–12:50` contribute neither time nor bike values.

### Decision

The aggregation engine strictly enforces each observation's validity interval. A newer observation supersedes an older observation from its own timestamp onward, even when the older observation has not reached its staleness limit. Every validity interval is clipped against the following observation, its staleness expiry, and the target-hour bounds.

When no valid observation covers any portion of an hour, `averageFreeBikes` is stored as `null`, not as zero.

### Consequences

The aggregation logic must operate over explicit intervals instead of carrying the last value indefinitely. A numeric zero means that valid observations reported zero free bikes; `null` means that no valid information covered the hour. Those states must remain distinct throughout storage and result exposure.

---

## Architectural Boundary: CityBikes Client and Runtime Validation

### Context

CityBikes responses are untrusted external input. The assignment prohibits using a type assertion to declare a response valid without runtime checking, and tests must exercise the client without touching the real network.

### Decision

A dedicated CityBikes client will be the only HTTP boundary. Its Zod schemas will be based on the documented observed shapes and validate only fields required to produce an internal observation. Malformed data must not become an empty network or an observation with zero bikes.

Based on the field-selection experiment, the intended production client will use the V2 network endpoint with `?fields=stations,vehicles` so station and roaming-vehicle data can be retrieved in one request. GBFS remains an investigation aid rather than an intended runtime dependency.

The client should return a discriminated outcome that distinguishes at least:

- successful validated response;
- non-success HTTP response;
- network or transport failure;
- malformed JSON;
- structurally invalid provider response.

It will also return parsed rate-limit metadata when those headers are present.

### Consequences

The scheduler owns retries, retry accounting, backoff, fairness, and selection of the next request, so it must receive typed failure information. The aggregator remains independent of HTTP behavior: a failed fetch creates no observation, and any lost coverage is calculated from persisted observations later.

---

## Decision 1: What Counts as a Bicycle

### Context

The capture contains stations-only, vehicles-only, and mixed representations. It also demonstrates scooters and cases where station `free_bikes` already includes a station-level normal-bike/e-bike breakdown.

### Options considered

- count all provider-reported vehicles;
- count station totals only;
- count bicycles according to each observed representation;
- add station subtype fields to station `free_bikes`.

### Decision

Count:

- station `free_bikes` when that network's station representation is known to represent bicycle inventory;
- roaming `kind == "bike"`;
- roaming `kind == "ebike"`;
- cargo bicycles.

Exclude roaming `kind == "scooter"`. Do not separately add station `extra.normal_bikes` or `extra.ebikes` when `free_bikes` already contains them.

Provider-specific representation differences belong in reproducible network configuration or normalization metadata, not ad-hoc string checks scattered through the algorithm. The implemented normalization modes are `stations-only`, `vehicles-only`, and `stations-and-vehicles`.

### Consequences

This mapping is evidence-backed but tied to observed provider semantics and needs maintenance if CityBikes changes its representations.

---

## Decision 2: Network Inclusion and Semantic Mapping Rules

### Context

Broad discovery produced 34 candidates, not all of which belong in the current bicycle metric.

### Decision

Exclude as scooter-only in the captured evidence:

- `lime-san-francisco`;
- `bird-seattle`;
- `lime-portland`.

Include `bird-los-angeles`, `spin-los-angeles`, and `e-cargobike-goteborg`. Spin Los Angeles is semantically relevant, but its captured source data is stale; inclusion in the mapping does not make stale data usable.

Exclude `kotobike`. This conclusion relies on **external/operator research**, not the CityBikes capture: Kotobike states that service ended on March 31, 2026 and was integrated/rebranded into Charichari on April 1, 2026. The captured CityBikes data is frozen around that transition. Sources: [Kotobike notice, April 1](https://kotobike.jp/en/news/260401) and [Kotobike notice, February 23](https://kotobike.jp/en/news/260223).

Keep Bay Wheels relevant to San Francisco, but do not count its entire regional resource as a San Francisco total. **External/operator research:** the provider's current Lyft Bike service page (formerly Bay Wheels) says the system covers San Francisco, the East Bay, and San Jose ([service page](https://www.lyft.com/bikes/bay-wheels), [service updates](https://www.lyft.com/bikes/bay-wheels/service-updates)).

For this take-home, the reproducible configuration applies the following inclusive deterministic bounding box to both Bay Wheels station and vehicle records:

```text
latitude:   37.708 .. 37.833
longitude: -122.515 .. -122.356
```

This is an explicit engineering approximation, not a claim that the rectangle is the exact San Francisco municipal polygon. It keeps the regional resource usable without introducing a GIS dependency under the challenge's time constraint. A production implementation should replace this approximation with an authoritative geographic boundary if exact municipal inclusion is required.

Do not merge Bird Los Angeles and Spin Los Angeles merely because Bird acquired Spin. **External research:** Bird's filing records the acquisition ([SEC filing](https://www.sec.gov/Archives/edgar/data/1861449/000186144923000196/brds-20230919.htm)); LADOT material has referenced both Bird and Spin ([LADOT FAQ](https://ladot.lacity.gov/about/faq)). This does not establish that Spin Los Angeles is currently active. The documented position is that CityBikes exposes it as a distinct Los Angeles resource, no official retirement evidence comparable to Kotobike was established in this investigation, and the captured source data was about 37 days stale.

After the four exclusions above (three scooter-only resources and retired Kotobike), 30 of the 34 discovered resources remain in the reproducible mapping. Regional Bay Wheels is included only through the deterministic San Francisco filter above. This is not equivalent to 30 requests required for every city observation.

### Consequences

Excluding the three currently scooter-only resources avoids spending bicycle-polling budget on resources that contributed no bicycles in the captured evidence. Provider fleet composition can change later, so a static mapping can become stale. Periodic semantic rediscovery is a production-hardening concern outside this take-home's current scope.

---

## Decision 3: Fetch Time vs Source Freshness

### Context

`fetchedAt` records when this service received an HTTP response; it does not refresh the age of the underlying provider data. The final capture includes successful responses whose provider timestamps were much older than the HTTP response.

### Decision

Provider/source timestamps drive freshness decisions. Re-fetching an old source state does not restart validity. A matching bicycle count with a meaningfully newer source state can still be useful information, but a matching count with unchanged source state does not renew freshness. Stale required data must not be treated as zero, and benchmark staleness must reflect provider-backed source age rather than only elapsed time since HTTP fetch.

Network normalization now preserves:

- `oldestSourceAt`;
- `newestSourceAt`;
- `fetchedAt`;
- `validFrom`;
- `validUntil`.

For all source records included by the configured representation after any geographic filter:

```text
oldestSourceAt = minimum source timestamp
newestSourceAt = maximum source timestamp

validFrom  = newestSourceAt
validUntil = oldestSourceAt + maxStaleness
```

This is the intersection of the individual source validity windows. A normalized network total is usable only when:

```text
validFrom < validUntil
```

A spread equal to or greater than `maxStaleness` therefore yields no overlapping validity interval.

`fetchedAt` is preserved as receipt metadata but never extends provider-backed validity. A response fetched after `validUntil` may still normalize into a historical snapshot whose usable interval is already in the past.

For modes that use roaming vehicles, included vehicle timestamps participate in the represented source state even when a known scooter contributes zero bicycles. Unknown included vehicle kinds fail normalization rather than being silently treated as zero. For station-only mode, vehicle records are outside the configured representation and do not affect counting or source-time reduction.

### Consequences

This rule is intentionally conservative. A single old record inside the configured representation can shorten or eliminate the network's common validity interval. That may reduce coverage, but it avoids presenting a total as fresh when its component source observations do not overlap under the challenge's own staleness semantics. The benchmark will expose the practical cost of this choice.

An explicitly missing `vehicles` property fails closed for modes that require vehicles. An explicitly present empty vehicle array is distinct from a missing array; for `stations-and-vehicles`, normalization may still proceed when included station records provide source-time evidence.

Future provider timestamps and clock skew still require an explicit small policy rather than being silently accepted.

---

## Decision 4: Multi-Network City Composition

### Context

A city can depend on multiple network resources, and those resources may be fetched at different times.

The challenge defines an observation as a measurement of a city's total free bikes at an instant `t`, valid for `[t, t + maxStaleness)`. CityBikes does not hand this service one atomic city measurement: a network response may contain many source timestamps, and a city may require several separately fetched networks.

That leaves a material question unanswered by the brief: **which instant should become `t` for a city value assembled from provider state that was produced and learned at different times?**

The answer changes R5 compliance, coverage, and hourly averages.

### Options considered

1. **Use HTTP fetch/composition time and grant a fresh full `maxStaleness` window.**
   Simple, but it can make already-old provider state look fresh merely because it was fetched again.

2. **Backdate the city observation to the beginning of the component source-validity overlap.**
   This preserves provider timestamps, but it creates observations at instants when the service did not yet know the complete city value. In replay it can also create time-travel if a component was fetched later.

3. **Use the actual composition instant as the city observation instant, but cap expiry at the earliest provider-backed component expiry.**
   This preserves causality and does not refresh stale source state.

### Decision

Choose option 3.

A city may combine newly fetched network measurements with cached network measurements, but a component is usable at composition instant `asOf` only when:

```text
component.fetchedAt <= asOf
component.validFrom <= asOf < component.validUntil
```

The first condition is a causality rule: deterministic replay must not use provider state before the service actually received it.

The second condition is the provider-backed freshness rule.

A complete city observation is produced only when every network in the city's reproducible configuration is usable at `asOf`.

For a complete city observation:

```text
observedAt = asOf
freeBikes  = sum(required component freeBikes)
validUntil = minimum(required component validUntil)
```

The city observation must **not** be backdated to an earlier source timestamp or overlap start.

`validUntil` is intentionally allowed to be earlier than `observedAt + maxStaleness`. The service does not extend any component's source-backed validity merely because the complete city value was assembled later.

If a required component is unavailable at `asOf`, do not treat it as zero and do not persist the known subtotal as an official city observation. An incomplete diagnostic result may preserve the known subtotal and unavailable-network reasons, but it does not contribute to the official hourly average or satisfy R5 as a complete city observation.

The challenge's hourly `partial` flag remains a temporal-coverage flag (`coverage < 0.75`), not a composition-completeness flag.

### Why this is a material underspecification

The brief's binding `[t, t + maxStaleness)` rule assumes an atomic observation at `t`, while the real provider representation exposes non-atomic source timestamps and separately fetched resources. It does not specify whether `t` means provider source time, HTTP receipt time, or composition time when these differ.

Those readings can produce different observation instants and different expiry intervals, which changes:

- whether an R5 five-minute window contains an observation;
- how many seconds of an hour are covered;
- the resulting time-weighted average.

The implementation therefore records this as a materially underspecified requirement and chooses the conservative causal interpretation above.

### Consequences

The city/aggregation boundary now needs an explicit expiry rather than assuming every city observation is valid for exactly `maxStaleness` seconds after `observedAt`.

That is a deliberate conservative deviation from mechanically reapplying `[observedAt, observedAt + maxStaleness)` after composition. It avoids inventing freshness the provider evidence does not support.

This model can reduce coverage when one component is close to expiry. The benchmark should expose that cost rather than hiding it.

The currently implemented aggregator still assumes `timestamp + maxStaleness`; it requires a focused tested adaptation after city composition is implemented.

---

## Decision 5: R2 “Nothing New”

### Decision

Classify fetches conceptually as follows:

1. **Availability change:** normalized bicycle availability changed.
2. **Freshness refresh:** availability stayed the same, but provider-backed usable freshness advanced.
3. **Redundant:** no useful semantic improvement—availability did not change, provider-backed validity did not advance, and network/city completeness did not improve.
4. **Failure:** an HTTP, network, malformed, or invalid provider response; failures are not redundant.

Raw-body hash equality and same numeric bike counts are not the definition. A same-count measurement with a newer source state may be useful, and restoring a previously unavailable or stale component is useful even if its count matches an older value.

### Consequences

Availability changes are a volatility signal and may shorten polling. Repeated freshness-only refreshes indicate a healthy but flat source. Repeated redundant responses indicate polling faster than useful source updates and should drive stronger backoff, while fairness prevents permanent starvation.

No verified push mechanism or cache validator lets the scheduler know in advance that a request will be unchanged. R2 therefore means adaptively minimizing redundant fetches and reporting the redundant ratio honestly, not claiming zero redundancy or clairvoyance. The required benchmark denominator remains total fetches, with failures reported separately so a low redundant ratio cannot conceal a high error rate.

---

## Remaining Open Questions

- Does R5 mean aligned five-minute windows or every rolling five-minute interval?
- What small future-timestamp and clock-skew policy is appropriate?
- Which final impossible requirement pair can be proven as required by the challenge?
- What scheduler policy and weights are justified once city composition and persisted domain state are implemented and testable?
