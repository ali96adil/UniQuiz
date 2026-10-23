-- SQL extracted from main:apps/server/src/ranking.ts (blob b2f84d215a5cb24d069c502f9e142fd2e0dca6e3)
-- Only interpolation ${QUESTION_DURATION_MS} has been resolved to M6's 25000.
-- Comparison fixture: generated test data only, never the real university DB.
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
      (
        SELECT COUNT(DISTINCT a.position)
        FROM audit_events a
        WHERE a.event_type = 'QUESTION_REVEALED'
          AND a.round_id = r.id
              AND a.id > COALESCE((
                SELECT MAX(v.id)
                FROM audit_events v
                WHERE v.event_type = 'QUESTION_VOID_REPLACED'
                  AND v.round_id = r.id
                  AND v.position = a.position
              ), 0)
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
            25000
          )
        ), 0)
        FROM audit_events a
        WHERE a.event_type = 'QUESTION_REVEALED'
          AND a.round_id = r.id
              AND a.id > COALESCE((
                SELECT MAX(v.id)
                FROM audit_events v
                WHERE v.event_type = 'QUESTION_VOID_REPLACED'
                  AND v.round_id = r.id
                  AND v.position = a.position
              ), 0)
      ) AS totalResponseTimeMs,
      (
        SELECT COUNT(*)
        FROM live_submissions s3
        WHERE s3.round_id = r.id
          AND s3.is_correct = 1
          AND (
            (r.college_a_id = c.id AND s3.station = 'A')
            OR
            (r.college_b_id = c.id AND s3.station = 'B')
          )
          AND EXISTS (
            SELECT 1
            FROM audit_events a3
            WHERE a3.event_type = 'QUESTION_REVEALED'
              AND a3.round_id = s3.round_id
              AND a3.position = s3.question_position
              AND a3.id > COALESCE((
                SELECT MAX(v.id)
                FROM audit_events v
                WHERE v.event_type = 'QUESTION_VOID_REPLACED'
                  AND v.round_id = s3.round_id
                  AND v.position = s3.question_position
              ), 0)
          )
      ) AS correctAnswers,
      (
        SELECT COUNT(*)
        FROM live_submissions s4
        WHERE s4.round_id = r.id
          AND s4.is_correct = 0
          AND (
            (r.college_a_id = c.id AND s4.station = 'A')
            OR
            (r.college_b_id = c.id AND s4.station = 'B')
          )
          AND EXISTS (
            SELECT 1
            FROM audit_events a4
            WHERE a4.event_type = 'QUESTION_REVEALED'
              AND a4.round_id = s4.round_id
              AND a4.position = s4.question_position
              AND a4.id > COALESCE((
                SELECT MAX(v.id)
                FROM audit_events v
                WHERE v.event_type = 'QUESTION_VOID_REPLACED'
                  AND v.round_id = s4.round_id
                  AND v.position = s4.question_position
              ), 0)
          )
      ) AS wrongAnswers
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
