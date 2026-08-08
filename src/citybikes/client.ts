import type { z } from "zod";

import {
  parseRateLimitHeaders,
  type RateLimitState,
} from "./rate-limit-headers";
import { cityBikesResponseSchema } from "./schemas";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type CityBikesFetchResult =
  | {
      kind: "success";
      networkId: string;
      payload: z.output<typeof cityBikesResponseSchema>;
      rateLimit: RateLimitState;
    }
  | {
      kind: "http-error";
      networkId: string;
      status: number;
      rateLimit: RateLimitState | null;
    }
  | {
      kind: "invalid-rate-limit";
      networkId: string;
      status: number;
    }
  | {
      kind: "malformed-json";
      networkId: string;
      status: number;
      rateLimit: RateLimitState;
    }
  | {
      kind: "invalid-response";
      networkId: string;
      status: number;
      rateLimit: RateLimitState;
    }
  | {
      kind: "network-error";
      networkId: string;
      error: unknown;
    };

export async function fetchCityBikesNetwork(
  networkId: string,
  fetchImpl: FetchLike,
): Promise<CityBikesFetchResult> {
  const url = new URL(
    `https://api.citybik.es/v2/networks/${encodeURIComponent(networkId)}`,
  );
  url.searchParams.set("fields", "stations,vehicles");

  let response: Response;

  try {
    response = await fetchImpl(url.toString());
  } catch (error) {
    return { kind: "network-error", networkId, error };
  }

  const rateLimit = parseRateLimitHeaders(response.headers);

  if (!response.ok) {
    return {
      kind: "http-error",
      networkId,
      status: response.status,
      rateLimit,
    };
  }

  if (rateLimit === null) {
    return {
      kind: "invalid-rate-limit",
      networkId,
      status: response.status,
    };
  }

  let decoded: unknown;

  try {
    decoded = await response.json();
  } catch {
    return {
      kind: "malformed-json",
      networkId,
      status: response.status,
      rateLimit,
    };
  }

  const validation = cityBikesResponseSchema.safeParse(decoded);

  if (!validation.success) {
    return {
      kind: "invalid-response",
      networkId,
      status: response.status,
      rateLimit,
    };
  }

  return {
    kind: "success",
    networkId,
    payload: validation.data,
    rateLimit,
  };
}
