import { parseCityBikesTimestamp } from "../src/citybikes/timestamp";

describe("parseCityBikesTimestamp", () => {
  // JavaScript Date stores milliseconds only, so fractional digits beyond the
  // first three are intentionally discarded in the expected instants.
  it.each([
    [
      "the CityBikes +00:00Z form",
      "2026-08-07T04:11:31.603538+00:00Z",
      "2026-08-07T04:11:31.603Z",
    ],
    [
      "a conventional UTC Z timestamp",
      "2026-08-07T04:11:31.603538Z",
      "2026-08-07T04:11:31.603Z",
    ],
    [
      "a conventional explicit UTC offset timestamp",
      "2026-08-07T04:11:31.603538+00:00",
      "2026-08-07T04:11:31.603Z",
    ],
    [
      "a UTC timestamp without fractional seconds",
      "2026-08-07T04:11:31Z",
      "2026-08-07T04:11:31.000Z",
    ],
  ])("accepts %s", (_description, raw, expectedIso) => {
    const parsed = parseCityBikesTimestamp(raw);

    expect(parsed).toBeInstanceOf(Date);
    expect(parsed?.toISOString()).toBe(expectedIso);
  });

  it.each([
    ["a missing timezone", "2026-08-07T04:11:31"],
    ["a date-only value", "2026-08-07"],
    ["an impossible calendar date", "2026-02-30T04:11:31Z"],
    ["an impossible hour", "2026-08-07T25:11:31Z"],
    ["a duplicate non-UTC offset plus Z", "2026-08-07T04:11:31+01:00Z"],
    ["garbage", "not-a-date"],
    ["an empty string", ""],
  ])("returns null for %s", (_description, raw) => {
    expect(parseCityBikesTimestamp(raw)).toBeNull();
  });
});
