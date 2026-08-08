import Database from "better-sqlite3";

import type { CityCompositionResult } from "../composition/city-composer";
import type { HourlyResult, ValidityObservation } from "../core/aggregator";
import type { NetworkNormalizationResult } from "../normalization/network-normalizer";

type NormalizedNetworkSnapshot = Extract<
  NetworkNormalizationResult,
  { kind: "success" }
>;

type CompleteCityObservation = Extract<
  CityCompositionResult,
  { kind: "complete" }
>;

export type PersistedRequestBudgetState =
  | { kind: "unknown" }
  | { kind: "bootstrap-pending" }
  | {
      kind: "established";
      limit: number;
      remaining: number;
      resetAt: Date;
    }
  | { kind: "fail-closed"; resetAt: Date | null };

export interface StoredHourlyResult extends HourlyResult {
  city: string;
  countryCode: string;
  hourStart: Date;
}

interface NetworkSnapshotRow {
  network_id: string;
  free_bikes: number;
  oldest_source_at: number;
  newest_source_at: number;
  valid_from: number;
  valid_until: number;
  fetched_at: number;
}

interface CityObservationRow {
  observed_at: number;
  valid_until: number;
  free_bikes: number;
}

interface HourlyResultRow {
  covered_seconds: number;
  average_free_bikes: number | null;
  coverage: number;
  partial: number;
}

interface StoredHourlyResultRow extends HourlyResultRow {
  city: string;
  country_code: string;
  hour_start: number;
}

interface RequestBudgetStateRow {
  state_kind: string;
  limit_value: number | null;
  remaining_value: number | null;
  reset_at: number | null;
}

function networkSnapshotFromRow(
  row: NetworkSnapshotRow,
): NormalizedNetworkSnapshot {
  return {
    kind: "success",
    networkId: row.network_id,
    freeBikes: row.free_bikes,
    oldestSourceAt: new Date(row.oldest_source_at),
    newestSourceAt: new Date(row.newest_source_at),
    validFrom: new Date(row.valid_from),
    validUntil: new Date(row.valid_until),
    fetchedAt: new Date(row.fetched_at),
  };
}

function requestBudgetStateFromRow(
  row: RequestBudgetStateRow | undefined,
): PersistedRequestBudgetState {
  if (row === undefined) {
    return { kind: "unknown" };
  }

  const resetAt = dateFromEpochMilliseconds(row.reset_at);
  const hasNoBudgetValues =
    row.limit_value === null &&
    row.remaining_value === null &&
    row.reset_at === null;

  if (row.state_kind === "unknown" && hasNoBudgetValues) {
    return { kind: "unknown" };
  }

  if (row.state_kind === "bootstrap-pending" && hasNoBudgetValues) {
    return { kind: "bootstrap-pending" };
  }

  if (
    row.state_kind === "established" &&
    row.limit_value !== null &&
    row.remaining_value !== null &&
    isValidEstablishedBudget(row.limit_value, row.remaining_value) &&
    resetAt !== null
  ) {
    return {
      kind: "established",
      limit: row.limit_value,
      remaining: row.remaining_value,
      resetAt,
    };
  }

  if (
    row.state_kind === "fail-closed" &&
    row.limit_value === null &&
    row.remaining_value === null
  ) {
    return {
      kind: "fail-closed",
      resetAt,
    };
  }

  return { kind: "fail-closed", resetAt };
}

function isValidEstablishedBudget(
  limit: number | null,
  remaining: number | null,
): boolean {
  return (
    limit !== null &&
    remaining !== null &&
    Number.isSafeInteger(limit) &&
    Number.isSafeInteger(remaining) &&
    limit > 0 &&
    remaining >= 0 &&
    remaining <= limit
  );
}

function dateFromEpochMilliseconds(value: number | null): Date | null {
  if (value === null || !Number.isSafeInteger(value)) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export class SqliteStore {
  private readonly database: Database.Database;
  private isClosed = false;

  constructor(databasePath: string) {
    this.database = new Database(databasePath);

    if (databasePath !== ":memory:") {
      this.database.pragma("journal_mode = WAL");
      this.database.pragma("synchronous = FULL");
    }

    this.database.exec(`
      CREATE TABLE IF NOT EXISTS network_snapshots (
        network_id TEXT NOT NULL,
        free_bikes INTEGER NOT NULL,
        oldest_source_at INTEGER NOT NULL,
        newest_source_at INTEGER NOT NULL,
        valid_from INTEGER NOT NULL,
        valid_until INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (
          network_id,
          free_bikes,
          oldest_source_at,
          newest_source_at,
          valid_from,
          valid_until,
          fetched_at
        )
      );
      CREATE INDEX IF NOT EXISTS network_snapshots_usable_idx
        ON network_snapshots (network_id, valid_from DESC, fetched_at DESC, valid_until);

      CREATE TABLE IF NOT EXISTS city_observations (
        city TEXT NOT NULL,
        country_code TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        valid_until INTEGER NOT NULL,
        free_bikes INTEGER NOT NULL,
        oldest_source_at INTEGER NOT NULL,
        newest_source_at INTEGER NOT NULL,
        PRIMARY KEY (city, country_code, observed_at)
      );
      CREATE INDEX IF NOT EXISTS city_observations_hour_idx
        ON city_observations (city, country_code, observed_at, valid_until);

      CREATE TABLE IF NOT EXISTS hourly_results (
        city TEXT NOT NULL,
        country_code TEXT NOT NULL,
        hour_start INTEGER NOT NULL,
        covered_seconds REAL NOT NULL,
        average_free_bikes REAL,
        coverage REAL NOT NULL,
        partial INTEGER NOT NULL,
        PRIMARY KEY (city, country_code, hour_start)
      );

      CREATE TABLE IF NOT EXISTS request_budget_state (
        state_id INTEGER PRIMARY KEY CHECK (state_id = 1),
        state_kind TEXT NOT NULL,
        limit_value INTEGER,
        remaining_value INTEGER,
        reset_at INTEGER
      );
    `);
  }

  close(): void {
    if (!this.isClosed) {
      this.database.close();
      this.isClosed = true;
    }
  }

  saveNetworkSnapshot(snapshot: NormalizedNetworkSnapshot): void {
    this.database
      .prepare<unknown[]>(`
        INSERT OR IGNORE INTO network_snapshots (
          network_id,
          free_bikes,
          oldest_source_at,
          newest_source_at,
          valid_from,
          valid_until,
          fetched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        snapshot.networkId,
        snapshot.freeBikes,
        snapshot.oldestSourceAt.getTime(),
        snapshot.newestSourceAt.getTime(),
        snapshot.validFrom.getTime(),
        snapshot.validUntil.getTime(),
        snapshot.fetchedAt.getTime(),
      );
  }

  findUsableNetworkSnapshot(
    networkId: string,
    asOf: Date,
  ): NormalizedNetworkSnapshot | null {
    const asOfMs = asOf.getTime();
    const row = this.database
      .prepare<unknown[], NetworkSnapshotRow>(`
        SELECT
          network_id,
          free_bikes,
          oldest_source_at,
          newest_source_at,
          valid_from,
          valid_until,
          fetched_at
        FROM network_snapshots
        WHERE network_id = ?
          AND fetched_at <= ?
          AND valid_from <= ?
          AND valid_until > ?
        ORDER BY valid_from DESC, fetched_at DESC
        LIMIT 1
      `)
      .get(networkId, asOfMs, asOfMs, asOfMs);

    return row === undefined ? null : networkSnapshotFromRow(row);
  }

  saveCityObservation(observation: CompleteCityObservation): void {
    this.database
      .prepare<unknown[]>(`
        INSERT OR IGNORE INTO city_observations (
          city,
          country_code,
          observed_at,
          valid_until,
          free_bikes,
          oldest_source_at,
          newest_source_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        observation.city,
        observation.countryCode,
        observation.observedAt.getTime(),
        observation.validUntil.getTime(),
        observation.freeBikes,
        observation.oldestSourceAt.getTime(),
        observation.newestSourceAt.getTime(),
      );
  }

  getCityObservationsForHour(
    city: string,
    countryCode: string,
    hourStart: Date,
    hourEnd: Date,
  ): ValidityObservation[] {
    const rows = this.database
      .prepare<unknown[], CityObservationRow>(`
        SELECT observed_at, valid_until, free_bikes
        FROM city_observations
        WHERE city = ?
          AND country_code = ?
          AND observed_at < ?
          AND valid_until > ?
        ORDER BY observed_at ASC
      `)
      .all(city, countryCode, hourEnd.getTime(), hourStart.getTime());

    return rows.map((row) => ({
      timestamp: new Date(row.observed_at),
      validUntil: new Date(row.valid_until),
      freeBikes: row.free_bikes,
    }));
  }

  saveHourlyResult(
    city: string,
    countryCode: string,
    hourStart: Date,
    result: HourlyResult,
  ): void {
    this.database
      .prepare<unknown[]>(`
        INSERT INTO hourly_results (
          city,
          country_code,
          hour_start,
          covered_seconds,
          average_free_bikes,
          coverage,
          partial
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (city, country_code, hour_start) DO UPDATE SET
          covered_seconds = excluded.covered_seconds,
          average_free_bikes = excluded.average_free_bikes,
          coverage = excluded.coverage,
          partial = excluded.partial
      `)
      .run(
        city,
        countryCode,
        hourStart.getTime(),
        result.coveredSeconds,
        result.averageFreeBikes,
        result.coverage,
        result.partial ? 1 : 0,
      );
  }

  getHourlyResult(
    city: string,
    countryCode: string,
    hourStart: Date,
  ): HourlyResult | null {
    const row = this.database
      .prepare<unknown[], HourlyResultRow>(`
        SELECT covered_seconds, average_free_bikes, coverage, partial
        FROM hourly_results
        WHERE city = ?
          AND country_code = ?
          AND hour_start = ?
      `)
      .get(city, countryCode, hourStart.getTime());

    if (row === undefined) {
      return null;
    }

    return {
      coveredSeconds: row.covered_seconds,
      averageFreeBikes: row.average_free_bikes,
      coverage: row.coverage,
      partial: row.partial !== 0,
    };
  }

  listHourlyResults(): StoredHourlyResult[] {
    const rows = this.database
      .prepare<unknown[], StoredHourlyResultRow>(`
        SELECT
          city,
          country_code,
          hour_start,
          covered_seconds,
          average_free_bikes,
          coverage,
          partial
        FROM hourly_results
        ORDER BY hour_start ASC, city ASC, country_code ASC
      `)
      .all();

    return rows.map((row) => ({
      city: row.city,
      countryCode: row.country_code,
      hourStart: new Date(row.hour_start),
      coveredSeconds: row.covered_seconds,
      averageFreeBikes: row.average_free_bikes,
      coverage: row.coverage,
      partial: row.partial !== 0,
    }));
  }

  getRequestBudgetState(): PersistedRequestBudgetState {
    const row = this.database
      .prepare<unknown[], RequestBudgetStateRow>(`
        SELECT state_kind, limit_value, remaining_value, reset_at
        FROM request_budget_state
        WHERE state_id = 1
      `)
      .get();

    return requestBudgetStateFromRow(row);
  }

  saveRequestBudgetState(state: PersistedRequestBudgetState): void {
    const limit = state.kind === "established" ? state.limit : null;
    const remaining = state.kind === "established" ? state.remaining : null;
    const resetAt =
      state.kind === "established" || state.kind === "fail-closed"
        ? state.resetAt
        : null;

    this.database
      .prepare<unknown[]>(`
        INSERT INTO request_budget_state (
          state_id,
          state_kind,
          limit_value,
          remaining_value,
          reset_at
        ) VALUES (1, ?, ?, ?, ?)
        ON CONFLICT (state_id) DO UPDATE SET
          state_kind = excluded.state_kind,
          limit_value = excluded.limit_value,
          remaining_value = excluded.remaining_value,
          reset_at = excluded.reset_at
      `)
      .run(
        state.kind,
        limit,
        remaining,
        resetAt === null ? null : resetAt.getTime(),
      );
  }
}
