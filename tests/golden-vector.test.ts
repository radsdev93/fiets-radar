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

  it("handles observations starting before the hour that are superseded before intervalStart", () => {
    const maxStaleness = 900;
    const intervalStart = new Date("2026-08-05T12:00:00Z");
    const intervalEnd = new Date("2026-08-05T13:00:00Z");

    const observations: Observation[] = [
      // Taken at 11:50, superseded at 11:55. Contributes 0 seconds to the 12:00 hour.
      { timestamp: new Date("2026-08-05T11:50:00Z"), freeBikes: 50 },
      // Taken at 11:55, valid until 12:10. Contributes 600 seconds (12:00 to 12:10).
      { timestamp: new Date("2026-08-05T11:55:00Z"), freeBikes: 100 },
    ];

    const expected: HourlyResult = {
      coveredSeconds: 600,
      averageFreeBikes: 100.00,
      coverage: 0.1667,
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
