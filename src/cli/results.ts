import type { StoredHourlyResult } from "../storage/sqlite-store";
import { SqliteStore } from "../storage/sqlite-store";

interface ResultsOutput {
  city: string;
  countryCode: string;
  hourStart: string;
  coveredSeconds: number;
  averageFreeBikes: number | null;
  coverage: number;
  partial: boolean;
}

export function formatStoredHourlyResults(
  results: readonly StoredHourlyResult[],
): string {
  const output: ResultsOutput[] = results.map((result) => ({
    city: result.city,
    countryCode: result.countryCode,
    hourStart: result.hourStart.toISOString(),
    coveredSeconds: result.coveredSeconds,
    averageFreeBikes: result.averageFreeBikes,
    coverage: result.coverage,
    partial: result.partial,
  }));

  return JSON.stringify(output, null, 2);
}

function databasePathFromArguments(argumentsList: readonly string[]): string {
  const databaseFlagIndex = argumentsList.indexOf("--db");
  const databasePath =
    databaseFlagIndex === -1 ? undefined : argumentsList[databaseFlagIndex + 1];

  if (databasePath === undefined || databasePath.startsWith("--")) {
    throw new Error("Usage: npm run results -- --db <sqlite-file>");
  }

  return databasePath;
}

if (require.main === module) {
  const store = new SqliteStore(databasePathFromArguments(process.argv.slice(2)));

  try {
    process.stdout.write(`${formatStoredHourlyResults(store.listHourlyResults())}\n`);
  } finally {
    store.close();
  }
}
