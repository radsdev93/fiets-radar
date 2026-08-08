import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CityCompositionResult } from "../src/composition/city-composer";
import { calculateHourlyAverageFromValidity, type HourlyResult } from "../src/core/aggregator";
import type { NetworkNormalizationResult } from "../src/normalization/network-normalizer";
import { SqliteStore } from "../src/storage/sqlite-store";

type NormalizedNetworkSnapshot = Extract<
  NetworkNormalizationResult,
  { kind: "success" }
>;

type CompleteCityObservation = Extract<
  CityCompositionResult,
  { kind: "complete" }
>;

function at(time: string): Date {
  return new Date(`2026-08-08T${time}Z`);
}

function networkSnapshot(
  networkId: string,
  validFrom: string,
  validUntil: string,
  fetchedAt: string,
  freeBikes = 5,
): NormalizedNetworkSnapshot {
  return {
    kind: "success",
    networkId,
    freeBikes,
    oldestSourceAt: at("11:55:00"),
    newestSourceAt: at(validFrom),
    validFrom: at(validFrom),
    validUntil: at(validUntil),
    fetchedAt: at(fetchedAt),
  };
}

function cityObservation(
  observedAt: string,
  validUntil: string,
  freeBikes = 8,
): CompleteCityObservation {
  return {
    kind: "complete",
    city: "Test City",
    countryCode: "TC",
    observedAt: at(observedAt),
    freeBikes,
    validUntil: at(validUntil),
    oldestSourceAt: at("11:55:00"),
    newestSourceAt: at(observedAt),
    availableNetworks: ["network-a"],
  };
}

function withTemporaryStore(action: (store: SqliteStore) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "fiets-radar-store-"));
  const store = new SqliteStore(join(directory, "store.sqlite"));

  try {
    action(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("SqliteStore", () => {
  it("saves and loads one usable normalized network snapshot", () => {
    withTemporaryStore((store) => {
      const snapshot = networkSnapshot(
        "network-a",
        "12:00:00",
        "12:15:00",
        "12:01:00",
      );
      store.saveNetworkSnapshot(snapshot);

      expect(store.findUsableNetworkSnapshot("network-a", at("12:05:00"))).toStrictEqual(
        snapshot,
      );
    });
  });

  it("uses a half-open network validity interval", () => {
    withTemporaryStore((store) => {
      store.saveNetworkSnapshot(
        networkSnapshot("network-a", "12:05:00", "12:10:00", "12:01:00"),
      );

      expect(store.findUsableNetworkSnapshot("network-a", at("12:05:00"))).not.toBeNull();
      expect(store.findUsableNetworkSnapshot("network-a", at("12:10:00"))).toBeNull();
    });
  });

  it("does not use a snapshot fetched after asOf", () => {
    withTemporaryStore((store) => {
      store.saveNetworkSnapshot(
        networkSnapshot("network-a", "12:00:00", "12:15:00", "12:10:00"),
      );

      expect(store.findUsableNetworkSnapshot("network-a", at("12:05:00"))).toBeNull();
    });
  });

  it("prefers the greatest validFrom over a later HTTP fetch", () => {
    withTemporaryStore((store) => {
      store.saveNetworkSnapshot(
        networkSnapshot("network-a", "12:00:00", "12:20:00", "12:09:00", 3),
      );
      store.saveNetworkSnapshot(
        networkSnapshot("network-a", "12:05:00", "12:20:00", "12:06:00", 7),
      );

      expect(store.findUsableNetworkSnapshot("network-a", at("12:10:00"))?.freeBikes).toBe(7);
    });
  });

  it("keeps an older usable snapshot when a later fetched snapshot is provider-stale", () => {
    withTemporaryStore((store) => {
      store.saveNetworkSnapshot(
        networkSnapshot("network-a", "12:00:00", "12:15:00", "12:01:00", 3),
      );
      store.saveNetworkSnapshot(
        networkSnapshot("network-a", "11:40:00", "12:00:00", "12:04:00", 9),
      );

      expect(store.findUsableNetworkSnapshot("network-a", at("12:05:00"))?.freeBikes).toBe(3);
    });
  });

  it("persists an exact network snapshot idempotently", () => {
    withTemporaryStore((store) => {
      const snapshot = networkSnapshot(
        "network-a",
        "12:00:00",
        "12:15:00",
        "12:01:00",
      );
      store.saveNetworkSnapshot(snapshot);
      store.saveNetworkSnapshot(snapshot);

      expect(store.findUsableNetworkSnapshot("network-a", at("12:05:00"))).toStrictEqual(
        snapshot,
      );
    });
  });

  it("saves a complete city observation as explicit validity input", () => {
    withTemporaryStore((store) => {
      store.saveCityObservation(cityObservation("12:00:00", "12:10:00", 8));

      expect(
        store.getCityObservationsForHour("Test City", "TC", at("12:00:00"), at("13:00:00")),
      ).toStrictEqual([
        {
          timestamp: at("12:00:00"),
          validUntil: at("12:10:00"),
          freeBikes: 8,
        },
      ]);
    });
  });

  it("includes a pre-hour city observation whose validity extends into the hour", () => {
    withTemporaryStore((store) => {
      store.saveCityObservation(cityObservation("11:55:00", "12:05:00"));

      expect(
        store.getCityObservationsForHour("Test City", "TC", at("12:00:00"), at("13:00:00")),
      ).toHaveLength(1);
    });
  });

  it("excludes a city observation expiring exactly at hour start", () => {
    withTemporaryStore((store) => {
      store.saveCityObservation(cityObservation("11:55:00", "12:00:00"));

      expect(
        store.getCityObservationsForHour("Test City", "TC", at("12:00:00"), at("13:00:00")),
      ).toStrictEqual([]);
    });
  });

  it("excludes a city observation beginning exactly at hour end", () => {
    withTemporaryStore((store) => {
      store.saveCityObservation(cityObservation("13:00:00", "13:10:00"));

      expect(
        store.getCityObservationsForHour("Test City", "TC", at("12:00:00"), at("13:00:00")),
      ).toStrictEqual([]);
    });
  });

  it("returns city aggregation inputs in observedAt order", () => {
    withTemporaryStore((store) => {
      store.saveCityObservation(cityObservation("12:10:00", "12:20:00", 20));
      store.saveCityObservation(cityObservation("12:00:00", "12:05:00", 10));

      expect(
        store
          .getCityObservationsForHour("Test City", "TC", at("12:00:00"), at("13:00:00"))
          .map((observation) => observation.timestamp),
      ).toStrictEqual([at("12:00:00"), at("12:10:00")]);
    });
  });

  it("persists the same city observation idempotently without doubled coverage", () => {
    withTemporaryStore((store) => {
      const observation = cityObservation("12:00:00", "12:05:00", 10);
      store.saveCityObservation(observation);
      store.saveCityObservation(observation);
      const inputs = store.getCityObservationsForHour(
        "Test City",
        "TC",
        at("12:00:00"),
        at("13:00:00"),
      );

      expect(inputs).toHaveLength(1);
      expect(
        calculateHourlyAverageFromValidity(inputs, at("12:00:00"), at("13:00:00")),
      ).toStrictEqual({
        coveredSeconds: 300,
        averageFreeBikes: 10,
        coverage: 0.0833,
        partial: true,
      });
    });
  });

  it("saves and retrieves a normal hourly result", () => {
    withTemporaryStore((store) => {
      const result: HourlyResult = {
        coveredSeconds: 1800,
        averageFreeBikes: 12.5,
        coverage: 0.5,
        partial: true,
      };
      store.saveHourlyResult("Test City", "TC", at("12:00:00"), result);

      expect(store.getHourlyResult("Test City", "TC", at("12:00:00"))).toStrictEqual(result);
    });
  });

  it("round-trips a null hourly average", () => {
    withTemporaryStore((store) => {
      const result: HourlyResult = {
        coveredSeconds: 0,
        averageFreeBikes: null,
        coverage: 0,
        partial: true,
      };
      store.saveHourlyResult("Test City", "TC", at("12:00:00"), result);

      expect(store.getHourlyResult("Test City", "TC", at("12:00:00"))).toStrictEqual(result);
    });
  });

  it("upserts an hourly result for the same city and hour", () => {
    withTemporaryStore((store) => {
      store.saveHourlyResult("Test City", "TC", at("12:00:00"), {
        coveredSeconds: 600,
        averageFreeBikes: 5,
        coverage: 0.1667,
        partial: true,
      });
      const replacement: HourlyResult = {
        coveredSeconds: 1200,
        averageFreeBikes: 8,
        coverage: 0.3333,
        partial: true,
      };
      store.saveHourlyResult("Test City", "TC", at("12:00:00"), replacement);

      expect(store.getHourlyResult("Test City", "TC", at("12:00:00"))).toStrictEqual(
        replacement,
      );
    });
  });

  it("recovers persisted state after a normal close and reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "fiets-radar-store-"));
    const databasePath = join(directory, "store.sqlite");
    const network = networkSnapshot(
      "network-a",
      "12:00:00",
      "12:15:00",
      "12:01:00",
      5,
    );
    const observation = cityObservation("12:00:00", "12:10:00", 6);
    const hourlyResult: HourlyResult = {
      coveredSeconds: 600,
      averageFreeBikes: 6,
      coverage: 0.1667,
      partial: true,
    };
    const firstStore = new SqliteStore(databasePath);

    try {
      firstStore.saveNetworkSnapshot(network);
      firstStore.saveCityObservation(observation);
      firstStore.saveHourlyResult("Test City", "TC", at("12:00:00"), hourlyResult);
      firstStore.close();

      const reopenedStore = new SqliteStore(databasePath);
      try {
        expect(reopenedStore.findUsableNetworkSnapshot("network-a", at("12:05:00"))).toStrictEqual(
          network,
        );
        const inputs = reopenedStore.getCityObservationsForHour(
          "Test City",
          "TC",
          at("12:00:00"),
          at("13:00:00"),
        );
        expect(inputs).toHaveLength(1);
        expect(
          calculateHourlyAverageFromValidity(inputs, at("12:00:00"), at("13:00:00")),
        ).toStrictEqual(hourlyResult);
        expect(reopenedStore.getHourlyResult("Test City", "TC", at("12:00:00"))).toStrictEqual(
          hourlyResult,
        );
      } finally {
        reopenedStore.close();
      }
    } finally {
      firstStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
