import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Server as SocketIOServer } from "socket.io";
import { z } from "zod";
import type { AppDatabase } from "./database.js";
import type { LiveSessionManager } from "./live-session.js";
import { getCompetitionSnapshot } from "./competition.js";
import { getQuestionAllocationSummary } from "./question-bank.js";
import { getQuestionBankSummary } from "./importer.js";
import { getAudienceDisplaySettings, DEFAULT_AUDIENCE_COPY } from "./audience-settings.js";
import { getAudiencePresentation } from "./presentation.js";
import { createDatabaseBackup } from "./operations.js";

export type ParticipantType = "college" | "department" | "class" | "team";
export interface Workspace {
  id: string;
  name: string;
  participantType: ParticipantType;
  createdAt: string;
  updatedAt: string;
  active: boolean;
}

const inputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  participantType: z.enum(["college", "department", "class", "team"]).default("college"),
});
const patchSchema = inputSchema.partial().refine((value) => Object.keys(value).length > 0);

// These are the only event-scoped data tables. All questions and categories
// remain in the central library, shared across workspaces.
const eventTables = [
  "colleges",
  "participants",
  "qualification_rounds",
  "qualification_round_rules",
  "qualification_round_question_sets",
  "qualification_round_questions",
  "qualification_question_reservations",
  "audit_events",
  "live_submissions",
  "competition_state",
  "competition_rules",
  "live_state",
  "audience_settings",
  "audience_copy",
  "audience_assets",
  "audience_presentation",
] as const;

type EventTable = typeof eventTables[number];
type StoredValue = string | number | null | { __blob: string };
type StoredRow = Record<string, StoredValue>;
type StoredSnapshot = Record<EventTable, StoredRow[]>;

function encodeRow(row: Record<string, unknown>): StoredRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key, Buffer.isBuffer(value) ? { __blob: value.toString("base64") } : value,
  ])) as StoredRow;
}

function decodeRow(row: StoredRow): Record<string, string | number | null | Buffer> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    value !== null && typeof value === "object" && "__blob" in value
      ? Buffer.from(value.__blob, "base64")
      : value,
  ]));
}

function snapshot(db: AppDatabase): StoredSnapshot {
  return Object.fromEntries(eventTables.map((table) => [
    table,
    (db.prepare("SELECT * FROM " + table).all() as Record<string, unknown>[]).map(encodeRow),
  ])) as StoredSnapshot;
}

function emptySnapshot(
  db: AppDatabase, title: string, participantType: ParticipantType,
): StoredSnapshot {
  const plural = ({
    college: "الكليات",
    department: "الأقسام",
    class: "الشعب",
    team: "الفرق",
  } as const)[participantType];
  const saved = snapshot(db);
  for (const table of eventTables) {
    saved[table] = [];
  }
  const now = new Date().toISOString();
  saved.competition_state = [{
    id: 1, participants_locked: 0, draw_created_at: null, selected_round_id: null,
  }];
  saved.competition_rules = [{ id: 1, distribution_json: null }];
  saved.live_state = [{
    id: 1, phase: "IDLE", round_id: null, question_position: null,
    stations_confirmed: 0, countdown_started_at_epoch_ms: null,
    question_started_at_epoch_ms: null, question_closed_at_epoch_ms: null,
    close_reason: null, updated_at: now,
  }];
  saved.audience_settings = [{
    id: 1, event_title: title, event_subtitle: "", venue: "", season: "",
    footer_text: "", round_label: "جولة", updated_at: now,
  }];
  saved.audience_copy = [{
    id: 1, value_json: JSON.stringify({
      ...DEFAULT_AUDIENCE_COPY,
      patronageLine: "",
      supervisionLine: "",
      waitingParticipantsText: `بانتظار تثبيت ${plural} المشاركة`,
      participatingCollegeCountText: `{count} من ${plural} المشاركة`,
    }), updated_at: now,
  }];
  saved.audience_presentation = [{
    id: 1, active: 0, kind: "PLEASE_WAIT",
    title: "يرجى الانتظار", message: "", updated_at: now,
  }];
  return saved;
}

function duplicateSetup(
  db: AppDatabase, title: string, participantType: ParticipantType, source: StoredSnapshot,
): StoredSnapshot {
  const target = emptySnapshot(db, title, participantType);
  target.colleges = source.colleges;
  target.participants = source.participants;
  target.competition_rules = source.competition_rules;
  target.audience_settings = source.audience_settings.map((row) => ({
    ...row, event_title: title, updated_at: new Date().toISOString(),
  }));
  target.audience_copy = source.audience_copy;
  target.audience_assets = source.audience_assets;
  return target;
}

function parseSnapshot(value: string): StoredSnapshot {
  const parsed = JSON.parse(value) as Partial<StoredSnapshot>;
  if (!parsed || typeof parsed !== "object" ||
      eventTables.some((table) => !Array.isArray(parsed[table]))) {
    throw new Error("WORKSPACE_SNAPSHOT_INVALID");
  }
  return parsed as StoredSnapshot;
}

function insertRows(db: AppDatabase, table: EventTable, rows: StoredRow[]) {
  for (const raw of rows) {
    const row = decodeRow(raw);
    const columns = Object.keys(row);
    if (columns.length === 0 || columns.some((col) => !/^[a-z_]+$/.test(col))) {
      throw new Error("WORKSPACE_ROW_SCHEMA_INVALID");
    }
    const sql = "INSERT INTO " + table +
      " (" + columns.join(", ") + ") VALUES (" + columns.map(() => "?").join(", ") + ")";
    db.prepare(sql).run(...columns.map((col) => row[col]));
  }
}

function restore(db: AppDatabase, saved: StoredSnapshot): void {
  const deleteOrder: EventTable[] = [
    "live_submissions", "audit_events", "qualification_question_reservations",
    "qualification_round_questions", "qualification_round_question_sets",
    "qualification_round_rules", "qualification_rounds", "participants", "colleges",
    "audience_assets", "audience_copy", "audience_presentation",
    "audience_settings", "competition_rules", "competition_state", "live_state",
  ];
  for (const table of deleteOrder) {
    db.prepare("DELETE FROM " + table).run();
  }
  // Parent/child order is intentional so foreign_keys stays ON.
  const insertOrder: EventTable[] = [
    "colleges", "participants", "qualification_rounds",
    "qualification_round_rules", "qualification_round_question_sets", "qualification_round_questions",
    "qualification_question_reservations", "audit_events", "live_submissions",
    "competition_state", "competition_rules", "live_state", "audience_settings",
    "audience_copy", "audience_assets", "audience_presentation",
  ];
  for (const table of insertOrder) insertRows(db, table, saved[table]);
  const violations = db.pragma("foreign_key_check") as unknown[];
  if (violations.length > 0) throw new Error("WORKSPACE_FOREIGN_KEY_VIOLATION");
}

export function activeWorkspaceId(db: AppDatabase): string {
  const value = db.prepare("SELECT value FROM app_meta WHERE key = 'active_workspace_id'")
    .get() as { value: string } | undefined;
  if (!value) throw new Error("WORKSPACE_NOT_INITIALIZED");
  return value.value;
}

export function listCompetitionWorkspaces(db: AppDatabase): Workspace[] {
  const active = activeWorkspaceId(db);
  const rows = db.prepare(`
    SELECT id, name, participant_type AS participantType,
      created_at AS createdAt, updated_at AS updatedAt
    FROM competition_workspaces
    ORDER BY created_at, id
  `).all() as Omit<Workspace, "active">[];
  return rows.map((row) => ({ ...row, active: row.id === active }));
}

export function createCompetitionWorkspace(
  db: AppDatabase,
  name: string,
  participantType: ParticipantType,
  copyFromId?: string,
): Workspace {
  const now = new Date().toISOString();
  const id = randomUUID();
  db.transaction(() => {
    let initial = emptySnapshot(db, name, participantType);
    if (copyFromId) {
      const source = db.prepare(
        "SELECT payload_json AS payload FROM competition_workspaces WHERE id=?",
      ).get(copyFromId) as { payload: string | null } | undefined;
      if (!source) throw new Error("WORKSPACE_NOT_FOUND");
      const payload = copyFromId === activeWorkspaceId(db)
        ? snapshot(db)
        : parseSnapshot(source.payload ?? "");
      initial = duplicateSetup(db, name, participantType, payload);
    }
    db.prepare(`
      INSERT INTO competition_workspaces (
        id, name, participant_type, payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, participantType, JSON.stringify(initial), now, now);
  })();
  return { id, name, participantType, createdAt: now, updatedAt: now, active: false };
}

function switchingSafe(db: AppDatabase) {
  const state = db.prepare("SELECT phase FROM live_state WHERE id = 1")
    .get() as { phase: string };
  const activeRounds = (db.prepare(
    "SELECT COUNT(*) AS count FROM qualification_rounds WHERE status='ACTIVE'",
  ).get() as { count: number }).count;
  if (!["IDLE", "ROUND_COMPLETE"].includes(state.phase) || activeRounds > 0) {
    throw new Error("WORKSPACE_SWITCH_BLOCKED_BY_LIVE_SESSION");
  }
}

export function activateCompetitionWorkspace(db: AppDatabase, id: string): Workspace {
  const current = activeWorkspaceId(db);
  const selected = listCompetitionWorkspaces(db).find((item) => item.id === id);
  if (!selected) throw new Error("WORKSPACE_NOT_FOUND");
  if (current === id) return selected;

  db.transaction(() => {
    switchingSafe(db);
    const to = db.prepare(
      "SELECT payload_json AS payload FROM competition_workspaces WHERE id=?",
    ).get(id) as { payload: string | null } | undefined;
    if (!to?.payload) throw new Error("WORKSPACE_SNAPSHOT_MISSING");
    const next = parseSnapshot(to.payload);

    const phase = next.live_state[0]?.phase;
    const hasActiveRound = next.qualification_rounds.some((row) => row.status === "ACTIVE");
    if (!["IDLE", "ROUND_COMPLETE"].includes(String(phase)) || hasActiveRound) {
      throw new Error("WORKSPACE_TARGET_HAS_UNFINISHED_LIVE_SESSION");
    }

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE competition_workspaces
      SET payload_json = ?, updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(snapshot(db)), now, current);

    restore(db, next);
    db.prepare("UPDATE app_meta SET value = ? WHERE key = 'active_workspace_id'").run(id);
    db.prepare("UPDATE competition_workspaces SET updated_at=? WHERE id=?")
      .run(now, id);
  })();

  return { ...selected, active: true };
}

export function renameCompetitionWorkspace(
  db: AppDatabase, id: string, name?: string, participantType?: ParticipantType,
): Workspace {
  db.transaction(() => {
    const current = db.prepare(
      "SELECT name, participant_type AS participantType, payload_json AS payload FROM competition_workspaces WHERE id=?",
    ).get(id) as { name: string; participantType: ParticipantType; payload: string | null } | undefined;
    if (!current) throw new Error("WORKSPACE_NOT_FOUND");
    db.prepare(`
      UPDATE competition_workspaces
      SET name=?, participant_type=?, updated_at=?
      WHERE id=?
    `).run(name ?? current.name, participantType ?? current.participantType, new Date().toISOString(), id);
    // Rename a workspace's metadata only; the separately editable public
    // event title is deliberately not overwritten by this administrative name.
  })();
  return listCompetitionWorkspaces(db).find((item) => item.id === id)!;
}

export function registerCompetitionWorkspaceRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  io: SocketIOServer,
  liveSession: LiveSessionManager,
  databasePath: string,
): void {
  const publish = () => {
    const state = listCompetitionWorkspaces(db);
    io.emit("competition:workspaces", state);
    return state;
  };

  app.get("/api/competitions", async () => ({
    competitions: listCompetitionWorkspaces(db),
    activeId: activeWorkspaceId(db),
  }));

  app.post("/api/competitions", async (request, reply) => {
    const body = inputSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "INVALID_COMPETITION", issues: body.error.issues });
    const created = createCompetitionWorkspace(db, body.data.name, body.data.participantType);
    publish();
    return reply.code(201).send({ competition: created });
  });

  app.post<{ Params: { id: string } }>("/api/competitions/:id/duplicate", async (request, reply) => {
    const body = inputSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "INVALID_COMPETITION", issues: body.error.issues });
    try {
      const created = createCompetitionWorkspace(
        db, body.data.name, body.data.participantType, request.params.id,
      );
      publish();
      return reply.code(201).send({ competition: created });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "WORKSPACE_ERROR" });
    }
  });

  app.patch<{ Params: { id: string } }>("/api/competitions/:id", async (request, reply) => {
    const body = patchSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "INVALID_COMPETITION", issues: body.error.issues });
    try {
      const competition = renameCompetitionWorkspace(
        db, request.params.id, body.data.name, body.data.participantType,
      );
      publish();
      return { competition };
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : "WORKSPACE_ERROR" });
    }
  });

  app.post<{ Params: { id: string } }>("/api/competitions/:id/activate", async (request, reply) => {
    if (request.params.id === activeWorkspaceId(db)) {
      return { competition: listCompetitionWorkspaces(db).find((c) => c.active) };
    }

    try {
      switchingSafe(db);
    } catch {
      return reply.code(409).send({ error: "WORKSPACE_SWITCH_BLOCKED_BY_LIVE_SESSION" });
    }

    // Before replacing any live competition tables, persist a physical DB backup.
    try {
      createDatabaseBackup(db, databasePath, "pre-switch");
    } catch (error) {
      return reply.code(500).send({
        error: "PRE_WORKSPACE_BACKUP_FAILED",
        message: error instanceof Error ? error.message : "Backup failed.",
      });
    }

    try {
      const competition = activateCompetitionWorkspace(db, request.params.id);
      io.emit("competition:snapshot", getCompetitionSnapshot(db));
      io.emit("question-bank:snapshot", getQuestionBankSummary(db));
      io.emit("question-allocation:snapshot", getQuestionAllocationSummary(db));
      io.emit("audience:settings", getAudienceDisplaySettings(db));
      io.emit("audience:presentation", getAudiencePresentation(db));
      liveSession.publish();
      publish();
      return { competition };
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message : "WORKSPACE_SWITCH_FAILED",
      });
    }
  });
}
