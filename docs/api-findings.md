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
The API imposes a strict hard ceiling of 300 requests per hour. This gives us a maximum budget of exactly 5 requests per minute, or 25 requests every 5-minute window. Our centralized scheduler must be strictly governed by this ceiling, and we can theoretically read `ratelimit-remaining` at runtime to adapt our polling.

---

## 2. City to Network Mapping & Payload Structure
**Date Captured:** August 5, 2026
**Endpoint:** `GET https://api.citybik.es/v2/networks`

**Evidence:**
The global networks endpoint returns a list of networks and their metadata (location, ID, etc.), but crucially, it does *not* contain live bike availability data. We must poll the individual network endpoints to get observations.

When mapping the exact 20 required cities from the brief to the JSON payload, I discovered they do not map 1:1. Multiple cities host more than one bike-sharing network:

* **3 cities with 3 networks each** (Los Angeles, CA; San Francisco, CA; 京都府(Kyoto)) = 9 networks
* **8 cities with 2 networks each** (Barcelona, Bilbao, Seattle, Portland, Berlin, Köln, München, Göteborg) = 16 networks
* **9 cities with 1 network each** (Madrid, Paris, London, New York, Valencia, Chicago, Lisbon, Toronto, Montréal) = 9 networks

**Conclusion:**
The 20 requested cities map to exactly **34 distinct network endpoints**.

---

## 3. Network Payload Structure and Data Types
**Date Captured:** August 6, 2026
**Endpoint:** `GET https://api.citybik.es/v2/networks/{id}`

**Evidence:**
Inspection of individual network responses reveals the root payload is an object containing a single `network` key. The `free_bikes` data is nested inside a `stations` array. While fields like `empty_slots` or `extra` vary wildly in structure between providers (e.g., Nextbike vs. JCDecaux), the fields we need are consistently formatted.

Raw snippet captured from `bay-wheels_body.json` (San Francisco):

```json
{
  "network": {
    "id": "bay-wheels",
    "name": "Bay Wheels",
    "stations": [
      {
        "empty_slots": 11,
        "extra": {
          "address": "Harmon St at Adeline St",
          "last_updated": 1698150453,
          "renting": 1,
          "returning": 1,
          "uid": "1732958045763567406"
        },
        "free_bikes": 4,
        "id": "d0e8f4f1834b7b33a3faf8882f567ab8",
        "timestamp": "2026-08-06T18:41:20.123Z"
      }
    ]
  }
}

```

**Conclusion:**
We will use Zod to validate *only* the fields we actually need to compute the integral (`network.stations`, `id`, `free_bikes`, and `timestamp`). We must aggressively strip out unverified external fields like `extra` to prevent prototype pollution or unexpected type exceptions at the boundary.

---

## 4. Network Size Variability
**Date Captured:** August 6, 2026
**Endpoint:** `GET https://api.citybik.es/v2/networks/{id}`

**Evidence:**
Network byte size and parsing overhead vary massively based on the city.
Byte counts observed during the 34-network capture run across the required 20 cities:

* `bicing_body.json` (Barcelona): ~45 KB
* `velib_body.json` (Paris): ~840 KB
* `citi-bike-nyc_body.json` (New York): ~1.2 MB

**Conclusion:**
The aggregation engine and fetcher must be highly optimized. Calling `await res.json()` on a 1.2MB string is synchronous and blocks the Node event loop. We must ensure our time-weighted average function processes these arrays efficiently without holding onto excessive memory references, allowing V8 to garbage collect the raw parsed objects immediately.