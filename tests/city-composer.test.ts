import type { CityConfig } from "../src/config/cities";
import {
  composeCitySnapshot,
  type CityCompositionResult,
} from "../src/composition/city-composer";
import type { NetworkNormalizationResult } from "../src/normalization/network-normalizer";

type SuccessfulNetworkSnapshot = Extract<
  NetworkNormalizationResult,
  { kind: "success" }
>;

function at(time: string): Date {
  return new Date(`2026-08-08T${time}Z`);
}

function snapshot(
  networkId: string,
  freeBikes: number,
  oldestSourceAt: Date,
  newestSourceAt: Date,
  validFrom: Date,
  validUntil: Date,
  fetchedAt: Date,
): SuccessfulNetworkSnapshot {
  return {
    kind: "success",
    networkId,
    freeBikes,
    oldestSourceAt,
    newestSourceAt,
    validFrom,
    validUntil,
    fetchedAt,
  };
}

function city(networkIds: string[]): CityConfig {
  return {
    city: "Test City",
    countryCode: "TC",
    networks: networkIds.map((networkId) => ({
      networkId,
      mode: "stations-only",
    })),
  };
}

function complete(result: CityCompositionResult) {
  expect(result.kind).toBe("complete");
  if (result.kind !== "complete") {
    throw new Error("Expected complete city composition");
  }
  return result;
}

function incomplete(result: CityCompositionResult) {
  expect(result.kind).toBe("incomplete");
  if (result.kind !== "incomplete") {
    throw new Error("Expected incomplete city composition");
  }
  return result;
}

describe("composeCitySnapshot", () => {
  it("produces a complete single-network city snapshot", () => {
    const asOf = at("12:05:00");
    const result = complete(
      composeCitySnapshot(
        city(["network-a"]),
        new Map([
          [
            "network-a",
            snapshot(
              "network-a",
              5,
              at("12:00:00"),
              at("12:01:00"),
              at("12:01:00"),
              at("12:15:00"),
              at("12:02:00"),
            ),
          ],
        ]),
        asOf,
      ),
    );

    expect(result).toMatchObject({
      city: "Test City",
      countryCode: "TC",
      freeBikes: 5,
      availableNetworks: ["network-a"],
    });
  });

  it("sums required multi-network components and expires at the earliest component", () => {
    const result = complete(
      composeCitySnapshot(
        city(["network-a", "network-b"]),
        new Map([
          [
            "network-a",
            snapshot(
              "network-a",
              5,
              at("12:00:00"),
              at("12:02:00"),
              at("12:02:00"),
              at("12:20:00"),
              at("12:03:00"),
            ),
          ],
          [
            "network-b",
            snapshot(
              "network-b",
              7,
              at("11:58:00"),
              at("12:04:00"),
              at("12:04:00"),
              at("12:15:00"),
              at("12:04:30"),
            ),
          ],
        ]),
        at("12:05:00"),
      ),
    );

    expect(result.freeBikes).toBe(12);
    expect(result.validUntil).toStrictEqual(at("12:15:00"));
    expect(result.availableNetworks).toStrictEqual(["network-a", "network-b"]);
  });

  it("uses asOf for observedAt and reduces source timestamps across components", () => {
    const asOf = at("12:06:00");
    const result = complete(
      composeCitySnapshot(
        city(["network-a", "network-b"]),
        new Map([
          [
            "network-a",
            snapshot(
              "network-a",
              1,
              at("11:50:00"),
              at("12:01:00"),
              at("12:01:00"),
              at("12:20:00"),
              at("12:02:00"),
            ),
          ],
          [
            "network-b",
            snapshot(
              "network-b",
              2,
              at("11:55:00"),
              at("12:04:00"),
              at("12:04:00"),
              at("12:25:00"),
              at("12:05:00"),
            ),
          ],
        ]),
        asOf,
      ),
    );

    expect(result.observedAt).toStrictEqual(asOf);
    expect(result.oldestSourceAt).toStrictEqual(at("11:50:00"));
    expect(result.newestSourceAt).toStrictEqual(at("12:04:00"));
  });

  it("may compose an older cached snapshot with a newer snapshot while both are valid", () => {
    const result = complete(
      composeCitySnapshot(
        city(["cached", "new"]),
        new Map([
          [
            "cached",
            snapshot(
              "cached",
              3,
              at("11:55:00"),
              at("12:00:00"),
              at("12:00:00"),
              at("12:10:00"),
              at("12:00:30"),
            ),
          ],
          [
            "new",
            snapshot(
              "new",
              4,
              at("12:04:00"),
              at("12:04:00"),
              at("12:04:00"),
              at("12:18:00"),
              at("12:04:30"),
            ),
          ],
        ]),
        at("12:05:00"),
      ),
    );

    expect(result.freeBikes).toBe(7);
    expect(result.validUntil).toStrictEqual(at("12:10:00"));
  });

  it("returns a known subtotal without an official total when a required network is missing", () => {
    const result = incomplete(
      composeCitySnapshot(
        city(["network-a", "network-b"]),
        new Map([
          [
            "network-a",
            snapshot(
              "network-a",
              5,
              at("12:00:00"),
              at("12:00:00"),
              at("12:00:00"),
              at("12:20:00"),
              at("12:01:00"),
            ),
          ],
        ]),
        at("12:05:00"),
      ),
    );

    expect(result.knownFreeBikes).toBe(5);
    expect(result.availableNetworks).toStrictEqual(["network-a"]);
    expect(result.unavailableNetworks).toStrictEqual([
      { networkId: "network-b", reason: "missing" },
    ]);
    expect("freeBikes" in result).toBe(false);
  });

  it.each([
    [
      "expired",
      snapshot(
        "network-a",
        1,
        at("12:00:00"),
        at("12:00:00"),
        at("12:00:00"),
        at("12:05:00"),
        at("12:01:00"),
      ),
      at("12:05:00"),
      "expired",
    ],
    [
      "not yet fetched",
      snapshot(
        "network-a",
        1,
        at("12:00:00"),
        at("12:00:00"),
        at("12:00:00"),
        at("12:20:00"),
        at("12:10:00"),
      ),
      at("12:05:00"),
      "not-yet-fetched",
    ],
    [
      "not yet valid",
      snapshot(
        "network-a",
        1,
        at("12:00:00"),
        at("12:10:00"),
        at("12:10:00"),
        at("12:20:00"),
        at("12:01:00"),
      ),
      at("12:05:00"),
      "not-yet-valid",
    ],
  ])("classifies %s components deterministically", (_description, network, asOf, reason) => {
    const result = incomplete(
      composeCitySnapshot(city(["network-a"]), new Map([["network-a", network]]), asOf),
    );

    expect(result.unavailableNetworks).toStrictEqual([
      { networkId: "network-a", reason },
    ]);
    expect(result.knownFreeBikes).toBe(0);
  });

  it("treats validFrom as inclusive and validUntil as exclusive", () => {
    const validFrom = at("12:05:00");
    const validUntil = at("12:10:00");
    const network = snapshot(
      "network-a",
      3,
      at("12:00:00"),
      validFrom,
      validFrom,
      validUntil,
      at("12:01:00"),
    );

    expect(
      composeCitySnapshot(city(["network-a"]), new Map([["network-a", network]]), validFrom).kind,
    ).toBe("complete");
    expect(
      incomplete(
        composeCitySnapshot(city(["network-a"]), new Map([["network-a", network]]), validUntil),
      ).unavailableNetworks,
    ).toStrictEqual([{ networkId: "network-a", reason: "expired" }]);
  });

  it("ignores snapshots for networks outside the city configuration", () => {
    const result = complete(
      composeCitySnapshot(
        city(["network-a"]),
        new Map([
          [
            "network-a",
            snapshot(
              "network-a",
              2,
              at("12:00:00"),
              at("12:00:00"),
              at("12:00:00"),
              at("12:20:00"),
              at("12:01:00"),
            ),
          ],
          [
            "extra",
            snapshot(
              "extra",
              99,
              at("12:00:00"),
              at("12:00:00"),
              at("12:00:00"),
              at("12:20:00"),
              at("12:01:00"),
            ),
          ],
        ]),
        at("12:05:00"),
      ),
    );

    expect(result.freeBikes).toBe(2);
    expect(result.availableNetworks).toStrictEqual(["network-a"]);
  });

  it("returns copied Dates without mutating the source snapshots or asOf", () => {
    const asOf = at("12:05:00");
    const network = snapshot(
      "network-a",
      2,
      at("12:00:00"),
      at("12:01:00"),
      at("12:01:00"),
      at("12:20:00"),
      at("12:02:00"),
    );
    const result = complete(
      composeCitySnapshot(city(["network-a"]), new Map([["network-a", network]]), asOf),
    );

    expect(result.observedAt).not.toBe(asOf);
    expect(result.validUntil).not.toBe(network.validUntil);
    result.observedAt.setUTCMinutes(30);
    result.validUntil.setUTCMinutes(30);
    expect(asOf).toStrictEqual(at("12:05:00"));
    expect(network.validUntil).toStrictEqual(at("12:20:00"));
  });
});
