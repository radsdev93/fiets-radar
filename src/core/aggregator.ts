export interface Observation {
  timestamp: Date;
  freeBikes: number;
}

export interface HourlyResult {
  coveredSeconds: number;
  averageFreeBikes: number;
  coverage: number;
  partial: boolean;
}

const SECONDS_PER_HOUR = 60 * 60;

function round(value: number, decimalPlaces: number): number {
  const factor = 10 ** decimalPlaces;
  return Math.round((value + Number.EPSILON) * factor) / factor;
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
  const startMs = intervalStart.getTime();
  const endMs = intervalEnd.getTime();

  if (endMs <= startMs || maxStaleness <= 0) {
    return {
      coveredSeconds: 0,
      averageFreeBikes: 0,
      coverage: 0,
      partial: true,
    };
  }

  const sortedObservations = [...observations].sort(
    (left, right) => left.timestamp.getTime() - right.timestamp.getTime(),
  );

  let coveredSeconds = 0;
  let weightedBikes = 0;
  const maxStalenessMs = maxStaleness * 1_000;

  for (let index = 0; index < sortedObservations.length; index += 1) {
    const observation = sortedObservations[index];
    const observationStartMs = observation.timestamp.getTime();
    const nextObservationMs = sortedObservations[index + 1]?.timestamp.getTime();
    const expiresAtMs = observationStartMs + maxStalenessMs;
    const validityEndMs = Math.min(expiresAtMs, nextObservationMs ?? Infinity);

    const clippedStartMs = Math.max(observationStartMs, startMs);
    const clippedEndMs = Math.min(validityEndMs, endMs);
    const durationSeconds = Math.max(0, (clippedEndMs - clippedStartMs) / 1_000);

    coveredSeconds += durationSeconds;
    weightedBikes += durationSeconds * observation.freeBikes;
  }

  const averageFreeBikes =
    coveredSeconds === 0 ? 0 : weightedBikes / coveredSeconds;
  const coverage = coveredSeconds / SECONDS_PER_HOUR;

  return {
    coveredSeconds,
    averageFreeBikes: round(averageFreeBikes, 2),
    coverage: round(coverage, 4),
    partial: coverage < 0.75,
  };
}
