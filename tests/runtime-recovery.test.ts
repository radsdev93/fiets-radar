import { mkdtempSync, rmSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CityConfig } from "../src/config/cities";
import { formatStoredHourlyResults } from "../src/cli/results";
import { finalizeCompletedHour } from "../src/runtime/hourly-finalizer";
import { ServiceRuntime } from "../src/runtime/service-runtime";
import { SqliteStore } from "../src/storage/sqlite-store";

function at(time: string): Date {
  return new Date(`2026-08-08T${time}Z`);
}

const CITY_CONFIGS: CityConfig[] = [
  {
    city: "Runtime City",
    countryCode: "RT",
    networks: [{ networkId: "runtime-network", mode: "stations-only" }],
  },
];

function saveObservation(
  store: SqliteStore,
  observedAt: string,
  validUntil: string,
  freeBikes: number,
): void {
  store.saveCityObservation({
    kind: "complete",
    city: "Runtime City",
    countryCode: "RT",
    observedAt: at(observedAt),
    validUntil: at(validUntil),
    freeBikes,
    oldestSourceAt: at(observedAt),
    newestSourceAt: at(observedAt),
    availableNetworks: ["runtime-network"],
  });
}

function temporaryDatabase(): { directory: string; databasePath: string } {
  const directory = mkdtempSync(join(tmpdir(), "fiets-radar-runtime-"));
  return { directory, databasePath: join(directory, "store.sqlite") };
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode);
  }

  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

function compileWorker(outputDirectory: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const compiler = spawn(
      process.execPath,
      [join(process.cwd(), "node_modules", "typescript", "bin", "tsc"), "--outDir", outputDirectory],
      { stdio: "ignore" },
    );
    compiler.once("error", reject);
    compiler.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`TypeScript compiler exited with ${code}`));
      }
    });
  });
}

describe("hour finalization, runtime coordination, and stored results", () => {
  it("finalizes a completed UTC hour from durable validity observations idempotently", () => {
    const store = new SqliteStore(":memory:");

    try {
      saveObservation(store, "12:00:00", "12:20:00", 10);
      saveObservation(store, "12:20:00", "13:00:00", 20);
      finalizeCompletedHour(store, CITY_CONFIGS, at("12:00:00"));
      const first = store.getHourlyResult("Runtime City", "RT", at("12:00:00"));
      finalizeCompletedHour(store, CITY_CONFIGS, at("12:00:00"));

      expect(first).toStrictEqual({
        coveredSeconds: 3600,
        averageFreeBikes: 16.67,
        coverage: 1,
        partial: false,
      });
      expect(store.getHourlyResult("Runtime City", "RT", at("12:00:00"))).toStrictEqual(first);
    } finally {
      store.close();
    }
  });

  it("preserves a null average for a completed zero-coverage hour", () => {
    const store = new SqliteStore(":memory:");

    try {
      finalizeCompletedHour(store, CITY_CONFIGS, at("12:00:00"));
      expect(store.getHourlyResult("Runtime City", "RT", at("12:00:00"))).toStrictEqual({
        coveredSeconds: 0,
        averageFreeBikes: null,
        coverage: 0,
        partial: true,
      });
    } finally {
      store.close();
    }
  });

  it("does not finalize the in-flight hour and finalizes it after its UTC boundary", async () => {
    const store = new SqliteStore(":memory:");
    let now = at("12:30:00");
    let schedulerCalls = 0;
    const runtime = new ServiceRuntime(
      { now: () => new Date(now.getTime()) },
      { step: async () => { schedulerCalls += 1; } },
      store,
      CITY_CONFIGS,
    );

    try {
      saveObservation(store, "12:00:00", "13:00:00", 12);
      await runtime.tick();
      expect(store.getHourlyResult("Runtime City", "RT", at("12:00:00"))).toBeNull();
      now = at("13:00:00");
      await runtime.tick();
      expect(store.getHourlyResult("Runtime City", "RT", at("12:00:00"))?.averageFreeBikes).toBe(12);
      expect(schedulerCalls).toBe(2);
    } finally {
      store.close();
    }
  });

  it("lists stored results deterministically and formats ISO UTC JSON without converting null", () => {
    const store = new SqliteStore(":memory:");

    try {
      store.saveHourlyResult("Zurich", "CH", at("13:00:00"), {
        coveredSeconds: 0,
        averageFreeBikes: null,
        coverage: 0,
        partial: true,
      });
      store.saveHourlyResult("Amsterdam", "NL", at("12:00:00"), {
        coveredSeconds: 3600,
        averageFreeBikes: 7.5,
        coverage: 1,
        partial: false,
      });

      const results = store.listHourlyResults();
      expect(results.map((result) => `${result.hourStart.toISOString()}:${result.city}`)).toStrictEqual([
        "2026-08-08T12:00:00.000Z:Amsterdam",
        "2026-08-08T13:00:00.000Z:Zurich",
      ]);
      expect(JSON.parse(formatStoredHourlyResults(results))).toStrictEqual([
        {
          city: "Amsterdam",
          countryCode: "NL",
          hourStart: "2026-08-08T12:00:00.000Z",
          coveredSeconds: 3600,
          averageFreeBikes: 7.5,
          coverage: 1,
          partial: false,
        },
        {
          city: "Zurich",
          countryCode: "CH",
          hourStart: "2026-08-08T13:00:00.000Z",
          coveredSeconds: 0,
          averageFreeBikes: null,
          coverage: 0,
          partial: true,
        },
      ]);
    } finally {
      store.close();
    }
  });

  it("survives SIGKILL after committed writes and recomputes the in-flight hour without duplication", async () => {
    const { directory, databasePath } = temporaryDatabase();
    const compiledDirectory = mkdtempSync(join(tmpdir(), "fiets-radar-worker-"));
    let child: ChildProcess | undefined;

    try {
      await compileWorker(compiledDirectory);
      const workerPath = join(compiledDirectory, "tests", "fixtures", "r7-worker.js");
      child = spawn(process.execPath, [workerPath, databasePath, "prepare"], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: {
          ...process.env,
          NODE_PATH: join(process.cwd(), "node_modules"),
        },
      });
      await waitForReady(child);
      expect(child.pid).toBeDefined();
      child.kill("SIGKILL");
      await waitForExit(child);

      const resumed = spawn(process.execPath, [workerPath, databasePath, "resume"], {
        stdio: ["ignore", "ignore", "inherit"],
        env: {
          ...process.env,
          NODE_PATH: join(process.cwd(), "node_modules"),
        },
      });
      const code = await waitForExit(resumed);
      expect(code).toBe(0);

      const store = new SqliteStore(databasePath);
      try {
        expect(store.getHourlyResult("Recovery City", "RC", at("10:00:00"))).toStrictEqual({
          coveredSeconds: 3600,
          averageFreeBikes: 16.67,
          coverage: 1,
          partial: false,
        });
        expect(store.getHourlyResult("Recovery City", "RC", at("11:00:00"))).toStrictEqual({
          coveredSeconds: 3600,
          averageFreeBikes: 23.33,
          coverage: 1,
          partial: false,
        });
        finalizeCompletedHour(store, [{
          city: "Recovery City",
          countryCode: "RC",
          networks: [{ networkId: "recovery-network", mode: "stations-only" }],
        }], at("11:00:00"));
        expect(store.getCityObservationsForHour("Recovery City", "RC", at("11:00:00"), at("12:00:00"))).toHaveLength(3);
        expect(store.getHourlyResult("Recovery City", "RC", at("11:00:00"))?.averageFreeBikes).toBe(23.33);
      } finally {
        store.close();
      }
    } finally {
      if (child !== undefined && child.exitCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child);
      }
      rmSync(directory, { recursive: true, force: true });
      rmSync(compiledDirectory, { recursive: true, force: true });
    }
  });
});

async function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let errors = "";
    const stderr = child.stderr;

    const onMessage = (message: unknown): void => {
      if (message === "READY") {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(
        new Error(
          `Child exited before signalling READY (code ${code}, signal ${signal}): ${errors}`,
        ),
      );
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      stderr?.off("data", onErrorData);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
    };

    const onErrorData = (chunk: Buffer): void => {
      errors += chunk.toString();
    };
    stderr?.on("data", onErrorData);
    child.once("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}
