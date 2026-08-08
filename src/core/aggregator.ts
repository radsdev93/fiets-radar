export interface Observation {
  timestamp: Date;
  freeBikes: number;
}

export interface ValidityObservation {
  timestamp: Date;
  validUntil: Date;
  freeBikes: number;
}

export interface HourlyResult {
  coveredSeconds: number;
  averageFreeBikes: number | null;
  coverage: number;
  partial: boolean;
}

const SECONDS_PER_HOUR = 60 * 60;

function round(value: number, decimalPlaces: number): number {
  const factor = 10 ** decimalPlaces;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function emptyHourlyResult(): HourlyResult {
  return {
    coveredSeconds: 0,
    averageFreeBikes: null,
    coverage: 0,
    partial: true,
  };
}

export function calculateHourlyAverageFromValidity(
  observations: ValidityObservation[],
  intervalStart: Date,
  intervalEnd: Date,
): HourlyResult {
  const startMs = intervalStart.getTime();
  const endMs = intervalEnd.getTime();

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return emptyHourlyResult();
  }

  const sortedObservations = [...observations].sort(
    (left, right) => left.timestamp.getTime() - right.timestamp.getTime(),
  );
  let coveredSeconds = 0;
  let weightedBikes = 0;

  for (let index = 0; index < sortedObservations.length; index += 1) {
    const observation = sortedObservations[index];
    const nextObservation = sortedObservations[index + 1];
    const effectiveStartMs = Math.max(observation.timestamp.getTime(), startMs);
    const effectiveEndMs = Math.min(
      observation.validUntil.getTime(),
      nextObservation?.timestamp.getTime() ?? Infinity,
      endMs,
    );
    const durationSeconds = Math.max(
      0,
      (effectiveEndMs - effectiveStartMs) / 1_000,
    );

    coveredSeconds += durationSeconds;
    weightedBikes += durationSeconds * observation.freeBikes;
  }

  if (coveredSeconds === 0) {
    return emptyHourlyResult();
  }

  const coverage = coveredSeconds / SECONDS_PER_HOUR;

  return {
    coveredSeconds,
    averageFreeBikes: round(weightedBikes / coveredSeconds, 2),
    coverage: round(coverage, 4),
    partial: coverage < 0.75,
  };
}

/**
 * Produces a time-weighted bike average for one hourly interval.
 *
 * A newer observation replaces an older one, even when the older observation
 * has not reached its staleness limit yet. Each validity window is clipped to
 * the requested interval before contributing to coverage or the weighted sum.
 */
export function calculateHourlyAverage(
  observations: Observation[],
  intervalStart: Date,
  intervalEnd: Date,
  maxStaleness: number,
): HourlyResult {
  const maxStalenessMs = maxStaleness * 1_000;

  if (
    !Number.isFinite(maxStaleness) ||
    maxStaleness <= 0 ||
    !Number.isFinite(maxStalenessMs)
  ) {
    return emptyHourlyResult();
  }

  return calculateHourlyAverageFromValidity(
    observations.map((observation) => ({
      timestamp: observation.timestamp,
      validUntil: new Date(observation.timestamp.getTime() + maxStalenessMs),
      freeBikes: observation.freeBikes,
    })),
    intervalStart,
    intervalEnd,
  );
}
