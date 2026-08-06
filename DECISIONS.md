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
Through runtime API inspection, the global request budget is strictly 300 requests/hour, which equates to exactly 25 requests every 5 minutes. However, the 20 required cities map to 28 distinct network endpoints. Fetching 28 networks in 5 minutes mathematically guarantees exceeding the budget of 25.

**Decision:**
I am choosing to strictly enforce Requirement R6 (the budget limit) and intentionally allow Requirement R5 (the 5-minute window) to degrade. 

**Consequences:**
The service will never get banned or cause a denial of service to the provider (satisfying the spirit of R6 being a "hard ceiling"). The adaptive scheduler will be forced to stretch the polling interval for some cities beyond 5 minutes to stay under the 25-request ceiling.