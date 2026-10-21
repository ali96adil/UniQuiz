import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

const COOKIE = "uniquiz_operator";
const SESSION_MS = 8 * 60 * 60 * 1000;
const FAILED_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILED_LOGINS = 5;
const loginSchema = z.object({ password: z.string().min(1).max(1024) }).strict();

// Only public event metadata, audience/status information and the auth
// endpoints are readable without an operator session. Every other API route
// (including credential issuance and all POST/PUT/PATCH/DELETE) is protected.
const publicGetRoutes = new Set([
  "/api/auth/session", "/api/competitions", "/api/live",
  "/api/presence", "/api/ranking",
]);

function cookieValue(header: string | undefined): string | null {
  const part = header?.split(";").map((item) => item.trim())
    .find((item) => item.startsWith(COOKIE + "="));
  const token = part?.slice(COOKIE.length + 1) ?? "";
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function cookieHeader(token: string, https: boolean, maxAge: number): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${https ? "; Secure" : ""}`;
}

export function createOperatorAuth(password: string) {
  if (password.length < 16) throw new Error("OPERATOR_PASSWORD_TOO_SHORT");
  const salt = randomBytes(32);
  const expectedPassword = scryptSync(password, salt, 32);
  const sessions = new Map<string, number>();
  const failures = new Map<string, { count: number; resetAt: number }>();

  function prune(now: number) {
    for (const [key, expires] of sessions) {
      if (expires <= now) sessions.delete(key);
    }
    for (const [key, value] of failures) {
      if (value.resetAt <= now) failures.delete(key);
    }
  }

  function expiresAt(cookie: string | undefined): number | null {
    const token = cookieValue(cookie);
    if (!token) return null;
    const key = digest(token);
    const expires = sessions.get(key);
    if (expires === undefined) return null;
    if (expires <= Date.now()) {
      sessions.delete(key);
      return null;
    }
    return expires;
  }

  function isAuthorized(cookie: string | undefined): boolean {
    return expiresAt(cookie) !== null;
  }

  function register(app: FastifyInstance, onSessionRevoked?: (token: string) => void) {
    // Register before application routes. Do not trust a self-declared role,
    // reverse-proxy IP, or an answer-station token for admin authorization.
    app.addHook("onRequest", async (request, reply) => {
      if (request.method !== "GET" && request.method !== "HEAD" &&
          request.method !== "OPTIONS") {
        const origin = request.headers.origin;
        const host = request.headers.host;
        // SameSite protects cross-site cookies; Origin additionally blocks
        // malicious pages hosted on a sibling origin within the same site.
        // Vite's default proxy preserves the browser-facing Host header.
        if (request.headers["sec-fetch-site"] === "cross-site" ||
            (origin && (!host || (() => {
              try { return new URL(origin).host !== host; } catch { return true; }
            })()))) {
          return reply.code(403).send({ error: "CROSS_SITE_REQUEST_FORBIDDEN" });
        }
      }
      const path = request.url.split("?")[0];
      if (!path.startsWith("/api/")) return;
      if ((request.method === "GET" && publicGetRoutes.has(path)) ||
        (request.method === "POST" &&
          (path === "/api/auth/login" || path === "/api/auth/logout" ||
           path === "/api/stations/enroll"))) {
        return;
      }
      if (!isAuthorized(request.headers.cookie)) {
        return reply.code(401).send({ error: "OPERATOR_AUTH_REQUIRED" });
      }
      reply.header("cache-control", "no-store");
    });

    app.get("/api/auth/session", async (request) => ({
      authenticated: isAuthorized(request.headers.cookie),
    }));

    app.post("/api/auth/login", async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "INVALID_LOGIN_REQUEST" });
      const now = Date.now();
      prune(now);
      const ip = request.ip;
      const failed = failures.get(ip);
      if (failed && failed.count >= MAX_FAILED_LOGINS && failed.resetAt > now) {
        return reply.code(429).send({ error: "TOO_MANY_LOGIN_ATTEMPTS" });
      }
      const provided = scryptSync(parsed.data.password, salt, 32);
      if (!timingSafeEqual(provided, expectedPassword)) {
        const current = failures.get(ip);
        failures.set(ip, {
          count: (current && current.resetAt > now ? current.count : 0) + 1,
          resetAt: current && current.resetAt > now ? current.resetAt : now + FAILED_WINDOW_MS,
        });
        return reply.code(401).send({ error: "INVALID_OPERATOR_PASSWORD" });
      }
      failures.delete(ip);
      const token = randomBytes(32).toString("base64url");
      sessions.set(digest(token), now + SESSION_MS);
      reply.header("set-cookie", cookieHeader(token, request.protocol === "https", SESSION_MS / 1000));
      reply.header("cache-control", "no-store");
      return { authenticated: true };
    });

    app.post("/api/auth/logout", async (request, reply) => {
      const token = cookieValue(request.headers.cookie);
      if (token) {
        sessions.delete(digest(token));
        onSessionRevoked?.(token);
      }
      reply.header("set-cookie", cookieHeader("", request.protocol === "https", 0));
      reply.header("cache-control", "no-store");
      return { authenticated: false };
    });
  }

  return { register, isAuthorized, expiresAt, tokenFromCookie: cookieValue };
}

export type OperatorAuth = ReturnType<typeof createOperatorAuth>;
