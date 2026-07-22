import { getDb } from "./client";

// Running this just opens the DB, which applies schema.sql via applyMigrations().
// Kept as an explicit script so deploy pipelines can run migration as its own step.
getDb();
console.log("Migrations applied (schema.sql executed with CREATE TABLE IF NOT EXISTS).");
