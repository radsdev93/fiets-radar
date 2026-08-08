import type { CityBikesFetchResult } from "../citybikes/client";
import type { CityConfig, ConfiguredNetwork } from "../config/cities";
import { composeCitySnapshot } from "../composition/city-composer";
import {
  calculateHourlyAverageFromValidity,
  type HourlyResult,
} from "../core/aggregator";
import {
  normalizeNetworkSnapshot,
  type NetworkNormalizationResult,
} from "../normalization/network-normalizer";
import {
  AdaptiveScheduler,
  type SchedulerClock,
  type SchedulerPollingMode,
} from "../scheduler/adaptive-scheduler";
import { RequestBudgetController } from "../scheduler/request-budget";
import { SqliteStore } from "../storage/sqlite-store";
import { resolveTraceCities } from "../trace/city-selection";
import { TraceReplay } from "../trace/replay";
import {
  isCompleteTraceRound,
  traceRoundAvailableAt,
  type RecordedTrace,
  type TraceRound,
} from "../trace/trace-format";

const R5_WINDOW_MS = 300_000;
const DEFAULT_EVALUATION_TICK_SECONDS = 30;

type NormalizedSnapshot = Extract<
  NetworkNormalizationResult,
  { kind: "success" }
>;

export interface BenchmarkMetrics {
  requests: number;
  meanStalenessSeconds: number | null;
  p95StalenessSeconds: number | null;
  stalenessSampleCount: number;
  redundantRatio: number;
  r5Compliance: number;
  maeFreeBikes: number | null;
  maeSampleCount: number;
}

export interface BenchmarkResult {
  adaptive: BenchmarkMetrics;
  fixed: BenchmarkMetrics;
  comparison: {
    adaptiveWins: string[];
    fixedWins: string[];
    ties: string[];
  };
  metadata: {
    selectedCities: string[];
    traceRounds: number;
    completeTraceRounds: number;
    durationSeconds: number;
    requestBudget: number;
    fixedIntervalSeconds: number;
    evaluationTickSeconds: number;
  };
}

interface StrategyRun {
  metrics: Omit<BenchmarkMetrics, "maeFreeBikes" | "maeSampleCount">;
  hourlyResults: Map<string, HourlyResult>;
}

class VirtualClock implements SchedulerClock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(date: Date): void {
    this.current = new Date(date.getTime());
  }
}

function configuredNetworks(cityConfigs: readonly CityConfig[]): ConfiguredNetwork[] {
  const networks = new Map<string, ConfiguredNetwork>();

  for (const city of cityConfigs) {
    for (const network of city.networks) {
      if (!networks.has(network.networkId)) {
        networks.set(network.networkId, network);
      }
    }
  }

  return [...networks.values()];
}

function cityKey(city: CityConfig, hourStart: Date): string {
  return `${city.countryCode}:${city.city}:${hourStart.toISOString()}`;
}

function completeCitySnapshot(
  store: SqliteStore,
  city: CityConfig,
  at: Date,
) {
  const snapshots = new Map<string, NormalizedSnapshot>();

  for (const network of city.networks) {
    const snapshot = store.findUsableNetworkSnapshot(network.networkId, at);

    if (snapshot !== null) {
      snapshots.set(network.networkId, snapshot);
    }
  }

  const composed = composeCitySnapshot(city, snapshots, at);
  return composed.kind === "complete" ? composed : null;
}

export function completedHourStarts(start: Date, end: Date): Date[] {
  const hourStart = new Date(start.getTime());
  hourStart.setUTCMinutes(0, 0, 0);
  const starts: Date[] = [];

  for (
    let current = hourStart.getTime();
    current + 3_600_000 <= end.getTime();
    current += 3_600_000
  ) {
    starts.push(new Date(current));
  }

  return starts;
}

function hourlyResults(
  store: SqliteStore,
  cityConfigs: readonly CityConfig[],
  start: Date,
  end: Date,
): Map<string, HourlyResult> {
  const results = new Map<string, HourlyResult>();

  for (const hourStart of completedHourStarts(start, end)) {
    const hourEnd = new Date(hourStart.getTime() + 3_600_000);

    for (const city of cityConfigs) {
      const observations = store.getCityObservationsForHour(
        city.city,
        city.countryCode,
        hourStart,
        hourEnd,
      );
      const result = calculateHourlyAverageFromValidity(
        observations,
        hourStart,
        hourEnd,
      );
      store.saveHourlyResult(city.city, city.countryCode, hourStart, result);
      const persistedResult = store.getHourlyResult(
        city.city,
        city.countryCode,
        hourStart,
      );

      if (persistedResult !== null) {
        results.set(cityKey(city, hourStart), persistedResult);
      }
    }
  }

  return results;
}

interface VirtualEvent {
  at: Date;
  isRegularTick: boolean;
}

function virtualEvents(
  start: Date,
  end: Date,
  tickMs: number,
  rounds: readonly TraceRound[],
): VirtualEvent[] {
  const events = new Map<number, boolean>();

  for (let time = start.getTime(); time <= end.getTime(); time += tickMs) {
    events.set(time, true);
  }
  if (!events.has(end.getTime())) {
    events.set(end.getTime(), false);
  }
  for (const round of rounds) {
    const time = traceRoundAvailableAt(round).getTime();
    if (!events.has(time)) {
      events.set(time, false);
    }
  }

  return [...events]
    .sort(([left], [right]) => left - right)
    .map(([time, isRegularTick]) => ({
      at: new Date(time),
      isRegularTick,
    }));
}

function addObservation(
  observations: Map<string, Date[]>,
  city: string,
  at: Date,
): void {
  const values = observations.get(city) ?? [];
  const previous = values[values.length - 1];

  if (previous === undefined || previous.getTime() !== at.getTime()) {
    values.push(new Date(at.getTime()));
    observations.set(city, values);
  }
}

function virtualRateLimitResult(
  result: CityBikesFetchResult,
  limit: number,
  remaining: number,
  resetAfterSeconds: number,
): CityBikesFetchResult {
  const rateLimit = { limit, remaining, resetAfterSeconds };

  if (
    result.kind === "success" ||
    result.kind === "malformed-json" ||
    result.kind === "invalid-response"
  ) {
    return { ...result, rateLimit };
  }

  if (result.kind === "http-error" && result.rateLimit !== null) {
    return { ...result, rateLimit };
  }

  return result;
}

async function normalizeCompleteRound(
  replay: TraceReplay,
  round: TraceRound,
  networks: readonly ConfiguredNetwork[],
  maxStalenessSeconds: number,
): Promise<Map<string, NormalizedSnapshot> | null> {
  const snapshots = new Map<string, NormalizedSnapshot>();

  if (!isCompleteTraceRound(round, networks.map((network) => network.networkId))) {
    return null;
  }

  for (const network of networks) {
    const rawResponse = round.responses.find(
      (response) => response.networkId === network.networkId,
    );

    if (rawResponse === undefined) {
      return null;
    }

    const result = await replay.fetchNetwork(
      network.networkId,
      traceRoundAvailableAt(round),
    );

    if (result.kind !== "success") {
      return null;
    }

    const normalized = normalizeNetworkSnapshot(
      network,
      result.payload,
      rawResponse.capturedAt,
      maxStalenessSeconds,
    );

    if (normalized.kind !== "success") {
      return null;
    }

    snapshots.set(network.networkId, normalized);
  }

  return snapshots;
}

async function buildGroundTruth(
  trace: RecordedTrace,
  cityConfigs: readonly CityConfig[],
  networks: readonly ConfiguredNetwork[],
): Promise<{ store: SqliteStore; rounds: TraceRound[] }> {
  const store = new SqliteStore(":memory:");
  const replay = new TraceReplay(trace);
  const completeRounds: TraceRound[] = [];

  for (const round of [...trace.rounds].sort(
    (left, right) =>
      traceRoundAvailableAt(left).getTime() -
      traceRoundAvailableAt(right).getTime(),
  )) {
    const snapshots = await normalizeCompleteRound(
      replay,
      round,
      networks,
      trace.maxStalenessSeconds,
    );

    if (snapshots === null) {
      continue;
    }

    const availableAt = traceRoundAvailableAt(round);

    for (const city of cityConfigs) {
      const composition = composeCitySnapshot(city, snapshots, availableAt);

      if (composition.kind === "complete") {
        store.saveCityObservation(composition);
      }
    }

    completeRounds.push(round);
  }

  return { store, rounds: completeRounds };
}

function compareMetric(
  adaptive: number | null,
  fixed: number | null,
  lowerIsBetter: boolean,
): "adaptive" | "fixed" | "tie" {
  if (adaptive === null || fixed === null || adaptive === fixed) {
    return "tie";
  }
  return (lowerIsBetter ? adaptive < fixed : adaptive > fixed)
    ? "adaptive"
    : "fixed";
}

export function mean(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((total, value) => total + value, 0) / values.length;
}

export function percentile95(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null;
}

export function rollingR5Compliance(
  observationsByCity: ReadonlyMap<string, readonly Date[]>,
  cities: readonly string[],
  start: Date,
  end: Date,
): number {
  const windowEndDomainStart = start.getTime() + R5_WINDOW_MS;
  const windowEndDomainEnd = end.getTime();
  const completeWindowDurationMs = windowEndDomainEnd - windowEndDomainStart;

  if (cities.length === 0 || completeWindowDurationMs <= 0) {
    return 0;
  }

  let coveredMs = 0;

  for (const city of cities) {
    const intervals = (observationsByCity.get(city) ?? [])
      .map((observation) => ({
        start: Math.max(windowEndDomainStart, observation.getTime()),
        end: Math.min(
          windowEndDomainEnd,
          observation.getTime() + R5_WINDOW_MS,
        ),
      }))
      .filter((interval) => interval.end > interval.start)
      .sort((left, right) => left.start - right.start);
    let previousEnd = -Infinity;

    for (const interval of intervals) {
      const intervalStart = Math.max(interval.start, previousEnd);

      if (interval.end > intervalStart) {
        coveredMs += interval.end - intervalStart;
        previousEnd = interval.end;
      }
    }
  }

  return coveredMs / (cities.length * completeWindowDurationMs);
}

export function hourlyMeanAbsoluteError(
  strategy: ReadonlyMap<string, HourlyResult>,
  groundTruth: ReadonlyMap<string, HourlyResult>,
): { value: number | null; sampleCount: number } {
  let total = 0;
  let sampleCount = 0;

  for (const [key, strategyResult] of strategy) {
    const groundTruthResult = groundTruth.get(key);

    if (
      groundTruthResult === undefined ||
      strategyResult.averageFreeBikes === null ||
      groundTruthResult.averageFreeBikes === null
    ) {
      continue;
    }

    total += Math.abs(
      strategyResult.averageFreeBikes - groundTruthResult.averageFreeBikes,
    );
    sampleCount += 1;
  }

  return {
    value: sampleCount === 0 ? null : total / sampleCount,
    sampleCount,
  };
}

async function runStrategy(
  trace: RecordedTrace,
  cityConfigs: CityConfig[],
  requestBudget: number,
  mode: SchedulerPollingMode,
  start: Date,
  end: Date,
  tickSeconds: number,
  completeRounds: readonly TraceRound[],
): Promise<StrategyRun> {
  const clock = new VirtualClock(start);
  const store = new SqliteStore(":memory:");
  const budget = new RequestBudgetController(store);
  const replay = new TraceReplay(trace);
  const networks = configuredNetworks(cityConfigs);
  const observations = new Map<string, Date[]>();
  const staleness: number[] = [];
  let requests = 0;
  const scheduler = new AdaptiveScheduler({
    cityConfigs,
    store,
    budget,
    clock,
    maxStalenessSeconds: trace.maxStalenessSeconds,
    pollingMode: mode,
    fetchNetwork: async (networkId) => {
      requests += 1;
      const rawResult = await replay.fetchNetwork(networkId, clock.now());
      return virtualRateLimitResult(
        rawResult,
        requestBudget,
        Math.max(0, requestBudget - requests),
        Math.max(0, Math.ceil((end.getTime() - clock.now().getTime()) / 1_000)),
      );
    },
  });

  try {
    for (const event of virtualEvents(
      start,
      end,
      tickSeconds * 1_000,
      completeRounds,
    )) {
      const { at: time, isRegularTick } = event;
      clock.set(time);

      if (time.getTime() < end.getTime()) {
        for (let attempt = 0; attempt <= networks.length; attempt += 1) {
          const step = await scheduler.step();

          for (const city of step.materializedCities) {
            addObservation(observations, city, time);
          }

          if (step.kind === "idle" || step.kind === "blocked") {
            break;
          }
        }
      }

      if (isRegularTick) {
        for (const city of cityConfigs) {
          const estimate = completeCitySnapshot(store, city, time);

          if (estimate !== null) {
            staleness.push(
              Math.max(
                0,
                (time.getTime() - estimate.oldestSourceAt.getTime()) / 1_000,
              ),
            );
          }
        }
      }
    }

    const schedulerMetrics = scheduler.getMetrics();

    return {
      metrics: {
        requests: schedulerMetrics.totalFetches,
        meanStalenessSeconds: mean(staleness),
        p95StalenessSeconds: percentile95(staleness),
        stalenessSampleCount: staleness.length,
        redundantRatio: schedulerMetrics.redundantRatio,
        r5Compliance: rollingR5Compliance(
          observations,
          cityConfigs.map((city) => city.city),
          start,
          end,
        ),
      },
      hourlyResults: hourlyResults(store, cityConfigs, start, end),
    };
  } finally {
    store.close();
  }
}

export async function runBenchmark(options: {
  trace: RecordedTrace;
  cityConfigs: CityConfig[];
  requestBudget: number;
  evaluationTickSeconds?: number;
}): Promise<BenchmarkResult> {
  if (!Number.isSafeInteger(options.requestBudget) || options.requestBudget <= 0) {
    throw new Error("requestBudget must be a positive safe integer");
  }

  const tickSeconds = options.evaluationTickSeconds ?? DEFAULT_EVALUATION_TICK_SECONDS;

  if (!Number.isSafeInteger(tickSeconds) || tickSeconds <= 0) {
    throw new Error("evaluationTickSeconds must be a positive safe integer");
  }

  const cities = resolveTraceCities(options.trace.selectedCities, options.cityConfigs);
  const networks = configuredNetworks(cities);
  const groundTruth = await buildGroundTruth(options.trace, cities, networks);
  const firstRound = groundTruth.rounds[0];
  const lastRound = groundTruth.rounds[groundTruth.rounds.length - 1];

  if (firstRound === undefined || lastRound === undefined) {
    groundTruth.store.close();
    throw new Error("Trace has no normalized complete rounds for the selected cities");
  }

  const start = traceRoundAvailableAt(firstRound);
  const rawEnd = traceRoundAvailableAt(lastRound);
  const durationMs = Math.max(tickSeconds * 1_000, rawEnd.getTime() - start.getTime());
  const end = new Date(start.getTime() + durationMs);
  const fixedIntervalMs = Math.max(
    1,
    Math.ceil((networks.length * durationMs) / options.requestBudget),
  );

  try {
    const adaptive = await runStrategy(
      options.trace,
      cities,
      options.requestBudget,
      { kind: "adaptive" },
      start,
      end,
      tickSeconds,
      groundTruth.rounds,
    );
    const fixed = await runStrategy(
      options.trace,
      cities,
      options.requestBudget,
      { kind: "fixed", intervalMs: fixedIntervalMs },
      start,
      end,
      tickSeconds,
      groundTruth.rounds,
    );
    const groundTruthHourly = hourlyResults(groundTruth.store, cities, start, end);
    const adaptiveMae = hourlyMeanAbsoluteError(adaptive.hourlyResults, groundTruthHourly);
    const fixedMae = hourlyMeanAbsoluteError(fixed.hourlyResults, groundTruthHourly);
    const adaptiveMetrics: BenchmarkMetrics = {
      ...adaptive.metrics,
      maeFreeBikes: adaptiveMae.value,
      maeSampleCount: adaptiveMae.sampleCount,
    };
    const fixedMetrics: BenchmarkMetrics = {
      ...fixed.metrics,
      maeFreeBikes: fixedMae.value,
      maeSampleCount: fixedMae.sampleCount,
    };
    const comparison: BenchmarkResult["comparison"] = {
      adaptiveWins: [],
      fixedWins: [],
      ties: [],
    };
    const comparisons: Array<{
      name: string;
      result: "adaptive" | "fixed" | "tie";
    }> = [
      { name: "requests", result: compareMetric(adaptiveMetrics.requests, fixedMetrics.requests, true) },
      { name: "meanStalenessSeconds", result: compareMetric(adaptiveMetrics.meanStalenessSeconds, fixedMetrics.meanStalenessSeconds, true) },
      { name: "p95StalenessSeconds", result: compareMetric(adaptiveMetrics.p95StalenessSeconds, fixedMetrics.p95StalenessSeconds, true) },
      { name: "redundantRatio", result: compareMetric(adaptiveMetrics.redundantRatio, fixedMetrics.redundantRatio, true) },
      { name: "r5Compliance", result: compareMetric(adaptiveMetrics.r5Compliance, fixedMetrics.r5Compliance, false) },
      { name: "maeFreeBikes", result: compareMetric(adaptiveMetrics.maeFreeBikes, fixedMetrics.maeFreeBikes, true) },
    ];

    for (const comparisonResult of comparisons) {
      if (comparisonResult.result === "adaptive") {
        comparison.adaptiveWins.push(comparisonResult.name);
      } else if (comparisonResult.result === "fixed") {
        comparison.fixedWins.push(comparisonResult.name);
      } else {
        comparison.ties.push(comparisonResult.name);
      }
    }

    return {
      adaptive: adaptiveMetrics,
      fixed: fixedMetrics,
      comparison,
      metadata: {
        selectedCities: cities.map((city) => city.city),
        traceRounds: options.trace.rounds.length,
        completeTraceRounds: groundTruth.rounds.length,
        durationSeconds: durationMs / 1_000,
        requestBudget: options.requestBudget,
        fixedIntervalSeconds: fixedIntervalMs / 1_000,
        evaluationTickSeconds: tickSeconds,
      },
    };
  } finally {
    groundTruth.store.close();
  }
}
