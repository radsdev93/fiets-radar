import type { CityBikesFetchResult } from "../citybikes/client";
import type { CityConfig, ConfiguredNetwork } from "../config/cities";
import { composeCitySnapshot } from "../composition/city-composer";
import { normalizeNetworkSnapshot } from "../normalization/network-normalizer";
import type { NetworkNormalizationResult } from "../normalization/network-normalizer";
import { RequestBudgetController } from "./request-budget";
import { SqliteStore } from "../storage/sqlite-store";

export const R5_WINDOW_SECONDS = 300;
export const CITY_OBSERVATION_TARGET_SECONDS = 240;
export const POLL_EXPIRY_SAFETY_SECONDS = 60;

export interface SchedulerClock {
  now(): Date;
}

export type CityBikesNetworkFetcher = (
  networkId: string,
) => Promise<CityBikesFetchResult>;

export type FetchUsefulness =
  | "availability-change"
  | "freshness-refresh"
  | "redundant"
  | "failure";

export interface SchedulerMetrics {
  totalFetches: number;
  availabilityChanges: number;
  freshnessRefreshes: number;
  redundantFetches: number;
  failures: number;
  redundantRatio: number;
}

export interface AdaptiveSchedulerOptions {
  cityConfigs: CityConfig[];
  store: SqliteStore;
  budget: RequestBudgetController;
  clock: SchedulerClock;
  fetchNetwork: CityBikesNetworkFetcher;
  maxStalenessSeconds: number;
}

export type SchedulerStepResult =
  | {
      kind: "fetched";
      networkId: string;
      usefulness: FetchUsefulness;
      materializedCities: string[];
      capacityInsufficient: boolean;
    }
  | {
      kind: "blocked";
      reason: "bootstrap-pending" | "exhausted" | "budget-unknown";
      materializedCities: string[];
      capacityInsufficient: boolean;
    }
  | {
      kind: "idle" | "busy";
      materializedCities: string[];
      capacityInsufficient: boolean;
    };

export interface AdaptiveNetworkSchedule {
  intervalMs: number;
  nextPollAt: Date;
}

type NormalizedNetworkSnapshot = Extract<
  NetworkNormalizationResult,
  { kind: "success" }
>;

interface ScheduledNetwork {
  config: ConfiguredNetwork;
  order: number;
}

interface MutableNetworkSchedule {
  intervalMs: number;
  nextPollAtMs: number;
}

const R5_WINDOW_MS = R5_WINDOW_SECONDS * 1_000;
const CITY_OBSERVATION_TARGET_MS = CITY_OBSERVATION_TARGET_SECONDS * 1_000;
const POLL_EXPIRY_SAFETY_MS = POLL_EXPIRY_SAFETY_SECONDS * 1_000;

export class AdaptiveScheduler {
  private readonly networks: ScheduledNetwork[];
  private readonly schedules = new Map<string, MutableNetworkSchedule>();
  private readonly lastCompleteCityObservationAt = new Map<string, number>();
  private readonly metrics = {
    totalFetches: 0,
    availabilityChanges: 0,
    freshnessRefreshes: 0,
    redundantFetches: 0,
    failures: 0,
  };
  private isStepping = false;

  constructor(private readonly options: AdaptiveSchedulerOptions) {
    const networksById = new Map<string, ScheduledNetwork>();
    let order = 0;

    for (const cityConfig of options.cityConfigs) {
      for (const config of cityConfig.networks) {
        if (!networksById.has(config.networkId)) {
          networksById.set(config.networkId, { config, order });
          order += 1;
        }
      }
    }

    this.networks = [...networksById.values()];
  }

  async step(): Promise<SchedulerStepResult> {
    if (this.isStepping) {
      return this.emptyStepResult("busy", []);
    }

    this.isStepping = true;

    try {
      const materializedCities = this.materializeDueCities(this.options.clock.now());
      const selectedNetwork = this.selectDueNetwork(this.options.clock.now());

      if (selectedNetwork === null) {
        return this.emptyStepResult("idle", materializedCities);
      }

      const reservation = this.options.budget.reserve(this.options.clock.now());

      if (reservation.kind === "blocked") {
        return {
          kind: "blocked",
          reason: reservation.reason,
          materializedCities,
          capacityInsufficient: this.isCapacityInsufficient(),
        };
      }

      let fetchResult: CityBikesFetchResult;

      try {
        fetchResult = await this.options.fetchNetwork(
          selectedNetwork.config.networkId,
        );
      } catch {
        const completionTime = this.options.clock.now();
        this.options.budget.failClosed();
        this.recordUsefulness("failure");
        this.updateSchedule(selectedNetwork.config, completionTime, "failure");

        return {
          kind: "fetched",
          networkId: selectedNetwork.config.networkId,
          usefulness: "failure",
          materializedCities: [
            ...materializedCities,
            ...this.materializeDueCities(this.options.clock.now()),
          ],
          capacityInsufficient: this.isCapacityInsufficient(),
        };
      }

      const completionTime = this.options.clock.now();
      this.reconcileBudget(fetchResult, completionTime);
      const usefulness = this.processFetchResult(
        selectedNetwork.config,
        fetchResult,
        completionTime,
      );
      this.recordUsefulness(usefulness);
      this.updateSchedule(selectedNetwork.config, completionTime, usefulness);

      return {
        kind: "fetched",
        networkId: selectedNetwork.config.networkId,
        usefulness,
        materializedCities: [
          ...materializedCities,
          ...this.materializeDueCities(this.options.clock.now()),
        ],
        capacityInsufficient: this.isCapacityInsufficient(),
      };
    } finally {
      this.isStepping = false;
    }
  }

  getMetrics(): SchedulerMetrics {
    return {
      ...this.metrics,
      redundantRatio:
        this.metrics.totalFetches === 0
          ? 0
          : this.metrics.redundantFetches / this.metrics.totalFetches,
    };
  }

  getOverdueCities(): string[] {
    const nowMs = this.options.clock.now().getTime();

    return this.options.cityConfigs
      .filter((cityConfig) => {
        const lastObservationAt = this.lastCompleteCityObservationAt.get(
          this.cityKey(cityConfig),
        );

        return (
          lastObservationAt === undefined ||
          nowMs - lastObservationAt > R5_WINDOW_MS
        );
      })
      .map((cityConfig) => cityConfig.city);
  }

  getSustainableFloorMs(): number | null {
    const state = this.options.budget.getState();
    const nowMs = this.options.clock.now().getTime();

    if (
      state.kind !== "established" ||
      state.remaining <= 0 ||
      state.resetAt.getTime() <= nowMs
    ) {
      return null;
    }

    return Math.max(
      1,
      Math.ceil(
        (this.networks.length * (state.resetAt.getTime() - nowMs)) /
          state.remaining,
      ),
    );
  }

  isCapacityInsufficient(): boolean {
    const sustainableFloorMs = this.getSustainableFloorMs();

    return (
      sustainableFloorMs !== null &&
      sustainableFloorMs > this.freshnessCeilingMs()
    );
  }

  getNetworkSchedule(networkId: string): AdaptiveNetworkSchedule | null {
    const schedule = this.schedules.get(networkId);

    if (schedule === undefined) {
      return null;
    }

    return {
      intervalMs: schedule.intervalMs,
      nextPollAt: new Date(schedule.nextPollAtMs),
    };
  }

  private emptyStepResult(
    kind: "idle" | "busy",
    materializedCities: string[],
  ): SchedulerStepResult {
    return {
      kind,
      materializedCities,
      capacityInsufficient: this.isCapacityInsufficient(),
    };
  }

  private materializeDueCities(asOf: Date): string[] {
    const asOfMs = asOf.getTime();
    const materializedCities: string[] = [];

    for (const cityConfig of this.options.cityConfigs) {
      const cityKey = this.cityKey(cityConfig);
      const lastObservationAt = this.lastCompleteCityObservationAt.get(cityKey);

      if (
        lastObservationAt !== undefined &&
        asOfMs - lastObservationAt < CITY_OBSERVATION_TARGET_MS
      ) {
        continue;
      }

      const snapshotsByNetwork = new Map<string, NormalizedNetworkSnapshot>();

      for (const configuredNetwork of cityConfig.networks) {
        const snapshot = this.options.store.findUsableNetworkSnapshot(
          configuredNetwork.networkId,
          asOf,
        );

        if (snapshot !== null) {
          snapshotsByNetwork.set(configuredNetwork.networkId, snapshot);
        }
      }

      const composition = composeCitySnapshot(
        cityConfig,
        snapshotsByNetwork,
        asOf,
      );

      if (composition.kind === "complete") {
        this.options.store.saveCityObservation(composition);
        this.lastCompleteCityObservationAt.set(cityKey, asOfMs);
        materializedCities.push(cityConfig.city);
      }
    }

    return materializedCities;
  }

  private selectDueNetwork(now: Date): ScheduledNetwork | null {
    const nowMs = now.getTime();
    let selectedNetwork: ScheduledNetwork | null = null;
    let selectedDeadlineMs = Infinity;

    for (const scheduledNetwork of this.networks) {
      const snapshot = this.options.store.findUsableNetworkSnapshot(
        scheduledNetwork.config.networkId,
        now,
      );
      const schedule = this.schedules.get(scheduledNetwork.config.networkId);
      let deadlineMs: number;

      if (snapshot === null) {
        deadlineMs = schedule?.nextPollAtMs ?? -Infinity;
      } else if (schedule !== undefined) {
        deadlineMs = schedule.nextPollAtMs;
      } else {
        const intervalMs = this.initialIntervalMs();
        deadlineMs = this.nextPollDeadlineMs(nowMs, intervalMs, snapshot);

        this.schedules.set(scheduledNetwork.config.networkId, {
          intervalMs,
          nextPollAtMs: deadlineMs,
        });
      }

      if (
        deadlineMs <= nowMs &&
        (selectedNetwork === null ||
          deadlineMs < selectedDeadlineMs ||
          (deadlineMs === selectedDeadlineMs &&
            scheduledNetwork.order < selectedNetwork.order))
      ) {
        selectedNetwork = scheduledNetwork;
        selectedDeadlineMs = deadlineMs;
      }
    }

    return selectedNetwork;
  }

  private processFetchResult(
    config: ConfiguredNetwork,
    fetchResult: CityBikesFetchResult,
    fetchedAt: Date,
  ): FetchUsefulness {
    if (fetchResult.kind !== "success") {
      return "failure";
    }

    const previousSnapshot = this.options.store.findUsableNetworkSnapshot(
      config.networkId,
      fetchedAt,
    );
    const normalization = normalizeNetworkSnapshot(
      config,
      fetchResult.payload,
      fetchedAt,
      this.options.maxStalenessSeconds,
    );

    if (normalization.kind !== "success") {
      return "failure";
    }

    this.options.store.saveNetworkSnapshot(normalization);

    if (!this.isUsableAt(normalization, fetchedAt)) {
      return "failure";
    }

    if (previousSnapshot === null) {
      return "freshness-refresh";
    }

    if (
      normalization.validFrom.getTime() < previousSnapshot.validFrom.getTime()
    ) {
      return "redundant";
    }

    if (normalization.freeBikes !== previousSnapshot.freeBikes) {
      return "availability-change";
    }

    if (
      normalization.newestSourceAt.getTime() >
        previousSnapshot.newestSourceAt.getTime() ||
      normalization.validUntil.getTime() > previousSnapshot.validUntil.getTime()
    ) {
      return "freshness-refresh";
    }

    return "redundant";
  }

  private reconcileBudget(
    fetchResult: CityBikesFetchResult,
    completionTime: Date,
  ): void {
    if (
      fetchResult.kind === "success" ||
      fetchResult.kind === "malformed-json" ||
      fetchResult.kind === "invalid-response"
    ) {
      this.options.budget.observeRateLimit(fetchResult.rateLimit, completionTime);
      return;
    }

    if (fetchResult.kind === "http-error" && fetchResult.rateLimit !== null) {
      this.options.budget.observeRateLimit(fetchResult.rateLimit, completionTime);
      return;
    }

    this.options.budget.failClosed();
  }

  private recordUsefulness(usefulness: FetchUsefulness): void {
    this.metrics.totalFetches += 1;

    if (usefulness === "availability-change") {
      this.metrics.availabilityChanges += 1;
    } else if (usefulness === "freshness-refresh") {
      this.metrics.freshnessRefreshes += 1;
    } else if (usefulness === "redundant") {
      this.metrics.redundantFetches += 1;
    } else {
      this.metrics.failures += 1;
    }
  }

  private updateSchedule(
    config: ConfiguredNetwork,
    fetchedAt: Date,
    usefulness: FetchUsefulness,
  ): void {
    const previousSchedule = this.schedules.get(config.networkId);
    const previousIntervalMs = previousSchedule?.intervalMs;
    const intervalMs = this.nextIntervalMs(previousIntervalMs, usefulness);
    const snapshot = this.options.store.findUsableNetworkSnapshot(
      config.networkId,
      fetchedAt,
    );
    const nextPollAtMs = this.nextPollDeadlineMs(
      fetchedAt.getTime(),
      intervalMs,
      snapshot,
    );

    this.schedules.set(config.networkId, {
      intervalMs,
      nextPollAtMs: Math.max(fetchedAt.getTime(), nextPollAtMs),
    });
  }

  private nextIntervalMs(
    previousIntervalMs: number | undefined,
    usefulness: FetchUsefulness,
  ): number {
    const sustainableFloorMs = this.getSustainableFloorMs();
    const freshnessCeilingMs = this.freshnessCeilingMs();
    const capacityInsufficient =
      sustainableFloorMs !== null && sustainableFloorMs > freshnessCeilingMs;
    const initialIntervalMs = this.initialIntervalMs();
    let desiredIntervalMs: number;

    if (usefulness === "availability-change") {
      desiredIntervalMs = Math.ceil((previousIntervalMs ?? initialIntervalMs) / 2);
    } else if (usefulness === "freshness-refresh") {
      desiredIntervalMs = previousIntervalMs ?? initialIntervalMs;
    } else if (usefulness === "redundant") {
      desiredIntervalMs = (previousIntervalMs ?? initialIntervalMs) * 2;
    } else {
      desiredIntervalMs = (previousIntervalMs ?? freshnessCeilingMs) * 2;
    }

    if (sustainableFloorMs !== null) {
      desiredIntervalMs = Math.max(desiredIntervalMs, sustainableFloorMs);
    }

    if (!capacityInsufficient) {
      desiredIntervalMs = Math.min(desiredIntervalMs, freshnessCeilingMs);
    }

    return Math.max(1, Math.ceil(desiredIntervalMs));
  }

  private initialIntervalMs(): number {
    const sustainableFloorMs = this.getSustainableFloorMs();
    const freshnessCeilingMs = this.freshnessCeilingMs();

    if (sustainableFloorMs === null) {
      return freshnessCeilingMs;
    }

    const initialIntervalMs = Math.ceil(sustainableFloorMs * 1.5);

    return sustainableFloorMs > freshnessCeilingMs
      ? initialIntervalMs
      : Math.min(initialIntervalMs, freshnessCeilingMs);
  }

  private freshnessCeilingMs(): number {
    const maxStalenessMs = this.options.maxStalenessSeconds * 1_000;
    const safetyMarginMs = Math.min(
      POLL_EXPIRY_SAFETY_MS,
      Math.floor(maxStalenessMs / 2),
    );

    return Math.max(1, maxStalenessMs - safetyMarginMs);
  }

  private expirySafetyMs(): number {
    return Math.min(
      POLL_EXPIRY_SAFETY_MS,
      Math.floor((this.options.maxStalenessSeconds * 1_000) / 2),
    );
  }

  private nextPollDeadlineMs(
    startMs: number,
    intervalMs: number,
    snapshot: NormalizedNetworkSnapshot | null,
  ): number {
    const adaptiveDeadlineMs = startMs + intervalMs;

    if (snapshot === null || this.isCapacityInsufficient()) {
      return adaptiveDeadlineMs;
    }

    const expiryDeadlineMs =
      snapshot.validUntil.getTime() - this.expirySafetyMs();
    const preferredDeadlineMs = Math.min(adaptiveDeadlineMs, expiryDeadlineMs);
    const sustainableFloorMs = this.getSustainableFloorMs();

    return sustainableFloorMs === null
      ? preferredDeadlineMs
      : Math.max(startMs + sustainableFloorMs, preferredDeadlineMs);
  }

  private isUsableAt(
    snapshot: NormalizedNetworkSnapshot,
    asOf: Date,
  ): boolean {
    const asOfMs = asOf.getTime();

    return (
      snapshot.validFrom.getTime() <= asOfMs &&
      asOfMs < snapshot.validUntil.getTime()
    );
  }

  private cityKey(cityConfig: CityConfig): string {
    return `${cityConfig.countryCode}:${cityConfig.city}`;
  }
}
