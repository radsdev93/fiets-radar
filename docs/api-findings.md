# API Reconnaissance & Findings

## 1. Rate Limits (Requirement R6)
**Date Captured:** August 5, 2026
**Endpoint:** `GET https://api.citybik.es/v2/networks`

**Evidence:**
When inspecting the response headers via Postman, the API returned the following headers confirming the rate limits:
```http
content-type: application/json
content-length: 225876
ratelimit-limit: 300
x-ratelimit-limit-hour: 300
x-ratelimit-remaining-hour: 298
ratelimit-reset: 3021
ratelimit-remaining: 298
server: nginx/1.18.0 (Ubuntu)
date: Thu, 06 Aug 2026 01:09:39 GMT
access-control-allow-origin: *
via: kong/3.5.0

```

**Conclusion:**
The API imposes a strict hard ceiling of 300 requests per hour. This gives us a maximum budget of exactly 5 requests per minute, or 25 requests every 5-minute window. Our centralized scheduler must be strictly governed by this ceiling.

## 2. City to Network Mapping & Payload Structure
**Date Captured:** August 5, 2026
**Endpoint:** GET https://api.citybik.es/v2/networks

**Evidence:**
The global networks endpoint returns a list of networks and their metadata (location, ID, etc.), but crucially, it does *not* contain live bike availability data. We must poll the individual network endpoints to get observations.

When mapping the 20 required cities to the JSON payload, I discovered they do not map 1:1. 
* Los Angeles, CA resolves to 3 networks (e.g., `bird-los-angeles`, `metro-bike-share`, `spin-los-angeles`).
* 8 cities (Barcelona, Bilbao, Seattle, Portland, Berlin, Köln, München, Kyoto) resolve to 2 networks each.
* 11 cities resolve to 1 network each.

**Conclusion:** The 20 requested cities map to exactly 28 distinct network endpoints.