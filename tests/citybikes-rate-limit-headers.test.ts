import {
  parseRateLimitHeaders,
  type RateLimitState,
} from "../src/citybikes/rate-limit-headers";

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

describe("parseRateLimitHeaders", () => {
  it("accepts the captured primary and hourly compatibility headers", () => {
    const result = parseRateLimitHeaders(
      headers({
        "ratelimit-limit": "300",
        "ratelimit-remaining": "298",
        "ratelimit-reset": "3021",
        "x-ratelimit-limit-hour": "300",
        "x-ratelimit-remaining-hour": "298",
      }),
    );

    const expected: RateLimitState = {
      limit: 300,
      remaining: 298,
      resetAfterSeconds: 3021,
    };

    expect(result).toStrictEqual(expected);
  });

  it("accepts required primary headers without hourly compatibility aliases", () => {
    expect(
      parseRateLimitHeaders(
        headers({
          "ratelimit-limit": "300",
          "ratelimit-remaining": "150",
          "ratelimit-reset": "1800",
        }),
      ),
    ).toStrictEqual({
      limit: 300,
      remaining: 150,
      resetAfterSeconds: 1800,
    });
  });

  it("accepts zero remaining budget", () => {
    expect(
      parseRateLimitHeaders(
        headers({
          "ratelimit-limit": "300",
          "ratelimit-remaining": "0",
          "ratelimit-reset": "45",
        }),
      ),
    ).toStrictEqual({
      limit: 300,
      remaining: 0,
      resetAfterSeconds: 45,
    });
  });

  it("accepts zero reset delay", () => {
    expect(
      parseRateLimitHeaders(
        headers({
          "ratelimit-limit": "300",
          "ratelimit-remaining": "300",
          "ratelimit-reset": "0",
        }),
      ),
    ).toStrictEqual({
      limit: 300,
      remaining: 300,
      resetAfterSeconds: 0,
    });
  });

  it.each([
    [
      "a missing limit",
      headers({ "ratelimit-remaining": "298", "ratelimit-reset": "3021" }),
    ],
    [
      "a missing remaining value",
      headers({ "ratelimit-limit": "300", "ratelimit-reset": "3021" }),
    ],
    [
      "a missing reset value",
      headers({ "ratelimit-limit": "300", "ratelimit-remaining": "298" }),
    ],
    [
      "a zero limit",
      headers({
        "ratelimit-limit": "0",
        "ratelimit-remaining": "0",
        "ratelimit-reset": "1",
      }),
    ],
    [
      "a negative limit",
      headers({
        "ratelimit-limit": "-1",
        "ratelimit-remaining": "0",
        "ratelimit-reset": "1",
      }),
    ],
    [
      "a negative remaining value",
      headers({
        "ratelimit-limit": "300",
        "ratelimit-remaining": "-1",
        "ratelimit-reset": "1",
      }),
    ],
    [
      "remaining budget above the limit",
      headers({
        "ratelimit-limit": "300",
        "ratelimit-remaining": "301",
        "ratelimit-reset": "1",
      }),
    ],
    [
      "a negative reset delay",
      headers({
        "ratelimit-limit": "300",
        "ratelimit-remaining": "0",
        "ratelimit-reset": "-1",
      }),
    ],
    [
      "a fractional limit",
      headers({
        "ratelimit-limit": "300.5",
        "ratelimit-remaining": "0",
        "ratelimit-reset": "1",
      }),
    ],
    [
      "scientific notation",
      headers({
        "ratelimit-limit": "3e2",
        "ratelimit-remaining": "0",
        "ratelimit-reset": "1",
      }),
    ],
    [
      "a nonnumeric remaining value",
      headers({
        "ratelimit-limit": "300",
        "ratelimit-remaining": "many",
        "ratelimit-reset": "1",
      }),
    ],
    [
      "an empty reset value",
      headers({
        "ratelimit-limit": "300",
        "ratelimit-remaining": "0",
        "ratelimit-reset": "",
      }),
    ],
    [
      "a contradictory hourly limit",
      headers({
        "ratelimit-limit": "300",
        "ratelimit-remaining": "0",
        "ratelimit-reset": "1",
        "x-ratelimit-limit-hour": "200",
      }),
    ],
    [
      "a contradictory hourly remaining value",
      headers({
        "ratelimit-limit": "300",
        "ratelimit-remaining": "100",
        "ratelimit-reset": "1",
        "x-ratelimit-remaining-hour": "99",
      }),
    ],
    [
      "a malformed hourly limit",
      headers({
        "ratelimit-limit": "300",
        "ratelimit-remaining": "0",
        "ratelimit-reset": "1",
        "x-ratelimit-limit-hour": "many",
      }),
    ],
    [
      "a malformed hourly remaining value",
      headers({
        "ratelimit-limit": "300",
        "ratelimit-remaining": "0",
        "ratelimit-reset": "1",
        "x-ratelimit-remaining-hour": "many",
      }),
    ],
  ])("returns null for %s", (_description, inputHeaders) => {
    expect(parseRateLimitHeaders(inputHeaders)).toBeNull();
  });
});
