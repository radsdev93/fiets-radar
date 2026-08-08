import type { SchedulerNetworkNormalizer } from "../scheduler/adaptive-scheduler";
import type { TraceSample, RecordedTrace } from "./trace-format";
import { isCompleteTraceRound, traceRoundAvailableAt } from "./trace-format";

function copySample(sample: TraceSample): TraceSample {
  return {
    networkId: sample.networkId,
    capturedAt: new Date(sample.capturedAt.getTime()),
    freeBikes: sample.freeBikes,
    oldestSourceAt: new Date(sample.oldestSourceAt.getTime()),
    newestSourceAt: new Date(sample.newestSourceAt.getTime()),
    validFrom: new Date(sample.validFrom.getTime()),
    validUntil: new Date(sample.validUntil.getTime()),
  };
}

export class TraceReplay {
  constructor(private readonly trace: RecordedTrace) {}

  sample(networkId: string, at: Date): TraceSample | null {
    let selectedSample: TraceSample | null = null;
    let selectedAvailableAt = -Infinity;

    for (const round of this.trace.rounds) {
      const availableAt = traceRoundAvailableAt(round).getTime();

      if (
        availableAt > at.getTime() ||
        availableAt < selectedAvailableAt ||
        !isCompleteTraceRound(round, this.trace.networkIds)
      ) {
        continue;
      }

      const sample = round.samples.find(
        (candidate) => candidate.networkId === networkId,
      );

      if (sample !== undefined) {
        selectedAvailableAt = availableAt;
        selectedSample = sample;
      }
    }

    return selectedSample === null ? null : copySample(selectedSample);
  }
}

export function createTraceReplayNormalizer(
  replay: TraceReplay,
): SchedulerNetworkNormalizer {
  return (config, _payload, fetchedAt) => {
    const sample = replay.sample(config.networkId, fetchedAt);

    if (sample === null) {
      return { kind: "no-source-data", networkId: config.networkId };
    }

    return {
      kind: "success",
      networkId: config.networkId,
      freeBikes: sample.freeBikes,
      oldestSourceAt: sample.oldestSourceAt,
      newestSourceAt: sample.newestSourceAt,
      validFrom: sample.validFrom,
      validUntil: sample.validUntil,
      fetchedAt: new Date(fetchedAt.getTime()),
    };
  };
}
