# CityBikes API Findings and Captured Evidence

This document contains observations measured directly from the CityBikes API.

Claims are limited to what the captured responses demonstrate. Unresolved behavior is identified as unresolved rather than inferred from field names.

> **Revision note — August 6, 2026:** An earlier version incorrectly described the reported hourly quota as a separately enforced five-minute quota and described all candidate mappings as exact city matches. This revision separates measured provider behavior from derived averages and records the two provisional city aliases explicitly.

## 1. Reported Request Budget

**Date captured:** August 5, 2026
**Endpoint:** `GET https://api.citybik.es/v2/networks`
**Capture method:** Postman response-header inspection

### Raw evidence

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

### What this response demonstrates

At the captured instant, the provider reported:

* limit: `300`;
* remaining requests: `298`;
* reset value: `3021`;
* an explicitly named hourly limit header: `x-ratelimit-limit-hour`.

The service must read the current values from response headers at runtime. The observed number `300` must not become an assumed permanent constant.

### What this response does not demonstrate

This single response does not establish:

* whether the limit uses a fixed or rolling hour;
* whether burst requests are permitted;
* whether there is an additional minute or five-minute quota;
* the exact interpretation of `ratelimit-reset`;
* the shape of a `429` response;
* whether all endpoints return identical rate-limit headers;
* how failed or retried requests change the remaining value.

Dividing 300 requests by 12 five-minute periods gives an average allocation of 25 requests per five minutes. It is not evidence that 25 is a separately enforced five-minute limit.

Repeated captures and controlled comparisons are still required.

---

## 2. Global Network Discovery

**Date captured:** August 5, 2026
**Endpoint:** `GET https://api.citybik.es/v2/networks`

The global endpoint contains network metadata such as:

* network ID;
* network name;
* location city;
* location country;
* network-specific endpoint path.

It does not contain the live station-level availability needed to calculate free-bike observations. Individual network endpoints must be fetched for live data.

---

## 3. Candidate Mapping for the 20 Required Cities

The mapping was initially produced by matching the required city and country values against `network.location.city` and `network.location.country` in the global response.

That process yielded 32 exact city-and-country matches.

Two additional networks were included provisionally for investigation because their location strings appear to refer to the required location but do not match it exactly:

* `bay-wheels`

  * required city: `San Francisco, CA`
  * provider city: `San Francisco Bay Area, CA`
* `kotobike`

  * required city: `京都府 (Kyoto)`
  * provider city: `京都 (Kyoto)`

This creates a capture set of 34 candidate endpoints.

| Required city     | Country | Candidate network IDs                                      | Mapping status                   |
| ----------------- | ------- | ---------------------------------------------------------- | -------------------------------- |
| Barcelona         | ES      | `ambici-amb`, `bicing`                                     | exact                            |
| Madrid            | ES      | `bicimad`                                                  | exact                            |
| Valencia          | ES      | `valenbisi`                                                | exact                            |
| Bilbao            | ES      | `bilbon-bizi`, `bizkaibizi-bilbao`                         | exact                            |
| Paris             | FR      | `velib`                                                    | exact                            |
| London            | GB      | `santander-cycles`                                         | exact                            |
| New York, NY      | US      | `citi-bike-nyc`                                            | exact                            |
| Chicago, IL       | US      | `divvy`                                                    | exact                            |
| Los Angeles, CA   | US      | `bird-los-angeles`, `metro-bike-share`, `spin-los-angeles` | exact                            |
| San Francisco, CA | US      | `lime-san-francisco`, `spin-san-francisco`, `bay-wheels`   | two exact, one provisional alias |
| Seattle, WA       | US      | `bird-seattle`, `lime-seattle`                             | exact                            |
| Portland, OR      | US      | `biketown`, `lime-portland`                                | exact                            |
| Berlin            | DE      | `callabike-berlin`, `nextbike-berlin`                      | exact                            |
| Köln              | DE      | `callabike-koln`, `kvb-rad-koln`                           | exact                            |
| München           | DE      | `callabike-munchen`, `nextbike-myradl`                     | exact                            |
| Lisbon            | PT      | `gira`                                                     | exact                            |
| Toronto, ON       | CA      | `bixi-toronto`                                             | exact                            |
| Montréal, QC      | CA      | `bixi-montreal`                                            | exact                            |
| 京都府 (Kyoto)       | JP      | `docomo-cycle-kyoto`, `hellocycling-kyoto`, `kotobike`     | two exact, one provisional alias |
| Göteborg          | SE      | `e-cargobike-goteborg`, `styr-staell-goeteborg`            | exact                            |

### Current conclusion

The 34 endpoints form a **candidate capture set**, not yet a final production mapping.

Before the mapping is finalized, the evidence matrix must determine:

* whether each endpoint represents bicycles relevant to `free_bikes`;
* whether some endpoints represent scooters, cargo bikes, or another vehicle type;
* whether multiple networks overlap or duplicate the same physical inventory;
* whether the two manual aliases are geographically and semantically justified;
* whether a network with no stations should remain in the mapping.

The final mapping must be committed in a reproducible form rather than reconstructed from prose alone.

---

## 4. Capture Inventory

**Date captured:** August 6, 2026
**Endpoint pattern:** `GET https://api.citybik.es/v2/networks/{id}`

The reconnaissance script generated one header file and one body file for every candidate network.

### Inventory results

* candidate network IDs: 34;
* header files: 34;
* JSON body files: 34;
* total files: 68;
* missing header/body pairs: none;
* captured HTTP `200` responses: 34;
* bodies that parsed as JSON: 34;
* bodies containing a top-level `network` object with a `stations` array: 34.

### Scope of this conclusion

This inventory confirms only the common root shape of the captured responses:

```text
response
└── network
    └── stations[]
```

It does not yet prove that every station has:

* an `id`;
* a numeric `free_bikes`;
* a `timestamp`;
* the same timestamp format;
* non-negative counts;
* a consistent interpretation of provider-specific fields.

Those questions belong to the cross-network evidence matrix.

---

## 5. Example Network Response

The following excerpt was captured from `bay-wheels_body.json`:

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

This sample demonstrates that this particular response includes:

* `network.id`;
* `network.name`;
* `network.stations`;
* station `id`;
* station `free_bikes`;
* station `timestamp`;
* provider-specific nested metadata under `extra`.

It does not demonstrate that those fields exist with the same types in every other network.

The difference between `extra.last_updated` and the station-level `timestamp` also shows that a timestamp-like field cannot be selected based only on its name. Its meaning must be investigated before it is used for observation validity.

The final Zod schema will be designed after the complete evidence matrix is produced.

---

## 6. Captured Response-Size Variability

Body sizes were measured from the raw captured files.

| Network         |       Body size |
| --------------- | --------------: |
| `bird-seattle`  |       303 bytes |
| `bicing`        |   150,229 bytes |
| `velib`         |   654,809 bytes |
| `citi-bike-nyc` | 1,268,901 bytes |

Across the current capture:

* smallest body: `bird-seattle_body.json`, 303 bytes;
* largest body: `citi-bike-nyc_body.json`, 1,268,901 bytes.

### Conclusion supported by the evidence

Payload sizes vary substantially by network.

The client should avoid retaining raw provider objects after producing the validated internal result, especially during recording or replay across many requests.

These byte counts alone do not prove that JSON parsing or Zod validation creates a material Node.js event-loop problem. Parsing and validation cost must be measured before introducing performance-specific complexity.

---

## 7. Analysis Still Required

The next evidence pass must record, for each candidate network:

* HTTP status;
* body size;
* station count;
* whether `free_bikes` is always present;
* all observed `free_bikes` types;
* null, negative, fractional, or malformed values;
* station ID presence and uniqueness;
* station timestamp presence and format;
* minimum and maximum timestamps in one response;
* whether the response appears to represent bicycles, scooters, cargo bikes, or mixed vehicles;
* rate-limit header presence and exact names;
* caching headers such as `ETag` and `Last-Modified`;
* any empty or semantically unusual response.

Additional repeated fetches are required to investigate:

* what counts as an upstream change;
* whether station timestamps advance when counts remain unchanged;
* whether conditional requests are supported;
* how remaining-budget headers change;
* reset behavior;
* error and `429` response behavior.
