import type { AppDatabase } from "./database.js";

export interface AuditEventInput {
  eventType: string;
  roundId?: number | null;
  questionId?: number | null;
  relatedQuestionId?: number | null;
  position?: number | null;
  reason?: string | null;
  payload?: unknown;
  occurredAt?: string;
}

export function appendAuditEvent(
  db: AppDatabase,
  event: AuditEventInput,
): void {
  db.prepare(`
    INSERT INTO audit_events (
      event_type,
      round_id,
      question_id,
      related_question_id,
      position,
      reason,
      payload_json,
      occurred_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.eventType,
    event.roundId ?? null,
    event.questionId ?? null,
    event.relatedQuestionId ?? null,
    event.position ?? null,
    event.reason ?? null,
    event.payload === undefined
      ? null
      : JSON.stringify(event.payload),
    event.occurredAt ?? new Date().toISOString(),
  );
}
