import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import type { RateLimitState } from "../src/citybikes/rate-limit-headers";
import { RequestBudgetController } from "../src/scheduler/request-budget";
import {
  SqliteStore,
  type PersistedRequestBudgetState,
} from "../src/storage/sqlite-store";

function at(time: string): Date {
  return new Date(`2026-08-08T${time}Z`);
}

function rateLimit(
  remaining: number,
  resetAfterSeconds = 3_600,
): RateLimitState {
  return { limit: 300, remaining, resetAfterSeconds };
}

function withTemporaryStore(action: (store: SqliteStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "fiets-radar-budget-"));
  const store = new SqliteStore(join(directory, "store.sqlite"));

  try {
    action(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function establishedState(
  controller: RequestBudgetController,
): Extract<PersistedRequestBudgetState, { kind: "established" }> {
  const state = controller.getState();

  if (state.kind !== "established") {
    throw new Error("Expected established request-budget state");
  }

  return state;
}

describe("RequestBudgetController", () => {
  it("treats a fresh store as unknown", () => {
    withTemporaryStore((store) => {
      expect(new RequestBudgetController(store).getState()).toStrictEqual({ kind: "unknown" });
    });
  });

  it("issues exactly one initial bootstrap permit", () => {
    withTemporaryStore((store) => {
      const controller = new RequestBudgetController(store);

      expect(controller.reserve(at("12:00:00"))).toStrictEqual({
        kind: "permitted",
        permitKind: "bootstrap",
      });
      expect(controller.getState()).toStrictEqual({ kind: "bootstrap-pending" });
    });
  });

  it("blocks a second bootstrap reservation while pending", () => {
    withTemporaryStore((store) => {
      const controller = new RequestBudgetController(store);
      controller.reserve(at("12:00:00"));

      expect(controller.reserve(at("12:00:01"))).toStrictEqual({
        kind: "blocked",
        reason: "bootstrap-pending",
        resetAt: null,
      });
    });
  });

  it("keeps bootstrap-pending across a close and reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "fiets-radar-budget-"));
    const databasePath = join(directory, "store.sqlite");
    const firstStore = new SqliteStore(databasePath);

    try {
      new RequestBudgetController(firstStore).reserve(at("12:00:00"));
      firstStore.close();

      const reopenedStore = new SqliteStore(databasePath);
      try {
        expect(new RequestBudgetController(reopenedStore).reserve(at("12:00:01"))).toStrictEqual({
          kind: "blocked",
          reason: "bootstrap-pending",
          resetAt: null,
        });
      } finally {
        reopenedStore.close();
      }
    } finally {
      firstStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists bootstrap discovery with the provider reset instant", () => {
    withTemporaryStore((store) => {
      const controller = new RequestBudgetController(store);
      controller.reserve(at("12:30:00"));
      controller.observeRateLimit(
        { limit: 300, remaining: 299, resetAfterSeconds: 1_800 },
        at("12:30:00"),
      );

      expect(controller.getState()).toStrictEqual({
        kind: "established",
        limit: 300,
        remaining: 299,
        resetAt: at("13:00:00"),
      });
    });
  });

  it("uses provider-reported remaining exactly", () => {
    withTemporaryStore((store) => {
      const controller = new RequestBudgetController(store);
      controller.reserve(at("12:00:00"));
      controller.observeRateLimit(rateLimit(250), at("12:00:00"));

      expect(establishedState(controller).remaining).toBe(250);
    });
  });

  it("durably decrements established permits and reconciles the next provider value", () => {
    withTemporaryStore((store) => {
      const controller = new RequestBudgetController(store);
      controller.reserve(at("12:00:00"));
      controller.observeRateLimit(rateLimit(2), at("12:00:00"));

      expect(controller.reserve(at("12:01:00"))).toStrictEqual({
        kind: "permitted",
        permitKind: "established",
      });
      expect(establishedState(controller).remaining).toBe(1);
      controller.observeRateLimit(rateLimit(1), at("12:01:00"));

      expect(controller.reserve(at("12:02:00"))).toStrictEqual({
        kind: "permitted",
        permitKind: "established",
      });
      expect(establishedState(controller).remaining).toBe(0);
    });
  });

  it("blocks an exhausted established budget before reset", () => {
    withTemporaryStore((store) => {
      const controller = new RequestBudgetController(store);
      controller.reserve(at("12:00:00"));
      controller.observeRateLimit(rateLimit(0), at("12:00:00"));

      expect(controller.reserve(at("12:01:00"))).toStrictEqual({
        kind: "blocked",
        reason: "exhausted",
        resetAt: at("13:00:00"),
      });
    });
  });

  it("keeps an established decrement after a close and reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "fiets-radar-budget-"));
    const databasePath = join(directory, "store.sqlite");
    const firstStore = new SqliteStore(databasePath);

    try {
      const firstController = new RequestBudgetController(firstStore);
      firstController.reserve(at("12:00:00"));
      firstController.observeRateLimit(rateLimit(5), at("12:00:00"));
      firstController.reserve(at("12:01:00"));
      firstStore.close();

      const reopenedStore = new SqliteStore(databasePath);
      try {
        expect(establishedState(new RequestBudgetController(reopenedStore)).remaining).toBe(4);
      } finally {
        reopenedStore.close();
      }
    } finally {
      firstStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reconciles shared external budget changes without a second local decrement", () => {
    withTemporaryStore((store) => {
      const controller = new RequestBudgetController(store);
      controller.reserve(at("12:00:00"));
      controller.observeRateLimit(rateLimit(10), at("12:00:00"));
      controller.reserve(at("12:01:00"));
      expect(establishedState(controller).remaining).toBe(9);
      controller.observeRateLimit(rateLimit(6), at("12:01:00"));

      expect(establishedState(controller).remaining).toBe(6);
    });
  });

  it("starts a new bootstrap at the reset boundary without refilling the old limit", () => {
    withTemporaryStore((store) => {
      const controller = new RequestBudgetController(store);
      controller.reserve(at("12:00:00"));
      controller.observeRateLimit(rateLimit(5, 600), at("12:00:00"));

      expect(controller.reserve(at("12:10:00"))).toStrictEqual({
        kind: "permitted",
        permitKind: "bootstrap",
      });
      expect(controller.getState()).toStrictEqual({ kind: "bootstrap-pending" });
    });
  });

  it("blocks a second reset-window bootstrap while it is pending", () => {
    withTemporaryStore((store) => {
      const controller = new RequestBudgetController(store);
      controller.reserve(at("12:00:00"));
      controller.observeRateLimit(rateLimit(5, 600), at("12:00:00"));
      controller.reserve(at("12:10:00"));

      expect(controller.reserve(at("12:10:01"))).toStrictEqual({
        kind: "blocked",
        reason: "bootstrap-pending",
        resetAt: null,
      });
    });
  });

  it("fails closed after an unresolved bootstrap", () => {
    withTemporaryStore((store) => {
      const controller = new RequestBudgetController(store);
      controller.reserve(at("12:00:00"));
      controller.failClosed();

      expect(controller.getState()).toStrictEqual({ kind: "fail-closed", resetAt: null });
      expect(controller.reserve(at("12:01:00"))).toStrictEqual({
        kind: "blocked",
        reason: "budget-unknown",
        resetAt: null,
      });
    });
  });

  it("keeps fail-closed bootstrap state across a close and reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "fiets-radar-budget-"));
    const databasePath = join(directory, "store.sqlite");
    const firstStore = new SqliteStore(databasePath);

    try {
      const firstController = new RequestBudgetController(firstStore);
      firstController.reserve(at("12:00:00"));
      firstController.failClosed();
      firstStore.close();

      const reopenedStore = new SqliteStore(databasePath);
      try {
        expect(new RequestBudgetController(reopenedStore).reserve(at("12:01:00"))).toStrictEqual({
          kind: "blocked",
          reason: "budget-unknown",
          resetAt: null,
        });
      } finally {
        reopenedStore.close();
      }
    } finally {
      firstStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves resetAt after an established reservation fails closed", () => {
    withTemporaryStore((store) => {
      const controller = new RequestBudgetController(store);
      controller.reserve(at("12:00:00"));
      controller.observeRateLimit(rateLimit(2, 600), at("12:00:00"));
      controller.reserve(at("12:01:00"));
      expect(establishedState(controller).remaining).toBe(1);
      controller.failClosed();

      expect(controller.getState()).toStrictEqual({
        kind: "fail-closed",
        resetAt: at("12:10:00"),
      });
    });
  });

  it("blocks established fail-closed state before reset", () => {
    withTemporaryStore((store) => {
      const controller = new RequestBudgetController(store);
      controller.reserve(at("12:00:00"));
      controller.observeRateLimit(rateLimit(2, 600), at("12:00:00"));
      controller.reserve(at("12:01:00"));
      controller.failClosed();

      expect(controller.reserve(at("12:05:00"))).toStrictEqual({
        kind: "blocked",
        reason: "budget-unknown",
        resetAt: at("12:10:00"),
      });
    });
  });

  it("allows exactly one bootstrap after a preserved fail-closed reset", () => {
    withTemporaryStore((store) => {
      const controller = new RequestBudgetController(store);
      controller.reserve(at("12:00:00"));
      controller.observeRateLimit(rateLimit(2, 600), at("12:00:00"));
      controller.reserve(at("12:01:00"));
      controller.failClosed();

      expect(controller.reserve(at("12:10:00"))).toStrictEqual({
        kind: "permitted",
        permitKind: "bootstrap",
      });
      expect(controller.reserve(at("12:10:01"))).toStrictEqual({
        kind: "blocked",
        reason: "bootstrap-pending",
        resetAt: null,
      });
    });
  });

  it("treats provider remaining zero as an exhausted known state", () => {
    withTemporaryStore((store) => {
      const controller = new RequestBudgetController(store);
      controller.reserve(at("12:00:00"));
      controller.observeRateLimit(rateLimit(0), at("12:00:00"));

      expect(controller.reserve(at("12:01:00"))).toStrictEqual({
        kind: "blocked",
        reason: "exhausted",
        resetAt: at("13:00:00"),
      });
    });
  });

  it("starts bootstrap at an immediate provider reset", () => {
    withTemporaryStore((store) => {
      const controller = new RequestBudgetController(store);
      controller.reserve(at("12:00:00"));
      controller.observeRateLimit(rateLimit(0, 0), at("12:00:00"));

      expect(controller.reserve(at("12:00:00"))).toStrictEqual({
        kind: "permitted",
        permitKind: "bootstrap",
      });
    });
  });

  it("fails closed for a malformed persisted established state", () => {
    const directory = mkdtempSync(join(tmpdir(), "fiets-radar-budget-"));
    const databasePath = join(directory, "store.sqlite");
    const schemaStore = new SqliteStore(databasePath);

    try {
      schemaStore.close();
      const rawDatabase = new Database(databasePath);

      try {
        rawDatabase
          .prepare<[string, number, null, number]>(`
            INSERT INTO request_budget_state (
              state_id,
              state_kind,
              limit_value,
              remaining_value,
              reset_at
            ) VALUES (1, ?, ?, ?, ?)
          `)
          .run("established", 300, null, at("13:00:00").getTime());
      } finally {
        rawDatabase.close();
      }

      const store = new SqliteStore(databasePath);
      try {
        const controller = new RequestBudgetController(store);

        expect(controller.getState()).toStrictEqual({
          kind: "fail-closed",
          resetAt: at("13:00:00"),
        });
        expect(controller.reserve(at("12:59:59"))).toStrictEqual({
          kind: "blocked",
          reason: "budget-unknown",
          resetAt: at("13:00:00"),
        });
        expect(controller.reserve(at("13:00:00"))).toStrictEqual({
          kind: "permitted",
          permitKind: "bootstrap",
        });
        expect(controller.reserve(at("13:00:01"))).toStrictEqual({
          kind: "blocked",
          reason: "bootstrap-pending",
          resetAt: null,
        });
      } finally {
        store.close();
      }
    } finally {
      schemaStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
