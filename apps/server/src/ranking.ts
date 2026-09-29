import type {
  QualificationRankingEntry,
  QualificationRankingSnapshot,
} from "@uniquiz/shared";
import type { AppDatabase } from "./database.js";
import { QUESTION_DURATION_MS } from "./question-clock.js";

interface RankingRow {
  collegeId: number;
  name: string;
  shortName: string | null;
  sortOrder: number;
  roundStatus: "PENDING" | "ACTIVE" | "COMPLETED";
  scoreMicros: number;
  revealedQuestions: number;
  totalResponseTimeMs: number;
}

export function getQualificationRanking(
  db: AppDatabase,
): QualificationRankingSnapshot {
  const rows = db.prepare(`
    SELECT
      c.id AS collegeId,
      c.name,
      c.short_name AS shortName,
      c.sort_order AS sortOrder,
      r.status AS roundStatus,
      COALESCE(SUM(
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM audit_events a
            WHERE a.event_type = 'QUESTION_REVEALED'
              AND a.round_id = s.round_id
              AND a.position = s.question_position
          )
          THEN s.score_micros
          ELSE 0
        END
      ), 0) AS scoreMicros,
      (
        SELECT COUNT(DISTINCT a.position)
        FROM audit_events a
        WHERE a.event_type = 'QUESTION_REVEALED'
          AND a.round_id = r.id
      ) AS revealedQuestions,
      (
        SELECT COALESCE(SUM(
          COALESCE(
            (
              SELECT s2.response_time_ms
              FROM live_submissions s2
              WHERE s2.round_id = r.id
                AND s2.question_position = a.position
                AND (
                  (r.college_a_id = c.id AND s2.station = 'A')
                  OR
                  (r.college_b_id = c.id AND s2.station = 'B')
                )
              LIMIT 1
            ),
            ${QUESTION_DURATION_MS}
          )
        ), 0)
        FROM audit_events a
        WHERE a.event_type = 'QUESTION_REVEALED'
          AND a.round_id = r.id
      ) AS totalResponseTimeMs
    FROM participants p
    JOIN colleges c ON c.id = p.college_id
    JOIN qualification_rounds r
      ON r.college_a_id = c.id
      OR r.college_b_id = c.id
    LEFT JOIN live_submissions s
      ON s.round_id = r.id
      AND (
        (r.college_a_id = c.id AND s.station = 'A')
        OR
        (r.college_b_id = c.id AND s.station = 'B')
      )
    GROUP BY c.id, r.id
    ORDER BY c.sort_order, c.id
  `).all() as RankingRow[];

  const started = rows
    .filter((row) => row.roundStatus !== "PENDING")
    .sort((a, b) => {
      if (b.scoreMicros !== a.scoreMicros) {
        return b.scoreMicros - a.scoreMicros;
      }
      if (a.totalResponseTimeMs !== b.totalResponseTimeMs) {
        return a.totalResponseTimeMs - b.totalResponseTimeMs;
      }
      return a.sortOrder - b.sortOrder;
    });

  const rankedStarted: QualificationRankingEntry[] = started.map(
    (row, index) => {
      const rank = index + 1;

      return {
        college: {
          id: row.collegeId,
          name: row.name,
          shortName: row.shortName,
          sortOrder: row.sortOrder,
        },
        status:
          row.roundStatus === "COMPLETED"
            ? "COMPLETED"
            : "PLAYING",
        rank,
        scorePoints: row.scoreMicros / 1_000_000,
        revealedQuestions: row.revealedQuestions,
        totalResponseTimeMs: row.totalResponseTimeMs,
      };
    },
  );

  const notStarted: QualificationRankingEntry[] = rows
    .filter((row) => row.roundStatus === "PENDING")
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((row) => ({
      college: {
        id: row.collegeId,
        name: row.name,
        shortName: row.shortName,
        sortOrder: row.sortOrder,
      },
      status: "NOT_STARTED",
      rank: null,
      scorePoints: 0,
      revealedQuestions: 0,
      totalResponseTimeMs: 0,
    }));

  return {
    generatedAt: new Date().toISOString(),
    entries: [...rankedStarted, ...notStarted],
  };
}
