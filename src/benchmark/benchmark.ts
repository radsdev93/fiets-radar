import { cityBikesResponseSchema } from "../citybikes/schemas";
import type { CityConfig, ConfiguredNetwork } from "../config/cities";
import { composeCitySnapshot } from "../composition/city-composer";
import type { NetworkNormalizationResult } from "../normalization/network-normalizer";
import {
  AdaptiveScheduler,
  type SchedulerClock,
  type SchedulerPollingMode,
} from "../scheduler/adaptive-scheduler";
import { RequestBudgetController } from "../scheduler/request-budget";
import { SqliteStore } from "../storage/sqlite-store";
import { createTraceReplayNormalizer, TraceReplay } from "../trace/replay";
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
    traceRounds: number;
    completeTraceRounds: number;
    durationSeconds: number;
    requestBudget: number;
    fixedIntervalSeconds: number;
    evaluationTickSeconds: number;
  };
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

function configuredNetworks(cityConfigs: CityConfig[]): ConfiguredNetwork[] {
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

function cityKey(city: CityConfig): string {
  return `${city.countryCode}:${city.city}`;
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

  const result = composeCitySnapshot(city, snapshots, at);
  return result.kind === "complete" ? result : null;
}

function traceGroundTruth(
  round: TraceRound,
  city: CityConfig,
): ReturnType<typeof completeCitySnapshot> {
  const snapshots = new Map<string, NormalizedSnapshot>();

  for (const network of city.networks) {
    const sample = round.samples.find(
      (candidate) => candidate.networkId === network.networkId,
    );

    if (sample === undefined) {
      continue;
    }

    snapshots.set(network.networkId, {
      kind: "success",
      networkId: sample.networkId,
      freeBikes: sample.freeBikes,
      oldestSourceAt: new Date(sample.oldestSourceAt.getTime()),
      newestSourceAt: new Date(sample.newestSourceAt.getTime()),
      validFrom: new Date(sample.validFrom.getTime()),
      validUntil: new Date(sample.validUntil.getTime()),
      fetchedAt: new Date(sample.capturedAt.getTime()),
    });
  }

  const result = composeCitySnapshot(city, snapshots, traceRoundAvailableAt(round));
  return result.kind === "complete" ? result : null;
}

function sortedVirtualTimes(
  start: Date,
  end: Date,
  tickMs: number,
  rounds: TraceRound[],
): Date[] {
  const times = new Set<number>();

  for (let time = start.getTime(); time <= end.getTime(); time += tickMs) {
    times.add(time);
  }
  times.add(end.getTime());
  for (const round of rounds) {
    times.add(traceRoundAvailableAt(round).getTime());
  }

  return [...times]
    .sort((left, right) => left - right)
    .map((time) => new Date(time));
}

function addObservation(
  observations: Map<string, Date[]>,
  city: string,
  at: Date,
): void {
  const existing = observations.get(city) ?? [];
  const previous = existing[existing.length - 1];

  if (previous === undefined || previous.getTime() !== at.getTime()) {
    existing.push(new Date(at.getTime()));
    observations.set(city, existing);
  }
}

function metricOrder(
  adaptive: number | null,
  fixed: number | null,
  lowerIsBetter: boolean,
): "adaptive" | "fixed" | "tie" {
  if (adaptive === null || fixed === null) {
    return "tie";
  }
  if (adaptive === fixed) {
    return "tie";
  }
  const adaptiveBetter = lowerIsBetter ? adaptive < fixed : adaptive > fixed;
  return adaptiveBetter ? "adaptive" : "fixed";
}

export function percentile95(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[index] ?? null;
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function meanAbsoluteError(
  pairs: ReadonlyArray<{ actual: number; expected: number }>,
): number | null {
  if (pairs.length === 0) {
    return null;
  }

  return (
    pairs.reduce(
      (total, pair) => total + Math.abs(pair.actual - pair.expected),
      0,
    ) / pairs.length
  );
}

export function rollingR5Compliance(
  observationsByCity: ReadonlyMap<string, readonly Date[]>,
  cities: readonly string[],
  start: Date,
  end: Date,
): number {
  const durationMs = end.getTime() - start.getTime();

  if (cities.length === 0 || durationMs <= 0) {
    return 0;
  }

  let compliantMs = 0;

  for (const city of cities) {
    const intervals = (observationsByCity.get(city) ?? [])
      .map((observation) => ({
        start: Math.max(start.getTime(), observation.getTime()),
        end: Math.min(end.getTime(), observation.getTime() + R5_WINDOW_MS),
      }))
      .filter((interval) => interval.end > interval.start)
      .sort((left, right) => left.start - right.start);
    let coveredUntil = -Infinity;

    for (const interval of intervals) {
      const intervalStart = Math.max(interval.start, coveredUntil);

      if (interval.end > intervalStart) {
        compliantMs += interval.end - intervalStart;
        coveredUntil = interval.end;
      }
    }
  }

  return compliantMs / (cities.length * durationMs);
}

async function runStrategy(
  trace: RecordedTrace,
  cityConfigs: CityConfig[],
  requestBudget: number,
  mode: SchedulerPollingMode,
  start: Date,
  end: Date,
  evaluationTickSeconds: number,
  completeRounds: TraceRound[],
): Promise<BenchmarkMetrics> {
  const clock = new VirtualClock(start);
  const store = new SqliteStore(":memory:");
  const budget = new RequestBudgetController(store);
  const replay = new TraceReplay(trace);
  const networkCount = configuredNetworks(cityConfigs).length;
  let fetches = 0;
  const scheduler = new AdaptiveScheduler({
    cityConfigs,
    store,
    budget,
    clock,
    maxStalenessSeconds: trace.maxStalenessSeconds,
    pollingMode: mode,
    normalizer: createTraceReplayNormalizer(replay),
    fetchNetwork: async (networkId) => {
      fetches += 1;
      const remaining = Math.max(0, requestBudget - fetches);
      const resetAfterSeconds = Math.max(
        0,
        Math.ceil((end.getTime() - clock.now().getTime()) / 1_000),
      );

      return {
        kind: "success",
        networkId,
        rateLimit: {
          limit: requestBudget,
          remaining,
          resetAfterSeconds,
        },
        payload: cityBikesResponseSchema.parse({
          network: {
            stations: [
              {
                id: "trace-replay-placeholder",
                latitude: 0,
                longitude: 0,
                timestamp: "2026-08-08T00:00:00Z",
                free_bikes: 0,
              },
            ],
          },
        }),
      };
    },
  });
  const observations = new Map<string, Date[]>();
  const staleness: number[] = [];
  const maePairs: Array<{ actual: number; expected: number }> = [];
  const roundsByTime = new Map<number, TraceRound>();

  for (const round of completeRounds) {
    roundsByTime.set(traceRoundAvailableAt(round).getTime(), round);
  }

  try {
    for (const time of sortedVirtualTimes(
      start,
      end,
      evaluationTickSeconds * 1_000,
      completeRounds,
    )) {
      clock.set(time);

      const round = roundsByTime.get(time.getTime());

      if (round !== undefined) {
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

          const groundTruth = traceGroundTruth(round, city);

          if (estimate !== null && groundTruth !== null) {
            maePairs.push({
              actual: estimate.freeBikes,
              expected: groundTruth.freeBikes,
            });
          }
        }
      }

      if (time.getTime() < end.getTime()) {
        for (let attempts = 0; attempts <= networkCount; attempts += 1) {
          const step = await scheduler.step();

          for (const city of step.materializedCities) {
            addObservation(observations, city, time);
          }

          if (step.kind === "idle" || step.kind === "blocked") {
            break;
          }
        }
      }

    }

    const metrics = scheduler.getMetrics();
    const cityKeys = cityConfigs.map((city) => city.city);

    return {
      requests: metrics.totalFetches,
      meanStalenessSeconds: mean(staleness),
      p95StalenessSeconds: percentile95(staleness),
      stalenessSampleCount: staleness.length,
      redundantRatio: metrics.redundantRatio,
      r5Compliance: rollingR5Compliance(observations, cityKeys, start, end),
      maeFreeBikes: meanAbsoluteError(maePairs),
      maeSampleCount: maePairs.length,
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

  const evaluationTickSeconds =
    options.evaluationTickSeconds ?? DEFAULT_EVALUATION_TICK_SECONDS;

  if (!Number.isSafeInteger(evaluationTickSeconds) || evaluationTickSeconds <= 0) {
    throw new Error("evaluationTickSeconds must be a positive safe integer");
  }

  const networks = configuredNetworks(options.cityConfigs);
  const completeRounds = options.trace.rounds
    .filter((round) => isCompleteTraceRound(round, networks.map((network) => network.networkId)))
    .sort(
      (left, right) =>
        traceRoundAvailableAt(left).getTime() -
        traceRoundAvailableAt(right).getTime(),
    );
  const firstRound = completeRounds[0];
  const lastRound = completeRounds[completeRounds.length - 1];

  if (firstRound === undefined || lastRound === undefined) {
    throw new Error("Trace has no complete rounds for the configured networks");
  }

  const start = traceRoundAvailableAt(firstRound);
  const end = traceRoundAvailableAt(lastRound);
  const durationMs = Math.max(
    evaluationTickSeconds * 1_000,
    end.getTime() - start.getTime(),
  );
  const benchmarkEnd = new Date(start.getTime() + durationMs);
  const fixedIntervalMs = Math.max(
    1,
    Math.ceil((networks.length * durationMs) / options.requestBudget),
  );
  const adaptive = await runStrategy(
    options.trace,
    options.cityConfigs,
    options.requestBudget,
    { kind: "adaptive" },
    start,
    benchmarkEnd,
    evaluationTickSeconds,
    completeRounds,
  );
  const fixed = await runStrategy(
    options.trace,
    options.cityConfigs,
    options.requestBudget,
    { kind: "fixed", intervalMs: fixedIntervalMs },
    start,
    benchmarkEnd,
    evaluationTickSeconds,
    completeRounds,
  );
  const comparison: BenchmarkResult["comparison"] = {
    adaptiveWins: [],
    fixedWins: [],
    ties: [],
  };
  const comparisons: Array<{
    name: string;
    result: "adaptive" | "fixed" | "tie";
  }> = [
    { name: "requests", result: metricOrder(adaptive.requests, fixed.requests, true) },
    {
      name: "meanStalenessSeconds",
      result: metricOrder(adaptive.meanStalenessSeconds, fixed.meanStalenessSeconds, true),
    },
    {
      name: "p95StalenessSeconds",
      result: metricOrder(adaptive.p95StalenessSeconds, fixed.p95StalenessSeconds, true),
    },
    {
      name: "redundantRatio",
      result: metricOrder(adaptive.redundantRatio, fixed.redundantRatio, true),
    },
    {
      name: "r5Compliance",
      result: metricOrder(adaptive.r5Compliance, fixed.r5Compliance, false),
    },
    {
      name: "maeFreeBikes",
      result: metricOrder(adaptive.maeFreeBikes, fixed.maeFreeBikes, true),
    },
  ];

  for (const item of comparisons) {
    if (item.result === "adaptive") {
      comparison.adaptiveWins.push(item.name);
    } else if (item.result === "fixed") {
      comparison.fixedWins.push(item.name);
    } else {
      comparison.ties.push(item.name);
    }
  }

  return {
    adaptive,
    fixed,
    comparison,
    metadata: {
      traceRounds: options.trace.rounds.length,
      completeTraceRounds: completeRounds.length,
      durationSeconds: durationMs / 1_000,
      requestBudget: options.requestBudget,
      fixedIntervalSeconds: fixedIntervalMs / 1_000,
      evaluationTickSeconds,
    },
  };
}
