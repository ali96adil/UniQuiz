import {
  randomBytes,
  randomInt,
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

const PAIRING_TTL_MS = 5 * 60 * 1000;
const PAIRING_FAILURE_WINDOW_MS = 60 * 1000;
const MAX_PAIRING_FAILURES = 5;
const issuePairingSchema = z.object({}).strict();
const enrollSchema = z.object({
  station: z.enum(["A", "B"]),
  code: z.string().regex(/^\d{6}$/),
}).strict();

/**
 * Short numeric codes are one-use, ephemeral exchange secrets.
 * The long-term 192-bit station token never changes or becomes a short code.
 * Codes are NOT persisted, and automatically expire on server restart.
 */
export function createStationPairingManager(now: () => number = Date.now) {
  const codes = new Map<TeamStation, { code: string; expiresAt: number }>();
  const failures = new Map<string, { count: number; resetAt: number }>();
  function prune() {
    const time = now();
    for (const [station, value] of codes) if (value.expiresAt <= time) codes.delete(station);
    for (const [key, value] of failures) if (value.resetAt <= time) failures.delete(key);
  }
  return {
    issue(station: TeamStation) {
      prune();
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const expiresAt = now() + PAIRING_TTL_MS;
      codes.set(station, { code, expiresAt });
      return { station, code, expiresAt };
    },
    invalidate(station: TeamStation) { codes.delete(station); },
    redeem(station: TeamStation, submitted: string, clientIp: string): "OK" | "INVALID" | "RATE_LIMITED" {
      prune();
      const key = clientIp + ":" + station;
      const current = failures.get(key);
      if (current && current.count >= MAX_PAIRING_FAILURES && current.resetAt > now())
        return "RATE_LIMITED";
      const active = codes.get(station);
      const valid = active !== undefined &&
        timingSafeEqual(Buffer.from(active.code), Buffer.from(submitted));
      if (!valid) {
        const count = current && current.resetAt > now() ? current.count + 1 : 1;
        failures.set(key, {
          count, resetAt: current && current.resetAt > now()
            ? current.resetAt : now() + PAIRING_FAILURE_WINDOW_MS,
        });
        // Cap memory even under floods of spoofed enrollment attempts.
        if (failures.size > 500) failures.delete(failures.keys().next().value!);
        return "INVALID";
      }
      codes.delete(station); // single-use: replay is never allowed
      failures.delete(key);
      return "OK";
    },
  };
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
  const pairing = createStationPairingManager();
  app.post<{ Params: { station: string } }>("/api/stations/:station/pairing-code", async (request, reply) => {
    const station = request.params.station.toUpperCase();
    if (station !== "A" && station !== "B") return reply.code(404).send({ error: "UNKNOWN_STATION" });
    if (!issuePairingSchema.safeParse(request.body ?? {}).success)
      return reply.code(400).send({ error: "INVALID_REQUEST" });
    const issued = pairing.issue(station);
    return reply.header("cache-control", "no-store").send(issued);
  });
  app.post("/api/stations/enroll", async (request, reply) => {
    const body = enrollSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "INVALID_PAIRING_CODE" });
    const result = pairing.redeem(body.data.station, body.data.code, request.ip);
    reply.header("cache-control", "no-store");
    if (result === "RATE_LIMITED")
      return reply.code(429).send({ error: "PAIRING_RATE_LIMITED" });
    if (result === "INVALID")
      return reply.code(401).send({ error: "INVALID_OR_EXPIRED_PAIRING_CODE" });
    const station = listStationCredentials(db).find(item => item.station === body.data.station);
    if (!station) return reply.code(404).send({ error: "STATION_CREDENTIAL_NOT_FOUND" });
    appendAuditEvent(db, {
      eventType: "STATION_PAIRED",
      payload: { station: body.data.station },
      occurredAt: new Date().toISOString(),
    });
    return { station: station.station, token: station.token };
  });
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
      pairing.invalidate(station);
      // The previous socket has already authenticated; disconnect it so it
      // cannot submit answers after credential rotation.
      disconnectStation?.(station);
      return reply.header("cache-control", "no-store").send({ credential });
    },
  );

}
