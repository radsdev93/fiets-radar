import { setTimeout as wait } from "node:timers/promises";

import { fetchCityBikesNetwork } from "../citybikes/client";
import { CITY_CONFIGS, DEFAULT_MAX_STALENESS_SECONDS } from "../config/cities";
import { AdaptiveScheduler } from "../scheduler/adaptive-scheduler";
import { RequestBudgetController } from "../scheduler/request-budget";
import { ServiceRuntime } from "../runtime/service-runtime";
import { SqliteStore } from "../storage/sqlite-store";

class SystemClock {
  now(): Date {
    return new Date();
  }
}

function databasePathFromArguments(argumentsList: readonly string[]): string {
  const databaseFlagIndex = argumentsList.indexOf("--db");
  const databasePath =
    databaseFlagIndex === -1 ? undefined : argumentsList[databaseFlagIndex + 1];

  if (databasePath === undefined || databasePath.startsWith("--")) {
    throw new Error("Usage: npm run service -- --db <sqlite-file>");
  }

  return databasePath;
}

async function run(): Promise<void> {
  const store = new SqliteStore(databasePathFromArguments(process.argv.slice(2)));
  const clock = new SystemClock();
  const budget = new RequestBudgetController(store);
  const scheduler = new AdaptiveScheduler({
    cityConfigs: CITY_CONFIGS,
    store,
    budget,
    clock,
    maxStalenessSeconds: DEFAULT_MAX_STALENESS_SECONDS,
    fetchNetwork: (networkId) => fetchCityBikesNetwork(networkId, fetch),
  });
  const runtime = new ServiceRuntime(clock, scheduler, store, CITY_CONFIGS);
  let running = true;

  const stop = (): void => {
    running = false;
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    while (running) {
      await runtime.tick();
      await wait(1_000);
    }
  } finally {
    store.close();
  }
}

void run();
