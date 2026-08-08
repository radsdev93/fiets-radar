import type { CityConfig } from "../config/cities";
import type { NetworkNormalizationResult } from "../normalization/network-normalizer";

type NormalizedNetworkSnapshot = Extract<
  NetworkNormalizationResult,
  { kind: "success" }
>;

type UnavailableReason =
  | "missing"
  | "not-yet-fetched"
  | "not-yet-valid"
  | "expired";

function copyDate(date: Date): Date {
  return new Date(date.getTime());
}

function unusableReason(
  snapshot: NormalizedNetworkSnapshot,
  asOf: Date,
): UnavailableReason | undefined {
  const asOfTime = asOf.getTime();

  if (snapshot.fetchedAt.getTime() > asOfTime) {
    return "not-yet-fetched";
  }
  if (snapshot.validFrom.getTime() > asOfTime) {
    return "not-yet-valid";
  }
  if (snapshot.validUntil.getTime() <= asOfTime) {
    return "expired";
  }

  return undefined;
}

export type CityCompositionResult =
  | {
      kind: "complete";
      city: string;
      countryCode: string;
      observedAt: Date;
      freeBikes: number;
      validUntil: Date;
      oldestSourceAt: Date;
      newestSourceAt: Date;
      availableNetworks: string[];
    }
  | {
      kind: "incomplete";
      city: string;
      countryCode: string;
      observedAt: Date;
      knownFreeBikes: number;
      availableNetworks: string[];
      unavailableNetworks: Array<{
        networkId: string;
        reason: UnavailableReason;
      }>;
    };

export function composeCitySnapshot(
  cityConfig: CityConfig,
  snapshotsByNetwork: ReadonlyMap<string, NormalizedNetworkSnapshot>,
  asOf: Date,
): CityCompositionResult {
  const usableSnapshots: NormalizedNetworkSnapshot[] = [];
  const availableNetworks: string[] = [];
  const unavailableNetworks: Array<{
    networkId: string;
    reason: UnavailableReason;
  }> = [];
  let knownFreeBikes = 0;

  for (const networkConfig of cityConfig.networks) {
    const snapshot = snapshotsByNetwork.get(networkConfig.networkId);

    if (snapshot === undefined) {
      unavailableNetworks.push({
        networkId: networkConfig.networkId,
        reason: "missing",
      });
      continue;
    }

    const reason = unusableReason(snapshot, asOf);

    if (reason !== undefined) {
      unavailableNetworks.push({
        networkId: networkConfig.networkId,
        reason,
      });
      continue;
    }

    usableSnapshots.push(snapshot);
    availableNetworks.push(networkConfig.networkId);
    knownFreeBikes += snapshot.freeBikes;
  }

  if (unavailableNetworks.length > 0) {
    return {
      kind: "incomplete",
      city: cityConfig.city,
      countryCode: cityConfig.countryCode,
      observedAt: copyDate(asOf),
      knownFreeBikes,
      availableNetworks,
      unavailableNetworks,
    };
  }

  const firstSnapshot = usableSnapshots[0];

  if (firstSnapshot === undefined) {
    return {
      kind: "incomplete",
      city: cityConfig.city,
      countryCode: cityConfig.countryCode,
      observedAt: copyDate(asOf),
      knownFreeBikes: 0,
      availableNetworks: [],
      unavailableNetworks: [],
    };
  }

  let validUntil = firstSnapshot.validUntil;
  let oldestSourceAt = firstSnapshot.oldestSourceAt;
  let newestSourceAt = firstSnapshot.newestSourceAt;

  for (const snapshot of usableSnapshots.slice(1)) {
    if (snapshot.validUntil.getTime() < validUntil.getTime()) {
      validUntil = snapshot.validUntil;
    }
    if (snapshot.oldestSourceAt.getTime() < oldestSourceAt.getTime()) {
      oldestSourceAt = snapshot.oldestSourceAt;
    }
    if (snapshot.newestSourceAt.getTime() > newestSourceAt.getTime()) {
      newestSourceAt = snapshot.newestSourceAt;
    }
  }

  return {
    kind: "complete",
    city: cityConfig.city,
    countryCode: cityConfig.countryCode,
    observedAt: copyDate(asOf),
    freeBikes: knownFreeBikes,
    validUntil: copyDate(validUntil),
    oldestSourceAt: copyDate(oldestSourceAt),
    newestSourceAt: copyDate(newestSourceAt),
    availableNetworks,
  };
}
