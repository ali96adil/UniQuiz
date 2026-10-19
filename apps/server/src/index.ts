import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { Server as SocketIOServer } from "socket.io";
import type { ClientRole, PresenceSnapshot } from "@uniquiz/shared";
import { registerCompetitionRoutes, getCompetitionSnapshot } from "./competition.js";
import { config } from "./config.js";
import { registerOperatorAuth } from "./operator-auth.js";
import { openDatabase } from "./database.js";
import {
  getQuestionBankSummary,
  registerImportRoutes,
} from "./importer.js";
import {
  getQuestionAllocationSummary,
  registerQuestionBankRoutes,
} from "./question-bank.js";
import { registerLiveSessionRoutes } from "./live-session.js";
import { getQualificationRanking } from "./ranking.js";
import {
  getAudienceDisplaySettings,
  registerAudienceSettingsRoutes,
} from "./audience-settings.js";
import { registerResetAllRoute } from "./reset-all.js";
import {
  getAudiencePresentation,
  registerAudiencePresentationRoutes,
} from "./presentation.js";
import { OscOutput } from "./osc-output.js";
import { registerOperationsRoutes } from "./operations.js";
import { registerResultsExportRoutes } from "./results-export.js";
import { registerCompetitionArchiveRoutes } from "./competition-archives.js";
import { registerCompetitionWorkspaceRoutes } from "./competition-workspaces.js";
import {
  ensureStationCredentials,
  registerStationAuthRoutes,
  validateStationToken,
} from "./station-auth.js";

// Fail closed BEFORE an M7 database migration or runtime network bind.
if (!config.operatorPassphrase) {
  throw new Error("UNIQUIZ_OPERATOR_PASSPHRASE is required (min 12 characters). Set it in the server environment before starting UniQuiz.");
}
const app = Fastify({ logger: true });
const auth = registerOperatorAuth(app, config.operatorPassphrase);
const database = openDatabase(config.databasePath);
ensureStationCredentials(database);

await app.register(multipart, {
  limits: {
    files: 1,
    fields: 4,
    parts: 5,
    fileSize: 20 * 1024 * 1024,
  },
});

const io = new SocketIOServer(app.server, {
  cors: {
    origin: true,
    credentials: false,
  },
});

const roles = new Map<string, ClientRole>();

// Revocation must immediately disconnect an already-authenticated operator;
// checking cookies only during the initial handshake is not sufficient.
auth.onRevoked((sessionId) => {
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.operatorSessionId === sessionId) {
      socket.disconnect(true);
    }
  }
});

// The team bearer token is NOT sufficient to act as operator; the operator
// authenticates through the same HttpOnly session used for HTTP mutations.
io.use((socket, next) => {
  const requested = socket.handshake.auth?.role;
  if (requested === "operator") {
    const session = auth.sessionDetails(socket.handshake.headers.cookie);
    if (!session) return next(new Error("OPERATOR_AUTH_REQUIRED"));
    socket.data.operatorSessionId = session.id;
    socket.data.operatorSessionExpiresAt = session.expiresAt;
    return next();
  }
  if (requested === "team-a" || requested === "team-b") {
    const station = requested === "team-a" ? "A" : "B";
    const credential = socket.handshake.auth?.token;
    if (!validateStationToken(database, station, credential))
      return next(new Error("STATION_AUTH_REQUIRED"));
    // Signed station sessions expire while connected, not just at handshake.
    if (typeof credential === "string" && credential.startsWith("uqs1.")) {
      socket.data.stationSessionExpiresAt = Number(credential.split(".")[2]);
    }
    return next();
  }
  if (requested === "display") return next();
  return next(new Error("UNKNOWN_CLIENT_ROLE"));
});

function normalizeRole(
  value: unknown,
  token: unknown,
): ClientRole {
  switch (value) {
    case "operator":
    case "display":
      return value;
    case "team-a":
      return validateStationToken(database, "A", token)
        ? "team-a"
        : "unknown";
    case "team-b":
      return validateStationToken(database, "B", token)
        ? "team-b"
        : "unknown";
    default:
      return "unknown";
  }
}

function presenceSnapshot(): PresenceSnapshot {
  const counts = new Map<ClientRole, number>();

  for (const role of roles.values()) {
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }

  const visibleRoles: ClientRole[] = [
    "operator",
    "display",
    "team-a",
    "team-b",
  ];

  return {
    generatedAt: new Date().toISOString(),
    stations: visibleRoles.map((role) => ({
      role,
      connected: (counts.get(role) ?? 0) > 0,
      connections: counts.get(role) ?? 0,
    })),
  };
}

function publishPresence() {
  io.emit("presence:snapshot", presenceSnapshot());
}

app.get("/api/ranking", async () =>
  getQualificationRanking(database),
);

app.get("/health", async () => ({
  ok: true,
  service: "uniquiz-server",
  mode: config.mode,
  timestamp: new Date().toISOString(),
}));

app.get("/api/presence", async () => presenceSnapshot());

const oscOutput = new OscOutput(
  config.osc,
  (error) => {
    app.log.warn(
      {
        err: error,
        host: config.osc.host,
        port: config.osc.port,
      },
      "OSC show-control delivery failed",
    );
  },
);

registerCompetitionRoutes(app, database, io, oscOutput);
registerImportRoutes(app, database, io);
registerStationAuthRoutes(app, database);
registerAudienceSettingsRoutes(app, database, io);
registerAudiencePresentationRoutes(app, database, io);

const liveSession = registerLiveSessionRoutes(
  app,
  database,
  io,
  oscOutput,
  (role) =>
    [...roles.values()].some(
      (connectedRole) => connectedRole === role,
    ),
);

registerQuestionBankRoutes(
  app,
  database,
  io,
  (roundId, position) => {
    liveSession.onQuestionReplaced(roundId, position);
  },
);

registerResetAllRoute(
  app,
  database,
  io,
  liveSession,
  config.databasePath,
);

registerOperationsRoutes(app, database, {
  mode: config.mode,
  databasePath: config.databasePath,
  serverPort: config.port,
  webPort: 5173,
  osc: config.osc,
  getPresence: presenceSnapshot,
  sendOscTest: () => {
    oscOutput.send(
      "/uniquiz/system/test",
      [new Date().toISOString()],
    );
  },
});

registerResultsExportRoutes(app, database);
registerCompetitionArchiveRoutes(app, database);
registerCompetitionWorkspaceRoutes(app, database, io, liveSession, config.databasePath);

io.on("connection", (socket) => {
  const role = normalizeRole(
    socket.handshake.auth?.role,
    socket.handshake.auth?.token,
  );
  roles.set(socket.id, role);

  if (role === "operator") {
    // An open WebSocket must not outlive its HttpOnly cookie session.
    const expiresAt = Number(socket.data.operatorSessionExpiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      socket.disconnect(true);
      return;
    }
    const expiration = setTimeout(() => socket.disconnect(true), expiresAt - Date.now());
    expiration.unref();
    socket.on("disconnect", () => clearTimeout(expiration));
  }

  if (role === "team-a" || role === "team-b") {
    const expiresAt = socket.data.stationSessionExpiresAt;
    if (expiresAt !== undefined) {
      const remainingMs = Number(expiresAt) - Date.now();
      if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
        socket.disconnect(true);
        return;
      }
      const expiryTimer = setTimeout(() => socket.disconnect(true), remainingMs);
      expiryTimer.unref();
      socket.on("disconnect", () => clearTimeout(expiryTimer));
    }
    void socket.join(role);
  }

  publishPresence();
  // Only a newly connected answer station changes live station readiness.
  // Other joins should not force an extra global cue/UI refresh.
  if (role === "team-a" || role === "team-b") {
    io.emit("live:snapshot", liveSession.getSnapshot());
  }

  socket.emit("server:hello", {
    socketId: socket.id,
    role,
    mode: config.mode,
    serverTime: new Date().toISOString(),
  });

  socket.emit(
    "competition:snapshot",
    getCompetitionSnapshot(database),
  );

  socket.emit(
    "question-bank:snapshot",
    getQuestionBankSummary(database),
  );

  socket.emit(
    "question-allocation:snapshot",
    getQuestionAllocationSummary(database),
  );

  socket.emit(
    "live:snapshot",
    liveSession.getSnapshot(),
  );

  socket.emit(
    "ranking:snapshot",
    getQualificationRanking(database),
  );

  socket.emit(
    "audience:settings",
    getAudienceDisplaySettings(database),
  );

  socket.emit(
    "audience:presentation",
    getAudiencePresentation(database),
  );

  const teamState = liveSession.getTeamSubmissionState(role);
  if (teamState) {
    socket.emit("live:team-submission", teamState);
  }

  socket.on(
    "team:submit-answer",
    (
      payload: { option?: unknown },
      acknowledge?: (result: unknown) => void,
    ) => {
      try {
        const option =
          payload?.option === "A" ||
          payload?.option === "B" ||
          payload?.option === "C" ||
          payload?.option === "D"
            ? payload.option
            : null;

        if (!option) {
          throw new Error("INVALID_ANSWER_OPTION");
        }

        const receipt = liveSession.submitAnswer(role, option);
        acknowledge?.({ ok: true, receipt });

        const latestTeamState =
          liveSession.getTeamSubmissionState(role);
        if (latestTeamState) {
          socket.emit(
            "live:team-submission",
            latestTeamState,
          );
        }
      } catch (error) {
        acknowledge?.({
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "ANSWER_SUBMISSION_FAILED",
        });
      }
    },
  );

  socket.on("disconnect", () => {
    roles.delete(socket.id);
    publishPresence();
    io.emit("live:snapshot", liveSession.getSnapshot());
  });
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down UniQuiz");
  liveSession.dispose();
  io.close();
  database.close();
  await app.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({
  host: config.host,
  port: config.port,
});

app.log.info(
  {
    host: config.host,
    port: config.port,
    mode: config.mode,
    databasePath: config.databasePath,
    oscEnabled: config.osc.enabled,
    oscHost: config.osc.host,
    oscPort: config.osc.port,
  },
  "UniQuiz server ready",
);
