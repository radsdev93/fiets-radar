import {
  CITY_CONFIGS,
  DEFAULT_MAX_STALENESS_SECONDS,
} from "../src/config/cities";

describe("CITY_CONFIGS", () => {
  it("contains exactly the required city labels and country codes", () => {
    expect(
      CITY_CONFIGS.map(({ city, countryCode }) => ({ city, countryCode })),
    ).toStrictEqual([
      { city: "Barcelona", countryCode: "ES" },
      { city: "Madrid", countryCode: "ES" },
      { city: "Valencia", countryCode: "ES" },
      { city: "Bilbao", countryCode: "ES" },
      { city: "Paris", countryCode: "FR" },
      { city: "London", countryCode: "GB" },
      { city: "New York, NY", countryCode: "US" },
      { city: "Chicago, IL", countryCode: "US" },
      { city: "Los Angeles, CA", countryCode: "US" },
      { city: "San Francisco, CA", countryCode: "US" },
      { city: "Seattle, WA", countryCode: "US" },
      { city: "Portland, OR", countryCode: "US" },
      { city: "Berlin", countryCode: "DE" },
      { city: "Köln", countryCode: "DE" },
      { city: "München", countryCode: "DE" },
      { city: "Lisbon", countryCode: "PT" },
      { city: "Toronto, ON", countryCode: "CA" },
      { city: "Montréal, QC", countryCode: "CA" },
      { city: "京都府 (Kyoto)", countryCode: "JP" },
      { city: "Göteborg", countryCode: "SE" },
    ]);
    expect(DEFAULT_MAX_STALENESS_SECONDS).toBe(900);
  });

  it("contains 30 unique selected resources with the documented mode totals", () => {
    const networks = CITY_CONFIGS.flatMap((city) => city.networks);
    const modeTotals = networks.reduce(
      (totals, network) => ({
        ...totals,
        [network.mode]: totals[network.mode] + 1,
      }),
      {
        "stations-only": 0,
        "vehicles-only": 0,
        "stations-and-vehicles": 0,
      },
    );

    expect(networks).toHaveLength(30);
    expect(new Set(networks.map((network) => network.networkId)).size).toBe(30);
    expect(modeTotals).toStrictEqual({
      "stations-only": 16,
      "vehicles-only": 4,
      "stations-and-vehicles": 10,
    });
    expect(networks.map((network) => network.networkId)).not.toEqual(
      expect.arrayContaining([
        "lime-san-francisco",
        "bird-seattle",
        "lime-portland",
        "kotobike",
      ]),
    );
  });

  it("maps representative multi-resource cities and the Bay Wheels bounds", () => {
    const byCity = new Map(CITY_CONFIGS.map((city) => [city.city, city]));
    const networkIds = (city: string) =>
      byCity.get(city)?.networks.map((network) => network.networkId);

    expect(networkIds("Los Angeles, CA")).toStrictEqual([
      "bird-los-angeles",
      "spin-los-angeles",
      "metro-bike-share",
    ]);
    expect(networkIds("San Francisco, CA")).toStrictEqual([
      "spin-san-francisco",
      "bay-wheels",
    ]);
    expect(networkIds("Berlin")).toStrictEqual([
      "callabike-berlin",
      "nextbike-berlin",
    ]);
    expect(networkIds("京都府 (Kyoto)")).toStrictEqual([
      "docomo-cycle-kyoto",
      "hellocycling-kyoto",
    ]);
    expect(networkIds("Göteborg")).toStrictEqual([
      "e-cargobike-goteborg",
      "styr-staell-goeteborg",
    ]);

    const sanFrancisco = byCity.get("San Francisco, CA");
    const bayWheels = sanFrancisco?.networks.find(
      (network) => network.networkId === "bay-wheels",
    );

    expect(bayWheels).toStrictEqual({
      networkId: "bay-wheels",
      mode: "stations-and-vehicles",
      bounds: {
        minLatitude: 37.708,
        maxLatitude: 37.833,
        minLongitude: -122.515,
        maxLongitude: -122.356,
      },
    });
  });
});
