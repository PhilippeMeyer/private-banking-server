import { parseStringPromise } from "xml2js";
import { config } from "../config";
import { mapUkEntry } from "../normalize/mappers";
import { persistImport, ImportResult } from "./types";

export async function importUk(): Promise<ImportResult> {
  const res = await fetch(config.sources.ukSanctionsListUrl, {
    headers: { "User-Agent": "kyc-screening-service/0.1 (compliance-import)" },
  });
  if (!res.ok) {
    throw new Error(`UK list fetch failed: ${res.status} ${res.statusText}`);
  }
  const xml = await res.text();
  const parsed = await parseStringPromise(xml);

  // Verified live schema: Designations.Designation[]
  const entries: any[] = parsed?.Designations?.Designation ?? [];
  const canonical = entries.map((e) => mapUkEntry(e));

  return persistImport("UK", canonical, xml);
}
