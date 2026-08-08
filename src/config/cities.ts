export type NetworkNormalizationMode =
  | "stations-only"
  | "vehicles-only"
  | "stations-and-vehicles";

export interface GeographicBounds {
  minLatitude: number;
  maxLatitude: number;
  minLongitude: number;
  maxLongitude: number;
}

export interface ConfiguredNetwork {
  networkId: string;
  mode: NetworkNormalizationMode;
  bounds?: GeographicBounds;
}

export interface CityConfig {
  city: string;
  countryCode: string;
  networks: ConfiguredNetwork[];
}

export const DEFAULT_MAX_STALENESS_SECONDS = 900;

export const CITY_CONFIGS: CityConfig[] = [
  {
    city: "Barcelona",
    countryCode: "ES",
    networks: [
      { networkId: "ambici-amb", mode: "stations-only" },
      { networkId: "bicing", mode: "stations-only" },
    ],
  },
  { city: "Madrid", countryCode: "ES", networks: [{ networkId: "bicimad", mode: "stations-only" }] },
  { city: "Valencia", countryCode: "ES", networks: [{ networkId: "valenbisi", mode: "stations-only" }] },
  {
    city: "Bilbao",
    countryCode: "ES",
    networks: [
      { networkId: "bilbon-bizi", mode: "stations-only" },
      { networkId: "bizkaibizi-bilbao", mode: "stations-only" },
    ],
  },
  { city: "Paris", countryCode: "FR", networks: [{ networkId: "velib", mode: "stations-only" }] },
  { city: "London", countryCode: "GB", networks: [{ networkId: "santander-cycles", mode: "stations-only" }] },
  { city: "New York, NY", countryCode: "US", networks: [{ networkId: "citi-bike-nyc", mode: "stations-only" }] },
  { city: "Chicago, IL", countryCode: "US", networks: [{ networkId: "divvy", mode: "stations-and-vehicles" }] },
  {
    city: "Los Angeles, CA",
    countryCode: "US",
    networks: [
      { networkId: "bird-los-angeles", mode: "vehicles-only" },
      { networkId: "spin-los-angeles", mode: "vehicles-only" },
      { networkId: "metro-bike-share", mode: "stations-only" },
    ],
  },
  {
    city: "San Francisco, CA",
    countryCode: "US",
    networks: [
      { networkId: "spin-san-francisco", mode: "vehicles-only" },
      {
        networkId: "bay-wheels",
        mode: "stations-and-vehicles",
        bounds: {
          minLatitude: 37.708,
          maxLatitude: 37.833,
          minLongitude: -122.515,
          maxLongitude: -122.356,
        },
      },
    ],
  },
  { city: "Seattle, WA", countryCode: "US", networks: [{ networkId: "lime-seattle", mode: "vehicles-only" }] },
  { city: "Portland, OR", countryCode: "US", networks: [{ networkId: "biketown", mode: "stations-and-vehicles" }] },
  {
    city: "Berlin",
    countryCode: "DE",
    networks: [
      { networkId: "callabike-berlin", mode: "stations-and-vehicles" },
      { networkId: "nextbike-berlin", mode: "stations-and-vehicles" },
    ],
  },
  {
    city: "Köln",
    countryCode: "DE",
    networks: [
      { networkId: "callabike-koln", mode: "stations-and-vehicles" },
      { networkId: "kvb-rad-koln", mode: "stations-and-vehicles" },
    ],
  },
  {
    city: "München",
    countryCode: "DE",
    networks: [
      { networkId: "callabike-munchen", mode: "stations-and-vehicles" },
      { networkId: "nextbike-myradl", mode: "stations-and-vehicles" },
    ],
  },
  { city: "Lisbon", countryCode: "PT", networks: [{ networkId: "gira", mode: "stations-only" }] },
  { city: "Toronto, ON", countryCode: "CA", networks: [{ networkId: "bixi-toronto", mode: "stations-only" }] },
  { city: "Montréal, QC", countryCode: "CA", networks: [{ networkId: "bixi-montreal", mode: "stations-only" }] },
  {
    city: "京都府 (Kyoto)",
    countryCode: "JP",
    networks: [
      { networkId: "docomo-cycle-kyoto", mode: "stations-only" },
      { networkId: "hellocycling-kyoto", mode: "stations-only" },
    ],
  },
  {
    city: "Göteborg",
    countryCode: "SE",
    networks: [
      { networkId: "e-cargobike-goteborg", mode: "stations-only" },
      { networkId: "styr-staell-goeteborg", mode: "stations-and-vehicles" },
    ],
  },
];
