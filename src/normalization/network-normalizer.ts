import type { z } from "zod";

import type { ConfiguredNetwork, GeographicBounds } from "../config/cities";
import { cityBikesResponseSchema } from "../citybikes/schemas";

type ValidatedCityBikesPayload = z.output<typeof cityBikesResponseSchema>;

export type NetworkNormalizationResult =
  | {
      kind: "success";
      networkId: string;
      freeBikes: number;
      oldestSourceAt: Date;
      newestSourceAt: Date;
      validFrom: Date;
      validUntil: Date;
      fetchedAt: Date;
    }
  | {
      kind: "unsupported-vehicle-kind";
      networkId: string;
      vehicleId: string;
      vehicleKind: string;
    }
  | { kind: "missing-required-vehicles"; networkId: string }
  | { kind: "no-source-data"; networkId: string }
  | {
      kind: "no-overlapping-validity";
      networkId: string;
      oldestSourceAt: Date;
      newestSourceAt: Date;
    }
  | { kind: "invalid-max-staleness"; networkId: string };

function isWithinBounds(
  record: { latitude: number; longitude: number },
  bounds: GeographicBounds | undefined,
): boolean {
  return (
    bounds === undefined ||
    (record.latitude >= bounds.minLatitude &&
      record.latitude <= bounds.maxLatitude &&
      record.longitude >= bounds.minLongitude &&
      record.longitude <= bounds.maxLongitude)
  );
}

function copyDate(date: Date): Date {
  return new Date(date.getTime());
}

export function normalizeNetworkSnapshot(
  config: ConfiguredNetwork,
  payload: ValidatedCityBikesPayload,
  fetchedAt: Date,
  maxStalenessSeconds: number,
): NetworkNormalizationResult {
  if (!Number.isFinite(maxStalenessSeconds) || maxStalenessSeconds <= 0) {
    return { kind: "invalid-max-staleness", networkId: config.networkId };
  }

  const includedStations = payload.network.stations.filter((station) =>
    isWithinBounds(station, config.bounds),
  );
  const requiresVehicles = config.mode !== "stations-only";
  const vehicles = payload.network.vehicles;

  if (requiresVehicles && vehicles === undefined) {
    return { kind: "missing-required-vehicles", networkId: config.networkId };
  }

  const includedVehicles = (vehicles ?? []).filter((vehicle) =>
    isWithinBounds(vehicle, config.bounds),
  );
  const sourceDates: Date[] = [];
  let freeBikes = 0;

  if (config.mode !== "vehicles-only") {
    for (const station of includedStations) {
      freeBikes += station.free_bikes;
      sourceDates.push(station.timestamp);
    }
  }

  if (config.mode !== "stations-only") {
    for (const vehicle of includedVehicles) {
      sourceDates.push(vehicle.timestamp);

      if (vehicle.kind === "bike" || vehicle.kind === "ebike") {
        freeBikes += 1;
      } else if (vehicle.kind !== "scooter") {
        return {
          kind: "unsupported-vehicle-kind",
          networkId: config.networkId,
          vehicleId: vehicle.id,
          vehicleKind: vehicle.kind,
        };
      }
    }
  }

  if (sourceDates.length === 0) {
    return { kind: "no-source-data", networkId: config.networkId };
  }

  let oldestSourceAt = sourceDates[0];
  let newestSourceAt = sourceDates[0];

  for (const sourceDate of sourceDates.slice(1)) {
    if (sourceDate.getTime() < oldestSourceAt.getTime()) {
      oldestSourceAt = sourceDate;
    }
    if (sourceDate.getTime() > newestSourceAt.getTime()) {
      newestSourceAt = sourceDate;
    }
  }

  const validFrom = copyDate(newestSourceAt);
  const validUntil = new Date(
    oldestSourceAt.getTime() + maxStalenessSeconds * 1_000,
  );

  if (validFrom.getTime() >= validUntil.getTime()) {
    return {
      kind: "no-overlapping-validity",
      networkId: config.networkId,
      oldestSourceAt: copyDate(oldestSourceAt),
      newestSourceAt: copyDate(newestSourceAt),
    };
  }

  return {
    kind: "success",
    networkId: config.networkId,
    freeBikes,
    oldestSourceAt: copyDate(oldestSourceAt),
    newestSourceAt: copyDate(newestSourceAt),
    validFrom,
    validUntil,
    fetchedAt: copyDate(fetchedAt),
  };
}
