import { Router, Request, Response } from "express";
import { getDb } from "../../db/client";

export const reviewRouter = Router();

const BAND_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

// A screening counts as "reviewed" only once a conclusive disposition exists.
// A disposition explicitly recorded as 'pending' does NOT count as reviewed —
// it's a placeholder, not a decision — so it still shows up in this queue.
const CONCLUSIVE_DECISIONS = ["true_positive", "false_positive", "escalated"];
const CONCLUSIVE_PLACEHOLDERS = CONCLUSIVE_DECISIONS.map(() => "?").join(",");

// GET /screenings/pending-review?minBand=medium&limit=100
// Returns screenings at or above the given risk band that have no conclusive
// disposition yet. Default minBand=medium, since most compliance programs
// don't manually review every zero/low-risk hit — this surfaces the tier
// that actually needs a human decision.
reviewRouter.get("/screenings/pending-review", (req: Request, res: Response) => {
  const minBandParam = ((req.query.minBand as string) ?? "medium").toLowerCase();
  const minRank = BAND_RANK[minBandParam];
  if (minRank === undefined) {
    return res.status(400).json({ error: "minBand must be one of: low, medium, high" });
  }

  const limit = Math.min(parseInt((req.query.limit as string) ?? "100", 10) || 100, 500);

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT s.id, s.subject_name, s.subject_dob, s.subject_nationality, s.requested_by,
              s.requested_at, s.risk_score, s.risk_band, s.matches
       FROM screenings s
       WHERE (
         CASE s.risk_band WHEN 'low' THEN 0 WHEN 'medium' THEN 1 WHEN 'high' THEN 2 ELSE -1 END
       ) >= ?
       AND NOT EXISTS (
         SELECT 1 FROM dispositions d
         WHERE d.screening_id = s.id
           AND d.decision IN (${CONCLUSIVE_PLACEHOLDERS})
       )
       ORDER BY s.requested_at ASC
       LIMIT ?`
    )
    .all(minRank, ...CONCLUSIVE_DECISIONS, limit);

  res.json({
    minBand: minBandParam,
    count: rows.length,
    screenings: rows,
  });
});

// GET /screenings/review-summary
// Quick counts for a dashboard: how many screenings in each band are still
// awaiting a conclusive disposition. Cheap to poll, no pagination needed.
reviewRouter.get("/screenings/review-summary", (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT s.risk_band, COUNT(*) as pendingCount
       FROM screenings s
       WHERE NOT EXISTS (
         SELECT 1 FROM dispositions d
         WHERE d.screening_id = s.id
           AND d.decision IN (${CONCLUSIVE_PLACEHOLDERS})
       )
       GROUP BY s.risk_band`
    )
    .all(...CONCLUSIVE_DECISIONS) as { risk_band: string; pendingCount: number }[];

  const summary = { low: 0, medium: 0, high: 0 };
  for (const row of rows) {
    if (row.risk_band in summary) {
      (summary as any)[row.risk_band] = row.pendingCount;
    }
  }

  res.json({ pendingByBand: summary });
});
