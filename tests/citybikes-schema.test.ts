import { cityBikesResponseSchema } from "../src/citybikes/schemas";

function validStation() {
  return {
    id: "station-1",
    latitude: 41.3851,
    longitude: 2.1734,
    timestamp: "2026-08-07T04:11:31.603538+00:00Z",
    free_bikes: 7,
  };
}

function validVehicle() {
  return {
    id: "vehicle-1",
    latitude: 47.6062,
    longitude: -122.3321,
    timestamp: "2026-08-07T04:12:00.123456+00:00Z",
    kind: "scooter",
  };
}

describe("cityBikesResponseSchema", () => {
  it("accepts a stations-only response and removes unused provider fields", () => {
    const result = cityBikesResponseSchema.safeParse({
      network: {
        stations: [
          {
            ...validStation(),
            name: "Ignored provider station name",
            empty_slots: 3,
            extra: { arbitrary_provider_field: "ignored" },
          },
        ],
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected stations-only response to validate");
    }

    expect(result.data).toStrictEqual({
      network: {
        stations: [
          {
            id: "station-1",
            latitude: 41.3851,
            longitude: 2.1734,
            timestamp: new Date("2026-08-07T04:11:31.603Z"),
            free_bikes: 7,
          },
        ],
      },
    });
  });

  it("accepts roaming scooters structurally and removes unused provider fields", () => {
    const result = cityBikesResponseSchema.safeParse({
      network: {
        stations: [],
        vehicles: [
          {
            ...validVehicle(),
            extra: { arbitrary_provider_field: 123 },
          },
        ],
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected response with roaming vehicles to validate");
    }

    expect(result.data).toStrictEqual({
      network: {
        stations: [],
        vehicles: [
          {
            id: "vehicle-1",
            latitude: 47.6062,
            longitude: -122.3321,
            timestamp: new Date("2026-08-07T04:12:00.123Z"),
            kind: "scooter",
          },
        ],
      },
    });
  });

  it("accepts an unknown non-empty vehicle kind structurally", () => {
    const result = cityBikesResponseSchema.safeParse({
      network: {
        stations: [],
        vehicles: [{ ...validVehicle(), kind: "future-bike-kind" }],
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected unknown vehicle kind to validate");
    }

    expect(result.data).toStrictEqual({
      network: {
        stations: [],
        vehicles: [
          {
            id: "vehicle-1",
            latitude: 47.6062,
            longitude: -122.3321,
            timestamp: new Date("2026-08-07T04:12:00.123Z"),
            kind: "future-bike-kind",
          },
        ],
      },
    });
  });

  it("accepts explicit empty station and vehicle arrays", () => {
    const result = cityBikesResponseSchema.safeParse({
      network: {
        stations: [],
        vehicles: [],
      },
    });

    expect(result.success).toBe(true);
  });

  it.each([
    ["a null root", null],
    ["a missing network", {}],
    ["missing required stations", { network: {} }],
    ["stations that are not an array", { network: { stations: {} } }],
    [
      "a string station free_bikes value",
      { network: { stations: [{ ...validStation(), free_bikes: "7" }] } },
    ],
    [
      "a negative station free_bikes value",
      { network: { stations: [{ ...validStation(), free_bikes: -1 }] } },
    ],
    [
      "a fractional station free_bikes value",
      { network: { stations: [{ ...validStation(), free_bikes: 7.5 }] } },
    ],
    [
      "an empty station id",
      { network: { stations: [{ ...validStation(), id: "" }] } },
    ],
    [
      "an impossible station timestamp",
      {
        network: {
          stations: [
            { ...validStation(), timestamp: "2026-02-30T04:11:31Z" },
          ],
        },
      },
    ],
    [
      "a malformed vehicle timestamp",
      {
        network: {
          stations: [],
          vehicles: [{ ...validVehicle(), timestamp: "not-a-date" }],
        },
      },
    ],
    [
      "a station latitude outside the geographic range",
      { network: { stations: [{ ...validStation(), latitude: 91 }] } },
    ],
    [
      "a station longitude outside the geographic range",
      { network: { stations: [{ ...validStation(), longitude: 181 }] } },
    ],
    [
      "a vehicle longitude outside the geographic range",
      {
        network: {
          stations: [],
          vehicles: [{ ...validVehicle(), longitude: -181 }],
        },
      },
    ],
    [
      "a vehicle latitude outside the geographic range",
      {
        network: {
          stations: [],
          vehicles: [{ ...validVehicle(), latitude: -91 }],
        },
      },
    ],
    [
      "an empty vehicle id",
      {
        network: {
          stations: [],
          vehicles: [{ ...validVehicle(), id: "" }],
        },
      },
    ],
    [
      "an empty vehicle kind",
      {
        network: {
          stations: [],
          vehicles: [{ ...validVehicle(), kind: "" }],
        },
      },
    ],
    [
      "vehicles that are not an array",
      { network: { stations: [], vehicles: {} } },
    ],
  ])("rejects %s", (_description, response) => {
    expect(cityBikesResponseSchema.safeParse(response).success).toBe(false);
  });
});
