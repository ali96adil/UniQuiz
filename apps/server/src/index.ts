import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { Server as SocketIOServer } from "socket.io";
import type { ClientRole, PresenceSnapshot } from "@uniquiz/shared";
import { registerCompetitionRoutes, getCompetitionSnapshot } from "./competition.js";
import { config } from "./config.js";
import { createOperatorAuth } from "./operator-auth.js";
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
import { registerCompetitionWorkspaceRoutes, listCompetitionWorkspaces } from "./competition-workspaces.js";
import {
  ensureStationCredentials,
  registerStationAuthRoutes,
  validateStationToken,
} from "./station-auth.js";

// Fail closed if the local Mac has not been provisioned with an operator secret.
// Never generate a known/default password or silently expose admin APIs.
if (!config.operatorPassword) throw new Error("UNIQUIZ_OPERATOR_PASSWORD_REQUIRED");
const operatorAuth = createOperatorAuth(config.operatorPassword);
const app = Fastify({ logger: true });
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

// One authenticated HttpOnly cookie covers operator API and operator Socket.IO.
// Station tokens are scoped to answer stations; display remains read-only.
operatorAuth.register(app, (revokedToken) => {
  for (const socket of io.sockets.sockets.values()) {
    if (operatorAuth.tokenFromCookie(socket.handshake.headers.cookie) === revokedToken) {
      socket.disconnect(true);
    }
  }
});

const roles = new Map<string, ClientRole>();

function normalizeRole(
  value: unknown,
  token: unknown,
  cookie: string | undefined,
): ClientRole {
  switch (value) {
    case "operator":
      return operatorAuth.isAuthorized(cookie) ? "operator" : "unknown";
    case "display":
      return "display";
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
registerStationAuthRoutes(app, database, (station) => {
  const role = station === "A" ? "team-a" : "team-b";
  for (const socket of io.sockets.sockets.values()) {
    if (roles.get(socket.id) === role) socket.disconnect(true);
  }
});
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
    socket.handshake.headers.cookie,
  );
  roles.set(socket.id, role);

  // An established operator socket cannot outlive the HttpOnly session that
  // authorized its role. Logout separately disconnects it immediately.
  const operatorExpiresAt = role === "operator"
    ? operatorAuth.expiresAt(socket.handshake.headers.cookie)
    : null;
  const operatorExpiryTimer = operatorExpiresAt === null ? null : setTimeout(() => {
    socket.disconnect(true);
  }, Math.max(1, operatorExpiresAt - Date.now()));
  if (operatorExpiryTimer) {
    socket.once("disconnect", () => clearTimeout(operatorExpiryTimer));
  }

  if (role === "team-a" || role === "team-b") {
    void socket.join(role);
  }

  publishPresence();
  io.emit("live:snapshot", liveSession.getSnapshot());

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

  // A reconnecting operator may have missed an activation while offline.
  // Send the current workspace ID after the new competition snapshots so
  // React can remount its per-workspace editors with up-to-date state.
  socket.emit("competition:workspaces", listCompetitionWorkspaces(database));

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

        // Revalidate the credential on each answer, not only on handshake:
        // revoked station tokens must never submit from an old socket.
        if ((role === "team-a" || role === "team-b") &&
            !validateStationToken(database, role === "team-a" ? "A" : "B", socket.handshake.auth?.token)) {
          socket.disconnect(true);
          throw new Error("STATION_CREDENTIAL_REVOKED");
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
