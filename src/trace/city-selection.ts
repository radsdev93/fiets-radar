import type { CityConfig } from "../config/cities";

export function resolveTraceCities(
  requestedCities: readonly string[],
  cityConfigs: readonly CityConfig[],
): CityConfig[] {
  if (requestedCities.length === 0) {
    return [...cityConfigs];
  }

  const selected: CityConfig[] = [];
  const seen = new Set<string>();

  for (const cityName of requestedCities) {
    if (seen.has(cityName)) {
      throw new Error(`Duplicate city selection: ${cityName}`);
    }
    seen.add(cityName);

    const city = cityConfigs.find((candidate) => candidate.city === cityName);

    if (city === undefined) {
      throw new Error(`Unknown city selection: ${cityName}`);
    }

    selected.push(city);
  }

  return selected;
}
