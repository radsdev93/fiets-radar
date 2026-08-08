import { z } from "zod";

import { parseCityBikesTimestamp } from "./timestamp";

const cityBikesTimestampSchema = z.string().transform((raw, context) => {
  const timestamp = parseCityBikesTimestamp(raw);

  if (timestamp === null) {
    context.addIssue({
      code: "custom",
      message: "Invalid CityBikes timestamp",
    });
    return z.NEVER;
  }

  return timestamp;
});

const stationSchema = z.object({
  id: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  timestamp: cityBikesTimestampSchema,
  free_bikes: z.number().int().nonnegative(),
});

const vehicleSchema = z.object({
  id: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  timestamp: cityBikesTimestampSchema,
  kind: z.string().min(1),
});

export const cityBikesResponseSchema = z.object({
  network: z.object({
    stations: z.array(stationSchema),
    vehicles: z.array(vehicleSchema).optional(),
  }),
});
