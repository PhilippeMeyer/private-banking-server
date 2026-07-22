import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { config } from "../config";

let db: Database.Database | null = null;

/**
 * Returns a singleton SQLite connection. Kept behind a function (rather than
 * exported directly) so tests can point SQLITE_PATH at ":memory:" or a temp file.
 */
export function getDb(): Database.Database {
  if (db) return db;

  const dir = path.dirname(config.sqlitePath);
  if (dir !== "." && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(config.sqlitePath);
  db.pragma("journal_mode = WAL"); // better concurrent read/write behavior
  db.pragma("foreign_keys = ON");

  applyMigrations(db);
  return db;
}

function applyMigrations(database: Database.Database): void {
  const schemaPath = path.join(__dirname, "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf-8");
  database.exec(schema);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
