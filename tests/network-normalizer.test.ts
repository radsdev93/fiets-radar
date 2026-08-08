import type { ConfiguredNetwork } from "../src/config/cities";
import { normalizeNetworkSnapshot } from "../src/normalization/network-normalizer";

function at(time: string): Date {
  return new Date(`2026-08-07T${time}Z`);
}

function station(
  id: string,
  freeBikes: number,
  timestamp: Date,
  latitude = 0,
  longitude = 0,
) {
  return { id, free_bikes: freeBikes, timestamp, latitude, longitude };
}

function vehicle(
  id: string,
  kind: string,
  timestamp: Date,
  latitude = 0,
  longitude = 0,
) {
  return { id, kind, timestamp, latitude, longitude };
}

function payload(
  stations: ReturnType<typeof station>[],
  vehicles?: ReturnType<typeof vehicle>[],
) {
  return vehicles === undefined
    ? { network: { stations } }
    : { network: { stations, vehicles } };
}

const stationsOnly: ConfiguredNetwork = {
  networkId: "stations-network",
  mode: "stations-only",
};

const vehiclesOnly: ConfiguredNetwork = {
  networkId: "vehicles-network",
  mode: "vehicles-only",
};

const combined: ConfiguredNetwork = {
  networkId: "combined-network",
  mode: "stations-and-vehicles",
};

const bounded: ConfiguredNetwork = {
  networkId: "bay-wheels",
  mode: "stations-and-vehicles",
  bounds: {
    minLatitude: 37.708,
    maxLatitude: 37.833,
    minLongitude: -122.515,
    maxLongitude: -122.356,
  },
};

describe("normalizeNetworkSnapshot", () => {
  it("sums stations-only free bikes", () => {
    expect(
      normalizeNetworkSnapshot(
        stationsOnly,
        payload([station("a", 3, at("12:00:00")), station("b", 4, at("12:01:00"))]),
        at("12:02:00"),
        900,
      ),
    ).toMatchObject({ kind: "success", networkId: "stations-network", freeBikes: 7 });
  });

  it("counts bike and ebike vehicles but not scooters", () => {
    expect(
      normalizeNetworkSnapshot(
        vehiclesOnly,
        payload([], [
          vehicle("bike", "bike", at("12:00:00")),
          vehicle("ebike", "ebike", at("12:01:00")),
          vehicle("scooter", "scooter", at("12:02:00")),
        ]),
        at("12:03:00"),
        900,
      ),
    ).toMatchObject({ kind: "success", freeBikes: 2 });
  });

  it("adds station inventory and roaming bicycles without scooters", () => {
    expect(
      normalizeNetworkSnapshot(
        combined,
        payload([station("station", 5, at("12:00:00"))], [
          vehicle("bike", "bike", at("12:01:00")),
          vehicle("ebike", "ebike", at("12:02:00")),
          vehicle("scooter", "scooter", at("12:03:00")),
        ]),
        at("12:04:00"),
        900,
      ),
    ).toMatchObject({ kind: "success", freeBikes: 7 });
  });

  it("returns a typed failure for an included unknown vehicle kind", () => {
    expect(
      normalizeNetworkSnapshot(
        vehiclesOnly,
        payload([], [vehicle("future", "future-bike-kind", at("12:00:00"))]),
        at("12:01:00"),
        900,
      ),
    ).toStrictEqual({
      kind: "unsupported-vehicle-kind",
      networkId: "vehicles-network",
      vehicleId: "future",
      vehicleKind: "future-bike-kind",
    });
  });

  it("ignores vehicle kinds for stations-only configuration", () => {
    expect(
      normalizeNetworkSnapshot(
        stationsOnly,
        payload([station("station", 4, at("12:00:00"))], [
          vehicle("future", "future-bike-kind", at("12:00:00")),
        ]),
        at("12:01:00"),
        900,
      ),
    ).toMatchObject({ kind: "success", freeBikes: 4 });
  });

  it.each([vehiclesOnly, combined])("requires vehicles for %s mode", (config) => {
    expect(
      normalizeNetworkSnapshot(config, payload([station("station", 1, at("12:00:00"))]), at("12:01:00"), 900),
    ).toStrictEqual({ kind: "missing-required-vehicles", networkId: config.networkId });
  });

  it("filters both station and vehicle records using inclusive bounds", () => {
    expect(
      normalizeNetworkSnapshot(
        bounded,
        payload(
          [
            station("inside-station", 3, at("12:00:00"), 37.708, -122.515),
            station("outside-station", 99, at("12:00:00"), 37.7, -122.515),
          ],
          [
            vehicle("inside-bike", "bike", at("12:00:00"), 37.833, -122.356),
            vehicle("outside-ebike", "ebike", at("12:00:00"), 37.9, -122.356),
          ],
        ),
        at("12:01:00"),
        900,
      ),
    ).toMatchObject({ kind: "success", freeBikes: 4 });
  });

  it("returns no-source-data when every configured record is filtered out", () => {
    expect(
      normalizeNetworkSnapshot(
        bounded,
        payload([station("out", 1, at("12:00:00"), 37.7, -122.6)], []),
        at("12:01:00"),
        900,
      ),
    ).toStrictEqual({ kind: "no-source-data", networkId: "bay-wheels" });
  });

  it("uses the intersection of all included source validity windows", () => {
    const result = normalizeNetworkSnapshot(
      stationsOnly,
      payload([station("old", 1, at("12:00:00")), station("new", 1, at("12:05:00"))]),
      at("12:06:00"),
      900,
    );

    expect(result).toMatchObject({ kind: "success" });
    if (result.kind !== "success") {
      throw new Error("Expected overlapping validity");
    }
    expect(result.oldestSourceAt).toStrictEqual(at("12:00:00"));
    expect(result.newestSourceAt).toStrictEqual(at("12:05:00"));
    expect(result.validFrom).toStrictEqual(at("12:05:00"));
    expect(result.validUntil).toStrictEqual(at("12:15:00"));
  });

  it.each([
    ["equal", at("12:15:00")],
    ["greater", at("12:16:00")],
  ])("rejects %s source spreads at or beyond max staleness", (_description, newest) => {
    expect(
      normalizeNetworkSnapshot(
        stationsOnly,
        payload([station("old", 1, at("12:00:00")), station("new", 1, newest)]),
        at("12:20:00"),
        900,
      ),
    ).toMatchObject({ kind: "no-overlapping-validity", networkId: "stations-network" });
  });

  it("preserves an already-expired provider interval instead of refreshing it with fetchedAt", () => {
    const result = normalizeNetworkSnapshot(
      stationsOnly,
      payload([station("stale", 2, at("12:00:00"))]),
      at("13:00:00"),
      900,
    );

    expect(result).toMatchObject({ kind: "success", freeBikes: 2 });
    if (result.kind !== "success") {
      throw new Error("Expected a normalized stale source snapshot");
    }
    expect(result.validFrom).toStrictEqual(at("12:00:00"));
    expect(result.validUntil).toStrictEqual(at("12:15:00"));
    expect(result.fetchedAt).toStrictEqual(at("13:00:00"));
  });

  it.each([0, -1, Infinity])("rejects invalid max staleness %s", (maxStalenessSeconds) => {
    expect(
      normalizeNetworkSnapshot(
        stationsOnly,
        payload([station("station", 1, at("12:00:00"))]),
        at("12:01:00"),
        maxStalenessSeconds,
      ),
    ).toMatchObject({ kind: "invalid-max-staleness", networkId: "stations-network" });
  });
});
