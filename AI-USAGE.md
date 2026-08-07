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
- **Role:** External analysis and documentation assistant.
- **Code contribution:** 0%.
- **Usage:** Used to analyze captured CityBikes API evidence, cross-check reasoning against the assignment, and help draft and refine project documentation. Provider claims were verified against the raw captured evidence before being incorporated into the repository.

## Method

### Development workflow

I used a test-first approach for behavior explicitly defined by the specification.

The golden-vector test was committed in a failing state before the aggregation implementation existed. Codex was then asked to implement the smallest isolated function needed to satisfy that test.

After the initial implementation, I used review-driven edge-case tests:

- the pre-hour supersession scenario was added to verify existing boundary behavior and passed without requiring an implementation change;
- the zero-coverage scenario was added after reviewing the implementation against the written requirement and accompanied the correction from `0` to `null`.

This is therefore not strict TDD for every committed line. It is test-first development for specified behavior, followed by adversarial review and regression testing.

### Prompting strategy

I used narrow, task-focused prompts instead of asking the assistant to generate the complete service.

For the aggregation module, I intentionally omitted unrelated concerns such as:

- HTTP behavior;
- provider rate limits;
- storage;
- scheduling.

This kept the function independent and made its output directly testable.

As the project expands, prompts are intended to remain scoped to one boundary or coherent change at a time.

### Design storage

Specification interpretations and architectural choices are recorded in `DECISIONS.md`.

Measured provider behavior is recorded separately in `docs/api-findings.md`.

Implementation prompts are based on those documents rather than asking the assistant to make undocumented product or architecture decisions.

### Use of external analysis and documentation support

I also used ChatGPT for evidence analysis and documentation support. I did not use it to generate implementation code.

For provider behavior, AI analysis was treated as a way to identify patterns and questions to verify, not as evidence itself. Claims recorded in `docs/api-findings.md` are based on the captured response files.

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

---

## Remaining Required Entries

The following sections will be completed only when genuine qualifying examples occur:

* two additional assistant failures that type-check and look plausible;
* a piece written manually because the assistant repeatedly failed to produce a satisfactory result;
* a workable assistant suggestion that I deliberately rejected;
* the part of the final repository I trust least and what evidence would increase confidence.

I will not manufacture examples solely to fill these sections.
