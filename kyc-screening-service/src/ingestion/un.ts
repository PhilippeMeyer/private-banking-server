import { parseStringPromise } from "xml2js";
import { config } from "../config";
import { mapUnEntry } from "../normalize/mappers";
import { persistImport, ImportResult } from "./types";

export async function importUn(): Promise<ImportResult> {
  const res = await fetch(config.sources.unConsolidatedUrl, {
    headers: { "User-Agent": "kyc-screening-service/0.1 (compliance-import)" },
  });
  if (!res.ok) {
    throw new Error(`UN list fetch failed: ${res.status} ${res.statusText}`);
  }
  const xml = await res.text();
  const parsed = await parseStringPromise(xml);

  // Real schema nests under CONSOLIDATED_LIST.INDIVIDUALS[0].INDIVIDUAL[]
  // and CONSOLIDATED_LIST.ENTITIES[0].ENTITY[]
  const root = parsed?.CONSOLIDATED_LIST;
  const individuals: any[] = root?.INDIVIDUALS?.[0]?.INDIVIDUAL ?? [];
  const entities: any[] = root?.ENTITIES?.[0]?.ENTITY ?? [];

  const canonical = [
    ...individuals.map((i) => mapUnEntry(i, "individual")),
    ...entities.map((e) => mapUnEntry(e, "entity")),
  ];

  return persistImport("UN", canonical, xml);
}
