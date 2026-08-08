export interface RateLimitState {
  limit: number;
  remaining: number;
  resetAfterSeconds: number;
}

export function parseRateLimitHeaders(
  _headers: Headers,
): RateLimitState | null {
  return null;
}
