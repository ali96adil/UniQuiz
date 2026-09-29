import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { Server as SocketIOServer } from "socket.io";
import type { ClientRole, PresenceSnapshot } from "@uniquiz/shared";
import { registerCompetitionRoutes, getCompetitionSnapshot } from "./competition.js";
import { config } from "./config.js";
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
import { OscOutput } from "./osc-output.js";
import { registerOperationsRoutes } from "./operations.js";
import {
  ensureStationCredentials,
  registerStationAuthRoutes,
  validateStationToken,
} from "./station-auth.js";

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

const roles = new Map<string, ClientRole>();

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
  timestamp: new Date().toISOString(),
}));

app.get("/api/presence", async () => presenceSnapshot());

registerCompetitionRoutes(app, database, io);
registerImportRoutes(app, database, io);
registerStationAuthRoutes(app, database);
registerAudienceSettingsRoutes(app, database, io);

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
);

registerOperationsRoutes(app, database, {
  databasePath: config.databasePath,
  osc: config.osc,
  getPresence: presenceSnapshot,
});

io.on("connection", (socket) => {
  const role = normalizeRole(
    socket.handshake.auth?.role,
    socket.handshake.auth?.token,
  );
  roles.set(socket.id, role);

  if (role === "team-a" || role === "team-b") {
    void socket.join(role);
  }

  publishPresence();
  io.emit("live:snapshot", liveSession.getSnapshot());

  socket.emit("server:hello", {
    socketId: socket.id,
    role,
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
    databasePath: config.databasePath,
    oscEnabled: config.osc.enabled,
    oscHost: config.osc.host,
    oscPort: config.osc.port,
  },
  "UniQuiz server ready",
);
