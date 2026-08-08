import {
  fetchCityBikesNetwork,
  type CityBikesFetchResult,
} from "../citybikes/client";
import {
  isCompleteTraceRound,
  traceRoundAvailableAt,
  type RawTraceResponse,
  type RecordedTrace,
} from "./trace-format";

function copyResponse(response: RawTraceResponse): RawTraceResponse {
  return {
    networkId: response.networkId,
    capturedAt: new Date(response.capturedAt.getTime()),
    status: response.status,
    headers: response.headers.map(([name, value]) => [name, value]),
    body: response.body,
  };
}

export class TraceReplay {
  constructor(private readonly trace: RecordedTrace) {}

  response(networkId: string, at: Date): RawTraceResponse | null {
    let selected: RawTraceResponse | null = null;
    let selectedAt = -Infinity;

    for (const round of this.trace.rounds) {
      const availableAt = traceRoundAvailableAt(round).getTime();

      if (
        availableAt > at.getTime() ||
        availableAt < selectedAt ||
        !isCompleteTraceRound(round, this.trace.networkIds)
      ) {
        continue;
      }

      const response = round.responses.find(
        (candidate) => candidate.networkId === networkId,
      );

      if (response !== undefined) {
        selected = response;
        selectedAt = availableAt;
      }
    }

    return selected === null ? null : copyResponse(selected);
  }

  async fetchNetwork(
    networkId: string,
    at: Date,
  ): Promise<CityBikesFetchResult> {
    const response = this.response(networkId, at);

    if (response === null) {
      return {
        kind: "network-error",
        networkId,
        error: new Error("No causal raw trace response"),
      };
    }

    return fetchCityBikesNetwork(
      networkId,
      async () =>
        new Response(response.body, {
          status: response.status,
          headers: new Headers(response.headers),
        }),
    );
  }
}
