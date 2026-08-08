import type { CityConfig } from "../config/cities";
import type { SqliteStore } from "../storage/sqlite-store";
import { finalizeCompletedHour, utcHourStart } from "./hourly-finalizer";

export interface RuntimeClock {
  now(): Date;
}

export interface SchedulerRunner {
  step(): Promise<unknown>;
}

export class ServiceRuntime {
  private lastFinalizedHourStartMs: number | undefined;

  constructor(
    private readonly clock: RuntimeClock,
    private readonly scheduler: SchedulerRunner,
    private readonly store: SqliteStore,
    private readonly cityConfigs: readonly CityConfig[],
  ) {}

  async tick(): Promise<void> {
    const currentHour = utcHourStart(this.clock.now());
    const latestCompletedHourStartMs = currentHour.getTime() - 3_600_000;
    const firstHourStartMs =
      this.lastFinalizedHourStartMs === undefined
        ? latestCompletedHourStartMs
        : this.lastFinalizedHourStartMs + 3_600_000;

    for (
      let hourStartMs = firstHourStartMs;
      hourStartMs <= latestCompletedHourStartMs;
      hourStartMs += 3_600_000
    ) {
      finalizeCompletedHour(
        this.store,
        this.cityConfigs,
        new Date(hourStartMs),
      );
      this.lastFinalizedHourStartMs = hourStartMs;
    }

    await this.scheduler.step();
  }
}
