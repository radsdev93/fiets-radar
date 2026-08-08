import type { CityBikesFetchResult } from "../citybikes/client";
import type { CityConfig, ConfiguredNetwork } from "../config/cities";
import { normalizeNetworkSnapshot } from "../normalization/network-normalizer";
import type { CityBikesNetworkFetcher } from "../scheduler/adaptive-scheduler";
import type { RequestBudgetController } from "../scheduler/request-budget";
import type { RecordedTrace, TraceRound, TraceSample } from "./trace-format";

export interface TraceRecorderClock {
  now(): Date;
}

export interface TraceRecorderOptions {
  cityConfigs: CityConfig[];
  maxStalenessSeconds: number;
  budget: RequestBudgetController;
  clock: TraceRecorderClock;
  fetchNetwork: CityBikesNetworkFetcher;
}

export interface TraceRecordingResult {
  trace: RecordedTrace;
  stoppedEarly: string | null;
  requests: number;
}

function configuredNetworks(cityConfigs: CityConfig[]): ConfiguredNetwork[] {
  const byId = new Map<string, ConfiguredNetwork>();

  for (const city of cityConfigs) {
    for (const network of city.networks) {
      if (!byId.has(network.networkId)) {
        byId.set(network.networkId, network);
      }
    }
  }

  return [...byId.values()];
}

function reconcileBudget(
  budget: RequestBudgetController,
  result: CityBikesFetchResult,
  observedAt: Date,
): void {
  if (
    result.kind === "success" ||
    result.kind === "malformed-json" ||
    result.kind === "invalid-response"
  ) {
    budget.observeRateLimit(result.rateLimit, observedAt);
  } else if (result.kind === "http-error" && result.rateLimit !== null) {
    budget.observeRateLimit(result.rateLimit, observedAt);
  } else {
    budget.failClosed();
  }
}

function diagnosticKind(result: CityBikesFetchResult): string {
  return result.kind;
}

export class TraceRecorder {
  private readonly networks: ConfiguredNetwork[];

  constructor(private readonly options: TraceRecorderOptions) {
    this.networks = configuredNetworks(options.cityConfigs);
  }

  async record(
    rounds: number,
    intervalSeconds: number,
    wait: (milliseconds: number) => Promise<void>,
  ): Promise<TraceRecordingResult> {
    if (!Number.isSafeInteger(rounds) || rounds <= 0) {
      throw new Error("rounds must be a positive integer");
    }
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
      throw new Error("intervalSeconds must be positive");
    }

    const trace: RecordedTrace = {
      version: 1,
      provider: "CityBikes V2 normalized snapshot trace",
      recordedAt: this.copyDate(this.options.clock.now()),
      maxStalenessSeconds: this.options.maxStalenessSeconds,
      networkIds: this.networks.map((network) => network.networkId),
      rounds: [],
    };
    let requests = 0;
    let stoppedEarly: string | null = null;

    for (let index = 0; index < rounds; index += 1) {
      const remaining = this.options.budget.getState();

      if (
        remaining.kind === "established" &&
        remaining.remaining < this.networks.length
      ) {
        stoppedEarly = "insufficient-budget-for-round";
        trace.rounds.push(this.emptyRound("insufficient-budget-for-round"));
        break;
      }

      const outcome = await this.recordRound();
      trace.rounds.push(outcome.round);
      requests += outcome.requests;

      if (outcome.stoppedEarly !== null) {
        stoppedEarly = outcome.stoppedEarly;
        break;
      }

      if (index + 1 < rounds) {
        await wait(intervalSeconds * 1_000);
      }
    }

    return { trace, stoppedEarly, requests };
  }

  private async recordRound(): Promise<{
    round: TraceRound;
    requests: number;
    stoppedEarly: string | null;
  }> {
    const round: TraceRound = {
      roundAt: this.copyDate(this.options.clock.now()),
      samples: [],
      diagnostics: [],
    };
    let requests = 0;

    for (const network of this.networks) {
      const reservation = this.options.budget.reserve(this.options.clock.now());

      if (reservation.kind === "blocked") {
        round.diagnostics.push({
          networkId: network.networkId,
          kind: `budget-${reservation.reason}`,
        });
        return {
          round,
          requests,
          stoppedEarly: `budget-${reservation.reason}`,
        };
      }

      let result: CityBikesFetchResult;
      requests += 1;

      try {
        result = await this.options.fetchNetwork(network.networkId);
      } catch {
        this.options.budget.failClosed();
        round.diagnostics.push({ networkId: network.networkId, kind: "network-error" });
        return { round, requests, stoppedEarly: "network-error" };
      }

      const capturedAt = this.copyDate(this.options.clock.now());
      reconcileBudget(this.options.budget, result, capturedAt);

      if (result.kind !== "success") {
        round.diagnostics.push({
          networkId: network.networkId,
          kind: diagnosticKind(result),
        });
        continue;
      }

      const normalized = normalizeNetworkSnapshot(
        network,
        result.payload,
        capturedAt,
        this.options.maxStalenessSeconds,
      );

      if (normalized.kind !== "success") {
        round.diagnostics.push({
          networkId: network.networkId,
          kind: normalized.kind,
        });
        continue;
      }

      const sample: TraceSample = {
        networkId: normalized.networkId,
        capturedAt,
        freeBikes: normalized.freeBikes,
        oldestSourceAt: this.copyDate(normalized.oldestSourceAt),
        newestSourceAt: this.copyDate(normalized.newestSourceAt),
        validFrom: this.copyDate(normalized.validFrom),
        validUntil: this.copyDate(normalized.validUntil),
      };
      round.samples.push(sample);
    }

    return { round, requests, stoppedEarly: null };
  }

  private emptyRound(kind: string): TraceRound {
    return {
      roundAt: this.copyDate(this.options.clock.now()),
      samples: [],
      diagnostics: this.networks.map((network) => ({
        networkId: network.networkId,
        kind,
      })),
    };
  }

  private copyDate(date: Date): Date {
    return new Date(date.getTime());
  }
}
