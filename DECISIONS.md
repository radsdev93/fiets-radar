# Architectural Decisions & Spec Resolutions

This document tracks the underspecified requirements and contradictions found in the initial brief, along with the mathematical proofs and decisions made to resolve them.

## Technical Stack & Scaffolding

**Context:** The project requires a modern TypeScript environment with strict typing, runtime boundary validation, local storage that survives a `kill -9`, and Jest for testing.

**Decision:** Initialized with Node 24, TypeScript (downgraded to v6), `ts-jest`, `zod`, and `better-sqlite3`.

**Consequences:**
- Downgrading TypeScript to v6 was necessary to resolve an unresolvable peer-dependency conflict with `ts-jest`, ensuring a stable test environment.
- `zod` is chosen to strictly validate all untrusted external API data at the boundary, ensuring no invalid shapes enter the pipeline.
- `better-sqlite3` is chosen as the storage layer. It provides synchronous, robust file-based storage that requires zero external infrastructure while guaranteeing data survives a hard kill midway through an hour.