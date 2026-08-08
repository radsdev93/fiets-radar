# AI Usage

This document records how the implementation assistant was used, the work it produced, and the cases where its output required human verification or correction.

It is updated during development rather than reconstructed at the end.

## Tools

### VS Code Codex Extension

- **Model & settings:** GPT-5.6 Terra, High reasoning
- **Role:** Primary implementation assistant.
- **Code contribution:** Produced the initial versions of tests and implementation code described throughout this document. The final approximate percentage will be calculated before submission.

### ChatGPT

- **Model & settings:** GPT-5.6 Sol, High reasoning
- **Role:** External review and analysis assistant.
- **Code contribution:** <1%. One final TypeScript instance-type annotation was corrected from `Database` to `Database.Database` after switching to the maintained `@types/better-sqlite3` declarations; implementation code otherwise came from Codex or was written/reviewed by me.
- **Usage:** Used to review documentation wording, cross-check reasoning against the assignment, and analyze captured CityBikes API evidence such as response bodies and headers. Findings were reviewed against the raw evidence before being incorporated into the repository.

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

The scheduler slice is an example of why I keep the reported execution history rather than reconstructing a cleaner story afterward. The first scheduler RED run contained 153 tests total: 141 existing tests passed and 12 new scheduler tests failed. The assistant's first final GREEN report contained 154 passing tests because one additional scheduler test (`invalid-rate-limit` fail-closed behavior) had been added after that initial RED run. I did not recreate an artificial 13-test RED state. Later human review added genuine focused regressions from the then-green scheduler: 154→158 tests produced 4 RED failures, and a final deadline-pacing review produced a genuine 158→160 test RED with 2 failures. The final scheduler checkpoint is 160/160 green.

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

Human review added four focused scheduler regressions from the 154-test green baseline.

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

## Least-Trusted Final Area So Far

The part I currently trust least is the **adaptive scheduler policy**, not because a specific known failing case remains, but because it is the most heuristic component and has the largest gap between deterministic unit tests and real provider behavior.

The core safety boundaries around it are stronger:

- request authorization is persisted before the HTTP request;
- runtime provider remaining values are authoritative;
- malformed budget state fails closed;
- provider snapshots retain explicit validity;
- the scheduler is globally single-request-in-flight.

By contrast, choices such as halving cadence after availability changes, keeping cadence after freshness-only refreshes, doubling after redundancy, using a 60-second expiry margin, and deriving a sustainable per-network floor are deliberately simple heuristics.

The evidence that would increase my confidence most is the required deterministic replay benchmark over a **real recorded CityBikes trace**, using the same request budget for both the adaptive policy and a dumb fixed-interval baseline. I specifically want to see:

- total requests;
- redundant-fetch ratio;
- mean and p95 staleness;
- rolling R5 compliance;
- fairness/no-starvation behavior;
- MAE against the trace-derived ground truth;
- behavior when runtime capacity becomes insufficient.

If the adaptive policy loses badly on those measurements, I would tune the heuristic rather than treating the current passing unit tests as proof that the policy is good.

## Remaining Required Entries

The following required section will be completed only if a genuine qualifying example occurs:

* a piece written manually because the assistant repeatedly failed to produce a satisfactory result.

I will not manufacture examples solely to fill these sections.
