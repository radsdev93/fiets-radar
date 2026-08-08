import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  CITY_CONFIGS,
  DEFAULT_MAX_STALENESS_SECONDS,
} from "../config/cities";
import { RequestBudgetController } from "../scheduler/request-budget";
import { SqliteStore } from "../storage/sqlite-store";
import { TraceRecorder } from "../trace/recorder";
import { resolveTraceCities } from "../trace/city-selection";
import { serializeRecordedTrace } from "../trace/trace-format";

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

function repeatedOption(name: string): string[] {
  const values: string[] = [];

  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name) {
      const value = process.argv[index + 1];

      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Missing value for ${name}`);
      }

      values.push(value);
    }
  }

  return values;
}

async function main(): Promise<void> {
  const output = requiredOption("--output");
  const rounds = positiveInteger("--rounds");
  const intervalSeconds = positiveInteger("--interval-seconds");
  const cityConfigs = resolveTraceCities(repeatedOption("--city"), CITY_CONFIGS);
  const store = new SqliteStore(":memory:");
  const budget = new RequestBudgetController(store);
  const recorder = new TraceRecorder({
    cityConfigs,
    maxStalenessSeconds: DEFAULT_MAX_STALENESS_SECONDS,
    budget,
    clock: { now: () => new Date() },
    fetchImpl: fetch,
  });

  try {
    const result = await recorder.record(
      rounds,
      intervalSeconds,
      (milliseconds) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, milliseconds);
        }),
    );

    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, serializeRecordedTrace(result.trace), "utf8");
    const completedRounds = result.trace.rounds.filter(
      (round) => round.diagnostics.length === 0,
    ).length;

    console.log(`Completed rounds: ${completedRounds}`);
    console.log(`Incomplete rounds: ${result.trace.rounds.length - completedRounds}`);
    console.log(`Provider requests: ${result.requests}`);
    console.log(`Output: ${output}`);
    if (result.stoppedEarly !== null) {
      console.log(`Stopped early: ${result.stoppedEarly}`);
    }
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown recorder error";
  console.error(message);
  process.exitCode = 1;
});
