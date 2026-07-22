import * as XLSX from "xlsx";
import { config } from "../config";
import { mapJpMofRow, JpMofColumnMap } from "../normalize/mappers";
import { persistImport, ImportResult } from "./types";

/**
 * Japan's MOF publishes its sanctions/eligible-persons list as XLSX only —
 * no XML/JSON/API. The column mapping (config.sources.jpMofColumnMap) is
 * NOT verified against the live file; this project's tooling could not
 * parse the actual binary XLSX during development to confirm real header
 * names (likely Japanese-language). Before relying on this in production:
 *   1. Download the file manually from the URL in .env
 *   2. Open it and note the real header row
 *   3. Set JP_MOF_COLUMN_MAP in .env to match
 * This importer logs the actual headers it finds on every run specifically
 * so a silent mis-mapping doesn't go unnoticed.
 */
export async function importJpMof(): Promise<ImportResult> {
  const res = await fetch(config.sources.jpMofXlsxUrl, {
    headers: { "User-Agent": "kyc-screening-service/0.1 (compliance-import)" },
  });
  if (!res.ok) {
    throw new Error(`Japan MOF list fetch failed: ${res.status} ${res.statusText}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());

  // SheetJS auto-detects format and will silently parse an HTML page's
  // <table> as if it were spreadsheet data rather than erroring — this bit
  // the initial version of this importer, which pointed at MOF's HTML
  // overview page and "succeeded" while actually importing ~30 program-
  // summary rows instead of thousands of individual designees. A real XLSX
  // file is a ZIP archive and starts with the bytes "PK"; anything else
  // (like an HTML doctype) means the URL is wrong, not that parsing failed.
  const isZip = buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b; // "PK"
  if (!isZip) {
    const preview = buffer.subarray(0, 100).toString("utf-8").replace(/\s+/g, " ").trim();
    throw new Error(
      `Japan MOF fetch returned non-XLSX content (does not start with the ZIP "PK" signature ` +
        `real XLSX files have). This usually means the URL points at an HTML page, not the actual ` +
        `file — check JP_MOF_XLSX_URL. Content preview: "${preview.slice(0, 150)}"`
    );
  }

  const workbook = XLSX.read(buffer, { type: "buffer" });
  const firstSheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[firstSheetName];
  const rows: Record<string, any>[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  if (rows.length === 0) {
    throw new Error("Japan MOF XLSX parsed to zero rows — sheet layout may have changed.");
  }

  const actualColumns = Object.keys(rows[0]);
  const columnMap: JpMofColumnMap = config.sources.jpMofColumnMap;
  const missingMappedColumns = Object.values(columnMap).filter(
    (col) => col && !actualColumns.includes(col)
  );

  console.log(`[import] Japan MOF: sheet "${firstSheetName}", columns found: ${actualColumns.join(", ")}`);
  if (missingMappedColumns.length > 0) {
    console.warn(
      `[import] Japan MOF: configured column(s) not found in file: ${missingMappedColumns.join(", ")}. ` +
        `Update JP_MOF_COLUMN_MAP in .env to match the actual header row above.`
    );
  }

  const canonical = rows.map((row, i) =>
    mapJpMofRow({ ...row, __rowIndex: i }, columnMap)
  );

  return persistImport("JP_MOF", canonical, JSON.stringify({ rowCount: rows.length, columns: actualColumns }));
}
