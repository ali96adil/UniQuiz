import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { RuntimeMode } from "@uniquiz/shared";

const defaultDatabasePaths: Record<RuntimeMode, string> = {
  official: fileURLToPath(
    new URL("../../../data/uniquiz.db", import.meta.url),
  ),
  rehearsal: fileURLToPath(
    new URL(
      "../../../data/uniquiz-rehearsal.db",
      import.meta.url,
    ),
  ),
};

const environmentSchema = z.object({
  UNIQUIZ_MODE: z
    .enum(["official", "rehearsal"])
    .default("official"),
  UNIQUIZ_HOST: z.string().min(1).default("0.0.0.0"),
  UNIQUIZ_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  UNIQUIZ_DB_PATH: z.string().min(1).optional(),
  UNIQUIZ_OSC_ENABLED: z
    .string()
    .default("false")
    .transform((value) =>
      ["1", "true", "yes", "on"].includes(value.toLowerCase()),
    ),
  UNIQUIZ_OSC_HOST: z.string().min(1).default("127.0.0.1"),
  UNIQUIZ_OSC_PORT: z.coerce.number().int().min(1).max(65535).default(9001),
});

export function resolveConfig(
  env: NodeJS.ProcessEnv,
) {
  const parsed = environmentSchema.parse(env);

  return {
    mode: parsed.UNIQUIZ_MODE,
    host: parsed.UNIQUIZ_HOST,
    port: parsed.UNIQUIZ_PORT,
    databasePath:
      parsed.UNIQUIZ_DB_PATH ??
      defaultDatabasePaths[parsed.UNIQUIZ_MODE],
    osc: {
      enabled: parsed.UNIQUIZ_OSC_ENABLED,
      host: parsed.UNIQUIZ_OSC_HOST,
      port: parsed.UNIQUIZ_OSC_PORT,
    },
  } as const;
}

export const config = resolveConfig(process.env);
