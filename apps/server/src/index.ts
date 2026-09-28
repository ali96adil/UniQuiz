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

const app = Fastify({ logger: true });
const database = openDatabase(config.databasePath);

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

function normalizeRole(value: unknown): ClientRole {
  switch (value) {
    case "operator":
    case "display":
    case "team-a":
    case "team-b":
      return value;
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

app.get("/health", async () => ({
  ok: true,
  service: "uniquiz-server",
  timestamp: new Date().toISOString(),
}));

app.get("/api/presence", async () => presenceSnapshot());

registerCompetitionRoutes(app, database, io);
registerImportRoutes(app, database, io);
registerQuestionBankRoutes(app, database, io);
const liveSession = registerLiveSessionRoutes(app, database, io);

io.on("connection", (socket) => {
  const role = normalizeRole(socket.handshake.auth?.role);
  roles.set(socket.id, role);
  publishPresence();

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
  },
  "UniQuiz server ready",
);
