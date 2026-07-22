import { Router, Request, Response } from "express";
import { z } from "zod";
import { screenSubject } from "../../matching/matchService";
import { recordDisposition, getAuditTrailFor } from "../../audit/auditLog";
import { getDb } from "../../db/client";

export const screenRouter = Router();

const idNumberSchema = z.object({
  type: z.string(),
  number: z.string(),
  country: z.string().optional(),
});

const screenRequestSchema = z.object({
  name: z.string().min(1),
  dateOfBirth: z.string().optional(), // ISO date, e.g. "1980-04-12"
  nationality: z.string().optional(), // ISO 3166-1 alpha-2, e.g. "FR"
  idNumbers: z.array(idNumberSchema).optional(),
  requestedBy: z.string().optional(),
});

// POST /screen — synchronous single-subject screening
screenRouter.post("/screen", (req: Request, res: Response) => {
  const parsed = screenRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
  }

  const { name, dateOfBirth, nationality, idNumbers, requestedBy } = parsed.data;

  try {
    const result = screenSubject(
      { name, dateOfBirth, nationality, idNumbers },
      requestedBy
    );
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: "Screening failed", message: (err as Error).message });
  }
});

// POST /screen/batch — accepts an array of subjects, screens each synchronously
// and returns all results. For very large batches, swap this for a queued job
// with a webhook callback instead of blocking the HTTP request.
screenRouter.post("/screen/batch", (req: Request, res: Response) => {
  const batchSchema = z.object({ subjects: z.array(screenRequestSchema).min(1).max(500) });
  const parsed = batchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
  }

  const results = parsed.data.subjects.map((s) =>
    screenSubject(
      { name: s.name, dateOfBirth: s.dateOfBirth, nationality: s.nationality, idNumbers: s.idNumbers },
      s.requestedBy
    )
  );

  return res.status(200).json({ results });
});

// GET /screenings/:id — retrieve a past screening result
screenRouter.get("/screenings/:id", (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM screenings WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: "Screening not found" });
  return res.json(row);
});

// POST /screenings/:id/disposition — analyst records true/false positive
const dispositionSchema = z.object({
  decision: z.enum(["true_positive", "false_positive", "escalated", "pending"]),
  reviewedBy: z.string().min(1),
  notes: z.string().optional(),
});

screenRouter.post("/screenings/:id/disposition", (req: Request, res: Response) => {
  const parsed = dispositionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
  }

  const dispositionId = recordDisposition({
    screeningId: req.params.id,
    decision: parsed.data.decision,
    reviewedBy: parsed.data.reviewedBy,
    notes: parsed.data.notes,
  });

  return res.status(201).json({ dispositionId });
});

// GET /screenings/:id/audit — full audit trail for a screening
screenRouter.get("/screenings/:id/audit", (req: Request, res: Response) => {
  const trail = getAuditTrailFor("screening", req.params.id);
  return res.json({ trail });
});
