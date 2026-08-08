import { readFileSync } from "node:fs";

import { runBenchmark } from "../benchmark/benchmark";
import { CITY_CONFIGS } from "../config/cities";
import { resolveTraceCities } from "../trace/city-selection";
import { parseRecordedTrace } from "../trace/trace-format";

function requiredOption(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;

  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing ${name}`);
  }

  return value;
}

function positiveInteger(name: string): number {
  const raw = requiredOption(name);

  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }

  const value = Number(raw);

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

async function main(): Promise<void> {
  const tracePath = requiredOption("--trace");
  const requestBudget = positiveInteger("--budget");
  const parsed: unknown = JSON.parse(readFileSync(tracePath, "utf8"));
  const trace = parseRecordedTrace(parsed);

  if (trace === null) {
    throw new Error("Trace does not match the validated trace format");
  }

  const cityConfigs = resolveTraceCities(trace.selectedCities, CITY_CONFIGS);

  const result = await runBenchmark({
    trace,
    cityConfigs,
    requestBudget,
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown benchmark error";
  console.error(message);
  process.exitCode = 1;
});
