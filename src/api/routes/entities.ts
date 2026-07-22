import { Router, Request, Response } from "express";
import { getDb } from "../../db/client";

export const entitiesRouter = Router();

// GET /list-versions — shows the currently loaded version of each source list,
// so ops/compliance can confirm imports are current.
entitiesRouter.get("/list-versions", (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT source, version_label, record_count, imported_at, status
       FROM list_versions
       WHERE id IN (
         SELECT id FROM list_versions lv2
         WHERE lv2.source = list_versions.source
         ORDER BY imported_at DESC LIMIT 1
       )
       ORDER BY source`
    )
    .all();
  res.json({ listVersions: rows });
});

// GET /entities/:id — look up a single stored watchlist entity by internal id
entitiesRouter.get("/entities/:id", (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM entities WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: "Entity not found" });
  res.json(row);
});
