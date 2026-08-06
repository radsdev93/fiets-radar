import { calculateHourlyAverage } from "../src/core/aggregator";

interface Observation {
  timestamp: Date;
  freeBikes: number;
}

interface HourlyResult {
  coveredSeconds: number;
  averageFreeBikes: number;
  coverage: number;
  partial: boolean;
}

describe("calculateHourlyAverage", () => {
  it("aggregates the golden hourly observation vector", () => {
    const maxStaleness = 900;
    const intervalStart = new Date("2026-08-05T12:00:00Z");
    const intervalEnd = new Date("2026-08-05T13:00:00Z");

    const observations: Observation[] = [
      { timestamp: new Date("2026-08-05T11:52:00Z"), freeBikes: 100 },
      { timestamp: new Date("2026-08-05T12:10:00Z"), freeBikes: 130 },
      { timestamp: new Date("2026-08-05T12:15:00Z"), freeBikes: 130 },
      { timestamp: new Date("2026-08-05T12:50:00Z"), freeBikes: 70 },
    ];

    const expected: HourlyResult = {
      coveredSeconds: 2220,
      averageFreeBikes: 108.11,
      coverage: 0.6167,
      partial: true,
    };

    expect(
      calculateHourlyAverage(
        observations,
        intervalStart,
        intervalEnd,
        maxStaleness,
      ),
    ).toStrictEqual(expected);
  });
});
