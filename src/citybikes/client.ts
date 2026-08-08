import type { z } from "zod";

import type { RateLimitState } from "./rate-limit-headers";
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
  _fetchImpl: FetchLike,
): Promise<CityBikesFetchResult> {
  throw new Error("Not implemented");
}
