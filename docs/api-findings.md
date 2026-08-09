# CityBikes API Findings and Captured Evidence

This document records measured CityBikes behavior. Broad provider reconnaissance was completed on August 7, 2026. It distinguishes captured API evidence, semantic conclusions that can be drawn directly from that evidence, and architectural decisions, which belong in [`DECISIONS.md`](../DECISIONS.md).

All counts, shapes, and examples below are empirical observations from the described captures, not permanent provider guarantees.

## 1. Rate-Limit Evidence

### Original header capture

- **Date captured:** August 5, 2026
- **Endpoint:** `GET https://api.citybik.es/v2/networks`
- **Capture method:** Postman response-header inspection

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

This response reported a limit of `300`, remaining requests of `298`, reset value `3021`, and an explicitly named hourly-limit header. It did not by itself establish the reset semantics, burst behavior, a separate five-minute quota, `429` behavior, or retry accounting. Dividing an hourly limit by twelve is an average allocation, not evidence of a separately enforced five-minute quota.

### Targeted V2 and GBFS semantic capture

A run beginning around `2026-08-07T03:15Z` made 154 requests. All returned HTTP `200`. The remaining-budget counter decreased exactly once per request, approximately `298 → 145`; both V2 and GBFS calls consumed the same global budget. `ratelimit-reset` tracked the next UTC hour boundary within a few seconds.

No `ETag`, `Last-Modified`, `Cache-Control`, or `Age` header was observed across these responses. This absence is limited to the captured sample and does not prove that the provider can never emit cache validators.

### V2 field-selection experiment

A run beginning around `2026-08-07T03:56Z` made 25 requests, all HTTP `200`, with remaining budget approximately `144 → 120`. The six tested representative networks were `divvy`, `bird-los-angeles`, `spin-san-francisco`, `lime-seattle`, `callabike-berlin`, and `bay-wheels`.

For every one:

- the normal `/v2/networks/{id}` response exposed stations but no `vehicles`;
- `?fields=stations` returned stations;
- `?fields=vehicles` returned vehicles;
- `?fields=stations,vehicles` returned both;
- selected arrays matched the corresponding arrays from the other field-selection variants in that capture.

The experiment demonstrates that both station and roaming-vehicle data can be obtained from V2 in one request using `?fields=stations,vehicles`. GBFS was therefore not required to obtain those fields during the investigation.

## 2. Candidate Resources and Final V2 Capture

Global discovery produced 34 candidate resources for the 20 required cities. The initial mapping used `network.location.city` and `network.location.country`; `bay-wheels` and `kotobike` were provisional aliases investigated alongside exact matches.

### Candidate discovery mapping

| Required city | Country | Candidate network IDs | Discovery status |
| --- | --- | --- | --- |
| Barcelona | ES | `ambici-amb`, `bicing` | exact |
| Madrid | ES | `bicimad` | exact |
| Valencia | ES | `valenbisi` | exact |
| Bilbao | ES | `bilbon-bizi`, `bizkaibizi-bilbao` | exact |
| Paris | FR | `velib` | exact |
| London | GB | `santander-cycles` | exact |
| New York, NY | US | `citi-bike-nyc` | exact |
| Chicago, IL | US | `divvy` | exact |
| Los Angeles, CA | US | `bird-los-angeles`, `metro-bike-share`, `spin-los-angeles` | exact |
| San Francisco, CA | US | `lime-san-francisco`, `spin-san-francisco`, `bay-wheels` | two exact, one provisional alias |
| Seattle, WA | US | `bird-seattle`, `lime-seattle` | exact |
| Portland, OR | US | `biketown`, `lime-portland` | exact |
| Berlin | DE | `callabike-berlin`, `nextbike-berlin` | exact |
| Köln | DE | `callabike-koln`, `kvb-rad-koln` | exact |
| München | DE | `callabike-munchen`, `nextbike-myradl` | exact |
| Lisbon | PT | `gira` | exact |
| Toronto, ON | CA | `bixi-toronto` | exact |
| Montréal, QC | CA | `bixi-montreal` | exact |
| 京都府 (Kyoto) | JP | `docomo-cycle-kyoto`, `hellocycling-kyoto`, `kotobike` | two exact, one provisional alias |
| Göteborg | SE | `e-cargobike-goteborg`, `styr-staell-goeteborg` | exact |

This is the candidate discovery mapping, not the final production mapping. Later semantic inclusion and exclusion decisions are recorded in [`DECISIONS.md`](../DECISIONS.md). The final production mapping is represented reproducibly in configuration rather than reconstructed from prose.

A final capture beginning around `2026-08-07T04:11Z` made exactly 34 V2 requests, one per candidate resource:

```text
/v2/networks/{id}?fields=stations,vehicles
```

All 34 returned HTTP `200`; remaining budget changed `299 → 266`. The raw evidence consisted of 34 headers and 34 bodies, and the generated SHA-256 checksum file was verified against all 68 raw evidence files.

The final snapshot contained 15,524 station objects and 40,386 roaming vehicle objects.

### Observed object shapes

Across this final capture, station objects used:

- `id`: string;
- `name`: string;
- `latitude`: number;
- `longitude`: number;
- `timestamp`: string;
- `free_bikes`: non-negative integer;
- `empty_slots`: integer or `null`;
- `extra`: object.

No observed station `free_bikes` value was `null`, a string, negative, or fractional.

Vehicle objects used:

- `id`: string;
- `latitude`: number;
- `longitude`: number;
- `timestamp`: string;
- `kind`: string;
- `extra`: object.

Observed kinds were only `bike`, `ebike`, and `scooter`. Their totals across 40,386 captured vehicles were 5,586 bikes, 6,736 ebikes, and 28,064 scooters.

## 3. Observed Representation Categories

The 34 candidates empirically fell into three useful representation groups. These observed categories informed the implemented normalization modes: `stations-only`, `vehicles-only`, and `stations-and-vehicles`.

### Stations only (17)

`ambici-amb`, `bicing`, `bicimad`, `valenbisi`, `bilbon-bizi`, `bizkaibizi-bilbao`, `velib`, `santander-cycles`, `citi-bike-nyc`, `metro-bike-share`, `gira`, `bixi-toronto`, `bixi-montreal`, `docomo-cycle-kyoto`, `hellocycling-kyoto`, `kotobike`, and `e-cargobike-goteborg`.

### Vehicles only / synthetic-or-empty station representation (7)

`bird-los-angeles`, `spin-los-angeles`, `lime-san-francisco`, `spin-san-francisco`, `bird-seattle`, `lime-seattle`, and `lime-portland`.

### Stations plus vehicles (10)

`divvy`, `bay-wheels`, `biketown`, `callabike-berlin`, `nextbike-berlin`, `callabike-koln`, `kvb-rad-koln`, `callabike-munchen`, `nextbike-myradl`, and `styr-staell-goeteborg`.

## 4. Representation Evidence

### Lime

Representative final-snapshot values show why a synthetic station cannot be read as a bicycle-only total:

- `lime-san-francisco` had one synthetic station with approximately 2,837 free bikes and approximately 2,838 scooter vehicles; no bicycle vehicles were observed.
- `lime-portland` had one synthetic station with `free_bikes = 2,094` and 2,094 scooter vehicles; no bicycle vehicles were observed.
- `lime-seattle` had one synthetic station with approximately 13,337 free bikes and 3,543 ebikes plus 9,780 scooters. The small difference between the station aggregate and vehicle count is only a temporal observation: the objects came from the same HTTP response or nearby provider state. The capture does not establish an internal provider implementation.

The evidence supports two conclusions: typed roaming vehicles are necessary to distinguish bicycles from scooters, and adding a Lime synthetic station to typed vehicles would double count part of the fleet.

### Bird and Spin

Representative final-capture facts:

- `bird-los-angeles`: stations empty; 14 ebikes and 8,035 scooters; examined provider timestamps were fresh.
- `spin-los-angeles`: stations empty; 28 ebikes and 8 scooters; provider data remained approximately 37 days old across repeated reconnaissance.
- `spin-san-francisco`: stations empty; 112 ebikes and 3,033 scooters.
- `bird-seattle`: stations empty; 0 bicycles and 1 scooter.

These payloads do not establish operator or business status.

### Hybrid inventory and double counting

Some resources expose both station inventory and roaming bicycle inventory. In the final snapshot, `divvy` reported approximately 6,374 station free bikes, 1,976 roaming ebikes, and 993 roaming scooters. `nextbike-berlin` reported approximately 1,737 station free bikes and 3,310 roaming bikes.

For `nextbike-berlin`, `nextbike-myradl`, `kvb-rad-koln`, and `styr-staell-goeteborg`, analyzed station-bike UID sets and roaming-vehicle UID sets were disjoint in this capture. The number of station bike UIDs also matched the station `free_bikes` total in the examined data. This supports separate station and roaming inventories in those responses; it is not a universal provider guarantee.

### Station e-bike breakdown

For providers where both `extra.normal_bikes` and `extra.ebikes` were present for all examined stations, the capture satisfied:

```text
free_bikes = normal_bikes + ebikes
```

across 3,402 examined stations. Adding `extra.ebikes` on top of station `free_bikes` would double count for those providers.

## 5. Timestamp and Source-Freshness Evidence

The final capture contained 15,524 station timestamps plus 40,386 vehicle timestamps, for 55,910 timestamps. All used the unusual V2 form ending in `+00:00Z`, for example:

```text
2026-08-07T04:11:31.603538+00:00Z
```

This is observed CityBikes V2 behavior across the final evidence set.

### Node 24 timestamp-parser characterization

A follow-up characterization was run with the project's pinned Node.js `24.14.1` runtime before implementing the timestamp parser.

Native `Date.parse` / `Date` behavior was:

| Input | Observed Node 24 behavior |
| --- | --- |
| `2026-08-07T04:11:31.603538+00:00Z` | rejected as an invalid date |
| `2026-08-07T04:11:31.603538Z` | accepted as `2026-08-07T04:11:31.603Z` |
| `2026-08-07T04:11:31.603538+00:00` | accepted as `2026-08-07T04:11:31.603Z` |
| `2026-08-07T04:11:31Z` | accepted as `2026-08-07T04:11:31.000Z` |
| `2026-08-07T04:11:31` | accepted as local time rather than explicit UTC |
| `2026-02-30T04:11:31Z` | normalized to `2026-03-02T04:11:31.000Z` rather than rejected |

This characterization demonstrates two provider-boundary risks:

- the captured CityBikes `+00:00Z` form cannot be passed directly to the native Node 24 date parser;
- native date parsing is not sufficient calendar validation because some impossible dates are normalized instead of rejected.

JavaScript `Date` stores millisecond precision, so fractional digits beyond the first three are intentionally lost when a higher-precision provider timestamp is represented as a `Date`.

These findings characterize the runtime only. They do not, by themselves, claim that the project timestamp parser has been implemented.

Approximate ages of the newest provider data in this snapshot were:

| Resource | Approximate age |
| --- | ---: |
| `valenbisi` | 48.8 days |
| `spin-los-angeles` | 37.2 days |
| `callabike-berlin` | 18.9 minutes |
| `callabike-koln` | 18.9 minutes |
| `callabike-munchen` | 19.0 minutes |
| `docomo-cycle-kyoto` | 2.8 hours |
| `kotobike` | 128.1 days |

Other captured resources had much fresher provider timestamps. The supported conclusion is limited: a successful HTTP response can contain provider data much older than the HTTP response itself. The architectural freshness rule is recorded in `DECISIONS.md`.

## 6. Geographic Evidence

Captured Bay Wheels coordinates ranged approximately from latitude `37.309` to `37.885` and longitude `-122.511` to `-121.864`. The resource therefore covers a geography much wider than a single compact San Francisco city area, consistent with its provider location label, `San Francisco Bay Area, CA`.

An exact `network.location.city` match also does not prove that every station lies inside a municipal boundary: a Bixi Montréal capture included at least one geographically distant station. This is a limitation of metadata matching, not evidence for a general GIS filtering implementation.

## 7. Payload Size

One complete 34-network final round using `?fields=stations,vehicles` transferred approximately 15.4 MiB of JSON bodies.

| Resource | Approximate body size |
| --- | ---: |
| `lime-seattle` | 2.93 MB |
| `bird-los-angeles` | 2.05 MB |
| `divvy` | 1.81 MB |
| `citi-bike-nyc` | 1.27 MB |
| `nextbike-berlin` | 0.94 MB |

Selecting vehicles in the same V2 request does not cost an additional provider request, but it can materially increase transferred bytes, parse work, validation work, and trace size. These measurements do not establish a Node event-loop bottleneck.

## 8. Reconnaissance Status

Broad provider reconnaissance is considered complete. Future real-API calls should target a specific unresolved implementation question rather than repeat another broad sweep.

Remaining unknown provider behavior includes:

- exact `429` response behavior has not been intentionally triggered;
- failed and retried request accounting has not been deliberately tested;
- no cache validators were observed, but their absence in the captured sample is not proof that the provider can never emit them.

## 9. August 8 All-Resource Diagnostic Trace

**Date captured:** August 8, 2026  
**Mode:** real CityBikes V2 capture through the project's client/normalization path  
**Scope:** 30 configured network resources, 5 complete rounds

The diagnostic run completed:

```text
complete rounds:   5
incomplete rounds: 0
provider requests: 150
network resources: 30
```

This was a normalized V1 diagnostic trace created before the section-5 recorder was corrected to preserve raw HTTP status, headers, and bodies. It is therefore **not** the final benchmark trace handed in for section 5. Its purpose is provider-behavior evidence.

Each round contained one normalized sample for every configured resource and no diagnostics.

### Repeated stale-source evidence

Six configured resources were already provider-expired at capture time in **every one of the five rounds**:

```text
callabike-berlin
callabike-koln
callabike-munchen
docomo-cycle-kyoto
spin-los-angeles
valenbisi
```

A representative first-round `valenbisi` sample was:

```json
{
  "networkId": "valenbisi",
  "capturedAt": "2026-08-08T19:47:09.509Z",
  "freeBikes": 2113,
  "oldestSourceAt": "2026-06-19T09:35:47.174Z",
  "newestSourceAt": "2026-06-19T09:35:47.842Z",
  "validFrom": "2026-06-19T09:35:47.842Z",
  "validUntil": "2026-06-19T09:50:47.174Z"
}
```

A later round still reported the same provider state:

```json
{
  "networkId": "valenbisi",
  "capturedAt": "2026-08-08T19:56:56.578Z",
  "freeBikes": 2113,
  "oldestSourceAt": "2026-06-19T09:35:47.174Z",
  "newestSourceAt": "2026-06-19T09:35:47.842Z",
  "validFrom": "2026-06-19T09:35:47.842Z",
  "validUntil": "2026-06-19T09:50:47.174Z"
}
```

The HTTP retrieval occurred in August, but the source-backed validity interval still ended in June. Re-fetching therefore cannot be used to grant a fresh `maxStaleness` window.

`spin-los-angeles` showed the same pattern with source state fixed around July 1 while captured again on August 8.

### Healthy-resource contrast

The same trace also contained provider-current resources. For example, the first `styr-staell-goeteborg` sample was captured at `19:47:20.829Z` with provider source timestamps around `19:46:22Z` and validity extending to `20:01:22Z`.

The trace therefore demonstrates that stale-source behavior was not an artifact of the recorder assigning old timestamps to every network.

### What this evidence supports

The supported conclusions are:

- successful HTTP receipt is not equivalent to current provider state;
- provider source timestamps must drive freshness;
- historical normalized snapshots can be useful diagnostic/persistence evidence even when they are unusable at fetch time;
- repeatedly fetching a stale provider can produce no new usable state.

The trace does **not** prove that those resources are permanently stale or that they will behave the same way on another day.

### Relationship to the final benchmark trace

Section 5 requires raw status, headers, and body for every recorded fetch. After this diagnostic run, the trace format was replaced with V2 raw recording and deterministic raw replay.

The final benchmark capture is a separate dense V2 trace across Barcelona, Madrid, and Göteborg. It completed successfully with 60 complete rounds, 300 raw provider responses, and no incomplete rounds; the full replay methodology and results are documented in `docs/benchmark.md`.
