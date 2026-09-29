import { fileURLToPath } from "node:url";
import { z } from "zod";

const defaultDatabasePath = fileURLToPath(
  new URL("../../../data/uniquiz.db", import.meta.url),
);

const environmentSchema = z.object({
  UNIQUIZ_HOST: z.string().min(1).default("0.0.0.0"),
  UNIQUIZ_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  UNIQUIZ_DB_PATH: z.string().min(1).default(defaultDatabasePath),
  UNIQUIZ_OSC_ENABLED: z
    .string()
    .default("false")
    .transform((value) =>
      ["1", "true", "yes", "on"].includes(value.toLowerCase()),
    ),
  UNIQUIZ_OSC_HOST: z.string().min(1).default("127.0.0.1"),
  UNIQUIZ_OSC_PORT: z.coerce.number().int().min(1).max(65535).default(9001),
});

const parsed = environmentSchema.parse(process.env);

export const config = {
  host: parsed.UNIQUIZ_HOST,
  port: parsed.UNIQUIZ_PORT,
  databasePath: parsed.UNIQUIZ_DB_PATH,
  osc: {
    enabled: parsed.UNIQUIZ_OSC_ENABLED,
    host: parsed.UNIQUIZ_OSC_HOST,
    port: parsed.UNIQUIZ_OSC_PORT,
  },
} as const;
