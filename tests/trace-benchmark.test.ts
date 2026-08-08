import { cityBikesResponseSchema } from "../src/citybikes/schemas";
import type { CityBikesFetchResult } from "../src/citybikes/client";
import type { CityConfig } from "../src/config/cities";
import {
  AdaptiveScheduler,
  type SchedulerClock,
} from "../src/scheduler/adaptive-scheduler";
import { RequestBudgetController } from "../src/scheduler/request-budget";
import { SqliteStore } from "../src/storage/sqlite-store";
import {
  mean,
  meanAbsoluteError,
  percentile95,
  rollingR5Compliance,
  runBenchmark,
} from "../src/benchmark/benchmark";
import { TraceRecorder } from "../src/trace/recorder";
import {
  isCompleteTraceRound,
  parseRecordedTrace,
  serializeRecordedTrace,
  traceRoundAvailableAt,
} from "../src/trace/trace-format";
import {
  createTraceReplayNormalizer,
  TraceReplay,
} from "../src/trace/replay";

function at(value: string): Date {
  return new Date(`2026-08-08T${value}Z`);
}

class FakeClock implements SchedulerClock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(value: string): void {
    this.current = at(value);
  }
}

const TEST_CITY: CityConfig[] = [
  {
    city: "Trace City",
    countryCode: "TC",
    networks: [{ networkId: "network-a", mode: "stations-only" }],
  },
];

function rawTrace() {
  return {
    version: 1,
    provider: "CityBikes V2",
    recordedAt: "2026-08-08T12:00:00.000Z",
    maxStalenessSeconds: 900,
    networkIds: ["network-a"],
    rounds: [
      {
        roundAt: "2026-08-08T12:00:00.000Z",
        samples: [
          {
            networkId: "network-a",
            capturedAt: "2026-08-08T12:00:05.000Z",
            freeBikes: 10,
            oldestSourceAt: "2026-08-08T11:59:00.000Z",
            newestSourceAt: "2026-08-08T12:00:04.000Z",
            validFrom: "2026-08-08T12:00:04.000Z",
            validUntil: "2026-08-08T12:14:00.000Z",
          },
        ],
        diagnostics: [],
      },
      {
        roundAt: "2026-08-08T12:05:00.000Z",
        samples: [
          {
            networkId: "network-a",
            capturedAt: "2026-08-08T12:05:04.000Z",
            freeBikes: 14,
            oldestSourceAt: "2026-08-08T12:04:00.000Z",
            newestSourceAt: "2026-08-08T12:05:00.000Z",
            validFrom: "2026-08-08T12:05:00.000Z",
            validUntil: "2026-08-08T12:19:00.000Z",
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
    throw new Error("Expected valid trace");
  }

  return trace;
}

function parsedScoringTrace() {
  const trace = rawTrace();
  const firstRound = trace.rounds[0];
  const secondRound = trace.rounds[1];

  if (firstRound === undefined || secondRound === undefined) {
    throw new Error("Expected scoring trace rounds");
  }

  const scoringTrace = parseRecordedTrace({
    ...trace,
    rounds: [
      firstRound,
      {
        ...secondRound,
        roundAt: "2026-08-08T12:05:00.000Z",
        samples: [
          {
            ...secondRound.samples[0],
            capturedAt: "2026-08-08T12:05:05.000Z",
            validFrom: "2026-08-08T12:05:00.000Z",
          },
        ],
      },
      {
        ...secondRound,
        roundAt: "2026-08-08T12:10:00.000Z",
        samples: [
          {
            ...secondRound.samples[0],
            capturedAt: "2026-08-08T12:10:05.000Z",
            oldestSourceAt: "2026-08-08T11:55:04.000Z",
            newestSourceAt: "2026-08-08T12:10:00.000Z",
            validFrom: "2026-08-08T12:10:00.000Z",
            validUntil: "2026-08-08T12:10:04.000Z",
          },
        ],
      },
    ],
  });

  if (scoringTrace === null) {
    throw new Error("Expected valid scoring trace");
  }

  return scoringTrace;
}

function success(networkId: string): CityBikesFetchResult {
  return {
    kind: "success",
    networkId,
    rateLimit: { limit: 3, remaining: 2, resetAfterSeconds: 600 },
    payload: cityBikesResponseSchema.parse({
      network: {
        stations: [
          {
            id: "station",
            latitude: 1,
            longitude: 1,
            timestamp: "2026-08-08T12:00:00Z",
            free_bikes: 1,
          },
        ],
      },
    }),
  };
}

describe("trace, replay, and benchmark infrastructure", () => {
  it("runtime-validates compact traces, orders output, and identifies complete rounds", () => {
    const trace = parsedTrace();
    const firstRound = trace.rounds[0];

    if (firstRound === undefined) {
      throw new Error("Expected trace round");
    }

    expect(firstRound.samples[0]?.capturedAt).toStrictEqual(
      at("12:00:05"),
    );
    expect(isCompleteTraceRound(firstRound, trace.networkIds)).toBe(true);
    expect(serializeRecordedTrace(trace)).toContain('"version": 1');

    const malformed = {
      ...rawTrace(),
      recordedAt: "not-a-timestamp",
    };
    expect(parseRecordedTrace(malformed)).toBeNull();
  });

  it("rejects duplicate samples and keeps incomplete rounds out of ground truth", () => {
    const trace = parsedTrace();
    const firstRound = trace.rounds[0];

    if (firstRound === undefined) {
      throw new Error("Expected trace round");
    }

    const duplicate = {
      version: 1,
      provider: "CityBikes V2",
      recordedAt: "2026-08-08T12:00:00.000Z",
      maxStalenessSeconds: 900,
      networkIds: ["network-a"],
      rounds: [
        {
          roundAt: "2026-08-08T12:00:00.000Z",
          samples: [
            {
              networkId: "network-a",
              capturedAt: "2026-08-08T12:00:00.000Z",
              freeBikes: 1,
              oldestSourceAt: "2026-08-08T12:00:00.000Z",
              newestSourceAt: "2026-08-08T12:00:00.000Z",
              validFrom: "2026-08-08T12:00:00.000Z",
              validUntil: "2026-08-08T12:15:00.000Z",
            },
            {
              networkId: "network-a",
              capturedAt: "2026-08-08T12:00:00.000Z",
              freeBikes: 1,
              oldestSourceAt: "2026-08-08T12:00:00.000Z",
              newestSourceAt: "2026-08-08T12:00:00.000Z",
              validFrom: "2026-08-08T12:00:00.000Z",
              validUntil: "2026-08-08T12:15:00.000Z",
            },
          ],
          diagnostics: [],
        },
      ],
    };

    expect(parseRecordedTrace(duplicate)).toBeNull();
    expect(
      isCompleteTraceRound(
        { ...firstRound, samples: [], diagnostics: [{ networkId: "network-a", kind: "failure" }] },
        trace.networkIds,
      ),
    ).toBe(false);
  });

  it("does not replay a complete round until its latest sample capture time", () => {
    const replay = new TraceReplay(parsedTrace());

    expect(replay.sample("network-a", at("11:59:59"))).toBeNull();
    expect(replay.sample("network-a", at("12:00:04"))).toBeNull();
    expect(replay.sample("network-a", at("12:00:05"))?.freeBikes).toBe(10);
    expect(replay.sample("network-a", at("12:05:03"))?.freeBikes).toBe(10);
    const sample = replay.sample("network-a", at("12:05:04"));

    expect(sample?.freeBikes).toBe(14);
    expect(sample?.oldestSourceAt).toStrictEqual(at("12:04:00"));
  });

  it("uses the latest capture in a multi-network round and rejects pre-round captures", () => {
    const multiNetworkTrace = parseRecordedTrace({
      version: 1,
      provider: "CityBikes V2",
      recordedAt: "2026-08-08T12:00:00.000Z",
      maxStalenessSeconds: 900,
      networkIds: ["network-a", "network-b"],
      rounds: [
        {
          roundAt: "2026-08-08T12:00:00.000Z",
          samples: [
            {
              networkId: "network-a",
              capturedAt: "2026-08-08T12:00:03.000Z",
              freeBikes: 1,
              oldestSourceAt: "2026-08-08T12:00:00.000Z",
              newestSourceAt: "2026-08-08T12:00:00.000Z",
              validFrom: "2026-08-08T12:00:00.000Z",
              validUntil: "2026-08-08T12:15:00.000Z",
            },
            {
              networkId: "network-b",
              capturedAt: "2026-08-08T12:00:11.000Z",
              freeBikes: 1,
              oldestSourceAt: "2026-08-08T12:00:00.000Z",
              newestSourceAt: "2026-08-08T12:00:00.000Z",
              validFrom: "2026-08-08T12:00:00.000Z",
              validUntil: "2026-08-08T12:15:00.000Z",
            },
          ],
          diagnostics: [],
        },
      ],
    });

    if (multiNetworkTrace === null) {
      throw new Error("Expected valid multi-network trace");
    }

    const round = multiNetworkTrace.rounds[0];

    if (round === undefined) {
      throw new Error("Expected multi-network round");
    }

    expect(traceRoundAvailableAt(round)).toStrictEqual(at("12:00:11"));
    expect(new TraceReplay(multiNetworkTrace).sample("network-a", at("12:00:10"))).toBeNull();
    expect(new TraceReplay(multiNetworkTrace).sample("network-a", at("12:00:11"))?.freeBikes).toBe(1);

  });

  it("rejects samples captured before their round begins", () => {
    expect(
      parseRecordedTrace({
        ...rawTrace(),
        rounds: [
          {
            ...rawTrace().rounds[0],
            samples: [
              {
                ...rawTrace().rounds[0].samples[0],
                capturedAt: "2026-08-08T11:59:59.000Z",
              },
            ],
          },
        ],
      }),
    ).toBeNull();
  });

  it("lets the real scheduler consume a replay normalizer while preserving its default normalizer", async () => {
    const replay = new TraceReplay(parsedTrace());
    const store = new SqliteStore(":memory:");
    const budget = new RequestBudgetController(store);
    const clock = new FakeClock(at("12:05:04"));
    const replayScheduler = new AdaptiveScheduler({
      cityConfigs: TEST_CITY,
      store,
      budget,
      clock,
      fetchNetwork: async (networkId) => success(networkId),
      maxStalenessSeconds: 900,
      normalizer: createTraceReplayNormalizer(replay),
    });

    try {
      expect(await replayScheduler.step()).toMatchObject({
        kind: "fetched",
        usefulness: "freshness-refresh",
      });
      expect(
        store.findUsableNetworkSnapshot("network-a", clock.now())?.freeBikes,
      ).toBe(14);
    } finally {
      store.close();
    }
  });

  it("keeps fixed polling fixed and budget-authorized", async () => {
    const store = new SqliteStore(":memory:");
    const budget = new RequestBudgetController(store);
    const clock = new FakeClock(at("12:00:00"));
    let requests = 0;
    const scheduler = new AdaptiveScheduler({
      cityConfigs: TEST_CITY,
      store,
      budget,
      clock,
      fetchNetwork: async (networkId) => {
        requests += 1;
        return success(networkId);
      },
      maxStalenessSeconds: 900,
      pollingMode: { kind: "fixed", intervalMs: 120_000 },
    });

    try {
      await scheduler.step();
      expect(scheduler.getNetworkSchedule("network-a")?.intervalMs).toBe(120_000);
      clock.set("12:02:00");
      await scheduler.step();
      expect(requests).toBe(2);
      expect(scheduler.getNetworkSchedule("network-a")?.intervalMs).toBe(120_000);
    } finally {
      store.close();
    }
  });

  it("defines deterministic staleness, percentile, rolling R5, and MAE metrics", () => {
    expect(mean([10, 20, 30])).toBe(20);
    expect(percentile95([0, 10, 20, 30, 40])).toBe(40);
    expect(meanAbsoluteError([{ actual: 10, expected: 14 }, { actual: 8, expected: 6 }])).toBe(3);
    expect(meanAbsoluteError([])).toBeNull();

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
    ).toBeCloseTo(0.5, 8);
  });

  it("runs deterministic same-budget adaptive and fixed replay without using strategy data as trace ground truth", async () => {
    const result = await runBenchmark({
      trace: parsedTrace(),
      cityConfigs: TEST_CITY,
      requestBudget: 2,
      evaluationTickSeconds: 30,
    });

    expect(result).toMatchObject({
      metadata: { requestBudget: 2 },
      adaptive: { requests: expect.any(Number) },
      fixed: { requests: expect.any(Number) },
    });
    expect(result.adaptive.requests).toBeLessThanOrEqual(2);
    expect(result.fixed.requests).toBeLessThanOrEqual(2);
  });

  it("scores a trace checkpoint before replaying that checkpoint into the scheduler", async () => {
    const result = await runBenchmark({
      trace: parsedScoringTrace(),
      cityConfigs: TEST_CITY,
      requestBudget: 2,
      evaluationTickSeconds: 30,
    });

    expect(result.fixed.maeSampleCount).toBe(1);
    expect(result.fixed.maeFreeBikes).toBe(4);
  });

  it("records normalized samples with fakes, never turns failures into zero, and stops when budget blocks", async () => {
    const store = new SqliteStore(":memory:");
    const budget = new RequestBudgetController(store);
    const clock = new FakeClock(at("12:00:00"));
    const recorder = new TraceRecorder({
      cityConfigs: TEST_CITY,
      maxStalenessSeconds: 900,
      budget,
      clock,
      fetchNetwork: async (networkId) => success(networkId),
    });
    let waits = 0;

    try {
      const recorded = await recorder.record(1, 60, async () => {
        waits += 1;
      });

      expect(recorded.requests).toBe(1);
      expect(recorded.trace.rounds[0]?.samples[0]?.oldestSourceAt).toStrictEqual(
        at("12:00:00"),
      );
      expect(waits).toBe(0);
      budget.failClosed();
      const blocked = await recorder.record(1, 60, async () => undefined);
      expect(blocked.requests).toBe(0);
      expect(blocked.trace.rounds[0]?.samples).toStrictEqual([]);
      expect(blocked.stoppedEarly).not.toBeNull();
    } finally {
      store.close();
    }
  });
});
