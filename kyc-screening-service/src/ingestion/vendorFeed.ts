import { config } from "../config";
import { mapVendorRecord } from "../normalize/mappers";
import { persistImport, ImportResult } from "./types";

/**
 * PEP and adverse-media data virtually always comes from a licensed vendor
 * (Dow Jones Risk & Compliance, Refinitiv World-Check, Moody's Grid, etc.)
 * rather than a free public list. This module is a generic template for
 * whichever vendor you contract with — swap the request shape and response
 * parsing for the vendor's actual API contract; the rest of the pipeline
 * (mapping -> persistImport) stays the same.
 */

interface VendorFetchOptions {
  url: string;
  apiKey: string;
  riskCategory: "pep" | "adverse_media";
  sourceLabel: "PEP" | "ADVERSE_MEDIA";
}

async function importVendorFeed(opts: VendorFetchOptions): Promise<ImportResult> {
  if (!opts.url || !opts.apiKey) {
    throw new Error(
      `${opts.sourceLabel} vendor not configured. Set the API URL and key in .env once you've signed a data license.`
    );
  }

  const res = await fetch(opts.url, {
    headers: { Authorization: `Bearer ${opts.apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`${opts.sourceLabel} vendor fetch failed: ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as { records?: any[]; data?: any[] };
  // Assumes the vendor returns { records: [...] } — adjust to the real contract.
  const records: any[] = body.records ?? body.data ?? [];
  const canonical = records.map((r) => mapVendorRecord(r, opts.riskCategory));

  return persistImport(opts.sourceLabel === "PEP" ? "PEP" : "ADVERSE_MEDIA", canonical, JSON.stringify(body));
}

export async function importPep(): Promise<ImportResult> {
  return importVendorFeed({
    url: config.sources.pepVendorUrl,
    apiKey: config.sources.pepVendorKey,
    riskCategory: "pep",
    sourceLabel: "PEP",
  });
}

export async function importAdverseMedia(): Promise<ImportResult> {
  return importVendorFeed({
    url: config.sources.adverseMediaUrl,
    apiKey: config.sources.adverseMediaKey,
    riskCategory: "adverse_media",
    sourceLabel: "ADVERSE_MEDIA",
  });
}
