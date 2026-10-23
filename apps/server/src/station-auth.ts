import {
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { appendAuditEvent } from "./audit.js";
import type { AppDatabase } from "./database.js";

export type TeamStation = "A" | "B";

export interface StationCredential {
  station: TeamStation;
  token: string;
}

function newToken(): string {
  return randomBytes(24).toString("base64url");
}

export function ensureStationCredentials(
  db: AppDatabase,
): void {
  const insert = db.prepare(`
    INSERT INTO station_credentials (
      station,
      access_token,
      created_at
    )
    VALUES (?, ?, ?)
    ON CONFLICT(station) DO NOTHING
  `);

  const now = new Date().toISOString();
  insert.run("A", newToken(), now);
  insert.run("B", newToken(), now);
}

export function listStationCredentials(
  db: AppDatabase,
): StationCredential[] {
  return db.prepare(`
    SELECT
      station,
      access_token AS token
    FROM station_credentials
    ORDER BY station
  `).all() as StationCredential[];
}

export function validateStationToken(
  db: AppDatabase,
  station: TeamStation,
  candidate: unknown,
): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) {
    return false;
  }

  const row = db.prepare(`
    SELECT access_token AS token
    FROM station_credentials
    WHERE station = ?
  `).get(station) as { token: string } | undefined;

  if (!row) return false;

  const expected = Buffer.from(row.token);
  const actual = Buffer.from(candidate);

  return (
    expected.length === actual.length &&
    timingSafeEqual(expected, actual)
  );
}

const rotateStationSchema = z.object({
  confirm: z.literal("ROTATE_STATION_TOKEN"),
}).strict();

/** Revoke a station credential atomically without changing any competition data. */
export function rotateStationToken(db: AppDatabase, station: TeamStation): StationCredential {
  if (station !== "A" && station !== "B") throw new Error("UNKNOWN_STATION");
  return db.transaction(() => {
    const row = db.prepare("SELECT station FROM station_credentials WHERE station=?")
      .get(station);
    if (!row) throw new Error("STATION_CREDENTIAL_NOT_FOUND");
    const token = newToken();
    const now = new Date().toISOString();
    db.prepare("UPDATE station_credentials SET access_token=?, rotated_at=? WHERE station=?")
      .run(token, now, station);
    appendAuditEvent(db, {
      eventType: "STATION_CREDENTIAL_ROTATED",
      payload: { station },
      occurredAt: now,
    });
    return { station, token };
  })();
}

export function isStationRotationSafe(db: AppDatabase): boolean {
  const state = db.prepare("SELECT phase FROM live_state WHERE id=1")
    .get() as { phase: string } | undefined;
  const active = db.prepare("SELECT COUNT(*) AS count FROM qualification_rounds WHERE status='ACTIVE'")
    .get() as { count: number };
  return (state?.phase === "IDLE" || state?.phase === "ROUND_COMPLETE") &&
    active.count === 0;
}

export function registerStationAuthRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  disconnectStation?: (station: TeamStation) => void,
): void {
  app.get("/api/stations/credentials", async () => {
    const credentials = listStationCredentials(db);
    const teamA = credentials.find((item) => item.station === "A");
    const teamB = credentials.find((item) => item.station === "B");

    return {
      teamA: teamA ?? null,
      teamB: teamB ?? null,
    };
  });
  app.post<{ Params: { station: string } }>(
    "/api/stations/:station/rotate",
    async (request, reply) => {
      const station = request.params.station.toUpperCase();
      if (station !== "A" && station !== "B") {
        return reply.code(404).send({ error: "UNKNOWN_STATION" });
      }
      const parsed = rotateStationSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "ROTATION_CONFIRMATION_REQUIRED" });
      }
      if (!isStationRotationSafe(db)) {
        return reply.code(409).send({
          error: "STATION_ROTATION_BLOCKED_BY_LIVE_SESSION",
          message: "Finish the active round before rotating the station credential.",
        });
      }
      const credential = rotateStationToken(db, station);
      // The previous socket has already authenticated; disconnect it so it
      // cannot submit answers after credential rotation.
      disconnectStation?.(station);
      return reply.header("cache-control", "no-store").send({ credential });
    },
  );

}
