import { parseStringPromise } from "xml2js";
import { config } from "../config";
import { mapOfacEntry } from "../normalize/mappers";
import { persistImport, ImportResult } from "./types";

async function fetchText(url: string): Promise<string> {
  // OFAC's Sanctions List Service (the new host behind the treasury.gov
  // redirect) rejects requests with no User-Agent header with a 403.
  // Node's fetch sends none by default, so this is required, not optional.
  const res = await fetch(url, {
    headers: { "User-Agent": "kyc-screening-service/0.1 (compliance-import)" },
  });
  if (!res.ok) {
    throw new Error(`OFAC fetch failed: ${res.status} ${res.statusText} (${url})`);
  }
  return res.text();
}

async function importOne(
  url: string,
  source: "OFAC_SDN" | "OFAC_CONSOLIDATED"
): Promise<ImportResult> {
  const xml = await fetchText(url);
  const parsed = await parseStringPromise(xml);

  // Real SDN/Consolidated XML nests entries at sdnList.sdnEntry[]
  const entries: any[] = parsed?.sdnList?.sdnEntry ?? [];
  const canonical = entries.map((e) => mapOfacEntry(e, source));

  return persistImport(source, canonical, xml);
}

export async function importOfacSdn(): Promise<ImportResult> {
  return importOne(config.sources.ofacSdnUrl, "OFAC_SDN");
}

export async function importOfacConsolidated(): Promise<ImportResult> {
  return importOne(config.sources.ofacConsolidatedUrl, "OFAC_CONSOLIDATED");
}
