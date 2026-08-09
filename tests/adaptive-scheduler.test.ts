import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cityBikesResponseSchema,
} from "../src/citybikes/schemas";
import type { CityBikesFetchResult } from "../src/citybikes/client";
import type { CityConfig } from "../src/config/cities";
import { CITY_CONFIGS } from "../src/config/cities";
import {
  AdaptiveScheduler,
  type CityBikesNetworkFetcher,
  type SchedulerClock,
} from "../src/scheduler/adaptive-scheduler";
import { RequestBudgetController } from "../src/scheduler/request-budget";
import { SqliteStore } from "../src/storage/sqlite-store";

function at(time: string): Date {
  return new Date(`2026-08-08T${time}Z`);
}

class FakeClock implements SchedulerClock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(time: string): void {
    this.current = at(time);
  }

  setDate(date: Date): void {
    this.current = new Date(date.getTime());
  }
}

function city(networkIds: string[]): CityConfig[] {
  return [
    {
      city: "Test City",
      countryCode: "TC",
      networks: networkIds.map((networkId) => ({
        networkId,
        mode: "stations-only",
      })),
    },
  ];
}

function successfulFetch(
  networkId: string,
  sourceTime: string,
  freeBikes: number,
  remaining = 100,
): CityBikesFetchResult {
  return {
    kind: "success",
    networkId,
    rateLimit: { limit: 100, remaining, resetAfterSeconds: 3_600 },
    payload: cityBikesResponseSchema.parse({
      network: {
        stations: [
          {
            id: `${networkId}-station`,
            latitude: 1,
            longitude: 1,
            timestamp: `2026-08-08T${sourceTime}Z`,
            free_bikes: freeBikes,
          },
        ],
      },
    }),
  };
}

function withScheduler(
  cityConfigs: CityConfig[],
  action: (
    scheduler: AdaptiveScheduler,
    store: SqliteStore,
    budget: RequestBudgetController,
    clock: FakeClock,
  ) => Promise<void>,
  fetchNetwork: CityBikesNetworkFetcher,
  maxStalenessSeconds = 900,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "fiets-radar-scheduler-"));
  const store = new SqliteStore(join(directory, "store.sqlite"));
  const budget = new RequestBudgetController(store);
  const clock = new FakeClock(at("12:00:00"));
  const scheduler = new AdaptiveScheduler({
    cityConfigs,
    store,
    budget,
    clock,
    fetchNetwork,
    maxStalenessSeconds,
  });

  return action(scheduler, store, budget, clock).finally(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
}

describe("AdaptiveScheduler", () => {
  it("performs at most one fetch per step and reserves before fetching", async () => {
    const fetchedNetworks: string[] = [];

    await withScheduler(
      city(["network-a", "network-b"]),
      async (scheduler, _store, budget) => {
        const result = await scheduler.step();

        expect(result.kind).toBe("fetched");
        expect(fetchedNetworks).toStrictEqual(["network-a"]);
        expect(budget.getState().kind).toBe("established");
      },
      async (networkId) => {
        fetchedNetworks.push(networkId);
        return successfulFetch(networkId, "12:00:00", 5);
      },
    );
  });

  it("does not fetch when the budget is fail-closed", async () => {
    let fetches = 0;

    await withScheduler(
      city(["network-a"]),
      async (scheduler, _store, budget) => {
        budget.reserve(at("12:00:00"));
        budget.failClosed();

        expect((await scheduler.step()).kind).toBe("blocked");
        expect(fetches).toBe(0);
      },
      async (networkId) => {
        fetches += 1;
        return successfulFetch(networkId, "12:00:00", 5);
      },
    );
  });

  it("does not start another request while an earlier step is awaiting fetch completion", async () => {
    let resolveFetch: ((result: CityBikesFetchResult) => void) | undefined;
    const pendingFetch = new Promise<CityBikesFetchResult>((resolve) => {
      resolveFetch = resolve;
    });
    let fetches = 0;

    await withScheduler(
      city(["network-a", "network-b"]),
      async (scheduler) => {
        const firstStep = scheduler.step().catch(() => undefined);
        await Promise.resolve();
        const secondStep = await scheduler.step();

        expect(fetches).toBe(1);
        expect(secondStep.kind).toBe("busy");
        if (resolveFetch === undefined) {
          throw new Error("Expected pending fetch resolver");
        }
        resolveFetch(successfulFetch("network-a", "12:00:00", 5));
        await firstStep;
      },
      async () => {
        fetches += 1;
        return pendingFetch;
      },
    );
  });

  it("materializes a complete city from a persisted usable snapshot without fetching", async () => {
    let fetches = 0;

    await withScheduler(
      [CITY_CONFIGS[1]],
      async (scheduler, store) => {
        store.saveNetworkSnapshot({
          kind: "success",
          networkId: "bicimad",
          freeBikes: 8,
          oldestSourceAt: at("11:55:00"),
          newestSourceAt: at("12:00:00"),
          validFrom: at("12:00:00"),
          validUntil: at("12:15:00"),
          fetchedAt: at("12:00:00"),
        });

        const result = await scheduler.step();
        expect(result.kind).toBe("idle");
        expect(fetches).toBe(0);
        expect(
          store.getCityObservationsForHour("Madrid", "ES", at("12:00:00"), at("13:00:00")),
        ).toHaveLength(1);
        expect(scheduler.getMetrics().redundantRatio).toBe(0);
      },
      async (networkId) => {
        fetches += 1;
        return successfulFetch(networkId, "12:00:00", 8);
      },
    );
  });

  it("does not persist incomplete cached city composition when a missing network cannot be fetched", async () => {
    const fetchedNetworks: string[] = [];

    await withScheduler(
      city(["network-a", "network-b"]),
      async (scheduler, store, budget) => {
        store.saveNetworkSnapshot({
          kind: "success",
          networkId: "network-a",
          freeBikes: 3,
          oldestSourceAt: at("11:55:00"),
          newestSourceAt: at("12:00:00"),
          validFrom: at("12:00:00"),
          validUntil: at("12:15:00"),
          fetchedAt: at("12:00:00"),
        });

        budget.reserve(at("12:00:00"));
        budget.failClosed();
        expect((await scheduler.step()).kind).toBe("blocked");
        expect(fetchedNetworks).toStrictEqual([]);
        expect(
          store.getCityObservationsForHour("Test City", "TC", at("12:00:00"), at("13:00:00")),
        ).toStrictEqual([]);
      },
      async (networkId) => {
        fetchedNetworks.push(networkId);
        return successfulFetch(networkId, "12:00:00", 4);
      },
    );
  });

  it("targets cached city composition again at 240 seconds and reports rolling overdue status", async () => {
    let fetches = 0;

    await withScheduler(
      city(["network-a"]),
      async (scheduler, store, _budget, clock) => {
        store.saveNetworkSnapshot({
          kind: "success",
          networkId: "network-a",
          freeBikes: 4,
          oldestSourceAt: at("11:55:00"),
          newestSourceAt: at("12:00:00"),
          validFrom: at("12:00:00"),
          validUntil: at("12:15:00"),
          fetchedAt: at("12:00:00"),
        });
        await scheduler.step();
        clock.set("12:03:59");
        await scheduler.step();
        expect(
          store.getCityObservationsForHour("Test City", "TC", at("12:00:00"), at("13:00:00")),
        ).toHaveLength(1);
        clock.set("12:04:00");
        await scheduler.step();
        expect(
          store.getCityObservationsForHour("Test City", "TC", at("12:00:00"), at("13:00:00")),
        ).toHaveLength(2);
        clock.set("12:09:01");
        expect(scheduler.getOverdueCities()).toStrictEqual(["Test City"]);
        expect(fetches).toBe(0);
      },
      async (networkId) => {
        fetches += 1;
        return successfulFetch(networkId, "12:00:00", 4);
      },
    );
  });

  it("uses rolling elapsed time rather than aligned five-minute buckets", async () => {
    await withScheduler(
      city(["network-a"]),
      async (scheduler, store, _budget, clock) => {
        store.saveNetworkSnapshot({
          kind: "success",
          networkId: "network-a",
          freeBikes: 4,
          oldestSourceAt: at("11:55:00"),
          newestSourceAt: at("12:04:59"),
          validFrom: at("12:04:59"),
          validUntil: at("12:19:59"),
          fetchedAt: at("12:04:59"),
        });
        clock.set("12:04:59");
        await scheduler.step();

        clock.set("12:09:58");
        expect(scheduler.getOverdueCities()).toStrictEqual([]);
        clock.set("12:10:00");
        expect(scheduler.getOverdueCities()).toStrictEqual(["Test City"]);
      },
      async (networkId) => successfulFetch(networkId, "12:04:59", 4),
    );
  });

  it("selects equal missing networks fairly in configuration order", async () => {
    const fetchedNetworks: string[] = [];

    await withScheduler(
      city(["network-a", "network-b", "network-c"]),
      async (scheduler) => {
        await scheduler.step();
        await scheduler.step();
        await scheduler.step();

        expect(fetchedNetworks).toStrictEqual(["network-a", "network-b", "network-c"]);
      },
      async (networkId) => {
        fetchedNetworks.push(networkId);
        return successfulFetch(networkId, "12:00:00", 1);
      },
    );
  });

  it("reconciles valid budget metadata and fails closed after network errors", async () => {
    let fetches = 0;

    await withScheduler(
      city(["network-a"]),
      async (scheduler, _store, budget) => {
        await scheduler.step();
        expect(budget.getState()).toStrictEqual({ kind: "fail-closed", resetAt: null });
        await scheduler.step();
        expect(fetches).toBe(1);
      },
      async (networkId) => {
        fetches += 1;
        return { kind: "network-error", networkId, error: new Error("offline") };
      },
    );
  });

  it("fails closed after invalid rate-limit metadata", async () => {
    let fetches = 0;

    await withScheduler(
      city(["network-a"]),
      async (scheduler, _store, budget) => {
        await scheduler.step();
        expect(budget.getState()).toStrictEqual({ kind: "fail-closed", resetAt: null });
        await scheduler.step();
        expect(fetches).toBe(1);
      },
      async (networkId) => {
        fetches += 1;
        return { kind: "invalid-rate-limit", networkId, status: 200 };
      },
    );
  });

  it("backs off across same-count freshness refreshes with advancing provider timestamps", async () => {
    const outcomes = [
      successfulFetch("network-a", "12:00:00", 5),
      successfulFetch("network-a", "12:00:30", 5),
      successfulFetch("network-a", "12:01:00", 5),
    ];

    await withScheduler(
      city(["network-a"]),
      async (scheduler, _store, _budget, clock) => {
        expect(await scheduler.step()).toMatchObject({
          kind: "fetched",
          usefulness: "freshness-refresh",
        });
        const firstSchedule = scheduler.getNetworkSchedule("network-a");
        const sustainableFloorMs = scheduler.getSustainableFloorMs();

        if (firstSchedule === null || sustainableFloorMs === null) {
          throw new Error("Expected first schedule and sustainable floor");
        }

        expect(firstSchedule.intervalMs).toBe(sustainableFloorMs);
        clock.setDate(firstSchedule.nextPollAt);

        expect(await scheduler.step()).toMatchObject({
          kind: "fetched",
          usefulness: "freshness-refresh",
        });
        const secondSchedule = scheduler.getNetworkSchedule("network-a");

        if (secondSchedule === null) {
          throw new Error("Expected second schedule");
        }

        expect(secondSchedule.intervalMs).toBeGreaterThan(firstSchedule.intervalMs);
        clock.setDate(secondSchedule.nextPollAt);

        expect(await scheduler.step()).toMatchObject({
          kind: "fetched",
          usefulness: "freshness-refresh",
        });
        const thirdSchedule = scheduler.getNetworkSchedule("network-a");

        if (thirdSchedule === null) {
          throw new Error("Expected third schedule");
        }

        expect(thirdSchedule.intervalMs).toBeGreaterThan(secondSchedule.intervalMs);
        expect(scheduler.getMetrics()).toMatchObject({
          totalFetches: 3,
          availabilityChanges: 0,
          freshnessRefreshes: 3,
          redundantFetches: 0,
          failures: 0,
          redundantRatio: 0,
        });
      },
      async () => {
        const outcome = outcomes.shift();

        if (outcome === undefined) {
          throw new Error("No configured fetch outcome");
        }

        return outcome;
      },
    );
  });

  it("classifies first, redundant, freshness, and availability outcomes with adaptive intervals", async () => {
    const outcomes = [
      successfulFetch("network-a", "12:00:00", 5),
      successfulFetch("network-a", "12:00:00", 5),
      successfulFetch("network-a", "12:01:00", 5),
      successfulFetch("network-a", "12:03:00", 8),
    ];

    await withScheduler(
      city(["network-a"]),
      async (scheduler, store, _budget, clock) => {
        const first = await scheduler.step();
        expect(first).toMatchObject({ kind: "fetched", usefulness: "freshness-refresh" });
        const firstSchedule = scheduler.getNetworkSchedule("network-a");
        if (firstSchedule === null) {
          throw new Error("Expected first schedule");
        }
        clock.setDate(firstSchedule.nextPollAt);

        const redundant = await scheduler.step();
        expect(redundant).toMatchObject({ kind: "fetched", usefulness: "redundant" });
        const redundantSchedule = scheduler.getNetworkSchedule("network-a");
        if (redundantSchedule === null) {
          throw new Error("Expected redundant schedule");
        }
        expect(redundantSchedule.intervalMs).toBeGreaterThan(firstSchedule.intervalMs);
        clock.setDate(redundantSchedule.nextPollAt);

        const freshness = await scheduler.step();
        expect(freshness).toMatchObject({ kind: "fetched", usefulness: "freshness-refresh" });
        const freshnessSchedule = scheduler.getNetworkSchedule("network-a");
        if (freshnessSchedule === null) {
          throw new Error("Expected freshness schedule");
        }
        clock.setDate(freshnessSchedule.nextPollAt);

        const changed = await scheduler.step();
        expect(changed).toMatchObject({ kind: "fetched", usefulness: "availability-change" });
        const changedSchedule = scheduler.getNetworkSchedule("network-a");
        if (changedSchedule === null) {
          throw new Error("Expected changed schedule");
        }
        expect(changedSchedule.intervalMs).toBeLessThan(redundantSchedule.intervalMs);
        expect(store.findUsableNetworkSnapshot("network-a", clock.now())?.freeBikes).toBe(8);
        expect(scheduler.getMetrics()).toMatchObject({
          totalFetches: 4,
          availabilityChanges: 1,
          freshnessRefreshes: 2,
          redundantFetches: 1,
          failures: 0,
          redundantRatio: 0.25,
        });
      },
      async () => {
        const outcome = outcomes.shift();
        if (outcome === undefined) {
          throw new Error("No configured fetch outcome");
        }
        return outcome;
      },
    );
  });

  it("records normalization failures without inventing a network snapshot", async () => {
    await withScheduler(
      city(["network-a"]),
      async (scheduler, store) => {
        expect(await scheduler.step()).toMatchObject({ kind: "fetched", usefulness: "failure" });
        expect(store.findUsableNetworkSnapshot("network-a", at("12:00:00"))).toBeNull();
        expect(scheduler.getMetrics()).toMatchObject({ totalFetches: 1, failures: 1 });
      },
      async (networkId) => ({
        kind: "success",
        networkId,
        rateLimit: { limit: 10, remaining: 9, resetAfterSeconds: 3_600 },
        payload: cityBikesResponseSchema.parse({ network: { stations: [] } }),
      }),
    );
  });

  it("derives capacity from runtime remaining/reset state and exposes insufficiency", async () => {
    await withScheduler(
      city(["network-a", "network-b"]),
      async (scheduler, _store, budget, clock) => {
        expect(scheduler.getSustainableFloorMs()).toBeNull();
        budget.reserve(clock.now());
        budget.observeRateLimit({ limit: 20, remaining: 10, resetAfterSeconds: 100 }, clock.now());
        expect(budget.getState()).toStrictEqual({
          kind: "established",
          limit: 20,
          remaining: 10,
          resetAt: at("12:01:40"),
        });
        expect(scheduler.getSustainableFloorMs()).toBe(20_000);
        budget.observeRateLimit({ limit: 20, remaining: 5, resetAfterSeconds: 100 }, clock.now());
        expect(scheduler.getSustainableFloorMs()).toBe(40_000);
      },
      async (networkId) => successfulFetch(networkId, "12:00:00", 1),
    );

    await withScheduler(
      city(["network-a", "network-b"]),
      async (scheduler, _store, budget, clock) => {
        budget.reserve(clock.now());
        budget.observeRateLimit({ limit: 1, remaining: 1, resetAfterSeconds: 900 }, clock.now());

        expect(scheduler.isCapacityInsufficient()).toBe(true);
      },
      async (networkId) => successfulFetch(networkId, "12:00:00", 1),
      120,
    );
  });

  it("classifies an already expired normalized provider snapshot as a failure", async () => {
    await withScheduler(
      city(["network-a"]),
      async (scheduler, store, _budget, clock) => {
        clock.set("12:20:00");

        expect(await scheduler.step()).toMatchObject({
          kind: "fetched",
          usefulness: "failure",
        });
        expect(scheduler.getMetrics()).toMatchObject({
          totalFetches: 1,
          failures: 1,
          freshnessRefreshes: 0,
        });
        expect(
          store.findUsableNetworkSnapshot("network-a", at("12:20:00")),
        ).toBeNull();
      },
      async (networkId) => successfulFetch(networkId, "12:00:00", 5),
    );
  });

  it("classifies an older provider state with a changed count as redundant", async () => {
    const outcomes = [
      successfulFetch("network-a", "12:00:00", 10),
      successfulFetch("network-a", "11:59:00", 5),
    ];

    await withScheduler(
      city(["network-a"]),
      async (scheduler, store, _budget, clock) => {
        await scheduler.step();
        const firstSchedule = scheduler.getNetworkSchedule("network-a");

        if (firstSchedule === null) {
          throw new Error("Expected first schedule");
        }

        clock.setDate(firstSchedule.nextPollAt);
        expect(await scheduler.step()).toMatchObject({
          kind: "fetched",
          usefulness: "redundant",
        });
        expect(scheduler.getMetrics()).toMatchObject({
          availabilityChanges: 0,
          redundantFetches: 1,
        });
        expect(
          store.findUsableNetworkSnapshot("network-a", clock.now())?.freeBikes,
        ).toBe(10);
      },
      async () => {
        const outcome = outcomes.shift();

        if (outcome === undefined) {
          throw new Error("No configured fetch outcome");
        }

        return outcome;
      },
      3_600,
    );
  });

  it("does not clamp a fetched network below its sustainable floor when capacity is insufficient", async () => {
    await withScheduler(
      city(["network-a"]),
      async (scheduler, _store, budget, clock) => {
        budget.reserve(clock.now());
        budget.observeRateLimit(
          { limit: 1, remaining: 1, resetAfterSeconds: 900 },
          clock.now(),
        );

        expect(await scheduler.step()).toMatchObject({
          kind: "fetched",
          capacityInsufficient: true,
        });
        expect(
          scheduler.getNetworkSchedule("network-a")?.nextPollAt.getTime(),
        ).toBeGreaterThanOrEqual(at("12:15:00").getTime());
      },
      async (networkId) => ({
        kind: "success",
        networkId,
        rateLimit: { limit: 1, remaining: 1, resetAfterSeconds: 900 },
        payload: cityBikesResponseSchema.parse({
          network: {
            stations: [
              {
                id: "network-a-station",
                latitude: 1,
                longitude: 1,
                timestamp: "2026-08-08T12:00:00Z",
                free_bikes: 5,
              },
            ],
          },
        }),
      }),
      120,
    );
  });

  it("does not clamp an initialized cached schedule below its sustainable floor when capacity is insufficient", async () => {
    await withScheduler(
      city(["network-a"]),
      async (scheduler, store, budget, clock) => {
        store.saveNetworkSnapshot({
          kind: "success",
          networkId: "network-a",
          freeBikes: 5,
          oldestSourceAt: at("12:00:00"),
          newestSourceAt: at("12:00:00"),
          validFrom: at("12:00:00"),
          validUntil: at("12:02:00"),
          fetchedAt: at("12:00:00"),
        });
        budget.reserve(clock.now());
        budget.observeRateLimit(
          { limit: 1, remaining: 1, resetAfterSeconds: 900 },
          clock.now(),
        );

        expect(await scheduler.step()).toMatchObject({
          kind: "idle",
          capacityInsufficient: true,
        });
        expect(
          scheduler.getNetworkSchedule("network-a")?.nextPollAt.getTime(),
        ).toBeGreaterThanOrEqual(at("12:15:00").getTime());
      },
      async (networkId) => successfulFetch(networkId, "12:00:00", 5),
      120,
    );
  });

  it("does not let expiry safety pull a fetched schedule below its sustainable floor", async () => {
    await withScheduler(
      city(["network-a"]),
      async (scheduler, _store, budget, clock) => {
        budget.reserve(clock.now());
        budget.observeRateLimit(
          { limit: 1, remaining: 1, resetAfterSeconds: 60 },
          clock.now(),
        );

        expect(await scheduler.step()).toMatchObject({
          kind: "fetched",
          capacityInsufficient: false,
        });
        expect(scheduler.getSustainableFloorMs()).toBe(60_000);
        expect(
          scheduler.getNetworkSchedule("network-a")?.nextPollAt.getTime(),
        ).toBeGreaterThanOrEqual(at("12:01:00").getTime());
      },
      async (networkId) => ({
        kind: "success",
        networkId,
        rateLimit: { limit: 1, remaining: 1, resetAfterSeconds: 60 },
        payload: cityBikesResponseSchema.parse({
          network: {
            stations: [
              {
                id: "network-a-station",
                latitude: 1,
                longitude: 1,
                timestamp: "2026-08-08T11:46:30Z",
                free_bikes: 5,
              },
            ],
          },
        }),
      }),
    );
  });

  it("does not let expiry safety pull an initialized cached schedule below its sustainable floor", async () => {
    await withScheduler(
      city(["network-a"]),
      async (scheduler, store, budget, clock) => {
        store.saveNetworkSnapshot({
          kind: "success",
          networkId: "network-a",
          freeBikes: 5,
          oldestSourceAt: at("11:46:30"),
          newestSourceAt: at("11:46:30"),
          validFrom: at("11:46:30"),
          validUntil: at("12:01:30"),
          fetchedAt: at("12:00:00"),
        });
        budget.reserve(clock.now());
        budget.observeRateLimit(
          { limit: 1, remaining: 1, resetAfterSeconds: 60 },
          clock.now(),
        );

        expect(await scheduler.step()).toMatchObject({
          kind: "idle",
          capacityInsufficient: false,
        });
        expect(scheduler.getSustainableFloorMs()).toBe(60_000);
        expect(
          scheduler.getNetworkSchedule("network-a")?.nextPollAt.getTime(),
        ).toBeGreaterThanOrEqual(at("12:01:00").getTime());
      },
      async (networkId) => successfulFetch(networkId, "12:00:00", 5),
    );
  });
});
