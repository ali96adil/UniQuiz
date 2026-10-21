import type { FastifyInstance } from "fastify";
import type { Server as SocketIOServer } from "socket.io";
import { z } from "zod";
import type { AppDatabase } from "./database.js";
import { getQuestionBankSummary } from "./importer.js";

const categorySchema = z.object({
  key: z.string().trim().regex(/^[a-zA-Z][a-zA-Z0-9_-]{1,99}$/),
  name: z.string().trim().min(1).max(120),
  displayName: z.string().trim().min(1).max(120),
}).strict();
const questionSchema = z.object({
  categoryKey: z.string().trim().min(1).max(100),
  prompt: z.string().trim().min(3).max(2000),
  optionA: z.string().trim().min(1).max(500),
  optionB: z.string().trim().min(1).max(500),
  optionC: z.string().trim().min(1).max(500),
  optionD: z.string().trim().min(1).max(500),
  correctOption: z.enum(["A", "B", "C", "D"]),
  difficulty: z.number().int().min(1).max(5),
  sourceRef: z.string().trim().max(250).nullable().optional(),
}).strict().refine((q) =>
  new Set([q.optionA, q.optionB, q.optionC, q.optionD].map((v) => v.trim().toLocaleLowerCase())).size === 4,
  { message: "ANSWER_OPTIONS_MUST_BE_DISTINCT" },
);
const itemQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  categoryKey: z.string().trim().max(100).optional(),
  difficulty: z.coerce.number().int().min(1).max(5).optional(),
  status: z.enum(["active", "inactive", "all"]).default("active"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

interface QuestionInput {
  categoryKey: string;
  prompt: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  correctOption: "A" | "B" | "C" | "D";
  difficulty: number;
  sourceRef?: string | null;
}
type SqlParams = Array<string | number | null>;

function readId(raw: string): number | null {
  const n = Number(raw);
  return /^[1-9][0-9]*$/.test(raw) && Number.isSafeInteger(n) ? n : null;
}
function hasProtectedReferences(db: AppDatabase, id: number): boolean {
  for (const table of ["qualification_round_questions", "qualification_question_reservations", "live_submissions"] as const) {
    const row = db.prepare("SELECT 1 FROM " + table + " WHERE question_id = ? LIMIT 1").get(id);
    if (row) return true;
  }
  // Old archived questions are frozen in archive snapshots. However, a source
  // question is still considered historically used even if its live allocation
  // was later reset and only an archive retained it.
  const archives = db.prepare("SELECT payload_json AS payload FROM competition_archives").all() as Array<{ payload: string }>;
  for (const archive of archives) {
    try {
      const parsed = JSON.parse(archive.payload) as Record<string, unknown>;
      const allocations = JSON.stringify(parsed.qualification_round_questions ?? parsed);
      if (new RegExp('"question_id"\\s*:\\s*' + id + '(?![0-9])').test(allocations)) return true;
    } catch {
      // Broken archives must not authorize historical question rewrites.
      return true;
    }
  }
  return false;
}

function editAllowed(db: AppDatabase): boolean {
  const phase = db.prepare("SELECT phase FROM live_state WHERE id=1").get() as { phase: string } | undefined;
  return phase?.phase === "IDLE" || phase?.phase === "ROUND_COMPLETE";
}

function categoryId(db: AppDatabase, key: string): number | null {
  const row = db.prepare("SELECT id FROM categories WHERE category_key=?").get(key) as { id: number } | undefined;
  return row?.id ?? null;
}
function duplicatePrompt(db: AppDatabase, prompt: string, exceptId = -1): boolean {
  return Boolean(db.prepare("SELECT 1 FROM questions WHERE lower(trim(prompt))=lower(trim(?)) AND id<>? AND active=1 LIMIT 1").get(prompt, exceptId));
}
function writeQuestion(db: AppDatabase, id: number | null, input: QuestionInput): number {
  const category = categoryId(db, input.categoryKey);
  if (!category) throw new Error("CATEGORY_NOT_FOUND");
  if (duplicatePrompt(db, input.prompt, id ?? -1)) throw new Error("DUPLICATE_QUESTION");
  const values: SqlParams = [
    category, input.prompt, input.optionA, input.optionB,
    input.optionC, input.optionD, input.correctOption, input.difficulty, input.sourceRef || null,
  ];
  if (id === null) {
    const result = db.prepare("INSERT INTO questions (category_id,prompt,option_a,option_b,option_c,option_d,correct_option,difficulty,source_ref) VALUES (?,?,?,?,?,?,?,?,?)").run(...values);
    return Number(result.lastInsertRowid);
  }
  db.prepare("UPDATE questions SET category_id=?,prompt=?,option_a=?,option_b=?,option_c=?,option_d=?,correct_option=?,difficulty=?,source_ref=? WHERE id=?").run(...values, id);
  return id;
}

export function registerQuestionEditorRoutes(app: FastifyInstance, db: AppDatabase, io: SocketIOServer): void {
  const publish = () => io.emit("question-bank:snapshot", getQuestionBankSummary(db));
  app.get("/api/question-bank/items", async (request, reply) => {
    const parsed = itemQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_FILTER" });
    const q = parsed.data;
    const where = ["1=1"];
    const values: SqlParams = [];
    if (q.status !== "all") { where.push("q.active=?"); values.push(q.status === "active" ? 1 : 0); }
    if (q.categoryKey) { where.push("c.category_key=?"); values.push(q.categoryKey); }
    if (q.difficulty) { where.push("q.difficulty=?"); values.push(q.difficulty); }
    if (q.search) { where.push("(q.prompt LIKE ? OR q.source_ref LIKE ?)"); values.push("%" + q.search + "%", "%" + q.search + "%"); }
    const filter = where.join(" AND ");
    const count = db.prepare("SELECT COUNT(*) AS count FROM questions q JOIN categories c ON c.id=q.category_id WHERE " + filter)
      .get(...values) as { count: number };
    const items = db.prepare(
      "SELECT q.id,c.category_key AS categoryKey,q.prompt,q.option_a AS optionA,q.option_b AS optionB,q.option_c AS optionC,q.option_d AS optionD,q.correct_option AS correctOption,q.difficulty,q.source_ref AS sourceRef,q.active,q.created_at AS createdAt FROM questions q JOIN categories c ON c.id=q.category_id WHERE " + filter + " ORDER BY q.id DESC LIMIT ? OFFSET ?"
    ).all(...values, q.pageSize, (q.page - 1) * q.pageSize);
    return { items, total: count.count, page: q.page, pageSize: q.pageSize };
  });

  app.post("/api/question-bank/items", async (request, reply) => {
    const parsed = questionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_QUESTION", issues: parsed.error.issues });
    if (!editAllowed(db)) return reply.code(409).send({ error: "LIVE_SESSION_ACTIVE" });
    try {
      const id = db.transaction(() => writeQuestion(db, null, parsed.data))();
      publish();
      return reply.code(201).send({ ok: true, id });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "QUESTION_SAVE_FAILED" });
    }
  });

  app.put<{ Params: { id: string } }>("/api/question-bank/items/:id", async (request, reply) => {
    const id = readId(request.params.id);
    const parsed = questionSchema.safeParse(request.body);
    if (id === null || !parsed.success) return reply.code(400).send({ error: "INVALID_QUESTION" });
    if (!editAllowed(db)) return reply.code(409).send({ error: "LIVE_SESSION_ACTIVE" });
    const existing = db.prepare("SELECT 1 FROM questions WHERE id=?").get(id);
    if (!existing) return reply.code(404).send({ error: "QUESTION_NOT_FOUND" });
    if (hasProtectedReferences(db, id)) return reply.code(409).send({ error: "QUESTION_HISTORICALLY_USED", message: "انسخ السؤال وعدّل النسخة الجديدة بدلاً من تغيير سؤال سبق استخدامه." });
    try {
      db.transaction(() => writeQuestion(db, id, parsed.data))();
      publish();
      return { ok: true, id };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "QUESTION_SAVE_FAILED" });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/question-bank/items/:id", async (request, reply) => {
    const id = readId(request.params.id);
    if (id === null) return reply.code(400).send({ error: "INVALID_QUESTION_ID" });
    if (!editAllowed(db)) return reply.code(409).send({ error: "LIVE_SESSION_ACTIVE" });
    if (hasProtectedReferences(db, id)) return reply.code(409).send({ error: "QUESTION_HISTORICALLY_USED" });
    const result = db.prepare("UPDATE questions SET active=0 WHERE id=? AND active=1").run(id);
    if (result.changes === 0) return reply.code(404).send({ error: "ACTIVE_QUESTION_NOT_FOUND" });
    publish();
    return { ok: true };
  });

  app.patch<{ Params: { id: string } }>("/api/question-bank/items/:id/restore", async (request, reply) => {
    const id = readId(request.params.id);
    if (id === null) return reply.code(400).send({ error: "INVALID_QUESTION_ID" });
    if (!editAllowed(db)) return reply.code(409).send({ error: "LIVE_SESSION_ACTIVE" });
    const item = db.prepare("SELECT prompt FROM questions WHERE id=? AND active=0").get(id) as { prompt: string } | undefined;
    if (!item) return reply.code(404).send({ error: "INACTIVE_QUESTION_NOT_FOUND" });
    if (duplicatePrompt(db, item.prompt, id)) return reply.code(409).send({ error: "DUPLICATE_QUESTION" });
    db.prepare("UPDATE questions SET active=1 WHERE id=?").run(id);
    publish();
    return { ok: true };
  });

  app.post("/api/question-bank/categories", async (request, reply) => {
    const parsed = categorySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_CATEGORY", issues: parsed.error.issues });
    if (!editAllowed(db)) return reply.code(409).send({ error: "LIVE_SESSION_ACTIVE" });
    const data = parsed.data;
    try {
      db.prepare("INSERT INTO categories(category_key,name,display_name,sort_order) VALUES (?,?,?,(SELECT COALESCE(MAX(sort_order),0)+1 FROM categories))").run(data.key,data.name,data.displayName);
      publish();
      return reply.code(201).send({ ok:true, key:data.key });
    } catch {
      return reply.code(409).send({ error: "DUPLICATE_CATEGORY" });
    }
  });

  app.put<{ Params: { key: string } }>("/api/question-bank/categories/:key", async (request, reply) => {
    const parsed = categorySchema.omit({ key:true }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_CATEGORY" });
    if (!editAllowed(db)) return reply.code(409).send({ error: "LIVE_SESSION_ACTIVE" });
    try {
      const result = db.prepare("UPDATE categories SET name=?,display_name=? WHERE category_key=?").run(parsed.data.name,parsed.data.displayName,request.params.key);
      if (result.changes === 0) return reply.code(404).send({ error: "CATEGORY_NOT_FOUND" });
      publish();
      return { ok:true };
    } catch {
      return reply.code(409).send({ error: "DUPLICATE_CATEGORY_NAME" });
    }
  });
}
