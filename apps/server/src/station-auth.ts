import {
  createHash, createHmac, randomBytes, randomInt, timingSafeEqual,
} from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDatabase } from "./database.js";

export type TeamStation = "A" | "B";
export interface StationCredential {
  station: TeamStation;
  token: string;
}

// A short-lived eight-digit pairing code produces a separate, signed station
// session. Never put the reusable bearer token in a URL. The stable old
// station token remains valid for already-paired, pre-M7 installations.
export const PAIRING_CODE_TTL_MS = 5 * 60_000;
export const STATION_SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_PAIRING_ATTEMPTS = 6;
const MAX_IP_ATTEMPTS = 12;
const IP_WINDOW_MS = 10 * 60_000;

const stationSchema = z.enum(["A", "B"]);
const redeemSchema = z.object({
  station: stationSchema,
  code: z.string().regex(/^\d{8}$/),
}).strict();
const createSchema = z.object({
  station: stationSchema,
}).strict();

interface PendingCode {
  digest: Buffer;
  salt: Buffer;
  expiresAt: number;
  attempts: number;
}
interface RateLimit {
  attempts: number;
  expiresAt: number;
}

function newToken(): string {
  return randomBytes(24).toString("base64url");
}

function getStationSecret(db: AppDatabase, station: TeamStation): string | null {
  const row = db.prepare(`
    SELECT access_token AS token FROM station_credentials WHERE station = ?
  `).get(station) as { token: string } | undefined;
  return row?.token ?? null;
}

function fixedTimeEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function signStationSession(
  secret: string,
  station: TeamStation,
  expiresAt: number,
  nonce: string,
): string {
  return createHmac("sha256", secret)
    .update(`uniquiz-station-session:v1:${station}:${expiresAt}:${nonce}`)
    .digest("base64url");
}

function mintStationSession(
  db: AppDatabase,
  station: TeamStation,
  now: number,
): { token: string; expiresAt: number } {
  const secret = getStationSecret(db, station);
  if (!secret) throw new Error("STATION_CREDENTIAL_NOT_FOUND");
  const expiresAt = now + STATION_SESSION_TTL_MS;
  const nonce = randomBytes(18).toString("hex");
  const signature = signStationSession(secret, station, expiresAt, nonce);
  return {
    token: `uqs1.${station}.${expiresAt}.${nonce}.${signature}`,
    expiresAt,
  };
}

export function ensureStationCredentials(db: AppDatabase): void {
  const insert = db.prepare(`
    INSERT INTO station_credentials (
      station, access_token, created_at
    ) VALUES (?, ?, ?)
    ON CONFLICT(station) DO NOTHING
  `);
  const now = new Date().toISOString();
  insert.run("A", newToken(), now);
  insert.run("B", newToken(), now);
}

export function listStationCredentials(db: AppDatabase): StationCredential[] {
  return db.prepare(`
    SELECT station, access_token AS token
    FROM station_credentials ORDER BY station
  `).all() as StationCredential[];
}

export function validateStationToken(
  db: AppDatabase,
  station: TeamStation,
  candidate: unknown,
  now = Date.now(),
): boolean {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 512) {
    return false;
  }
  const secret = getStationSecret(db, station);
  if (!secret) return false;

  // Existing provisioned Windows stations keep working during rollout.
  if (fixedTimeEqual(Buffer.from(secret), Buffer.from(candidate))) return true;

  const parts = candidate.split(".");
  if (parts.length !== 5 || parts[0] !== "uqs1" || parts[1] !== station) return false;
  const [, , rawExpiry, nonce, signature] = parts;
  if (!rawExpiry || !/^\d{13}$/.test(rawExpiry) ||
      !nonce || !/^[a-f0-9]{36}$/.test(nonce) ||
      !signature || !/^[A-Za-z0-9_-]{43}$/.test(signature)) {
    return false;
  }
  const expiresAt = Number(rawExpiry);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now ||
      expiresAt > now + STATION_SESSION_TTL_MS) return false;
  const expected = signStationSession(secret, station, expiresAt, nonce);
  return fixedTimeEqual(Buffer.from(signature), Buffer.from(expected));
}

/**
 * No new SQLite schema is required: pending codes are transient, one-use and
 * intentionally disappear when the server restarts. Redeemed station sessions
 * are HMAC authenticated using the already-persistent station secret.
 */
export function createStationPairingManager(
  db: AppDatabase,
  now: () => number = Date.now,
) {
  const pending = new Map<TeamStation, PendingCode>();
  const attemptsByIp = new Map<string, RateLimit>();

  const issue = (station: TeamStation) => {
    const code = randomInt(0, 100_000_000).toString().padStart(8, "0");
    const salt = randomBytes(24);
    const expiresAt = now() + PAIRING_CODE_TTL_MS;
    pending.set(station, {
      digest: createHash("sha256").update(salt).update(code).digest(),
      salt,
      expiresAt,
      attempts: 0,
    });
    return { station, code, expiresAt };
  };

  const redeem = (station: TeamStation, code: string, ip: string) => {
    const currentTime = now();
    const bucket = attemptsByIp.get(ip);
    if (bucket && bucket.expiresAt > currentTime && bucket.attempts >= MAX_IP_ATTEMPTS) {
      return { ok: false as const, status: 429, error: "PAIRING_RATE_LIMITED" };
    }
    const active = pending.get(station);
    if (!active || active.expiresAt <= currentTime || active.attempts >= MAX_PAIRING_ATTEMPTS) {
      pending.delete(station);
      return { ok: false as const, status: 401, error: "PAIRING_INVALID_OR_EXPIRED" };
    }
    const proposed = createHash("sha256").update(active.salt).update(code).digest();
    if (!fixedTimeEqual(active.digest, proposed)) {
      active.attempts++;
      const count = bucket && bucket.expiresAt > currentTime ? bucket.attempts : 0;
      attemptsByIp.set(ip, { attempts: count + 1, expiresAt: currentTime + IP_WINDOW_MS });
      if (active.attempts >= MAX_PAIRING_ATTEMPTS) pending.delete(station);
      return { ok: false as const, status: 401, error: "PAIRING_INVALID_OR_EXPIRED" };
    }
    // Consume before issuing a session; concurrent/redelivered requests cannot
    // reuse this same pairing code.
    pending.delete(station);
    return {
      ok: true as const,
      station,
      ...mintStationSession(db, station, currentTime),
    };
  };
  return { issue, redeem };
}

export function registerStationAuthRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  pairing = createStationPairingManager(db),
): void {
  // Legacy credential endpoint remains operator-authenticated by the global
  // /api hook for recovery; the new station portal never requests it.
  app.get("/api/stations/credentials", async () => {
    const credentials = listStationCredentials(db);
    return {
      teamA: credentials.find((item) => item.station === "A") ?? null,
      teamB: credentials.find((item) => item.station === "B") ?? null,
    };
  });

  app.post("/api/stations/pairing/create", async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_PAIRING_STATION" });
    reply.header("Cache-Control", "no-store");
    return pairing.issue(parsed.data.station);
  });

  // This is the only unauthenticated station pairing route. Authentication
  // happens by proving possession of the short-lived operator-issued code.
  app.post("/api/stations/pairing/redeem", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const origin = request.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).host !== request.headers.host)
          return reply.code(403).send({ error: "PAIRING_ORIGIN_MISMATCH" });
      } catch {
        return reply.code(403).send({ error: "PAIRING_ORIGIN_MISMATCH" });
      }
    }
    const parsed = redeemSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_PAIRING_CODE" });
    const result = pairing.redeem(parsed.data.station, parsed.data.code, request.ip);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return { station: result.station, token: result.token, expiresAt: result.expiresAt };
  });
}
