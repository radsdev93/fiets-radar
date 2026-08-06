## Method

* **Workflow:** Strict Test-Driven Development (TDD). I used AI to generate the test suites based on the provided Golden Test Vector and edge cases first, ensuring the tests failed. Then, I prompted the AI to write the implementation to turn the tests green.
* **Prompting Strategy:** Targeted, single-file prompts. I deliberately withheld the full system context (like API rate limits) from the AI when generating the Math Engine to ensure strict boundary decoupling. 
* **Design Storage:** The system architecture and API constraints were kept in `DECISIONS.md` and my own head. The AI was treated strictly as a localized executor, not a system architect.

## Tools

* **Assistant/Tool:** VSCode Codex Extension
* **Model & Settings:** GPT-5.6 Terra (configured with High reasoning level)
* **Estimated Share of Code Produced:** ~70% (boilerplate, tests, and modular utility logic), with architectural design, mathematical validation, and manual overrides performed entirely by hand.

### Edge Case Verification: Pre-Hour Superseded Observations

* **Scenario:** I designed an edge-case test in `tests/golden-vector.test.ts` where multiple observations occur before the hour start boundary, with earlier ones being superseded before `intervalStart`.
* **Reasoning:** I wanted to verify that the AI's validity clipping logic (`Math.min` / `Math.max` bounds) did not accidentally leak superseded seconds or drop valid overlapping seconds across the hour boundary.
* **Outcome:** The generated aggregator logic correctly calculated 0 seconds for the superseded observation and accurately clipped the active observation to the hour start without requiring modification.

## AI Failures

### 1. Violation of the "No Average Rather Than Zero" Rule

* **What it produced:**
  When calculating the hourly average for an hour with 0 covered seconds, the AI generated:
  `const averageFreeBikes = coveredSeconds === 0 ? 0 : weightedBikes / coveredSeconds;`
* **How I noticed:**
  I checked the requirement in Section 2 of the spec which explicitly states: *"If nothing covers the hour, store no average rather than zero."* Returning the number `0` implies that a station had zero free bikes, which is mathematically false and would poison the data pipeline with fabricated inventory. 
* **What I replaced it with:**
  I updated the `HourlyResult` interface to type `averageFreeBikes` as `number | null`, and changed the logic to return `null` when `coveredSeconds === 0`.
* **Evidence my version is better:**
  My version accurately reflects missing external data (`null`) rather than hallucinating a physical state of zero bikes. I added a Jest test specifically asserting that expired observations result in a `null` average to prevent regressions.