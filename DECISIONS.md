# Architectural Decisions & Specification Resolutions

This document records specification conflicts, material ambiguities, architectural choices, and their costs. Measured CityBikes behavior is recorded separately in [`docs/api-findings.md`](./docs/api-findings.md).

> **Revision note — August 7, 2026:** Additional provider reconnaissance changed the city-resource and composition model. In particular, the earlier request arithmetic relied on a complete-refresh assumption that is no longer the chosen model. Captured facts, external/operator research, and architectural decisions are now distinguished more explicitly. Earlier revisions remain visible in Git history.

> **Revision note — August 8, 2026:** The required impossible-pair analysis is now resolved as R1 versus the strict literal reading of R2. The R5 city-observation interpretation is also made explicit: a city-level observation may be materialized at `asOf` from component measurements that were fetched earlier but remain provider-valid at `asOf`; doing so never renews the component validity intervals.

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
- `better-sqlite3` as the local storage implementation.

TypeScript 6.x was selected because the installed `ts-jest` version declared compatibility with TypeScript versions below 7. Forcing npm to ignore the peer-dependency range would create an unsupported dependency combination without providing a benefit required by the assignment.

Zod will validate untrusted CityBikes responses before they enter the internal domain model. External JSON will not be converted into trusted types through assertions such as `as NetworkResponse`.

SQLite was chosen because it requires no external service and supports transactions in a single local file.

The implemented store persists four kinds of durable state:

- normalized network snapshots;
- complete city observations used as aggregation inputs;
- hourly aggregation results;
- the single global CityBikes request-budget state.

Dates are stored as Unix epoch milliseconds and reconstructed as `Date` values on read.

For file-backed databases the store configures:

```text
journal_mode = WAL
synchronous = FULL
```

Network snapshots are historical rather than "latest row wins". Exact duplicate snapshots are idempotent, and lookup at an injected `asOf` instant requires both causality and provider validity:

```text
fetchedAt <= asOf
validFrom <= asOf < validUntil
```

When several snapshots are usable, selection prefers:

```text
validFrom DESC
fetchedAt DESC
```

This deliberately prefers fresher provider-backed state over a merely later HTTP fetch.

Official city observations use `(city, countryCode, observedAt)` as their idempotent identity. Incomplete diagnostic subtotals are not persisted through the official-observation API.

Hourly results use `(city, countryCode, hourStart)` as their identity and are upserted so an in-flight hour can be recomputed from persisted observations without duplicating logical output. `averageFreeBikes = null` is preserved as SQL `NULL` and round-trips as `null`.

### Consequences and cost

The storage strategy favors recomputing derived hourly state from durable observation inputs instead of maintaining a fragile partially accumulated weighted sum.

Normal close/reopen recovery is tested with a real temporary SQLite file. R7 is now also covered by a real process-level SIGKILL/restart test against a file-backed SQLite database.

The recovery test deliberately waits for an explicit child-process `READY` signal after the relevant SQLite writes have completed, then sends `SIGKILL` only to that exact spawned child. A second process reopens the same database, deliberately replays one identical pre-kill observation, writes the remaining observations, and finalizes the formerly in-flight hour.

The verified results are:

```text
completed pre-kill hour:
  coveredSeconds = 3600
  averageFreeBikes = 16.67

recovered in-flight hour:
  coveredSeconds = 3600
  averageFreeBikes = 23.33
```

Exactly three source observations remain for the recovered hour even though one pre-kill observation was intentionally replayed after restart. The `(city, countryCode, observedAt)` idempotency key prevents the replay from becoming a second logical observation.

This proves the required recovery property for **committed** observations: already-committed coverage is neither lost nor applied twice. It does not claim that a SQLite write interrupted before it commits must appear after a crash.

The synchronous SQLite API is acceptable for the expected workload, but database operations must remain small and deliberate so they do not unnecessarily block the event loop.

---

## Reassessment: R5 Window Coverage and R6 Request Budget

### Context

R5 requires at least one observation for every city in every five-minute window of the run. R6 requires the service never to exceed the request budget reported by the provider, including retries.

The August 5 capture reported an hourly limit of 300 requests. Broad discovery found 34 candidate resources, later narrowed semantically to 30 resources in the reproducible mapping. Bay Wheels is included only through the implemented deterministic San Francisco filter. The captured details are documented in `docs/api-findings.md`.

### Reassessment

The earlier calculation of `34 endpoints × 12 windows = 408 requests/hour` was useful under an interpretation requiring every mapped network to be freshly fetched for every city observation. It no longer proves impossibility because the selected composition model permits still-valid cached network measurements to participate in a city state.

R6 remains a hard invariant. The earlier proof must not be replaced with another unverified proof, and it also must not be read as proving that R5 and R6 are compatible. The assignment's required impossible pair is resolved separately below as **R1 versus the strict literal reading of R2**; this R5/R6 reassessment is kept because it records an earlier assumption that was corrected openly.

### Consequences

After runtime budget state has been established, the scheduler must not issue a request unless that state indicates that it is safe. City observations themselves do not require HTTP requests: due observations may be materialized from already-fetched component snapshots while those snapshots remain provider-valid. Benchmarking must still report actual rolling R5 compliance rather than claiming it solely from the 240-second target, and it must report actual request accounting, including failures.

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

The rate-limit boundary parses the captured primary headers (`ratelimit-limit`, `ratelimit-remaining`, and `ratelimit-reset`) and checks the optional hourly compatibility headers for consistency.

### Persistent global budget controller

Request authorization and reset-time handling are now implemented by a persistent global budget controller backed by the same SQLite store.

The persisted state is conceptually one of:

```text
unknown
bootstrap-pending
established(limit, remaining, resetAt)
fail-closed(resetAt | null)
```

The controller makes the following safety choices:

- a fresh/unknown state may durably reserve exactly one bootstrap request;
- the reservation is written synchronously before a permit is returned;
- an established reservation decrements the persisted remaining count before the caller can perform the HTTP request;
- provider-reported post-request `remaining` is authoritative and replaces the local conservative count exactly;
- a reset does not refill from the previous `limit`; the new provider window is discovered through one new bootstrap request;
- a request that yields no trustworthy budget metadata is never refunded;
- fail-closed state with a known reset remains blocked until that reset, then permits one new bootstrap;
- fail-closed state without a known reset remains blocked rather than guessing.

The persisted budget row is also decoded fail-closed. Absence of a row means genuinely unknown/fresh state and may bootstrap. A row that exists but is malformed or internally inconsistent must not be converted to `unknown`, because `unknown` authorizes a bootstrap request. A hostile regression test writes an inconsistent `established` row directly through SQLite and verifies that it becomes `fail-closed` while preserving a valid reset boundary.

### Single in-flight request assumption

The budget reconciliation model deliberately assumes the centralized scheduler will keep at most **one CityBikes request in flight globally**:

```text
choose request
→ reserve budget durably
→ perform/await HTTP
→ reconcile or fail closed
→ only then choose another request
```

This keeps provider header reconciliation ordered and avoids requiring a collection of outstanding reservations.

If future code allowed concurrent CityBikes requests, this controller would need explicit outstanding-reservation state or another ordering mechanism before the same R6 claim could be made.

A further availability tradeoff exists around bootstrap crashes. If the process dies after a bootstrap permit has been durably reserved but before trustworthy rate-limit metadata is persisted, restart sees `bootstrap-pending` and must not silently issue another bootstrap request. When no reset boundary is known, automatic recovery cannot prove that a retry is safe, so the conservative state may remain blocked until an explicit recovery path is available. By contrast, a crash after an established reservation leaves the already-decremented known budget persisted, so continuing after restart remains conservative.

### Consequences and cost

This policy gives R6 a clear operational meaning after discovery and prevents retries or normal polling from proceeding on guessed budget state. Its cost is availability: a malformed bootstrap response or transport failure can leave the controller fail-closed. When no trustworthy reset boundary is known, automatic polling remains blocked rather than risking an unprovable retry.

The bootstrap ambiguity is recorded as an underspecified operational edge of R6. It is **not** the assignment's required impossible requirement pair; the required pair is documented below under Decision 5.

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

The city/aggregation boundary uses explicit expiry rather than assuming every composed city observation is valid for exactly `maxStaleness` seconds after `observedAt`.

The interval-aware aggregation path accepts observations shaped as `timestamp`, `validUntil`, and `freeBikes`. The original challenge-facing `timestamp + maxStaleness` API remains available as a compatibility wrapper that converts to explicit validity intervals and delegates to the same aggregation engine.

That is a deliberate conservative deviation from mechanically reapplying `[observedAt, observedAt + maxStaleness)` after composition. It avoids inventing freshness the provider evidence does not support.

This model can reduce coverage when one component is close to expiry. The benchmark should expose that cost rather than hiding it.

---

## Decision 5: R1 Runtime Adaptation vs Literal R2 “Nothing New”

### Context

The assignment states every R1–R9 item as a hard requirement.

R1 requires the service to poll adaptively: a network whose availability changes quickly must be
polled more often than one that is flat or stale, and the adaptation must be driven by what is
observed at runtime.

R2 says:

```text
Do not spend requests on data that has not changed.
```

and also requires the service to report what fraction of fetches returned nothing new.

The observed CityBikes interface is pull-based. The provider evidence captured for this project did
not establish a push channel, `ETag`, `Last-Modified`, or another verified mechanism that tells the
service, before a fetch, whether the remote state has changed.

### Required impossible pair: R1 + strict literal R2

Read strictly as **“never issue a request whose result turns out to contain no new data”**, R2
cannot be guaranteed at the same time as runtime-driven R1.

The proof is an indistinguishability argument.

Assume the service last observed network state `S` at `t0`. At some later candidate poll instant
`t1`, consider two possible provider worlds:

```text
World A: the provider still contains S
World B: the provider has changed to S'
```

Before issuing the request at `t1`, the service has the same local information in both worlds.

If it sends the request:

```text
World A → the request returns nothing new
          → strict literal R2 is violated
```

If the scheduler never probes again in order to avoid that risk:

```text
World B → the service never discovers the change
          → it can never make later polling react to that runtime change as R1 requires
```

Postponing the probe does not remove the contradiction. At the first future probe the scheduler
chooses to make, the same two worlds are still indistinguishable immediately before that request:
one world is unchanged and the other has changed.

No scheduler policy can choose differently between those worlds before obtaining some new
information, because the worlds are locally indistinguishable at that point.

The real API evidence matters here: no verified free change-notification or conditional-validation
mechanism was found that removes this uncertainty without consuming the provider request being
accounted for.

The second sentence of R2 also supports this interpretation of the conflict: the brief explicitly
asks for the fraction of fetches that returned nothing new. If the first sentence literally implied
that such a fetch could never occur, that metric would be forced to zero by construction.

### Resolution

Keep R1 as an actual runtime-adaptation requirement.

Interpret R2 operationally as:

> **minimize requests that return no semantically useful new information, learn from those outcomes,
> and report their fraction honestly; do not claim that zero redundant fetches can be guaranteed.**

A provider fetch is classified as exactly one of:

1. **Availability change:** normalized bicycle availability changed.
2. **Freshness refresh:** availability stayed the same, but provider-backed usable freshness advanced.
3. **Redundant:** no useful semantic improvement—availability did not change, provider-backed
   validity did not advance, and network/city completeness did not improve.
4. **Failure:** an HTTP, network, malformed, invalid, or otherwise unusable provider result.

Raw-body equality and same numeric bike counts are not the definition of redundancy.

For example:

```text
100 bikes @ provider source 12:00
100 bikes @ provider source 12:05
```

is useful new evidence even though the numerical count is unchanged, because provider-backed
freshness advanced.

By contrast:

```text
100 bikes @ provider source June 19
100 bikes @ provider source June 19
```

fetched repeatedly in August is not a freshness refresh merely because HTTP receipt time advanced.

### Cost

The scheduler cannot guarantee a `0%` redundant-fetch ratio.

Some probing is the unavoidable price of discovering whether a previously flat or stale resource
has become volatile again. A redundant result is therefore not hidden as a success: it is measured,
feeds adaptive backoff, and remains visible in the benchmark.

Failures are tracked separately rather than counted as redundant, so a low redundancy ratio cannot
conceal a high error rate.

Availability changes may shorten polling. Freshness-only refreshes describe a healthy but relatively
flat source. Repeated redundant responses drive stronger backoff, while fairness prevents permanent
starvation.

This resolution weakens the strict literal wording of R2, but it preserves the part that is
implementable and measurable while making the unavoidable information-theoretic cost explicit.

---

## Decision 6: Centralized Adaptive Scheduler, Rolling R5, and Runtime Pacing

### Context

The scheduler must simultaneously support:

- R1 adaptive polling based on observed runtime behavior;
- R2 avoidance/reporting of redundant fetches;
- R3 one centralized scheduler and one global provider budget;
- R4 fairness/no starvation;
- R5 complete city observations in every five-minute window;
- R6 strict adherence to the provider's runtime-discovered global budget;
- R8 deterministic unit testing with fake time and no real waits.

The provider evidence also shows that a later HTTP response can carry older provider state, so HTTP recency cannot be treated as source freshness.

### Decision

The scheduler is implemented as an explicit `step()` operation. A step performs free local composition work first and then performs **at most one provider fetch**:

```text
materialize due cities from cached provider-valid state
→ select one due network
→ reserve request budget durably
→ await one HTTP request
→ reconcile or fail closed
→ normalize/classify/persist
→ advance that network deadline
→ attempt due city composition again
```

Concurrent `step()` calls do not start another provider request; the second call returns `busy`.

No per-city or per-network timers are used. Production orchestration can call `step()` repeatedly later.

### Rolling R5 interpretation

R5 is interpreted as a **rolling** five-minute requirement, not aligned `00/05/10/...` clock buckets.

A fixed-bucket interpretation can satisfy adjacent buckets with observations near opposite edges
while leaving an almost ten-minute gap. For example, observations at `12:00:01` and `12:09:59`
would satisfy the aligned `12:00–12:05` and `12:05–12:10` buckets while leaving a gap of almost ten
minutes between observations.

The scheduler therefore targets:

```text
CITY_OBSERVATION_TARGET_SECONDS = 240
R5_WINDOW_SECONDS = 300
```

A complete city observation is due every 240 seconds. A city is reported overdue after more than
300 seconds without a run-local complete observation.

### What counts as a city observation for R5

The provider does not expose one atomic resource for every required city. A city observation is a
derived city-level measurement produced by the composition boundary.

The chosen interpretation is:

> A new city observation may be materialized at composition instant `asOf` from component
> measurements fetched earlier, **provided every required component still describes its component at
> `asOf` under the provider-backed validity rules**.

The required conditions are:

```text
component.fetchedAt <= asOf
component.validFrom <= asOf < component.validUntil
```

If they all hold, the composer may persist:

```text
observedAt = asOf
freeBikes  = sum(required component freeBikes)
validUntil = minimum(required component validUntil)
```

This is considered an observation at `asOf` because it is the service's derived measurement of the
city total at that instant, using evidence that is still valid at that instant.

This interpretation does **not** claim that CityBikes itself was freshly contacted at `asOf`, and it
does not renew any component:

```text
cached component validUntil stays unchanged
city validUntil = earliest component validUntil
```

A component that has expired cannot be made current by local recomposition.

### Why not require a fresh upstream fetch for every R5 observation?

The brief defines R5 in terms of a city **observation**, not an upstream **request**. It separately
defines validity so that an observation continues to describe the measured state until expiry.

Requiring fresh HTTP evidence inside every R5 window would therefore add a stronger request-frequency
rule that is not stated explicitly and would conflate two different questions:

```text
Do I currently have a valid city-level view?
How recently did I contact the provider?
```

The first is what this implementation uses for R5. The second remains observable through source
staleness and request metrics.

### Cost of this interpretation

R5 compliance can remain high even when no new provider request occurred in a particular
five-minute window, as long as every component used for the new city-level observation remains
provider-valid.

That makes R5 a measure of **regular availability of a valid complete city view**, not a measure of
upstream polling frequency.

This is an explicit interpretation choice, not a claim that the brief uniquely forces this reading.
The alternative “fresh upstream measurement in every R5 window” interpretation would produce
different request arithmetic and could reduce achievable compliance under the same R6 budget.

Incomplete compositions never become official city observations and therefore never satisfy R5.

### Network selection and fairness

The scheduler builds one unique deterministic network list from the existing city configuration.

Selection is earliest-deadline-first:

1. missing usable state is immediately due unless a previous failure already moved that network's deadline forward;
2. otherwise use the network's adaptive `nextPollAt`;
3. ties use stable configuration order.

After a network is fetched, its deadline moves forward. This makes other equally overdue networks become eligible and avoids repeatedly selecting the same resource while others remain due.

### Fetch usefulness classification

Each actual provider fetch is classified as exactly one of:

```text
availability-change
freshness-refresh
redundant
failure
```

The classification is semantic and provider-time-aware:

- the first currently usable state is a freshness refresh;
- a changed `freeBikes` value is an availability change only when the provider state is not older than the state already in use;
- unchanged availability with improved provider-backed freshness is a freshness refresh;
- a successful but older provider state is redundant;
- a successful historical snapshot that is already expired at fetch completion may still be persisted for history, but is a scheduling failure because it supplies no usable current state;
- HTTP/client/normalization outcomes that produce no usable normalized state are failures.

Run-local metrics track:

```text
totalFetches
availabilityChanges
freshnessRefreshes
redundantFetches
failures
redundantRatio = redundantFetches / totalFetches
```

The ratio is kept unrounded internally.

### Adaptive interval policy

The scheduler uses a deliberately small explainable heuristic:

```text
availability change → shorten cadence
freshness refresh   → keep roughly the current cadence
redundant            → back off
failure              → conservative backoff
```

The interval is also bounded by runtime provider capacity and provider-backed freshness.

No provider limit such as `300/hour` is hardcoded into the scheduling policy.

When the request-budget controller exposes an established state with positive remaining budget and a future reset, the scheduler derives:

```text
remainingWindowMs = resetAt - now

sustainableFloorMs =
  ceil(
    configuredNetworkCount
    * remainingWindowMs
    / remaining
  )
```

This asks: if all configured networks had to share the currently remaining request budget at roughly equal cadence, how far apart would each network's requests need to be?

### Freshness ceiling and capacity conflict

The normal freshness ceiling is derived from configured `maxStaleness` with a 60-second safety margin when possible:

```text
freshnessCeiling =
  maxStaleness - safetyMargin
```

If the runtime sustainable floor is longer than that freshness ceiling, the scheduler exposes:

```text
capacityInsufficient = true
```

and does not intentionally violate R6 merely to preserve freshness.

When capacity is not globally insufficient, expiry-safety logic may still pull a poll earlier than the adaptive preference, but it may **not** pull the actual deadline earlier than an already-known sustainable pacing floor.

Conceptually:

```text
preferred =
  min(adaptiveDeadline, expirySafetyDeadline)

actual =
  max(start + sustainableFloor, preferred)
```

when a trustworthy sustainable floor exists.

This prevents near-expiry/stale provider responses from creating immediate retry loops that waste budget and undermine fairness.

### Source freshness correction

Second-pass review found two cases where the first scheduler implementation treated HTTP-success data too optimistically:

1. an already-expired normalized provider interval was counted as `freshness-refresh`;
2. an older provider state with a different bike count was counted as `availability-change`.

Both cases type-checked and passed the original generated scheduler suite.

The corrected scheduler persists historical normalized snapshots but only treats them as currently useful when:

```text
validFrom <= fetchedAt < validUntil
```

and it classifies provider-state regressions as redundant rather than as new availability changes.

### Consequences and cost

The scheduler is adaptive and budget-aware but intentionally heuristic, not an optimal control algorithm.

Run-local adaptive interval state is not persisted across restart. Durable correctness comes from persisted provider snapshots, city observations, hourly results, and request-budget state; scheduling heuristics are reconstructed conservatively after restart.

The policy can report `capacityInsufficient`, but it cannot make an impossible provider-capacity situation disappear. If runtime capacity is too low to refresh all necessary components before their provider-backed validity expires, R6 safety wins and actual R5 compliance may degrade. The benchmark must measure that result rather than infer compliance from the design.

The policy is now wired into a minimal production runtime. `ServiceRuntime.tick()` finalizes completed UTC hours from durable city observations and then advances the centralized scheduler. The live CLI uses one central loop; it does not introduce timers per city or network.

Raw trace recording and deterministic replay are also implemented. Final benchmark evidence is intentionally kept separate from the scheduler design: the heuristic is not considered successful merely because its unit tests pass.

---

## Decision 7: Hour Finalization, SIGKILL Recovery, and Result Exposure

### Context

R7 requires a real hard-kill recovery story: completed hours must remain intact, and an in-flight hour must resume without double counting or losing seconds already accumulated.

A tempting implementation is to persist mutable partial aggregation state such as:

```text
weightedSumSoFar
coveredSecondsSoFar
```

That creates a replay problem after a crash: the service must know exactly which increments were already applied before continuing.

R9 separately requires a way to expose stored hourly averages.

### Options considered

1. Persist a mutable partial weighted accumulator for the in-flight hour.
2. Treat durable city observations as source facts and recompute the hour from those observations.
3. Use an external stream processor or database with a larger recovery model.

### Decision

Choose option 2.

Complete city observations are the durable aggregation inputs. Hourly results are derived/materialized state.

When a UTC hour completes:

```text
load persisted observations overlapping the hour
→ calculateHourlyAverageFromValidity(...)
→ upsert hourly_results
```

No partially accumulated weighted sum is persisted.

The production runtime has one coordinator. On each tick it finalizes completed UTC hours known within that process and then calls the centralized scheduler.

For R9, `SqliteStore.listHourlyResults()` exposes deterministic domain records ordered by hour, city, and country. The `results` CLI prints them as JSON with ISO UTC timestamps and preserves `averageFreeBikes: null`.

### Process-level proof

The crash-recovery test uses a real child process and a real file-backed SQLite database.

Before the kill, the child:

- writes observations covering `10:00–11:00`;
- finalizes that completed hour;
- writes the first `11:00–11:10` observation;
- signals `READY` only after those writes complete.

The parent then calls `child.kill("SIGKILL")` on that exact child.

The restart process:

- opens the same SQLite file;
- writes the identical `11:00–11:10` observation again;
- writes `11:10–11:30` and `11:30–12:00`;
- finalizes `11:00–12:00`.

The recovered hour contains exactly three observations, not four, and evaluates to `3600` covered seconds and `23.33` average free bikes.

### Consequences and cost

The recovery model is simple because there is no partial arithmetic checkpoint to replay.

The cost is recomputation: finalization reads the persisted observations for the hour again. At this assignment's scale that is deliberately preferred over a more complicated mutable checkpoint protocol.

A fresh process automatically considers the immediately preceding completed hour. A persistent finalization cursor for arbitrary multi-hour downtime is not implemented, so automatic catch-up after a long outage is a documented limitation.

---

## Decision 8: Raw Trace, Causal Replay, and Benchmark Semantics

### Context

Section 5 requires real API evidence containing the instant, status, headers, and body of each fetch, then deterministic replay with a virtual clock and a same-budget comparison against a dumb fixed-interval baseline.

The first benchmark implementation recorded only normalized semantic snapshots. That representation was compact and sufficient for scheduler semantics, but it did **not** satisfy the explicit raw-trace requirement. The benchmark design was therefore corrected rather than defended.

A second issue was causality: one recorded round is a sequential sweep, so a response captured near the end of a round must not become visible merely because the round started earlier.

The required MAE metric also compares **stored hourly averages**, not instantaneous free-bike counts.

### Decision

The submission benchmark format is V2 raw trace evidence.

Each response records:

```text
networkId
capturedAt
HTTP status
response headers
exact response body text
```

The trace also records the selected city subset, configured network IDs, `maxStaleness`, and capture rounds. Trace JSON is runtime-validated with Zod before use.

A complete round becomes replay-visible at:

```text
max(roundAt, every response.capturedAt)
```

not at `roundAt`.

Replay rebuilds a synthetic HTTP `Response` and sends it through the real CityBikes client boundary. Recorded body data is therefore parsed as untrusted input again rather than asserted into an internal type.

The benchmark runs the real `AdaptiveScheduler` twice:

```text
adaptive polling mode
fixed polling mode
```

Both strategies receive the same trace, selected cities, virtual time range, and explicit simulated request budget.

The fixed interval is derived from the experiment:

```text
ceil(networkCount * benchmarkDurationMs / requestBudget)
```

rather than from a hardcoded provider limit.

### Metric definitions

**Requests:** exact scheduler fetch attempts.

**Staleness:** sampled on regular deterministic evaluation ticks only, using:

```text
virtualTime - city.oldestSourceAt
```

HTTP receipt time is not used as freshness.

**p95 staleness:** nearest-rank percentile.

**Redundant ratio:** scheduler semantic `redundantFetches / totalFetches`; failures remain separate.

**R5 compliance:** continuous rolling-window compliance over complete five-minute windows contained inside the benchmark run. The possible window-ending domain is:

```text
[runStart + 300s, runEnd)
```

An observation at `t` satisfies window endings in:

```text
[t, t + 300s)
```

Intervals are clipped and unioned per city.

**MAE:** mean absolute error between strategy **stored hourly averages** and trace-ground-truth hourly averages. Only completed UTC clock hours count, and only city-hour pairs where both sides have a non-null average are comparable.

### Trace selection

The final dense benchmark capture uses a handful of currently usable resources:

```text
Barcelona
  ambici-amb
  bicing

Madrid
  bicimad

Göteborg
  e-cargobike-goteborg
  styr-staell-goeteborg
```

This subset provides both changing and comparatively flat availability behavior without allowing known provider-broken resources to dominate an experiment whose purpose is comparing scheduling policies.

The earlier 30-resource/5-round normalized trace remains diagnostic evidence about provider behavior; it is not presented as the required section-5 raw trace.

### Consequences and cost

Raw traces are larger than normalized traces, but they satisfy the evidence requirement and allow replay to exercise the real runtime validation boundary.

Round-level availability is conservative: the benchmark waits until the whole sweep is complete before making that complete round visible. This sacrifices some possible sample-level fidelity in exchange for a simple no-future-information rule.

The adaptive heuristic is judged by measurement, not intent.

### Measured result and scheduler decision

The final V2 trace contains 60 complete rounds over approximately two hours for five configured
resources across Barcelona, Madrid, and Göteborg. The fixed and adaptive strategies were replayed
against the same trace with an explicit request budget of 300.

The submitted/original adaptive heuristic produced:

```text
requests             255
mean staleness       179.756 s
p95 staleness        292.352 s
redundant ratio      0.117647
R5 compliance        1.000000
hourly-average MAE   3.486667
```

The fixed baseline produced:

```text
requests             295
mean staleness       108.275 s
p95 staleness        188.385 s
redundant ratio      0.050847
R5 compliance        1.000000
hourly-average MAE   1.850000
```

The adaptive policy therefore wins only on request count, ties R5 compliance, and loses the four
measured quality metrics. I do not reinterpret or hide that result. This is an empirical result for
this trace and these tested policies; it is not a proof that adaptive scheduling cannot outperform a
fixed policy in general.

Two evidence-driven scheduler experiments were then tested against the **same** trace, budget,
baseline, and metric definitions:

1. a freshness-backoff experiment started unknown resources at the equal-share neutral cadence and
   applied a modest 1.25× backoff to repeated same-count freshness refreshes;
2. a global-pacing experiment separated per-network adaptive deadlines from aggregate request
   pacing so that changing resources could request service below the equal-share per-network floor.

The first experiment used 216 requests but materially worsened staleness, redundancy, and MAE.
The second used 246 requests and re-spent some capacity, but quality remained worse than the
original heuristic and p95 staleness degraded further.

Both experimental code changes were therefore reverted.

### Cost and final choice

The fixed baseline is unusually strong on this trace because its interval (`120.298` seconds) is
close to the approximately two-minute recording cadence. Polling substantially faster than the
trace can expose another request before newer recorded provider evidence exists, while backing off
flat-but-fresh resources saves requests at the cost of older source timestamps.

The benchmark is development evidence, not proof that the original heuristic is globally optimal
and not proof that the requested two-win target is impossible. However, it is sufficient to reject
the two measured regressions.

The final submission therefore keeps the simpler original adaptive policy:

```text
availability change → shorten cadence
freshness refresh   → keep roughly the current cadence
redundant            → back off
failure              → conservative backoff
```

and keeps the original runtime-derived sustainable per-network floor and expiry-safety pacing.

The cost is explicit: the submitted adaptive scheduler does **not** meet the benchmark target of
beating the fixed baseline on at least two metrics on this recorded workload. It saves about 13.6% of
requests while preserving measured R5 compliance, but gives up freshness and hourly-average accuracy
relative to the fixed baseline. `docs/benchmark.md` records the complete result and rejected
experiments. No further constant tuning is performed against this same development trace merely to
manufacture a favorable comparison.

---

## Final Specification-Problem Summary

The assignment explicitly requires at least one impossible pair and at least one material
underspecification to be identified, proved, resolved, and priced.

### Impossible pair

The required pair is:

```text
R1 runtime-driven adaptive polling
+
strict literal R2 zero requests that return nothing new
```

Decision 5 gives the proof.

The core issue is information: before polling a pull-only resource, the service cannot distinguish
“still unchanged” from “changed since the last observation” when the provider offers no verified
free pre-request change signal.

The resolution is to preserve runtime-driven adaptation and interpret R2 as minimizing, learning
from, and reporting semantically redundant fetches rather than pretending they can be eliminated
with certainty.

The cost is that the redundant-fetch ratio is not guaranteed to be zero.

### Material underspecification

Decision 4 records the primary materially underspecified requirement.

The binding aggregation definition assumes a city observation at one instant `t`, but real
CityBikes city totals can require:

```text
many station/vehicle source timestamps
+
sequential network fetches
+
a later city composition instant
```

The brief does not define which of those times becomes `t`.

Different readings change:

- observation instant;
- expiry;
- R5 compliance;
- covered seconds;
- stored hourly averages.

The chosen resolution is causal composition at `asOf`, with every component required to be known
and provider-valid at `asOf`, and with city expiry capped at the earliest component expiry.

The cost is conservative coverage and additional explicit-validity handling.

### Additional explicit ambiguities

Two other specification edges are documented but are not needed to satisfy the brief's minimum
“one pair + one underspecification” requirement:

- **R6 bootstrap authorization:** the first runtime budget headers cannot be read until after a
  request has already been made. The implementation allows one durable bootstrap reservation and
  fails closed afterward if trustworthy metadata is unavailable.
- **R5 window and observation semantics:** the implementation uses rolling windows and treats a
  causal recomposition from still-valid component evidence as a new city-level observation at
  `asOf`, without renewing the component validity.

These interpretations are stated here so the implementation does not silently rely on them.

## Remaining Open Questions

- A production policy for small future provider timestamps / clock skew beyond the current
  causal-validity checks.
