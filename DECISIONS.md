# Architectural Decisions & Spec Resolutions

This document tracks the underspecified requirements and contradictions found in the initial brief, along with the mathematical proofs and decisions made to resolve them.

## Technical Stack & Scaffolding

**Context:** The project requires a modern TypeScript environment with strict typing, runtime boundary validation, local storage that survives a `kill -9`, and Jest for testing.

**Decision:** Initialized with Node 24, TypeScript (downgraded to v6), `ts-jest`, `zod`, and `better-sqlite3`.

**Consequences:**
- Downgrading TypeScript to v6 was necessary to resolve an unresolvable peer-dependency conflict with `ts-jest`, ensuring a stable test environment.
- `zod` is chosen to strictly validate all untrusted external API data at the boundary, ensuring no invalid shapes enter the pipeline.
- `better-sqlite3` is chosen as the storage layer. It provides synchronous, robust file-based storage that requires zero external infrastructure while guaranteeing data survives a hard kill midway through an hour.

## Spec Contradiction: Requirement R5 vs Requirement R6

**Context:** 
Requirement R5 mandates that every city must be observed at least once every 5-minute window. 
Requirement R6 mandates that we must never exceed the provider's discovered request budget, treating it as a "hard ceiling."

**The Proof:**
Through runtime API inspection, the global request budget is strictly 300 requests/hour, which equates to exactly 25 requests every 5 minutes. However, the 20 required cities map to 34 distinct network endpoints. Fetching 34 networks in 5 minutes mathematically guarantees exceeding the budget of 25.

**Decision:**
I am choosing to strictly enforce Requirement R6 (the budget limit) and intentionally allow Requirement R5 (the 5-minute window) to degrade. 

**Consequences:**
The service will never get banned or cause a denial of service to the provider (satisfying the spirit of R6 being a "hard ceiling"). The adaptive scheduler will be forced to stretch the polling interval for some cities beyond 5 minutes to stay under the 25-request ceiling.

## Underspecified Requirement: Expiration and "Uncovered Seconds" Gaps

**Context:**
The definition of "Hourly average" states that it is the integral of the value over the covered seconds, divided by the covered seconds, and that "uncovered seconds are excluded from both". However, it is underspecified how the system should handle the mathematical integral during a mid-hour gap where an observation's `maxStaleness` (900s) has expired, but a new observation has not yet arrived. It is ambiguous whether the system should carry forward the last known value or drop the gap entirely.

**The Proof:**
The provided Golden Test Vector proves that the data must be strictly dropped. 
In the test vector, the 11:52:00 observation (100 bikes) expires at 12:07:00, and the next observation is at 12:10:00. This creates a 180-second gap. A second gap of 1200 seconds occurs between 12:30:00 and 12:50:00. 
If we carry forward the stale values during these blackouts, the covered seconds exceed 2220 and the average skews heavily. The only way to achieve exactly 2220 covered seconds and an average of 108.11 is to completely omit these expired intervals from the time-weighted sum.

**Decision:**
The aggregation engine will strictly enforce the `[t, t + maxStaleness)` validity window. Mid-hour gaps where data has expired will be treated as mathematical voids. The integral calculation will exclusively sum intervals where the timestamp is strictly within an active validity window.

**Consequences:**
The Math Engine (Aggregator) must be designed to calculate intervals discretely rather than assuming a continuous timeline. It must explicitly calculate the start and end of every valid interval, clipping them at the `maxStaleness` boundary and the hour boundaries before calculating the integral.

## Architectural Boundary: API Client and Runtime Validation

**Context:**
The system must consume data from an untrusted third-party HTTP API. The requirements strictly forbid blind type assertions (e.g., `as NetworkResponse`) and mandate runtime validation. Furthermore, the network logic must be isolated so that the scheduling and aggregation components can be tested deterministically without real network calls.

**Decision:**
I will implement a dedicated API Fetcher component that acts as the sole network boundary.

1. **Strict Zod Parsing:** All responses from the CityBikes API will be immediately passed through strict Zod schemas.

2. **Fail-Safe Returns:** If the API returns malformed JSON or unexpected shapes, the Zod parser will throw, and the Fetcher will catch the error, returning a safe, empty state (e.g., null or a tagged error type) to the Scheduler rather than crashing the node process.

3. **Decoupled State:** The Fetcher will not maintain scheduling state; it will only execute targeted fetches and report the observed rate limit headers back to the caller.

**Consequences:**
The Math Engine and Scheduler remain completely pure and agnostic to HTTP or network errors. If the CityBikes API changes its data model unexpectedly, the system will degrade gracefully (recording 0 covered seconds for the affected window) rather than poisoning the storage with invalid types.