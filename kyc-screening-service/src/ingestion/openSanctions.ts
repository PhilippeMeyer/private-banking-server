import { parse } from "csv-parse/sync";
import { config } from "../config";
import { mapOpenSanctionsRow } from "../normalize/mappers";
import { persistImport, ImportResult } from "./types";

/**
 * OpenSanctions aggregates ~100+ national sanctions/PEP lists (including UK,
 * Japan, Singapore, Hong Kong) into one consistent schema. Useful for broad
 * coverage of jurisdictions whose own data is messy PDF/HTML rather than a
 * clean feed (Singapore, Hong Kong fall in this category).
 *
 * LICENSING — READ BEFORE ENABLING:
 * OpenSanctions bulk/API data is free for non-commercial use (journalists,
 * civic research). A bank's KYC screening use is commercial use and
 * requires a paid license from OpenSanctions (https://www.opensanctions.org/licensing/).
 * This importer refuses to run unless OPENSANCTIONS_LICENSE_CONFIRMED=true
 * is explicitly set in .env, as a deliberate speed bump against accidentally
 * using unlicensed data in a commercial compliance system.
 */
export async function importOpenSanctions(): Promise<ImportResult> {
  if (!config.sources.openSanctionsLicenseConfirmed) {
    throw new Error(
      "OpenSanctions import blocked: set OPENSANCTIONS_LICENSE_CONFIRMED=true in .env " +
        "only after confirming you have a commercial license from OpenSanctions " +
        "(https://www.opensanctions.org/licensing/) — bulk/API data is free for " +
        "non-commercial use only, and a bank's KYC screening is commercial use."
    );
  }

  const res = await fetch(config.sources.openSanctionsCsvUrl, {
    headers: { "User-Agent": "kyc-screening-service/0.1 (compliance-import)" },
  });
  if (!res.ok) {
    throw new Error(`OpenSanctions fetch failed: ${res.status} ${res.statusText}`);
  }

  const csvText = await res.text();
  const rows: Record<string, string>[] = parse(csvText, { columns: true, skip_empty_lines: true });

  if (rows.length === 0) {
    throw new Error("OpenSanctions CSV parsed to zero rows — check the dataset URL.");
  }

  // OpenSanctions has changed its CSV columns before (e.g. added program_ids
  // later); log what's actually present so a schema drift is visible.
  console.log(`[import] OpenSanctions: columns found: ${Object.keys(rows[0]).join(", ")}`);

  const canonical = rows.map(mapOpenSanctionsRow);
  return persistImport("OPENSANCTIONS", canonical, csvText);
}
