# AI Usage

This document records how the implementation assistant was used, the work it produced, and the cases where its output required human verification or correction.

It is updated during development rather than reconstructed at the end.

## Tools

### VS Code Codex Extension

- **Model & settings:** GPT-5.6 Terra, High reasoning
- **Role:** Primary implementation assistant.
- **Code contribution:** Roughly 99% of the final submitted TypeScript/Jest implementation was initially generated through Codex prompts and then reviewed before commit.

### ChatGPT

- **Model & settings:** GPT-5.6 Sol, High reasoning
- **Role:** External review and analysis assistant.
- **Code contribution:** <1% of the final submitted TypeScript/Jest tree. One final TypeScript instance-type annotation was corrected from `Database` to `Database.Database` after switching to the maintained `@types/better-sqlite3` declarations. ChatGPT also supplied an experimental global-request-pacing prototype during benchmark tuning; that experiment was committed for measurement and later reverted after it regressed the benchmark, so it is visible in Git history but is not part of the final submitted implementation.
- **Usage:** Used as an external second-pass analysis/review assistant for specification interpretation, documentation, captured API evidence, scheduler review, and benchmark-design review. Provider claims were checked against captured evidence before being incorporated into the repository.

## Method

### Development workflow

I used a test-first approach for behavior explicitly defined by the specification.

The golden-vector test was committed in a failing state before the aggregation implementation existed. Codex was then asked to implement the smallest isolated function needed to satisfy that test.

After the initial implementation, I used review-driven edge-case tests:

- the pre-hour supersession scenario was added to verify existing boundary behavior and passed without requiring an implementation change;
- the zero-coverage scenario was added after reviewing the implementation against the written requirement and accompanied the correction from `0` to `null`.

This is therefore not strict TDD for every committed line. It is test-first development for specified behavior, followed by adversarial review and regression testing.

The same pattern was later applied to provider-boundary work. Timestamp parsing, Zod response validation, rate-limit parsing, and the HTTP client were developed as small behavioral slices. For several slices I committed an intentionally failing contract before the implementation that made it green.

I also reviewed the tests themselves before treating a RED contract as complete. Two examples were:

- the response-schema contract was strengthened to accept an unknown non-empty vehicle `kind`, preventing a plausible implementation from hard-coding only the currently observed `bike`, `ebike`, and `scooter` values at the structural validation layer;
- the HTTP-client contract was strengthened so an HTTP 200 response with unusable rate-limit metadata and malformed JSON must return `invalid-rate-limit`, proving that budget validation takes precedence over body decoding.

These were review refinements, not assistant failures: the implementation had not yet been written. The purpose was to make the behavioral contract precise enough that a later green implementation could not pass while violating an architectural decision.

### Prompting strategy

I used narrow, task-focused prompts instead of asking the assistant to generate the complete service.

For the aggregation module, I intentionally omitted unrelated concerns such as:

- HTTP behavior;
- provider rate limits;
- storage;
- scheduling.

This kept the function independent and made its output directly testable.

As the project expanded, prompts remained scoped to one boundary or coherent change at a time. Later prompts explicitly listed concerns that were out of scope, required existing tests to remain unchanged during the GREEN step, and asked the assistant to report test/type-check/diff results before I committed the change.

This made it easier to distinguish a correct implementation from scope creep. For example, the HTTP-client prompt prohibited retries, scheduling, bicycle normalization, persistence, and timing logic; those responsibilities remain separate modules.

### Later RED/GREEN workflow adjustment

As the deadline approached, I reduced assistant-call overhead for larger but still coherent modules. Instead of using separate assistant invocations for RED and GREEN, I required one prompt to perform the phases in order:

1. create focused tests and only the minimum stubs needed to compile;
2. run the full suite and report the actual failing RED state;
3. implement the minimum production behavior;
4. rerun the full suite for GREEN;
5. run type checking and diff checks;
6. stop without staging or committing so I could review the complete result.

For the city configuration and network normalizer slice, the reported RED state was 81 tests total with 62 passing and 19 failing; after implementation the same suite was 81/81 green.

This workflow is still test-first, but the RED and GREEN executions happen inside one assistant invocation rather than as separate Git commits. I do not reconstruct artificial failing commits after the implementation already exists. Earlier repository history retains several separate RED/GREEN commits, while later coherent modules commit their tests together with the implementation.

The tradeoff is that I cannot review the generated test file between the assistant's RED execution and its implementation. I mitigate that by deciding the behavioral contract before prompting, requiring the assistant to report both phases, and reviewing the tests and implementation together before committing.

The scheduler slice is an example of why I keep the reported execution history rather than reconstructing a cleaner story afterward. The first scheduler RED run contained 153 tests total: 141 existing tests passed and 12 new scheduler tests failed. The assistant's first final GREEN report contained 154 passing tests because one additional scheduler test (`invalid-rate-limit` fail-closed behavior) had been added after that initial RED run. I did not recreate an artificial 13-test RED state. Later second-pass review added genuine focused regressions from the then-green scheduler: 154→158 tests produced 4 RED failures, and a final deadline-pacing review produced a genuine 158→160 test RED with 2 failures. The final scheduler checkpoint is 160/160 green.


### Trace, benchmark, and recovery workflow

The trace/benchmark phase produced an important correction to my own prompting process.

My first benchmark prompt asked for a compact normalized trace because I was optimizing for deterministic replay and file size. Codex implemented that design successfully, but a later reread of section 5 showed that the assignment explicitly requires the recorded fetch instant, HTTP status, headers, and body. The implementation was therefore replaced with a V2 raw trace instead of treating prompt compliance as specification compliance.

That phase also exposed several cases where passing tests were not enough to trust the experimental design:

- the first replay made a complete round visible from `roundAt`, which could expose a response captured later in the sequential sweep;
- benchmark evaluation initially allowed the scheduler to consume a newly available trace checkpoint before scoring against that same checkpoint;
- the first MAE compared instantaneous bike counts, while the brief requires stored hourly averages against trace ground truth;
- staleness was initially sampled at trace-only events as well as regular evaluation ticks;
- the first R5 metric measured time after observations rather than the share of complete rolling five-minute windows containing an observation.

I treated these as benchmark-design corrections, not all as separate Codex failures. Several arose because my prompt itself encoded the wrong or incomplete interpretation. The fix was to go back to the brief, define the benchmark semantics precisely, add focused regression tests, and keep the measured RED/GREEN transitions.

The relevant later checkpoints were:

```text
compact trace/replay slice:
  RED   168 total / 160 passed / 8 failed
  GREEN 168 / 168

causality correction:
  RED   171 total / 167 passed / 4 failed
  GREEN 171 / 171

metric correction:
  RED   174 total / 171 passed / 3 failed
  GREEN 174 / 174

runtime / SIGKILL / results slice:
  RED   179 total / 174 passed / 5 failed
  GREEN 179 / 179
```

The V2 replay feeds recorded raw responses back through the real CityBikes client and Zod boundary instead of typing recorded JSON through an assertion.

For R7, the generated test uses a real child process and file-backed SQLite database. It waits for an IPC `READY` signal, sends `SIGKILL` only to the exact child it spawned, restarts a second process against the same database, intentionally replays one duplicate observation, and verifies the final aggregate and persisted observation count. There are no real network calls or timer sleeps in that test.

### Design storage

Specification interpretations and architectural choices are recorded in `DECISIONS.md`.

Measured provider behavior is recorded separately in `docs/api-findings.md`.

Implementation prompts are based on those documents rather than asking the assistant to make undocumented product or architecture decisions.

### Use of external review

I also used ChatGPT as a second-pass reviewer for documentation, architectural reasoning, and exploratory analysis of the captured API evidence. It was not used as the primary implementation generator. One later TypeScript instance-type annotation was changed from `Database` to `Database.Database` following its review after the switch to maintained `better-sqlite3` typings.

For provider behavior, the assistant's analysis was treated as a way to identify questions and patterns to verify, not as a source of truth. Claims recorded in `docs/api-findings.md` are based on the captured response files themselves.

---

## Verification: Pre-Hour Superseded Observations

### Scenario

I added an edge-case test in `tests/golden-vector.test.ts` with multiple observations before the hour boundary.

An earlier pre-hour observation is superseded before `intervalStart`, while the most recent pre-hour observation remains valid into the target hour.

### Reasoning

I wanted to verify that the generated clipping logic did not:

- count seconds belonging to the superseded observation;
- discard the latest valid pre-hour observation;
- include time before the target hour.

### Outcome

The initial aggregator correctly assigned zero seconds to the superseded observation and clipped the active observation to the hour boundary.

No implementation change was required for this scenario.

---

## AI Failures

### 1. Returned Zero Instead of No Average

#### What it produced

For an hour with zero covered seconds, the initial implementation generated:

```ts
const averageFreeBikes =
  coveredSeconds === 0 ? 0 : weightedBikes / coveredSeconds;
```

The code compiled, passed the original golden-vector test, and looked locally reasonable.

#### How I noticed

During review, I compared the zero-coverage behavior with the explicit requirement:

> If nothing covers the hour, store no average rather than zero.

Returning `0` would claim that valid measurements showed zero free bikes. In reality, the service had no valid measurement for the hour.

That distinction affects consumers and stored historical data.

#### What I replaced it with

I changed the result type to allow:

```ts
averageFreeBikes: number | null;
```

and changed the calculation to:

```ts
const averageFreeBikes =
  coveredSeconds === 0 ? null : weightedBikes / coveredSeconds;
```

The return logic rounds only numeric values.

#### Evidence that the replacement is better

I added a Jest regression test where all observations expire before the target hour.

The expected result is:

```ts
{
  coveredSeconds: 0,
  averageFreeBikes: null,
  coverage: 0,
  partial: true
}
```

The test now distinguishes:

* `0`: a measured state with no free bikes;
* `null`: no valid data from which an average can be calculated.

### 2. Malformed Persisted Budget State Failed Open

#### What it produced

The initial persistent request-budget implementation decoded a missing row and an unrecognized or internally inconsistent row through the same fallback:

```ts
return { kind: "unknown" };
```

The code type-checked and all 140 tests passed.

That looked plausible because `unknown` was also the legitimate state for a fresh database.

#### How I noticed

During review of the R6 hard invariant, I followed the fallback into the controller.

`unknown` is not a blocked state: it authorizes exactly one bootstrap request.

Therefore a persisted row such as an `established` state with a missing `remaining` value would be interpreted as fresh/unknown state and could authorize another provider request.

That is fail-open behavior in the component whose purpose is to fail closed when request-budget state cannot be trusted.

#### What I replaced it with

I kept **absence of a row** as the legitimate `unknown` state.

If a row exists but cannot be safely decoded as `unknown`, `bootstrap-pending`, `established`, or `fail-closed`, it now becomes:

```ts
{
  kind: "fail-closed",
  resetAt
}
```

A valid persisted reset boundary is preserved when available; otherwise `resetAt` is `null`.

The established state is also checked for a positive safe-integer limit, a safe-integer remaining count, `0 <= remaining <= limit`, and a valid reset timestamp.

#### Evidence that the replacement is better

I added a hostile regression test that creates the SQLite schema normally, then uses `better-sqlite3` directly in the test to insert an intentionally inconsistent persisted row:

```text
state_kind      = established
limit_value     = 300
remaining_value = NULL
reset_at        = 13:00
```

Before the fix, the test observed `{ kind: "unknown" }` and failed.

After the fix, it verifies:

- the row is interpreted as `fail-closed`;
- the known reset is preserved;
- requests before the reset are blocked as `budget-unknown`;
- exactly one new bootstrap may be reserved at the reset boundary.

The regression produced a genuine RED state of 141 tests total, 140 passing and 1 failing, followed by 141/141 GREEN.


### 3. Scheduler Treated Provider-Stale Data as New/Useful State

#### What it produced

The first adaptive scheduler implementation assumed that a successful normalization result was useful for current scheduling.

Two consequences looked plausible in isolation:

1. if no previous usable snapshot existed, a successfully normalized response was classified as `freshness-refresh`;
2. if `freeBikes` differed from the cached value, it was classified as `availability-change`.

The code type-checked and the initial scheduler suite reached 154/154 passing tests.

#### How I noticed

During review I followed the provider timestamps rather than the HTTP completion time.

The network normalizer deliberately allows historical intervals to normalize successfully for persistence/replay. A response fetched at 12:20 could therefore normalize to a provider-backed interval ending at 12:15. That is valid historical data, but it is not usable current state and should not count as a freshness refresh.

I also checked the existing storage rule that a later HTTP fetch can contain **older provider state** than a still-usable cached snapshot. The initial scheduler compared the changed bike count before proving that the provider state was not older. A response containing an older provider timestamp and a different count could therefore be reported as a new availability change and cause more aggressive polling.

Both mistakes conflated:

```text
successful HTTP / normalization
```

with:

```text
new provider-backed information usable now
```

#### What I replaced it with

Successful normalized snapshots are still persisted as historical evidence.

Before classifying one as useful for current scheduling, the scheduler now requires:

```text
validFrom <= fetchedAt < validUntil
```

An already-expired normalized interval is classified as `failure`.

If a currently usable normalized response has a `validFrom` earlier than the previous usable provider state, it is classified as `redundant` even when the numeric bike count differs.

Only non-regressing provider state can produce a new availability-change classification.

#### Evidence that the replacement is better

Second-pass review added four focused scheduler regressions from the 154-test green baseline.

The resulting genuine RED state was:

```text
158 total
154 passed
4 failed
```

The failures included:

- already-expired normalized provider state being treated as useful;
- older provider state with a changed count being treated as an availability change;
- two cases where capacity pacing was overridden by expiry-safety deadlines.

After the focused corrections the suite reached 158/158 green.

A later review found that a near-expiry snapshot could still pull an actual deadline earlier than a known sustainable floor even when global `capacityInsufficient` was false. Two more test-first regressions produced:

```text
160 total
158 passed
2 failed
```

The shared deadline helper now ensures expiry protection cannot make the scheduler intentionally poll earlier than the known runtime sustainable pacing floor. The final scheduler checkpoint is 160/160 green.

The provider-staleness classification issue is the AI failure recorded here. The pacing corrections are related scheduler review corrections, but I do not count them as separate assistant failures merely to increase the failure count.

---

## Workable Assistant Suggestion Rejected

### Local `better-sqlite3` Type Declaration

During the SQLite persistence slice, Codex generated a small local ambient declaration file for `better-sqlite3`.

The suggestion was workable in the narrow sense that the project compiled with it and all 120 tests passed. It was also understandable given that my implementation prompt explicitly prohibited adding dependencies.

I rejected the local declaration during review. Maintaining a handwritten partial declaration would make the project responsible for describing a third-party library API that TypeScript would trust without checking against the package itself.

I replaced it with the maintained `@types/better-sqlite3` development dependency.

That replacement exposed a real typing difference: the database instance field needed to use the package's `Database.Database` instance type rather than `Database`. After that small correction, `npx tsc --noEmit` passed and the full 120-test suite remained green.

This was not classified as an assistant failure because the original solution satisfied the prompt and worked. It was a deliberate maintainability/type-safety tradeoff made during review.

---

## Least-Trusted Final Area

The part I trust least is the **adaptive scheduler policy** because it is the most heuristic component and has the largest gap between deterministic unit-test correctness and control-loop quality on real provider behavior.

The core safety boundaries around it are stronger:

- request authorization is persisted before the HTTP request;
- runtime provider remaining values are authoritative;
- malformed budget state fails closed;
- provider snapshots retain explicit validity;
- the scheduler is globally single-request-in-flight;
- R5 compliance is measured rather than inferred from the target cadence.

The final V2 benchmark made that distinction concrete.

Against the same raw trace and virtual request budget:

```text
original adaptive:
  requests             255
  mean staleness       179.756 s
  p95 staleness        292.352 s
  redundant ratio      0.117647
  R5 compliance        1.000000
  hourly-average MAE   3.486667

fixed:
  requests             295
  mean staleness       108.275 s
  p95 staleness        188.385 s
  redundant ratio      0.050847
  R5 compliance        1.000000
  hourly-average MAE   1.850000
```

The adaptive scheduler therefore saves requests and ties R5 compliance, but loses the measured staleness, redundancy, and hourly-average-error metrics.

I did not tune the benchmark inputs or hide the loss.

Two subsequent evidence-driven scheduler experiments used the same trace, budget, fixed baseline, and metric definitions. Both measured worse on overall quality and were reverted. The final submitted scheduler is therefore the original, simpler heuristic rather than the most recently attempted tuning.

This is the main area I would continue investigating with additional independent traces if this were a production system.

---

## Something Written by Hand

After the first real V2 benchmark, the AI-assisted scheduler had passed the deterministic suite but still won only the request-count metric and lost the quality metrics.

At that point I wrote the first benchmark-driven scheduler experiment and its focused regression test by hand rather than asking the implementation assistant to produce another heuristic.

The change separated two ideas that the previous AI-assisted policy treated too similarly:

```text
semantic usefulness:
  same count + newer provider freshness is useful

availability volatility:
  repeated same-count freshness is still evidence that bike availability is flat
```

The handwritten experiment therefore:

- changed the initial adaptive interval from `1.5 × sustainableFloor` to the neutral sustainable floor;
- kept the first successful observation at that neutral cadence;
- applied a modest `1.25×` interval backoff to later same-count freshness refreshes;
- added a focused test proving that first observation remains neutral while successive fresh-but-flat observations progressively back off and remain classified as `freshness-refresh`.

I chose `1.25` as a deliberately modest, explainable factor between “no backoff” and the existing `2×` redundant-response backoff. I selected it before looking at the new benchmark result rather than searching constants after the fact.

### Why I think the assistant struggled

The problem was not TypeScript syntax. The difficult part was that the unit tests could verify local scheduler invariants but could not prove that the resulting feedback policy made good use of requests over real provider behavior.

The AI-assisted iterations repeatedly produced locally plausible rules:

```text
change → faster
freshness → useful
redundant → slower
```

but the real trace exposed interactions between:

- semantic usefulness and numerical volatility;
- source freshness and unchanged bike counts;
- the equal-share sustainable floor;
- trace update resolution;
- multi-resource city staleness;
- request savings versus where those saved requests are spent.

Those interactions are control-policy behavior rather than ordinary branch correctness, so they remained weakly constrained until the real replay benchmark existed.

### What happened to the handwritten experiment

The experiment was useful because the benchmark falsified the hypothesis.

Using the same trace and budget, it reduced requests from `255` to `216` but worsened mean staleness, p95 staleness, redundant ratio, and hourly-average MAE. I therefore rejected it after measurement rather than keeping it merely because I had written it myself.

A second structural global-pacing experiment was also measured and rejected.

Both tuning commits were reverted, restoring the original heuristic for submission. The handwritten experiment remains visible in Git history and is documented in `docs/benchmark.md`.

That result changed my confidence more than another passing unit test would have: it showed that a reasonable local policy improvement can still make the end-to-end control loop worse, and that benchmark evidence must be allowed to overrule implementation intuition.
