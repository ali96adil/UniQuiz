import type { FastifyInstance, FastifyReply } from "fastify";
import ExcelJS from "exceljs";
import type { AppDatabase } from "./database.js";
import { getQualificationRanking } from "./ranking.js";
import { QUESTION_DURATION_MS } from "./question-clock.js";
import { getAudienceDisplaySettings } from "./audience-settings.js";

function isCurrentCycleRevealedSql(alias: string): string {
  return `
    EXISTS (
      SELECT 1
      FROM audit_events a
      WHERE a.event_type = 'QUESTION_REVEALED'
        AND a.round_id = ${alias}.round_id
        AND a.position = ${alias}.question_position
        AND a.id > COALESCE((
          SELECT MAX(v.id)
          FROM audit_events v
          WHERE v.event_type = 'QUESTION_VOID_REPLACED'
            AND v.round_id = ${alias}.round_id
            AND v.position = ${alias}.question_position
        ), 0)
    )
  `;
}

export async function buildResultsWorkbook(
  db: AppDatabase,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "UniQuiz";
  workbook.created = new Date();

  const settings = getAudienceDisplaySettings(db);
  const ranking = getQualificationRanking(db);

  const summary = workbook.addWorksheet("Summary");
  summary.addRow(["field", "value"]);
  summary.addRow(["event_title", settings.eventTitle]);
  summary.addRow(["event_subtitle", settings.eventSubtitle]);
  summary.addRow(["venue", settings.venue]);
  summary.addRow(["season", settings.season]);
  summary.addRow(["generated_at", new Date().toISOString()]);
  summary.addRow(["question_duration_seconds", QUESTION_DURATION_MS / 1000]);
  summary.addRow(["maximum_points", 25]);
  summary.addRow([
    "scoring",
    "Correct answer = displayed remaining whole second (25–1 points); wrong/no answer/expiry = 0",
  ]);

  const rankingSheet = workbook.addWorksheet("Ranking");
  rankingSheet.addRow([
    "rank",
    "college",
    "status",
    "score_points",
    "total_response_time_ms",
    "correct_answers",
    "wrong_answers",
    "revealed_questions",
  ]);

  for (const entry of ranking.entries) {
    rankingSheet.addRow([
      entry.rank ?? "",
      entry.college.name,
      entry.status,
      entry.status === "NOT_STARTED" ? "" : entry.scorePoints,
      entry.status === "NOT_STARTED" ? "" : entry.totalResponseTimeMs,
      entry.correctAnswers,
      entry.wrongAnswers,
      entry.revealedQuestions,
    ]);
  }

  const rounds = workbook.addWorksheet("Rounds");
  rounds.addRow([
    "round_order",
    "status",
    "college_a",
    "college_b",
    "team_a_points",
    "team_b_points",
  ]);

  const roundRows = db.prepare(`
    SELECT
      r.id,
      r.round_order AS roundOrder,
      r.status,
      a.name AS collegeA,
      b.name AS collegeB
    FROM qualification_rounds r
    JOIN colleges a ON a.id = r.college_a_id
    LEFT JOIN colleges b ON b.id = r.college_b_id
    ORDER BY r.round_order
  `).all() as Array<{
    id: number;
    roundOrder: number;
    status: string;
    collegeA: string;
    collegeB: string | null;
  }>;

  const roundScore = db.prepare(`
    SELECT
      s.station,
      COALESCE(SUM(s.score_micros), 0) AS scoreMicros
    FROM live_submissions s
    WHERE s.round_id = ?
      AND ${isCurrentCycleRevealedSql("s")}
    GROUP BY s.station
  `);

  for (const round of roundRows) {
    const scoreRows = roundScore.all(round.id) as Array<{
      station: "A" | "B";
      scoreMicros: number;
    }>;
    const scoreFor = (station: "A" | "B") =>
      (scoreRows.find((row) => row.station === station)?.scoreMicros ?? 0) /
      1_000_000;

    rounds.addRow([
      round.roundOrder,
      round.status,
      round.collegeA,
      round.collegeB ?? "",
      scoreFor("A"),
      round.collegeB ? scoreFor("B") : "",
    ]);
  }

  const submissions = workbook.addWorksheet("Submissions");
  submissions.addRow([
    "round_order",
    "question_position",
    "category",
    "station",
    "college",
    "question_id",
    "selected_option",
    "correct_option",
    "is_correct",
    "response_time_ms",
    "score_points",
    "submitted_at_epoch_ms",
    "counts_in_official_result",
  ]);

  const submissionRows = db.prepare(`
    SELECT
      r.round_order AS roundOrder,
      s.question_position AS questionPosition,
      c.name AS categoryName,
      s.station,
      CASE
        WHEN s.station = 'A' THEN ca.name
        ELSE cb.name
      END AS collegeName,
      s.question_id AS questionId,
      s.selected_option AS selectedOption,
      q.correct_option AS correctOption,
      s.is_correct AS isCorrect,
      s.response_time_ms AS responseTimeMs,
      s.score_micros AS scoreMicros,
      s.submitted_at_epoch_ms AS submittedAtEpochMs,
      CASE WHEN ${isCurrentCycleRevealedSql("s")} THEN 1 ELSE 0 END
        AS countsInOfficialResult
    FROM live_submissions s
    JOIN qualification_rounds r ON r.id = s.round_id
    JOIN questions q ON q.id = s.question_id
    JOIN categories c ON c.id = q.category_id
    JOIN colleges ca ON ca.id = r.college_a_id
    LEFT JOIN colleges cb ON cb.id = r.college_b_id
    ORDER BY r.round_order, s.question_position, s.station
  `).all() as Array<{
    roundOrder: number;
    questionPosition: number;
    categoryName: string;
    station: string;
    collegeName: string | null;
    questionId: number;
    selectedOption: string;
    correctOption: string;
    isCorrect: number;
    responseTimeMs: number;
    scoreMicros: number;
    submittedAtEpochMs: number;
    countsInOfficialResult: number;
  }>;

  for (const row of submissionRows) {
    submissions.addRow([
      row.roundOrder,
      row.questionPosition,
      row.categoryName,
      row.station,
      row.collegeName ?? "",
      row.questionId,
      row.selectedOption,
      row.correctOption,
      row.isCorrect === 1 ? "yes" : "no",
      row.responseTimeMs,
      row.scoreMicros / 1_000_000,
      row.submittedAtEpochMs,
      row.countsInOfficialResult === 1 ? "yes" : "no",
    ]);
  }

  const audit = workbook.addWorksheet("Audit");
  audit.addRow([
    "id",
    "event_type",
    "round_id",
    "round_order",
    "question_id",
    "related_question_id",
    "position",
    "reason",
    "payload_json",
    "occurred_at",
  ]);

  const auditRows = db.prepare(`
    SELECT
      a.id,
      a.event_type AS eventType,
      a.round_id AS roundId,
      r.round_order AS roundOrder,
      a.question_id AS questionId,
      a.related_question_id AS relatedQuestionId,
      a.position,
      a.reason,
      a.payload_json AS payloadJson,
      a.occurred_at AS occurredAt
    FROM audit_events a
    LEFT JOIN qualification_rounds r ON r.id = a.round_id
    ORDER BY a.id
  `).all() as Array<{
    id: number;
    eventType: string;
    roundId: number | null;
    roundOrder: number | null;
    questionId: number | null;
    relatedQuestionId: number | null;
    position: number | null;
    reason: string | null;
    payloadJson: string | null;
    occurredAt: string;
  }>;

  for (const row of auditRows) {
    audit.addRow([
      row.id,
      row.eventType,
      row.roundId ?? "",
      row.roundOrder ?? "",
      row.questionId ?? "",
      row.relatedQuestionId ?? "",
      row.position ?? "",
      row.reason ?? "",
      row.payloadJson ?? "",
      row.occurredAt,
    ]);
  }

  for (const sheet of workbook.worksheets) {
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.getRow(1).font = { bold: true };
    sheet.columns.forEach((column) => {
      const values = column.values ?? [];
      const lengths = values
        .slice(1)
        .map((value) => String(value ?? "").length + 2);
      column.width = Math.min(
        48,
        Math.max(12, ...lengths),
      );
    });
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function registerResultsExportRoutes(
  app: FastifyInstance,
  db: AppDatabase,
): void {
  app.get(
    "/api/export/results.xlsx",
    async (_request, reply: FastifyReply) => {
      const buffer = await buildResultsWorkbook(db);
      const stamp = new Date().toISOString().slice(0, 10);

      reply
        .header(
          "content-type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        .header(
          "content-disposition",
          `attachment; filename="UniQuiz-results-${stamp}.xlsx"`,
        );

      return reply.send(buffer);
    },
  );
}
