import type { CityConfig } from "../src/config/cities";
import {
  completedHourStarts,
  runBenchmark,
  hourlyMeanAbsoluteError,
  percentile95,
  rollingR5Compliance,
} from "../src/benchmark/benchmark";
import { resolveTraceCities } from "../src/trace/city-selection";
import { TraceRecorder } from "../src/trace/recorder";
import { TraceReplay } from "../src/trace/replay";
import { parseRecordedTrace, serializeRecordedTrace } from "../src/trace/trace-format";
import { RequestBudgetController } from "../src/scheduler/request-budget";
import { SqliteStore } from "../src/storage/sqlite-store";

function at(value: string): Date {
  return new Date(`2026-08-08T${value}Z`);
}

const TRACE_CITY: CityConfig = {
  city: "Trace City",
  countryCode: "TC",
  networks: [{ networkId: "network-a", mode: "stations-only" }],
};

const OTHER_CITY: CityConfig = {
  city: "Other City",
  countryCode: "OC",
  networks: [{ networkId: "network-b", mode: "stations-only" }],
};

function responseBody(freeBikes: number, timestamp: string): string {
  return JSON.stringify({
    network: {
      stations: [
        {
          id: "station-a",
          latitude: 1,
          longitude: 1,
          timestamp,
          free_bikes: freeBikes,
        },
      ],
    },
  });
}

function rawTrace() {
  return {
    version: 2,
    provider: "CityBikes V2",
    recordedAt: "2026-08-08T12:00:00.000Z",
    maxStalenessSeconds: 900,
    selectedCities: ["Trace City"],
    networkIds: ["network-a"],
    rounds: [
      {
        roundAt: "2026-08-08T12:00:00.000Z",
        responses: [
          {
            networkId: "network-a",
            capturedAt: "2026-08-08T12:00:05.000Z",
            status: 200,
            headers: [
              ["ratelimit-limit", "10"],
              ["ratelimit-remaining", "9"],
              ["ratelimit-reset", "3600"],
            ],
            body: responseBody(10, "2026-08-08T12:00:00Z"),
          },
        ],
        diagnostics: [],
      },
      {
        roundAt: "2026-08-08T12:05:00.000Z",
        responses: [
          {
            networkId: "network-a",
            capturedAt: "2026-08-08T12:05:05.000Z",
            status: 200,
            headers: [
              ["ratelimit-limit", "10"],
              ["ratelimit-remaining", "8"],
              ["ratelimit-reset", "3300"],
            ],
            body: responseBody(14, "2026-08-08T12:05:00Z"),
          },
        ],
        diagnostics: [],
      },
    ],
  };
}

function parsedTrace() {
  const trace = parseRecordedTrace(rawTrace());

  if (trace === null) {
    throw new Error("Expected valid raw trace");
  }

  return trace;
}

describe("raw trace V2 and benchmark", () => {
  it("runtime-validates raw HTTP status, headers, body, and capture time", () => {
    const trace = parsedTrace();
    const response = trace.rounds[0]?.responses[0];

    expect(response?.status).toBe(200);
    expect(response?.headers).toContainEqual(["ratelimit-limit", "10"]);
    expect(response?.body).toContain("free_bikes");
    expect(response?.capturedAt).toStrictEqual(at("12:00:05"));
    expect(parseRecordedTrace({ ...rawTrace(), version: 1 })).toBeNull();
    expect(
      parseRecordedTrace({
        ...rawTrace(),
        rounds: [
          {
            ...rawTrace().rounds[0],
            responses: [{ ...rawTrace().rounds[0].responses[0], status: "200" }],
          },
        ],
      }),
    ).toBeNull();
  });

  it("replay does not use future raw responses and routes the body through the CityBikes client", async () => {
    const replay = new TraceReplay(parsedTrace());

    expect(replay.response("network-a", at("12:00:04"))).toBeNull();
    expect(replay.response("network-a", at("12:00:05"))?.body).toContain("free_bikes");
    expect(await replay.fetchNetwork("network-a", at("12:00:05"))).toMatchObject({
      kind: "success",
      networkId: "network-a",
    });
  });

  it("rejects duplicate or pre-round raw responses", () => {
    const firstResponse = rawTrace().rounds[0].responses[0];

    expect(
      parseRecordedTrace({
        ...rawTrace(),
        rounds: [{
          ...rawTrace().rounds[0],
          responses: [firstResponse, firstResponse],
        }],
      }),
    ).toBeNull();
    expect(
      parseRecordedTrace({
        ...rawTrace(),
        rounds: [{
          ...rawTrace().rounds[0],
          responses: [{ ...firstResponse, capturedAt: "2026-08-08T11:59:59.000Z" }],
        }],
      }),
    ).toBeNull();
  });

  it("selects the latest causal raw response and surfaces malformed recorded bodies", async () => {
    const replay = new TraceReplay(parsedTrace());

    expect(replay.response("network-a", at("12:05:04"))?.body).toContain("free_bikes");
    expect(replay.response("network-a", at("12:05:05"))?.body).toContain("14");

    const malformedTrace = parseRecordedTrace({
      ...rawTrace(),
      rounds: [{
        ...rawTrace().rounds[0],
        responses: [{ ...rawTrace().rounds[0].responses[0], body: "{ bad JSON" }],
      }],
    });

    if (malformedTrace === null) {
      throw new Error("Expected structurally valid malformed-body trace");
    }

    expect(
      await new TraceReplay(malformedTrace).fetchNetwork("network-a", at("12:00:05")),
    ).toMatchObject({ kind: "malformed-json" });
  });

  it("serializes V2 responses deterministically", () => {
    const first = serializeRecordedTrace(parsedTrace());
    const second = serializeRecordedTrace(parsedTrace());

    expect(first).toBe(second);
    expect(first).toContain('"version": 2');
  });

  it("uses nearest-rank p95 for source-based staleness reporting", () => {
    expect(percentile95([0, 10, 20, 30, 40])).toBe(40);
  });

  it("resolves an explicit city subset deterministically and rejects invalid selections", () => {
    expect(resolveTraceCities(["Other City", "Trace City"], [TRACE_CITY, OTHER_CITY])).toStrictEqual([
      OTHER_CITY,
      TRACE_CITY,
    ]);
    expect(() => resolveTraceCities(["Trace City", "Trace City"], [TRACE_CITY])).toThrow();
    expect(() => resolveTraceCities(["Missing"], [TRACE_CITY])).toThrow();
  });

  it("records raw responses through the real client path without converting a failure to zero", async () => {
    const store = new SqliteStore(":memory:");
    const recorder = new TraceRecorder({
      cityConfigs: [TRACE_CITY],
      maxStalenessSeconds: 900,
      budget: new RequestBudgetController(store),
      clock: { now: () => at("12:00:05") },
      fetchImpl: async () => new Response(responseBody(10, "2026-08-08T12:00:00Z"), {
        status: 200,
        headers: {
          "ratelimit-limit": "10",
          "ratelimit-remaining": "9",
          "ratelimit-reset": "3600",
        },
      }),
    });

    try {
      const result = await recorder.record(1, 60, async () => undefined);
      expect(result.trace.rounds[0]?.responses[0]?.body).toContain("free_bikes");
      expect(result.trace.rounds[0]?.responses[0]?.status).toBe(200);
      expect(result.trace.rounds[0]?.diagnostics).toStrictEqual([]);
    } finally {
      store.close();
    }
  });

  it("stops the recorder without creating a fake response when its budget is fail-closed", async () => {
    const store = new SqliteStore(":memory:");
    const budget = new RequestBudgetController(store);
    budget.reserve(at("12:00:00"));
    budget.failClosed();
    const recorder = new TraceRecorder({
      cityConfigs: [TRACE_CITY],
      maxStalenessSeconds: 900,
      budget,
      clock: { now: () => at("12:00:05") },
      fetchImpl: async () => new Response("unreachable"),
    });

    try {
      const result = await recorder.record(1, 60, async () => undefined);
      expect(result.requests).toBe(0);
      expect(result.trace.rounds[0]?.responses).toStrictEqual([]);
      expect(result.stoppedEarly).not.toBeNull();
    } finally {
      store.close();
    }
  });

  it("uses selected trace cities only and collects staleness at ticks", async () => {
    const result = await runBenchmark({
      trace: parsedTrace(),
      cityConfigs: [TRACE_CITY, OTHER_CITY],
      requestBudget: 2,
      evaluationTickSeconds: 30,
    });

    expect(result.metadata.selectedCities).toStrictEqual(["Trace City"]);
    expect(result.adaptive.stalenessSampleCount).toBeGreaterThan(2);
  });

  it("samples staleness at regular ticks, not a trace-only availability event", async () => {
    const traceInput = rawTrace();
    const secondRound = traceInput.rounds[1];

    if (secondRound === undefined) {
      throw new Error("Expected second trace round");
    }

    traceInput.rounds[1] = {
      ...secondRound,
      roundAt: "2026-08-08T12:00:15.000Z",
      responses: [{
        ...secondRound.responses[0],
        capturedAt: "2026-08-08T12:00:20.000Z",
        body: responseBody(14, "2026-08-08T12:00:15Z"),
      }],
    };
    const trace = parseRecordedTrace(traceInput);

    if (trace === null) {
      throw new Error("Expected valid trace with an inter-tick availability event");
    }

    const result = await runBenchmark({
      trace,
      cityConfigs: [TRACE_CITY],
      requestBudget: 2,
      evaluationTickSeconds: 30,
    });

    expect(result.adaptive.stalenessSampleCount).toBe(2);
    expect(result.fixed.stalenessSampleCount).toBe(2);
  });

  it("uses only completed clock hours for hourly-average MAE", () => {
    expect(
      completedHourStarts(at("12:20:00"), at("13:40:00")).map((hour) =>
        hour.toISOString(),
      ),
    ).toStrictEqual(["2026-08-08T12:00:00.000Z"]);
  });

  it("measures rolling R5 compliance over complete rolling windows", () => {
    const observations = new Map<string, readonly Date[]>([
      ["Trace City", [at("12:04:59")]],
    ]);

    expect(
      rollingR5Compliance(
        observations,
        ["Trace City"],
        at("12:00:00"),
        at("12:10:00"),
      ),
    ).toBeCloseTo(299 / 300, 10);
    expect(
      rollingR5Compliance(
        observations,
        ["Trace City"],
        at("12:00:00"),
        at("12:04:00"),
      ),
    ).toBe(0);
  });

  it("compares hourly averages and excludes missing averages rather than treating them as zero", () => {
    const comparison = hourlyMeanAbsoluteError(
      new Map([
        ["TC:Trace City:2026-08-08T12:00:00.000Z", {
          coveredSeconds: 900,
          averageFreeBikes: 10,
          coverage: 0.25,
          partial: true,
        }],
        ["OC:Other City:2026-08-08T12:00:00.000Z", {
          coveredSeconds: 0,
          averageFreeBikes: null,
          coverage: 0,
          partial: true,
        }],
      ]),
      new Map([
        ["TC:Trace City:2026-08-08T12:00:00.000Z", {
          coveredSeconds: 900,
          averageFreeBikes: 14,
          coverage: 0.25,
          partial: true,
        }],
      ]),
    );

    expect(comparison).toStrictEqual({ value: 4, sampleCount: 1 });
  });
});
