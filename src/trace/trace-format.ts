import { z } from "zod";

const isoDateSchema = z.string().datetime({ offset: true }).transform((raw, context) => {
  const date = new Date(raw);

  if (Number.isNaN(date.getTime())) {
    context.addIssue({ code: "custom", message: "Invalid ISO timestamp" });
    return z.NEVER;
  }

  return date;
});

const headerSchema = z.tuple([z.string().min(1), z.string()]);

const rawTraceResponseSchema = z.object({
  networkId: z.string().min(1),
  capturedAt: isoDateSchema,
  status: z.number().int().min(100).max(599),
  headers: z.array(headerSchema),
  body: z.string(),
});

const traceRoundSchema = z
  .object({
    roundAt: isoDateSchema,
    responses: z.array(rawTraceResponseSchema),
    diagnostics: z.array(
      z.object({ networkId: z.string().min(1), kind: z.string().min(1) }),
    ),
  })
  .superRefine((round, context) => {
    const seen = new Set<string>();

    for (const response of round.responses) {
      if (response.capturedAt.getTime() < round.roundAt.getTime()) {
        context.addIssue({
          code: "custom",
          message: "Response capture cannot precede its trace round",
        });
        return;
      }
      if (seen.has(response.networkId)) {
        context.addIssue({
          code: "custom",
          message: "Duplicate network response in trace round",
        });
        return;
      }
      seen.add(response.networkId);
    }
  });

const recordedTraceSchema = z
  .object({
    version: z.literal(2),
    provider: z.string().min(1),
    recordedAt: isoDateSchema,
    maxStalenessSeconds: z.number().finite().int().positive().max(Number.MAX_SAFE_INTEGER),
    selectedCities: z.array(z.string().min(1)).min(1),
    networkIds: z.array(z.string().min(1)).min(1),
    rounds: z.array(traceRoundSchema),
  })
  .superRefine((trace, context) => {
    if (new Set(trace.selectedCities).size !== trace.selectedCities.length) {
      context.addIssue({ code: "custom", message: "Duplicate selected city" });
    }
    if (new Set(trace.networkIds).size !== trace.networkIds.length) {
      context.addIssue({ code: "custom", message: "Duplicate trace network ID" });
    }

    const configuredNetworks = new Set(trace.networkIds);

    for (const round of trace.rounds) {
      for (const response of round.responses) {
        if (!configuredNetworks.has(response.networkId)) {
          context.addIssue({
            code: "custom",
            message: "Trace response is not a configured network",
          });
          return;
        }
      }
    }
  });

export type RawTraceResponse = z.output<typeof rawTraceResponseSchema>;
export type TraceRound = z.output<typeof traceRoundSchema>;
export type RecordedTrace = z.output<typeof recordedTraceSchema>;

export function parseRecordedTrace(input: unknown): RecordedTrace | null {
  const result = recordedTraceSchema.safeParse(input);
  return result.success ? result.data : null;
}

export function traceRoundAvailableAt(round: TraceRound): Date {
  let availableAt = round.roundAt.getTime();

  for (const response of round.responses) {
    availableAt = Math.max(availableAt, response.capturedAt.getTime());
  }

  return new Date(availableAt);
}

export function isCompleteTraceRound(
  round: TraceRound,
  networkIds: readonly string[],
): boolean {
  const responseNetworks = new Set(
    round.responses.map((response) => response.networkId),
  );

  return networkIds.every((networkId) => responseNetworks.has(networkId));
}

export function serializeRecordedTrace(trace: RecordedTrace): string {
  return JSON.stringify(
    {
      version: trace.version,
      provider: trace.provider,
      recordedAt: trace.recordedAt.toISOString(),
      maxStalenessSeconds: trace.maxStalenessSeconds,
      selectedCities: [...trace.selectedCities],
      networkIds: [...trace.networkIds].sort(),
      rounds: [...trace.rounds]
        .sort((left, right) => left.roundAt.getTime() - right.roundAt.getTime())
        .map((round) => ({
          roundAt: round.roundAt.toISOString(),
          responses: [...round.responses]
            .sort((left, right) => left.networkId.localeCompare(right.networkId))
            .map((response) => ({
              networkId: response.networkId,
              capturedAt: response.capturedAt.toISOString(),
              status: response.status,
              headers: [...response.headers].sort((left, right) => {
                const nameOrder = left[0].localeCompare(right[0]);
                return nameOrder === 0 ? left[1].localeCompare(right[1]) : nameOrder;
              }),
              body: response.body,
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
