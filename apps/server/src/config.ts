import { fileURLToPath } from "node:url";
import { z } from "zod";

const defaultDatabasePath = fileURLToPath(
  new URL("../../../data/uniquiz.db", import.meta.url),
);

const environmentSchema = z.object({
  UNIQUIZ_HOST: z.string().min(1).default("0.0.0.0"),
  UNIQUIZ_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  UNIQUIZ_DB_PATH: z.string().min(1).default(defaultDatabasePath),
});

const parsed = environmentSchema.parse(process.env);

export const config = {
  host: parsed.UNIQUIZ_HOST,
  port: parsed.UNIQUIZ_PORT,
  databasePath: parsed.UNIQUIZ_DB_PATH,
} as const;
