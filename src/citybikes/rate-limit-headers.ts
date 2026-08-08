export interface RateLimitState {
  limit: number;
  remaining: number;
  resetAfterSeconds: number;
}

const DECIMAL_INTEGER = /^\d+$/;

function parseDecimalInteger(value: string | null): number | null {
  if (value === null || !DECIMAL_INTEGER.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function matchesOptionalHeader(
  headers: Headers,
  name: string,
  expectedValue: number,
): boolean {
  const value = headers.get(name);

  if (value === null) {
    return true;
  }

  return parseDecimalInteger(value) === expectedValue;
}

export function parseRateLimitHeaders(
  headers: Headers,
): RateLimitState | null {
  const limit = parseDecimalInteger(headers.get("ratelimit-limit"));
  const remaining = parseDecimalInteger(headers.get("ratelimit-remaining"));
  const resetAfterSeconds = parseDecimalInteger(headers.get("ratelimit-reset"));

  if (
    limit === null ||
    remaining === null ||
    resetAfterSeconds === null ||
    limit <= 0 ||
    remaining < 0 ||
    remaining > limit ||
    resetAfterSeconds < 0 ||
    !matchesOptionalHeader(headers, "x-ratelimit-limit-hour", limit) ||
    !matchesOptionalHeader(headers, "x-ratelimit-remaining-hour", remaining)
  ) {
    return null;
  }

  return { limit, remaining, resetAfterSeconds };
}
