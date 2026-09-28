import {
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { FastifyInstance } from "fastify";
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

export function registerStationAuthRoutes(
  app: FastifyInstance,
  db: AppDatabase,
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
}
