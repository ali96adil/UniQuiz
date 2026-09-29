import type {
  QualificationRankingEntry,
  QualificationRankingSnapshot,
} from "@uniquiz/shared";
import type { AppDatabase } from "./database.js";

interface RankingRow {
  collegeId: number;
  name: string;
  shortName: string | null;
  sortOrder: number;
  roundStatus: "PENDING" | "ACTIVE" | "COMPLETED";
  scoreMicros: number;
  revealedQuestions: number;
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
              AND a.id > COALESCE((
                SELECT MAX(v.id)
                FROM audit_events v
                WHERE v.event_type = 'QUESTION_VOID_REPLACED'
                  AND v.round_id = s.round_id
                  AND v.position = s.question_position
              ), 0)
          )
          THEN s.score_micros
          ELSE 0
        END
      ), 0) AS scoreMicros,
      COUNT(DISTINCT
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM audit_events a
            WHERE a.event_type = 'QUESTION_REVEALED'
              AND a.round_id = s.round_id
              AND a.position = s.question_position
              AND a.id > COALESCE((
                SELECT MAX(v.id)
                FROM audit_events v
                WHERE v.event_type = 'QUESTION_VOID_REPLACED'
                  AND v.round_id = s.round_id
                  AND v.position = s.question_position
              ), 0)
          )
          THEN s.question_position
          ELSE NULL
        END
      ) AS revealedQuestions
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
      return a.sortOrder - b.sortOrder;
    });

  let previousScore: number | null = null;
  let previousRank = 0;

  const rankedStarted: QualificationRankingEntry[] = started.map(
    (row, index) => {
      const rank =
        previousScore !== null && row.scoreMicros === previousScore
          ? previousRank
          : index + 1;

      previousScore = row.scoreMicros;
      previousRank = rank;

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
    }));

  return {
    generatedAt: new Date().toISOString(),
    entries: [...rankedStarted, ...notStarted],
  };
}
