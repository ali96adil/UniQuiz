import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Server as SocketIOServer } from "socket.io";
import ExcelJS from "exceljs";
import { parse as parseCsv } from "csv-parse/sync";
import { z } from "zod";
import type {
  BulkImportPreview,
  ImportDataKind,
  ImportIssue,
  QuestionBankSummary,
} from "@uniquiz/shared";
import { getCompetitionSnapshot } from "./competition.js";
import type { AppDatabase } from "./database.js";

interface RawRecord {
  [key: string]: string;
}

interface ImportedCollege {
  name: string;
  shortName: string | null;
  participating: boolean | null;
}

interface ImportedCategory {
  key: string;
  name: string;
}

interface ImportedQuestion {
  categoryKey: string;
  question: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  correctOption: "A" | "B" | "C" | "D";
  sourceRef: string | null;
}

interface ParsedImport {
  colleges: ImportedCollege[] | null;
  categories: ImportedCategory[] | null;
  questions: ImportedQuestion[] | null;
  issues: ImportIssue[];
}

interface StagedImport {
  createdAt: number;
  fileName: string;
  parsed: ParsedImport;
}

const applySchema = z.object({
  previewId: z.string().uuid(),
});

const previews = new Map<string, StagedImport>();
const PREVIEW_TTL_MS = 30 * 60 * 1000;

function cleanupExpiredPreviews() {
  const cutoff = Date.now() - PREVIEW_TTL_MS;
  for (const [id, preview] of previews.entries()) {
    if (preview.createdAt < cutoff) previews.delete(id);
  }
}

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeKey(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function issue(
  issues: ImportIssue[],
  level: "error" | "warning",
  sheet: string,
  row: number | null,
  message: string,
) {
  issues.push({ level, sheet, row, message });
}

function parseBoolean(
  value: string,
): boolean | null | "INVALID" {
  const normalized = value.trim().toLocaleLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "y", "نعم"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "لا"].includes(normalized)) return false;
  return "INVALID";
}

function validateColleges(
  records: RawRecord[],
  sheet: string,
  issues: ImportIssue[],
): ImportedCollege[] {
  const rows: ImportedCollege[] = [];
  const names = new Set<string>();

  if (records.length > 20) {
    issue(issues, "error", sheet, null, "A maximum of 20 colleges is allowed.");
  }

  records.forEach((record, index) => {
    const row = index + 2;
    const name = text(record.name);
    const shortName = text(record.short_name) || null;
    const participatingValue = parseBoolean(text(record.participating));

    if (!name) {
      issue(issues, "error", sheet, row, "College name is required.");
      return;
    }

    const normalized = normalizeKey(name);
    if (names.has(normalized)) {
      issue(issues, "error", sheet, row, `Duplicate college name: ${name}`);
    }
    names.add(normalized);

    if (participatingValue === "INVALID") {
      issue(
        issues,
        "error",
        sheet,
        row,
        "participating must be true/false, yes/no, 1/0, نعم/لا, or blank.",
      );
      return;
    }

    rows.push({
      name,
      shortName,
      participating: participatingValue,
    });
  });

  return rows;
}

function validateCategories(
  records: RawRecord[],
  sheet: string,
  issues: ImportIssue[],
): ImportedCategory[] {
  const rows: ImportedCategory[] = [];
  const keys = new Set<string>();
  const names = new Set<string>();

  if (records.length !== 5) {
    issue(
      issues,
      "error",
      sheet,
      null,
      "Official qualification requires exactly 5 categories.",
    );
  }

  records.forEach((record, index) => {
    const row = index + 2;
    const key = text(record.key);
    const name = text(record.name);

    if (!key || !name) {
      issue(issues, "error", sheet, row, "Both key and name are required.");
      return;
    }

    const normalizedKey = normalizeKey(key);
    const normalizedName = normalizeKey(name);

    if (keys.has(normalizedKey)) {
      issue(issues, "error", sheet, row, `Duplicate category key: ${key}`);
    }
    if (names.has(normalizedName)) {
      issue(issues, "error", sheet, row, `Duplicate category name: ${name}`);
    }

    keys.add(normalizedKey);
    names.add(normalizedName);
    rows.push({ key, name });
  });

  return rows;
}

function validateQuestions(
  records: RawRecord[],
  sheet: string,
  issues: ImportIssue[],
  allowedCategoryKeys: Set<string>,
): ImportedQuestion[] {
  const rows: ImportedQuestion[] = [];
  const prompts = new Set<string>();
  const sourceRefs = new Set<string>();

  if (records.some((record) => Object.hasOwn(record, "difficulty"))) {
    issue(
      issues,
      "error",
      sheet,
      null,
      "difficulty is not supported. All official questions have one level.",
    );
  }

  records.forEach((record, index) => {
    const row = index + 2;
    const categoryKey = text(record.category_key);
    const question = text(record.question);
    const optionA = text(record.option_a);
    const optionB = text(record.option_b);
    const optionC = text(record.option_c);
    const optionD = text(record.option_d);
    const correctOption = text(record.correct_option).toUpperCase();
    const sourceRef = text(record.source_ref) || null;

    if (
      !categoryKey ||
      !question ||
      !optionA ||
      !optionB ||
      !optionC ||
      !optionD
    ) {
      issue(
        issues,
        "error",
        sheet,
        row,
        "category_key, question and all four options are required.",
      );
      return;
    }

    if (!allowedCategoryKeys.has(normalizeKey(categoryKey))) {
      issue(
        issues,
        "error",
        sheet,
        row,
        `Unknown category_key: ${categoryKey}`,
      );
    }

    if (!["A", "B", "C", "D"].includes(correctOption)) {
      issue(
        issues,
        "error",
        sheet,
        row,
        "correct_option must be exactly A, B, C, or D.",
      );
      return;
    }

    const normalizedPrompt = normalizeKey(question);
    if (prompts.has(normalizedPrompt)) {
      issue(issues, "error", sheet, row, "Duplicate question text.");
    }
    prompts.add(normalizedPrompt);

    const options = [optionA, optionB, optionC, optionD].map(normalizeKey);
    if (new Set(options).size !== 4) {
      issue(
        issues,
        "error",
        sheet,
        row,
        "All four answer options must be distinct.",
      );
    }

    if (sourceRef) {
      const normalizedSourceRef = normalizeKey(sourceRef);
      if (sourceRefs.has(normalizedSourceRef)) {
        issue(
          issues,
          "error",
          sheet,
          row,
          `Duplicate source_ref: ${sourceRef}`,
        );
      }
      sourceRefs.add(normalizedSourceRef);
    }

    rows.push({
      categoryKey,
      question,
      optionA,
      optionB,
      optionC,
      optionD,
      correctOption: correctOption as "A" | "B" | "C" | "D",
      sourceRef,
    });
  });

  return rows;
}

function rowsFromObjects(
  input: Record<string, unknown>[],
): RawRecord[] {
  return input
    .map((record) =>
      Object.fromEntries(
        Object.entries(record).map(([key, value]) => [
          normalizeHeader(key),
          text(value),
        ]),
      ),
    )
    .filter((record) => Object.values(record).some(Boolean));
}

function rowsFromWorksheet(
  worksheet: ExcelJS.Worksheet,
): RawRecord[] {
  const headers: string[] = [];

  worksheet.getRow(1).eachCell(
    { includeEmpty: true },
    (cell, columnNumber) => {
      headers[columnNumber - 1] = normalizeHeader(cell.text);
    },
  );

  const records: RawRecord[] = [];

  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const record: RawRecord = {};

    headers.forEach((header, index) => {
      if (header) record[header] = row.getCell(index + 1).text.trim();
    });

    if (Object.values(record).some(Boolean)) {
      records.push(record);
    }
  }

  return records;
}

function detectCsvKind(record: RawRecord): ImportDataKind | null {
  const keys = new Set(Object.keys(record));

  if (
    [
      "category_key",
      "question",
      "option_a",
      "option_b",
      "option_c",
      "option_d",
      "correct_option",
    ].every((key) => keys.has(key))
  ) {
    return "questions";
  }

  if (keys.has("key") && keys.has("name")) {
    return "categories";
  }

  if (keys.has("name")) {
    return "colleges";
  }

  return null;
}

function existingCategoryKeys(db: AppDatabase): Set<string> {
  const rows = db.prepare(`
    SELECT category_key AS categoryKey
    FROM categories
  `).all() as Array<{ categoryKey: string }>;

  return new Set(rows.map((row) => normalizeKey(row.categoryKey)));
}

export async function parseImportBuffer(
  db: AppDatabase,
  fileName: string,
  buffer: Buffer,
): Promise<ParsedImport> {
  const issues: ImportIssue[] = [];
  const extension = extname(fileName).toLowerCase();

  let collegeRecords: RawRecord[] | null = null;
  let categoryRecords: RawRecord[] | null = null;
  let questionRecords: RawRecord[] | null = null;

  if (extension === ".csv") {
    const parsed = parseCsv(buffer.toString("utf8"), {
      columns: (headers: string[]) => headers.map(normalizeHeader),
      bom: true,
      skip_empty_lines: true,
      trim: true,
    }) as Record<string, unknown>[];

    const records = rowsFromObjects(parsed);
    const kind = records.length > 0 ? detectCsvKind(records[0]) : null;

    if (!kind) {
      issue(
        issues,
        "error",
        "CSV",
        1,
        "Could not detect CSV type from headers.",
      );
    } else if (kind === "colleges") {
      collegeRecords = records;
    } else if (kind === "categories") {
      categoryRecords = records;
    } else {
      questionRecords = records;
    }
  } else if (extension === ".xlsx") {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);

    const collegesSheet = workbook.getWorksheet("Colleges");
    const categoriesSheet = workbook.getWorksheet("Categories");
    const questionsSheet = workbook.getWorksheet("Questions");

    if (!collegesSheet && !categoriesSheet && !questionsSheet) {
      issue(
        issues,
        "error",
        "Workbook",
        null,
        "Workbook must contain Colleges, Categories, or Questions sheet.",
      );
    }

    collegeRecords = collegesSheet ? rowsFromWorksheet(collegesSheet) : null;
    categoryRecords = categoriesSheet
      ? rowsFromWorksheet(categoriesSheet)
      : null;
    questionRecords = questionsSheet
      ? rowsFromWorksheet(questionsSheet)
      : null;
  } else {
    issue(
      issues,
      "error",
      "File",
      null,
      "Only .csv and .xlsx files are supported.",
    );
  }

  const categories = categoryRecords
    ? validateCategories(categoryRecords, "Categories", issues)
    : null;

  const allowedCategoryKeys = categories
    ? new Set(categories.map((row) => normalizeKey(row.key)))
    : existingCategoryKeys(db);

  const colleges = collegeRecords
    ? validateColleges(collegeRecords, "Colleges", issues)
    : null;

  const questions = questionRecords
    ? validateQuestions(
        questionRecords,
        "Questions",
        issues,
        allowedCategoryKeys,
      )
    : null;

  if (questions && allowedCategoryKeys.size !== 5) {
    issue(
      issues,
      "error",
      "Questions",
      null,
      "Question import requires exactly 5 configured categories.",
    );
  }

  if (questions) {
    const counts = new Map<string, number>();
    for (const question of questions) {
      const key = normalizeKey(question.categoryKey);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    for (const categoryKey of allowedCategoryKeys) {
      if ((counts.get(categoryKey) ?? 0) < 2) {
        issue(
          issues,
          "warning",
          "Questions",
          null,
          `Category ${categoryKey} has fewer than 2 questions.`,
        );
      }
    }
  }

  return {
    colleges,
    categories,
    questions,
    issues,
  };
}

function buildPreview(
  previewId: string,
  fileName: string,
  parsed: ParsedImport,
): BulkImportPreview {
  const kinds: ImportDataKind[] = [];
  if (parsed.colleges) kinds.push("colleges");
  if (parsed.categories) kinds.push("categories");
  if (parsed.questions) kinds.push("questions");

  const categoryQuestionCounts: Record<string, number> = {};
  for (const question of parsed.questions ?? []) {
    categoryQuestionCounts[question.categoryKey] =
      (categoryQuestionCounts[question.categoryKey] ?? 0) + 1;
  }

  return {
    previewId,
    fileName,
    valid: !parsed.issues.some((entry) => entry.level === "error"),
    kinds,
    counts: {
      colleges: parsed.colleges?.length ?? 0,
      categories: parsed.categories?.length ?? 0,
      questions: parsed.questions?.length ?? 0,
      participatingColleges:
        parsed.colleges?.filter((college) => college.participating === true)
          .length ?? 0,
    },
    categoryQuestionCounts,
    issues: parsed.issues,
    samples: {
      colleges: (parsed.colleges ?? []).slice(0, 5).map((row) => row.name),
      categories: (parsed.categories ?? []).slice(0, 5).map((row) => row.name),
      questions: (parsed.questions ?? [])
        .slice(0, 5)
        .map((row) => row.question),
    },
  };
}

export function getQuestionBankSummary(
  db: AppDatabase,
): QuestionBankSummary {
  const categories = db.prepare(`
    SELECT
      c.category_key AS key,
      c.name,
      c.sort_order AS sortOrder,
      COUNT(q.id) AS questionCount
    FROM categories c
    LEFT JOIN questions q
      ON q.category_id = c.id
      AND q.active = 1
    GROUP BY c.id
    ORDER BY c.sort_order
  `).all() as Array<{
    key: string;
    name: string;
    sortOrder: number;
    questionCount: number;
  }>;

  return {
    totalQuestions: categories.reduce(
      (total, category) => total + category.questionCount,
      0,
    ),
    categories,
  };
}

async function sendTemplate(reply: FastifyReply) {
  const workbook = new ExcelJS.Workbook();

  const colleges = workbook.addWorksheet("Colleges");
  colleges.addRow(["name", "short_name", "participating"]);

  const categories = workbook.addWorksheet("Categories");
  categories.addRow(["key", "name"]);

  const questions = workbook.addWorksheet("Questions");
  questions.addRow([
    "category_key",
    "question",
    "option_a",
    "option_b",
    "option_c",
    "option_d",
    "correct_option",
    "source_ref",
  ]);

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

  reply
    .header(
      "content-type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    .header(
      "content-disposition",
      'attachment; filename="UniQuiz-import-template.xlsx"',
    );

  return reply.send(buffer);
}


async function sendExport(
  db: AppDatabase,
  reply: FastifyReply,
) {
  const workbook = new ExcelJS.Workbook();

  const colleges = workbook.addWorksheet("Colleges");
  colleges.addRow(["name", "short_name", "participating"]);

  const collegeRows = db.prepare(`
    SELECT
      c.name,
      c.short_name AS shortName,
      CASE WHEN p.college_id IS NULL THEN 0 ELSE 1 END AS participating
    FROM colleges c
    LEFT JOIN participants p ON p.college_id = c.id
    ORDER BY c.sort_order, c.id
  `).all() as Array<{
    name: string;
    shortName: string | null;
    participating: number;
  }>;

  for (const college of collegeRows) {
    colleges.addRow([
      college.name,
      college.shortName ?? "",
      college.participating === 1 ? "yes" : "no",
    ]);
  }

  const categories = workbook.addWorksheet("Categories");
  categories.addRow(["key", "name"]);

  const categoryRows = db.prepare(`
    SELECT
      category_key AS categoryKey,
      name
    FROM categories
    ORDER BY sort_order, id
  `).all() as Array<{
    categoryKey: string;
    name: string;
  }>;

  for (const category of categoryRows) {
    categories.addRow([category.categoryKey, category.name]);
  }

  const questions = workbook.addWorksheet("Questions");
  questions.addRow([
    "category_key",
    "question",
    "option_a",
    "option_b",
    "option_c",
    "option_d",
    "correct_option",
    "source_ref",
  ]);

  const questionRows = db.prepare(`
    SELECT
      c.category_key AS categoryKey,
      q.prompt AS question,
      q.option_a AS optionA,
      q.option_b AS optionB,
      q.option_c AS optionC,
      q.option_d AS optionD,
      q.correct_option AS correctOption,
      q.source_ref AS sourceRef
    FROM questions q
    JOIN categories c ON c.id = q.category_id
    WHERE q.active = 1
    ORDER BY c.sort_order, q.id
  `).all() as Array<{
    categoryKey: string;
    question: string;
    optionA: string;
    optionB: string;
    optionC: string;
    optionD: string;
    correctOption: string;
    sourceRef: string | null;
  }>;

  for (const question of questionRows) {
    questions.addRow([
      question.categoryKey,
      question.question,
      question.optionA,
      question.optionB,
      question.optionC,
      question.optionD,
      question.correctOption,
      question.sourceRef ?? "",
    ]);
  }

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const stamp = new Date().toISOString().slice(0, 10);

  reply
    .header(
      "content-type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    .header(
      "content-disposition",
      `attachment; filename="UniQuiz-export-${stamp}.xlsx"`,
    );

  return reply.send(buffer);
}

export function registerImportRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  io: SocketIOServer,
) {
  app.get("/api/question-bank", async () => getQuestionBankSummary(db));
  app.get("/api/import/template.xlsx", async (_request, reply) =>
    sendTemplate(reply),
  );

  app.get("/api/export/data.xlsx", async (_request, reply) =>
    sendExport(db, reply),
  );

  app.post("/api/import/preview", async (request, reply) => {
    cleanupExpiredPreviews();

    const file = await request.file();
    if (!file) {
      return reply.code(400).send({
        error: "FILE_REQUIRED",
        message: "Upload one CSV or XLSX file.",
      });
    }

    const buffer = await file.toBuffer();
    const parsed = await parseImportBuffer(db, file.filename, buffer);
    const previewId = randomUUID();

    previews.set(previewId, {
      createdAt: Date.now(),
      fileName: file.filename,
      parsed,
    });

    return buildPreview(previewId, file.filename, parsed);
  });

  app.post("/api/import/apply", async (request, reply) => {
    cleanupExpiredPreviews();

    const parsedBody = applySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({
        error: "INVALID_REQUEST",
        issues: parsedBody.error.issues,
      });
    }

    const staged = previews.get(parsedBody.data.previewId);
    if (!staged) {
      return reply.code(404).send({
        error: "PREVIEW_NOT_FOUND",
        message: "Import preview expired or does not exist.",
      });
    }

    if (staged.parsed.issues.some((entry) => entry.level === "error")) {
      return reply.code(409).send({
        error: "IMPORT_HAS_ERRORS",
        message: "Fix import errors before applying.",
      });
    }

    const competition = getCompetitionSnapshot(db);

    if (
      staged.parsed.colleges &&
      (competition.participantsLocked || competition.drawCreatedAt !== null)
    ) {
      return reply.code(409).send({
        error: "COLLEGE_IMPORT_LOCKED",
        message:
          "College import is blocked after participants are locked or draw exists.",
      });
    }

    const lockedQuestionSetCount = (
      db.prepare(
        "SELECT COUNT(*) AS count FROM qualification_round_question_sets",
      ).get() as { count: number }
    ).count;

    if (
      lockedQuestionSetCount > 0 &&
      (staged.parsed.categories || staged.parsed.questions)
    ) {
      return reply.code(409).send({
        error: "QUESTION_SETS_LOCKED",
        message:
          "Question/category import is blocked after round question sets are locked.",
      });
    }

    const existingQuestionCount = (
      db.prepare("SELECT COUNT(*) AS count FROM questions").get() as {
        count: number;
      }
    ).count;

    if (
      staged.parsed.categories &&
      !staged.parsed.questions &&
      existingQuestionCount > 0
    ) {
      return reply.code(409).send({
        error: "CATEGORY_IMPORT_REQUIRES_QUESTIONS",
        message:
          "Import categories together with questions while a question bank exists.",
      });
    }

    const apply = db.transaction(() => {
      if (staged.parsed.colleges) {
        db.prepare("DELETE FROM participants").run();
        db.prepare("DELETE FROM colleges").run();

        const insertCollege = db.prepare(`
          INSERT INTO colleges (name, short_name, sort_order)
          VALUES (?, ?, ?)
        `);
        const insertParticipant = db.prepare(`
          INSERT INTO participants (college_id)
          VALUES (?)
        `);

        staged.parsed.colleges.forEach((college, index) => {
          const result = insertCollege.run(
            college.name,
            college.shortName,
            index + 1,
          );

          if (college.participating === true) {
            insertParticipant.run(Number(result.lastInsertRowid));
          }
        });
      }

      if (staged.parsed.questions) {
        db.prepare("DELETE FROM questions").run();
      }

      if (staged.parsed.categories) {
        db.prepare("DELETE FROM categories").run();

        const insertCategory = db.prepare(`
          INSERT INTO categories (category_key, name, sort_order)
          VALUES (?, ?, ?)
        `);

        staged.parsed.categories.forEach((category, index) => {
          insertCategory.run(category.key, category.name, index + 1);
        });
      }

      if (staged.parsed.questions) {
        const categoryRows = db.prepare(`
          SELECT id, category_key AS categoryKey
          FROM categories
        `).all() as Array<{ id: number; categoryKey: string }>;

        const categoryIds = new Map(
          categoryRows.map((row) => [normalizeKey(row.categoryKey), row.id]),
        );

        const insertQuestion = db.prepare(`
          INSERT INTO questions (
            category_id,
            prompt,
            option_a,
            option_b,
            option_c,
            option_d,
            correct_option,
            source_ref
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const question of staged.parsed.questions) {
          const categoryId = categoryIds.get(
            normalizeKey(question.categoryKey),
          );

          if (!categoryId) {
            throw new Error(
              `Missing category while applying question: ${question.categoryKey}`,
            );
          }

          insertQuestion.run(
            categoryId,
            question.question,
            question.optionA,
            question.optionB,
            question.optionC,
            question.optionD,
            question.correctOption,
            question.sourceRef,
          );
        }
      }
    });

    apply();
    previews.delete(parsedBody.data.previewId);

    if (staged.parsed.colleges) {
      io.emit("competition:snapshot", getCompetitionSnapshot(db));
    }

    const questionBank = getQuestionBankSummary(db);
    io.emit("question-bank:snapshot", questionBank);

    return {
      ok: true,
      imported: buildPreview(
        parsedBody.data.previewId,
        staged.fileName,
        staged.parsed,
      ).counts,
      questionBank,
    };
  });
}
