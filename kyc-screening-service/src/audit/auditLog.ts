import { v4 as uuid } from "uuid";
import { getDb } from "../db/client";

export interface DispositionInput {
  screeningId: string;
  decision: "true_positive" | "false_positive" | "escalated" | "pending";
  reviewedBy: string;
  notes?: string;
}

/**
 * Records an analyst's disposition on a screening result. Never mutates the
 * original screening row — the screening is what the system produced, the
 * disposition is what a human decided about it. Both are kept for audit.
 */
export function recordDisposition(input: DispositionInput): string {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO dispositions (id, screening_id, decision, reviewed_by, notes, reviewed_at)
     VALUES (@id, @screeningId, @decision, @reviewedBy, @notes, @reviewedAt)`
  ).run({
    id,
    screeningId: input.screeningId,
    decision: input.decision,
    reviewedBy: input.reviewedBy,
    notes: input.notes ?? null,
    reviewedAt: now,
  });

  db.prepare(
    `INSERT INTO audit_log (id, entity_type, entity_id, action, actor, details, created_at)
     VALUES (@id, 'disposition', @screeningId, 'reviewed', @actor, @details, @createdAt)`
  ).run({
    id: uuid(),
    screeningId: input.screeningId,
    actor: input.reviewedBy,
    details: JSON.stringify({ decision: input.decision, notes: input.notes ?? null }),
    createdAt: now,
  });

  return id;
}

export function getAuditTrailFor(entityType: string, entityId: string) {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM audit_log WHERE entity_type = ? AND entity_id = ? ORDER BY created_at ASC`
    )
    .all(entityType, entityId);
}
