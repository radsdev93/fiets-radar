import {
  fetchCityBikesNetwork,
  type CityBikesFetchResult,
  type FetchLike,
} from "../citybikes/client";
import type { CityConfig, ConfiguredNetwork } from "../config/cities";
import { normalizeNetworkSnapshot } from "../normalization/network-normalizer";
import type { RequestBudgetController } from "../scheduler/request-budget";
import type { RawTraceResponse, RecordedTrace, TraceRound } from "./trace-format";

export interface TraceRecorderClock {
  now(): Date;
}

export interface TraceRecorderOptions {
  cityConfigs: CityConfig[];
  maxStalenessSeconds: number;
  budget: RequestBudgetController;
  clock: TraceRecorderClock;
  fetchImpl: FetchLike;
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

export class TraceRecorder {
  private readonly networks: ConfiguredNetwork[];

  constructor(private readonly options: TraceRecorderOptions) {
    this.networks = configuredNetworks(options.cityConfigs);
  }

  async record(
    rounds: number,
    intervalSeconds: number,
    wait: (milliseconds: number) => Promise<void>,
  ): Promise<{ trace: RecordedTrace; stoppedEarly: string | null; requests: number }> {
    if (!Number.isSafeInteger(rounds) || rounds <= 0) {
      throw new Error("rounds must be a positive integer");
    }
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
      throw new Error("intervalSeconds must be positive");
    }

    const trace: RecordedTrace = {
      version: 2,
      provider: "CityBikes V2 raw HTTP trace",
      recordedAt: this.copyDate(this.options.clock.now()),
      maxStalenessSeconds: this.options.maxStalenessSeconds,
      selectedCities: this.options.cityConfigs.map((city) => city.city),
      networkIds: this.networks.map((network) => network.networkId),
      rounds: [],
    };
    let requests = 0;
    let stoppedEarly: string | null = null;

    for (let index = 0; index < rounds; index += 1) {
      const budgetState = this.options.budget.getState();

      if (
        budgetState.kind === "established" &&
        budgetState.remaining < this.networks.length
      ) {
        stoppedEarly = "insufficient-budget-for-round";
        trace.rounds.push(this.emptyRound(stoppedEarly));
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
      responses: [],
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

      let recordedResponse: RawTraceResponse | null = null;
      const recordingFetch: FetchLike = async (input, init) => {
        const response = await this.options.fetchImpl(input, init);
        const body = await response.clone().text();
        const capturedAt = this.copyDate(this.options.clock.now());
        recordedResponse = {
          networkId: network.networkId,
          capturedAt,
          status: response.status,
          headers: [...response.headers.entries()].sort((left, right) => {
            const nameOrder = left[0].localeCompare(right[0]);
            return nameOrder === 0 ? left[1].localeCompare(right[1]) : nameOrder;
          }),
          body,
        };
        return response;
      };
      let result: CityBikesFetchResult;
      requests += 1;

      try {
        result = await fetchCityBikesNetwork(network.networkId, recordingFetch);
      } catch {
        this.options.budget.failClosed();
        round.diagnostics.push({ networkId: network.networkId, kind: "network-error" });
        return { round, requests, stoppedEarly: "network-error" };
      }

      const completedAt = this.copyDate(this.options.clock.now());

      if (recordedResponse !== null) {
        round.responses.push(recordedResponse);
      }

      reconcileBudget(this.options.budget, result, completedAt);

      if (result.kind !== "success") {
        round.diagnostics.push({ networkId: network.networkId, kind: result.kind });
        continue;
      }

      const normalized = normalizeNetworkSnapshot(
        network,
        result.payload,
        completedAt,
        this.options.maxStalenessSeconds,
      );

      if (normalized.kind !== "success") {
        round.diagnostics.push({ networkId: network.networkId, kind: normalized.kind });
      }
    }

    return { round, requests, stoppedEarly: null };
  }

  private emptyRound(kind: string): TraceRound {
    return {
      roundAt: this.copyDate(this.options.clock.now()),
      responses: [],
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
