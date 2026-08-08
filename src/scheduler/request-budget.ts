import type { RateLimitState } from "../citybikes/rate-limit-headers";
import type {
  PersistedRequestBudgetState,
  SqliteStore,
} from "../storage/sqlite-store";

export type RequestBudgetReservationResult =
  | { kind: "permitted"; permitKind: "bootstrap" | "established" }
  | {
      kind: "blocked";
      reason: "bootstrap-pending" | "exhausted" | "budget-unknown";
      resetAt: Date | null;
    };

export class RequestBudgetController {
  constructor(private readonly store: SqliteStore) {}

  reserve(now: Date): RequestBudgetReservationResult {
    const state = this.store.getRequestBudgetState();

    if (state.kind === "unknown") {
      return this.reserveBootstrap();
    }

    if (state.kind === "bootstrap-pending") {
      return {
        kind: "blocked",
        reason: "bootstrap-pending",
        resetAt: null,
      };
    }

    if (state.kind === "established") {
      if (now.getTime() >= state.resetAt.getTime()) {
        return this.reserveBootstrap();
      }

      if (state.remaining === 0) {
        return {
          kind: "blocked",
          reason: "exhausted",
          resetAt: new Date(state.resetAt.getTime()),
        };
      }

      this.store.saveRequestBudgetState({
        kind: "established",
        limit: state.limit,
        remaining: state.remaining - 1,
        resetAt: state.resetAt,
      });
      return { kind: "permitted", permitKind: "established" };
    }

    if (state.resetAt !== null && now.getTime() >= state.resetAt.getTime()) {
      return this.reserveBootstrap();
    }

    return {
      kind: "blocked",
      reason: "budget-unknown",
      resetAt: state.resetAt === null ? null : new Date(state.resetAt.getTime()),
    };
  }

  observeRateLimit(rateLimit: RateLimitState, observedAt: Date): void {
    this.store.saveRequestBudgetState({
      kind: "established",
      limit: rateLimit.limit,
      remaining: rateLimit.remaining,
      resetAt: new Date(
        observedAt.getTime() + rateLimit.resetAfterSeconds * 1_000,
      ),
    });
  }

  failClosed(): void {
    const state = this.store.getRequestBudgetState();

    if (state.kind === "established") {
      this.store.saveRequestBudgetState({
        kind: "fail-closed",
        resetAt: state.resetAt,
      });
      return;
    }

    if (state.kind === "fail-closed") {
      this.store.saveRequestBudgetState(state);
      return;
    }

    this.store.saveRequestBudgetState({ kind: "fail-closed", resetAt: null });
  }

  getState(): PersistedRequestBudgetState {
    return this.store.getRequestBudgetState();
  }

  private reserveBootstrap(): RequestBudgetReservationResult {
    this.store.saveRequestBudgetState({ kind: "bootstrap-pending" });
    return { kind: "permitted", permitKind: "bootstrap" };
  }
}
