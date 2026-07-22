import fs from "fs";
import { parse } from "csv-parse/sync";
import { mapCustomRecord } from "../normalize/mappers";
import { persistImport, ImportResult } from "./types";

/**
 * Imports a bank-maintained custom watchlist from a local CSV or JSON file.
 * Expected CSV columns: id,name,aliases,dateOfBirth,nationality,tags
 * (aliases and tags as semicolon-separated values within the cell)
 */
export function importCustomListFromFile(filePath: string): ImportResult {
  const content = fs.readFileSync(filePath, "utf-8");

  const records = filePath.endsWith(".json")
    ? JSON.parse(content)
    : parse(content, { columns: true, skip_empty_lines: true }).map((row: any) => ({
        ...row,
        aliases: row.aliases ? row.aliases.split(";").map((s: string) => s.trim()) : [],
        tags: row.tags ? row.tags.split(";").map((s: string) => s.trim()) : [],
      }));

  const canonical = records.map(mapCustomRecord);
  return persistImport("CUSTOM", canonical, content, filePath);
}
