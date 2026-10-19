import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

const SESSION_COOKIE = "uniquiz_operator";
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;
const MAX_FAILURES = 8;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;

const loginSchema = z.object({
  passphrase: z.string().min(1).max(1024),
}).strict();

interface Session {
  expiresAt: number;
}
interface FailureState {
  failures: number;
  until: number;
}

function extractSession(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const piece of cookieHeader.split(";")) {
    const [name, ...parts] = piece.trim().split("=");
    if (name === SESSION_COOKIE) {
      const value = parts.join("=");
      return /^[a-f0-9]{64}$/.test(value) ? value : null;
    }
  }
  return null;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashPassphrase(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32);
}

function cookie(token: string, secure: boolean, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function registerOperatorAuth(
  app: FastifyInstance,
  passphrase: string,
) {
  if (passphrase.length < 12) {
    throw new Error("UNIQUIZ_OPERATOR_PASSPHRASE must be at least 12 characters.");
  }

  const salt = randomBytes(32);
  const reference = hashPassphrase(passphrase, salt);
  const sessions = new Map<string, Session>();
  const failures = new Map<string, FailureState>();
  const authenticated = (header: string | undefined): boolean => {
    const token = extractSession(header);
    if (!token) return false;
    const key = hashToken(token);
    const session = sessions.get(key);
    if (!session) return false;
    if (session.expiresAt <= Date.now()) {
      sessions.delete(key);
      return false;
    }
    return true;
  };

  const publicApi = (method: string, url: string): boolean => {
    const path = url.split("?")[0];
    if (path === "/api/auth/status" && method === "GET") return true;
    if (path === "/api/auth/login" && method === "POST") return true;
    if (path === "/api/auth/logout" && method === "POST") return true;
    // Audience displays and public ranking need read-only access.
    return method === "GET" && ["/api/live", "/api/ranking", "/api/presence"].includes(path);
  };

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/") || publicApi(request.method, request.url)) return;
    if (!authenticated(request.headers.cookie)) {
      return reply.code(401).send({ error: "OPERATOR_AUTH_REQUIRED" });
    }
    // For browser unsafe methods: do not allow cross-origin cookie replay.
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin) {
        try {
          const parsed = new URL(origin);
          if (parsed.host !== request.headers.host) {
            return reply.code(403).send({ error: "OPERATOR_ORIGIN_MISMATCH" });
          }
        } catch {
          return reply.code(403).send({ error: "OPERATOR_ORIGIN_MISMATCH" });
        }
      }
    }
  });

  app.get("/api/auth/status", async (request) => ({
    required: true,
    authenticated: authenticated(request.headers.cookie),
  }));

  app.post("/api/auth/login", async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_LOGIN_REQUEST" });
    const remote = request.ip;
    const prior = failures.get(remote);
    const now = Date.now();
    if (prior && prior.failures >= MAX_FAILURES && prior.until > now) {
      return reply.code(429).send({ error: "LOGIN_TEMPORARILY_LIMITED" });
    }
    const candidate = hashPassphrase(parsed.data.passphrase, salt);
    if (!timingSafeEqual(candidate, reference)) {
      const active = prior && prior.until > now ? prior.failures : 0;
      failures.set(remote, { failures: active + 1, until: now + FAILURE_WINDOW_MS });
      return reply.code(401).send({ error: "INVALID_OPERATOR_PASSPHRASE" });
    }
    failures.delete(remote);
    const token = randomBytes(32).toString("hex");
    sessions.set(hashToken(token), { expiresAt: now + SESSION_DURATION_MS });
    reply.header("Cache-Control", "no-store");
    reply.header("Set-Cookie", cookie(token, request.protocol === "https", SESSION_DURATION_MS / 1000));
    return { authenticated: true };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = extractSession(request.headers.cookie);
    if (token) sessions.delete(hashToken(token));
    reply.header("Cache-Control", "no-store");
    reply.header("Set-Cookie", cookie("", request.protocol === "https", 0));
    return { authenticated: false };
  });

  return {
    authenticated,
    clearSessions: () => sessions.clear(),
  };
}
