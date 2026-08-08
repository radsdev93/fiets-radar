import type { CityConfig } from "../../src/config/cities";
import { finalizeCompletedHour } from "../../src/runtime/hourly-finalizer";
import { SqliteStore } from "../../src/storage/sqlite-store";

const cityConfigs: CityConfig[] = [
  {
    city: "Recovery City",
    countryCode: "RC",
    networks: [{ networkId: "recovery-network", mode: "stations-only" }],
  },
];

function at(time: string): Date {
  return new Date(`2026-08-08T${time}Z`);
}

function saveObservation(
  store: SqliteStore,
  observedAt: string,
  validUntil: string,
  freeBikes: number,
): void {
  store.saveCityObservation({
    kind: "complete",
    city: "Recovery City",
    countryCode: "RC",
    observedAt: at(observedAt),
    validUntil: at(validUntil),
    freeBikes,
    oldestSourceAt: at(observedAt),
    newestSourceAt: at(observedAt),
    availableNetworks: ["recovery-network"],
  });
}

const [databasePath, mode] = process.argv.slice(2);

if (databasePath === undefined || mode === undefined) {
  throw new Error("Expected database path and worker mode");
}

const store = new SqliteStore(databasePath);

if (mode === "prepare") {
  saveObservation(store, "10:00:00", "10:20:00", 10);
  saveObservation(store, "10:20:00", "11:00:00", 20);
  finalizeCompletedHour(store, cityConfigs, at("10:00:00"));
  saveObservation(store, "11:00:00", "11:10:00", 10);
  process.on("message", () => {
    store.close();
  });
  process.send?.("READY");
} else if (mode === "resume") {
  saveObservation(store, "11:00:00", "11:10:00", 10);
  saveObservation(store, "11:10:00", "11:30:00", 20);
  saveObservation(store, "11:30:00", "12:00:00", 30);
  finalizeCompletedHour(store, cityConfigs, at("11:00:00"));
  store.close();
} else {
  store.close();
  throw new Error(`Unknown worker mode: ${mode}`);
}
