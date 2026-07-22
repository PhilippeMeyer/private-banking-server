import { parseStringPromise } from "xml2js";
import { config } from "../config";
import { mapEuEntry } from "../normalize/mappers";
import { persistImport, ImportResult } from "./types";

export async function importEu(): Promise<ImportResult> {
  const res = await fetch(config.sources.euConsolidatedUrl, {
    headers: { "User-Agent": "kyc-screening-service/0.1 (compliance-import)" },
  });
  if (res.status === 403) {
    throw new Error(
      "EU list fetch failed: 403 Forbidden. The EU Financial Sanctions Files " +
        "portal requires a registered EU Login account and a per-user token " +
        "appended as ?token=<your-username> — a plain public URL is not enough. " +
        "Register at https://webgate.ec.europa.eu/fsd/fsf, find 'Show settings " +
        "for crawler/robot' after logging in, and set EU_CONSOLIDATED_XML_URL " +
        "in .env to the exact URL shown there."
    );
  }
  if (!res.ok) {
    throw new Error(`EU list fetch failed: ${res.status} ${res.statusText}`);
  }
  const xml = await res.text();
  const parsed = await parseStringPromise(xml, { explicitArray: true, mergeAttrs: false });

  // Real schema nests under export.sanctionEntity[], each with attribute-heavy
  // children (nameAlias, birthdate, citizenship all keep attrs under '$').
  const entities: any[] = parsed?.export?.sanctionEntity ?? [];
  const canonical = entities.map((e) => mapEuEntry(e));

  return persistImport("EU", canonical, xml);
}
