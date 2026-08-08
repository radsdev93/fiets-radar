import { z } from "zod";

const safeNonNegativeInteger = z
  .number()
  .finite()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

const isoDateSchema = z.string().datetime({ offset: true }).transform((raw, context) => {
  const date = new Date(raw);

  if (Number.isNaN(date.getTime())) {
    context.addIssue({ code: "custom", message: "Invalid ISO timestamp" });
    return z.NEVER;
  }

  return date;
});

const traceSampleSchema = z
  .object({
    networkId: z.string().min(1),
    capturedAt: isoDateSchema,
    freeBikes: safeNonNegativeInteger,
    oldestSourceAt: isoDateSchema,
    newestSourceAt: isoDateSchema,
    validFrom: isoDateSchema,
    validUntil: isoDateSchema,
  })
  .superRefine((sample, context) => {
    if (sample.oldestSourceAt.getTime() > sample.newestSourceAt.getTime()) {
      context.addIssue({
        code: "custom",
        message: "oldestSourceAt must not follow newestSourceAt",
      });
    }

    if (sample.validFrom.getTime() >= sample.validUntil.getTime()) {
      context.addIssue({
        code: "custom",
        message: "validity interval must be non-empty",
      });
    }
  });

const traceRoundSchema = z
  .object({
    roundAt: isoDateSchema,
    samples: z.array(traceSampleSchema),
    diagnostics: z.array(
      z.object({ networkId: z.string().min(1), kind: z.string().min(1) }),
    ),
  })
  .superRefine((round, context) => {
    const seen = new Set<string>();

    for (const sample of round.samples) {
      if (seen.has(sample.networkId)) {
        context.addIssue({
          code: "custom",
          message: "Duplicate network sample in trace round",
        });
        return;
      }
      seen.add(sample.networkId);

      if (sample.capturedAt.getTime() < round.roundAt.getTime()) {
        context.addIssue({
          code: "custom",
          message: "Sample capture cannot precede its trace round",
        });
        return;
      }
    }
  });

const recordedTraceSchema = z
  .object({
    version: z.literal(1),
    provider: z.string().min(1),
    recordedAt: isoDateSchema,
    maxStalenessSeconds: safeNonNegativeInteger.refine((value) => value > 0),
    networkIds: z.array(z.string().min(1)).min(1),
    rounds: z.array(traceRoundSchema),
  })
  .superRefine((trace, context) => {
    if (new Set(trace.networkIds).size !== trace.networkIds.length) {
      context.addIssue({ code: "custom", message: "Duplicate trace network ID" });
    }

    const configuredNetworkIds = new Set(trace.networkIds);

    for (const round of trace.rounds) {
      for (const sample of round.samples) {
        if (!configuredNetworkIds.has(sample.networkId)) {
          context.addIssue({
            code: "custom",
            message: "Trace sample is not a configured network",
          });
          return;
        }
      }
    }
  });

export type TraceSample = z.output<typeof traceSampleSchema>;
export type TraceRound = z.output<typeof traceRoundSchema>;
export type RecordedTrace = z.output<typeof recordedTraceSchema>;

export function traceRoundAvailableAt(round: TraceRound): Date {
  let availableAt = round.roundAt.getTime();

  for (const sample of round.samples) {
    availableAt = Math.max(availableAt, sample.capturedAt.getTime());
  }

  return new Date(availableAt);
}

export function parseRecordedTrace(input: unknown): RecordedTrace | null {
  const result = recordedTraceSchema.safeParse(input);
  return result.success ? result.data : null;
}

function copyDate(date: Date): Date {
  return new Date(date.getTime());
}

export function serializeRecordedTrace(trace: RecordedTrace): string {
  return JSON.stringify(
    {
      version: trace.version,
      provider: trace.provider,
      recordedAt: trace.recordedAt.toISOString(),
      maxStalenessSeconds: trace.maxStalenessSeconds,
      networkIds: [...trace.networkIds].sort(),
      rounds: [...trace.rounds]
        .sort((left, right) => left.roundAt.getTime() - right.roundAt.getTime())
        .map((round) => ({
          roundAt: copyDate(round.roundAt).toISOString(),
          samples: [...round.samples]
            .sort((left, right) => left.networkId.localeCompare(right.networkId))
            .map((sample) => ({
              networkId: sample.networkId,
              capturedAt: copyDate(sample.capturedAt).toISOString(),
              freeBikes: sample.freeBikes,
              oldestSourceAt: copyDate(sample.oldestSourceAt).toISOString(),
              newestSourceAt: copyDate(sample.newestSourceAt).toISOString(),
              validFrom: copyDate(sample.validFrom).toISOString(),
              validUntil: copyDate(sample.validUntil).toISOString(),
            })),
          diagnostics: [...round.diagnostics].sort((left, right) => {
            const networkOrder = left.networkId.localeCompare(right.networkId);
            return networkOrder === 0 ? left.kind.localeCompare(right.kind) : networkOrder;
          }),
        })),
    },
    null,
    2,
  );
}

export function isCompleteTraceRound(
  round: TraceRound,
  networkIds: readonly string[],
): boolean {
  const sampledNetworkIds = new Set(round.samples.map((sample) => sample.networkId));

  return networkIds.every((networkId) => sampledNetworkIds.has(networkId));
}
