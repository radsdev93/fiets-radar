import {
  calculateHourlyAverage,
  calculateHourlyAverageFromValidity,
  type ValidityObservation,
} from "../src/core/aggregator";

function at(time: string): Date {
  return new Date(`2026-08-08T${time}Z`);
}

function explicit(
  timestamp: string,
  validUntil: string,
  freeBikes: number,
): ValidityObservation {
  return {
    timestamp: at(timestamp),
    validUntil: at(validUntil),
    freeBikes,
  };
}

const intervalStart = at("12:00:00");
const intervalEnd = at("13:00:00");

const emptyResult = {
  coveredSeconds: 0,
  averageFreeBikes: null,
  coverage: 0,
  partial: true,
};

describe("calculateHourlyAverageFromValidity", () => {
  it("does not extend an explicit expiry by the default staleness period", () => {
    expect(
      calculateHourlyAverageFromValidity(
        [explicit("12:07:00", "12:15:00", 100)],
        intervalStart,
        intervalEnd,
      ),
    ).toStrictEqual({
      coveredSeconds: 480,
      averageFreeBikes: 100,
      coverage: 0.1333,
      partial: true,
    });
  });

  it("supersedes an older explicit interval at the newer timestamp", () => {
    expect(
      calculateHourlyAverageFromValidity(
        [
          explicit("12:00:00", "12:15:00", 10),
          explicit("12:05:00", "12:20:00", 20),
        ],
        intervalStart,
        intervalEnd,
      ),
    ).toStrictEqual({
      coveredSeconds: 1200,
      averageFreeBikes: 17.5,
      coverage: 0.3333,
      partial: true,
    });
  });

  it("clips a pre-hour explicit observation to the requested hour", () => {
    expect(
      calculateHourlyAverageFromValidity(
        [explicit("11:55:00", "12:05:00", 7)],
        intervalStart,
        intervalEnd,
      ),
    ).toStrictEqual({
      coveredSeconds: 300,
      averageFreeBikes: 7,
      coverage: 0.0833,
      partial: true,
    });
  });

  it("leaves explicit gaps out of both coverage and the average denominator", () => {
    expect(
      calculateHourlyAverageFromValidity(
        [
          explicit("12:00:00", "12:05:00", 10),
          explicit("12:10:00", "12:15:00", 20),
        ],
        intervalStart,
        intervalEnd,
      ),
    ).toStrictEqual({
      coveredSeconds: 600,
      averageFreeBikes: 15,
      coverage: 0.1667,
      partial: true,
    });
  });

  it("returns an empty result when no explicit interval overlaps the hour", () => {
    expect(
      calculateHourlyAverageFromValidity(
        [explicit("11:00:00", "11:05:00", 50)],
        intervalStart,
        intervalEnd,
      ),
    ).toStrictEqual(emptyResult);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "returns no coverage for invalid wrapper maxStaleness %p",
    (maxStaleness) => {
      expect(
        calculateHourlyAverage(
          [{ timestamp: at("12:00:00"), freeBikes: 10 }],
          intervalStart,
          intervalEnd,
          maxStaleness,
        ),
      ).toStrictEqual(emptyResult);
    },
  );

  it.each([
    [at("12:00:00"), at("12:00:00")],
    [at("12:01:00"), at("12:00:00")],
  ])("returns no coverage for an invalid requested interval", (start, end) => {
    expect(
      calculateHourlyAverage(
        [{ timestamp: at("12:00:00"), freeBikes: 10 }],
        start,
        end,
        900,
      ),
    ).toStrictEqual(emptyResult);
  });

  it("does not reorder arrays or mutate Date inputs for either entry point", () => {
    const wrapperTimestamp = at("12:10:00");
    const wrapperEarlierTimestamp = at("12:00:00");
    const wrapperObservations = [
      { timestamp: wrapperTimestamp, freeBikes: 20 },
      { timestamp: wrapperEarlierTimestamp, freeBikes: 10 },
    ];
    const explicitTimestamp = at("12:10:00");
    const explicitValidUntil = at("12:20:00");
    const explicitEarlierTimestamp = at("12:00:00");
    const explicitEarlierValidUntil = at("12:05:00");
    const explicitObservations = [
      {
        timestamp: explicitTimestamp,
        validUntil: explicitValidUntil,
        freeBikes: 20,
      },
      {
        timestamp: explicitEarlierTimestamp,
        validUntil: explicitEarlierValidUntil,
        freeBikes: 10,
      },
    ];

    calculateHourlyAverage(wrapperObservations, intervalStart, intervalEnd, 900);
    calculateHourlyAverageFromValidity(explicitObservations, intervalStart, intervalEnd);

    expect(wrapperObservations.map((observation) => observation.timestamp)).toStrictEqual([
      wrapperTimestamp,
      wrapperEarlierTimestamp,
    ]);
    expect(explicitObservations.map((observation) => observation.timestamp)).toStrictEqual([
      explicitTimestamp,
      explicitEarlierTimestamp,
    ]);
    expect(wrapperTimestamp).toStrictEqual(at("12:10:00"));
    expect(wrapperEarlierTimestamp).toStrictEqual(at("12:00:00"));
    expect(explicitTimestamp).toStrictEqual(at("12:10:00"));
    expect(explicitValidUntil).toStrictEqual(at("12:20:00"));
    expect(explicitEarlierTimestamp).toStrictEqual(at("12:00:00"));
    expect(explicitEarlierValidUntil).toStrictEqual(at("12:05:00"));
  });
});
