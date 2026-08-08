import {
  fetchCityBikesNetwork,
  type FetchLike,
} from "../src/citybikes/client";

function validRateLimitHeaders(remaining = "298"): Headers {
  return new Headers({
    "ratelimit-limit": "300",
    "ratelimit-remaining": remaining,
    "ratelimit-reset": "3021",
    "x-ratelimit-limit-hour": "300",
    "x-ratelimit-remaining-hour": remaining,
  });
}

function validCityBikesBody() {
  return {
    network: {
      stations: [
        {
          id: "station-1",
          latitude: 41.3851,
          longitude: 2.1734,
          timestamp: "2026-08-07T04:11:31.603538+00:00Z",
          free_bikes: 7,
          extra: { ignored_provider_field: true },
        },
      ],
    },
  };
}

function toUrl(input: string | URL | Request): URL {
  if (input instanceof Request) {
    return new URL(input.url);
  }

  return new URL(input);
}

describe("fetchCityBikesNetwork", () => {
  it("requests stations and vehicles, then returns validated data and budget state", async () => {
    const requestedUrls: URL[] = [];
    const fetchImpl: FetchLike = async (input) => {
      requestedUrls.push(toUrl(input));
      return new Response(JSON.stringify(validCityBikesBody()), {
        status: 200,
        headers: validRateLimitHeaders(),
      });
    };

    const result = await fetchCityBikesNetwork("test/network", fetchImpl);

    expect(result.kind).toBe("success");
    if (result.kind !== "success") {
      throw new Error("Expected successful CityBikes response");
    }

    expect(result.networkId).toBe("test/network");
    expect(result.rateLimit).toStrictEqual({
      limit: 300,
      remaining: 298,
      resetAfterSeconds: 3021,
    });
    expect(result.payload).toStrictEqual({
      network: {
        stations: [
          {
            id: "station-1",
            latitude: 41.3851,
            longitude: 2.1734,
            timestamp: new Date("2026-08-07T04:11:31.603Z"),
            free_bikes: 7,
          },
        ],
      },
    });

    const requestedUrl = requestedUrls[0];
    if (requestedUrl === undefined) {
      throw new Error("Expected fetch to receive a URL");
    }

    expect(requestedUrl.origin).toBe("https://api.citybik.es");
    expect(requestedUrl.pathname).toBe("/v2/networks/test%2Fnetwork");
    expect(requestedUrl.searchParams.get("fields")).toBe("stations,vehicles");
  });

  it("returns an HTTP error without requiring an error body to be JSON", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response("not JSON", {
        status: 429,
        headers: validRateLimitHeaders("0"),
      });

    const result = await fetchCityBikesNetwork("network-429", fetchImpl);

    expect(result).toStrictEqual({
      kind: "http-error",
      networkId: "network-429",
      status: 429,
      rateLimit: {
        limit: 300,
        remaining: 0,
        resetAfterSeconds: 3021,
      },
    });
  });

  it("returns an HTTP error with null budget state when headers are unusable", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response("service unavailable", { status: 503 });

    const result = await fetchCityBikesNetwork("network-503", fetchImpl);

    expect(result).toStrictEqual({
      kind: "http-error",
      networkId: "network-503",
      status: 503,
      rateLimit: null,
    });
  });

  it("fails closed when a successful response lacks usable budget headers", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response("{ invalid JSON", { status: 200 });

    const result = await fetchCityBikesNetwork("network-without-budget", fetchImpl);

    expect(result).toStrictEqual({
      kind: "invalid-rate-limit",
      networkId: "network-without-budget",
      status: 200,
    });
  });

  it("returns malformed-json after a successful response with valid budget headers", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response("{ invalid JSON", {
        status: 200,
        headers: validRateLimitHeaders(),
      });

    const result = await fetchCityBikesNetwork("network-malformed-json", fetchImpl);

    expect(result).toStrictEqual({
      kind: "malformed-json",
      networkId: "network-malformed-json",
      status: 200,
      rateLimit: {
        limit: 300,
        remaining: 298,
        resetAfterSeconds: 3021,
      },
    });
  });

  it("returns invalid-response for structurally invalid CityBikes JSON", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ network: { stations: "not-an-array" } }), {
        status: 200,
        headers: validRateLimitHeaders(),
      });

    const result = await fetchCityBikesNetwork("network-invalid-response", fetchImpl);

    expect(result).toStrictEqual({
      kind: "invalid-response",
      networkId: "network-invalid-response",
      status: 200,
      rateLimit: {
        limit: 300,
        remaining: 298,
        resetAfterSeconds: 3021,
      },
    });
  });

  it("returns the thrown transport error when no response exists", async () => {
    const error = new Error("Network unavailable");
    const fetchImpl: FetchLike = async () => {
      throw error;
    };

    const result = await fetchCityBikesNetwork("network-error", fetchImpl);

    expect(result).toStrictEqual({
      kind: "network-error",
      networkId: "network-error",
      error,
    });
  });
});
