import type { CityConfig } from "../config/cities";
import { calculateHourlyAverageFromValidity } from "../core/aggregator";
import { SqliteStore } from "../storage/sqlite-store";

export function utcHourStart(at: Date): Date {
  const hourStart = new Date(at.getTime());
  hourStart.setUTCMinutes(0, 0, 0);
  return hourStart;
}

export function finalizeCompletedHour(
  store: SqliteStore,
  cityConfigs: readonly CityConfig[],
  hourStart: Date,
): void {
  const hourEnd = new Date(hourStart.getTime() + 3_600_000);

  for (const cityConfig of cityConfigs) {
    const observations = store.getCityObservationsForHour(
      cityConfig.city,
      cityConfig.countryCode,
      hourStart,
      hourEnd,
    );
    const result = calculateHourlyAverageFromValidity(
      observations,
      hourStart,
      hourEnd,
    );

    store.saveHourlyResult(
      cityConfig.city,
      cityConfig.countryCode,
      hourStart,
      result,
    );
  }
}
