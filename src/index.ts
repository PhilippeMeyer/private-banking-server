import { startServer } from "./api/server";
import { startScheduler } from "./ingestion/scheduler";
import { getDb } from "./db/client";

// Ensures schema is applied before anything else touches the DB.
getDb();

startServer();
startScheduler();
