import express from "express";
import { config } from "../config";
import { screenRouter } from "./routes/screen";
import { entitiesRouter } from "./routes/entities";
import { reviewRouter } from "./routes/review";

export function createServer() {
  const app = express();
  app.use(express.json({ limit: "5mb" }));

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  // reviewRouter must be mounted before screenRouter: it has specific paths
  // like /screenings/pending-review that would otherwise be matched by
  // screenRouter's GET /screenings/:id as if "pending-review" were an id.
  app.use(reviewRouter);
  app.use(screenRouter);
  app.use(entitiesRouter);

  // Centralized error handler so an unexpected exception never leaks a stack
  // trace to a banking client integration.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[server] unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

export function startServer(): void {
  const app = createServer();
  app.listen(config.port, () => {
    console.log(`[server] KYC screening service listening on port ${config.port}`);
  });
}
